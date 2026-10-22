import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { startStack, ctxOf, type Stack } from './helpers.js';

const stacks: Stack[] = [];
async function stack(): Promise<Stack> {
    const value = await startStack();
    stacks.push(value);
    return value;
}
after(async () => { for (const value of stacks) await value.stop(); });

describe('交接复核：真实并发与会话隔离', () => {
    it('诊断预览和导出均递归移除事件中的凭据、存档与本机路径', async () => {
        const s = await stack();
        s.bridge.events.publish('diagnostic_fixture', { nested: { token: s.token, note: `Bearer ${s.token} C:\\Users\\private-user\\secret.txt FixtureSave_1234567890`, localPath: s.dataDir } });
        const sessionResponse = await fetch(`http://127.0.0.1:${s.bridgePort}/api/v1/session`);
        const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
        const session = await sessionResponse.json() as { csrfToken: string };
        const preview = await fetch(`http://127.0.0.1:${s.bridgePort}/api/v1/diagnostics`, { headers: { cookie } });
        const exported = await fetch(`http://127.0.0.1:${s.bridgePort}/api/v1/diagnostics/export`, { method: 'POST', headers: { cookie, 'x-sab-csrf': session.csrfToken } });
        assert.equal(exported.status, 200);
        const record = await exported.json() as { file: string };
        for (const payload of [await preview.text(), readFileSync(record.file, 'utf8')]) {
            for (const secret of [s.token, 'private-user', 'FixtureSave_1234567890', s.dataDir]) assert.ok(!payload.includes(secret));
            assert.ok(payload.includes('<redacted>'));
        }
    });

    it('Mod 报 failed 但无法确定副作用时必须保留 unknown，而非确定失败', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s));
        s.mod.setBehavior('buy', () => ({ status: 'failed', error: { code: 'VERIFY_FAILED', message: 'purchase verification failed', effectKnown: false } }));
        const result = await s.bridge.actions.executeTool('stardew_buy', { itemId: '(O)472', count: 1, actionId: 'uncertain-purchase' }, ctxOf(s));
        const receipt = result.structured?.receipt as { status: string; effectKnown: boolean; nextAction: string };
        assert.equal(receipt.status, 'unknown');
        assert.equal(receipt.effectKnown, false);
        assert.equal(receipt.nextAction, 'query_action');
    });

    it('钓鱼预算耗尽不能报告已核验鱼获，实际阶段必须保留', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s));
        s.mod.setBehavior('fish', () => ({ status: 'succeeded', result: { outcome: 'partial', reason: 'budget_exhausted', phase: 'waiting_bite', inventoryDelta: [] } }));
        const result = await s.bridge.actions.executeTool('stardew_fish', { actionId: 'no-catch' }, ctxOf(s));
        const receipt = result.structured?.receipt as { status: string; verified: boolean; effects: Record<string, unknown> };
        assert.equal(receipt.status, 'partial');
        assert.equal(receipt.verified, false);
        assert.equal(receipt.effects.outcome, 'partial');
    });

    it('异步加载只标记受理，需另行观察存档就绪', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s));
        s.mod.setBehavior('load', () => ({ status: 'succeeded', result: { accepted: true, saveId: 'Test_123' } }));
        const result = await s.bridge.actions.executeTool('stardew_load', { saveId: 'Test_123', actionId: 'load-accept' }, ctxOf(s));
        const receipt = result.structured?.receipt as { status: string; verified: boolean };
        assert.equal(receipt.status, 'accepted');
        assert.equal(receipt.verified, false);
    });

    it('仅留下派发意图的崩溃窗口仍可按 actionId 查询，不能伪装成未执行', async () => {
        const s = await stack();
        s.bridge.ledger.recordIntent({ dedupKey: 'mock-instance-1#crash-window', actionId: 'crash-window', signature: 'test', command: 'buy', clientId: s.clientId, controlSessionId: null, gameInstanceId: 'mock-instance-1', worldGeneration: 3, intentAt: new Date().toISOString() });
        const result = await s.bridge.actions.executeTool('stardew_status', { actionId: 'crash-window' }, ctxOf(s));
        const receipt = result.structured?.receipt as { status: string; effectKnown: boolean; verified: boolean };
        assert.equal(receipt.status, 'unknown');
        assert.equal(receipt.effectKnown, false);
        assert.equal(receipt.verified, false);
        assert.ok(s.bridge.actions.getStatus().control.unresolvedActionIds.includes('crash-window'));
        assert.equal(s.mod.commandCount('buy'), 0);
    });

    it('同时发起的 start 在等待 Mod 确认前也只能派发一次 acquire', async () => {
        const s = await stack();
        const results = await Promise.all(['client-a', 'client-b'].map(clientId =>
            s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s, clientId))
        ));
        assert.equal(results.filter(result => !result.isError).length, 1);
        assert.equal(s.mod.requests.filter(request => request.command === 'control' && request.args.operation === 'acquire').length, 1);
        assert.equal(s.bridge.control.list().filter(session => session.state === 'active').length, 1);
    });

    it('同一游戏进程中更换 worldGeneration 也必须关闭旧会话', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_snapshot', {}, ctxOf(s));
        const started = await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s));
        assert.equal(started.isError, false);
        s.mod.worldGeneration += 1;
        await s.bridge.actions.executeTool('stardew_snapshot', {}, ctxOf(s));
        const result = await s.bridge.actions.executeTool('stardew_select', { slot: 0 }, ctxOf(s));
        assert.equal(result.isError, true);
        assert.equal(s.mod.commandCount('select'), 0);
    });

    it('曾经执行过动作的旧客户端不能用无 ID 的 stop 停止新控制者', async () => {
        const s = await stack();
        const a = ctxOf(s, 'client-a');
        const b = ctxOf(s, 'client-b');
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, a);
        await s.bridge.actions.executeTool('stardew_select', { slot: 0, actionId: 'prior-a' }, a);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'end' }, a);
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, b);
        const result = await s.bridge.actions.executeTool('stardew_stop', {}, a);
        assert.equal(s.mod.commandCount('stop'), 0, result.text);
    });

    it('未知 actionId 不会被转发给 Mod，更不会改变当前游戏菜单', async () => {
        const s = await stack();
        await s.bridge.actions.executeTool('stardew_session', { operation: 'start' }, ctxOf(s, 'client-b'));
        await s.bridge.actions.executeTool('stardew_stop', { actionId: 'does-not-exist' }, ctxOf(s, 'client-a'));
        assert.equal(s.mod.commandCount('stop'), 0);
    });
});
