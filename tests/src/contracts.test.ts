/**
 * 契约层测试：工具目录完整性、参数校验、签名与收据稳定化。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    TOOLS,
    TOOL_INDEX,
    validateToolArguments,
    actionSignature,
    canonicalJson,
    ERROR_CODES,
    makeFault
} from '@sab/contracts';

const WRITE_TOOLS = TOOLS.filter((tool) => tool.kind === 'write');
const READ_TOOLS = TOOLS.filter((tool) => tool.kind === 'read');

describe('工具目录', () => {
    it('包含 28 个工具且名称唯一、统一前缀', () => {
        assert.equal(TOOLS.length, 28);
        const names = new Set(TOOLS.map((tool) => tool.name));
        assert.equal(names.size, TOOLS.length);
        for (const tool of TOOLS) {
            assert.match(tool.name, /^stardew_[a-z]+$/);
            assert.ok(tool.description.length >= 8, `${tool.name} 描述过短`);
            assert.equal(typeof tool.inputSchema, 'object');
            assert.ok(tool.annotations, `${tool.name} 缺少 annotations`);
            assert.equal(typeof tool.command, 'string');
            assert.ok(tool.command.length > 0, tool.name + ' 缺少 Mod 命令名');
            assert.equal(typeof tool.modArgs === 'function' || tool.modArgs === undefined, true);
        }
        assert.equal(OBJECT_KEYS_UNIQUE(), true);
    });

    it('读写分类与现实约束一致：调试类工具不存在', () => {
        assert.ok(READ_TOOLS.length >= 8);
        assert.ok(WRITE_TOOLS.length >= 12);
        const forbidden = ['stardew_warp', 'stardew_skipevent', 'stardew_diag', 'stardew_give', 'stardew_setmoney'];
        for (const name of forbidden) {
            assert.equal(TOOL_INDEX.has(name), false, `${name} 不应作为 Agent 工具存在`);
        }
    });

    it('写工具统一接受 actionId 与 controlSessionId', () => {
        for (const tool of WRITE_TOOLS) {
            const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
            assert.ok('actionId' in props, `${tool.name} 缺少 actionId`);
            assert.ok('controlSessionId' in props, `${tool.name} 缺少 controlSessionId`);
        }
    });
});

function OBJECT_KEYS_UNIQUE(): boolean {
    return new Set(TOOLS.map((tool) => tool.name)).size === TOOLS.length;
}

describe('参数校验', () => {
    it('snapshot 接受半径 16 并拒绝 17', () => {
        assert.equal(validateToolArguments('stardew_snapshot', { radius: 16 }).ok, true);
        const bad = validateToolArguments('stardew_snapshot', { radius: 17 });
        assert.equal(bad.ok, false);
        assert.equal(bad.ok, false);
        if (bad.ok === false) assert.match(bad.issues.map((issue) => issue.path).join(','), /radius/);
    });

    it('move 要求 near 与绝对坐标二选一', () => {
        assert.equal(validateToolArguments('stardew_move', { x: 12, y: 9 }).ok, true);
        assert.equal(validateToolArguments('stardew_move', { near: '@s2:e1' }).ok, true);
        assert.equal(validateToolArguments('stardew_move', { x: 12, y: 9, near: '@s2:e1' }).ok, false);
        assert.equal(validateToolArguments('stardew_move', {}).ok, false);
    });

    it('拒绝未知参数与非法槽位', () => {
        assert.equal(validateToolArguments('stardew_snapshot', { bogus: 1 }).ok, false);
        assert.equal(validateToolArguments('stardew_select', { slot: 36 }).ok, false);
        assert.equal(validateToolArguments('stardew_select', { slot: -1 }).ok, false);
        assert.equal(validateToolArguments('stardew_select', { slot: 0 }).ok, true);
        assert.equal(validateToolArguments('stardew_equip', { slot: 1, kind: 'hat' }).ok, true);
        assert.equal(validateToolArguments('stardew_equip', { slot: 1, kind: 'cape' }).ok, false);
    });

    it('容器操作需要槽位而 list 不需要', () => {
        assert.equal(validateToolArguments('stardew_container', { target: '@s1:e1', operation: 'list' }).ok, true);
        assert.equal(validateToolArguments('stardew_container', { target: '@s1:e1', operation: 'deposit' }).ok, false);
        assert.equal(
            validateToolArguments('stardew_container', { target: '@s1:e1', operation: 'deposit', slot: 3, count: 2 }).ok,
            true
        );
    });

    it('未知工具返回结构化失败', () => {
        const result = validateToolArguments('stardew_warp', {});
        assert.equal(result.ok, false);
    });
});

describe('签名与收据', () => {
    it('canonicalJson 与键序无关', () => {
        assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
        assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
    });

    it('相同工具与参数产生相同签名，参数变化产生不同签名', () => {
        const base = { clientId: 'tester', controlSessionId: 'cs-1', command: 'move' };
        const first = actionSignature({ ...base, args: { x: 1, y: 2 } });
        const second = actionSignature({ ...base, args: { y: 2, x: 1 } });
        const third = actionSignature({ ...base, args: { x: 1, y: 3 } });
        assert.equal(first, second);
        assert.notEqual(first, third);
        assert.match(first, /^[0-9a-f]{32,64}$/);
    });
});

describe('错误表', () => {
    it('每个错误码都有说明与下一步建议', () => {
        for (const [code, entry] of Object.entries(ERROR_CODES)) {
            assert.ok(entry.message.length > 0, `${code} 缺少消息`);
            assert.ok(['observe', 'query_action', 'stop', 'wait', 'restart_control', 'fix_environment', 'upgrade', 'none'].includes(entry.nextAction));
            assert.equal(typeof entry.effectKnown, 'boolean');
        }
    });

    it('makeFault 保留 effectKnown 语义', () => {
        const fault = makeFault('RESULT_UNKNOWN');
        assert.equal(fault.code, 'RESULT_UNKNOWN');
        assert.equal(fault.effectKnown, false);
        assert.equal(fault.nextAction, 'query_action');
    });
});
