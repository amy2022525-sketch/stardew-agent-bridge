/**
 * 统一工具路由（§17.3）：HTTP MCP、legacy MCP、stdio 与 `/api/v1/tool/<name>` 共用一处。
 *
 * 任务/上下文/记忆工具是 Bridge 业务，绝不能被当成 Mod 命令或游戏写动作发给游戏；
 * 其余工具原样交给既有 ActionService，保持 29 个旧工具的行为不变。
 */
import {
    BridgeError,
    makeFault,
    validateToolArguments,
    type DecisionContextInfo
} from '@sab/contracts';
import type { ActionService, ToolContext, ToolResult } from '@sab/control-core';
import type { ContextTokenStore, DecisionStore, TaskService, TaskQueryService, Principal } from '@sab/decision-core';
import type { DecisionConfigStore } from './decision-config.js';
import type { DecisionGamePort } from './decision-game-port.js';
import type { DecisionMemoryService } from './decision-memory.js';

export const BRIDGE_DECISION_TOOLS: readonly string[] = [
    'stardew_task', 'stardew_task_status', 'stardew_context', 'stardew_memory'
];

export interface BridgeToolRouterOptions {
    actions: ActionService;
    service: TaskService;
    query: TaskQueryService;
    memory: DecisionMemoryService;
    tokens: ContextTokenStore;
    game: DecisionGamePort;
    config: DecisionConfigStore;
    store: DecisionStore;
    enabled: () => boolean;
    stopLatched: () => { latched: boolean; reason: string | null };
    nowMs?: () => number;
}

export class BridgeToolRouter {
    constructor(private readonly deps: BridgeToolRouterOptions) {}

    async executeTool(toolName: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
        if (!BRIDGE_DECISION_TOOLS.includes(toolName)) {
            return this.deps.actions.executeTool(toolName, rawArgs, ctx);
        }
        try {
            const validation = validateToolArguments(toolName, rawArgs);
            if (!validation.ok) {
                const message = validation.tool ? validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') : '未知工具。';
                throw new BridgeError('INVALID_ARGUMENT', '参数校验失败：' + message);
            }
            const args = validation.args as Record<string, unknown>;
            const principal = toPrincipal(ctx);
            switch (toolName) {
                case 'stardew_context':
                    return this.context(principal, args);
                case 'stardew_task':
                    return await this.task(principal, args, ctx.signal);
                case 'stardew_task_status':
                    return await this.taskStatus(principal, args, ctx.signal);
                case 'stardew_memory':
                    return this.memoryTool(principal, args);
                default:
                    throw new BridgeError('INVALID_ARGUMENT', '未知 Bridge 工具。');
            }
        } catch (error) {
            return errorResult(error);
        }
    }

