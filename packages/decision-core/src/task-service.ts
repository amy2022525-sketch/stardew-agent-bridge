/**
 * 任务服务（§08/§09/§17.2）：submit/update/pause/resume/cancel/reply/resolve 的唯一业务入口。
 * MCP、stdio 与 Web 都调用这里，不存在第二套状态机。
 *
 * 关键约束：
 * - ownerClientId 来自认证层，绝不从请求正文读取；内部身份前缀在入口处拒绝。
 * - 单执行槽：一个未结束的自动任务；第二个 submit 返回 EXECUTOR_BUSY，不做隐形排队。
 * - 幂等：requestId 在调用者作用域内唯一；同键同内容回放原结果，同键不同内容报冲突。
 * - 定义 CAS 只在目标/限制/计划/恢复授权实质变化时 +1；进度只 +stateVersion。
 * - pause/cancel 不因过期 revision 被拒绝（紧急停止优先）。
 */
import {
    BridgeError,
    TASK_GOAL_MAX_CHARS,
    TASK_MAX_CRITERIA,
    RESOLUTION_KINDS,
    TASK_TITLE_MAX_CHARS,
    TASK_MAX_TILES_PER_CRITERION,
    isDecisionId,
    isTerminalTaskState,
    type ErrorCode,
    type TaskBudget,
    type TaskConstraints,
    type TaskPlanStep,
    type TaskRecord,
    type TaskState,
    type TaskSuccessCriterion,
    type TaskView,
    type WorldIdentity
} from '@sab/contracts';
import { synthesizeBudget, type EffectiveBudget } from './budget.js';
import type {
    AuthzPort,
    ContextTokenPort,
    DecisionEvent,
    DecisionPolicyView,
    EventSinkPort,
    GamePort,
    ProviderResolverPort
} from './ports.js';
import type { DecisionStore } from './store.js';
import type { Clock } from './clock.js';
import type { MemoryStore } from './memory-store.js';
import { buildScopeKey } from './world-scope.js';
import type { ContextTokenRecord } from './world-scope.js';
import { canonicalHash, newDecisionId } from './ids.js';
import { contextTokenHash } from './context-token.js';
import { summarizeResidualWork } from './progress.js';
import { internalOf } from './preflight.js';

export type PrincipalTransport = 'http' | 'stdio' | 'web' | 'decision';

export interface Principal {
    clientId: string;
    clientName: string;
    transport: PrincipalTransport;
    /** 仅由本机 Web 管理会话置位：可管理任意客户端的任务，但仍不能冒充内部执行身份。 */
    admin?: boolean;
}

/** Runner 接口：TaskService 只负责状态与持久化，真正的循环在 runner.ts。 */
export interface RunnerControl {
    start(task: TaskRecord): Promise<boolean>;
    pause(taskId: string, reason: string): void;
    cancel(taskId: string, reason: string): void;
    isRunning(taskId: string): boolean;
    invalidateAll(reason: string): void;
}

export interface TaskServiceDefaults {
    defaultProviderId: string | null;
    defaultPolicyId: string;
    activeProfileId: string;
}

export interface TaskServiceOptions {
    store: DecisionStore;
    events: EventSinkPort;
    authz: AuthzPort;
    providers: ProviderResolverPort;
    tokens: ContextTokenPort;
    game: GamePort;
    clock: Clock;
    enabled: () => boolean;
    defaults: () => TaskServiceDefaults;
    memory?: MemoryStore;
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

export interface SubmitInput {
    requestId: string;
    contextToken: string;
    title: string;
    goal: string;
    providerId?: string;
    policyId?: string;
    scopeMode?: 'persistent' | 'ephemeral';
    profileId?: string;
    constraints?: TaskConstraints;
    budget?: TaskBudget;
    successCriteria?: TaskSuccessCriterion[];
}

export interface UpdateInput {
    requestId: string;
    expectedRevision: number;
    patch: {
        title?: string;
        goal?: string;
        constraints?: TaskConstraints;
        budget?: TaskBudget;
        successCriteria?: TaskSuccessCriterion[];
    };
}

const PATCH_KEYS = ['title', 'goal', 'constraints', 'budget', 'successCriteria'] as const;
const NON_TERMINAL: readonly TaskState[] = ['queued', 'running', 'pausing', 'paused', 'waiting_main', 'needs_review'];
const STOPPED: readonly TaskState[] = ['paused', 'waiting_main', 'needs_review'];

export class TaskService {
    private runner: RunnerControl | null = null;

    constructor(private readonly deps: TaskServiceOptions) {}

    attachRunner(runner: RunnerControl): void {
        this.runner = runner;
    }

