/**
 * DXR-01/DXR-03/DXR-08/DXR-09/DXP-08 类断言：真实多轮执行循环、fence 与未知动作。
 * FakeProvider + FakeGamePort + 临时决策库；不访问网络、不启动游戏。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ContextTokenStore, DecisionRunner, DecisionStore, TaskService, systemClock } from '@sab/decision-core';
import type { Principal } from '@sab/decision-core';
import type { TaskRecord } from '@sab/contracts';
import type { DecisionProvider, ProviderCallResult } from '@sab/decision-core';
import { envelope, FakeAuthz, FakeGamePort, FakeProvider, FakeProviders, RecordingEvents, receipt, snapshot, status, TEST_IDENTITY } from './decision-fixtures.js';

const principal: Principal = { clientId: 'tester', clientName: '测试主模型', transport: 'http' };
const areas: string[] = [];

afterEach(() => {
    for (const area of areas.splice(0)) rmSync(area, { recursive: true, force: true });
});

interface Harness {
    store: DecisionStore;
    service: TaskService;
    game: FakeGamePort;
    tokens: ContextTokenStore;
    events: RecordingEvents;
    authz: FakeAuthz;
    token: string;
    stop(): void;
}

function harness(provider: DecisionProvider, game: FakeGamePort): Harness {
    const area = mkdtempSync(path.join(os.tmpdir(), 'sab-decision-runner-'));
    areas.push(area);
    const store = new DecisionStore(path.join(area, 'decision.sqlite'));
    const tokens = new ContextTokenStore();
    const events = new RecordingEvents();
    const authz = new FakeAuthz();
    const providers = new FakeProviders(provider);
    const service = new TaskService({
        store,
        events,
        authz,
        providers,
        tokens,
        game,
        clock: systemClock,
        enabled: () => true,
        defaults: () => ({ defaultProviderId: 'fake', defaultPolicyId: 'farm-care', activeProfileId: 'default' })
    });
    const runner = new DecisionRunner({
        store,
        game,
        authz,
        providers,
        events,
        clock: systemClock,
        enabled: () => true,
        bootId: 'boot-test',
        modelRequestTimeoutMs: () => 2_000
    });
    service.attachRunner(runner);
    const issued = tokens.issue({
        clientId: principal.clientId,
        profileId: 'default',
        scopeKey: `p:default:${TEST_IDENTITY.worldId}:${TEST_IDENTITY.actorFarmerId}`,
        worldId: TEST_IDENTITY.worldId,
        actorFarmerId: TEST_IDENTITY.actorFarmerId,
        instanceId: 'inst-1',
        worldGeneration: 3,
        nowMs: Date.now()
    });
    return { store, service, game, tokens, events, authz, token: issued.token, stop: () => store.close() };
}

const submitInput = (token: string) => ({
    requestId: 'req-run-1',
    contextToken: token,
    title: '浇好农舍旁的两格作物',
    goal: '给已观察的两格作物浇水，体力不足就停下。',
    providerId: 'fake',
    policyId: 'farm-care',
    scopeMode: 'persistent' as const,
    constraints: { locations: ['Farm'], stopEnergyAtOrBelow: 20, allowDayChange: false },
    successCriteria: [{ kind: 'crop_tiles_watered' as const, location: 'Farm', tiles: [{ x: 64, y: 18 }, { x: 65, y: 18 }] }]
});

/** 从上下文里取本轮 observationId，模拟真实模型引用观察。 */
function observationIdOf(contextJson: string): string {
    const parsed = JSON.parse(contextJson) as { state?: { observationId?: string } };
    const id = parsed.state?.observationId;
    assert.ok(id, '上下文必须下发 observationId');
    return id;
}