    // -----------------------------------------------------------------------
    // stardew_context
    // -----------------------------------------------------------------------
    private context(principal: Principal, args: Record<string, unknown>): ToolResult {
        this.deps.service.assertExternal(principal);
        const status = this.deps.game.status();
        const identity = this.deps.game.latestWorldIdentity();
        const config = this.deps.config.current;
        const requestedProfile = typeof args.profileId === 'string' ? args.profileId : config.activeProfileId;
        if (!config.profiles.some((profile) => profile.id === requestedProfile)) {
            throw new BridgeError('INVALID_ARGUMENT', 'profileId 不存在。');
        }
        const authorized = this.deps.game.isClientAuthorized(principal.clientId);
        const online = status.mod.connected && status.mod.saveLoaded;
        const latch = this.deps.stopLatched();
        let token: string | null = null;
        let expiresAt: string | null = null;
        if (online && authorized && this.deps.enabled()) {
            const instanceId = status.mod.instanceId;
            const worldGeneration = status.mod.worldGeneration;
            const canPersistent = identity !== null;
            const canEphemeral = instanceId !== null && worldGeneration !== null;
            if (canPersistent || canEphemeral) {
                const scopeKey = canPersistent
                    ? `p:${requestedProfile}:${identity.worldId}:${identity.actorFarmerId}`
                    : `e:${requestedProfile}:${String(instanceId)}:${String(worldGeneration)}`;
                const issued = this.deps.tokens.issue({
                    clientId: principal.clientId,
                    profileId: requestedProfile,
                    scopeKey,
                    worldId: identity?.worldId ?? null,
                    actorFarmerId: identity?.actorFarmerId ?? null,
                    instanceId,
                    worldGeneration,
                    nowMs: this.deps.nowMs?.() ?? Date.now()
                });
                token = issued.token;
                expiresAt = new Date(issued.record.expiresAtMs).toISOString();
            }
        }
        const info: DecisionContextInfo = {
            profileId: requestedProfile,
            automationEnabled: this.deps.enabled() && !latch.latched,
            userStopLatched: latch.latched,
            gameOnline: online,
            contextToken: token,
            contextExpiresAt: expiresAt,
            worldIdentity: identity,
            instanceId: status.mod.instanceId,
            worldGeneration: status.mod.worldGeneration,
            scopeModeOptions: identity ? ['persistent', 'ephemeral'] : ['ephemeral'],
            availableProviderIds: this.deps.game.providerIdsFor(principal.clientId),
            availablePolicyIds: this.deps.game.policyIdsFor(principal.clientId)
        };
        const lines = [
            `作用域 profile=${info.profileId} 世界身份=${identity ? `${identity.worldId}/${identity.actorFarmerId}` : '缺失（只能用 ephemeral）'}`,
            `执行器=${info.automationEnabled ? '已启用' : '未启用或已停止'} 用户停止锁=${info.userStopLatched ? '生效' : '未生效'} 游戏=${online ? '在线' : '离线'}`,
            `可用执行模型=${info.availableProviderIds.join('、') || '（无）'}`,
            `可用操作政策=${info.availablePolicyIds.join('、') || '（无）'}`,
            token ? `contextToken=${token}（60 秒内有效，仅用于本次派单绑定，不是控制租约）` : 'contextToken=null（当前不能派发游戏任务）'
        ];
        return { isError: false, text: lines.join('\n'), structured: { kind: 'decision_context', context: info } };
    }

    // -----------------------------------------------------------------------
    // stardew_task
    // -----------------------------------------------------------------------
    private async task(principal: Principal, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
        void signal;
        const operation = String(args.operation);
        const requestId = String(args.requestId);
        switch (operation) {
            case 'submit': {
                const accepted = await this.deps.service.submit(principal, {
                    requestId,
                    contextToken: String(args.contextToken ?? ''),
                    title: String(args.title ?? ''),
                    goal: String(args.goal ?? ''),
                    providerId: optionalString(args.providerId) ?? undefined,
                    policyId: optionalString(args.policyId) ?? undefined,
                    scopeMode: args.scopeMode === 'ephemeral' ? 'ephemeral' : args.scopeMode === 'persistent' ? 'persistent' : undefined,
                    profileId: optionalString(args.profileId) ?? undefined,
                    constraints: args.constraints as never,
                    budget: args.budget as never,
                    successCriteria: args.successCriteria as never
                });
                return this.taskResult(accepted, '任务已接单；accepted 不代表完成，请用 stardew_task_status 轮询。');
            }
            case 'update': {
                const result = this.deps.service.update(principal, String(args.taskId), {
                    requestId,
                    expectedRevision: Number(args.expectedRevision),
                    patch: (args.patch ?? {}) as never
                });
                return this.taskResult(result, '任务定义已更新。');
            }
            case 'pause': {
                const result = this.deps.service.pause(principal, String(args.taskId), requestId, optionalString(args.reason) ?? undefined);
                return this.taskResult(result, '已请求暂停。');
            }
            case 'cancel': {
                const result = this.deps.service.cancel(principal, String(args.taskId), requestId, optionalString(args.reason) ?? undefined);
                return this.taskResult(result, '已取消后续执行；已发生的动作不被撤销。');
            }
            case 'resume': {
                const result = await this.deps.service.resume(principal, String(args.taskId), requestId, Number(args.expectedRevision), String(args.contextToken ?? ''));
                return this.taskResult(result, '已恢复：新 run 使用新上下文，累计预算不清零。');
            }
            case 'reply': {
                const result = await this.deps.service.reply(principal, String(args.taskId), requestId, Number(args.expectedRevision), String(args.contextToken ?? ''), String(args.answer ?? ''));
                return this.taskResult(result, '答复已记录，任务将用新上下文继续。');
            }
            case 'resolve': {
                const result = this.deps.service.resolve(principal, String(args.taskId), requestId, {
                    expectedRevision: Number(args.expectedRevision),
                    resolution: args.resolution as 'accept_completion' | 'reviewed_pause' | 'reject_completion',
                    note: String(args.note ?? ''),
                    evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((id): id is string => typeof id === 'string') : undefined
                });
                return this.taskResult(result, '复核结论已记录；原动作收据不被修改。');
            }
            default:
                throw new BridgeError('INVALID_ARGUMENT', '未支持的任务操作：' + operation);
        }
    }

