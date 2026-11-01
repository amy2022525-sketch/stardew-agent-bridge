/**
 * 决策上下文构造器（§12.1）。九段固定顺序：
 * 规则版本 → 任务目标/有效政策 → 作用域与状态 → 短计划 → 游戏快照 →
 * 最近动作摘要 → 未决动作 → 相关记忆 → 可用工具与 schema。
 * 上限 48KiB；缩减顺序 entities → inventory → memories → receipts；
 * 绝不删：世界身份、授权边界（工具/地点/政策）、未决动作、预算余量。
 * coverage/truncated 原样透传；不把缺失地块当作没有作物。
 */
import type {
    ActionReceipt,
    BudgetUsage,
    MemoryRecord,
    SnapshotSummary,
    TaskDefinition,
    TaskPhase,
    TaskScope,
    TaskState,
} from "@sab/contracts";
import {
    CONTEXT_JSON_MAX_BYTES,
    CONTEXT_RECENT_ACTION_SUMMARY_MAX,
    DECISION_SCHEMA_VERSION,
    MEMORY_MAX_RESULTS,
    TASK_PLAN_MAX_STEPS,
    utf8ByteLength,
} from "@sab/contracts";
import type { EffectiveBudget } from "./budget.js";
import type { DecisionPolicyView } from "./ports.js";
import type { EffectiveToolSet } from "./tool-policy.js";
import { PROMPT_VERSION } from "./prompts.js";

export interface BudgetRemaining {
    modelCalls: number;
    writeActions: number;
    httpAttempts: number;
    activeMs: number;
    tokens: number;
}

export interface BuildContextInput {
    taskId: string;
    runId: string;
    /** 本轮观察归属 id：写动作事务（§10.3）要求 decision.observationId 与之匹配。 */
    observationId: string;
    taskState: TaskState;
    phase: TaskPhase;
    definition: TaskDefinition;
    providerId: string;
    scope: TaskScope;
    /** 本轮已收紧后的有效政策（§15.3：每轮读取收紧，放宽不扩权）。 */
    policy: DecisionPolicyView;
    effectiveTools: EffectiveToolSet;
    /** 本轮新鲜快照（§10.5）。 */
    snapshot: SnapshotSummary;
    /** 最近动作收据（调用方按时间序传入；本函数截到 CONTEXT_RECENT_ACTION_SUMMARY_MAX）。 */
    recentReceipts: ActionReceipt[];
    /** ledger 中该作用域未决 actionId：受保护段，必须原样送达。 */
    unresolvedActionIds: string[];
    budgetLimit: EffectiveBudget;
    budgetUsed: BudgetUsage;
    budgetRemaining: BudgetRemaining;
    /** 检索结果（已按 §13.3 排序截断）；本函数再防御性截到 MEMORY_MAX_RESULTS。 */
    memories: MemoryRecord[];
    plan: NonNullableSnapshotPlan;
    generatedAtIso: string;
    recentRead?: { toolName: string; observationId: string; text: string; structured: Record<string, unknown> | null } | null;
}

/** 计划步进上下文的形状：允许调用方传 TaskPlanStep[]（含状态）或 null。 */
import type { TaskPlanStep } from "@sab/contracts";
export type NonNullableSnapshotPlan = TaskPlanStep[] | null;

export type BuildContextResult =
    | { ok: true; contextJson: string; byteLength: number; omitted: string[]; includedEvidenceIds: string[] }
    | { ok: false; reason: string };

interface ReceiptSummary {
    actionId: string;
    command: ActionReceipt["command"];
    status: string;
    verified: ActionReceipt["verified"];
    effectKnown: boolean;
    summary: string;
    finishedAt: string | null;
    stopReason: string | null;
}

function summarizeReceipt(r: ActionReceipt): ReceiptSummary {
    return {
        actionId: r.actionId,
        command: r.command,
        status: r.status,
        verified: r.verified,
        effectKnown: r.effectKnown,
        summary: r.summary,
        finishedAt: r.finishedAt ?? null,
        stopReason: r.stopReason ?? null,
    };
}

function memoryProjection(m: MemoryRecord): Record<string, unknown> {
    return {
        memoryId: m.memoryId,
        kind: m.kind,
        title: m.title,
        content: m.content,
        sourceType: m.sourceType,
        confidenceLabel: m.confidenceLabel,
        observedAt: m.observedAt,
        expiresAt: m.expiresAt,
    };
}

