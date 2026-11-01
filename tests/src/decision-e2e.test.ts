/**
 * 端到端接线：真实 Bridge + Mock Mod + 本地假模型 HTTP 服务。
 *
 * 覆盖单元测试之间的缝隙：Web/MCP 工具路由 → TaskService → Runner →
 * DecisionGamePort → ActionService/账本 → Mock Mod 动作 → 新观察 → 完成判定。
 *
 * 不访问真实模型、不启动游戏、不产生费用；假模型只返回固定的 DecisionEnvelope。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { startStack, type Stack } from './helpers.js';

const stacks: Stack[] = [];
const servers: Server[] = [];
after(async () => {
    for (const stack of stacks.splice(0)) await stack.stop();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface DecisionScript {
    kind: 'plan' | 'act';
    stepId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
}

/** 本地假模型：按脚本顺序返回 DecisionEnvelope，并从上下文里回填本轮 observationId。 */
async function startFakeModel(script: DecisionScript[], options: { onCall?: () => void; delayMs?: number; probeOk?: boolean } = {}): Promise<{ baseUrl: string; calls: () => number }> {
    let index = 0;
    const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            let contextJson = '{}';
            try {
                const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
                contextJson = body.messages?.find((message) => message.role === 'user')?.content ?? '{}';
            } catch {
                /* 保持空上下文：下面的断言会因缺少 observationId 失败 */
            }
            const context = JSON.parse(contextJson) as { probe?: boolean; state?: { observationId?: string }; snapshot?: { entities?: { ref: string }[] } };
            const observationId = context.state?.observationId ?? '';
            const step = script[Math.min(index, script.length - 1)];
            index += 1;
            options.onCall?.();
            const args = { ...step?.args };
            if (typeof args['target'] === 'string') {
                const suffix = /:e[456]$/.exec(args['target'])?.[0];
                args['target'] = context.snapshot?.entities?.find(entity => suffix && entity.ref.endsWith(suffix))?.ref ?? args['target'];
            }
            const decision = step?.kind === 'plan'
                ? {
                    schemaVersion: 1,
                    kind: 'plan',
                    observationId,
                    stepId: null,
                    toolName: null,
                    argumentsJson: null,
                    plan: [{ stepId: step.stepId ?? 'step_water', title: '浇水', doneWhen: '两格作物均已浇水' }],
                    briefReason: '先规划两格作物',
                    evidenceIds: [],
                    question: null
                }
                : {
                    schemaVersion: 1,
                    kind: 'act',
                    observationId,
                    stepId: step?.stepId ?? 'step_water',
                    toolName: step?.toolName ?? 'stardew_use',
                    argumentsJson: JSON.stringify(args),
                    plan: null,
                    briefReason: '执行浇水',
                    evidenceIds: [],
                    question: null
                };
            res.writeHead(200, { 'content-type': 'application/json' });
            const body = JSON.stringify({
                id: 'fake-completion',
                object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(context.probe ? { ok: options.probeOk ?? true } : decision) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }
            });
            if (options.delayMs) setTimeout(() => res.end(body), options.delayMs);
            else res.end(body);
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, calls: () => index };
}

function prepareDecisionConfig(modelBaseUrl: string) {
    return (dataDir: string): void => {
        const dir = path.join(dataDir, 'decision');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            schemaVersion: 1,
            enabled: true,
            defaultProviderId: 'fake-e2e',
            defaultPolicyId: 'farm-care',
            providers: [{
                id: 'fake-e2e',
                label: '本地假模型',
                protocol: 'openai-chat-compatible',
                baseUrl: modelBaseUrl,
                model: 'fake-model',
                authMode: 'none',
                secretRef: null,
                decisionFormat: 'json_object',
                maxOutputParameter: 'max_completion_tokens',
                timeoutMs: 5_000,
                maxOutputTokens: 512,
                allowPrivateNetwork: true,
                allowPlainHttp: true
            }],
            authorizedClientIds: ['tester'],
            profiles: [{ id: 'default', label: '默认分组' }],
            activeProfileId: 'default',
            limits: { maxModelCalls: 12, maxWriteActions: 12, maxActiveMs: 120_000, maxAccountedTokens: 50_000, maxHttpAttempts: 12 }
        }), 'utf8');
    };
}

async function tool(stack: Stack, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; structured?: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${String(stack.bridgePort)}/api/v1/tool/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${stack.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args)
    });
    return await response.json() as { isError: boolean; text: string; structured?: Record<string, unknown> };
}

