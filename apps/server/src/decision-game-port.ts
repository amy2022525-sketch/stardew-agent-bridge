/**
 * 决策执行器 → 既有游戏控制链的唯一适配层（§17.3）。
 *
 * 这里**不复制**任何动作逻辑：所有写动作仍走 ActionService（record intent → Mod → 收据），
 * 只读工具也走同一 Tool registry。决策核心通过端口拿到结构化结果与收据。
 *
 * 内部身份 `sab-internal-decision:<owner>` 由组合根传给 Runner；请求正文无法伪造它。
 */
import {
    BridgeError,
    ERROR_CODES,
    type ActionReceipt,
    type BridgeStatus,
    type ControlSessionInfo,
    type ErrorCode,
    type SnapshotSummary,
    type TaskBudget,
    type WorldIdentity
} from '@sab/contracts';
import type { ActionLedger, ActionService, ControlManager, ToolResult } from '@sab/control-core';
import type { ModClient } from '@sab/game-client';
import type {
    AuthzPort,
    DecisionPolicyView,
    DispatchWriteRequest,
    DispatchWriteResult,
    GamePort,
    ReadOnlyResult,
    ReceiptLookupPort,
    StartControlResult
} from '@sab/decision-core';
import type { DecisionConfigStore } from './decision-config.js';
import { policyViewOf } from './decision-config.js';

export interface DecisionGamePortOptions {
    actions: ActionService;
    control: ControlManager;
    ledger: ActionLedger;
    mod: ModClient;
    config: DecisionConfigStore;
    isRegisteredClient: (clientId: string) => boolean;
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
    /** 快照半径：太大会挤占上下文预算，6–8 是农场近场的实用范围。 */
    snapshotRadius?: number;
}

export class DecisionGamePort implements GamePort, ReceiptLookupPort, AuthzPort {
    private lastIdentity: WorldIdentity | null = null;
    private readonly radius: number;

    constructor(private readonly deps: DecisionGamePortOptions) {
        this.radius = Math.max(2, Math.min(10, deps.snapshotRadius ?? 6));
    }

    // -----------------------------------------------------------------------
    // GamePort
    // -----------------------------------------------------------------------
    status(): BridgeStatus {
        return this.deps.actions.getStatus();
    }

    async freshSnapshot(): Promise<SnapshotSummary> {
        const result = await this.deps.actions.executeTool(
            'stardew_snapshot',
            { radius: this.radius },
            { clientId: 'sab-internal-decision:snapshot', clientName: '自动任务观察', transport: 'decision' }
        );
        if (result.isError) {
            const fault = faultOf(result);
            throw new BridgeError(mapCode(fault.code), fault.message);
        }
        const structured = result.structured ?? null;
        const snapshot = structured ? (structured['snapshot'] as SnapshotSummary | undefined) : undefined;
        if (!snapshot) throw new BridgeError('INTERNAL_ERROR', '快照结果缺少结构化数据。');
        if (snapshot.worldIdentity) this.lastIdentity = snapshot.worldIdentity;
        return snapshot;
    }

    latestWorldIdentity(): WorldIdentity | null {
        const fromHello = this.deps.mod.hello?.worldIdentity ?? null;
        if (fromHello) return fromHello;
        return this.lastIdentity;
    }

    async startControlSession(internalClientId: string, internalClientName: string): Promise<StartControlResult> {
        try {
            const session = await this.deps.control.start({
                clientId: internalClientId,
                clientName: internalClientName,
                mode: 'step',
                label: internalClientName
            });
            return { ok: true, session };
        } catch (error) {
            const fault = BridgeError.from(error).fault;
            return { ok: false, code: mapCode(fault.code), message: fault.message };
        }
    }

    async endControlSession(internalClientId: string, controlSessionId: string, reason: string): Promise<void> {
        try {
            await this.deps.control.end(internalClientId, controlSessionId, reason);
        } catch (error) {
            // 只结束自己的会话；被别人接管时此处失败是正常结果，不当作错误抛出。
            this.deps.logger?.('debug', '结束己方控制会话未成功', { reason, error: BridgeError.from(error).message });
        }
    }

    noteActivity(controlSessionId: string): void {
        void this.deps.control.noteActivity(controlSessionId);
    }

    async dispatchWrite(request: DispatchWriteRequest): Promise<DispatchWriteResult> {
        const args: Record<string, unknown> = { ...request.args, actionId: request.actionId, controlSessionId: request.controlSessionId };
        const result = await this.deps.actions.executeTool(request.toolName, args, {
            clientId: request.internalClientId,
            clientName: request.internalClientName,
            transport: 'decision',
            signal: request.signal
        });
        const structured = result.structured ?? null;
        const kind = structured ? structured['kind'] : null;
        if (kind === 'action') {
            const receipt = structured?.['receipt'] as ActionReceipt | undefined;
            if (receipt) return { kind: 'receipt', receipt };
        }
        const fault = faultOf(result);
        return { kind: 'fault', code: mapCode(fault.code), message: fault.message, effectKnown: fault.effectKnown };
    }

    async stopActiveAction(internalClientId: string, actionId: string, signal?: AbortSignal): Promise<DispatchWriteResult> {
        const result = await this.deps.actions.executeTool('stardew_stop', { actionId }, {
            clientId: internalClientId,
            clientName: '自动任务停止',
            transport: 'decision',
            signal
        });
        const structured = result.structured ?? null;
        if (structured && structured['kind'] === 'action') {
            const receipt = structured['receipt'] as ActionReceipt | undefined;
            if (receipt) return { kind: 'receipt', receipt };
        }
        const fault = faultOf(result);
        return { kind: 'fault', code: mapCode(fault.code), message: fault.message, effectKnown: fault.effectKnown };
    }