    // -----------------------------------------------------------------------
    // submit
    // -----------------------------------------------------------------------
    async submit(principal: Principal, input: SubmitInput): Promise<Record<string, unknown>> {
        this.assertExternal(principal);
        if (!isDecisionId(input.requestId)) throw new BridgeError('INVALID_ARGUMENT', 'requestId 非法。');
        // Web 手工派单不经过 MCP schema，这里做同样的长度/非空检查。
        if (typeof input.title !== 'string' || input.title.trim().length === 0 || Array.from(input.title).length > TASK_TITLE_MAX_CHARS) {
            throw new BridgeError('INVALID_ARGUMENT', `title 需为 1–${String(TASK_TITLE_MAX_CHARS)} 个字符。`);
        }
        if (typeof input.goal !== 'string' || input.goal.trim().length === 0 || Array.from(input.goal).length > TASK_GOAL_MAX_CHARS) {
            throw new BridgeError('INVALID_ARGUMENT', `goal 需为 1–${String(TASK_GOAL_MAX_CHARS)} 个字符。`);
        }
        // 1. 幂等前置：已存在的 requestId 直接回放，绝不产生第二次副作用。
        const replayed = this.replay(principal.clientId, input.requestId, 'submit', null, this.hashOf('submit', null, input));
        if (replayed) return replayed;

        if (!this.deps.enabled()) throw new BridgeError('DECISION_DISABLED');
        if (!this.deps.authz.isClientAuthorized(principal.clientId)) throw new BridgeError('DECISION_NOT_AUTHORIZED');

        // 2. token 绑定：scope 只来自 token，不信任正文 worldId/ownerClientId。
        const token = this.requireToken(input.contextToken, principal.clientId);
        // profile 只能由 token 决定；正文里的不同值视为作用域混淆，不做静默覆盖。
        if (input.profileId !== undefined && input.profileId !== token.profileId) {
            throw new BridgeError('TASK_SCOPE_CHANGED', 'profileId 与 contextToken 不一致。');
        }
        const scopeMode = input.scopeMode ?? 'persistent';
        if (scopeMode === 'persistent' && (!token.worldId || !token.actorFarmerId)) {
            throw new BridgeError('WORLD_IDENTITY_UNAVAILABLE', '当前存档缺少稳定世界身份：请更新 Mod，或显式使用 scopeMode=ephemeral。');
        }
        const scopeKey = scopeMode === 'persistent'
            ? buildScopeKey({ mode: 'persistent', profileId: token.profileId, worldIdentity: { schemaVersion: 1, source: 'native_game', worldId: token.worldId ?? '', actorFarmerId: token.actorFarmerId ?? '' }, instanceId: token.instanceId, worldGeneration: token.worldGeneration })
            : buildScopeKey({ mode: 'ephemeral', profileId: token.profileId, worldIdentity: null, instanceId: token.instanceId, worldGeneration: token.worldGeneration });
        if (scopeKey === null) throw new BridgeError('WORLD_IDENTITY_UNAVAILABLE', '作用域信息不完整，无法派发持久任务。');

        // 3. 实时复核：token 绑定的世界/实例必须仍是当前世界。
        this.assertTokenStillMatches(token);

        const status = this.deps.game.status();
        if (status.mod.multiplayer?.enabled === true || status.mod.singlePlayer === false) {
            throw new BridgeError('MULTIPLAYER_AUTOMATION_UNSUPPORTED');
        }

        // 4. 单执行槽：仅当已有任务属于同一 owner 的同一 stopped 任务时允许继续管理，其余一律 busy。
        const slot = this.deps.store.currentSlot();
        if (slot) {
            const held = this.deps.store.loadTask(slot.taskId);
            if (held && !isTerminalTaskState(held.state)) throw new BridgeError('EXECUTOR_BUSY');
            // 终态残留：清掉陈旧占位，避免永久占用。
            this.deps.store.clearSlot();
        }

        const defaults = this.deps.defaults();
        const providerId = input.providerId ?? defaults.defaultProviderId;
        if (!providerId) throw new BridgeError('PROVIDER_NOT_CONFIGURED', '未指定执行模型，且配置中没有默认执行模型。');
        if (!this.deps.authz.isProviderAllowed(principal.clientId, providerId)) throw new BridgeError('PROVIDER_NOT_CONFIGURED', '该客户端不允许使用此执行模型，或模型尚未配置。');
        const policyId = input.policyId ?? defaults.defaultPolicyId;
        if (!this.deps.authz.isPolicyAllowed(principal.clientId, policyId)) {
            throw new BridgeError('POLICY_DENIED', '该客户端不允许使用此操作政策：' + policyId);
        }
        const policy = this.deps.authz.policySnapshot(policyId);
        if (!policy) throw new BridgeError('POLICY_DENIED', '未找到可用操作政策：' + policyId);

        const constraints = this.normalizeConstraints(input.constraints, policy);
        const criteria = this.normalizeCriteria(input.successCriteria);
        // Web 手工派单不经过 MCP schema：预算也要逐字段校验，非法值不能被静默忽略。
        const requestedBudget = this.normalizeBudget(input.budget);
        const budgetLimit = this.effectiveBudget(principal.clientId, providerId, requestedBudget);

        const now = this.nowIso();
        const taskId = newDecisionId('task');
        const record: TaskRecord = {
            schemaVersion: 1,
            taskId,
            ownerClientId: principal.clientId,
            definition: {
                title: input.title,
                goal: input.goal,
                providerId,
                constraints,
                budget: requestedBudget ?? {},
                successCriteria: criteria
            },
            definitionRevision: 1,
            stateVersion: 1,
            state: 'queued',
            phase: 'preflight',
            scope: {
                mode: scopeMode,
                profileId: token.profileId,
                worldId: scopeMode === 'persistent' ? token.worldId : null,
                actorFarmerId: scopeMode === 'persistent' ? token.actorFarmerId : null,
                instanceId: token.instanceId,
                worldGeneration: token.worldGeneration,
                scopeKey
            },
            policySnapshot: {
                policyId: policy.policyId,
                revision: policy.revision,
                allowedTools: policy.allowedTools,
                allowedLocations: policy.allowedLocations,
                toolRestrictions: policy.toolRestrictions as unknown as Record<string, unknown>,
                capturedAt: now
            },
            providerRef: providerId,
            budgetLimit,
            budgetUsed: { modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false },
            plan: null,
            currentRunId: null,
            createdAt: now,
            updatedAt: now,
            pauseReason: null,
            blocker: null,
            completion: null,
            lastEvidenceSummary: null
        };

        // 5. 持久化 + 单槽预留 + 幂等结果在同一个短事务外顺序执行：
        //    store 是唯一事务边界；顺序失败时保留 request 行以便重试回放。
        const accepted = {
            schemaVersion: 1,
            accepted: true,
            taskId,
            state: 'queued',
            phase: 'preflight',
            definitionRevision: 1,
            stateVersion: 1,
            completed: false,
            nextPollAfterMs: 2000,
            resumeRequiresUser: false,
            // 首次派单把“实际生效的限制”回给主模型，便于它在开跑前发现与预期不符。
            effectiveLimits: budgetLimit,
            constraints,
            policyId: policy.policyId,
            providerId
        };
        this.deps.store.transaction(() => {
            const reserved = this.deps.store.reserveRequest({
                ownerClientId: principal.clientId,
                requestId: input.requestId,
                operation: 'submit',
                taskId,
                canonicalHash: this.hashOf('submit', null, input),
                createdAt: now
            });
            if (reserved.kind !== 'none') {
                // 并发提交或进程中断留下的同一 requestId：绝不创建第二个任务。
                throw new BridgeError('TASK_IDEMPOTENCY_CONFLICT', 'requestId 已被占用；请用原 requestId 查询结果。');
            }
            this.deps.store.createTask(record);
            if (!this.deps.store.tryAcquireSlot(taskId, 1, now)) throw new BridgeError('EXECUTOR_BUSY');
            this.deps.store.setRequestResult(principal.clientId, input.requestId, accepted);
            this.deps.store.appendEvent(taskId, 'decision_task_created', { payload: { title: input.title, owner: principal.clientId } });
        });
        this.deps.tokens.consume(contextTokenHash(input.contextToken), taskId);
        this.emit('decision_task_created', taskId, { owner: principal.clientId, title: input.title });

        // 6. 立即返回接单结果；执行循环在后台继续，accepted 不代表完成。
        const started = await this.startTask(taskId);
        if (!started) {
            this.deps.logger?.('warn', '任务已创建但执行循环未能启动', { taskId });
        }
        return accepted;
    }

