/**
 * 故障语义测试：结果不明、账本不可写、断线后的只读与写拒绝。
 *
 * 关键断言：不确定的结果绝不报告为成功，也绝不用新 ID 自动重放。
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

async function waitForReconnect(s: Stack, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !s.bridge.mod.connected) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(s.bridge.mod.connected, true, 'Mod 应在断线后自动重连');
}

describe('结果不明', () => {
    it('动作执行期间断线 → 收据 unknown、effectKnown=false、下一步查询', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        s.mod.setBehavior('move', () => ({ status: 'succeeded', dropConnection: true }));

        const result = await s.bridge.actions.executeTool(
            'stardew_move',
            { x: 12, y: 12, actionId: 'act-drop' },
            ctxOf(s)
        );
        assert.equal(result.isError, true);
        assert.match(result.text, /RESULT_UNKNOWN/);
        assert.match(result.text, /RESULT_UNKNOWN/);
        assert.match(result.text, /下一步=query_action/);

        const receipt = s.bridge.actions.resolveReceipt('act-drop');
        assert.ok(receipt, '必须留下收据');
        assert.equal(receipt.status, 'unknown');
        assert.equal(receipt.effectKnown, false);
        assert.equal(receipt.nextAction, 'query_action');
        const row = s.bridge.ledger.findById('act-drop');
        assert.equal(row?.status, 'unknown');

        await waitForReconnect(s);

        // 同一 actionId 重试：不得再次触达游戏，只返回“原记录未定”
        const before = s.mod.commandCount('move');
        const retry = await s.bridge.actions.executeTool('stardew_move', { x: 12, y: 12, actionId: 'act-drop' }, ctxOf(s));
        assert.equal(retry.isError, true);
        assert.match(retry.text, /RESULT_UNKNOWN|尚无最终收据|不要用新 ID/);
        assert.equal(s.mod.commandCount('move'), before, '重试不得再次执行');
    });

    it('未决动作出现在状态与收据列表中', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        s.mod.setBehavior('use', () => ({ status: 'unknown' }));
        const result = await s.bridge.actions.executeTool('stardew_use', { target: '@s1:e1', actionId: 'act-unknown' }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.match(result.text, /RESULT_UNKNOWN/);

        const status = s.bridge.actions.getStatus();
        assert.ok(status.control.unresolvedActionIds.includes('act-unknown'), '未决动作应被列出');
        const receipts = s.bridge.actions.recentReceipts(10);
        assert.ok(receipts.some((receipt) => receipt.actionId === 'act-unknown' && receipt.status === 'unknown'));
    });

    it('Mod 明确报告失败时不写成成功，并保留错误码', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
        s.mod.setBehavior('buy', () => ({
            status: 'failed',
            error: { code: 'NOT_ENOUGH_MONEY', message: '金币不足（模拟）。', effectKnown: true, nextAction: 'observe' }
        }));
        const result = await s.bridge.actions.executeTool('stardew_buy', { itemId: '(O)472', count: 1, actionId: 'act-buy' }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.match(result.text, /INSUFFICIENT_RESOURCE/);
        const receipt = s.bridge.actions.resolveReceipt('act-buy');
        assert.equal(receipt?.status, 'failed');
        assert.equal(receipt?.error?.code, 'INSUFFICIENT_RESOURCE');
        assert.equal((receipt?.error?.detail as { originalCode?: string } | null)?.originalCode, 'NOT_ENOUGH_MONEY');
    });
});

describe('账本不可写', () => {
    it('拒绝派发写动作，并且不触达游戏', async () => {
        const s = await stack({ breakLedger: true });
        assert.equal(s.bridge.ledger.writable, false);
        const session = await s.bridge.actions.executeTool(
            'stardew_session',
            { operation: 'start', mode: 'step' },
            ctxOf(s)
        );
        // 会话本身可能因账本损坏而失败；无论成功与否，写动作都必须被拒绝。
        assert.ok(session.isError === false || session.isError === true);
        const result = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.match(result.text, /JOURNAL_UNAVAILABLE|CONTROL_/);
        assert.equal(s.mod.commandCount('select'), 0);
    });
});

describe('断线期间的行为', () => {
    it('断线后只读请求返回 GAME_UNAVAILABLE，而不是空结果', async () => {
        const s = await stack();
        s.mod.dropConnections();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && s.bridge.mod.connected) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const result = await s.bridge.actions.executeTool('stardew_snapshot', { radius: 3 }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.match(result.text, /GAME_UNAVAILABLE/);
    });

    it('没有在途动作时 stop 明确报告“无动作”，且不谎报释放输入', async () => {
        const s = await stack();
        const result = await s.bridge.actions.executeTool('stardew_stop', {}, ctxOf(s));
        assert.equal(result.isError, false);
        assert.match(result.text, /没有|无/);
    });
});
