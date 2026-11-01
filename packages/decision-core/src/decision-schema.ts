/**
 * DecisionEnvelope 的本地严格验证（即使 JSON mode 也本地 AJV；§10.4）。
 * 结构由 @sab/contracts 的 DECISION_OUTPUT_SCHEMA 派生，互斥语义在此补充。
 */
import { Ajv, type ValidateFunction } from "ajv";
import {
    DECISION_ARGUMENTS_JSON_MAX_BYTES,
    DECISION_BRIEF_REASON_MAX_CHARS,
    DECISION_MAX_EVIDENCE_IDS,
    DECISION_OUTPUT_SCHEMA,
    TASK_PLAN_MAX_STEPS,
    TASK_STEP_DONE_WHEN_MAX_CHARS,
    TASK_STEP_TITLE_MAX_CHARS,
    isDecisionId,
    utf8ByteLength
} from "@sab/contracts";
import type { DecisionEnvelope } from "@sab/contracts";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, allowUnionTypes: true });
let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
    if (!compiled) compiled = ajv.compile(DECISION_OUTPUT_SCHEMA);
    return compiled;
}

export interface EnvelopeValidationResult {
    ok: boolean;
    issues: string[];
    envelope?: DecisionEnvelope;
}

export function validateDecisionEnvelope(value: unknown): EnvelopeValidationResult {
    const issues: string[] = [];
    const fn = validator();
    if (!fn(value)) {
        for (const err of fn.errors ?? []) {
            issues.push(`${err.instancePath || "(root)"}: ${err.message ?? "不符合 DecisionEnvelope schema"}`);
        }
        return { ok: false, issues };
    }
    const env = value as DecisionEnvelope;
    if (env.schemaVersion !== 1) issues.push("schemaVersion 必须为 1");
    // 按字符数限制：中文一句话不应因为 UTF-8 字节数是字符数的 3 倍而被误判超限。
    if (Array.from(env.briefReason).length > DECISION_BRIEF_REASON_MAX_CHARS) {
        issues.push(`briefReason 超过 ${String(DECISION_BRIEF_REASON_MAX_CHARS)} 字符`);
    }
    if (env.evidenceIds.length > DECISION_MAX_EVIDENCE_IDS) issues.push("evidenceIds 超过 16 条");
    for (const id of env.evidenceIds) {
        if (!isDecisionId(id)) issues.push(`证据 ID 非法：${id}`);
    }
    if (!isDecisionId(env.observationId)) issues.push("observationId 非法");

    if (env.stepId !== null && !isDecisionId(env.stepId)) issues.push("stepId 非法");

    switch (env.kind) {
        case "plan": {
            if (env.plan === null || env.toolName !== null || env.argumentsJson !== null) {
                issues.push("plan 必须只带 plan 字段，不能带工具");
            } else {
                if (env.plan.length > TASK_PLAN_MAX_STEPS) issues.push("plan 超过 12 步");
                const seen = new Set<string>();
                for (const step of env.plan) {
                    if (!isDecisionId(step.stepId)) issues.push(`stepId 非法：${step.stepId}`);
                    if (seen.has(step.stepId)) issues.push(`stepId 重复：${step.stepId}`);
                    seen.add(step.stepId);
                    if (step.title.length === 0 || step.title.length > TASK_STEP_TITLE_MAX_CHARS) issues.push("步骤标题长度非法");
                    if (step.doneWhen.length === 0 || step.doneWhen.length > TASK_STEP_DONE_WHEN_MAX_CHARS) issues.push("步骤 doneWhen 长度非法");
                }
            }
            break;
        }
        case "act": {
            if (env.plan !== null) issues.push("act 不能带 plan");
            if (typeof env.toolName !== "string" || env.toolName.length === 0) issues.push("act 必须提供 toolName");
            if (typeof env.argumentsJson !== "string" || env.argumentsJson.length === 0) issues.push("act 必须提供 argumentsJson");
            else if (utf8ByteLength(env.argumentsJson) > DECISION_ARGUMENTS_JSON_MAX_BYTES) issues.push("argumentsJson 超过 8 KiB");
            break;
        }
        case "finish": {
            if (env.plan !== null || env.toolName !== null || env.argumentsJson !== null) issues.push("finish 不能带工具或 plan");
            if (env.question !== null) issues.push("finish 不能带 question");
            break;
        }
        case "ask_main": {
            if (env.plan !== null || env.toolName !== null || env.argumentsJson !== null) issues.push("ask_main 不能带工具或 plan");
            if (typeof env.question !== "string" || env.question.length === 0) issues.push("ask_main 必须提供 question");
            break;
        }
        default:
            issues.push("未知 kind");
    }
    return { ok: issues.length === 0, issues, envelope: env };
}