interface TaskSnapshot {
    state: string;
    phase: string;
    completion: { evidenceLevel: string } | null;
    blocker: { summary: string } | null;
    budgetUsed?: { modelCalls: number; writeActions: number; accountedTokens: number };
}

async function waitForTask(stack: Stack, taskId: string): Promise<TaskSnapshot> {
    const deadline = Date.now() + 20_000;
    for (;;) {
        const result = await tool(stack, 'stardew_task_status', { operation: 'get', taskId });
        const view = (result.structured as { view?: { task: TaskSnapshot } } | undefined)?.view?.task;
        if (view && (view.state === 'completed' || view.state === 'failed' || view.state === 'needs_review' || view.state === 'waiting_main')) return view;
        if (Date.now() > deadline) throw new Error(`等待任务结束超时；最后状态：${JSON.stringify(view ?? result)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe('决策执行器端到端（Bridge + Mock Mod + 假模型）', () => {
    for (const expected of [true, false]) it(`Web 模型检测 ${expected ? '有效' : '无效'} JSON：有明确结果且不执行游戏动作`, async () => {
        const model = await startFakeModel([], { probeOk: expected });
        const stack = await startStack({ prepareDataDir: prepareDecisionConfig(model.baseUrl) });
        stacks.push(stack);
        assert.equal(model.calls(), 0, '打开/配置服务不应自动请求模型');
        const base = `http://127.0.0.1:${stack.bridgePort}`;
        const sessionResponse = await fetch(base + '/api/v1/session');
        const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
        const session = await sessionResponse.json() as { csrfToken: string };
        const response = await fetch(base + '/api/v1/decision/providers/fake-e2e/probe', {
            method: 'POST', headers: { cookie, origin: base, 'x-sab-csrf': session.csrfToken }
        });
        const result = await response.json() as { ok: boolean; error?: { code: string } };
        assert.equal(response.status, 200);
        assert.equal(result.ok, expected);
        if (!expected) assert.equal(result.error?.code, 'DECISION_OUTPUT_INVALID');
        assert.equal(model.calls(), 1);
        for (const command of ['select', 'use', 'move']) assert.equal(stack.mod.commandCount(command), 0);
    });
    it('派单 → 规划 → 选壶 → 浇两格 → 机器验证完成，且任务工具不转发给 Mod', async () => {
        const model = await startFakeModel([
            { kind: 'plan', stepId: 'step_water' },
            { kind: 'act', toolName: 'stardew_select', args: { slot: 3 } },
            { kind: 'act', toolName: 'stardew_use', args: { target: '@s1:e4' } },
            { kind: 'act', toolName: 'stardew_use', args: { target: '@s1:e5' } }
        ]);
        const stack = await startStack({ prepareDataDir: prepareDecisionConfig(model.baseUrl) });
        stack.mod.nativeCropRefs = true;
        stacks.push(stack);

        const context = await tool(stack, 'stardew_context', { operation: 'current' });
        assert.equal(context.isError, false, context.text);
        const info = (context.structured as { context: { contextToken: string | null; scopeModeOptions: string[] } }).context;
        assert.ok(info.contextToken, '在线且已授权时应签发 token');

        const submitted = await tool(stack, 'stardew_task', {
            operation: 'submit',
            requestId: 'e2e-submit-1',
            contextToken: info.contextToken,
            title: '浇好农舍旁的两格作物',
            goal: '给 (13,12) 与 (14,12) 的作物浇水',
            providerId: 'fake-e2e',
            policyId: 'farm-care',
            scopeMode: 'ephemeral',
            constraints: { locations: ['Farm'] },
            successCriteria: [{ kind: 'crop_tiles_watered', location: 'Farm', tiles: [{ x: 13, y: 12 }, { x: 14, y: 12 }] }],
            budget: { maxModelCalls: 12, maxWriteActions: 12, maxActiveMs: 120_000, maxAccountedTokens: 50_000 }
        });
        assert.equal(submitted.isError, false, submitted.text);
        const accepted = (submitted.structured as { result?: { taskId?: string; accepted?: boolean } } | undefined)?.result ?? {};
        assert.equal(accepted.accepted, true);
        assert.ok(accepted.taskId);

        const task = await waitForTask(stack, accepted.taskId);
        assert.equal(task.state, 'completed', `未完成：${task.blocker?.summary ?? ''}`);
        assert.equal(task.completion?.evidenceLevel, 'verified_observation', '完成必须来自机器观察');
        // 用量必须在运行中/结束时都能从任务行读到（不是永远 0）。
        assert.ok((task.budgetUsed?.modelCalls ?? 0) >= 4, '模型调用次数应被持久化');
        assert.ok((task.budgetUsed?.writeActions ?? 0) >= 3, '选壶 + 两次浇水都应计入写动作');

        // 真实动作经过 Mod：选壶 + 两次 use；任务工具一个都没有转发给 Mod。
        assert.ok(stack.mod.commandCount('select') >= 1, '应选择水壶');
        const uses = stack.mod.requests.filter((request) => request.command === 'use');
        assert.deepEqual(
            uses.map((request) => String(request.args['target']).replace(/^@s\d+:/, '@s:')).sort(),
            ['@s:e4', '@s:e5'],
            '只应浇两格已观察作物'
        );
        assert.equal(stack.mod.commandCount('task'), 0, '任务工具不能被转发给 Mod');
        assert.equal(stack.mod.commandCount('context'), 0, '上下文工具不能被转发给 Mod');
        assert.ok(model.calls() >= 4, '规划 + 选壶 + 两次浇水各一次模型调用');
    });

    it('原生 soil + 动态 ref：空水壶补水后浇水，且补水经过同一动作账本', async () => {
        const model = await startFakeModel([
            { kind: 'act', toolName: 'stardew_select', args: { slot: 3 } },
            { kind: 'act', toolName: 'stardew_use', args: { target: '@s1:e6' } },
            { kind: 'act', toolName: 'stardew_use', args: { target: '@s1:e4' } },
            { kind: 'act', toolName: 'stardew_use', args: { target: '@s1:e5' } }
        ]);
        const stack = await startStack({ prepareDataDir: prepareDecisionConfig(model.baseUrl) });
        stacks.push(stack);
        stack.mod.nativeCropRefs = true;
        stack.mod.wateringCanWater = 0;
        const context = await tool(stack, 'stardew_context', { operation: 'current' });
        const token = (context.structured as { context: { contextToken: string } }).context.contextToken;
        const submitted = await tool(stack, 'stardew_task', {
            operation: 'submit', requestId: 'e2e-refill', contextToken: token,
            title: '补水后浇两格', goal: '只使用水壶补水和浇水', scopeMode: 'ephemeral', policyId: 'farm-care',
            successCriteria: [{ kind: 'crop_tiles_watered', location: 'Farm', tiles: [{ x: 13, y: 12 }, { x: 14, y: 12 }] }]
        });
        assert.equal(submitted.isError, false, submitted.text);
        const taskId = (submitted.structured as { result: { taskId: string } }).result.taskId;
        const completed = await waitForTask(stack, taskId);
        assert.equal(completed.state, 'completed', completed.blocker?.summary);
        const targets = stack.mod.requests.filter(request => request.command === 'use').map(request => String(request.args['target']).replace(/^@s\d+:/, '@s:'));
        assert.deepEqual(targets, ['@s:e6', '@s:e4', '@s:e5']);
        assert.equal(stack.mod.wateringCanWater, 38);
        assert.equal(completed.completion?.evidenceLevel, 'verified_observation');
    });

    it('模型回答期间撤销 Bearer 注册：旧任务不得继续调用或写游戏', async () => {
        let revoke = (): void => {};
        const model = await startFakeModel([{ kind: 'act', toolName: 'stardew_select', args: { slot: 3 } }], { onCall: () => revoke() });
        const stack = await startStack({ prepareDataDir: prepareDecisionConfig(model.baseUrl) });
        stacks.push(stack);
        revoke = () => stack.bridge.auth.revoke('tester');
        const context = await tool(stack, 'stardew_context', { operation: 'current' });
        const token = (context.structured as { context: { contextToken: string } }).context.contextToken;
        const submitted = await tool(stack, 'stardew_task', {
            operation: 'submit', requestId: 'e2e-revoked', contextToken: token,
            title: '撤销中的任务', goal: '检验注销的客户端不会继续控制游戏', scopeMode: 'ephemeral', policyId: 'farm-care'
        });
        assert.equal(submitted.isError, false, submitted.text);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(model.calls(), 1);
        assert.equal(stack.mod.commandCount('select'), 0);
        assert.equal(stack.mod.commandCount('use'), 0);
    });
});
