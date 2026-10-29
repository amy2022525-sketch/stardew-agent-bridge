/**
 * 容器部署的地址契约（纯函数，无副作用）。
 *
 * 三类地址必须严格分开：
 * 1. 内部探测地址：http://127.0.0.1:17655 —— 只在容器内使用（健康检查、stdio、自检、锁复用）。
 * 2. 外部展示地址：SAB_PUBLIC_BASE_URL —— 浏览器与 MCP HTTP 配置使用的宿主回环地址。
 * 3. MCP 地址：外部展示根 URL + /mcp（绝不拼出 /mcp/mcp）。
 *
 * 首版安全边界：外部地址只允许 http + 127.0.0.1/localhost + 显式端口 1024–65535；
 * 拒绝 IPv6 映射、用户名密码、query/hash、子路径，以及 127.1、十六进制、整数形式的
 * 主机别名。不从请求头（Host/Forwarded/X-Forwarded-*）推导公共地址。
 */
export const CONTAINER_GATEWAY_PORT = 17656;
export const CONTAINER_BRIDGE_INTERNAL_PORT = 17655;
export const CONTAINER_MOD_INTERNAL_PORT = 17654;
export const CONTAINER_VNC_INTERNAL_PORT = 5900;
export const CONTAINER_NOVNC_INTERNAL_PORT = 6080;
export class AddressError extends Error {
    code = 'CONFIG_INVALID';
    constructor(message) {
        super(message);
        this.name = 'AddressError';
    }
}
function isValidPortText(text) {
    if (!/^[0-9]+$/.test(text))
        return false;
    const port = Number(text);
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
/**
 * 严格解析外部展示地址。输入必须逐字符匹配规范形式：
 * `http://127.0.0.1:<port>` 或 `http://localhost:<port>`，结尾允许一个 `/`。
 * 通过「解析后再与原输入比对」拒绝 URL 解析器会自动吞掉的别名与编码。
 */
export function parsePublicBaseUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new AddressError('SAB_PUBLIC_BASE_URL 不能为空字符串以外的空白；未设置时请留空。');
    }
    if (raw.length > 128)
        throw new AddressError('SAB_PUBLIC_BASE_URL 超长。');
    const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (trimmed.includes('..'))
        throw new AddressError('SAB_PUBLIC_BASE_URL 不允许包含 `..`。');
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new AddressError(`SAB_PUBLIC_BASE_URL 不是合法 URL：${raw}`);
    }
    if (url.protocol !== 'http:')
        throw new AddressError('SAB_PUBLIC_BASE_URL 首版只允许 http 协议（本机回环）。');
    if (url.username !== '' || url.password !== '')
        throw new AddressError('SAB_PUBLIC_BASE_URL 不允许包含用户名或密码。');
    if (url.search !== '' || url.hash !== '')
        throw new AddressError('SAB_PUBLIC_BASE_URL 不允许 query 或 hash。');
    if (url.pathname !== '' && url.pathname !== '/')
        throw new AddressError('SAB_PUBLIC_BASE_URL 不允许子路径。');
    if (url.port === '' || !isValidPortText(url.port)) {
        throw new AddressError('SAB_PUBLIC_BASE_URL 必须显式给出 1024–65535 的端口。');
    }
    const hostname = url.hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        throw new AddressError(`SAB_PUBLIC_BASE_URL 的 host 只允许 127.0.0.1 或 localhost（收到 ${hostname}）。` +
            '首版不支持 IPv6 映射（[::1]/[::]）、0.0.0.0 或任意域名。');
    }
    // 再校验：规范形式必须与原输入一致，拒绝 127.1、0x7f000001、2130706433、127.0.0.1. 等别名。
    const canonical = `http://${hostname}:${url.port}`;
    if (canonical !== trimmed) {
        throw new AddressError(`SAB_PUBLIC_BASE_URL 必须写作规范形式 ${canonical}（收到 ${raw}）。`);
    }
    return { baseUrl: canonical, hostname: hostname, port: Number(url.port) };
}
/** 从宿主发布端口推导默认外部展示地址（SAB_PUBLIC_BASE_URL 为空时使用）。 */
export function defaultPublicBaseUrl(httpPort) {
    if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535) {
        throw new AddressError(`SAB_HTTP_PORT 必须是 1024–65535 的整数（收到 ${httpPort}）。`);
    }
    return parsePublicBaseUrl(`http://127.0.0.1:${httpPort}`);
}
/**
 * 解析外部展示地址：显式值走严格校验；空值按端口构造默认值；
 * 显式值的端口必须与 SAB_HTTP_PORT 一致，否则生成的配置必然连不上。
 */
export function resolvePublicBaseUrl(options) {
    const explicit = options.explicit?.trim();
    const parts = explicit ? parsePublicBaseUrl(explicit) : defaultPublicBaseUrl(options.httpPort);
    if (parts.port !== options.httpPort) {
        throw new AddressError(`SAB_PUBLIC_BASE_URL 端口（${parts.port}）与 SAB_HTTP_PORT（${options.httpPort}）不一致；` +
            '两者必须相同，否则导出的 MCP 地址连不上实际发布端口。');
    }
    return parts;
}
/** 外部 MCP HTTP 地址：公共根 + /mcp。 */
export function publicMcpUrl(parts) {
    return `${parts.baseUrl}/mcp`;
}
/**
 * 网关允许的外部 Host 集合（带端口）。只含受控回环主机名；
 * 容器内部端口（17656 等）绝不进入公共允许集合。
 */
export function allowedExternalHosts(parts) {
    return [`127.0.0.1:${parts.port}`, `localhost:${parts.port}`];
}
/** 网关允许的外部 Origin 集合（精确匹配，含端口）。 */
export function allowedExternalOrigins(parts) {
    return [`http://127.0.0.1:${parts.port}`, `http://localhost:${parts.port}`];
}
/** 校验桌面（noVNC）地址：与公共地址同一套规则，端口需与 SAB_NOVNC_PORT 一致。 */
export function resolveDesktopBaseUrl(options) {
    const explicit = options.explicit?.trim();
    const parts = explicit ? parsePublicBaseUrl(explicit) : defaultPublicBaseUrl(options.novncPort);
    if (parts.port !== options.novncPort) {
        throw new AddressError(`SAB_DESKTOP_BASE_URL 端口（${parts.port}）与 SAB_NOVNC_PORT（${options.novncPort}）不一致。`);
    }
    return parts;
}
/** 网关上游（内部回环 Bridge）的固定地址；不可由请求或环境覆盖。 */
export function upstreamBridgeOrigin() {
    return `http://127.0.0.1:${CONTAINER_BRIDGE_INTERNAL_PORT}`;
}
/** 展示给用户的外部 Web 根地址（浏览器打开的页面）。 */
export function publicWebUrl(parts) {
    return `${parts.baseUrl}/`;
}
