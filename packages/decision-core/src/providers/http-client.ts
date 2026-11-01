/**
 * Provider 传输层（§11.5）：node:http/https 原生实现。
 * 规则：拒 userinfo/query/fragment/file/data；默认 HTTPS（allowPlainHttp 显式例外）；
 * 先 DNS 解析 → 按策略校验实际 IP → 按已解析 IP 建连（禁双解析器；TLS servername 保持原主机）；
 * 不跟随重定向；Authorization 只发往原主机；总+连接 timeout；响应体 ≤512KiB；TLS 常验无旁路；
 * 错误只带规范码与 ≤200 字符脱敏摘要，绝不携带原始 body、Key 或请求头。
 */
import * as http from "node:http";
import * as https from "node:https";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { ProviderCallError } from "./types.js";

export const PROVIDER_RESPONSE_MAX_BYTES = 512 * 1024;
export const CONNECT_TIMEOUT_MS = 10_000;

export interface ProviderEndpointConfig {
    /** 已包含服务前缀的 baseUrl（例如以 /v1 结尾）；只追加一次资源路径。 */
    baseUrl: string;
    timeoutMs: number;
    allowPrivateNetwork: boolean;
    allowPlainHttp: boolean;
}

export class RateLimitedProviderError extends ProviderCallError {
    /** 已解析且封顶的 Retry-After；超预算由调用方决定停止。 */
    readonly retryAfterMs: number | null;
    constructor(init: { message: string; safeSummary: string; requestId: string | null; retryAfterMs: number | null; httpStatus: number }) {
        super({ code: "PROVIDER_RATE_LIMITED", message: init.message, httpStatus: init.httpStatus, retryable: true, safeSummary: init.safeSummary, requestId: init.requestId });
        this.name = "RateLimitedProviderError";
        this.retryAfterMs = init.retryAfterMs;
    }
}

/** 校验并拆分 endpoint；返回可安全使用的 parts。拒 userinfo/query/fragment 与非 http(s)。 */
export function parseProviderBaseUrl(raw: string, allowPlainHttp: boolean): {
    protocol: "http:" | "https:";
    hostname: string;
    port: number;
    pathPrefix: string;
} {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 不是合法 URL", safeSummary: "invalid url" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 只允许 http/https（拒 file/data 等）", safeSummary: url.protocol });
    }
    if (url.protocol === "http:" && !allowPlainHttp) {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "明文 HTTP 需在 endpoint 配置显式开启", safeSummary: "plain http not allowed" });
    }
    if (url.username !== "" || url.password !== "") {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 不允许携带用户名/密码", safeSummary: "userinfo rejected" });
    }
    if (url.search !== "" || url.hash !== "") {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 不允许 query 或 fragment", safeSummary: "query/fragment rejected" });
    }
    const hostname = url.hostname;
    if (hostname === "") {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 缺少主机名", safeSummary: "missing host" });
    }
    const defaultPort = url.protocol === "https:" ? 443 : 80;
    const port = url.port !== "" ? Number(url.port) : defaultPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new ProviderCallError({ code: "PROVIDER_ENDPOINT_REJECTED", message: "endpoint 端口非法", safeSummary: "bad port" });
    }
    // 去尾斜杠；资源路径（/responses、/chat/completions）由调用方只追加一次。
    let pathPrefix = url.pathname;
    while (pathPrefix.length > 1 && pathPrefix.endsWith("/")) pathPrefix = pathPrefix.slice(0, -1);
    if (pathPrefix === "/") pathPrefix = "";
    return { protocol: url.protocol as "http:" | "https:", hostname, port, pathPrefix };
}

