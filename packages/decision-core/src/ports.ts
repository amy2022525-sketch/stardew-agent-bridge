/**
 * 决策核心与宿主（apps/server 适配层）之间的端口。核心不导入 control-core，
 * 全部外部能力经这些接口注入；适配层是唯一实现处（§17.3 decision-game-port.ts）。
 */
import type {
    ActionReceipt,
    BridgeStatus,
    ControlSessionInfo,
    ErrorCode,
    SnapshotSummary,
    TaskBudget,
    WorldIdentity
} from "@sab/contracts";
import type { DecisionProvider } from "./providers/types.js";
import type { ContextTokenRecord } from "./world-scope.js";

export interface StartControlResult {
    ok: boolean;
    session?: ControlSessionInfo;
    code?: ErrorCode;
    message?: string;
}

export interface DispatchWriteRequest {
    /** 内部执行身份 `sab-internal-decision:<taskId>`，不得与外部 clientId 混用。 */
    internalClientId: string;
    internalClientName: string;
    controlSessionId: string;
    toolName: string;
    /** 已完成 schema 与政策校验的参数；actionId 由服务端生成并在此传入。 */
    args: Record<string, unknown>;
    actionId: string;
    timeoutMs: number;
    signal: AbortSignal;
}

export type DispatchWriteResult =
    | { kind: "receipt"; receipt: ActionReceipt }
    | { kind: "fault"; code: ErrorCode; message: string; effectKnown: boolean };

export interface ReadOnlyResult {
    ok: boolean;
    text: string;
    /** 只读工具的结构化结果（如快照），作为带来源的观察证据保存。 */
    structured: Record<string, unknown> | null;
}

export interface GamePort {
    /** Bridge 聚合状态（Mod 链路、控制持有者、账本可写性等）。 */
    status(): BridgeStatus;
    /** 取新鲜快照；读操作不延长控制租约（§09.4）。 */
    freshSnapshot(): Promise<SnapshotSummary>;
    /** 当前 Mod 上报的稳定身份（来自 Hello 或最近快照）；旧 Mod 与未加载存档为 null。 */
    latestWorldIdentity(): WorldIdentity | null;
    /** 以内部身份创建控制会话；控制权被他人占用时返回 CONTROL_BUSY，不抢占。 */
    startControlSession(internalClientId: string, internalClientName: string): Promise<StartControlResult>;
    endControlSession(internalClientId: string, controlSessionId: string, reason: string): Promise<void>;
    noteActivity(controlSessionId: string): void;
    /** 唯一的写动作派发通道：内部经既有 ActionService/ActionLedger，绝不复制动作逻辑。 */
    dispatchWrite(request: DispatchWriteRequest): Promise<DispatchWriteResult>;
    /** 取消/接管时尽力停止己方在途动作；保留原 actionId 与未知结果。 */
    stopActiveAction(internalClientId: string, actionId: string, signal?: AbortSignal): Promise<DispatchWriteResult>;
    /** 策略允许的只读工具（snapshot/inspect 等）；结果作为观察证据，不建意图。 */
    runReadOnly(internalClientId: string, toolName: string, args: Record<string, unknown>): Promise<ReadOnlyResult>;
}

export interface AuthzPort {
    /** 每次 submit/resume 前实时读取 AuthStore，不用缓存旧授权（§31）。 */
    isClientAuthorized(clientId: string): boolean;
    /** 客户端是否允许使用该 provider（含 clientLimits 收紧）。 */
    isProviderAllowed(clientId: string, providerId: string): boolean;
    /** 客户端是否允许使用该操作政策（clientLimits.policyIds 只能进一步收紧）。 */
    isPolicyAllowed(clientId: string, policyId: string): boolean;
    /** 返回政策冻结视图（id/label/allowedTools/allowedLocations/toolRestrictions/budgetCaps）。 */
    policySnapshot(policyId: string): DecisionPolicyView | null;
    /** 每轮读取当前政策的收紧/撤销；放宽不自动扩权（§15.2）。 */
    currentPolicyTightening(policyId: string): DecisionPolicyView | null;
    /** 有效预算 = min(全局 limits, provider 上限, 任务请求)；缺省取更严。 */
    effectiveBudgetLimits(clientId: string, providerId: string, taskBudget: TaskBudget): Record<string, number>;
    multiplayerAutomationAllowed(): boolean;
}

export interface DecisionPolicyView {
    policyId: string;
    label: string;
    revision: number;
    allowedTools: string[];
    allowedLocations: string[];
    toolRestrictions: Record<string, ToolArgumentGuard>;
    budgetCaps: Record<string, number>;
}

/**
 * 静态实现的工具参数保护（非脚本/正则/SQL）。D1 至少支持：
 * - waterOnly：只允许 water 工具且目标必须来自本轮已观察的作物格；
 * - maxCountPerAction：单次动作数量上限；
 * - allowedItemIds：可消费/交互物品 ID 白名单（若为空表示该 guard 不适用）。
 */
export interface ToolArgumentGuard {
    waterOnly?: boolean;
    maxCountPerAction?: number;
    allowedItemIds?: string[];
    maxGoldSpendPerAction?: number;
}

export interface DecisionEvent {
    kind: string;
    taskId: string;
    payload: Record<string, unknown>;
}

export interface EventSinkPort {
    /** 只发布小摘要 + taskId；禁止泄露 Key/token/原始提示词/错误体。发布失败不改变状态机。 */
    emit(event: DecisionEvent): void;
}

export interface ProviderResolverPort {
    /** 依 providerId 解析当前配置版本的 provider 句柄；配置 CAS 版本随结果返回。 */
    resolveProvider(providerId: string): Promise<{ provider: DecisionProvider; configRevision: number } | { error: string }>;
    /** 已授权 provider 的公开概况（id/label/能力；不含 baseUrl 凭据与 secretRef）。 */
    publicProviderIds(clientId: string): string[];
}

export interface ReceiptLookupPort {
    /** 按 actionId 在本人/本任务作用域查收据；不触发重新执行。 */
    resolveReceipt(actionId: string, clientId: string): ActionReceipt | null;
    /** 作用域内未决（intent 无终态）动作 ID 列表。 */
    unresolvedActionIds(clientId: string): string[];
}

/**
 * contextToken 解析端口（§07.3）：token 明文只在 stardew_context(current) 返回一次；
 * 决策核心仅凭 sha256(token) 经此端口取回绑定记录（apps/server 进程内保存，重启作废）。
 * consume=一次性消费：submit/resume/reply 成功创建新 run 时标记，重复提交经幂等层回放。
 */
export interface ContextTokenPort {
    lookup(tokenHash: string): ContextTokenRecord | null;
    consume(tokenHash: string, taskId: string): boolean;
}
