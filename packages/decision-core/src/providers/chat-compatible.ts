/**
 * openai-chat-compatible 适配器（§11.2）：POST {baseUrl}/chat/completions。
 * 长度字段按 profile 显式二选一（默认 max_completion_tokens），绝不同时发送；
 * temperature/reasoning 仅显式声明支持才发送；choices 必须恰好 1；
 * finish_reason=length/content_filter/refusal、message.refusal、tool_calls 全部拒绝。
 */
import type {
    DecisionProvider,
    ProviderCallRequest,
    ProviderCallResult,
    ProviderProfileConfig,
    ProviderSecretAccess,
    ProviderUsage
} from "./types.js";
import { PROVIDER_DEFAULTS, ProviderCallError } from "./types.js";
import { postJson } from "./http-client.js";
import type { JsonPostResponse } from "./http-client.js";

const JSON_SCHEMA_NAME = "decision_envelope";

export function buildChatBody(cfg: ProviderProfileConfig, req: ProviderCallRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.contextJson }
        ],
        stream: false
    };
    const lenField = cfg.maxOutputParameter ?? PROVIDER_DEFAULTS.maxOutputParameter;
    body[lenField] = req.maxOutputTokens;
    const format = cfg.decisionFormat ?? PROVIDER_DEFAULTS.decisionFormat;
    if (format === "json_schema") {
        body.response_format = {
            type: "json_schema",
            json_schema: { name: JSON_SCHEMA_NAME, strict: true, schema: req.outputSchema }
        };
    } else if (format === "json_object") {
        body.response_format = { type: "json_object" };
    }
    if (cfg.supportsTemperature === true && typeof cfg.temperature === "number") body.temperature = cfg.temperature;
    if (cfg.supportsReasoning === true && typeof cfg.reasoningEffort === "string") body.reasoning_effort = cfg.reasoningEffort;
    return body;
}

function readUsage(json: Record<string, unknown>): ProviderUsage {
    const usage = json.usage;
    if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        const it = typeof u.prompt_tokens === "number" ? u.prompt_tokens : null;
        const ot = typeof u.completion_tokens === "number" ? u.completion_tokens : null;
        const tt = typeof u.total_tokens === "number" ? u.total_tokens : (it !== null || ot !== null ? (it ?? 0) + (ot ?? 0) : null);
        if (it !== null || ot !== null || tt !== null) {
            return { inputTokens: it, outputTokens: ot, totalTokens: tt, source: "provider" };
        }
    }
    return { inputTokens: null, outputTokens: null, totalTokens: null, source: "unavailable" };
}

function contentToString(content: unknown): string | null {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
            if (item && typeof item === "object") {
                const rec = item as Record<string, unknown>;
                if ((rec.type === "text" || rec.type === undefined) && typeof rec.text === "string") parts.push(rec.text);
            }
        }
        return parts.length > 0 ? parts.join("") : null;
    }
    return null;
}

export class ChatCompatibleProvider implements DecisionProvider {
    readonly id: string;
    readonly label: string;
    readonly protocol = "openai-chat-compatible" as const;
    private readonly cfg: ProviderProfileConfig;
    private readonly secrets: ProviderSecretAccess;

    constructor(cfg: ProviderProfileConfig, secrets: ProviderSecretAccess) {
        this.cfg = cfg;
        this.secrets = secrets;
        this.id = cfg.id;
        this.label = cfg.label;
    }

    async decide(req: ProviderCallRequest): Promise<ProviderCallResult> {
        const auth = this.secrets.authorizationHeader(this.cfg);
        if (this.cfg.authMode === "bearer" && auth === null) {
            throw new ProviderCallError({ code: "PROVIDER_AUTH_FAILED", message: "provider 配置为 bearer 但凭据缺失", retryable: false, safeSummary: "missing secret for secretRef" });
        }
        const startedAt = Date.now();
        const response: JsonPostResponse = await postJson({
            endpoint: {
                baseUrl: this.cfg.baseUrl,
                timeoutMs: this.cfg.timeoutMs ?? PROVIDER_DEFAULTS.timeoutMs,
                allowPrivateNetwork: this.cfg.allowPrivateNetwork === true,
                allowPlainHttp: this.cfg.allowPlainHttp === true
            },
            resourcePath: "/chat/completions",
            body: buildChatBody(this.cfg, req),
            getAuthorization: () => (this.cfg.authMode === "bearer" ? auth : null),
            signal: req.signal
        });
        const json = response.json;
        const usage = readUsage(json);
        const choices = json.choices;
        if (!Array.isArray(choices) || choices.length !== 1) {
            throw new ProviderCallError({
                code: "PROVIDER_BAD_RESPONSE",
                message: Array.isArray(choices) && choices.length === 0 ? "completion 数组为空，不产生动作" : "choices 必须恰好 1 个 completion，不产生动作",
                httpStatus: response.status,
                retryable: false,
                safeSummary: "choices length=" + (Array.isArray(choices) ? String(choices.length) : "missing"),
                requestId: response.requestId
            });
        }
        const choice = choices[0] as Record<string, unknown>;
        const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
        if (finishReason === "length") {
            throw new ProviderCallError({ code: "PROVIDER_OUTPUT_TRUNCATED", message: "输出因长度限制被截断，不产生动作", httpStatus: response.status, retryable: false, safeSummary: "finish_reason=length", requestId: response.requestId });
        }
        if (finishReason === "content_filter" || finishReason === "refusal" || finishReason === "tool_calls" || finishReason === "function_call") {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: `completion 被拒绝或走工具调用（${finishReason}），不产生动作`, httpStatus: response.status, retryable: false, safeSummary: "finish_reason=" + finishReason, requestId: response.requestId });
        }
        const message = choice.message;
        if (!message || typeof message !== "object") {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "缺少 message 对象", httpStatus: response.status, retryable: false, safeSummary: "missing message", requestId: response.requestId });
        }
        const m = message as Record<string, unknown>;
        if (typeof m.refusal === "string" && m.refusal !== "") {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "模型显式拒绝，不产生动作", httpStatus: response.status, retryable: false, safeSummary: "message.refusal set", requestId: response.requestId });
        }
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "模型返回工具调用而非 JSON 决策包，拒绝执行", httpStatus: response.status, retryable: false, safeSummary: "tool_calls present", requestId: response.requestId });
        }
        if (Array.isArray(m.function_call) || (m.function_call !== null && m.function_call !== undefined && typeof m.function_call === "object")) {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "模型返回 function_call 而非 JSON 决策包，拒绝执行", httpStatus: response.status, retryable: false, safeSummary: "function_call present", requestId: response.requestId });
        }
        const text = contentToString(m.content);
        if (text === null || text.trim() === "") {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "completion 正文为空或非文本，不产生动作", httpStatus: response.status, retryable: false, safeSummary: "empty content", requestId: response.requestId });
        }
        return { decisionText: text, usage, latencyMs: Date.now() - startedAt, finishReason: finishReason === "" ? "stop" : finishReason };
    }
}
