/**
 * 容器回环网关（受限 HTTP 转发）。
 *
 * 这是 Docker 部署中唯一监听容器网络接口（0.0.0.0:17656）的进程；
 * 原 Bridge 仍然只监听 127.0.0.1:17655，保留全部回环/认证/CSRF 保护。
 *
 * 关键顺序：先验证**原始**外部 Host/Origin，再把上游 Host/Origin 规范化为
 * 内部回环同源。若先重写后检查，任何恶意网页都会被伪装成同源请求。
 *
 * 本模块不实例化 Bridge、ActionLedger 或 ControlManager；它只做受限转发，
 * 外加由网关自己回答的 /container/live 与 /container/ready（与 Bridge 的
 * 内部 /health 严格区分）。
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MAX_REQUEST_BYTES, BRIDGE_VERSION } from '@sab/contracts';
import {
    CONTAINER_BRIDGE_INTERNAL_PORT,
    CONTAINER_GATEWAY_PORT,
    allowedExternalHosts,
    allowedExternalOrigins,
    type PublicBaseUrlParts
} from './container-addresses.js';

/** 网关日志：只允许这些字段；绝不记录 query、Authorization、Cookie、CSRF 或玩家数据。 */
export interface GatewayLogEntry {
    requestId: string;
    method: string;
    pathClass: 'mcp' | 'api' | 'container' | 'web' | 'other';
    status: number;
    durationMs: number;
    fault?: string;
}

export type GatewayLogger = (entry: GatewayLogEntry) => void;

/** §12.2 的对外净化状态。由 supervisor 状态文件 + 受控 probe 生成，绝不含凭据/PID/路径。 */
export interface ContainerPublicStatus {
    schemaVersion: 1;
    mode: 'bridge' | 'game';
    state: string;
    live: boolean;
    modConnected: boolean;
    saveLoaded: boolean;
    desktopEnabled: boolean;
    desktopAvailable: boolean;
    reasonCode: string;
    /** 桌面入口（可选）：仅当启用且通过本机 URL 校验时为规范回环 URL；否则 null。 */
    desktopBaseUrl?: string | null;
}

export interface GatewayOptions {
    publicBase: PublicBaseUrlParts;
    /** 只读状态来源（读 /run/sab/status.json + 受控 probe）；由运行时装配注入。 */
    containerStatus: () => Promise<ContainerPublicStatus>;
    logger?: GatewayLogger;
    /** 连接建立超时（毫秒）；与持续流空闲策略分开，不截断钓鱼/加载等长调用。 */
    connectTimeoutMs?: number;
    /** 请求体读取总时限（毫秒）；慢连接占用的上限。 */
    bodyReadTimeoutMs?: number;
    listenHost?: string;
    listenPort?: number;
    /** Test transport injection; the production upstream is always fixed loopback. */
    request?: typeof httpRequest;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);

/** 业务头白名单之外的清理通过 hop-by-hop 解析完成；这里只是静态兜底名单。 */
const STATIC_HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

/** 绝不信任或放大转发来源头：进入上游前一律移除。 */
const FORWARDED_HEADERS = new Set(['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip']);

function classifyPath(pathname: string): GatewayLogEntry['pathClass'] {
    if (pathname === '/mcp') return 'mcp';
    if (pathname.startsWith('/api/')) return 'api';
    if (pathname.startsWith('/container/')) return 'container';
    if (pathname === '/' || pathname === '/index.html' || /\.[a-z0-9]+$/i.test(pathname)) return 'web';
    return 'other';
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
}

function countRawHeader(req: IncomingMessage, name: string): number {
    const lower = name.toLowerCase();
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if ((req.rawHeaders[index] ?? '').toLowerCase() === lower) count += 1;
    }
    return count;
}

export class ContainerGateway {
    private readonly options: GatewayOptions;
    private readonly allowedHosts: Set<string>;
    private readonly allowedOrigins: Set<string>;
    private readonly upstreamOriginHeader = `127.0.0.1:${CONTAINER_BRIDGE_INTERNAL_PORT}`;
    private readonly upstreamOrigin = `http://127.0.0.1:${CONTAINER_BRIDGE_INTERNAL_PORT}`;
    private server: Server | null = null;
    private readonly logger: GatewayLogger;

