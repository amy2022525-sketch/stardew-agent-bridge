/**
 * DEC-016/DEC-018 的 HTTP 层断言：状态/配置 CAS/凭据不回显/任务工具路由/旧 Mod 身份降级。
 * 使用真实 Bridge + MockMod，但不访问真实模型服务、不产生游戏动作。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { startStack, type Stack } from './helpers.js';

const stacks: Stack[] = [];
after(async () => { for (const stack of stacks) await stack.stop(); });

const provider = {
    id: 'local-executor',
    label: '本地测试执行模型',
    protocol: 'openai-chat-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    authMode: 'none',
    secretRef: null,
    decisionFormat: 'json_schema',
    maxOutputParameter: 'max_completion_tokens',
    timeoutMs: 5000,
    maxOutputTokens: 512,
    allowPrivateNetwork: true,
    allowPlainHttp: true
};

function prepareConfig(overrides: Record<string, unknown> = {}) {
    return (dataDir: string): void => {
        const dir = path.join(dataDir, 'decision');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            schemaVersion: 1,
            enabled: true,
            defaultProviderId: 'local-executor',
            defaultPolicyId: 'farm-care',
            providers: [provider],
            authorizedClientIds: ['tester'],
            profiles: [{ id: 'default', label: '默认分组' }],
            activeProfileId: 'default',
            limits: { maxModelCalls: 20, maxWriteActions: 30, maxActiveMs: 600000, maxAccountedTokens: 120000, maxHttpAttempts: 20 },
            clientLimits: { tester: { providerIds: ['local-executor'] } },
            ...overrides
        }), 'utf8');
    };
}

async function session(stack: Stack) {
    const base = `http://127.0.0.1:${stack.bridgePort}`;
    const response = await fetch(`${base}/api/v1/session`);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await response.json() as { csrfToken: string };
    const request = (route: string, init: RequestInit = {}) => fetch(base + route, {
        ...init,
        headers: { cookie, origin: base, 'content-type': 'application/json', 'x-sab-csrf': csrfToken, ...(init.headers ?? {}) }
    });
    return { base, cookie, csrfToken, request };
}

describe('决策 Web API：默认关闭与配置 CAS', () => {
    it('旧凭据文件里的 web/内部身份也不能作为 Bearer 登录', async () => {
        const stack = await startStack();
        stacks.push(stack);
        const filename = path.join(stack.dataDir, 'credentials.json');
        const credentials = JSON.parse(readFileSync(filename, 'utf8')) as { clients: Record<string, unknown> };
        for (const id of ['web', 'sab-internal-decision:legacy']) {
            credentials.clients[id] = { clientId: id, clientName: 'legacy reserved identity', token: 'synthetic-reserved-token-' + id, createdAt: new Date().toISOString() };
        }
        writeFileSync(filename, JSON.stringify(credentials), 'utf8');
        for (const id of ['web', 'sab-internal-decision:legacy']) {
            assert.equal(stack.bridge.auth.verifyBearer('Bearer synthetic-reserved-token-' + id), null);
        }
        assert.equal(stack.bridge.auth.verifyBearer('Bearer ' + stack.token)?.clientId, 'tester');
    });
    it('全新数据根默认关闭，不创建任务库或密钥', async () => {
        const stack = await startStack();
        stacks.push(stack);
        const { request } = await session(stack);
        const status = await request('/api/v1/decision/status');
        assert.equal(status.status, 200);
        const body = await status.json() as { enabled: boolean; health: string; providerConfigured: boolean; bootId: string; activeTaskId: string | null };
        assert.equal(body.enabled, false);
        assert.equal(body.health, 'disabled');
        assert.equal(body.providerConfigured, false);
        assert.equal(body.activeTaskId, null);
        assert.match(body.bootId, /^[0-9a-f-]{36}$/);
        const config = await (await request('/api/v1/decision/config')).json() as { configRevision: number; providers: unknown[]; enabled: boolean };
        assert.equal(config.configRevision, 0);
        assert.deepEqual(config.providers, []);
        assert.equal(config.enabled, false);
    });

    it('配置视图不回显密钥，revision 冲突返回 409，未提交的 clientLimits 被保留', async () => {
        const stack = await startStack({ prepareDataDir: prepareConfig() });
        stacks.push(stack);
        const { request } = await session(stack);

        const status = await (await request('/api/v1/decision/status')).json() as { enabled: boolean; providerConfigured: boolean; health: string };
        assert.equal(status.enabled, true);
        assert.equal(status.providerConfigured, true, 'authMode=none 视为已配置');
        assert.equal(status.health, 'ok');

        const view = await (await request('/api/v1/decision/config')).json() as {
            configRevision: number;
            providers: { id: string; baseUrl: string; hasSecret: boolean; authMode: string }[];
        };
        assert.equal(view.configRevision, 1);
        assert.equal(view.providers[0]?.baseUrl, provider.baseUrl);
        assert.equal(view.providers[0]?.hasSecret, false);
        assert.equal('secret' in (view.providers[0] as object), false, '响应不得包含任何 secret 字段');

        const conflict = await request('/api/v1/decision/config', {
            method: 'PUT',
            body: JSON.stringify({ expectedRevision: 0, config: { enabled: true } })
        });
        assert.equal(conflict.status, 409);

        const updated = await request('/api/v1/decision/config', {
            method: 'PUT',
            body: JSON.stringify({
                expectedRevision: 1,
                config: {
                    enabled: true,
                    defaultProviderId: 'local-executor',
                    defaultPolicyId: 'farm-care',
                    providers: [provider],
                    authorizedClientIds: ['tester']
                    // 故意不提交 clientLimits/profiles/sharing：服务端必须保留旧值。
                }
            })
        });
        assert.equal(updated.status, 200);
        const next = await updated.json() as { configRevision: number };
        assert.equal(next.configRevision, 2);

        const raw = JSON.parse(readFileSync(path.join(stack.dataDir, 'decision', 'config.json'), 'utf8')) as {
            clientLimits?: Record<string, unknown>;
            profiles?: { id: string }[];
        };
        assert.deepEqual(Object.keys(raw.clientLimits ?? {}), ['tester'], '未提交的 clientLimits 不能被重置');
        assert.equal(raw.profiles?.[0]?.id, 'default', '未提交的 profiles 不能被重置');
    });

    it('Bearer 令牌不能调用 provider/secret 管理接口', async () => {
        const stack = await startStack({ prepareDataDir: prepareConfig() });
        stacks.push(stack);
        const response = await fetch(`http://127.0.0.1:${stack.bridgePort}/api/v1/decision/config`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${stack.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 1, config: { enabled: false } })
        });
        assert.ok(response.status === 401 || response.status === 403, `期望 401/403，实际 ${response.status}`);
    });
});

describe('任务工具路由与旧 Mod 身份降级', () => {
    it('旧 Mod 没有 worldIdentity：context 只给临时作用域，持久派单被明确拒绝', async () => {
        const stack = await startStack({ prepareDataDir: prepareConfig() });
        stacks.push(stack);
        const base = `http://127.0.0.1:${stack.bridgePort}`;
        const call = async (tool: string, args: Record<string, unknown>) => {
            const response = await fetch(`${base}/api/v1/tool/${tool}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${stack.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(args)
            });
            return await response.json() as { isError: boolean; text: string; structured?: Record<string, unknown> };
        };

        const context = await call('stardew_context', { operation: 'current' });
        assert.equal(context.isError, false, context.text);
        const info = (context.structured as { context: { contextToken: string | null; scopeModeOptions: string[] } }).context;
        assert.ok(info.contextToken, '在线且已授权时应签发短期 token');
        assert.deepEqual(info.scopeModeOptions, ['ephemeral'], '旧 Mod 只允许临时作用域');

        const rejected = await call('stardew_task', {
            operation: 'submit',
            requestId: 'api-persist-1',
            contextToken: info.contextToken,
            title: '持久任务',
            goal: '验证旧 Mod 下持久派单被拒绝',
            providerId: 'local-executor',
            policyId: 'farm-care',
            scopeMode: 'persistent'
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.text, /WORLD_IDENTITY_UNAVAILABLE/);

        const status = await (await fetch(`${base}/api/v1/decision/status`, {
            headers: { cookie: (await session(stack)).cookie }
        })).json() as { activeTaskId: string | null };
        assert.equal(status.activeTaskId, null, '被拒绝的派单不得占执行槽');
    });
});
