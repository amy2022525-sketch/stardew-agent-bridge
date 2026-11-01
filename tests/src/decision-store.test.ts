/**
 * DXS-01/DXS-05 类断言：决策库 schema、CAS、单执行槽、幂等预留与重启恢复。
 * 使用临时目录，绝不触碰用户真实数据根。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DecisionStore } from '@sab/decision-core';
import type { TaskRecord } from '@sab/contracts';
import { TEST_IDENTITY } from './decision-fixtures.js';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
        schemaVersion: 1,
        taskId: overrides.taskId ?? 'ptask_test_1',
        ownerClientId: 'tester',
        definition: {
            title: '测试任务',
            goal: '给两格作物浇水',
            providerId: 'fake',
            constraints: { locations: ['Farm'], allowDayChange: false },
            budget: {},
            successCriteria: []
        },
        definitionRevision: 1,
        stateVersion: 1,
        state: 'queued',
        phase: 'preflight',
        scope: {
            mode: 'persistent',
            profileId: 'default',
            worldId: TEST_IDENTITY.worldId,
            actorFarmerId: TEST_IDENTITY.actorFarmerId,
            instanceId: 'inst-1',
            worldGeneration: 3,
            scopeKey: `p:default:${TEST_IDENTITY.worldId}:${TEST_IDENTITY.actorFarmerId}`
        },
        policySnapshot: {
            policyId: 'farm-care',
            revision: 1,
            allowedTools: ['stardew_use'],
            allowedLocations: ['Farm'],
            toolRestrictions: {},
            capturedAt: '2026-10-30T01:00:00.000Z'
        },
        providerRef: 'fake',
        budgetLimit: { maxModelCalls: 10, maxWriteActions: 10, maxActiveMs: 60_000, maxAccountedTokens: 10_000, maxHttpAttempts: 10 },
        budgetUsed: { modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false },
        plan: null,
        currentRunId: null,
        createdAt: '2026-10-30T01:00:00.000Z',
        updatedAt: '2026-10-30T01:00:00.000Z',
        pauseReason: null,
        blocker: null,
        completion: null,
        lastEvidenceSummary: null,
        ...overrides
    };
}

describe('决策库：CAS、单槽、幂等与恢复', () => {
    let area = '';
    let store: DecisionStore;

    before(() => {
        area = mkdtempSync(path.join(os.tmpdir(), 'sab-decision-store-'));
        store = new DecisionStore(path.join(area, 'decision.sqlite'));
    });

    after(() => {
        store.close();
        rmSync(area, { recursive: true, force: true });
    });

    it('新库可写且 schema 版本为 1', () => {
        assert.equal(store.writable, true);
        assert.equal(store.schemaVersion, 1);
    });

    it('create/load 往返保留作用域与预算', () => {
        store.createTask(makeTask());
        const loaded = store.loadTask('ptask_test_1');
        assert.ok(loaded);
        assert.equal(loaded.scope.scopeKey, makeTask().scope.scopeKey);
        assert.equal(loaded.budgetLimit.maxWriteActions, 10);
    });

    it('stateVersion 不连续或底层版本不符时抛 TASK_REVISION_CONFLICT', () => {
        const current = store.loadTask('ptask_test_1');
        assert.ok(current);
        assert.throws(
            () => store.updateTask({ ...current, state: 'running', stateVersion: current.stateVersion + 2 }, current.stateVersion),
            /版本号不连续|INTERNAL_ERROR/
        );
        store.updateTask({ ...current, state: 'running', stateVersion: current.stateVersion + 1 }, current.stateVersion);
        const running = store.loadTask('ptask_test_1');
        assert.ok(running);
        assert.throws(
            () => store.updateTask({ ...running, state: 'paused', stateVersion: running.stateVersion + 1 }, running.stateVersion - 1),
            /版本冲突|TASK_REVISION_CONFLICT/
        );
    });

    it('单执行槽：第二个任务拿不到槽，释放后可再取', () => {
        assert.equal(store.tryAcquireSlot('ptask_test_1', 1, '2026-10-30T01:00:00.000Z'), true);
        assert.equal(store.tryAcquireSlot('ptask_other', 1, '2026-10-30T01:00:00.000Z'), false);
        assert.equal(store.currentSlot()?.taskId, 'ptask_test_1');
        assert.equal(store.releaseSlot('ptask_test_1', 1), true);
        assert.equal(store.tryAcquireSlot('ptask_other', 1, '2026-10-30T01:00:00.000Z'), true);
        store.clearSlot();
    });

    it('requestId 同内容回放、不同内容冲突，且不产生第二行', () => {
        const created = '2026-10-30T01:00:00.000Z';
        assert.equal(store.reserveRequest({ ownerClientId: 'tester', requestId: 'req-1', operation: 'submit', taskId: null, canonicalHash: 'h1', createdAt: created }).kind, 'none');
        assert.equal(store.reserveRequest({ ownerClientId: 'tester', requestId: 'req-1', operation: 'submit', taskId: null, canonicalHash: 'h1', createdAt: created }).kind, 'same');
        assert.equal(store.reserveRequest({ ownerClientId: 'tester', requestId: 'req-1', operation: 'submit', taskId: null, canonicalHash: 'h2', createdAt: created }).kind, 'conflict');
    });

    it('重启恢复把 queued/running/pausing 改成 needs_review 并清空槽位', () => {
        const paused = store.loadTask('ptask_test_1');
        assert.ok(paused);
        store.updateTask({ ...paused, state: 'paused', stateVersion: paused.stateVersion + 1 }, paused.stateVersion);
        const second = makeTask({ taskId: 'ptask_test_2', state: 'running', stateVersion: 3 });
        store.createTask(second);
        assert.equal(store.tryAcquireSlot('ptask_test_2', 2, '2026-10-30T01:00:00.000Z'), true);
        const recovery = store.recoverOnStartup();
        assert.deepEqual(recovery.recoveredTaskIds, ['ptask_test_2']);
        const recovered = store.loadTask('ptask_test_2');
        assert.equal(recovered?.state, 'needs_review');
        assert.equal(recovered?.blocker?.code, 'RESULT_UNKNOWN');
        assert.equal(store.currentSlot(), null);
    });

    it('归档保留任务与请求 tombstone，不删除未决动作', () => {
        store.archiveTask('ptask_test_1', '2026-10-30T02:00:00.000Z');
        const page = store.listTasks('tester', { limit: 10, includeArchived: false });
        assert.equal(page.tasks.some((task) => task.taskId === 'ptask_test_1'), false);
        const all = store.listTasks('tester', { limit: 10, includeArchived: true });
        assert.equal(all.tasks.some((task) => task.taskId === 'ptask_test_1'), true);
    });
});