    // -----------------------------------------------------------------------
    // stardew_task_status
    // -----------------------------------------------------------------------
    private async taskStatus(principal: Principal, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
        const operation = String(args.operation);
        if (operation === 'get') {
            const view = this.deps.query.get(principal, String(args.taskId));
            return this.viewResult(view, '任务状态。');
        }
        if (operation === 'list') {
            const page = this.deps.query.list(principal, {
                cursor: optionalString(args.cursor) ?? null,
                limit: typeof args.limit === 'number' ? args.limit : 20,
                state: typeof args.state === 'string' ? (args.state as never) : null
            });
            const text = page.tasks.length === 0
                ? '没有匹配的任务。'
                : page.tasks.map((view) => `${view.task.taskId} [${view.task.state}/${view.task.phase}] ${view.task.definition.title}`).join('\n');
            return { isError: false, text: `${text}${page.nextCursor ? `\ncursor=${page.nextCursor}` : ''}`, structured: { kind: 'task_list', tasks: page.tasks, nextCursor: page.nextCursor } };
        }
        if (operation === 'wait') {
            const result = await this.deps.query.wait(principal, {
                taskId: String(args.taskId),
                afterStateVersion: Number(args.afterStateVersion),
                timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 5000,
                signal
            });
            return this.viewResult(result.task, result.changed ? '任务状态已变化。' : '等待超时，状态未变化；后台任务不受影响。');
        }
        throw new BridgeError('INVALID_ARGUMENT', '未支持的状态操作：' + operation);
    }

