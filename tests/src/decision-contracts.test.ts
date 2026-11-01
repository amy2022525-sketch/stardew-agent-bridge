/**
 * DXC-01/DXC-05/DXC-06/DXP-08/DXV-12 类断言：契约、决策包解析与完成判定。
 * 合成 fixture；不访问网络、不启动游戏。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateCriteria, parseDecisionText, validateDecisionEnvelope } from '@sab/decision-core';
import { validateToolArguments } from '@sab/contracts';
import { envelope, snapshot } from './decision-fixtures.js';

describe('决策契约：参数校验与决策包', () => {
    it('submit 缺 goal / 多余字段 / 非法 requestId 一律拒绝', () => {
        const missing = validateToolArguments('stardew_task', { operation: 'submit', requestId: 'req-1' });
        assert.equal(missing.ok, false);
        const extra = validateToolArguments('stardew_task', {
            operation: 'submit', requestId: 'req-1', contextToken: 'x'.repeat(32), title: 't', goal: 'g', ownerClientId: 'spoofed'
        });
        assert.equal(extra.ok, false, '不允许请求正文自填 ownerClientId');
        const badId = validateToolArguments('stardew_task', {
            operation: 'submit', requestId: '请求-1', contextToken: 'x'.repeat(32), title: 't', goal: 'g'
        });
        assert.equal(badId.ok, false);
    });

    it('只接受恰好一个 JSON 对象：尾随文本与多对象都拒绝', () => {
        const good = parseDecisionText(envelope({ kind: 'finish' }));
        assert.equal(good.ok, true);
        const trailing = parseDecisionText(`${envelope({ kind: 'finish' })}\n以上是本次决策。`);
        assert.equal(trailing.ok, false);
        const two = parseDecisionText(`${envelope({ kind: 'finish' })}${envelope({ kind: 'finish' })}`);
        assert.equal(two.ok, false);
        const truncated = parseDecisionText('{"schemaVersion":1,"kind":"act"');
        assert.equal(truncated.ok, false);
    });

    it('允许整体被 ```json 围栏包裹，但围栏外不得有解释', () => {
        const fenced = parseDecisionText('```json\n' + envelope({ kind: 'finish' }) + '\n```');
        assert.equal(fenced.ok, true);
        const chatty = parseDecisionText('这是决策：\n' + envelope({ kind: 'finish' }));
        assert.equal(chatty.ok, false);
    });

    it('finish/ask_main 不得夹带可执行工具', () => {
        const finishWithTool = validateDecisionEnvelope({
            schemaVersion: 1, kind: 'finish', observationId: 'obs_1', stepId: null,
            toolName: 'stardew_use', argumentsJson: '{}', plan: null,
            briefReason: '完成', evidenceIds: [], question: null
        });
        assert.equal(finishWithTool.ok, false);
        const askWithoutQuestion = validateDecisionEnvelope({
            schemaVersion: 1, kind: 'ask_main', observationId: 'obs_1', stepId: null,
            toolName: null, argumentsJson: null, plan: null,
            briefReason: '卡住', evidenceIds: [], question: null
        });
        assert.equal(askWithoutQuestion.ok, false);
    });

    it('argumentsJson 必须是 JSON 对象且不超过 8 KiB', () => {
        const huge = JSON.stringify({ padding: 'x'.repeat(9000) });
        const parsed = parseDecisionText(envelope({ kind: 'act', toolName: 'stardew_move', argumentsJson: huge }));
        assert.equal(parsed.ok, false);
        const array = parseDecisionText(envelope({ kind: 'act', toolName: 'stardew_move', argumentsJson: '[1,2]' }));
        assert.equal(array.ok, false);
    });

    it('observationId 必须是服务端格式的 ID', () => {
        const bad = validateDecisionEnvelope({
            schemaVersion: 1, kind: 'finish', observationId: 'not an id ', stepId: null,
            toolName: null, argumentsJson: null, plan: null,
            briefReason: '完成', evidenceIds: [], question: null
        });
        assert.equal(bad.ok, false);
    });
});

describe('完成判定：缺格与未决动作不能算成功', () => {
    const criteria = [{ kind: 'crop_tiles_watered' as const, location: 'Farm', tiles: [{ x: 64, y: 18 }, { x: 65, y: 18 }] }];

    it('只有一格被观察时是 unverifiable，不能推断整片已浇完', () => {
        const result = evaluateCriteria(criteria, {
            tileObservations: new Map([['Farm,64,18', { hasCrop: true, watered: true, season: 'spring', day: 3, year: 1, observedAtMs: 1_000 }]]),
            latest: { snapshot: snapshot(), observedAtMs: 1_000 },
            scopeMatchesWorld: true,
            unresolvedActionIds: [],
            nowMs: 2_000,
            evidenceMaxAgeMs: 60_000
        });
        assert.equal(result.results[0]?.status, 'unverifiable');
        assert.equal(result.allMet, false);
    });

    it('两格同日观察且 watered 才 met；无作物不算满足', () => {
        const stamp = { hasCrop: true, watered: true, season: 'spring', day: 3, year: 1, observedAtMs: 1_000 };
        const result = evaluateCriteria(criteria, {
            tileObservations: new Map([['Farm,64,18', stamp], ['Farm,65,18', stamp]]),
            latest: { snapshot: snapshot(), observedAtMs: 1_000 },
            scopeMatchesWorld: true,
            unresolvedActionIds: [],
            nowMs: 2_000,
            evidenceMaxAgeMs: 60_000
        });
        assert.equal(result.allMet, true);
        const noCrop = evaluateCriteria(criteria, {
            tileObservations: new Map([
                ['Farm,64,18', { ...stamp, hasCrop: false }],
                ['Farm,65,18', stamp]
            ]),
            latest: { snapshot: snapshot(), observedAtMs: 1_000 },
            scopeMatchesWorld: true,
            unresolvedActionIds: [],
            nowMs: 2_000,
            evidenceMaxAgeMs: 60_000
        });
        assert.equal(noCrop.allMet, false);
    });

    it('存在未决动作时不得 verified completed', () => {
        const stamp = { hasCrop: true, watered: true, season: 'spring', day: 3, year: 1, observedAtMs: 1_000 };
        const result = evaluateCriteria(criteria, {
            tileObservations: new Map([['Farm,64,18', stamp], ['Farm,65,18', stamp]]),
            latest: { snapshot: snapshot(), observedAtMs: 1_000 },
            scopeMatchesWorld: true,
            unresolvedActionIds: ['dx-unknown-1'],
            nowMs: 2_000,
            evidenceMaxAgeMs: 60_000
        });
        assert.equal(result.allMet, false);
    });

    it('manual_review 只生成候选，不算机器验证', () => {
        const result = evaluateCriteria([{ kind: 'manual_review', note: '看起来完成了' }], {
            tileObservations: new Map(),
            latest: { snapshot: snapshot(), observedAtMs: 1_000 },
            scopeMatchesWorld: true,
            unresolvedActionIds: [],
            nowMs: 2_000,
            evidenceMaxAgeMs: 60_000
        });
        assert.equal(result.allMet, false);
        assert.equal(result.manualOnly, true);
    });
});
