/**
 * 预算：默认值（§12.2）、有效上限合成（min 取更严）、原子预留/结算与未知用量保守记账。
 * 重试/恢复/换 run 不重置累计；计数口径：HTTP 尝试含正常/重试/纠错/规划；
 * 写动作在派发前预留（含失败/未知的真实派发），重复收据查询不计。
 */
import type { BudgetUsage, EffectiveTaskBudget, TaskBudget } from "@sab/contracts";

export const BUDGET_DEFAULTS: Required<TaskBudget> & { maxHttpAttempts: number; maxOutputTokensPerCall: number; modelRequestMs: number } = {
    maxModelCalls: 60,
    maxWriteActions: 80,
    maxActiveMs: 10 * 60 * 1000,
    maxAccountedTokens: 120_000,
    maxHttpAttempts: 60,
    maxOutputTokensPerCall: 2048,
    modelRequestMs: 30_000
};

export const MODEL_REQUEST_MS_RANGE = { minMs: 5_000, maxMs: 90_000 } as const;

/** 未回报 usage 的请求按“字节量 + 固定开销”保守预留（标明非服务商 tokenizer）。 */
export const UNKNOWN_TOKEN_RESERVE_BASE = 600;
export const UNKNOWN_TOKEN_BYTES_PER_TOKEN = 4;

export type EffectiveBudget = EffectiveTaskBudget;

/** min(全局, provider, 任务)；任何一侧缺省取更严格值；不超过全局默认。 */
export function synthesizeBudget(
    globalCaps: (TaskBudget & { maxHttpAttempts?: number }) | undefined,
    providerCaps: (TaskBudget & { maxHttpAttempts?: number }) | undefined,
    taskRequest: TaskBudget | undefined
): EffectiveBudget {
    const pick = (key: keyof TaskBudget): number => {
        const values = [BUDGET_DEFAULTS[key], globalCaps?.[key], providerCaps?.[key], taskRequest?.[key]].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
        return Math.min(...values);
    };
    const httpValues = [
        BUDGET_DEFAULTS.maxHttpAttempts,
        globalCaps?.maxHttpAttempts,
        providerCaps?.maxHttpAttempts,
        globalCaps?.maxModelCalls,
        providerCaps?.maxModelCalls,
        taskRequest?.maxModelCalls
    ].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    return {
        maxModelCalls: pick("maxModelCalls"),
        maxWriteActions: pick("maxWriteActions"),
        maxActiveMs: pick("maxActiveMs"),
        maxAccountedTokens: pick("maxAccountedTokens"),
        maxHttpAttempts: Math.min(...httpValues)
    };
}

/** 文本体积的保守 token 预留（本地估算，非 tokenizer）。 */
export function conservativeTokenReserve(text: string, maxOutputTokens: number): number {
    return Math.ceil(Buffer.byteLength(text, "utf8") / UNKNOWN_TOKEN_BYTES_PER_TOKEN) + UNKNOWN_TOKEN_RESERVE_BASE + maxOutputTokens;
}

export type BudgetDimension = "modelCall" | "httpAttempt" | "writeAction" | "activeMs" | "tokens";

export interface BudgetCheck {
    allowed: boolean;
    reason?: BudgetDimension;
}

export interface BudgetSettlement {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    usageKnown: boolean;
    reservedTokens: number;
}

/**
 * 单任务预算计数器。持久化由 store 完成（budgetUsageJson）；这里只做纯逻辑，
 * 便于孤立测试。所有预留先占额度，结算时多退少补；未知用量保留预留并置 usageUnknown。
 */
export class BudgetMeter {
    private usage: BudgetUsage;
    /** 只读上限：runner 需要读取 active 时间与调用上限做边界判断。 */
    readonly limits: EffectiveBudget;
    /** 每次模型请求预留的 token，结算时用实测替换。 */
    private pendingReserve = 0;
    private activeAccumulatedMs: number;
    private runStartedAtMs: number | null = null;

