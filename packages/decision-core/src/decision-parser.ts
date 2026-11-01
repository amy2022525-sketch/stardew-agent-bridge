/**
 * 模型响应文本 → DecisionEnvelope：JSON 边界检查 + parse + schema 校验；绝不 eval。
 * 多个 JSON、尾随文本、围栏外说明、截断、refusal、未知 kind 全部拒绝（§10.4）。
 */
import { DECISION_ARGUMENTS_JSON_MAX_BYTES, utf8ByteLength } from "@sab/contracts";
import type { DecisionEnvelope } from "@sab/contracts";
import { validateDecisionEnvelope } from "./decision-schema.js";

export interface ParsedDecision {
    ok: true;
    envelope: DecisionEnvelope;
    /** argumentsJson parse 后的对象（act 时提供）。 */
    args?: Record<string, unknown>;
}

export interface ParseFailure {
    ok: false;
    reason: string;
}

export type ParseResult = ParsedDecision | ParseFailure;

const MAX_RESPONSE_BYTES = 64 * 1024;

export function parseDecisionText(text: string): ParseResult {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: "响应为空" };
    if (utf8ByteLength(trimmed) > MAX_RESPONSE_BYTES) return { ok: false, reason: "响应超过体积上限" };
    const jsonText = extractSingleJsonObject(trimmed);
    if (jsonText === null) return { ok: false, reason: "响应不是恰好一个 JSON 对象（禁止多 JSON、尾随文本或围栏外说明）" };
    let value: unknown;
    try {
        value = JSON.parse(jsonText);
    } catch {
        return { ok: false, reason: "JSON 解析失败" };
    }
    const validated = validateDecisionEnvelope(value);
    if (!validated.ok || !validated.envelope) return { ok: false, reason: `DecisionEnvelope 校验失败：${validated.issues.join("；")}` };
    const envelope = validated.envelope;
    if (envelope.kind === "act" && typeof envelope.argumentsJson === "string") {
        let args: unknown;
        try {
            args = JSON.parse(envelope.argumentsJson);
        } catch {
            return { ok: false, reason: "argumentsJson 不是合法 JSON" };
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) return { ok: false, reason: "argumentsJson 必须是 JSON 对象" };
        if (utf8ByteLength(envelope.argumentsJson) > DECISION_ARGUMENTS_JSON_MAX_BYTES) return { ok: false, reason: "argumentsJson 超过 8 KiB" };
        return { ok: true, envelope, args: args as Record<string, unknown> };
    }
    return { ok: true, envelope };
}

/**
 * 提取“恰好一个顶层 JSON 对象”：允许整体被 ```json 围栏包裹；否则文本必须从一个 {
 * 开始并恰好平衡结束，尾部除空白外不得有任何内容，也不得有两个顶层对象。
 */
function extractSingleJsonObject(text: string): string | null {
    const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(text);
    const body = fenced?.[1] !== undefined ? fenced[1].trim() : text;
    if (body.length === 0 || body[0] !== "{") return null;
    // 不预先用 `}{` 之类子串快速拒绝：它可能出现在合法字符串内容里。
    // 下面的扫描器一旦在深度归零后发现尾随内容就会拒绝相邻对象/尾随文本。
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (ch === "\\") { escaped = true; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                const rest = body.slice(i + 1).trim();
                if (rest.length > 0) return null; // 尾随文本
                return body.slice(0, i + 1);
            }
            if (depth < 0) return null;
        }
    }
    return null; // 未平衡：疑似截断
}
