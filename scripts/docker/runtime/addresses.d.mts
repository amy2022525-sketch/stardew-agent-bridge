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
export declare const CONTAINER_GATEWAY_PORT = 17656;
export declare const CONTAINER_BRIDGE_INTERNAL_PORT = 17655;
export declare const CONTAINER_MOD_INTERNAL_PORT = 17654;
export declare const CONTAINER_VNC_INTERNAL_PORT = 5900;
export declare const CONTAINER_NOVNC_INTERNAL_PORT = 6080;
export type RunMode = 'bridge' | 'game';
export declare class AddressError extends Error {
    readonly code: "CONFIG_INVALID";
    constructor(message: string);
}
export interface PublicBaseUrlParts {
    /** 规范化后的根地址，例如 http://127.0.0.1:18055（无结尾斜杠）。 */
    baseUrl: string;
    hostname: '127.0.0.1' | 'localhost';
    port: number;
}
/**
 * 严格解析外部展示地址。输入必须逐字符匹配规范形式：
 * `http://127.0.0.1:<port>` 或 `http://localhost:<port>`，结尾允许一个 `/`。
 * 通过「解析后再与原输入比对」拒绝 URL 解析器会自动吞掉的别名与编码。
 */
export declare function parsePublicBaseUrl(raw: string): PublicBaseUrlParts;
/** 从宿主发布端口推导默认外部展示地址（SAB_PUBLIC_BASE_URL 为空时使用）。 */
export declare function defaultPublicBaseUrl(httpPort: number): PublicBaseUrlParts;
/**
 * 解析外部展示地址：显式值走严格校验；空值按端口构造默认值；
 * 显式值的端口必须与 SAB_HTTP_PORT 一致，否则生成的配置必然连不上。
 */
export declare function resolvePublicBaseUrl(options: {
    explicit?: string | undefined;
    httpPort: number;
}): PublicBaseUrlParts;
/** 外部 MCP HTTP 地址：公共根 + /mcp。 */
export declare function publicMcpUrl(parts: PublicBaseUrlParts): string;
/**
 * 网关允许的外部 Host 集合（带端口）。只含受控回环主机名；
 * 容器内部端口（17656 等）绝不进入公共允许集合。
 */
export declare function allowedExternalHosts(parts: PublicBaseUrlParts): string[];
/** 网关允许的外部 Origin 集合（精确匹配，含端口）。 */
export declare function allowedExternalOrigins(parts: PublicBaseUrlParts): string[];
/** 校验桌面（noVNC）地址：与公共地址同一套规则，端口需与 SAB_NOVNC_PORT 一致。 */
export declare function resolveDesktopBaseUrl(options: {
    explicit?: string | undefined;
    novncPort: number;
}): PublicBaseUrlParts;
/** 网关上游（内部回环 Bridge）的固定地址；不可由请求或环境覆盖。 */
export declare function upstreamBridgeOrigin(): string;
/** 展示给用户的外部 Web 根地址（浏览器打开的页面）。 */
export declare function publicWebUrl(parts: PublicBaseUrlParts): string;