    constructor(options: GatewayOptions) {
        this.options = options;
        this.allowedHosts = new Set(allowedExternalHosts(options.publicBase));
        this.allowedOrigins = new Set(allowedExternalOrigins(options.publicBase));
        this.logger = options.logger ?? (() => {});
    }

    async start(): Promise<number> {
        const host = this.options.listenHost ?? '0.0.0.0';
        const port = this.options.listenPort ?? CONTAINER_GATEWAY_PORT;
        const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
            void this.handle(req, res);
        });
        // WebSocket Upgrade 一律拒绝：MCP 走 HTTP/SSE，Mod WS 从不经过网关。
        server.on('upgrade', (_req, socket) => {
            socket.destroy();
        });
        server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
        server.headersTimeout = 15_000;
        server.requestTimeout = this.options.bodyReadTimeoutMs ?? 30_000;
        server.on('clientError', (_error, socket) => {
            socket.destroy();
        });
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolve);
        });
        const address = server.address();
        return typeof address === 'object' && address ? address.port : port;
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private reject(
        req: IncomingMessage,
        res: ServerResponse,
        startedAt: number,
        requestId: string,
        status: number,
        fault: string,
        message: string
    ): void {
        sendJson(res, status, { error: message, code: fault });
        this.logger({
            requestId,
            method: req.method ?? '?',
            pathClass: classifyPath(safePathname(req.url)),
            status,
            durationMs: Date.now() - startedAt,
            fault
        });
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const startedAt = Date.now();
        const requestId = randomUUID();
        const method = (req.method ?? 'GET').toUpperCase();
        const pathname = safePathname(req.url);

        try {
            // ---- 1) 方法与代理形态 ------------------------------------------------
            if (!METHODS.has(method)) {
                // CONNECT 与其他方法都不允许：本网关不是通用代理。
                this.reject(req, res, startedAt, requestId, 405, 'METHOD_NOT_ALLOWED', '方法不允许。');
                return;
            }
            const rawUrl = req.url ?? '/';
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) || rawUrl.startsWith('//')) {
                this.reject(req, res, startedAt, requestId, 400, 'ABSOLUTE_URL_REJECTED', '不接受绝对形式的请求目标。');
                return;
            }

            // ---- 2) 原始 Host 校验（转发之前；缺失/重复/伪造全部拒绝） -------------
            if (countRawHeader(req, 'host') !== 1) {
                this.reject(req, res, startedAt, requestId, 400, 'HOST_REJECTED', 'Host 头缺失或重复。');
                return;
            }
            const host = (req.headers.host ?? '').trim();
            if (!/^[A-Za-z0-9.-]+:[0-9]+$/.test(host) || !this.allowedHosts.has(host)) {
                // 后缀欺骗（127.0.0.1.evil.example）因不在精确集合内而被拒绝；不做 endsWith。
                this.reject(req, res, startedAt, requestId, 403, 'HOST_REJECTED', 'Host 不在本机允许集合内。');
                return;
            }

            // ---- 3) 原始 Origin 校验（必须在规范化之前） ---------------------------
            const originHeader = req.headers.origin;
            if (countRawHeader(req, 'origin') > 1) {
                this.reject(req, res, startedAt, requestId, 403, 'ORIGIN_REJECTED', '拒绝重复 Origin。');
                return;
            }
            if (typeof originHeader === 'string') {
                const origin = originHeader.trim();
                if (origin === 'null' || origin.includes(',') || !this.allowedOrigins.has(origin)) {
                    this.reject(req, res, startedAt, requestId, 403, 'ORIGIN_REJECTED', 'Origin 不在本机允许集合内。');
                    return;
                }
            }
            // 不带 Origin 的 MCP SDK/命令行请求可继续；它们仍需通过上游 Bearer/会话认证。

            // ---- 4) Sec-Fetch-Site 防线（不是唯一认证依据） ------------------------
            if ((pathname === '/mcp' || pathname.startsWith('/api/')) && req.headers['sec-fetch-site'] === 'cross-site') {
                this.reject(req, res, startedAt, requestId, 403, 'ORIGIN_REJECTED', '拒绝跨站获取。');
                return;
            }

            // ---- 5) 网关自有状态端点（与 Bridge /health 严格区分） ------------------
            if (pathname === '/container/live' || pathname === '/container/ready') {
                if (method !== 'GET' && method !== 'HEAD') {
                    this.reject(req, res, startedAt, requestId, 405, 'METHOD_NOT_ALLOWED', '方法不允许。');
                    return;
                }
                const status = await this.options.containerStatus();
                const ok = pathname === '/container/live' ? status.live : status.state === 'ready' || status.state === 'bridge_ready';
                sendJson(res, ok ? 200 : 503, status);
                this.logger({ requestId, method, pathClass: 'container', status: ok ? 200 : 503, durationMs: Date.now() - startedAt, ...(ok ? {} : { fault: status.reasonCode }) });
                return;
            }

            // ---- 6) 转发到内部回环 Bridge ------------------------------------------
            if (pathname === '/health') {
                const status = await this.options.containerStatus();
                sendJson(res, status.live ? 200 : 503, {
                    ok: status.live, bridgeVersion: BRIDGE_VERSION,
                    modConnected: status.modConnected, saveLoaded: status.saveLoaded
                });
                return;
            }
            await this.forward(req, res, startedAt, requestId, method);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!res.headersSent) sendJson(res, 500, { error: '网关内部错误。', code: 'GATEWAY_INTERNAL' });
            else res.destroy();
            this.logger({ requestId, method, pathClass: classifyPath(pathname), status: res.statusCode || 500, durationMs: Date.now() - startedAt, fault: 'GATEWAY_INTERNAL' });
            void message;
        }
    }

    /**
     * 内部请求规范化：只有外部校验全部通过后才把上游 Host 设为回环地址；
     * 原请求有合法 Origin 时规范为上游同源 origin；无 Origin 的请求继续不带 Origin。
     */
    private buildUpstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
        const headers: Record<string, string | string[]> = {};
        // 解析 Connection 动态列出的 hop-by-hop 头，不能只删固定名单。
        const dynamicHopByHop = new Set<string>();
        const connection = req.headers.connection;
        if (typeof connection === 'string') {
            for (const token of connection.split(',')) {
                const name = token.trim().toLowerCase();
                if (name) dynamicHopByHop.add(name);
            }
        }
        for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            const lower = key.toLowerCase();
            if (STATIC_HOP_BY_HOP.has(lower) || dynamicHopByHop.has(lower)) continue;
            if (FORWARDED_HEADERS.has(lower)) continue;
            if (lower === 'host' || lower === 'origin' || lower === 'content-length') continue;
            headers[lower] = value;
        }
        headers['host'] = this.upstreamOriginHeader;
        if (typeof req.headers.origin === 'string') headers['origin'] = this.upstreamOrigin;
        // Content-Length 由转发逻辑单独处理（超限在转发前拒绝）。
        const contentLength = req.headers['content-length'];
        if (typeof contentLength === 'string' && /^\d+$/.test(contentLength)) headers['content-length'] = contentLength;
        return headers;
    }

    private async forward(req: IncomingMessage, res: ServerResponse, startedAt: number, requestId: string, method: string): Promise<void> {
        // 请求体上限沿用协议 64 KiB；超限终止上游并返回可识别 413，不做无界缓冲。
        const declared = req.headers['content-length'];
        if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
            this.reject(req, res, startedAt, requestId, 413, 'PAYLOAD_TOO_LARGE', '请求体超过 64 KiB 上限。');
            req.resume();
            return;
        }

        const headers = this.buildUpstreamHeaders(req);
        const upstream = (this.options.request ?? httpRequest)(
            {
                host: '127.0.0.1',
                port: CONTAINER_BRIDGE_INTERNAL_PORT,
                method,
                path: req.url ?? '/',
                headers,
                // 不设固定 agent；每个外部请求对应独立上游请求，客户端断开只影响自己。
                agent: false
            },
            (upstreamRes) => {
                if (aborted) {
                    upstreamRes.resume();
                    return;
                }
                res.statusCode = upstreamRes.statusCode ?? 502;
                const raw = upstreamRes.rawHeaders;
                const dynamic = new Set((upstreamRes.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()));
                for (let index = 0; index < raw.length; index += 2) {
                    const name = (raw[index] ?? '').toLowerCase();
                    if (STATIC_HOP_BY_HOP.has(name) || dynamic.has(name)) continue;
                    const value = raw[index + 1] ?? '';
                    if (name === 'set-cookie') {
                        // 原样保留多个 Set-Cookie。
                        const existing = res.getHeader('set-cookie');
                        const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
                        res.setHeader('set-cookie', [...list, value]);
                        continue;
                    }
                    res.setHeader(name, value);
                }
                if ((upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')) {
                    // SSE 不缓冲、不压缩、不合并：立即刷出头，逐段 pipe。
                    res.flushHeaders();
                }
                upstreamRes.pipe(res);
                upstreamRes.on('error', () => res.destroy());
                upstreamRes.on('end', () => {
                    this.logger({
                        requestId,
                        method,
                        pathClass: classifyPath(safePathname(req.url)),
                        status: res.statusCode,
                        durationMs: Date.now() - startedAt
                    });
                });
            }
        );

        let aborted = false;
        let received = 0;
        let clientGone = false;

        const abortWith413 = (): void => {
            if (aborted) return;
            aborted = true;
            upstream.destroy();
            if (!res.headersSent) sendJson(res, 413, { error: '请求体超过 64 KiB 上限。', code: 'PAYLOAD_TOO_LARGE' });
            else res.destroy();
            this.logger({ requestId, method, pathClass: classifyPath(safePathname(req.url)), status: 413, durationMs: Date.now() - startedAt, fault: 'PAYLOAD_TOO_LARGE' });
        };

        // 连接建立超时与持续流空闲策略分开：只约束「连不上上游」，不截断长响应。
        const connectTimeout = setTimeout(() => {
            aborted = true;
            upstream.destroy();
            if (!res.headersSent) sendJson(res, 503, { error: '上游连接超时。', code: 'UPSTREAM_UNAVAILABLE' });
        }, this.options.connectTimeoutMs ?? 10_000);
        // Only bound TCP establishment. Waiting for a tool response can legitimately take minutes.
        upstream.once('socket', socket => {
            if (socket.connecting) socket.once('connect', () => clearTimeout(connectTimeout));
            else clearTimeout(connectTimeout);
        });

        upstream.on('error', () => {
            clearTimeout(connectTimeout);
            if (aborted) return;
            aborted = true;
            // 上游失效：如实报告 502；业务写结果可能未知，不能伪造「执行失败且无副作用」。
            if (!res.headersSent) {
                sendJson(res, 502, {
                    error: '上游 Bridge 不可用；若这是写操作，其结果未知，请查询原 actionId 收据，不要自动重试。',
                    code: 'UPSTREAM_UNAVAILABLE'
                });
            } else {
                res.destroy();
            }
            if (!clientGone) {
                this.logger({ requestId, method, pathClass: classifyPath(safePathname(req.url)), status: 502, durationMs: Date.now() - startedAt, fault: 'UPSTREAM_UNAVAILABLE' });
            }
        });

        // 客户端断开：只关闭本请求对应的上游请求，保留现有取消语义；不触碰共享 Bridge。
        res.once('close', () => {
            clearTimeout(connectTimeout);
            if (!res.writableFinished) {
                clientGone = true;
                upstream.destroy();
            }
        });

        // 请求体读取时限：防止慢连接长期占用。
        const expectsBody = method === 'POST' || method === 'DELETE';
        let bodyTimer: NodeJS.Timeout | null = null;
        if (expectsBody) {
            bodyTimer = setTimeout(() => {
                aborted = true;
                upstream.destroy();
                req.destroy();
                if (!res.headersSent) sendJson(res, 408, { error: '请求体读取超时。', code: 'BODY_READ_TIMEOUT' });
            }, this.options.bodyReadTimeoutMs ?? 30_000);
            req.once('end', () => {
                if (bodyTimer) clearTimeout(bodyTimer);
            });
        }

        req.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_REQUEST_BYTES) abortWith413();
        });
        req.on('error', () => upstream.destroy());
        const clearBodyTimer = (): void => { if (bodyTimer) clearTimeout(bodyTimer); };
        req.once('close', clearBodyTimer);
        upstream.once('error', clearBodyTimer);
        // chunked 与定长请求都直接流式转发；背压由 pipe 处理。
        req.pipe(upstream);
    }
}

function safePathname(rawUrl: string | undefined): string {
    try {
        return new URL(rawUrl ?? '/', 'http://gateway.invalid').pathname;
    } catch {
        return '/';
    }
}
