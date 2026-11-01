/**
 * Preflight 12 条件（§10.1）。纯检查函数：由 Runner 在进入 running 前调用；
 * 任何一条不满足都返回明确原因；控制权归他人 → waiting_main 不抢占；
 * step 暂停未确认 → PAUSE_NOT_CONFIRMED，不把 requested:true 当 paused。
 */
import type { BridgeStatus, ErrorCode, SnapshotSummary } from "@sab/contracts";
import type { BudgetMeter } from "./budget.js";
import type { AuthzPort, GamePort } from "./ports.js";

export interface PreflightInput {
    clientId: string;
    providerId: string;
    nowMs: number;
}

export type PreflightOutcome =
    | { ok: true }
    | { ok: false; code: ErrorCode; message: string; waiting: boolean };

export function runPreflight(deps: {
    game: GamePort;
    authz: AuthzPort;
    status: BridgeStatus;
    executorEnabled: boolean;
    userStopLatched: boolean;
    budget: BudgetMeter;
    hasPendingReviewAction: boolean;
    latestSnapshot: SnapshotSummary | null;
    input: PreflightInput;
}): PreflightOutcome {
    const fail = (code: ErrorCode, message: string, waiting: boolean): PreflightOutcome => ({ ok: false, code, message, waiting });

    // 1 功能启用
    if (!deps.executorEnabled) return fail("DECISION_DISABLED", "决策执行器未启用", false);
    // 2 用户停止锁
    if (deps.userStopLatched) return fail("USER_STOP_LATCHED", "用户停止锁生效，须玩家在 Web 重新允许", false);
    // 3 客户端派单权限（实时查询）
    if (!deps.authz.isClientAuthorized(deps.input.clientId)) return fail("DECISION_NOT_AUTHORIZED", "客户端未获派单授权", false);
    // 3b provider 已配置且协议有效
    if (!deps.authz.isProviderAllowed(deps.input.clientId, deps.input.providerId)) return fail("PROVIDER_NOT_CONFIGURED", "provider 未配置或对本客户端无效", false);
    // 4/5 任务库/账本可写（status.ledger.writable + 调用方保证 store 已开）
    if (!deps.status.ledger.writable) return fail("TASK_STORAGE_UNAVAILABLE", "任务库/动作账本不可写", true);
    // 6 Mod 在线
    if (!deps.status.mod.connected) return fail("BRIDGE_NOT_RUNNING", "Mod 未连接", true);
    // 7 单人世界已加载
    if (!deps.status.mod.saveLoaded) return fail("NO_SAVE_LOADED", "世界未加载（标题页或加载存档中）", true);
    if (deps.status.mod.multiplayer?.enabled === true || deps.status.mod.singlePlayer === false) return fail("MULTIPLAYER_AUTOMATION_UNSUPPORTED", "本版本只运行单人自动任务", false);
    // 8 context 绑定一致（有新鲜快照且实例/代数与 token 作用域一致）
    if (!deps.latestSnapshot) return fail("CONTEXT_EXPIRED", "缺少与 contextToken 一致的新鲜观察", true);
    if (deps.latestSnapshot.instanceId !== deps.status.mod.instanceId) return fail("TASK_SCOPE_CHANGED", "观察与当前游戏实例不一致", true);
    if (deps.latestSnapshot.worldGeneration !== deps.status.mod.worldGeneration) return fail("TASK_SCOPE_CHANGED", "观察与当前世界代数不一致", true);
    // 9 无待复核消费动作（该任务作用域）
    if (deps.hasPendingReviewAction) return fail("RESULT_UNKNOWN", "存在待复核的未知动作", true);
    // 10 控制权空闲（无人持有且无他人活动会话）
    const holder = deps.status.control.holder;
    if (holder && holder.clientId !== internalOf(deps.input.clientId)) {
        return fail("CONTROL_BUSY", `控制权由 ${holder.clientName} 持有，不抢占`, true);
    }
    // 10b 游戏暂停确认
    const pause = deps.status.control.pause;
    if (pause.requested && pause.state !== "paused") {
        return fail("PAUSE_NOT_CONFIRMED", "已请求暂停但游戏尚未确认 paused", true);
    }
    // 11/12 预算可用（模型尝试与写动作至少各剩 1，active 时间未耗尽）
    if (!deps.budget.canSpend("modelCall", 1, deps.input.nowMs).allowed) return fail("BUDGET_EXHAUSTED", "模型调用预算耗尽", true);
    if (!deps.budget.canSpend("writeAction", 1, deps.input.nowMs).allowed) return fail("BUDGET_EXHAUSTED", "写动作预算耗尽", true);
    if (!deps.budget.canSpend("activeMs", 0, deps.input.nowMs).allowed) return fail("BUDGET_EXHAUSTED", "active 时间预算耗尽", true);
    return { ok: true };
}

export function internalOf(externalClientId: string): string {
    return `sab-internal-decision:${externalClientId}`;
}
