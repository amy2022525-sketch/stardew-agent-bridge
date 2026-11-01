/**
 * 步骤推进与无进展检测（§10.5/§12.3）：
 * - step 状态 pending/active/reported_done/verified_done/skipped；仅机器条件 + 有效证据可 verified_done；
 * - 失败指纹 = 同作用域同目标/工具/参数 + 相同失败原因；连续 3 次无进展 → TASK_STALLED；
 * - 时间戳变化或模型换一句理由不算进展；位置/目标完成数/背包变化算进展。
 */
import { canonicalJson } from "@sab/contracts";
import type { StepStatus, TaskPlanStep } from "@sab/contracts";

export const STALL_FINGERPRINT_LIMIT = 3;

export interface ProgressSignals {
    locationChanged: boolean;
    goalProgressChanged: number;
    inventoryDelta: number;
}

export function hasObservableProgress(previous: ProgressSignals | null, current: ProgressSignals): boolean {
    if (!previous) return true; // 首次观察建立基线，不算“有进展”但也不计停滞
    return previous.locationChanged !== current.locationChanged || previous.goalProgressChanged !== current.goalProgressChanged || previous.inventoryDelta !== current.inventoryDelta;
}

export function failureFingerprint(scopeKey: string, toolName: string, args: Record<string, unknown>, failureCode: string): string {
    return canonicalJson({ scopeKey, toolName, args, failureCode });
}

export class StallDetector {
    private lastFingerprint: string | null = null;
    private consecutive = 0;

    /**
     * 返回 true 表示连续 3 次同指纹且其间无可观察进展。
     * 任何一次真实进展（地块/位置/背包变化）都会清零计数；失败原因或参数变化换新指纹。
     */
    recordFailure(fingerprint: string, madeObservableProgress: boolean): boolean {
        if (madeObservableProgress) {
            this.consecutive = 0;
            this.lastFingerprint = fingerprint;
            return false;
        }
        if (this.lastFingerprint === fingerprint) this.consecutive += 1;
        else {
            this.lastFingerprint = fingerprint;
            this.consecutive = 1;
        }
        return this.consecutive >= STALL_FINGERPRINT_LIMIT;
    }

    reset(): void {
        this.lastFingerprint = null;
        this.consecutive = 0;
    }
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
    switch (from) {
        case "pending": return to === "active" || to === "skipped";
        case "active": return to === "reported_done" || to === "skipped";
        case "reported_done": return to === "verified_done" || to === "active" || to === "skipped";
        case "verified_done": return false;
        case "skipped": return false;
        default: return false;
    }
}

export interface ResidualWork {
    pendingSteps: string[];
    unverifiedSteps: string[];
    blockers: string[];
}

/** 剩余工作摘要（§25.2 汇报最少项之一）。 */
export function summarizeResidualWork(plan: TaskPlanStep[] | null, blockerSummary: string | null): ResidualWork {
    if (!plan) return { pendingSteps: [], unverifiedSteps: [], blockers: blockerSummary ? [blockerSummary] : [] };
    return {
        pendingSteps: plan.filter((s) => s.status === "pending" || s.status === "active").map((s) => `${s.stepId}:${s.title}`),
        unverifiedSteps: plan.filter((s) => s.status === "reported_done").map((s) => `${s.stepId}:${s.title}`),
        blockers: blockerSummary ? [blockerSummary] : []
    };
}