    constructor(limits: EffectiveBudget, persisted: BudgetUsage, clockNowMs: number) {
        this.limits = limits;
        this.usage = { ...persisted };
        this.activeAccumulatedMs = this.usage.activeMs;
        void clockNowMs;
    }

    snapshot(): BudgetUsage {
        return { ...this.usage };
    }

    /** run 开始计时；人工暂停期间调用 pauseClock 停止累计。 */
    startRunClock(nowMs: number): void {
        this.runStartedAtMs = nowMs;
    }

    pauseClock(nowMs: number): void {
        if (this.runStartedAtMs !== null) {
            this.activeAccumulatedMs += Math.max(0, nowMs - this.runStartedAtMs);
            this.usage.activeMs = this.activeAccumulatedMs;
            this.runStartedAtMs = null;
        }
    }

    /** 进入 waiting/pausing 等状态前结算；恢复不清零（activeAccumulatedMs 保留）。 */
    currentActiveMs(nowMs: number): number {
        if (this.runStartedAtMs === null) return this.activeAccumulatedMs;
        return this.activeAccumulatedMs + Math.max(0, nowMs - this.runStartedAtMs);
    }

    canSpend(dim: BudgetDimension, amount: number, nowMs: number): BudgetCheck {
        switch (dim) {
            case "modelCall":
                return { allowed: this.usage.modelCalls + amount <= this.limits.maxModelCalls, reason: "modelCall" };
            case "httpAttempt":
                return { allowed: this.usage.httpAttempts + amount <= this.limits.maxHttpAttempts, reason: "httpAttempt" };
            case "writeAction":
                return { allowed: this.usage.writeActions + amount <= this.limits.maxWriteActions, reason: "writeAction" };
            case "activeMs":
                return { allowed: this.currentActiveMs(nowMs) <= this.limits.maxActiveMs, reason: "activeMs" };
            case "tokens":
                return { allowed: this.usage.accountedTokens + this.pendingReserve + amount <= this.limits.maxAccountedTokens, reason: "tokens" };
        }
    }

    spendHttpAttempt(): void {
        this.usage.httpAttempts += 1;
    }

    /** 发起一次模型调用：计 modelCalls 并预留 token；返回预留量供结算。 */
    reserveModelCall(reserveTokens: number): number {
        this.usage.modelCalls += 1;
        this.pendingReserve += reserveTokens;
        return reserveTokens;
    }

    settleModelCall(reserveTokens: number, settlement: BudgetSettlement): void {
        this.pendingReserve = Math.max(0, this.pendingReserve - reserveTokens);
        if (settlement.usageKnown) {
            const total = settlement.totalTokens ?? ((settlement.inputTokens ?? 0) + (settlement.outputTokens ?? 0));
            this.usage.accountedTokens += Math.max(0, total);
            // A conservative reservation exceeding measured usage does not make usage unknown.
        } else {
            // 未知用量：保留本次保守预留，绝不当 0。
            this.usage.accountedTokens += Math.max(0, settlement.reservedTokens);
            this.usage.usageUnknown = true;
        }
    }

    /** 派发前预留写动作（真实派发即计数，无论后续失败/未知）。 */
    reserveWriteAction(): BudgetCheck {
        if (this.usage.writeActions + 1 > this.limits.maxWriteActions) return { allowed: false, reason: "writeAction" };
        this.usage.writeActions += 1;
        return { allowed: true };
    }

    remaining(): { modelCalls: number; writeActions: number; httpAttempts: number; activeMs: number; tokens: number } {
        return {
            modelCalls: Math.max(0, this.limits.maxModelCalls - this.usage.modelCalls),
            writeActions: Math.max(0, this.limits.maxWriteActions - this.usage.writeActions),
            httpAttempts: Math.max(0, this.limits.maxHttpAttempts - this.usage.httpAttempts),
            activeMs: Math.max(0, this.limits.maxActiveMs - this.activeAccumulatedMs),
            tokens: Math.max(0, this.limits.maxAccountedTokens - this.usage.accountedTokens - this.pendingReserve)
        };
    }
}