    // -----------------------------------------------------------------------
    // update
    // -----------------------------------------------------------------------
    update(principal: Principal, taskId: string, input: UpdateInput): Record<string, unknown> {
        this.assertExternal(principal);
        const hash = this.hashOf('update', taskId, input);
        const replayed = this.replay(principal.clientId, input.requestId, 'update', taskId, hash);
        if (replayed) return replayed;
        const task = this.requireOwnedTask(principal, taskId);
        if (isTerminalTaskState(task.state)) throw new BridgeError('INVALID_ARGUMENT', '终态任务不可修改；请新建任务。');
        if (task.definitionRevision !== input.expectedRevision) {
            throw new BridgeError('TASK_REVISION_CONFLICT', '任务定义版本冲突：请重新读取当前定义。', { detail: { taskId, currentRevision: task.definitionRevision } });
        }
        const keys = Object.keys(input.patch ?? {});
        if (keys.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'update 的 patch 为空。');
        for (const key of keys) {
            if (!(PATCH_KEYS as readonly string[]).includes(key)) throw new BridgeError('INVALID_ARGUMENT', 'patch 字段不在白名单：' + key);
        }
        const running = task.state === 'running' || task.state === 'pausing';
        if (running && (input.patch.title !== undefined || input.patch.goal !== undefined || input.patch.successCriteria !== undefined)) {
            throw new BridgeError('POLICY_DENIED', '任务运行中只能收紧限制或预算，不能偷换目标。');
        }
        if (!this.deps.authz.isPolicyAllowed(principal.clientId, task.policySnapshot.policyId)) {
            throw new BridgeError('POLICY_DENIED', '该客户端已不被允许使用原操作政策。');
        }
        const policy = this.deps.authz.policySnapshot(task.policySnapshot.policyId);
        if (!policy) throw new BridgeError('POLICY_DENIED', '原政策已不存在，无法校验收紧后的限制。');

        const nextDefinition = { ...task.definition };
        if (input.patch.title !== undefined) {
            if (typeof input.patch.title !== 'string' || input.patch.title.trim().length === 0 || Array.from(input.patch.title).length > TASK_TITLE_MAX_CHARS) {
                throw new BridgeError('INVALID_ARGUMENT', 'title 长度非法。');
            }
            nextDefinition.title = input.patch.title;
        }
        if (input.patch.goal !== undefined) {
            if (typeof input.patch.goal !== 'string' || input.patch.goal.trim().length === 0 || Array.from(input.patch.goal).length > TASK_GOAL_MAX_CHARS) {
                throw new BridgeError('INVALID_ARGUMENT', 'goal 长度非法。');
            }
            nextDefinition.goal = input.patch.goal;
        }
        if (input.patch.constraints !== undefined) nextDefinition.constraints = this.normalizeConstraints(input.patch.constraints, policy);
        if (input.patch.successCriteria !== undefined) nextDefinition.successCriteria = this.normalizeCriteria(input.patch.successCriteria);
        if (input.patch.budget !== undefined) {
            // 预算只能收紧：任何维度都不允许高于当前有效上限。
            nextDefinition.budget = this.tightenBudget(task.budgetLimit, input.patch.budget);
        }
        const now = this.nowIso();
        // 目标/限制/条件变化会让旧计划失去意义：清空步骤，恢复后重新规划（避免沿用旧假设）。
        const planInvalidated = input.patch.title !== undefined || input.patch.goal !== undefined
            || input.patch.constraints !== undefined || input.patch.successCriteria !== undefined;
        const next: TaskRecord = {
            ...task,
            definition: nextDefinition,
            definitionRevision: task.definitionRevision + 1,
            stateVersion: task.stateVersion + 1,
            plan: planInvalidated ? null : task.plan,
            updatedAt: now
        };
        if (input.patch.budget !== undefined) next.budgetLimit = this.effectiveBudget(principal.clientId, task.definition.providerId, nextDefinition.budget);
        const result = { schemaVersion: 1, taskId, definitionRevision: next.definitionRevision, stateVersion: next.stateVersion, state: next.state };
        this.deps.store.transaction(() => {
            this.reserveOperation(principal.clientId, input.requestId, 'update', taskId, hash, now);
            this.deps.store.updateTask(next, task.stateVersion);
            if (planInvalidated) this.deps.store.replaceSteps(taskId, []);
            this.deps.store.appendEvent(taskId, 'decision_definition_updated', { payload: { revision: next.definitionRevision } });
            this.deps.store.setRequestResult(principal.clientId, input.requestId, result);
        });
        this.emit('decision_state_changed', taskId, { state: next.state });
        return result;
    }

    // -----------------------------------------------------------------------
    // pause / cancel：紧急停止优先，不因过期 revision 被拒绝
    // -----------------------------------------------------------------------
    pause(principal: Principal, taskId: string, requestId: string, reason?: string): Record<string, unknown> {
        this.assertExternal(principal);
        const hash = this.hashOf('pause', taskId, { reason: reason ?? null });
        const replayed = this.replay(principal.clientId, requestId, 'pause', taskId, hash);
        if (replayed) return replayed;
        const task = this.requireOwnedTask(principal, taskId);
        // 先占住 requestId，再返回任何结果或产生副作用：冲突的 requestId 不能被顺手复用。
        this.reserveOperation(principal.clientId, requestId, 'pause', taskId, hash, this.nowIso());
        if (isTerminalTaskState(task.state)) {
            return this.pauseResult(task, principal, requestId, '任务已结束，无需暂停。');
        }
        if (STOPPED.includes(task.state)) {
            return this.pauseResult(task, principal, requestId, '任务已经停止。');
        }
        const text = (reason ?? '主模型请求暂停').slice(0, 240);
        // 先让循环失效，再落状态：迟到的模型回答不能继续派发动作。
        this.runner?.pause(taskId, text);
        const now = this.nowIso();
        // 没有活动 run（例如刚接单尚未启动）时，直接进入 paused，避免永远停在 pausing。
        const running = this.runner?.isRunning(taskId) === true;
        const next: TaskRecord = {
            ...task,
            state: running ? 'pausing' : 'paused',
            phase: 'idle',
            pauseReason: text,
            stateVersion: task.stateVersion + 1,
            updatedAt: now
        };
        this.deps.store.transaction(() => {
            this.deps.store.updateTask(next, task.stateVersion);
            this.deps.store.appendEvent(taskId, 'decision_pause_requested', { payload: { reason: text } });
        });
        this.emit('decision_state_changed', taskId, { state: next.state });
        return this.pauseResult(next, principal, requestId, running ? '已请求暂停。' : '任务已暂停。');
    }

