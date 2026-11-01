/**
 * Provider 抽象（§11）：核心只依赖 decide()；HTTP 细节、正文提取与脱敏在实现内完成。
 * 不回传响应 header 与原始错误体；usage 缺失时 source 标 unavailable，由预算层保守预留。
 */
export type ProviderProtocol = "openai-responses" | "openai-chat-compatible";

export interface ProviderUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    source: "provider" | "unavailable";
}

export interface ProviderCallRequest {
    systemPrompt: string;
    contextJson: string;
    outputSchema: Record<string, unknown>;
    maxOutputTokens: number;
    signal: AbortSignal;
}

export interface ProviderCallResult {
    decisionText: string;
    usage: ProviderUsage;
    latencyMs: number;
    /** 协议原生完成原因（completed / length / content_filter / refusal …）。 */
    finishReason: string;
}

export class ProviderCallError extends Error {
    /** 规范错误码：PROVIDER_UNAUTHORIZED / PROVIDER_RATE_LIMITED / PROVIDER_TIMEOUT /
     * PROVIDER_TRANSPORT / PROVIDER_BAD_RESPONSE / PROVIDER_OUTPUT_TRUNCATED 等。 */
    readonly code: string;
    readonly httpStatus: number | null;
    readonly retryable: boolean;
    /** 已脱敏短摘要；绝不携带原始 body、Key 或请求头。 */
    readonly safeSummary: string;
    readonly requestId: string | null;
    constructor(init: { code: string; message: string; httpStatus?: number | null; retryable?: boolean; safeSummary?: string; requestId?: string | null }) {
        super(init.message);
        this.name = "ProviderCallError";
        this.code = init.code;
        this.httpStatus = init.httpStatus ?? null;
        this.retryable = init.retryable ?? false;
        this.safeSummary = init.safeSummary ?? "";
        this.requestId = init.requestId ?? null;
    }
}

export interface DecisionProvider {
    readonly id: string;
    readonly label: string;
    readonly protocol: ProviderProtocol;
    decide(request: ProviderCallRequest): Promise<ProviderCallResult>;
}

/**
 * Provider 配置档（§11.3）：非敏感字段入 config.json；secretRef 只引用本应用管理的
 * 凭据记录（由 apps/server 的 secrets 存储解析），不是文件路径或环境变量名。
 */
export type DecisionFormat = "json_schema" | "json_object" | "plain_json";
export type MaxOutputParameter = "max_completion_tokens" | "max_tokens";

export interface ProviderProfileConfig {
    id: string;
    label: string;
    protocol: ProviderProtocol;
    /** 已包含服务前缀（如 /v1）的 baseUrl；适配器只追加一次资源路径。 */
    baseUrl: string;
    /** 模型名是用户字符串配置，不硬编码推荐型号。 */
    model: string;
    /** none 必须显式声明，不把缺 Key 静默解释成匿名调用。 */
    authMode: "bearer" | "none";
    secretRef: string | null;
    decisionFormat: DecisionFormat;
    /** Chat 的长度字段显式二选一，绝不同时发送；缺省 max_completion_tokens。 */
    maxOutputParameter?: MaxOutputParameter;
    timeoutMs?: number;
    maxOutputTokens?: number;
    allowPrivateNetwork?: boolean;
    allowPlainHttp?: boolean;
    /** temperature/reasoning 默认不发送，只有该配置显式声明支持才发送。 */
    supportsTemperature?: boolean;
    temperature?: number;
    supportsReasoning?: boolean;
    reasoningEffort?: string;
}

export const PROVIDER_DEFAULTS = { timeoutMs: 30_000, maxOutputTokens: 2048, maxOutputParameter: "max_completion_tokens" as MaxOutputParameter, decisionFormat: "json_schema" as DecisionFormat };

export interface ProviderSecretAccess {
    /** authMode=bearer 时返回 "Bearer <key>"；缺凭据返回 null（适配器据此报 PROVIDER_AUTH_FAILED）。 */
    authorizationHeader(config: ProviderProfileConfig): string | null;
}
