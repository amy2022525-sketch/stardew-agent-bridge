/**
 * 控制权与幂等测试：真实启动 Bridge + 模拟 Mod。
 *
 * 覆盖交接书要求：并发 start 只有一个成功、无会话写入被拒、租约过期后写入被拒、
 * 只读不续租、相同 actionId 不重放、不同内容同 actionId 冲突、人工接管撤销写入权。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startStack, ctxOf, type Stack } from './helpers.js';

const stacks: Stack[] = [];

async function stack(options: Parameters<typeof startStack>[0] = {}): Promise<Stack> {
    const created = await startStack(options);
    stacks.push(created);
    return created;
}

after(async () => {
    for (const created of stacks) await created.stop();
});

describe('控制权', () => {
    it('没有会话时写入被拒绝且不触达游戏', async () => {
        const s = await stack();
        const result = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.match(result.text, /CONTROL_REQUIRED/);
        assert.equal(s.mod.commandCount('select'), 0);
    });

    it('并发 start 只有一个成功，另一个得到 CONTROL_BUSY', async () => {
        const s = await stack();
        const first = await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step', goal: '并发测试' },
            ctxOf(s, 'client-a')
        );
        const second = await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step' },
            ctxOf(s, 'client-b')
        );
        assert.equal(first.isError, false);
        assert.equal(second.isError, true);
        assert.match(second.text, /CONTROL_BUSY/);
        assert.equal(s.bridge.control.list().filter((session) => session.state === 'active').length, 1);
    });

    it('拿到会话后写入成功、写入账本并携带 Mod 确认的 epoch', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step' },
            ctxOf(s)
        );
        const result = await s.bridge.actions.executeTool(
            'stardew_select',
            { slot: 1, actionId: 'act-select-1' },
            ctxOf(s)
        );
        assert.equal(result.isError, false, result.text);
        assert.equal(s.mod.commandCount('select'), 1);
        const received = s.mod.requests.find((request) => request.command === 'select');
        assert.equal(typeof received?.epoch, 'number');
        assert.equal(received?.actionId, 'act-select-1');
        const receipt = s.bridge.actions.resolveReceipt('act-select-1');
        assert.ok(receipt, '应写入收据');
        assert.equal(receipt.status, 'succeeded');
        assert.equal(receipt.command, 'select');
        assert.ok(s.bridge.ledger.findById('act-select-1'));
    });

    it('相同 actionId 与相同参数不重放，返回同一收据', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        const first = await s.bridge.actions.executeTool('stardew_eat', { slot: 2, actionId: 'act-dup' }, ctxOf(s));
        const second = await s.bridge.actions.executeTool('stardew_eat', { slot: 2, actionId: 'act-dup' }, ctxOf(s));
        assert.equal(first.isError, false, first.text);
        assert.equal(second.isError, false, second.text);
        assert.equal(s.mod.commandCount('eat'), 1, '重放请求不得再次触达游戏');
        const firstReceipt = s.bridge.actions.resolveReceipt('act-dup');
        assert.ok(firstReceipt);
        assert.match(second.text, /重放|replay|已完成/);
    });

    it('相同 actionId 但参数不同视为冲突，不会静默覆盖', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        await s.bridge.actions.executeTool('stardew_select', { slot: 0, actionId: 'act-conflict' }, ctxOf(s));
        const conflict = await s.bridge.actions.executeTool(
            'stardew_select',
            { slot: 5, actionId: 'act-conflict' },
            ctxOf(s)
        );
        assert.equal(conflict.isError, true);
        assert.match(conflict.text, /IDEMPOTENCY_CONFLICT/);
        assert.equal(s.mod.commandCount('select'), 1);
    });

    it('结束会话后写入得到 CONTROL_EXPIRED/REQUIRED', async () => {
        const s = await stack();
        const started = await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step' },
            ctxOf(s)
        );
        assert.equal(started.isError, false);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'end' }, ctxOf(s));
        const afterEnd = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(afterEnd.isError, true);
        assert.match(afterEnd.text, /CONTROL_(REQUIRED|EXPIRED)/);
        assert.equal(s.mod.commandCount('select'), 0);
    });

    it('只读观察不续租：租约到期后写入被拒绝，只读仍可继续', async () => {
        const s = await stack({ leaseTtlMs: 1_200 });
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        // 只做只读观察，不写
        for (let index = 0; index < 3; index += 1) {
            const observed = await s.bridge.actions.executeTool('stardew_snapshot', { radius: 3 }, ctxOf(s));
            assert.equal(observed.isError, false, observed.text);
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        const expired = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(expired.isError, true);
        assert.match(expired.text, /CONTROL_(EXPIRED|REQUIRED)/);
        const stillReadable = await s.bridge.actions.executeTool('stardew_snapshot', { radius: 3 }, ctxOf(s));
        assert.equal(stillReadable.isError, false);
    });

    it('人工接管撤销写入权并递增 epoch', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        const epochBefore = s.mod.epoch;
        const takeover = await s.bridge.control.takeover('web_manual_takeover');
        assert.equal(takeover.closedSessionIds.length, 1);
        assert.ok(s.mod.epoch > epochBefore, '接管必须让 Mod 侧 epoch 递增');
        const blocked = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(blocked.isError, true);
        assert.match(blocked.text, /CONTROL_(REQUIRED|EXPIRED)/);
    });

    it('世界变化会关闭已有控制会话（防止跨存档写入）', async () => {
        const s = await stack();
        const started = await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step' },
            ctxOf(s)
        );
        assert.equal(started.isError, false);
        s.mod.saveLoaded = false;
        await s.bridge.actions.executeTool('stardew_snapshot', { radius: 2 }, ctxOf(s));
        // 模拟 Mod 重连后报告新世界
        s.mod.instanceId = 'mock-instance-2';
        s.mod.dropConnections();
        const deadline = Date.now() + 6_000;
        while (Date.now() < deadline && s.bridge.control.list().some((session) => session.state === 'active')) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const activeCount = s.bridge.control.list().filter((session) => session.state === 'active').length;
        assert.equal(activeCount, 0, '世界/实例变化后不应保留活动写入会话');
    });
});