    cancel(principal: Principal, taskId: string, requestId: string, reason?: string): Record<string, unknown> {
        this.assertExternal(principal);
        const hash = this.hashOf('cancel', taskId, { reason: reason ?? null });
        const replayed = this.replay(principal.clientId, requestId, 'cancel', taskId, hash);
        if (replayed) return replayed;
        const task = this.requireOwnedTask(principal, taskId);
        this.reserveOperation(principal.clientId, requestId, 'cancel', taskId, hash, this.nowIso());
        if (isTerminalTaskState(task.state)) {
            return this.pauseResult(task, principal, requestId, '任务已结束。');
        }
        const text = (reason ?? '主模型请求取消').slice(0, 240);
        this.runner?.cancel(taskId, text);
        const now = this.nowIso();
        const next: TaskRecord = {
            ...task,
            state: 'cancelled',
            phase: 'idle',
            pauseReason: text,
            stateVersion: task.stateVersion + 1,
            updatedAt: now
        };
        this.deps.store.transaction(() => {
            this.deps.store.updateTask(next, task.stateVersion);
            // 终态释放执行槽；未决动作仍单独列出，不被状态标签吞掉。
            this.deps.store.releaseSlot(taskId, this.deps.store.currentSlot()?.generation ?? 1);
            this.deps.store.appendEvent(taskId, 'decision_cancelled', { payload: { reason: text } });
            this.deps.store.setRequestResult(principal.clientId, requestId, this.cancelResult(next));
        });
        this.emit('decision_state_changed', taskId, { state: 'cancelled' });
        // episode 摘要由 runner 的 onFinished 统一生成，避免取消路径重复写入两条。
        return this.cancelResult(next);
    }

    // -----------------------------------------------------------------------
    // resume / reply：都要新 token、新 run、保留累计预算
    // -----------------------------------------------------------------------
    async resume(principal: Principal, taskId: string, requestId: string, expectedRevision: number, contextToken: string): Promise<Record<string, unknown>> {
        return this.restart(principal, taskId, requestId, expectedRevision, contextToken, 'resume', null);
    }

    async reply(principal: Principal, taskId: string, requestId: string, expectedRevision: number, contextToken: string, answer: string): Promise<Record<string, unknown>> {
        if (typeof answer !== 'string' || answer.trim().length === 0) throw new BridgeError('INVALID_ARGUMENT', 'reply 需要非空 answer。');
        return this.restart(principal, taskId, requestId, expectedRevision, contextToken, 'reply', answer.slice(0, 4096));
    }