const act = (toolName: string, args: Record<string, unknown>) => (contextJson: string) => envelope({
    kind: 'act',
    observationId: observationIdOf(contextJson),
    stepId: 'step_water',
    toolName,
    argumentsJson: JSON.stringify(args),
    briefReason: `执行 ${toolName}`
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待条件超时');
}

describe('执行循环', () => {
    it('取得控制过程中取消：迟到取得的己方会话也必须释放', async () => {
        const game = new FakeGamePort(status());
        let acquiring = false;
        let release = (): void => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const original = game.startControlSession.bind(game);
        game.startControlSession = async (clientId, name) => {
            acquiring = true;
            await gate;
            return original(clientId, name);
        };
        const provider = new FakeProvider([]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => acquiring);
            h.service.cancel(principal, accepted.taskId, 'cancel-acquire');
            release();
            await waitFor(() => game.endedSessions.length === 1);
            assert.deepEqual(game.endedSessions, ['session-1']);
            assert.equal(game.writes.length, 0);
            assert.equal(provider.calls.length, 0);
        } finally { release(); h.stop(); }
    });

    it('只读 inspect 的实际结果进入下一轮模型上下文，不被丢弃', async () => {
        const initial = status();
        initial.mod.capabilities = ['snapshot', 'inspect'];
        const game = new FakeGamePort(initial);
        const provider = new FakeProvider([
            act('stardew_inspect', { target: '@s1:e1' }),
            ctx => {
                const context = JSON.parse(ctx) as { recentRead?: { toolName: string; structured?: { kind?: string } } };
                assert.equal(context.recentRead?.toolName, 'stardew_inspect');
                assert.equal(context.recentRead?.structured?.kind, 'stardew_inspect');
                return envelope({ kind: 'ask_main', observationId: observationIdOf(ctx), question: '观察已完成，请主模型复核。' });
            }
        ]);
        const h = harness(provider, game);
        h.authz.policy = { ...h.authz.policy!, allowedTools: [...h.authz.policy!.allowedTools, 'stardew_inspect'] };
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'waiting_main');
            assert.equal(game.reads.length, 1);
            assert.equal(game.writes.length, 0);
            assert.equal(provider.calls.length, 2);
        } finally { h.stop(); }
    });

    it('新观察已无作物时清除旧浇水证据，不能拼出虚假完成', async () => {
        const first = snapshot({ entities: [
            { ref: '@s1:e1', kind: 'crop', name: '作物', tile: { x: 64, y: 18 }, watered: true },
            { ref: '@s1:e2', kind: 'crop', name: '作物', tile: { x: 65, y: 18 }, watered: false }
        ] });
        const changed = snapshot({ entities: [
            { ref: '@s2:e1', kind: 'soil', name: '空地', tile: { x: 64, y: 18 }, watered: true },
            { ref: '@s2:e2', kind: 'crop', name: '作物', tile: { x: 65, y: 18 }, watered: true }
        ] });
        const provider = new FakeProvider([
            ctx => envelope({ kind: 'plan', observationId: observationIdOf(ctx), plan: [{ stepId: 'check', title: '核对', doneWhen: '当前两格有作物且浇水' }] }),
            ctx => envelope({ kind: 'finish', observationId: observationIdOf(ctx) })
        ]);
        const game = new FakeGamePort(status());
        game.freshSnapshot = async () => provider.calls.length > 0 ? changed : first;
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'waiting_main');
            const task = h.store.loadTask(accepted.taskId)!;
            assert.notEqual(task.completion?.evidenceLevel, 'verified_observation');
            assert.ok(task.completion?.criterionResults.some(result => result.status === 'unverifiable'));
        } finally { h.stop(); }
    });

    it('非法预算与未知预算字段在派单时被拒绝，不创建任务', async () => {
        const h = harness(new FakeProvider([]), new FakeGamePort(status()));
        try {
            await assert.rejects(
                () => h.service.submit(principal, { ...submitInput(h.token), budget: { maxModelCalls: 0 } }),
                /正整数/
            );
            await assert.rejects(
                () => h.service.submit(principal, { ...submitInput(h.token), budget: { maxHttpAttempts: 5 } as never }),
                /未知预算字段/
            );
            await assert.rejects(
                () => h.service.submit(principal, { ...submitInput(h.token), budget: { maxActiveMs: 1.5 } as never }),
                /正整数/
            );
            assert.equal(h.store.listTasks(principal.clientId, { limit: 10 }).tasks.length, 0);
        } finally {
            h.stop();
        }
    });

    it('规划→选壶→两次浇水→机器验证完成，且动作串行经 GamePort', async () => {
        const game = new FakeGamePort(status());
        const unwatered = snapshot();
        const watered = snapshot({
            entities: [
                { ref: '@s1:e1', kind: 'crop', name: '防风草', tile: { x: 64, y: 18 }, watered: true, needsWater: false },
                { ref: '@s1:e2', kind: 'crop', name: '防风草', tile: { x: 65, y: 18 }, watered: true, needsWater: false }
            ]
        });
        game.freshSnapshot = async () => game.writes.length >= 3 ? watered : unwatered;
        const provider = new FakeProvider([
            (ctx) => envelope({
                kind: 'plan',
                observationId: observationIdOf(ctx),
                plan: [{ stepId: 'step_water', title: '给两格作物浇水', doneWhen: '两格作物 watered=true' }],
                briefReason: '先规划再逐步浇水'
            }),
            act('stardew_select', { slot: 0 }),
            act('stardew_use', { target: '@s1:e1' }),
            act('stardew_use', { target: '@s1:e2' })
        ]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => {
                const state = h.store.loadTask(accepted.taskId)?.state;
                return state === 'completed' || state === 'waiting_main' || state === 'needs_review';
            });
            const task = h.store.loadTask(accepted.taskId);
            assert.ok(task);
            assert.equal(task.state, 'completed');
            assert.equal(task.completion?.evidenceLevel, 'verified_observation');
            assert.deepEqual(h.service.toView(task).remainingWork, { pendingSteps: [], unverifiedSteps: [], blockers: [] }, '已完成目标不能把未单独核验的计划文本当作未完成工作');
            assert.equal(game.writes.length, 3);
            assert.deepEqual(game.writes.map((write) => write.toolName), ['stardew_select', 'stardew_use', 'stardew_use']);
            for (const write of game.writes) {
                assert.ok(write.actionId.startsWith('dx'), 'actionId 必须由服务端生成');
                assert.equal(write.internalClientId, 'sab-internal-decision:tester');
                assert.equal(write.args['controlSessionId'], 'session-1');
                assert.equal('epoch' in write.args, false, '模型不得注入 epoch');
                assert.equal('owner' in write.args, false);
            }
            assert.deepEqual(game.endedSessions, ['session-1'], 'run 结束必须释放自己的控制会话');
            assert.equal(task.budgetUsed.modelCalls, 4);
            assert.equal(h.store.currentSlot(), null, '终态释放执行槽');
            assert.ok(h.events.events.some((event) => event.kind === 'decision_completed'));
        } finally {
            h.stop();
        }
    });

    it('未知结果回执：保留未决 actionId，进入待复核，后续写动作 0 次', async () => {
        const game = new FakeGamePort(status());
        game.snapshots.splice(0, game.snapshots.length, snapshot(), snapshot(), snapshot(), snapshot());
        game.enqueueWriteResult({ kind: 'fault', code: 'RESULT_UNKNOWN', message: 'Mod 回执丢失', effectKnown: false });
        const provider = new FakeProvider([
            (ctx) => envelope({
                kind: 'plan',
                observationId: observationIdOf(ctx),
                plan: [{ stepId: 'step_water', title: '浇水', doneWhen: 'watered' }],
                briefReason: '规划'
            }),
            act('stardew_use', { target: '@s1:e1' })
        ]);
        const h = harness(provider, game);
        try {
            await h.service.submit(principal, submitInput(h.token));
            await waitFor(() => h.store.listTasks('tester', { limit: 1 }).tasks[0]?.state === 'needs_review');
            const task = h.store.listTasks('tester', { limit: 1 }).tasks[0] as TaskRecord;
            assert.equal(task.state, 'needs_review');
            assert.equal(task.completion, null);
            assert.equal(game.writes.length, 1, '未知回执后不得再用新 ID 重做');
            const unresolved = h.store.unresolvedActionIdsForTask(task.taskId);
            assert.equal(unresolved.length, 1);
            assert.equal(unresolved[0], game.writes[0]?.actionId);
            const writesBefore = game.writes.length;
            await new Promise((resolve) => setTimeout(resolve, 120));
            assert.equal(game.writes.length, writesBefore, '停下后不再派发任何写动作');
        } finally {
            h.stop();
        }
    });

    it('模型等待期间取消：立刻中止，不产生写动作，迟到回答不会被使用', async () => {
        const game = new FakeGamePort(status());
        let started = false;
        const provider: DecisionProvider = {
            id: 'fake',
            label: 'gated',
            protocol: 'openai-chat-compatible',
            decide(request): Promise<ProviderCallResult> {
                started = true;
                return new Promise((_resolve, reject) => {
                    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            }
        };
        const h = harness(provider, game);
        try {
            await h.service.submit(principal, submitInput(h.token));
            await waitFor(() => started);
            const task = h.store.listTasks('tester', { limit: 1 }).tasks[0] as TaskRecord;
            h.service.cancel(principal, task.taskId, 'req-cancel-1', '用户取消');
            await waitFor(() => h.store.loadTask(task.taskId)?.state === 'cancelled');
            assert.equal(game.writes.length, 0);
            assert.equal(h.store.loadTask(task.taskId)?.state, 'cancelled');
        } finally {
            h.stop();
        }
    });

    it('Web 管理员可管理他人任务，普通客户端仍被拒绝', async () => {
        const game = new FakeGamePort(status());
        game.controlBusy = true;
        const h = harness(new FakeProvider([]), game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'waiting_main');
            const other = { clientId: 'other-client', clientName: 'Other', transport: 'http' as const };
            assert.throws(() => h.service.pause(other, accepted.taskId, 'req-other-pause', '越权'), /不存在或不属于/);
            const admin = { clientId: 'web', clientName: 'Web 控制台', transport: 'web' as const, admin: true };
            const result = h.service.pause(admin, accepted.taskId, 'req-admin-pause', '管理员暂停');
            assert.equal(typeof result, 'object');
        } finally {
            h.stop();
        }
    });

    it('控制权被占用：不抢占、不调用模型，任务停下等主模型处理', async () => {
        const game = new FakeGamePort(status());
        game.controlBusy = true;
        const provider = new FakeProvider([]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'waiting_main');
            const task = h.store.loadTask(accepted.taskId);
            assert.equal(task?.state, 'waiting_main');
            assert.equal(task?.blocker?.code, 'CONTROL_BUSY');
            assert.equal(game.controlSessions, 0, '不得建立第二个控制会话');
            assert.equal(provider.calls.length, 0, '控制权未取得前不应调用模型');
        } finally {
            h.stop();
        }
    });

    it('运行中游戏实例变化：TASK_SCOPE_CHANGED 并待复核，不向新实例派发', async () => {
        const game = new FakeGamePort(status());
        game.snapshots.splice(0, game.snapshots.length, snapshot(), snapshot({ instanceId: 'inst-2' }));
        const provider = new FakeProvider([
            (ctx) => envelope({ kind: 'plan', observationId: observationIdOf(ctx), plan: [{ stepId: 's1', title: '浇水', doneWhen: 'watered' }], briefReason: '规划' })
        ]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, { ...submitInput(h.token), scopeMode: 'ephemeral' as const }) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'needs_review');
            const task = h.store.loadTask(accepted.taskId);
            assert.equal(task?.state, 'needs_review');
            assert.equal(task?.blocker?.code, 'TASK_SCOPE_CHANGED');
            assert.equal(game.writes.length, 0, '实例变化后不得派发写动作');
        } finally {
            h.stop();
        }
    });

    it('自然跨日：停止并待复核，不继续用昨天的证据', async () => {
        const game = new FakeGamePort(status());
        const day3 = snapshot();
        const day4 = snapshot({ date: { season: 'spring', day: 4, year: 1 }, snapshotId: 'snap_day4' });
        game.snapshots.splice(0, game.snapshots.length, day3, day3, day4);
        const provider = new FakeProvider([
            (ctx) => envelope({
                kind: 'plan',
                observationId: observationIdOf(ctx),
                plan: [{ stepId: 's1', title: '浇水', doneWhen: 'watered' }],
                briefReason: '规划'
            })
        ]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'needs_review');
            const task = h.store.loadTask(accepted.taskId);
            assert.equal(task?.state, 'needs_review');
            assert.match(task?.blocker?.summary ?? '', /日期|跨日/);
            assert.equal(game.writes.length, 0);
        } finally {
            h.stop();
        }
    });

    it('同一目标连续三次失败且无进展：TASK_STALLED，不再无限重试', async () => {
        const game = new FakeGamePort(status());
        game.snapshots.splice(0, game.snapshots.length, snapshot(), snapshot(), snapshot(), snapshot(), snapshot());
        for (let i = 0; i < 3; i += 1) {
            game.enqueueWriteResult({
                kind: 'receipt',
                receipt: receipt(`dx-fail-${String(i)}`, {
                    status: 'failed',
                    verified: false,
                    effectKnown: true,
                    summary: '路径被阻挡',
                    error: { code: 'PATH_BLOCKED', message: '路径被阻挡', effectKnown: true, nextAction: 'observe', detail: null }
                })
            });
        }
        const alwaysAct = (ctx: string) => envelope({
            kind: 'act',
            observationId: observationIdOf(ctx),
            stepId: 's1',
            toolName: 'stardew_use',
            argumentsJson: JSON.stringify({ target: '@s1:e1' }),
            briefReason: '继续浇水'
        });
        const provider = new FakeProvider([
            (ctx) => envelope({ kind: 'plan', observationId: observationIdOf(ctx), plan: [{ stepId: 's1', title: '浇水', doneWhen: 'watered' }], briefReason: '规划' }),
            alwaysAct, alwaysAct, alwaysAct
        ]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => h.store.loadTask(accepted.taskId)?.state === 'waiting_main');
            const task = h.store.loadTask(accepted.taskId);
            assert.equal(task?.state, 'waiting_main');
            assert.match(task?.blocker?.summary ?? '', /连续失败|TASK_STALLED|无进展/);
            assert.equal(game.writes.length, 3, '第三次失败后停止，不得继续重试');
        } finally {
            h.stop();
        }
    });

    it('run 记录实际使用的 provider 配置版本', async () => {
        const game = new FakeGamePort(status());
        game.snapshots.splice(0, game.snapshots.length, snapshot(), snapshot());
        const plan = (ctx: string) => envelope({ kind: 'plan', observationId: observationIdOf(ctx), plan: [{ stepId: 's1', title: '观察', doneWhen: 'ok' }], briefReason: '规划' });
        // 连续规划会在重规划上限后停止，足以完成一次真实 run 并写入 provider 版本。
        const provider = new FakeProvider([plan, plan, plan]);
        const h = harness(provider, game);
        try {
            const accepted = await h.service.submit(principal, submitInput(h.token)) as { taskId: string };
            await waitFor(() => {
                const state = h.store.loadTask(accepted.taskId)?.state;
                return state === 'waiting_main' || state === 'needs_review' || state === 'completed';
            });
            const runs = h.store.listRuns(accepted.taskId);
            assert.ok(runs.length >= 1);
            assert.equal(runs[0]?.providerId, 'fake');
            assert.equal(runs[0]?.providerConfigRevision, 1);
        } finally {
            h.stop();
        }
    });

    it('客户端授权撤销后下一轮停止，不再调用模型', async () => {
        const game = new FakeGamePort(status());
        game.snapshots.splice(0, game.snapshots.length, snapshot(), snapshot());
        const provider = new FakeProvider([
            (ctx) => envelope({
                kind: 'plan',
                observationId: observationIdOf(ctx),
                plan: [{ stepId: 's1', title: '观察', doneWhen: 'ok' }],
                briefReason: '规划'
            })
        ]);
        const h = harness(provider, game);
        try {
            await h.service.submit(principal, submitInput(h.token));
            h.authz.authorized = false;
            await waitFor(() => {
                const state = h.store.listTasks('tester', { limit: 1 }).tasks[0]?.state;
                return state === 'waiting_main' || state === 'needs_review' || state === 'failed';
            });
            const task = h.store.listTasks('tester', { limit: 1 }).tasks[0];
            assert.ok(task);
            assert.notEqual(task?.state, 'completed');
            assert.ok(provider.calls.length <= 2, '授撤销后不应继续循环调用模型');
        } finally {
            h.stop();
        }
    });
});