export function buildDecisionContext(input: BuildContextInput): BuildContextResult {
    const omitted: string[] = [];
    const entitiesAll = input.snapshot.entities ?? [];
    const inventoryAll = input.snapshot.inventory ?? [];
    const memoriesAll = input.memories.slice(0, MEMORY_MAX_RESULTS);
    if (input.memories.length > memoriesAll.length) {
        omitted.push("memories: 截断至 " + MEMORY_MAX_RESULTS + " 条");
    }
    const receiptsAll = input.recentReceipts.slice(0, CONTEXT_RECENT_ACTION_SUMMARY_MAX);
    if (input.recentReceipts.length > receiptsAll.length) {
        omitted.push("recentActions: 截断至最近 " + CONTEXT_RECENT_ACTION_SUMMARY_MAX + " 条");
    }
    const planAll = (input.plan ?? []).slice(0, TASK_PLAN_MAX_STEPS);
    if ((input.plan ?? []).length > planAll.length) {
        omitted.push("plan: 截断至 " + TASK_PLAN_MAX_STEPS + " 步");
    }

    const assemble = (entityCap: number, inventoryCap: number, memoryCap: number, receiptCap: number): string => {
        const snapshotPart: Record<string, unknown> = {
            snapshotId: input.snapshot.snapshotId,
            instanceId: input.snapshot.instanceId,
            worldGeneration: input.snapshot.worldGeneration,
            sceneGeneration: input.snapshot.sceneGeneration,
            // 受保护：世界身份原样透传，缺失即为身份缺口，不得静默补造。
            worldIdentity: input.snapshot.worldIdentity ?? null,
            sampledAt: input.snapshot.sampledAt,
            location: input.snapshot.location,
            date: input.snapshot.date,
            time: input.snapshot.time,
            player: input.snapshot.player,
            inventory: inventoryAll.slice(0, inventoryCap),
            entities: entitiesAll.slice(0, entityCap),
            exits: input.snapshot.exits ?? [],
            menu: input.snapshot.menu,
            shipping: input.snapshot.shipping,
            // 受保护：覆盖范围与截断标记必须让模型知道“看不到的不等于不存在”。
            truncated: input.snapshot.truncated,
            coverage: input.snapshot.coverage ?? null,
        };
        const context: Record<string, unknown> = {
            schemaVersion: 1,
            // 1. 系统规则与版本（正文规则在 system prompt，这里只送稳定版本号）
            version: { promptVersion: PROMPT_VERSION, decisionSchemaVersion: DECISION_SCHEMA_VERSION },
            // 2. 本任务目标与有效政策
            task: {
                taskId: input.taskId,
                title: input.definition.title,
                goal: input.definition.goal,
                providerId: input.providerId,
                constraints: input.definition.constraints,
                successCriteria: input.definition.successCriteria,
                policy: {
                    policyId: input.policy.policyId,
                    revision: input.policy.revision,
                    label: input.policy.label,
                    allowedTools: input.policy.allowedTools,
                    allowedLocations: input.policy.allowedLocations,
                    toolRestrictions: input.policy.toolRestrictions,
                },
            },
            // 3. 当前作用域与状态（含受保护的预算余量与未决动作提示位）
            world: {
                scope: input.scope,
            },
            state: {
                taskState: input.taskState,
                phase: input.phase,
                // 决策包必须引用本轮观察；observationId 必须随上下文下发，否则模型无法合法回填。
                observationId: input.observationId,
                budget: {
                    limit: input.budgetLimit,
                    used: input.budgetUsed,
                    remaining: input.budgetRemaining,
                },
                generatedAt: input.generatedAtIso,
            },
            // 4. 有界短计划
            plan: planAll,
            // 5. 当前游戏快照
            snapshot: snapshotPart,
            // 6. 最近动作收据摘要
            recentActions: receiptsAll.slice(0, receiptCap).map(summarizeReceipt),
            recentRead: input.recentRead ?? null,
            // 7. 未决动作（受保护：RESULT_UNKNOWN 前禁止继续同类写）
            unresolvedActions: input.unresolvedActionIds,
            // 8. 相关记忆
            memories: memoriesAll.slice(0, memoryCap).map(memoryProjection),
            // 9. 可用工具与参数 schema（已是三层交集后的最终集合）
            tools: input.effectiveTools.tools,
        };
        return JSON.stringify(context);
    };

    let entityCap = entitiesAll.length;
    let inventoryCap = inventoryAll.length;
    let memoryCap = memoriesAll.length;
    let receiptCap = receiptsAll.length;
    let contextJson = "";
    for (;;) {
        contextJson = assemble(entityCap, inventoryCap, memoryCap, receiptCap);
        if (utf8ByteLength(contextJson) <= CONTEXT_JSON_MAX_BYTES) break;
        if (entityCap > 0) {
            entityCap = Math.max(0, Math.floor(entityCap / 2));
            omitted.push("entities: 超 48KiB，缩减至 " + entityCap + " 条");
            continue;
        }
        if (inventoryCap > 0) {
            inventoryCap = Math.max(0, Math.floor(inventoryCap / 2));
            omitted.push("inventory: 超 48KiB，缩减至 " + inventoryCap + " 格");
            continue;
        }
        if (memoryCap > 0) {
            memoryCap = Math.max(0, memoryCap - 1);
            omitted.push("memories: 超 48KiB，缩减至 " + memoryCap + " 条");
            continue;
        }
        if (receiptCap > 0) {
            receiptCap = Math.max(0, receiptCap - 1);
            omitted.push("recentActions: 超 48KiB，缩减至 " + receiptCap + " 条");
            continue;
        }
        // 受保护段与工具 schema 本身超限时：拒绝构造，绝不删世界身份/授权边界/未决动作/预算余量。
        return {
            ok: false,
            reason: "上下文在允许缩减项全部移除后仍超过 48KiB：请缩小观察范围或拆分任务，不得删除受保护段",
        };
    }

    const includedEvidenceIds: string[] = [];
    const pushId = (id: string | null | undefined): void => {
        if (id && !includedEvidenceIds.includes(id)) includedEvidenceIds.push(id);
    };
    pushId(input.observationId);
    pushId(input.snapshot.snapshotId);
    // 最近动作与未决动作的 ID 也是服务器提供的证据，允许模型在 brief/evidence 中引用。
    for (const receipt of receiptsAll.slice(0, receiptCap)) pushId(receipt.actionId);
    for (const actionId of input.unresolvedActionIds) pushId(actionId);
    for (let i = 0; i < memoryCap; i++) {
        const m = memoriesAll[i];
        if (m) pushId(m.memoryId);
    }
    return {
        ok: true,
        contextJson,
        byteLength: utf8ByteLength(contextJson),
        omitted,
        includedEvidenceIds,
    };
}
