/**
 * 单任务后台执行循环（§10）：观察 → 决策 → 校验 → 原有动作服务 → 核对。
 *
 * 结构性保证：
 * - 同一时刻最多一个写动作在途；写动作只经 GamePort（apps/server 唯一适配），
 *   绝不自建第二条 Mod 写连接，也绝不复制 ActionService 的动作逻辑。
 * - 每个 await 之后重新核对 fence（bootId + taskId + runId + generation + abort）。
 * - 迟到模型回答一律丢弃；暂停/取消先置 flag 与 abort，再在派发前二次检查。
 * - finally 里只释放本 run 自己的控制会话，绝不 end 他人刚取得的会话。
 * - 终态由 TaskService/取消路径决定；runner 不把 cancelled 改回 running。
 */
import {
    BridgeError,
    DECISION_OUTPUT_SCHEMA,
    getTool,
    isErrorCode,
    validateToolArguments,
    type ActionReceipt,
    type DecisionEnvelope,
    type ErrorCode,
    type SnapshotSummary,
    type TaskCompletion,
    type TaskRecord,
    type TaskState
} from '@sab/contracts';
import { BudgetMeter, conservativeTokenReserve, synthesizeBudget } from './budget.js';
import { buildDecisionContext } from './context-builder.js';
import { parseDecisionText } from './decision-parser.js';
import { evaluateCriteria } from './completion.js';
import { EXECUTOR_SYSTEM_PROMPT, PLANNING_SYSTEM_PROMPT, correctionSystemPrompt } from './prompts.js';
import { checkToolGuard, computeEffectiveTools, intersectPolicies, isWriteTool, rejectInjectedIdentityFields } from './tool-policy.js';
import { hasLiveCrop, refreshActionArgs, toolForSlot, wateringTargets } from './game-observation.js';
import type { GuardContext } from './tool-policy.js';
import { recentMemories } from './memory-search.js';
import { newActionId, newDecisionId, canonicalHash } from './ids.js';
import { compareGameDate, snapshotMatchesScope } from './world-scope.js';
import type { DecisionPolicyView, GamePort, AuthzPort, EventSinkPort, ProviderResolverPort } from './ports.js';
import type { DecisionStore } from './store.js';
import type { MemoryStore } from './memory-store.js';
import type { Clock } from './clock.js';
import type { DecisionProvider } from './providers/types.js';
import { ProviderCallError } from './providers/types.js';
import { StallDetector, failureFingerprint, canTransitionStep } from './progress.js';
import type { TaskPlanStep } from '@sab/contracts';

export interface RunnerDeps {
    store: DecisionStore;
    game: GamePort;
    authz: AuthzPort;
    providers: ProviderResolverPort;
    events: EventSinkPort;
    clock: Clock;
    enabled: () => boolean;
    /** 本次 Bridge 启动标识：fence 的第一段，防止跨进程比较 generation。 */
    bootId: string;
    memory?: MemoryStore;
    /** 单次模型请求上限；按 provider 读取（不同模型能力不同），内部再夹到 5–90 秒。 */
    modelRequestTimeoutMs?: (providerId: string) => number;
    /** run 结束后的确定性 episode 摘要钩子；失败不影响状态机。 */
    onFinished?: (taskId: string) => void;
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

interface RunState {
    runId: string;
    /** 创建该 run 的进程标识；跨进程/跨重启的旧状态一律不得继续。 */
    bootId: string;
    generation: number;
    controller: AbortController;
    flags: { pause: boolean; cancel: boolean; reason: string | null };
    providerConfigRevision: number;
    providerId: string;
    startedAtMs: number;
}

interface LoopOutput {
    state: TaskState;
    phase: TaskRecord['phase'];
    summary: string;
    completion: TaskCompletion | null;
    blocker: TaskRecord['blocker'];
}

interface TileStamp {
    hasCrop: boolean;
    watered: boolean;
    season: string;
    day: number;
    year: number;
    observedAtMs: number;
}

const MAX_REPLANS_PER_RUN = 2;
const MAX_CORRECTIONS_PER_DECISION = 1;
const MAX_TRANSPORT_RETRIES = 2;
const EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const MAX_OUTPUT_TOKENS = 2048;

/** 模型决策包 + 已校验的 act 参数（只读/写动作共用）。 */
interface ParsedDecision {
    envelope: DecisionEnvelope;
    args: Record<string, unknown> | null;
}

export class DecisionRunner {
    private readonly runs = new Map<string, RunState>();

    constructor(private readonly deps: RunnerDeps) {}

    isRunning(taskId: string): boolean {
        return this.runs.has(taskId);
    }

    /** 提交或 resume 后启动一次 run。已有运行或缺少槽位返回 false。 */
    async start(task: TaskRecord): Promise<boolean> {
        if (this.runs.has(task.taskId)) return false;
        const existing = this.deps.store.loadTask(task.taskId);
        // 只有 queued 才能开跑：submit/resume 会先落 queued；若期间被暂停/取消，start 必须放弃。
        if (!existing || existing.state !== 'queued') return false;

        const generation = this.nextGeneration(task.taskId);
        const now = this.nowIso();
        if (!this.deps.store.tryAcquireSlot(task.taskId, generation, now)) return false;
        const runId = newDecisionId('run');
        const providerId = existing.definition.providerId;
        this.deps.store.transaction(() => {
            this.deps.store.insertRun({
                runId,
                taskId: task.taskId,
                generation,
                state: 'active',
                providerId,
                providerConfigRevision: 0,
                policyRevision: existing.policySnapshot.revision,
                internalClientId: `sab-internal-decision:${existing.ownerClientId}`,
                controlSessionId: null,
                startReason: 'start',
                endReason: null,
                startedAt: now,
                endedAt: null
            });
            const next: TaskRecord = {
                ...existing,
                currentRunId: runId,
                state: 'queued',
                phase: 'preflight',
                stateVersion: existing.stateVersion + 1,
                updatedAt: now
            };
            this.deps.store.updateTask(next, existing.stateVersion);
        });

        const controller = new AbortController();
        const state: RunState = {
            runId,
            bootId: this.deps.bootId,
            generation,
            controller,
            flags: { pause: false, cancel: false, reason: null },
            providerConfigRevision: 0,
            providerId,
            startedAtMs: this.deps.clock.nowMs()
        };
        this.runs.set(task.taskId, state);
        void this.execute(task.taskId, state).catch((error: unknown) => {
            this.deps.logger?.('error', '执行循环异常终止', { taskId: task.taskId, error: String(error) });
        });
        return true;
    }