    private async restart(
        principal: Principal,
        taskId: string,
        requestId: string,
        expectedRevision: number,
        contextToken: string,
        operation: 'resume' | 'reply',
        answer: string | null
    ): Promise<Record<string, unknown>> {
        this.assertExternal(principal);
        const hash = this.hashOf(operation, taskId, { expectedRevision, answer });
        const replayed = this.replay(principal.clientId, requestId, operation, taskId, hash);
        if (replayed) return replayed;
        const task = this.requireOwnedTask(principal, taskId);
        if (isTerminalTaskState(task.state)) throw new BridgeError('INVALID_ARGUMENT', '终态任务不可恢复；如需继续请新建任务。');
        if (task.definitionRevision !== expectedRevision) throw new BridgeError('TASK_REVISION_CONFLICT');
        if (task.state === 'needs_review') throw new BridgeError('RESULT_UNKNOWN', '任务存在待复核动作：请先 resolve，再恢复。');
        if (operation === 'reply' && task.state !== 'waiting_main') throw new BridgeError('INVALID_ARGUMENT', '只有 waiting_main 任务可以 reply。');
        if (operation === 'resume' && task.state !== 'paused' && task.state !== 'waiting_main') {
            throw new BridgeError('INVALID_ARGUMENT', '只有 paused/waiting_main 任务可以恢复。');
        }
        const store = this.deps.store;
        if (store.isUserStopLatched().latched) throw new BridgeError('USER_STOP_LATCHED');
        if (!this.deps.enabled()) throw new BridgeError('DECISION_DISABLED');
        if (!this.deps.authz.isClientAuthorized(principal.clientId)) throw new BridgeError('DECISION_NOT_AUTHORIZED');
        // 恢复沿用冻结政策；若配置已把该政策/模型撤出该客户端，必须拒绝而不是继续。
        if (!this.deps.authz.isPolicyAllowed(principal.clientId, task.policySnapshot.policyId)) {
            throw new BridgeError('POLICY_DENIED', '该客户端已不被允许使用原操作政策。');
        }
        if (!this.deps.authz.isProviderAllowed(principal.clientId, task.definition.providerId)) {
            throw new BridgeError('PROVIDER_NOT_CONFIGURED', '该客户端已不被允许使用原执行模型。');
        }
        if (store.unresolvedActionIdsForTask(taskId).length > 0) {
            throw new BridgeError('RESULT_UNKNOWN', '仍有未决动作会影响后续安全，禁止恢复；请先核对原动作收据。');
        }
        // 恢复前确认执行槽可用：否则会把任务改成 queued 却永远起不来。
        const slot = store.currentSlot();
        if (slot && slot.taskId !== taskId) {
            throw new BridgeError('EXECUTOR_BUSY', '另一个自动任务正在占用执行槽；请先处理它再恢复。');
        }
        const token = this.requireToken(contextToken, principal.clientId);
        this.assertTokenStillMatches(token);
        if (token.profileId !== task.scope.profileId) throw new BridgeError('TASK_SCOPE_CHANGED', 'token 属于另一个存档分组。');
        if (task.scope.mode === 'persistent' && (token.worldId !== task.scope.worldId || token.actorFarmerId !== task.scope.actorFarmerId)) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '当前世界/角色与任务绑定不一致，不能自动迁移。');
        }
        if (task.scope.mode === 'ephemeral' && (token.instanceId !== task.scope.instanceId || token.worldGeneration !== task.scope.worldGeneration)) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '临时作用域只在一个进程连接周期内有效。');
        }

        const now = this.nowIso();
        const nextRevision = task.definitionRevision + 1;
        const next: TaskRecord = {
            ...task,
            definitionRevision: nextRevision,
            stateVersion: task.stateVersion + 1,
            state: 'queued',
            phase: 'preflight',
            pauseReason: null,
            blocker: null,
            completion: null,
            currentRunId: null,
            updatedAt: now
        };
        const result = {
            schemaVersion: 1,
            accepted: true,
            taskId,
            state: 'queued',
            phase: 'preflight',
            definitionRevision: nextRevision,
            stateVersion: next.stateVersion,
            completed: false,
            nextPollAfterMs: 2000,
            resumeRequiresUser: false,
            // 恢复可能换用新 provider/policy/预算：把实际生效值回给调用方，避免“以为还是旧配置”。
            providerId: next.definition.providerId,
            policyId: next.policySnapshot.policyId,
            effectiveLimits: next.budgetLimit
        };
        store.transaction(() => {
            this.reserveOperation(principal.clientId, requestId, operation, taskId, hash, now);
            store.updateTask(next, task.stateVersion);
            store.appendEvent(taskId, operation === 'reply' ? 'decision_reply_accepted' : 'decision_resumed', {
                payload: answer === null ? { revision: nextRevision } : { revision: nextRevision, answer }
            });
            store.setRequestResult(principal.clientId, requestId, result);
        });
        this.deps.tokens.consume(contextTokenHash(contextToken), taskId);
        if (answer !== null) {
            // 主模型答复只作为任务上下文与事件保存，绝不修改全局权限。
            // 记忆写入失败（例如达到 storage_limit）不应阻止任务恢复；事件里已经留有答复。
            try {
                this.deps.memory?.add({
                    memoryId: newDecisionId('mem'),
                    scopeKey: task.scope.scopeKey,
                    ownerClientId: task.ownerClientId,
                    visibility: 'private',
                    kind: 'task_working',
                    title: '主模型答复',
                    content: answer,
                    sourceType: 'main_model',
                    sourceId: taskId,
                    evidenceIds: [],
                    confidenceLabel: 'reported',
                    observedAt: now,
                    expiresAt: null,
                    supersedesId: null,
                    allowNativeSource: false
                });
            } catch (error) {
                this.deps.logger?.('warn', '保存主模型答复记忆失败，任务继续', { taskId, error: String(error) });
            }
        }
        this.emit('decision_state_changed', taskId, { state: 'queued' });
        await this.startTask(taskId);
        return result;
    }

    // -----------------------------------------------------------------------
    // resolve：只审核候选完成/复核结论，不改写原动作事实
    // -----------------------------------------------------------------------
    resolve(
        principal: Principal,
        taskId: string,
        requestId: string,
        input: { expectedRevision: number; resolution: 'accept_completion' | 'reviewed_pause' | 'reject_completion'; note: string; evidenceIds?: string[] }
    ): Record<string, unknown> {
        this.assertExternal(principal);
        // 枚举必须先校验：未知 resolution 不能被 else 分支当成 reject_completion 执行。
        if (!RESOLUTION_KINDS.includes(input.resolution)) {
            throw new BridgeError('INVALID_ARGUMENT', '未知的 resolution。');
        }
        const hash = this.hashOf('resolve', taskId, input);
        const replayed = this.replay(principal.clientId, requestId, 'resolve', taskId, hash);
        if (replayed) return replayed;
        const task = this.requireOwnedTask(principal, taskId);
        if (task.definitionRevision !== input.expectedRevision) throw new BridgeError('TASK_REVISION_CONFLICT');
        if (task.state !== 'needs_review' && task.state !== 'waiting_main' && task.state !== 'completed') {
            throw new BridgeError('INVALID_ARGUMENT', '只有待复核或等待主模型的任务需要 resolve。');
        }
        if (task.state === 'completed' && input.resolution !== 'accept_completion') {
            throw new BridgeError('INVALID_ARGUMENT', '已完成任务只能确认完成，不能退回暂停或拒绝。');
        }
        const unresolved = this.deps.store.unresolvedActionIdsForTask(taskId);
        const now = this.nowIso();
        let next: TaskRecord;
        if (input.resolution === 'accept_completion') {
            if (!task.completion) throw new BridgeError('INVALID_ARGUMENT', '该任务没有可审核的完成候选。');
            if (unresolved.length > 0) throw new BridgeError('RESULT_UNKNOWN', '存在未决动作时不能接受完成；请先核对原收据。');
            next = {
                ...task,
                state: 'completed',
                phase: 'idle',
                // 人工/主模型确认不能把已机器验证的证据降级；只在原本较弱时提升到 main_reviewed。
                completion: {
                    ...task.completion,
                    evidenceLevel: task.completion.evidenceLevel === 'verified_observation' ? 'verified_observation' : 'main_reviewed',
                    worldSaved: 'unknown'
                },
                blocker: null,
                stateVersion: task.stateVersion + 1,
                updatedAt: now
            };
        } else if (input.resolution === 'reviewed_pause') {
            next = {
                ...task,
                state: 'paused',
                phase: 'idle',
                pauseReason: input.note.slice(0, 240),
                blocker: null,
                stateVersion: task.stateVersion + 1,
                updatedAt: now
            };
        } else {
            next = {
                ...task,
                state: 'waiting_main',
                phase: 'idle',
                pauseReason: input.note.slice(0, 240),
                blocker: {
                    code: 'DECISION_OUTPUT_INVALID' as ErrorCode,
                    summary: '主模型拒绝了完成候选：' + input.note.slice(0, 600),
                    evidenceIds: (input.evidenceIds ?? []).filter(isDecisionId).slice(0, 16),
                    raisedAt: now
                },
                stateVersion: task.stateVersion + 1,
                updatedAt: now
            };
        }
        const result = {
            schemaVersion: 1,
            taskId,
            state: next.state,
            resolution: input.resolution,
            completion: next.completion,
            unresolvedActionIds: unresolved
        };
        this.deps.store.transaction(() => {
            this.reserveOperation(principal.clientId, requestId, 'resolve', taskId, hash, now);
            this.deps.store.updateTask(next, task.stateVersion);
            if (next.state === 'completed' || next.state === 'cancelled') {
                this.deps.store.releaseSlot(taskId, this.deps.store.currentSlot()?.generation ?? 1);
            }
            this.deps.store.appendEvent(taskId, 'decision_resolved', { payload: { resolution: input.resolution } });
            // 幂等结果必须与状态变更同事务：否则崩溃后同 requestId 会变成“已预留但无结果”。
            this.deps.store.setRequestResult(principal.clientId, requestId, result);
        });
        this.emit('decision_state_changed', taskId, { state: next.state });
        if (next.state === 'completed') this.recordEpisode(taskId);
        return result;
    }

    /** 归档终态任务（软删除）：保留任务、事件、未决动作与幂等 tombstone。 */
    archive(principal: Principal, taskId: string): Record<string, unknown> {
        this.assertExternal(principal);
        const task = this.requireOwnedTask(principal, taskId);
        if (!isTerminalTaskState(task.state)) {
            throw new BridgeError('INVALID_ARGUMENT', '只有已完成/失败/取消的任务可以归档；请先取消运行中的任务。');
        }
        this.deps.store.archiveTask(taskId, this.nowIso());
        // 防御性清理：终态任务理论上已释放执行槽，但历史数据可能留有占位。
        const slot = this.deps.store.currentSlot();
        if (slot?.taskId === taskId) this.deps.store.releaseSlot(taskId, slot.generation);
        this.deps.store.appendEvent(taskId, 'decision_archived', { payload: { by: principal.clientId } });
        return { schemaVersion: 1, taskId, archived: true };
    }

    // -----------------------------------------------------------------------
    // 查询辅助（供 task-query 使用）
    // -----------------------------------------------------------------------
    assertExternal(principal: Principal): void {
        const { clientId } = principal;
        if (clientId.startsWith('sab-internal-decision:')) {
            throw new BridgeError('DECISION_NOT_AUTHORIZED', '内部执行身份不得调用任务工具。');
        }
        if (principal.transport === 'decision') {
            throw new BridgeError('DECISION_NOT_AUTHORIZED', '内部传输不可用于对外任务接口。');
        }
    }

    toView(task: TaskRecord): TaskView {
        const unresolved = this.deps.store.unresolvedActionIdsForTask(task.taskId);
        // 计划步骤由 task_steps 表维护（runner 每轮更新状态）；任务行的 plan 只是冗余副本，
        // 这里以表为准，避免 Web 面板永远显示“无短计划”。
        const steps = this.deps.store.loadSteps(task.taskId);
        const viewTask: TaskRecord = steps.length > 0 ? { ...task, plan: steps } : task;
        return {
            schemaVersion: 1,
            task: viewTask,
            unresolvedActionIds: unresolved,
            remainingWork: task.state === 'completed' ? { pendingSteps: [], unverifiedSteps: [], blockers: [] }
                : summarizeResidualWork(viewTask.plan, task.blocker?.summary ?? null),
            finalSummary: this.deps.store.getFinalSummary(task.taskId),
            origin: { kind: task.ownerClientId === 'web' ? 'web' : 'main_model', clientId: task.ownerClientId },
            nextPollAfterMs: task.state === 'running' || task.state === 'queued' ? 2000 : 5000
        };
    }

    requireOwnedTask(principal: Principal, taskId: string): TaskRecord {
        if (!isDecisionId(taskId)) throw new BridgeError('INVALID_ARGUMENT', 'taskId 非法。');
        const task = this.deps.store.loadTask(taskId);
        // 统一“不存在/无权”外形，避免从错误差异枚举私有任务。
        if (!task) throw new BridgeError('NOT_FOUND', '任务不存在或不属于当前客户端。');
        // Web 是本地管理员会话：可以处理所有任务；MCP 客户端只能管理自己拥有的任务。
        if (task.ownerClientId !== principal.clientId && principal.transport !== 'web') {
            throw new BridgeError('NOT_FOUND', '任务不存在或不属于当前客户端。');
        }
        return task;
    }

    /** 每轮/派发前的授权复核，runner 复用。 */
    isStillAuthorized(task: TaskRecord): boolean {
        return this.deps.enabled() && this.deps.authz.isClientAuthorized(task.ownerClientId);
    }

    // -----------------------------------------------------------------------
    // 内部
    // -----------------------------------------------------------------------
    private async startTask(taskId: string): Promise<boolean> {
        if (!this.runner) return false;
        const task = this.deps.store.loadTask(taskId);
        if (!task) return false;
        try {
            return await this.runner.start(task);
        } catch (error) {
            this.deps.logger?.('error', '启动执行循环失败', { taskId, error: String(error) });
            this.failTask(taskId, '执行循环未能启动：' + (error instanceof Error ? error.message : String(error)));
            return false;
        }
    }

    private failTask(taskId: string, summary: string): void {
        const task = this.deps.store.loadTask(taskId);
        if (!task || isTerminalTaskState(task.state)) return;
        try {
            this.deps.store.updateTask({
                ...task,
                state: 'failed',
                phase: 'idle',
                blocker: { code: 'INTERNAL_ERROR', summary: summary.slice(0, 600), evidenceIds: [], raisedAt: this.nowIso() },
                stateVersion: task.stateVersion + 1,
                updatedAt: this.nowIso()
            }, task.stateVersion);
            const slot = this.deps.store.currentSlot();
            if (slot?.taskId === taskId) this.deps.store.releaseSlot(taskId, slot.generation);
        } catch (error) {
            this.deps.logger?.('error', '标记任务失败时写入失败', { taskId, error: String(error) });
        }
    }

    private pauseResult(task: TaskRecord, principal: Principal, requestId: string, note: string): Record<string, unknown> {
        const result = {
            schemaVersion: 1,
            taskId: task.taskId,
            state: task.state,
            phase: task.phase,
            note,
            unresolvedActionIds: this.deps.store.unresolvedActionIdsForTask(task.taskId)
        };
        this.deps.store.setRequestResult(principal.clientId, requestId, result);
        return result;
    }

    private cancelResult(task: TaskRecord): Record<string, unknown> {
        return {
            schemaVersion: 1,
            taskId: task.taskId,
            state: task.state,
            phase: task.phase,
            unresolvedActionIds: this.deps.store.unresolvedActionIdsForTask(task.taskId)
        };
    }

    private replay(clientId: string, requestId: string, operation: 'submit' | 'update' | 'pause' | 'resume' | 'cancel' | 'reply' | 'resolve', taskId: string | null, hash: string): Record<string, unknown> | null {
        const existing = this.deps.store.lookupRequest(clientId, requestId);
        if (!existing) return null;
        if (existing.operation !== operation || existing.canonicalHash !== hash || (taskId !== null && existing.taskId !== null && existing.taskId !== taskId)) {
            throw new BridgeError('TASK_IDEMPOTENCY_CONFLICT', 'requestId 已用于不同内容：返回原任务信息，不产生新副作用。', {
                detail: { requestId, originalOperation: existing.operation, originalTaskId: existing.taskId }
            });
        }
        if (!existing.resultJson) {
            // 预留后结果未写入（进程中断等）：绝不再执行一次副作用，交给查询核对。
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '该 requestId 已预留但结果未写入；请用 stardew_task_status 核对是否有对应任务。', {
                detail: { requestId, taskId: existing.taskId }
            });
        }
        return existing.resultJson;
    }

    /**
     * 为变更类操作预留 requestId。submit 已在创建任务时预留；其余操作也要预留，
     * 否则“pause 的 requestId”可以被再次用于 submit，幂等键就失去作用域。
     */
    private reserveOperation(
        clientId: string,
        requestId: string,
        operation: 'update' | 'pause' | 'resume' | 'cancel' | 'reply' | 'resolve',
        taskId: string,
        hash: string,
        at: string
    ): void {
        const reserved = this.deps.store.reserveRequest({
            ownerClientId: clientId,
            requestId,
            operation,
            taskId,
            canonicalHash: hash,
            createdAt: at
        });
        if (reserved.kind === 'conflict') {
            throw new BridgeError('TASK_IDEMPOTENCY_CONFLICT', 'requestId 已用于不同内容：拒绝新的副作用。', {
                detail: { requestId, originalOperation: reserved.request.operation, originalTaskId: reserved.request.taskId }
            });
        }
        if (reserved.kind === 'same') {
            // 已预留但结果未写入：可能是进程中断。绝不重复执行副作用。
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '该 requestId 已预留但结果未写入；请先查询任务状态。', {
                detail: { requestId, taskId: reserved.request.taskId }
            });
        }
    }

    private hashOf(operation: string, taskId: string | null, payload: unknown): string {
        // token 是绑定凭据而非意图：排除后同一次意图的重试才能正确回放。
        const clone = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
        delete clone['contextToken'];
        delete clone['requestId'];
        return canonicalHash({ operation, taskId, payload: clone });
    }

    private requireToken(raw: string, clientId: string): ContextTokenRecord {
        if (typeof raw !== 'string' || raw.length < 16) throw new BridgeError('CONTEXT_EXPIRED', '缺少有效的 contextToken，请先调用 stardew_context。');
        const record = this.deps.tokens.lookup(contextTokenHash(raw));
        if (!record) throw new BridgeError('CONTEXT_EXPIRED');
        if (record.clientId !== clientId) throw new BridgeError('CONTEXT_EXPIRED', 'contextToken 属于其他客户端。');
        if (record.consumed) throw new BridgeError('CONTEXT_EXPIRED', 'contextToken 已使用；请重新获取。');
        return record;
    }

    private assertTokenStillMatches(token: ContextTokenRecord): void {
        const status = this.deps.game.status();
        if (!status.mod.connected || !status.mod.saveLoaded) throw new BridgeError('GAME_UNAVAILABLE', '游戏未连接或未加载存档。');
        if (token.instanceId !== null && status.mod.instanceId !== null && token.instanceId !== status.mod.instanceId) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '游戏实例已变化。');
        }
        if (token.worldGeneration !== null && status.mod.worldGeneration !== null && token.worldGeneration !== status.mod.worldGeneration) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '世界代次已变化。');
        }
        if (token.worldId !== null) {
            const identity: WorldIdentity | null = this.deps.game.latestWorldIdentity();
            if (identity !== null && (identity.worldId !== token.worldId || identity.actorFarmerId !== token.actorFarmerId)) {
                throw new BridgeError('TASK_SCOPE_CHANGED', '当前存档/角色与 contextToken 不一致。');
            }
        }
    }

    /** 限制只能收紧：地点必须属于政策允许列表，花费受政策上限约束。 */
    private normalizeConstraints(input: TaskConstraints | undefined, policy: DecisionPolicyView): TaskConstraints {
        const out: TaskConstraints = {};
        const locations = input?.locations;
        if (locations !== undefined) {
            if (!Array.isArray(locations) || locations.length > 16) throw new BridgeError('INVALID_ARGUMENT', 'locations 非法。');
            for (const loc of locations) {
                if (typeof loc !== 'string' || loc.length === 0 || loc.length > 64) throw new BridgeError('INVALID_ARGUMENT', '地点名非法。');
                if (policy.allowedLocations.length > 0 && !policy.allowedLocations.includes(loc)) {
                    throw new BridgeError('POLICY_DENIED', '地点不在当前政策允许范围：' + loc);
                }
            }
            out.locations = [...locations];
        } else if (policy.allowedLocations.length > 0) {
            out.locations = [...policy.allowedLocations];
        }
        for (const key of ['stopEnergyAtOrBelow', 'stopHealthAtOrBelow', 'latestStartGameTime', 'maxGoldSpend'] as const) {
            const value = input?.[key];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new BridgeError('INVALID_ARGUMENT', key + ' 必须是非负有限数。');
            if (key === 'latestStartGameTime' && value > 2600) throw new BridgeError('INVALID_ARGUMENT', 'latestStartGameTime 超出游戏时间范围。');
            out[key] = value;
        }
        if (input?.allowDayChange === true) throw new BridgeError('INVALID_ARGUMENT', '本版本禁止跨日续跑：allowDayChange 只能为 false。');
        out.allowDayChange = false;
        const cap = policy.budgetCaps['maxGoldSpend'];
        if (typeof cap === 'number') {
            const requested = out.maxGoldSpend ?? 0;
            if (requested > cap) throw new BridgeError('POLICY_DENIED', `本政策的金币支出上限为 ${String(cap)}。`);
        }
        return out;
    }

    /**
     * Web 手工派单不经过 MCP schema，这里对四种条件做与 validate.ts 等价的检查。
     * 只接受有限枚举，不做任何表达式求值。
     */
    private normalizeCriteria(input: TaskSuccessCriterion[] | undefined): TaskSuccessCriterion[] {
        if (input === undefined) return [];
        if (!Array.isArray(input) || input.length > TASK_MAX_CRITERIA) throw new BridgeError('INVALID_ARGUMENT', '成功条件数量非法。');
        return input.map((criterion) => {
            if (criterion === null || typeof criterion !== 'object') throw new BridgeError('INVALID_ARGUMENT', '成功条件必须是对象。');
            switch (criterion.kind) {
                case 'crop_tiles_watered': {
                    if (typeof criterion.location !== 'string' || criterion.location.length === 0 || criterion.location.length > 64) {
                        throw new BridgeError('INVALID_ARGUMENT', 'crop_tiles_watered 需要合法 location。');
                    }
                    if (!Array.isArray(criterion.tiles) || criterion.tiles.length === 0 || criterion.tiles.length > TASK_MAX_TILES_PER_CRITERION) {
                        throw new BridgeError('INVALID_ARGUMENT', 'crop_tiles_watered 的地块数量非法。');
                    }
                    for (const tile of criterion.tiles) {
                        if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0) {
                            throw new BridgeError('INVALID_ARGUMENT', '地块坐标必须是非负整数。');
                        }
                    }
                    return criterion;
                }
                case 'at_tile': {
                    if (typeof criterion.location !== 'string' || criterion.location.length === 0 || criterion.location.length > 64) {
                        throw new BridgeError('INVALID_ARGUMENT', 'at_tile 需要合法 location。');
                    }
                    if (!Number.isInteger(criterion.x) || !Number.isInteger(criterion.y) || criterion.x < 0 || criterion.y < 0) {
                        throw new BridgeError('INVALID_ARGUMENT', 'at_tile 需要非负整数坐标。');
                    }
                    const tolerance = criterion.tolerance ?? 0;
                    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
                        throw new BridgeError('INVALID_ARGUMENT', 'at_tile 的 tolerance 必须在 0–1。');
                    }
                    return { ...criterion, tolerance };
                }
                case 'inventory_at_least': {
                    if (typeof criterion.itemId !== 'string' || criterion.itemId.length === 0 || criterion.itemId.length > 128) {
                        throw new BridgeError('INVALID_ARGUMENT', 'inventory_at_least 需要合法 itemId。');
                    }
                    if (!Number.isInteger(criterion.count) || criterion.count <= 0) {
                        throw new BridgeError('INVALID_ARGUMENT', 'inventory_at_least 需要正整数 count。');
                    }
                    if (criterion.quality !== undefined && (!Number.isInteger(criterion.quality) || criterion.quality < 0 || criterion.quality > 4)) {
                        throw new BridgeError('INVALID_ARGUMENT', 'quality 超出游戏品质范围。');
                    }
                    return criterion;
                }
                case 'manual_review':
                    return { ...criterion, note: typeof criterion.note === 'string' ? criterion.note.slice(0, 500) : undefined };
                default:
                    throw new BridgeError('INVALID_ARGUMENT', '未知成功条件 kind。');
            }
        });
    }

    /** 预算入参校验：只接受四个已实现的维度，正整数；非法/未知字段直接拒绝。 */
    private normalizeBudget(input: TaskBudget | undefined): TaskBudget | undefined {
        if (input === undefined) return undefined;
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            throw new BridgeError('INVALID_ARGUMENT', 'budget 必须是对象。');
        }
        const allowed = new Set(['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens']);
        for (const key of Object.keys(input)) {
            if (!allowed.has(key)) throw new BridgeError('INVALID_ARGUMENT', '未知预算字段：' + key);
        }
        const out: TaskBudget = {};
        for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens'] as const) {
            const value = input[key];
            if (value === undefined) continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
                throw new BridgeError('INVALID_ARGUMENT', key + ' 必须是正整数。');
            }
            out[key] = value;
        }
        return out;
    }

    private tightenBudget(current: EffectiveBudget, patch: TaskBudget): TaskBudget {
        const out: TaskBudget = {};
        for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens'] as const) {
            const value = patch[key];
            if (value === undefined) continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new BridgeError('INVALID_ARGUMENT', key + ' 必须是正整数。');
            if (value > current[key]) throw new BridgeError('POLICY_DENIED', key + ' 只能收紧：不得高于当前有效上限。');
            out[key] = value;
        }
        return out;
    }

    private effectiveBudget(clientId: string, providerId: string, requested: TaskBudget | undefined): TaskRecord['budgetLimit'] {
        const global = this.deps.authz.effectiveBudgetLimits(clientId, providerId, requested ?? {});
        const synthesized = synthesizeBudget(global, undefined, requested);
        return {
            maxModelCalls: synthesized.maxModelCalls,
            maxWriteActions: synthesized.maxWriteActions,
            maxActiveMs: synthesized.maxActiveMs,
            maxAccountedTokens: synthesized.maxAccountedTokens,
            maxHttpAttempts: synthesized.maxHttpAttempts
        };
    }

    /** 完成/取消时生成确定性 episode 摘要；失败不影响状态机。 */
    recordEpisode(taskId: string): void {
        if (!this.deps.memory) return;
        try {
            const task = this.deps.store.loadTask(taskId);
            if (!task) return;
            const summary = this.deps.store.getFinalSummary(taskId);
            const steps = this.deps.store.loadSteps(taskId);
            const verified = steps.filter((s) => s.status === 'verified_done').length;
            const content = [
                `任务「${task.definition.title}」结束状态：${task.state}。`,
                summary ? `摘要：${summary}` : '无终局摘要。',
                `计划步骤：${String(steps.length)} 个，其中已核验 ${String(verified)} 个。`,
                `用量：模型 ${String(task.budgetUsed.modelCalls)} 次、写动作 ${String(task.budgetUsed.writeActions)} 次。`
            ].join('\n');
            this.deps.memory.add({
                memoryId: newDecisionId('mem'),
                scopeKey: task.scope.scopeKey,
                ownerClientId: task.ownerClientId,
                visibility: 'private',
                kind: 'episodic',
                title: `任务结束：${task.definition.title}`.slice(0, 120),
                content: content.slice(0, 2000),
                sourceType: 'executor',
                sourceId: taskId,
                evidenceIds: [],
                confidenceLabel: 'reported',
                observedAt: this.nowIso(),
                expiresAt: null,
                supersedesId: null,
                allowNativeSource: false
            });
        } catch (error) {
            this.deps.logger?.('warn', '写入 episode 摘要失败', { taskId, error: String(error) });
        }
    }

    private emit(kind: string, taskId: string, payload: Record<string, unknown>): void {
        const event: DecisionEvent = { kind, taskId, payload };
        try {
            this.deps.events.emit(event);
        } catch (error) {
            // 事件失败不改变状态机（§31.6）。
            this.deps.logger?.('warn', '决策事件发送失败', { kind, taskId, error: String(error) });
        }
    }

    private nowIso(): string {
        return new Date(this.deps.clock.nowMs()).toISOString();
    }
}

export { NON_TERMINAL, STOPPED, internalOf };
export type { TaskPlanStep };