    // -----------------------------------------------------------------------
    // stardew_memory
    // -----------------------------------------------------------------------
    private memoryTool(principal: Principal, args: Record<string, unknown>): ToolResult {
        const mp = { clientId: principal.clientId, clientName: principal.clientName, admin: false };
        const operation = String(args.operation);
        if (operation === 'search') {
            const result = this.deps.memory.search(mp, {
                query: optionalString(args.query) ?? '',
                kind: args.kind as never,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                taskId: optionalString(args.taskId) ?? undefined
            });
            return {
                isError: false,
                text: result.memories.length === 0 ? '没有匹配的记忆。' : result.memories.map((m) => `${m.memoryId} [${m.kind}/${m.confidenceLabel}] ${m.title}`).join('\n'),
                structured: { kind: 'memory_list', scopeKey: result.scopeKey, memories: result.memories, expiredIds: result.expiredIds, truncated: result.truncated }
            };
        }
        if (operation === 'get') {
            const record = this.deps.memory.get(mp, String(args.memoryId));
            return { isError: false, text: `${record.title}\n${record.content}`, structured: { kind: 'memory', memory: record } };
        }
        if (operation === 'add') {
            const record = this.deps.memory.add(mp, {
                title: String(args.title ?? ''),
                content: String(args.content ?? ''),
                kind: args.kind as never,
                sourceType: args.sourceType === 'user' ? 'user' : 'main_model',
                evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((id): id is string => typeof id === 'string') : undefined,
                taskId: optionalString(args.taskId) ?? undefined,
                expiresAt: typeof args.expiresAt === 'string' ? args.expiresAt : null
            });
            return { isError: false, text: `已记录记忆 ${record.memoryId}（来源 ${record.sourceType}）。`, structured: { kind: 'memory', memory: record } };
        }
        if (operation === 'update') {
            const record = this.deps.memory.update(mp, String(args.memoryId), {
                expectedRevision: Number(args.expectedRevision),
                title: optionalString(args.title) ?? undefined,
                content: optionalString(args.content) ?? undefined,
                expiresAt: args.expiresAt === null ? null : typeof args.expiresAt === 'string' ? args.expiresAt : undefined
            });
            return { isError: false, text: `已更新记忆 ${record.memoryId}（revision ${String(record.revision)}）。`, structured: { kind: 'memory', memory: record } };
        }
        if (operation === 'archive') {
            const record = this.deps.memory.archive(mp, String(args.memoryId));
            return { isError: false, text: `已归档记忆 ${record.memoryId}；动作账本不受影响。`, structured: { kind: 'memory', memory: record } };
        }
        throw new BridgeError('INVALID_ARGUMENT', '未支持的记忆操作：' + operation);
    }

    private taskResult(result: Record<string, unknown>, note: string): ToolResult {
        return { isError: false, text: `${note}\n${JSON.stringify(result)}`, structured: { kind: 'task_result', result } };
    }

    private viewResult(view: ReturnType<TaskService['toView']>, note: string): ToolResult {
        const task = view.task;
        const lines = [
            note,
            `任务 ${task.taskId}「${task.definition.title}」`,
            `状态=${task.state} 阶段=${task.phase} 定义版本=${String(task.definitionRevision)} 状态版本=${String(task.stateVersion)}`,
            `目标=${task.definition.goal}`,
            view.finalSummary ? `摘要=${view.finalSummary}` : '',
            task.blocker ? `卡点=${task.blocker.code}: ${task.blocker.summary}` : '',
            view.unresolvedActionIds.length > 0 ? `未决动作=${view.unresolvedActionIds.join(', ')}` : '未决动作=无',
            `用量：模型 ${String(task.budgetUsed.modelCalls)} 次 / 写动作 ${String(task.budgetUsed.writeActions)} 次 / token ${String(task.budgetUsed.accountedTokens)}${task.budgetUsed.usageUnknown ? '（含未知用量保守预留）' : ''}`,
            task.completion ? `完成证据=${task.completion.evidenceLevel}（存档已写盘=${task.completion.worldSaved}）` : '',
            view.remainingWork.pendingSteps.length > 0 ? `剩余步骤=${view.remainingWork.pendingSteps.join('; ')}` : ''
        ].filter((line) => line !== '');
        return { isError: false, text: lines.join('\n'), structured: { kind: 'task_view', view } };
    }
}

export function toPrincipal(ctx: ToolContext): Principal {
    const transport = ctx.transport === 'web' ? 'web' : ctx.transport === 'stdio' ? 'stdio' : 'http';
    if (ctx.clientId.startsWith('sab-internal-decision:')) {
        throw new BridgeError('DECISION_NOT_AUTHORIZED', '内部执行身份不得调用对外工具。');
    }
    return { clientId: ctx.clientId, clientName: ctx.clientName, transport };
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 错误统一成形，不把内部异常原文抛给用户页面。 */
export function errorResult(error: unknown): ToolResult {
    const bridge = BridgeError.from(error);
    const fault = bridge.fault;
    return {
        isError: true,
        text: `错误 ${fault.code}: ${fault.message}（effectKnown=${String(fault.effectKnown)} 下一步=${fault.nextAction}）`,
        structured: { kind: 'error', fault: makeFault(fault.code, fault.message, { detail: fault.detail ?? null }) }
    };
}