    /** 暂停：立即 fence（abort 模型请求），循环收尾后进入 paused。 */
    pause(taskId: string, reason: string): void {
        const run = this.runs.get(taskId);
        if (!run) return;
        run.flags.pause = true;
        run.flags.reason = reason;
        run.controller.abort(new BridgeError('CANCELLED', '任务已暂停'));
    }

    /** 取消：先切断未来调度，再由收尾逻辑停止己方动作并保留未决事实。 */
    cancel(taskId: string, reason: string): void {
        const run = this.runs.get(taskId);
        if (!run) return;
        run.flags.cancel = true;
        run.flags.reason = reason;
        run.controller.abort(new BridgeError('CANCELLED', '任务已取消'));
    }

    /** Bridge 停机/人工接管：使所有 generation 失效。 */
    invalidateAll(reason: string): void {
        for (const [, run] of this.runs) {
            run.flags.cancel = true;
            run.flags.reason = reason;
            run.controller.abort(new Error(reason));
        }
    }

    // -----------------------------------------------------------------------
    // 主循环
    // -----------------------------------------------------------------------
    private async execute(taskId: string, run: RunState): Promise<void> {
        let output: LoopOutput | null = null;
        let controlSessionId: string | null = null;
        let attemptNo = 0;
        let budget: BudgetMeter | null = null;
        let provider: DecisionProvider | null = null;
        let replans = 0;
        let lastWatered = 0;
        const stall = new StallDetector();
        const tiles = new Map<string, TileStamp>();
        let startDate: { season: string; day: number; year: number } | null = null;
        let lastSnapshot: SnapshotSummary | null = null;
        let lastObservationId: string | null = null;
        let recentRead: { toolName: string; observationId: string; text: string; structured: Record<string, unknown> | null } | null = null;
        const internalClientId = `sab-internal-decision:${this.loadTask(taskId)?.ownerClientId ?? 'unknown'}`;

        try {
            let task = this.loadTask(taskId);
            if (!task) throw new BridgeError('NOT_FOUND', '任务不存在。');
            budget = new BudgetMeter(
                synthesizeBudget(task.budgetLimit, undefined, task.definition.budget),
                task.budgetUsed,
                this.deps.clock.nowMs()
            );
            budget.startRunClock(this.deps.clock.nowMs());

            // —— 启动前检查（§10.1）——
            if (!this.deps.enabled()) throw new BridgeError('DECISION_DISABLED');
            const latch = this.deps.store.isUserStopLatched();
            if (latch.latched) throw new BridgeError('USER_STOP_LATCHED', latch.reason ?? undefined);
            if (!this.deps.authz.isClientAuthorized(task.ownerClientId)) throw new BridgeError('DECISION_NOT_AUTHORIZED');
            const resolved = await this.deps.providers.resolveProvider(task.definition.providerId);
            if ('error' in resolved) throw new BridgeError('PROVIDER_NOT_CONFIGURED', resolved.error);
            provider = resolved.provider;
            run.providerConfigRevision = resolved.configRevision;
            this.deps.store.updateRunProvider(run.runId, task.definition.providerId, resolved.configRevision);
            if (run.controller.signal.aborted) throw this.abortError(run);

            const status = this.deps.game.status();
            if (!status.ledger.writable) throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '动作账本不可写。');
            if (!status.mod.connected) throw new BridgeError('GAME_UNAVAILABLE', 'Mod 未连接。');
            if (!status.mod.saveLoaded) throw new BridgeError('GAME_UNAVAILABLE', '存档未加载。');
            if (status.mod.multiplayer?.enabled === true || status.mod.singlePlayer === false) {
                throw new BridgeError('MULTIPLAYER_AUTOMATION_UNSUPPORTED');
            }
            if (status.control.holder && status.control.holder.clientId !== internalClientId) {
                throw new BridgeError('CONTROL_BUSY', `控制权由 ${status.control.holder.clientName} 持有，不抢占。`);
            }
            if (this.deps.store.unresolvedActionIdsForTask(taskId).length > 0 || status.control.unresolvedActionIds.length > 0) {
                throw new BridgeError('RESULT_UNKNOWN', '存在未决动作：需要先核对原收据。');
            }
            if (!budget.canSpend('activeMs', 0, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', 'active 时间预算已耗尽。');

            // —— 新鲜观察 + 作用域核对 ——
            lastSnapshot = await this.deps.game.freshSnapshot();
            this.assertFence(taskId, run);
            this.assertScope(task, lastSnapshot);
            startDate = lastSnapshot.date ? { ...lastSnapshot.date } : null;
            lastObservationId = this.recordObservation(task, run.runId, lastSnapshot);

            // —— 取得本 run 自己的控制会话 ——
            const control = await this.deps.game.startControlSession(internalClientId, `自动任务 ${taskId}`);
            // Capture the acquired session before cancellation can throw, so finally releases it.
            controlSessionId = control.session?.controlSessionId ?? null;
            this.assertFence(taskId, run);
            if (!control.ok || !control.session) {
                throw new BridgeError(control.code ?? 'CONTROL_BUSY', control.message ?? '无法取得控制会话。');
            }
            controlSessionId = control.session.controlSessionId;
            this.deps.store.updateRunControl(run.runId, controlSessionId);

            // 暂停确认必须在取得控制之后：acquire 才会请求游戏进入菜单。
            // 之前的实现读的是 acquire 之前的旧状态，running 时会被误判为 PAUSE_NOT_CONFIRMED。
            await this.waitForPauseConfirmed(run, 3_000);
            this.patch(taskId, { state: 'running', phase: 'observing' });

            // —— 主循环 ——
            while (!run.controller.signal.aborted) {
                task = this.loadTask(taskId);
                if (!task) break;
                if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') break;
                if (this.fenceBroken(task, run)) break;
                if (run.flags.cancel) break;

                if (!this.deps.enabled()) throw new BridgeError('DECISION_DISABLED', '执行器已在运行中被禁用。');
                if (!this.deps.authz.isClientAuthorized(task.ownerClientId)) throw new BridgeError('DECISION_NOT_AUTHORIZED', '客户端授权已被撤销。');
                if (this.deps.store.isUserStopLatched().latched) throw new BridgeError('USER_STOP_LATCHED');
                if (!budget.canSpend('activeMs', 0, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', 'active 时间预算耗尽。');

                let snapshot = await this.deps.game.freshSnapshot();
                this.assertFence(taskId, run);
                lastSnapshot = snapshot;
                this.assertScope(task, snapshot);
                this.absorbTiles(tiles, snapshot);
                lastObservationId = this.recordObservation(task, run.runId, snapshot);

                // 停止条件：开始下一动作之前检查（不承诺帧级不跨界）。
                // 资源/时间到限是“正常停止并保留进度”，不是卡死；交给主模型决定是否继续。
                const stop = this.stopCondition(task, snapshot);
                if (stop !== null) {
                    output = {
                        state: 'waiting_main',
                        phase: 'idle',
                        summary: stop.message,
                        completion: null,
                        blocker: { code: stop.code, summary: stop.message, evidenceIds: [], raisedAt: this.nowIso() }
                    };
                    break;
                }

                // 自然跨日：D1 不跨日，进入待复核而不是继续用昨天的证据。
                if (startDate !== null && compareGameDate(startDate, snapshot.date) === 'day_changed') {
                    throw new BridgeError('TASK_SCOPE_CHANGED', '游戏日期已变化：本版本不支持跨日续跑，请复核后新建任务。');
                }

                const unresolved = this.deps.store.unresolvedActionIdsForTask(taskId);
                const evaluation = evaluateCriteria(task.definition.successCriteria, {
                    tileObservations: tiles,
                    latest: { snapshot, observedAtMs: this.deps.clock.nowMs() },
                    scopeMatchesWorld: this.scopeMatches(task, snapshot),
                    unresolvedActionIds: unresolved,
                    nowMs: this.deps.clock.nowMs(),
                    evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS
                });
                if (evaluation.allMet) {
                    output = {
                        state: 'completed',
                        phase: 'idle',
                        summary: '确定性成功条件已在最新观察中全部满足。',
                        completion: { evidenceLevel: 'verified_observation', criterionResults: evaluation.results, worldSaved: 'unknown' },
                        blocker: null
                    };
                    break;
                }

                // 每轮读取政策收紧；放宽不自动扩权。
                let policy = this.currentPolicy(task);
                const modStatus = this.deps.game.status().mod;
                let tools = computeEffectiveTools(policy, [...modStatus.capabilities, ...modStatus.writeCommands]);
                if (tools.toolNames.length === 0) {
                    throw new BridgeError('POLICY_DENIED', '当前政策没有给执行模型任何可用工具。');
                }

                const memories = this.deps.memory
                    ? recentMemories(this.deps.store, { clientId: task.ownerClientId, scopeKey: task.scope.scopeKey, count: 12 }, this.deps.clock.nowMs())
                    : [];
                const built = buildDecisionContext({
                    taskId,
                    runId: run.runId,
                    observationId: lastObservationId,
                    taskState: 'running',
                    phase: 'thinking',
                    definition: task.definition,
                    providerId: task.definition.providerId,
                    scope: task.scope,
                    policy,
                    effectiveTools: tools,
                    snapshot,
                    recentReceipts: this.recentReceipts(task, run.runId),
                    unresolvedActionIds: unresolved,
                    budgetLimit: task.budgetLimit,
                    budgetUsed: budget.snapshot(),
                    budgetRemaining: budget.remaining(),
                    memories: memories.map((hit) => hit.record),
                    plan: this.deps.store.loadSteps(taskId),
                    generatedAtIso: this.nowIso(),
                    recentRead
                });
                if (!built.ok) throw new BridgeError('CONTEXT_EXPIRED', built.reason);
                if (built.byteLength === 0) throw new BridgeError('INTERNAL_ERROR', '上下文构造为空。');

                // 控制租约只由真实动作续期；模型思考/退避接近期限时主动停下，绝不发假写动作保活。
                const holder = this.deps.game.status().control.holder;
                if (holder && holder.controlSessionId === controlSessionId) {
                    const remainingMs = Date.parse(holder.expiresAt) - this.deps.clock.nowMs();
                    if (Number.isFinite(remainingMs) && remainingMs < 35_000) {
                        throw new BridgeError('CONTROL_EXPIRED', '控制租约即将到期，已停止本次运行；重新恢复后会取得新的控制会话。');
                    }
                }
                this.patch(taskId, { phase: 'thinking' });
                const hasPlan = this.deps.store.loadSteps(taskId).length > 0;
                const parsedDecision = await this.askModel(task, run, budget, provider, built.contextJson, null, !hasPlan);
                this.assertFence(taskId, run);
                const decision = parsedDecision.envelope;
                if (decision.observationId !== lastObservationId) {
                    throw new BridgeError('DECISION_OUTPUT_INVALID', '决策引用的不是本轮观察。');
                }
                // evidenceIds 只能引用服务器本轮实际提供过的证据，不能凭空编造或跨任务引用。
                const allowedEvidence = new Set(built.includedEvidenceIds);
                const unknownEvidence = decision.evidenceIds.filter((id) => !allowedEvidence.has(id));
                if (unknownEvidence.length > 0) {
                    throw new BridgeError('DECISION_OUTPUT_INVALID', '决策引用了本轮未提供的证据：' + unknownEvidence.join(', '));
                }

                if (decision.kind === 'plan' && decision.plan) {
                    if (replans >= MAX_REPLANS_PER_RUN) {
                        throw new BridgeError('TASK_STALLED', '本次运行已达到重规划上限，且仍未推进；请汇报卡点。');
                    }
                    replans += 1;
                    this.deps.store.replaceSteps(taskId, decision.plan.map((step) => ({ ...step, status: 'pending' as const, evidenceIds: [] })));
                    this.patch(taskId, { phase: 'observing', lastEvidenceSummary: decision.briefReason });
                    continue;
                }

                if (decision.kind === 'ask_main') {
                    output = {
                        state: 'waiting_main',
                        phase: 'idle',
                        summary: decision.question ?? decision.briefReason,
                        completion: null,
                        blocker: {
                            code: 'TASK_STALLED' as ErrorCode,
                            summary: (decision.question ?? decision.briefReason).slice(0, 600),
                            evidenceIds: decision.evidenceIds.slice(0, 16),
                            raisedAt: this.nowIso()
                        }
                    };
                    break;
                }

                if (decision.kind === 'finish') {
                    const fresh = await this.deps.game.freshSnapshot();
                    this.assertFence(taskId, run);
                    lastSnapshot = fresh;
                    this.assertScope(task, fresh);
                    this.absorbTiles(tiles, fresh);
                    this.recordObservation(task, run.runId, fresh);
                    const finalEval = evaluateCriteria(task.definition.successCriteria, {
                        tileObservations: tiles,
                        latest: { snapshot: fresh, observedAtMs: this.deps.clock.nowMs() },
                        scopeMatchesWorld: this.scopeMatches(task, fresh),
                        unresolvedActionIds: this.deps.store.unresolvedActionIdsForTask(taskId),
                        nowMs: this.deps.clock.nowMs(),
                        evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS
                    });
                    const completion: TaskCompletion = {
                        evidenceLevel: finalEval.allMet ? 'verified_observation' : 'none',
                        criterionResults: finalEval.results,
                        worldSaved: 'unknown'
                    };
                    if (finalEval.allMet) {
                        // Whole-task criteria do not prove each natural-language plan step.
                        output = { state: 'completed', phase: 'idle', summary: '完成候选已通过确定性条件核对。', completion, blocker: null };
                    } else if (finalEval.manualOnly) {
                        output = {
                            state: 'needs_review',
                            phase: 'idle',
                            summary: '执行模型报告完成，但目标只能人工审核：' + (decision.briefReason || '无机器可验证条件。'),
                            completion,
                            blocker: null
                        };
                    } else {
                        output = {
                            state: 'waiting_main',
                            phase: 'idle',
                            summary: '执行模型报告完成，但确定性条件未全部通过：' + finalEval.notes.join(' '),
                            completion,
                            blocker: null
                        };
                    }
                    break;
                }

                // —— act ——
                if (decision.toolName === null || decision.argumentsJson === null) {
                    throw new BridgeError('DECISION_OUTPUT_INVALID', 'act 缺少工具或参数。');
                }
                if (!tools.toolNames.includes(decision.toolName)) {
                    throw new BridgeError('POLICY_DENIED', '工具不在当前有效政策允许列表：' + decision.toolName);
                }
                const spec = getTool(decision.toolName);
                if (!spec) throw new BridgeError('POLICY_DENIED', '未知工具：' + decision.toolName);
                const validated = validateToolArguments(decision.toolName, parsedDecision.args ?? {});
                if (!validated.ok) throw new BridgeError('DECISION_OUTPUT_INVALID', '动作参数校验失败。');
                let args = validated.args as Record<string, unknown>;
                const injected = rejectInjectedIdentityFields(args);
                if (!injected.ok) throw new BridgeError('POLICY_DENIED', injected.reason);
                if (isWriteTool(decision.toolName)) {
                    const fresh = await this.deps.game.freshSnapshot();
                    this.assertPermission(task, run);
                    this.assertScope(task, fresh);
                    const renewedArgs = refreshActionArgs(snapshot, fresh, decision.toolName, args);
                    if (!renewedArgs) {
                        this.emit(taskId, 'decision_observation_changed', { observationId: lastObservationId });
                        continue;
                    }
                    snapshot = fresh;
                    lastSnapshot = fresh;
                    lastObservationId = this.recordObservation(task, run.runId, fresh);
                    args = renewedArgs;
                    const stop = this.stopCondition(task, fresh);
                    if (stop) throw new BridgeError(stop.code, stop.message);
                    policy = this.currentPolicy(task);
                    const currentMod = this.deps.game.status().mod;
                    tools = computeEffectiveTools(policy, [...currentMod.capabilities, ...currentMod.writeCommands]);
                    if (!tools.toolNames.includes(decision.toolName)) throw new BridgeError('POLICY_DENIED', '动作等待期间工具许可已被收紧。');
                }
                const guardContext: GuardContext = {
                    selectedToolForSlot: (slot) => this.toolKindForSlot(snapshot, slot),
                    currentSelectedSlot: snapshot.player?.selectedSlot ?? null,
                    itemIdForSlot: (slot) => snapshot.inventory.find(item => item.slot === slot)?.itemId ?? null,
                    observedWaterTargets: this.waterTargets(snapshot, task.definition.constraints.locations ?? [])
                };
                const guard = checkToolGuard(decision.toolName, args, policy.toolRestrictions[decision.toolName], guardContext);
                if (!guard.ok) throw new BridgeError('POLICY_DENIED', guard.reason);
                if (!this.locationAllowed(task, snapshot)) {
                    throw new BridgeError('POLICY_DENIED', '当前地图不在任务允许地点内。');
                }
                if (policy.allowedLocations.length > 0 && !policy.allowedLocations.includes(snapshot.location)) {
                    throw new BridgeError('POLICY_DENIED', '当前地图不在有效政策允许地点内。');
                }

                if (isWriteTool(decision.toolName)) {
                    if (controlSessionId === null) throw new BridgeError('CONTROL_EXPIRED', '控制会话不可用。');
                    if (!budget.canSpend('writeAction', 1, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', '写动作预算耗尽。');
                    if (!budget.reserveWriteAction().allowed) throw new BridgeError('BUDGET_EXHAUSTED', '写动作预算耗尽。');
                    this.persistBudget(taskId, budget);
                    attemptNo += 1;
                    const actionId = newActionId(run.runId.replace(/[^A-Za-z0-9]/g, '').slice(-18), attemptNo);
                    this.deps.store.insertActionPrepared({
                        runId: run.runId,
                        attemptNo,
                        taskId,
                        actionId,
                        toolName: decision.toolName,
                        argsHash: canonicalHash({ tool: decision.toolName, args }),
                        observationId: lastObservationId,
                        stepId: decision.stepId,
                        at: this.nowIso()
                    });
                    this.patch(taskId, { phase: 'acting', lastEvidenceSummary: decision.briefReason });
                    if (decision.stepId !== null) this.activateStep(taskId, decision.stepId);
                    this.assertPermission(task, run);

                    const result = await this.deps.game.dispatchWrite({
                        internalClientId,
                        internalClientName: `自动任务 ${taskId}`,
                        controlSessionId,
                        toolName: decision.toolName,
                        args: { ...args, actionId, controlSessionId },
                        actionId,
                        timeoutMs: spec.timeoutMs ?? 15_000,
                        signal: run.controller.signal
                    });
                    if (result.kind === 'receipt') {
                        this.deps.store.markActionReceipted(run.runId, attemptNo, result.receipt, this.nowIso());
                        this.assertFence(taskId, run);
                        this.emit(taskId, 'decision_action_receipted', { actionId, status: result.receipt.status, command: result.receipt.command });
                        if (result.receipt.effectKnown === false || result.receipt.status === 'unknown') {
                            output = {
                                state: 'needs_review',
                                phase: 'idle',
                                summary: `动作 ${actionId} 结果未知：已停止后续派发，请按原收据核对。`,
                                completion: null,
                                blocker: null
                            };
                            break;
                        }
                        if (result.receipt.status === 'cancelled') {
                            // 取消但效果可能已发生：保留未决事实，不冒充成功。
                            output = { state: 'needs_review', phase: 'idle', summary: `动作 ${actionId} 被取消，效果需核对。`, completion: null, blocker: null };
                            break;
                        }
                        if (result.receipt.status === 'failed') {
                            const fault = result.receipt.error?.code ?? 'INTERNAL_ERROR';
                            const fingerprint = failureFingerprint(task.scope.scopeKey, decision.toolName, args, fault);
                            const watered = this.countWatered(tiles);
                            const progressed = watered > lastWatered;
                            lastWatered = watered;
                            if (stall.recordFailure(fingerprint, progressed)) {
                                throw new BridgeError('TASK_STALLED', `同一目标连续失败且无进展（${fault}）。`);
                            }
                            this.patch(taskId, { phase: 'observing', lastEvidenceSummary: result.receipt.summary });
                            continue;
                        }
                        this.patch(taskId, { phase: 'verifying', lastEvidenceSummary: result.receipt.summary });
                        continue;
                    }

                    this.deps.store.markActionState(run.runId, attemptNo, result.effectKnown ? 'stale' : 'unknown', this.nowIso());
                    this.assertFence(taskId, run);
                    if (!result.effectKnown) {
                        this.emit(taskId, 'decision_action_unknown', { actionId, code: result.code });
                        output = { state: 'needs_review', phase: 'idle', summary: `动作 ${actionId} 结果未知：${result.code}`, completion: null, blocker: null };
                        break;
                    }
                    throw new BridgeError(result.code, result.message);
                }

                // 只读工具：不注入 actionId/controlSessionId，不建动作意图。
                const read = await this.deps.game.runReadOnly(internalClientId, decision.toolName, args);
                this.assertFence(taskId, run);
                if (!read.ok) {
                    const fingerprint = failureFingerprint(task.scope.scopeKey, decision.toolName, args, 'READ_FAILED');
                    if (stall.recordFailure(fingerprint, false)) throw new BridgeError('TASK_STALLED', '只读查询连续失败且无进展。');
                    throw new BridgeError('POLICY_DENIED', read.text);
                }
                const structured = read.structured && Buffer.byteLength(JSON.stringify(read.structured), 'utf8') <= 4096 ? read.structured : null;
                recentRead = { toolName: decision.toolName, observationId: lastObservationId, text: read.text.slice(0, 2000), structured };
                this.deps.store.appendEvent(taskId, 'decision_read_observed', { runId: run.runId, payload: recentRead });
                this.patch(taskId, { phase: 'observing', lastEvidenceSummary: decision.briefReason });
            }

            if (!output) output = this.abortedOutput(run);
        } catch (error) {
            output = this.errorOutput(taskId, run, error);
        } finally {
            try {
                if (budget) budget.pauseClock(this.deps.clock.nowMs());
                const latest = this.loadTask(taskId);
                const terminal = latest !== null && (latest.state === 'completed' || latest.state === 'failed' || latest.state === 'cancelled');
                const resolution = output ?? this.abortedOutput(run);
                // 外部停止（TaskService/halt）可能已经把任务落成 paused/needs_review；
                // runner 收尾不得把这些更保守的状态改回 paused 或覆盖 blocker。
                const externallyStopped = latest !== null
                    && (latest.state === 'paused' || latest.state === 'needs_review')
                    && (run.flags.cancel || run.flags.pause);
                if (latest && !terminal && !externallyStopped) {
                    // TaskService 已经宣布的终态优先：runner 绝不把 cancelled 改回 running。
                    const next: TaskRecord = {
                        ...latest,
                        state: resolution.state,
                        phase: resolution.phase,
                        pauseReason: resolution.state === 'paused' ? (run.flags.reason ?? latest.pauseReason) : latest.pauseReason,
                        blocker: resolution.blocker ?? (resolution.state === 'waiting_main' || resolution.state === 'needs_review' ? latest.blocker : null),
                        completion: resolution.completion ?? latest.completion,
                        budgetUsed: budget?.snapshot() ?? latest.budgetUsed,
                        currentRunId: resolution.state === 'paused' || resolution.state === 'waiting_main' || resolution.state === 'needs_review'
                            ? null
                            : latest.currentRunId,
                        stateVersion: latest.stateVersion + 1,
                        updatedAt: this.nowIso()
                    };
                    this.deps.store.updateTask(next, latest.stateVersion);
                    this.deps.store.setFinalSummary(taskId, resolution.summary);
                    this.deps.store.appendEvent(taskId, 'decision_run_finished', { runId: run.runId, payload: { state: resolution.state, summary: resolution.summary.slice(0, 600) } });
                } else if (latest) {
                    this.deps.store.appendEvent(taskId, 'decision_run_finished', { runId: run.runId, payload: { state: latest.state } });
                }
            } catch (error) {
                this.deps.logger?.('error', '保存任务结束状态失败', { taskId, error: String(error) });
            } finally {
                if (controlSessionId !== null) {
                    try {
                        await this.deps.game.endControlSession(internalClientId, controlSessionId, 'run_finished');
                    } catch (error) {
                        this.deps.logger?.('warn', '释放己方控制会话失败', { taskId, error: String(error) });
                    }
                }
                try {
                    this.deps.store.endRun(run.runId, 'ended', output?.state ?? 'unknown', this.nowIso());
                } catch (error) {
                    this.deps.logger?.('warn', '结束 run 记录失败', { taskId, error: String(error) });
                }
                // paused/waiting_main/needs_review 仍占自动任务槽（resume 复用），终态才释放。
                const finalTask = this.loadTask(taskId);
                if (finalTask && (finalTask.state === 'completed' || finalTask.state === 'failed' || finalTask.state === 'cancelled')) {
                    try {
                        this.deps.store.releaseSlot(taskId, run.generation);
                    } catch { /* 槽位可能已被 TaskService 释放 */ }
                }
                this.runs.delete(taskId);
                const final = this.loadTask(taskId);
                this.emit(taskId, final?.state === 'completed' ? 'decision_completed' : 'decision_blocked', {
                    state: final?.state ?? 'unknown',
                    summary: output?.summary ?? ''
                });
                try {
                    this.deps.onFinished?.(taskId);
                } catch (error) {
                    this.deps.logger?.('warn', '收尾钩子失败', { taskId, error: String(error) });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 模型调用：重试、纠错、超时与预算
    // -----------------------------------------------------------------------
    private async askModel(
        task: TaskRecord,
        run: RunState,
        budget: BudgetMeter,
        provider: DecisionProvider,
        contextJson: string,
        correctionIssues: string[] | null,
        planning: boolean
    ): Promise<ParsedDecision> {
        let correctionUsed = 0;
        let transportRetries = 0;
        const currentContext = contextJson;
        let issues = correctionIssues;
        for (;;) {
            this.assertPermission(task, run);
            // 没有有效短计划时先用规划提示词，避免模型直接逐格微操。
            const systemPrompt = issues === null
                ? (planning ? PLANNING_SYSTEM_PROMPT : EXECUTOR_SYSTEM_PROMPT)
                : correctionSystemPrompt(issues);
            const reserve = conservativeTokenReserve(currentContext, MAX_OUTPUT_TOKENS);
            if (!budget.canSpend('modelCall', 1, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', '模型调用预算耗尽。');
            if (!budget.canSpend('httpAttempt', 1, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', '模型 HTTP 尝试预算耗尽。');
            if (!budget.canSpend('tokens', reserve, this.deps.clock.nowMs()).allowed) throw new BridgeError('BUDGET_EXHAUSTED', 'token 预算耗尽。');
            const reserved = budget.reserveModelCall(reserve);
            budget.spendHttpAttempt();
            const callId = newDecisionId('call');
            this.deps.store.insertModelCall({
                callId,
                taskId: task.taskId,
                runId: run.runId,
                generation: run.generation,
                providerId: task.definition.providerId,
                providerConfigRevision: run.providerConfigRevision,
                reservedTokens: reserved,
                usageJson: null,
                usageUnknown: true,
                status: 'started',
                errorCode: null,
                latencyMs: null,
                startedAt: this.nowIso(),
                endedAt: null
            });

            const timeoutMs = Math.max(5000, Math.min(90_000, this.deps.modelRequestTimeoutMs?.(task.definition.providerId) ?? 30_000));
            // 自己组合取消信号并在 finally 里移除监听：避免每次模型调用都在 controller 上留下监听器。
            const combined = new AbortController();
            const onRunAbort = (): void => combined.abort(run.controller.signal.reason);
            if (run.controller.signal.aborted) combined.abort(run.controller.signal.reason);
            else run.controller.signal.addEventListener('abort', onRunAbort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                combined.abort(new BridgeError('PROVIDER_TIMEOUT'));
            }, timeoutMs);
            timer.unref?.();
            const signal = combined.signal;
            const startedAt = this.deps.clock.nowMs();
            let settled = false;
            try {
                const response = await provider.decide({
                    systemPrompt,
                    contextJson: currentContext,
                    outputSchema: DECISION_OUTPUT_SCHEMA,
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                    signal
                });
                const usage = response.usage;
                const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
                budget.settleModelCall(reserved, {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: total > 0 ? total : null,
                    usageKnown: usage.source === 'provider' && total > 0,
                    reservedTokens: reserved
                });
                settled = true;
                this.persistBudget(task.taskId, budget);
                this.deps.store.finishModelCall(callId, {
                    status: 'completed',
                    usageJson: JSON.stringify(usage),
                    usageUnknown: usage.source !== 'provider',
                    errorCode: null,
                    latencyMs: response.latencyMs,
                    endedAt: this.nowIso()
                });
                this.assertPermission(task, run);
                const parsed = parseDecisionText(response.decisionText);
                if (parsed.ok) return { envelope: parsed.envelope, args: parsed.args ?? null };
                // 格式/参数纠错：每个决策最多一次，仍占原总预算。
                if (correctionUsed >= MAX_CORRECTIONS_PER_DECISION) {
                    throw new BridgeError('DECISION_OUTPUT_INVALID', parsed.reason);
                }
                correctionUsed += 1;
                issues = [parsed.reason.slice(0, 300)];
                this.emit(task.taskId, 'decision_output_corrected', { reason: parsed.reason.slice(0, 200) });
                continue;
            } catch (error) {
                // 失败/超时的请求也可能已计费：按预留量保守记账，绝不当作 0。
                if (!settled) {
                    budget.settleModelCall(reserved, {
                        inputTokens: null,
                        outputTokens: null,
                        totalTokens: null,
                        usageKnown: false,
                        reservedTokens: reserved
                    });
                    this.persistBudget(task.taskId, budget);
                }
                const providerError = error instanceof ProviderCallError ? error : null;
                const code = providerError?.code ?? 'PROVIDER_TRANSPORT';
                if (!settled) this.deps.store.finishModelCall(callId, {
                    status: timedOut || code === 'PROVIDER_TIMEOUT' ? 'timeout' : run.controller.signal.aborted ? 'aborted' : 'error',
                    usageJson: null,
                    usageUnknown: true,
                    errorCode: code.slice(0, 80),
                    latencyMs: this.deps.clock.nowMs() - startedAt,
                    endedAt: this.nowIso()
                });
                if (run.controller.signal.aborted) throw this.abortError(run);
                if (timedOut) {
                    // 超时是传输层可重试故障：仍受同一重试预算与任务 deadline 约束。
                    if (transportRetries < MAX_TRANSPORT_RETRIES) {
                        transportRetries += 1;
                        await sleepAbortable(400 * 2 ** (transportRetries - 1), run.controller.signal);
                        continue;
                    }
                    throw new BridgeError('PROVIDER_TIMEOUT', '执行模型请求超时（已用尽本次重试预算）。');
                }
                if (error instanceof BridgeError) throw error;
                const retryable = providerError?.retryable === true;
                if (!retryable || transportRetries >= MAX_TRANSPORT_RETRIES) {
                    throw this.providerBridgeError(code, error);
                }
                transportRetries += 1;
                const backoffMs = Math.min(8000, 400 * 2 ** (transportRetries - 1)) + Math.floor(Math.random() * 150);
                const retryAfter = providerError !== null && 'retryAfterMs' in providerError
                    ? (providerError as unknown as { retryAfterMs?: number | null }).retryAfterMs
                    : null;
                const wait = typeof retryAfter === 'number' ? Math.min(retryAfter, 8000) : backoffMs;
                await sleepAbortable(wait, run.controller.signal);
                continue;
            } finally {
                clearTimeout(timer);
                run.controller.signal.removeEventListener('abort', onRunAbort);
            }
        }
    }

    // -----------------------------------------------------------------------
    // 观察、作用域与停止条件
    // -----------------------------------------------------------------------
    private recordObservation(task: TaskRecord, runId: string, snapshot: SnapshotSummary): string {
        const observationId = newDecisionId('obs');
        this.deps.store.insertObservation({
            observationId,
            taskId: task.taskId,
            runId,
            scopeKey: task.scope.scopeKey,
            instanceId: snapshot.instanceId,
            worldGeneration: snapshot.worldGeneration,
            sceneGeneration: snapshot.sceneGeneration,
            dateJson: snapshot.date ? JSON.stringify(snapshot.date) : null,
            coverageJson: snapshot.coverage ? JSON.stringify(snapshot.coverage) : null,
            payloadJson: JSON.stringify(snapshot),
            at: this.nowIso()
        });
        return observationId;
    }

    private absorbTiles(tiles: Map<string, TileStamp>, snapshot: SnapshotSummary): void {
        // 截断/未覆盖的快照不能当作“整片地已看过”：只吸收明确列出的作物格。
        if (snapshot.truncated || snapshot.coverage?.complete === false) {
            // 仍然记录被列出的格，但完成判定会因缺少覆盖而 unverifiable。
            this.deps.logger?.('debug', '观察被截断，完成判定将标记 unverifiable', { location: snapshot.location });
        }
        const date = snapshot.date;
        if (!date) return;
        for (const entity of snapshot.entities) {
            if (!hasLiveCrop(entity)) {
                // A currently observed empty/changed tile invalidates an older crop stamp.
                if (['soil', 'tile', 'water', 'terrain', 'object', 'action'].includes(entity.kind)) {
                    tiles.delete(`${snapshot.location},${String(entity.tile.x)},${String(entity.tile.y)}`);
                }
                continue;
            }
            const record = entity as unknown as Record<string, unknown>;
            tiles.set(`${snapshot.location},${String(entity.tile.x)},${String(entity.tile.y)}`, {
                hasCrop: true,
                watered: record['watered'] === true,
                season: date.season,
                day: date.day,
                year: date.year,
                observedAtMs: this.deps.clock.nowMs()
            });
        }
    }

    private countWatered(tiles: Map<string, TileStamp>): number {
        let n = 0;
        for (const stamp of tiles.values()) if (stamp.watered) n += 1;
        return n;
    }

    private scopeMatches(task: TaskRecord, snapshot: SnapshotSummary): boolean {
        if (!snapshotMatchesScope(snapshot.worldIdentity?.worldId ?? null, snapshot.instanceId, snapshot.worldGeneration, task.scope)) return false;
        if (task.scope.mode === 'persistent' && snapshot.worldIdentity) {
            return snapshot.worldIdentity.actorFarmerId === task.scope.actorFarmerId;
        }
        return true;
    }

    private assertScope(task: TaskRecord, snapshot: SnapshotSummary): void {
        if (!this.scopeMatches(task, snapshot)) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '当前世界、角色或实例与任务绑定不一致，已停止且不会自动迁移。');
        }
    }

    private locationAllowed(task: TaskRecord, snapshot: SnapshotSummary): boolean {
        const allowed = task.definition.constraints.locations ?? [];
        if (allowed.length === 0) return true;
        return allowed.includes(snapshot.location);
    }

    /**
     * 分步模式要求游戏确认暂停后才派发动作；给 Mod 最多 timeoutMs 完成菜单切换，
     * 期间任何取消都立即中止。requested=false 表示当前模式不需要暂停。
     */
    private async waitForPauseConfirmed(run: RunState, timeoutMs: number): Promise<void> {
        const deadline = this.deps.clock.nowMs() + timeoutMs;
        for (;;) {
            if (run.controller.signal.aborted) throw this.abortError(run);
            const pause = this.deps.game.status().control.pause;
            if (!pause.requested) return;
            if (pause.state === 'paused') return;
            if (this.deps.clock.nowMs() >= deadline) {
                throw new BridgeError('PAUSE_NOT_CONFIRMED', '已请求暂停但游戏未在限期内确认 paused；请等待游戏完成暂停后再试。');
            }
            await sleepAbortable(100, run.controller.signal);
        }
    }

    private stopCondition(task: TaskRecord, snapshot: SnapshotSummary): { code: ErrorCode; message: string } | null {
        const c = task.definition.constraints;
        const energy = snapshot.player?.energy ?? null;
        const health = snapshot.player?.health ?? null;
        if (typeof c.stopEnergyAtOrBelow === 'number' && energy !== null && energy <= c.stopEnergyAtOrBelow) {
            return {
                code: 'INSUFFICIENT_RESOURCE',
                message: `体力 ${String(energy)} 已不高于停止阈值 ${String(c.stopEnergyAtOrBelow)}，任务停止并保留已完成部分。`
            };
        }
        if (typeof c.stopHealthAtOrBelow === 'number' && health !== null && health <= c.stopHealthAtOrBelow) {
            return {
                code: 'INSUFFICIENT_RESOURCE',
                message: `生命 ${String(health)} 已不高于停止阈值 ${String(c.stopHealthAtOrBelow)}，任务停止。`
            };
        }
        if (typeof c.latestStartGameTime === 'number' && snapshot.time !== null && snapshot.time > c.latestStartGameTime) {
            return {
                code: 'BUDGET_EXHAUSTED',
                message: `游戏时间 ${String(snapshot.time)} 已超过任务允许的最新开始时间 ${String(c.latestStartGameTime)}。`
            };
        }
        return null;
    }

    private currentPolicy(task: TaskRecord): DecisionPolicyView {
        const frozen: DecisionPolicyView = {
            policyId: task.policySnapshot.policyId,
            label: task.policySnapshot.policyId,
            revision: task.policySnapshot.revision,
            allowedTools: task.policySnapshot.allowedTools,
            allowedLocations: task.policySnapshot.allowedLocations,
            toolRestrictions: task.policySnapshot.toolRestrictions as unknown as DecisionPolicyView['toolRestrictions'],
            budgetCaps: {}
        };
        const current = this.deps.authz.currentPolicyTightening(task.policySnapshot.policyId);
        if (!current) throw new BridgeError('POLICY_DENIED', '当前操作政策已撤销。');
        return intersectPolicies(frozen, current);
    }

    private toolKindForSlot(snapshot: SnapshotSummary, slot: string): 'watering_can' | 'other' | 'unknown' {
        return toolForSlot(snapshot, slot);
    }

    private waterTargets(snapshot: SnapshotSummary, allowedLocations: string[]): Set<string> {
        if (allowedLocations.length > 0 && !allowedLocations.includes(snapshot.location)) return new Set();
        return wateringTargets(snapshot);
    }

    private recentReceipts(task: TaskRecord, runId: string): ActionReceipt[] {
        const links = this.deps.store.listActionLinksForTask(task.taskId, 8);
        const receipts: ActionReceipt[] = [];
        for (const link of links) {
            if (link.receipt) receipts.push(link.receipt);
            else if (link.runId === runId && link.dispatchState === 'prepared') {
                // 在途动作没有收据：保持未决提示，不编造状态。
                continue;
            }
        }
        return receipts;
    }

    private activateStep(taskId: string, stepId: string): void {
        const steps = this.deps.store.loadSteps(taskId);
        const step = steps.find((s) => s.stepId === stepId);
        if (!step) return;
        if (canTransitionStep(step.status, 'active')) this.deps.store.updateStepStatus(taskId, stepId, 'active', step.evidenceIds);
    }

    // -----------------------------------------------------------------------
    // fence、状态与收尾
    // -----------------------------------------------------------------------
    private assertFence(taskId: string, run: RunState): void {
        const task = this.loadTask(taskId);
        if (!task) throw new BridgeError('NOT_FOUND', '任务已不存在。');
        if (this.fenceBroken(task, run)) throw this.abortError(run);
    }

    private assertPermission(task: TaskRecord, run: RunState): void {
        this.assertFence(task.taskId, run);
        if (!this.deps.enabled()) throw new BridgeError('DECISION_DISABLED');
        if (this.deps.store.isUserStopLatched().latched) throw new BridgeError('USER_STOP_LATCHED');
        if (!this.deps.authz.isClientAuthorized(task.ownerClientId)) throw new BridgeError('DECISION_NOT_AUTHORIZED');
        if (!this.deps.authz.isPolicyAllowed(task.ownerClientId, task.policySnapshot.policyId)) throw new BridgeError('POLICY_DENIED');
        if (!this.deps.authz.isProviderAllowed(task.ownerClientId, task.definition.providerId)) throw new BridgeError('PROVIDER_NOT_CONFIGURED');
    }

    private fenceBroken(task: TaskRecord, run: RunState): boolean {
        if (run.controller.signal.aborted) return true;
        // bootId 是 fence 的第一段：即使任务行被外部恢复，旧进程的 run 也不能继续写。
        if (run.bootId !== this.deps.bootId) return true;
        if (task.currentRunId !== run.runId) return true;
        if (task.state === 'cancelled' || task.state === 'completed' || task.state === 'failed') return true;
        return false;
    }

    private abortError(run: RunState): BridgeError {
        if (run.flags.cancel) return new BridgeError('CANCELLED', run.flags.reason ?? '任务已取消');
        if (run.flags.pause) return new BridgeError('CANCELLED', run.flags.reason ?? '任务已暂停');
        return new BridgeError('CANCELLED', '执行已中止');
    }

    private abortedOutput(run: RunState): LoopOutput {
        if (run.flags.cancel && !run.flags.pause) {
            return { state: 'paused', phase: 'idle', summary: run.flags.reason ?? '执行循环已停止', completion: null, blocker: null };
        }
        return { state: 'paused', phase: 'idle', summary: run.flags.reason ?? '任务已暂停', completion: null, blocker: null };
    }

    private errorOutput(taskId: string, run: RunState, error: unknown): LoopOutput {
        const bridge = BridgeError.from(error);
        if (run.flags.pause) {
            return { state: 'paused', phase: 'idle', summary: run.flags.reason ?? '任务已暂停', completion: null, blocker: null };
        }
        if (run.flags.cancel) {
            return { state: 'paused', phase: 'idle', summary: run.flags.reason ?? '执行循环已停止', completion: null, blocker: null };
        }
        // fault.code 是 string（兼容旧 Mod 错误码）；进入任务 blocker 前必须收敛到契约枚举。
        const code: ErrorCode = isErrorCode(bridge.fault.code) ? bridge.fault.code : 'INTERNAL_ERROR';
        // 世界/存档/日期变化与未知回执都需要人工/主模型复核，不能当作普通等待。
        const needsReview = code === 'RESULT_UNKNOWN' || code === 'CONTROL_EXPIRED'
            || code === 'PAUSE_NOT_CONFIRMED' || code === 'TASK_SCOPE_CHANGED'
            || code === 'WORLD_IDENTITY_UNAVAILABLE';
        const failed = code === 'INTERNAL_ERROR' || code === 'TASK_STORAGE_UNAVAILABLE';
        const state: TaskState = failed ? 'failed' : needsReview ? 'needs_review' : 'waiting_main';
        return {
            state,
            phase: 'idle',
            summary: `${code}: ${bridge.message}`,
            completion: null,
            blocker: { code, summary: bridge.message.slice(0, 600), evidenceIds: [], raisedAt: this.nowIso() }
        };
    }

    private providerBridgeError(code: string, error: unknown): BridgeError {
        const message = error instanceof Error ? error.message : String(error);
        const mapped: ErrorCode = code === 'PROVIDER_UNAUTHORIZED'
            ? 'PROVIDER_AUTH_FAILED'
            : code === 'PROVIDER_RATE_LIMITED'
                ? 'PROVIDER_RATE_LIMITED'
                : code === 'PROVIDER_TIMEOUT'
                    ? 'PROVIDER_TIMEOUT'
                    : code === 'PROVIDER_OUTPUT_TRUNCATED'
                        ? 'DECISION_OUTPUT_INVALID'
                        : 'PROVIDER_UNSUPPORTED';
        return new BridgeError(mapped, message.slice(0, 240));
    }

    private patch(taskId: string, patch: Partial<Pick<TaskRecord, 'state' | 'phase' | 'pauseReason' | 'lastEvidenceSummary'>>): void {
        // 主模型可能在同一时刻 update 任务定义并抬高 stateVersion：重读一次再写，
        // 只有连续冲突才向上抛（由 errorOutput 收尾），避免误把任务判失败。
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const task = this.loadTask(taskId);
            if (!task) return;
            if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return;
            const next: TaskRecord = {
                ...task,
                ...patch,
                stateVersion: task.stateVersion + 1,
                updatedAt: this.nowIso()
            };
            try {
                this.deps.store.updateTask(next, task.stateVersion);
                return;
            } catch (error) {
                if (!(error instanceof BridgeError) || error.fault.code !== 'TASK_REVISION_CONFLICT' || attempt === 1) throw error;
            }
        }
    }

    /** 预算用量落库失败不应中断任务本身；下一轮或收尾还会再写。 */
    private persistBudget(taskId: string, budget: BudgetMeter): void {
        try {
            this.deps.store.updateBudgetUsage(taskId, budget.snapshot());
        } catch (error) {
            this.deps.logger?.('debug', '预算用量落库失败', { taskId, error: String(error) });
        }
    }

    private nextGeneration(taskId: string): number {
        const runs = this.deps.store.listRuns(taskId, 100);
        let max = 0;
        for (const run of runs) max = Math.max(max, run.generation);
        return max + 1;
    }

    private emit(taskId: string, kind: string, payload: Record<string, unknown>): void {
        try {
            this.deps.events.emit({ kind, taskId, payload });
        } catch (error) {
            this.deps.logger?.('warn', '决策事件发送失败', { kind, taskId, error: String(error) });
        }
    }

    private loadTask(taskId: string): TaskRecord | null {
        try {
            return this.deps.store.loadTask(taskId);
        } catch (error) {
            this.deps.logger?.('error', '读取任务失败', { taskId, error: String(error) });
            return null;
        }
    }

    private nowIso(): string {
        return new Date(this.deps.clock.nowMs()).toISOString();
    }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new BridgeError('CANCELLED', '已取消'));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new BridgeError('CANCELLED', '已取消'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
