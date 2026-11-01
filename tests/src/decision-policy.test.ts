/**
 * DXP-01/DXP-02/DXP-04/DXP-05 类断言：三层工具交集、参数级保护与预算口径。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetMeter, checkToolGuard, computeEffectiveTools, conservativeTokenReserve, intersectPolicies, rejectInjectedIdentityFields, synthesizeBudget, validateCustomPolicyTools, hasLiveCrop, refreshActionArgs, wateringTargets } from '@sab/decision-core';
import type { GuardContext } from '@sab/decision-core';
import { TEST_POLICY, snapshot } from './decision-fixtures.js';

const guardContext: GuardContext = {
    selectedToolForSlot: (slot) => (slot === '0' ? 'watering_can' : 'other'),
    currentSelectedSlot: 0,
    itemIdForSlot: (slot) => slot === 0 ? '(T)WateringCan' : '(O)24',
    observedWaterTargets: new Set(['@s1:e1'])
};

describe('工具政策：交集与参数保护', () => {
    it('控制/任务/配置类工具即使被写进政策也不会暴露给执行模型', () => {
        const policy = { ...TEST_POLICY, allowedTools: [...TEST_POLICY.allowedTools, 'stardew_task', 'stardew_session', 'stardew_saves', 'stardew_stop'] };
        const tools = computeEffectiveTools(policy, ['move', 'select', 'use', 'snapshot', 'task']);
        // 农场照料必须保留观察工具（snapshot/status），但控制/任务/存档类永不出现。
        assert.deepEqual(tools.toolNames, ['stardew_move', 'stardew_select', 'stardew_snapshot', 'stardew_status', 'stardew_use']);
        for (const forbidden of ['stardew_task', 'stardew_session', 'stardew_saves', 'stardew_stop']) {
            assert.equal(tools.toolNames.includes(forbidden), false, forbidden);
        }
    });

    it('Mod 未声明写能力的工具被剔除', () => {
        const tools = computeEffectiveTools(TEST_POLICY, ['use']);
        // status 由 Bridge 本地合成，不依赖 Mod 能力；其余工具按 Mod 声明过滤。
        assert.deepEqual(tools.toolNames, ['stardew_status', 'stardew_use']);
    });

    it('状态查询允许（Bridge 本地只读），存档/截图/诊断永不暴露', () => {
        const policy = { ...TEST_POLICY, allowedTools: ['stardew_status', 'stardew_saves', 'stardew_load', 'stardew_screenshot', 'stardew_doctor', 'stardew_multiplayer'] };
        const tools = computeEffectiveTools(policy, ['status', 'saves', 'load', 'screenshot', 'hello', 'multiplayer']);
        assert.deepEqual(tools.toolNames, ['stardew_status']);
    });

    it('custom 政策拒绝没有已实现保护的高影响工具', () => {
        const denied = validateCustomPolicyTools(['stardew_buy'], {});
        assert.equal(denied.ok, false);
        assert.match(denied.issues.join('；'), /stardew_buy/);
        assert.equal(validateCustomPolicyTools(['stardew_interact'], {}).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_menu'], {}).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_saves'], {}).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_use'], {}).ok, false, 'use 必须有 waterOnly');
        assert.equal(validateCustomPolicyTools(['stardew_use'], { stardew_use: { waterOnly: true } }).ok, true);
        assert.equal(validateCustomPolicyTools(['stardew_eat'], { stardew_eat: { allowedItemIds: [] } }).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_eat'], { stardew_eat: { allowedItemIds: ['(O)24'], maxCountPerAction: 1 } }).ok, true);
        assert.equal(validateCustomPolicyTools(['stardew_move', 'stardew_snapshot'], {}).ok, true);
    });

    it('拒绝模型注入 actionId/controlSessionId/owner/epoch', () => {
        for (const key of ['actionId', 'controlSessionId', 'owner', 'epoch', 'clientId', 'actor']) {
            const result = rejectInjectedIdentityFields({ [key]: 'x' });
            assert.equal(result.ok, false, key);
        }
        assert.equal(rejectInjectedIdentityFields({ slot: 0 }).ok, true);
    });

    it('water-only：只能选水壶、只能对已观察待浇作物使用', () => {
        assert.equal(checkToolGuard('stardew_select', { slot: 0 }, { waterOnly: true }, guardContext).ok, true);
        assert.equal(checkToolGuard('stardew_select', { slot: 1 }, { waterOnly: true }, guardContext).ok, false);
        assert.equal(checkToolGuard('stardew_use', { target: '@s1:e1' }, { waterOnly: true }, guardContext).ok, true);
        assert.equal(checkToolGuard('stardew_use', { target: '@s9:e9' }, { waterOnly: true }, guardContext).ok, false);
        assert.equal(checkToolGuard('stardew_buy', { itemId: 'Parsnip' }, { waterOnly: true }, guardContext).ok, false);
    });

    it('未知 guard 字段视为未实现，直接拒绝而不是假装有保护', () => {
        const result = checkToolGuard('stardew_use', { target: '@s1:e1' }, { waterOnly: true, scriptExpression: true } as never, guardContext);
        assert.equal(result.ok, false);
        assert.match(result.ok ? '' : result.reason, /未实现/);
    });

    it('native soil 作物与补水源可用，空土、死作物及已浇地不可误认', () => {
        const observed = snapshot({ entities: [
            { ref: '@s2:e1', kind: 'soil', name: '作物', tile: { x: 1, y: 1 }, crop: '(O)24', cropState: { itemId: '(O)24', dead: false }, needsWater: true, watered: false },
            { ref: '@s2:e2', kind: 'water', name: '水源', tile: { x: 2, y: 1 }, refillable: true },
            { ref: '@s2:e3', kind: 'soil', name: '空地', tile: { x: 3, y: 1 }, watered: false },
            { ref: '@s2:e4', kind: 'soil', name: '死作物', tile: { x: 4, y: 1 }, crop: '(O)24', cropState: { itemId: '(O)24', dead: true }, needsWater: true },
            { ref: '@s2:e5', kind: 'soil', name: '已浇作物', tile: { x: 5, y: 1 }, crop: '(O)24', needsWater: false, watered: true }
        ] });
        assert.equal(hasLiveCrop(observed.entities[0]!), true);
        assert.deepEqual([...wateringTargets(observed)], ['@s2:e1', '@s2:e2']);
    });

    it('use 必须确认当前手持水壶，不能拿锄头通过目标白名单', () => {
        assert.equal(checkToolGuard('stardew_use', { target: '@s1:e1' }, { waterOnly: true }, { ...guardContext, currentSelectedSlot: 1 }).ok, false);
        assert.equal(checkToolGuard('stardew_use', { target: '@s1:e1' }, { waterOnly: true }, { ...guardContext, currentSelectedSlot: null }).ok, false);
    });

    it('槽位工具按真实背包物品应用白名单；无法证明配方/箱内来源时不开放', () => {
        assert.equal(checkToolGuard('stardew_eat', { slot: 1 }, { allowedItemIds: ['(O)24'], maxCountPerAction: 1 }, guardContext).ok, true);
        assert.equal(checkToolGuard('stardew_eat', { slot: 1 }, { allowedItemIds: ['(O)194'], maxCountPerAction: 1 }, guardContext).ok, false);
        assert.equal(checkToolGuard('stardew_place', { slot: 3 }, { allowedItemIds: ['(O)24'] }, { ...guardContext, itemIdForSlot: () => null }).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_craft'], { stardew_craft: { allowedItemIds: ['(O)24'], maxCountPerAction: 1 } }).ok, false);
        assert.equal(validateCustomPolicyTools(['stardew_container'], { stardew_container: { allowedItemIds: ['(O)24'], maxCountPerAction: 1 } }).ok, false);
    });

    it('政策地点无交集必须拒绝，移除 waterOnly 或扩大物品清单不能放宽旧任务', () => {
        assert.throws(() => intersectPolicies(TEST_POLICY, { ...TEST_POLICY, allowedLocations: ['Town'] }), /共同允许/);
        const expanded = intersectPolicies(TEST_POLICY, { ...TEST_POLICY, toolRestrictions: {} });
        assert.equal(expanded.toolRestrictions.stardew_use?.waterOnly, true);
        const restricted = intersectPolicies({ ...TEST_POLICY, allowedLocations: [] }, { ...TEST_POLICY, allowedLocations: ['Town'] });
        assert.deepEqual(restricted.allowedLocations, ['Town']);
    });

    it('模型等待后静态地块引用可重新绑定，手持工具或作物变化则必须重新决策', () => {
        const before = snapshot();
        const next = snapshot({ entities: before.entities.map(entity => ({ ...entity, ref: entity.ref.replace('@s1:', '@s2:') })) });
        assert.deepEqual(refreshActionArgs(before, next, 'stardew_use', { target: '@s1:e1' }), { target: '@s2:e1' });
        assert.equal(refreshActionArgs(before, { ...next, player: { ...next.player!, selectedSlot: 3 } }, 'stardew_use', { target: '@s1:e1' }), null);
        assert.equal(refreshActionArgs(before, { ...next, entities: next.entities.map(entity => ({ ...entity, watered: true })) }, 'stardew_use', { target: '@s1:e1' }), null);
    });

    it('数量与金币上限只统计显式传入的字段，缺字段不误判', () => {
        assert.equal(checkToolGuard('stardew_buy', { count: 3 }, { maxCountPerAction: 2 }, guardContext).ok, false);
        assert.equal(checkToolGuard('stardew_buy', { count: 1 }, { maxCountPerAction: 2 }, guardContext).ok, true);
        assert.equal(checkToolGuard('stardew_buy', {}, { maxGoldSpendPerAction: 0 }, guardContext).ok, true);
        assert.equal(checkToolGuard('stardew_buy', { price: 10 }, { maxGoldSpendPerAction: 0 }, guardContext).ok, false);
    });
});

describe('预算：取更严值、未知用量不当 0', () => {
    it('已回报真实 usage 的请求不会因预留更大而被错误标成未知', () => {
        const budget = new BudgetMeter(synthesizeBudget(undefined, undefined, undefined), {
            modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false
        }, 0);
        const reserved = budget.reserveModelCall(5000);
        budget.settleModelCall(reserved, { inputTokens: 100, outputTokens: 20, totalTokens: 120, usageKnown: true, reservedTokens: reserved });
        assert.equal(budget.snapshot().accountedTokens, 120);
        assert.equal(budget.snapshot().usageUnknown, false);
    });
    it('min(全局, provider, 任务) 生效，缺省取硬上限', () => {
        const merged = synthesizeBudget({ maxModelCalls: 20 }, { maxModelCalls: 30 }, { maxModelCalls: 40 });
        assert.equal(merged.maxModelCalls, 20);
        assert.equal(merged.maxWriteActions, 80);
        const stricterTask = synthesizeBudget({ maxWriteActions: 10 }, undefined, { maxWriteActions: 5 });
        assert.equal(stricterTask.maxWriteActions, 5);
    });

    it('未知用量保留保守预留并置 usageUnknown，绝不当 0', () => {
        const budget = new BudgetMeter(synthesizeBudget(undefined, undefined, { maxAccountedTokens: 10_000 }), {
            modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false
        }, 0);
        const reserved = budget.reserveModelCall(conservativeTokenReserve('x'.repeat(400), 2048));
        budget.settleModelCall(reserved, { inputTokens: null, outputTokens: null, totalTokens: null, usageKnown: false, reservedTokens: reserved });
        const usage = budget.snapshot();
        assert.equal(usage.usageUnknown, true);
        assert.ok(usage.accountedTokens >= reserved);
        assert.equal(usage.modelCalls, 1);
    });

    it('写动作在派发前预留，达到上限后拒绝', () => {
        const budget = new BudgetMeter(synthesizeBudget(undefined, undefined, { maxWriteActions: 2 }), {
            modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false
        }, 0);
        assert.equal(budget.reserveWriteAction().allowed, true);
        assert.equal(budget.reserveWriteAction().allowed, true);
        assert.equal(budget.reserveWriteAction().allowed, false);
        assert.equal(budget.snapshot().writeActions, 2);
    });

    it('人工暂停期间 active 时间不累计', () => {
        const budget = new BudgetMeter(synthesizeBudget(undefined, undefined, { maxActiveMs: 10_000 }), {
            modelCalls: 0, writeActions: 0, httpAttempts: 0, activeMs: 0, accountedTokens: 0, usageUnknown: false
        }, 0);
        budget.startRunClock(1_000);
        budget.pauseClock(3_000);
        assert.equal(budget.currentActiveMs(50_000), 2_000);
        budget.startRunClock(50_000);
        assert.equal(budget.currentActiveMs(51_000), 3_000);
    });
});
