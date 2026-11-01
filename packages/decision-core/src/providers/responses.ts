/**
 * openai-responses 适配器（§11.2）：POST {baseUrl}/responses。
 * 只从 status==="completed" 的 message/output_text 部分提取正文；
 * 不依赖 SDK 才有的聚合 output_text，不把 reasoning 或任意 output[0] 当正文。
 * 非 completed 状态一律不产生动作（incomplete+max_output_tokens 记截断）。
 */
import type {
    DecisionProvider,
    ProviderCallRequest,
    ProviderCallResult,
    ProviderProfileConfig,
    ProviderSecretAccess,
    ProviderUsage
} from "./types.js";
import { PROVIDER_DEFAULTS } from "./types.js";
import { ProviderCallError } from "./types.js";
import { postJson } from "./http-client.js";
import type { JsonPostResponse } from "./http-client.js";

const JSON_SCHEMA_NAME = "decision_envelope";

/** 从 REST JSON 结构提取正文：output[] 中 type=message 的 output_text 部分。 */
export function extractResponsesText(json: Record<string, unknown>): string | null {
    const output = json.output;
    if (!Array.isArray(output)) return null;
    const chunks: string[] = [];
    for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        if (rec.type !== "message") continue;
        const content = rec.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type === "output_text" && typeof p.text === "string") chunks.push(p.text);
        }
    }
    return chunks.length > 0 ? chunks.join("") : null;
}

function readUsage(json: Record<string, unknown>): ProviderUsage {
    const usage = json.usage;
    if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        const it = typeof u.input_tokens === "number" ? u.input_tokens : null;
        const ot = typeof u.output_tokens === "number" ? u.output_tokens : null;
        const tt = typeof u.total_tokens === "number" ? u.total_tokens : (it !== null || ot !== null ? (it ?? 0) + (ot ?? 0) : null);
        if (it !== null || ot !== null || tt !== null) {
            return { inputTokens: it, outputTokens: ot, totalTokens: tt, source: "provider" };
        }
    }
    return { inputTokens: null, outputTokens: null, totalTokens: null, source: "unavailable" };
}

export function buildResponsesBody(cfg: ProviderProfileConfig, req: ProviderCallRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: cfg.model,
        instructions: req.systemPrompt,
        input: req.contextJson,
        max_output_tokens: req.maxOutputTokens,
        store: false,
        stream: false
    };
    const format = cfg.decisionFormat ?? PROVIDER_DEFAULTS.decisionFormat;
    if (format === "json_schema") {
        body.text = {
            format: { type: "json_schema", name: JSON_SCHEMA_NAME, strict: true, schema: req.outputSchema }
        };
    } else if (format === "json_object") {
        body.text = { format: { type: "json_object" } };
    }
    if (cfg.supportsTemperature === true && typeof cfg.temperature === "number") body.temperature = cfg.temperature;
    if (cfg.supportsReasoning === true && typeof cfg.reasoningEffort === "string") body.reasoning = { effort: cfg.reasoningEffort };
    return body;
}

export class ResponsesProvider implements DecisionProvider {
    readonly id: string;
    readonly label: string;
    readonly protocol = "openai-responses" as const;
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
            resourcePath: "/responses",
            body: buildResponsesBody(this.cfg, req),
            getAuthorization: () => (this.cfg.authMode === "bearer" ? auth : null),
            signal: req.signal
        });
        const json = response.json;
        const status = typeof json.status === "string" ? json.status : null;
        const usage = readUsage(json);
        if (status !== "completed") {
            const incomplete = json.incomplete_details;
            const reason = incomplete && typeof incomplete === "object" ? String((incomplete as Record<string, unknown>).reason ?? "") : "";
            if (status === "incomplete" && reason === "max_output_tokens") {
                throw new ProviderCallError({ code: "PROVIDER_OUTPUT_TRUNCATED", message: "模型输出被 max_output_tokens 截断，不产生动作", httpStatus: response.status, retryable: false, safeSummary: "incomplete: max_output_tokens", requestId: response.requestId });
            }
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: `Responses 状态非 completed（${status ?? "unknown"}），不产生动作`, httpStatus: response.status, retryable: false, safeSummary: `status=${status ?? "missing"}`, requestId: response.requestId });
        }
        const text = extractResponsesText(json);
        if (text === null || text.trim() === "") {
            throw new ProviderCallError({ code: "PROVIDER_BAD_RESPONSE", message: "Responses 完成但缺少 message/output_text 正文", httpStatus: response.status, retryable: false, safeSummary: "no output_text part", requestId: response.requestId });
        }
        return { decisionText: text, usage, latencyMs: Date.now() - startedAt, finishReason: status };
    }
}