    async runReadOnly(internalClientId: string, toolName: string, args: Record<string, unknown>): Promise<ReadOnlyResult> {
        const result = await this.deps.actions.executeTool(toolName, args, {
            clientId: internalClientId,
            clientName: '自动任务观察',
            transport: 'decision'
        });
        return {
            ok: !result.isError,
            text: result.text.slice(0, 4000),
            structured: result.structured ?? null
        };
    }

    // -----------------------------------------------------------------------
    // AuthzPort：每次实时读取配置与 AuthStore，不用缓存旧授权
    // -----------------------------------------------------------------------
    isClientAuthorized(clientId: string): boolean {
        if (clientId.startsWith('sab-internal-decision:')) return false;
        // Web 是本地管理员会话：可管理全部任务、使用全部已配置 provider/policy。
        // MCP 客户端仍必须显式出现在 authorizedClientIds。
        if (clientId === 'web') return true;
        const config = this.deps.config.current;
        return this.deps.isRegisteredClient(clientId) && config.authorizedClientIds.includes(clientId);
    }

    isProviderAllowed(clientId: string, providerId: string): boolean {
        const config = this.deps.config.current;
        const provider = config.providers.find((entry) => entry.id === providerId);
        if (!provider) return false;
        if (!this.isClientAuthorized(clientId)) return false;
        const limits = config.clientLimits[clientId];
        if (limits?.providerIds && !limits.providerIds.includes(providerId)) return false;
        return true;
    }

    isPolicyAllowed(clientId: string, policyId: string): boolean {
        if (!this.isClientAuthorized(clientId)) return false;
        if (!policyViewOf(this.deps.config.current, policyId)) return false;
        const limits = this.deps.config.current.clientLimits[clientId];
        return limits?.policyIds ? limits.policyIds.includes(policyId) : true;
    }

    policySnapshot(policyId: string): DecisionPolicyView | null {
        return policyViewOf(this.deps.config.current, policyId);
    }

    /** 当前政策的收紧/撤销：D1 的政策来自同一份配置，放宽不会自动扩大已冻结权限。 */
    currentPolicyTightening(policyId: string): DecisionPolicyView | null {
        return policyViewOf(this.deps.config.current, policyId);
    }

    effectiveBudgetLimits(clientId: string, providerId: string, taskBudget: TaskBudget): Record<string, number> {
        const config = this.deps.config.current;
        const merged: Record<string, number> = { ...config.limits };
        // provider 条目只提供请求超时/输出上限，不参与次数预算；因此这里不查找 provider。
        void providerId;
        const clientBudget = config.clientLimits[clientId]?.budget;
        if (clientBudget) {
            for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens'] as const) {
                const value = clientBudget[key];
                if (typeof value === 'number') merged[key] = Math.min(merged[key] ?? value, value);
            }
        }
        for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens'] as const) {
            const value = taskBudget[key];
            if (typeof value === 'number') merged[key] = Math.min(merged[key] ?? value, value);
        }
        return merged;
    }

    multiplayerAutomationAllowed(): boolean {
        return false;
    }

    providerIdsFor(clientId: string): string[] {
        const config = this.deps.config.current;
        if (!this.isClientAuthorized(clientId)) return [];
        const limits = config.clientLimits[clientId];
        return config.providers
            .filter((provider) => !limits?.providerIds || limits.providerIds.includes(provider.id))
            .map((provider) => provider.id);
    }

    policyIdsFor(clientId: string): string[] {
        const config = this.deps.config.current;
        if (!this.isClientAuthorized(clientId)) return [];
        const limits = config.clientLimits[clientId];
        const ids = ['observe-move', 'farm-care', ...config.customPolicies.map((policy) => policy.id)];
        return limits?.policyIds ? ids.filter((id) => limits.policyIds?.includes(id)) : ids;
    }

    // -----------------------------------------------------------------------
    // ReceiptLookupPort
    // -----------------------------------------------------------------------
    resolveReceipt(actionId: string, clientId: string): ActionReceipt | null {
        const receipt = this.deps.actions.resolveReceipt(actionId);
        if (!receipt) return null;
        // 收据可能含坐标/物品等私人上下文：只给发起者或本地管理员看。
        return receipt.clientId === clientId || clientId === 'web' ? receipt : null;
    }

    unresolvedActionIds(clientId: string): string[] {
        return this.deps.ledger
            .unresolved(10)
            .filter((receipt) => receipt.clientId === clientId || clientId === 'web')
            .map((receipt) => receipt.actionId);
    }

    currentSession(): ControlSessionInfo | null {
        return this.deps.control.activeSession;
    }
}

function faultOf(result: ToolResult): { code: string; message: string; effectKnown: boolean } {
    const structured = result.structured ?? null;
    const fault = structured && structured['kind'] === 'error' ? structured['fault'] as Record<string, unknown> | undefined : undefined;
    if (fault) {
        return {
            code: typeof fault['code'] === 'string' ? fault['code'] : 'INTERNAL_ERROR',
            message: typeof fault['message'] === 'string' ? fault['message'] : result.text,
            effectKnown: fault['effectKnown'] !== false
        };
    }
    return { code: 'INTERNAL_ERROR', message: result.text, effectKnown: false };
}

function mapCode(code: string): ErrorCode {
    return Object.hasOwn(ERROR_CODES, code) ? (code as ErrorCode) : 'INTERNAL_ERROR';
}