function ipInCidrV4(ip: string, cidrBase: number[], prefixBits: number): boolean {
    const a = ip.split(".").map((x) => Number(x));
    if (a.length !== 4 || a.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    const shift = 32 - prefixBits;
    const av = (((a[0] as number) * 2 ** 24) + ((a[1] as number) * 2 ** 16) + ((a[2] as number) * 2 ** 8) + (a[3] as number)) >>> 0;
    const bv = (((cidrBase[0] as number) * 2 ** 24) + ((cidrBase[1] as number) * 2 ** 16) + ((cidrBase[2] as number) * 2 ** 8) + (cidrBase[3] as number)) >>> 0;
    const mask = shift === 0 ? 0xffffffff : (0xffffffff << shift) >>> 0;
    return (av & mask) === (bv & mask);
}

/** 把 IPv6（含 :: 压缩与内嵌 IPv4 尾段）展开为 8 个 16bit 段；zone id 拒绝。 */
function ipv6Groups(ip: string): number[] | null {
    if (ip.includes("%")) return null;
    let work = ip.toLowerCase();
    if (work.includes(".")) {
        const lastColon = work.lastIndexOf(":");
        const tail = work.slice(lastColon + 1);
        const v4 = tail.split(".");
        if (v4.length !== 4) return null;
        const b = v4.map((x) => Number(x));
        if (b.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
        const h1 = (((b[0] as number) << 8) | (b[1] as number)).toString(16);
        const h2 = (((b[2] as number) << 8) | (b[3] as number)).toString(16);
        work = work.slice(0, lastColon + 1) + h1 + ":" + h2;
    }
    const doubleIdx = work.indexOf("::");
    let expanded = work;
    if (doubleIdx >= 0) {
        if (work.indexOf("::", doubleIdx + 1) >= 0) return null;
        const head = work.slice(0, doubleIdx).split(":").filter((s) => s !== "");
        const tailGroups = work.slice(doubleIdx + 2).split(":").filter((s) => s !== "");
        if (head.length + tailGroups.length > 7) return null;
        const fill = 8 - head.length - tailGroups.length;
        expanded = head.concat(new Array<string>(fill).fill("0"), tailGroups).join(":");
    }
    const parts = expanded.split(":");
    if (parts.length !== 8) return null;
    const groups: number[] = [];
    for (const part of parts) {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(parseInt(part, 16));
    }
    return groups;
}

/** 按高位前缀逐段比较（16bit 对齐，无 32bit 溢出问题）。 */
function ipv6MatchPrefix(ip: string, baseHex: string, prefixBits: number): boolean {
    const a = ipv6Groups(ip);
    const b = ipv6Groups(baseHex);
    if (!a || !b) return false;
    let remaining = prefixBits;
    for (let i = 0; i < 8 && remaining > 0; i++) {
        const bitsHere = Math.min(16, remaining);
        const shift = 16 - bitsHere;
        if ((a[i] as number) >>> shift !== (b[i] as number) >>> shift) return false;
        remaining -= bitsHere;
    }
    return true;
}
export function isAddressAllowed(ip: string, allowPrivateNetwork: boolean): boolean {
    const v6 = net.isIPv6(ip);
    const v4 = net.isIPv4(ip);
    if (!v4 && !v6) return false;
    if (v4) {
        // 永久拒绝段：与开关无关
        if (ipInCidrV4(ip, [169, 254, 0, 0], 16)) return false; // 链路本地/云元数据
        if (ipInCidrV4(ip, [0, 0, 0, 0], 8)) return false; // 本网络/未指定
        if (ipInCidrV4(ip, [224, 0, 0, 0], 4)) return false; // 组播/保留
        const privateV4 =
            ipInCidrV4(ip, [127, 0, 0, 0], 8) || // 环回
            ipInCidrV4(ip, [10, 0, 0, 0], 8) ||
            ipInCidrV4(ip, [172, 16, 0, 0], 12) ||
            ipInCidrV4(ip, [192, 168, 0, 0], 16) ||
            ipInCidrV4(ip, [100, 64, 0, 0], 10); // CGNAT（本地服务常见）
        // 私网/环回只在 endpoint 显式 allowPrivateNetwork 时放行；公网始终放行（§11.5）
        if (privateV4) return allowPrivateNetwork;
        return true;
    }
    const lower = ip.toLowerCase();
    if (lower === "::") return false; // 未指定
    if (lower === "::1") return allowPrivateNetwork; // 环回：同私网开关
    if (ipv6MatchPrefix(ip, "fe80::", 10)) return false; // 链路本地：永拒
    if (ipv6MatchPrefix(ip, "ff00::", 8)) return false; // 组播
    const groups = ipv6Groups(ip);
    if (groups && groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0
        && (groups[5] === 0xffff || groups[5] === 0)) {
        // ::ffff:A.B.C.D（映射）与已废弃的 ::A.B.C.D（兼容）都按内嵌 IPv4 递归判策略，
        // 防止 ::ffff:169.254.x.x / ::127.0.0.1 用 IPv6 写法绕过私网限制。
        // :: 与 ::1 已在上方单独处理，不会落到这里。
        const g6 = groups[6] as number;
        const g7 = groups[7] as number;
        const embedded = [String((g6 >>> 8) & 0xff), String(g6 & 0xff), String((g7 >>> 8) & 0xff), String(g7 & 0xff)].join(".");
        return isAddressAllowed(embedded, allowPrivateNetwork);
    }
    if (groups && ipv6MatchPrefix(ip, "2002::", 16)) {
        // 6to4：2002:V4ADDR::/48，IPv4 位于第 2、3 组（不是含 2002 前缀的第 1 组）。
        // 取错字段会把 2002:7f00:1::（内嵌 127.0.0.1）误判为公网，直接绕过私网限制。
        const g1 = groups[1] as number;
        const g2 = groups[2] as number;
        const embedded = [String(g1 >>> 8), String(g1 & 0xff), String(g2 >>> 8), String(g2 & 0xff)].join(".");
        return isAddressAllowed(embedded, allowPrivateNetwork);
    }
    if (groups && ipv6MatchPrefix(ip, "2001::", 32)) {
        // Teredo：尾两段按位取反为客户端 IPv4；策略按解码结果，无法解码时保守拒绝
        const g6 = ~(groups[6] as number) & 0xffff;
        const g7 = ~(groups[7] as number) & 0xffff;
        const embedded = [String(g6 >>> 8), String(g6 & 0xff), String(g7 >>> 8), String(g7 & 0xff)].join(".");
        if (net.isIPv4(embedded)) return isAddressAllowed(embedded, allowPrivateNetwork);
        return false;
    }
    // ULA（fc00::/7，含 fd00）与旧站点本地（fec0::/10）属于私网语义：
    // 未显式 allowPrivateNetwork 时必须拒绝，不能当作公网放行。
    if (ipv6MatchPrefix(ip, "fc00::", 7) || ipv6MatchPrefix(ip, "fec0::", 10)) {
        return allowPrivateNetwork;
    }
    return true;
}

export interface JsonPostRequest {
    endpoint: ProviderEndpointConfig;
    /** 形如 "/responses" 或 "/chat/completions"；只追加一次。 */
    resourcePath: string;
    body: Record<string, unknown>;
    /** 每请求现取 Authorization（密钥不落实例明文）。null 表示 authMode:none 已显式声明。 */
    getAuthorization: () => string | null;
    signal: AbortSignal;
}

export interface JsonPostResponse {
    status: number;
    json: Record<string, unknown>;
    requestId: string | null;
}

function redact(text: string): string {
    let out = String(text ?? "");
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [redacted]");
    out = out.replace(/sk-[A-Za-z0-9_\-]{4,}/g, "[redacted-key]");
    out = out.replace(/("?(api[_-]?key|authorization|token|secret)"?\s*[:=]\s*")([^"]*)(")/gi, '$1[redacted]$5');
    out = out.replace(/[\r\n\t]+/g, " ");
    if (out.length > 200) out = out.slice(0, 200);
    return out;
}

function pickRequestId(headers: http.IncomingHttpHeaders, json: Record<string, unknown>): string | null {
    for (const name of ["x-request-id", "request-id", "x-openai-request-id", "x-mtreq-id"]) {
        const v = headers[name];
        if (typeof v === "string" && v !== "") return v.slice(0, 128);
    }
    const id = json["id"];
    return typeof id === "string" && id !== "" ? id.slice(0, 128) : null;
}

function parseRetryAfterMs(value: string | undefined): number | null {
    if (!value) return null;
    const secs = Number(value);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 120) * 1000;
    const dateMs = Date.parse(value);
    if (!Number.isNaN(dateMs)) return Math.max(0, Math.min((dateMs - Date.now()) / 1000, 120)) * 1000;
    return null;
}

export async function postJson(req: JsonPostRequest): Promise<JsonPostResponse> {
    const { protocol, hostname, port, pathPrefix } = parseProviderBaseUrl(req.endpoint.baseUrl, req.endpoint.allowPlainHttp);
    const path = pathPrefix + req.resourcePath;
    const startedAt = Date.now();

    // —— 先解析 → 校验 → 按已解析 IP 连接（禁双解析器）——
    let addresses: Array<{ address: string; family: number }> = [];
    try {
        addresses = (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
    } catch {
        throw new ProviderCallError({ code: "PROVIDER_TRANSPORT", message: "endpoint DNS 解析失败", retryable: true, safeSummary: "dns lookup failed" });
    }
    if (net.isIP(hostname) !== 0) {
        addresses = [{ address: hostname, family: net.isIP(hostname) === 4 ? 4 : 6 }];
    }
    const allowed = addresses.filter((a) => isAddressAllowed(a.address, req.endpoint.allowPrivateNetwork));
    if (allowed.length === 0) {
        throw new ProviderCallError({ code: "PROVIDER_NETWORK_BLOCKED", message: "endpoint 解析到未授权内网/链路本地/元数据地址，已拒绝连接", retryable: false, safeSummary: "resolved addresses blocked by network policy" });
    }
    const target = allowed[0] as { address: string; family: number };

    const payload = JSON.stringify(req.body);
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload, "utf8")),
        host: hostname + (protocol === "https:" && port === 443 ? "" : protocol === "http:" && port === 80 ? "" : ":" + String(port)),
    };
    const auth = req.getAuthorization();
    if (auth !== null) headers["authorization"] = auth; // 只发往原主机；不跟随重定向 ⇒ 不可能换主机

    const transport = protocol === "https:" ? https : http;
    return await new Promise<JsonPostResponse>((resolve, reject) => {
        let settled = false;
        // cleanup 必须先于任何可能同步触发的 finishError 定义：signal 已 abort 时
        // onAbort 会立刻调用 finishError → cleanup，否则会落在 TDZ 上。
        let cleanup = (): void => undefined;
        const finishError = (err: ProviderCallError): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const finishOk = (v: JsonPostResponse): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(v);
        };

        const request = transport.request(
            {
                protocol,
                host: target.address, // 已校验 IP
                port,
                path,
                method: "POST",
                headers,
                // Override the global Agent's idle timeout for an active model request.
                timeout: req.endpoint.timeoutMs,
                ...(protocol === "https:" ? { servername: hostname } : {}), // TLS 校验原主机名
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                    res.resume();
                    finishError(new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "不跟随重定向（尤其不会带 Authorization 跳往新主机）", httpStatus: status, retryable: false, safeSummary: "redirect " + String(status) }));
                    return;
                }
                const chunks: Buffer[] = [];
                let total = 0;
                res.on("data", (c: Buffer) => {
                    total += c.length;
                    if (total > PROVIDER_RESPONSE_MAX_BYTES) {
                        res.destroy();
                        finishError(new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "响应体超过 512KiB 上限", httpStatus: status, retryable: false, safeSummary: "response body exceeds limit" }));
                        return;
                    }
                    chunks.push(c);
                });
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        finishError(new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "响应不是合法 JSON", httpStatus: status, retryable: false, safeSummary: "non-json response" }));
                        return;
                    }
                    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                        finishError(new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "响应顶层不是 JSON 对象", httpStatus: status, retryable: false, safeSummary: "unexpected top-level shape" }));
                        return;
                    }
                    const json = parsed as Record<string, unknown>;
                    const requestId = pickRequestId(res.headers ?? {}, json);
                    if (status >= 200 && status < 300) {
                        finishOk({ status, json, requestId });
                        return;
                    }
                    if (status === 401 || status === 403) {
                        finishError(new ProviderCallError({ code: "PROVIDER_UNAUTHORIZED", message: "执行模型认证失败，已停止本轮，请修正凭据", httpStatus: status, retryable: false, safeSummary: redact("auth " + String(status)), requestId }));
                        return;
                    }
                    if (status === 429) {
                        finishError(new RateLimitedProviderError({ message: "执行模型被限流", safeSummary: redact("rate limited"), requestId, retryAfterMs: parseRetryAfterMs(res.headers["retry-after"] !== undefined ? String(res.headers["retry-after"]) : undefined), httpStatus: 429 }));
                        return;
                    }
                    if (status >= 500) {
                        finishError(new ProviderCallError({ code: "PROVIDER_TRANSPORT", message: "模型服务暂时故障（5xx）", httpStatus: status, retryable: true, safeSummary: redact("server error " + String(status)), requestId }));
                        return;
                    }
                    finishError(new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "模型服务返回未接受的响应状态", httpStatus: status, retryable: false, safeSummary: redact("unexpected status " + String(status)), requestId }));
                });
                res.on("error", () => {
                    finishError(new ProviderCallError({ code: "PROVIDER_TRANSPORT", message: "响应流错误", retryable: true, safeSummary: "response stream error" }));
                });
            }
        );

        const connectTimer = setTimeout(() => {
            request.destroy(new Error("connect timeout"));
        }, Math.min(CONNECT_TIMEOUT_MS, req.endpoint.timeoutMs));
        connectTimer.unref?.();
        const totalTimer = setTimeout(() => {
            finishError(new ProviderCallError({ code: "PROVIDER_TIMEOUT", message: "模型请求超时（总时限）", retryable: true, safeSummary: "request timeout after " + String(Date.now() - startedAt) + "ms" }));
            request.destroy(new Error("total timeout"));
        }, req.endpoint.timeoutMs);
        totalTimer.unref?.();

        const onAbort = (): void => {
            finishError(new ProviderCallError({ code: "CANCELLED", message: "请求已取消，只保证不再使用迟到结果，不承诺服务商未计费", retryable: false, safeSummary: "aborted by caller" }));
            request.destroy(new Error("aborted"));
        };
        cleanup = (): void => {
            clearTimeout(connectTimer);
            clearTimeout(totalTimer);
            req.signal.removeEventListener("abort", onAbort);
        };
        if (req.signal.aborted) {
            onAbort();
            return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });

        request.on("socket", (socket) => {
            socket.setTimeout(req.endpoint.timeoutMs);
            // Agent keep-alive sockets are already connected and emit no new connect event.
            if (!socket.connecting) clearTimeout(connectTimer);
            else socket.once(protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
        });
        request.on("timeout", () => {
            // socket idle：由总时限兜底，这里主动断开
            request.destroy(new Error("socket idle timeout"));
        });
        request.on("error", (err: Error) => {
            const msg = err && err.message ? err.message : "transport error";
            if (msg === "aborted") return; // 已由 onAbort 定案
            if (msg === "total timeout") return; // 已由 totalTimer 定案
            finishError(new ProviderCallError({ code: "PROVIDER_TRANSPORT", message: "到模型服务的连接失败", retryable: true, safeSummary: redact(msg) }));
        });
        request.write(payload);
        request.end();
    });
}
