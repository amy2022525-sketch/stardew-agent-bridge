/**
 * DEC-005 的配置/凭据纯逻辑断言：默认关闭、CAS 由 store 负责、custom 政策保护、
 * 端点结构与私密凭据的只写语义。不启动 Bridge、不访问网络。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DecisionConfigStore, DecisionSecretStore, dataPaths, defaultDecisionConfig, normalizeConfig } from '@sab/server';
import type { DecisionProviderEntry } from '@sab/server';

const areas: string[] = [];
afterEach(() => { for (const area of areas.splice(0)) rmSync(area, { recursive: true, force: true }); });

function tempPaths() {
    const area = mkdtempSync(path.join(os.tmpdir(), 'sab-decision-config-'));
    areas.push(area);
    const paths = dataPaths(area);
    // 与 Bridge 的 ensureDirs 一致：私密子目录先存在，原子写入才有目标目录。
    mkdirSync(paths.decisionRoot, { recursive: true });
    return paths;
}

// 显式标注类型：否则 protocol/decisionFormat 会被推断成 string，无法用于需要枚举的 API。
const provider: DecisionProviderEntry = {
    id: 'local-executor',
    label: '本地执行模型',
    protocol: 'openai-chat-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    authMode: 'none',
    secretRef: null,
    decisionFormat: 'json_schema',
    maxOutputParameter: 'max_completion_tokens',
    timeoutMs: 30000,
    maxOutputTokens: 2048,
    allowPrivateNetwork: true,
    allowPlainHttp: true
};

describe('决策配置：默认值与权限边界', () => {
    it('默认关闭、revision 0、没有 provider 与授权客户端', () => {
        const config = defaultDecisionConfig();
        assert.equal(config.enabled, false);
        assert.equal(config.configRevision, 0);
        assert.equal(config.defaultProviderId, null);
        assert.deepEqual(config.providers, []);
        assert.deepEqual(config.authorizedClientIds, []);
        assert.equal(config.maxConcurrentTasks, 1);
        assert.equal(config.multiplayerAutomation, 'disabled');
        assert.equal(config.resumeAfterRestart, false);
    });

    it('启用但没有默认 provider 被拒绝', () => {
        assert.throws(() => normalizeConfig({ ...defaultDecisionConfig(), enabled: true }), /PROVIDER_NOT_CONFIGURED|默认执行模型/);
    });

    it('内部身份命名空间不能出现在授权名单', () => {
        assert.throws(() => normalizeConfig({
            ...defaultDecisionConfig(),
            authorizedClientIds: ['sab-internal-decision:tester']
        }), /内部|INVALID_ARGUMENT/);
    });

    it('联机自动化与重启续跑不能被打开', () => {
        assert.throws(() => normalizeConfig({ ...defaultDecisionConfig(), multiplayerAutomation: 'enabled' }), /联机|disabled/);
        assert.throws(() => normalizeConfig({ ...defaultDecisionConfig(), resumeAfterRestart: true }), /resumeAfterRestart|false/);
    });

    it('端点拒绝 userinfo/query/fragment 与未声明的明文 HTTP', () => {
        const base = { ...defaultDecisionConfig(), enabled: true, defaultProviderId: 'local-executor' };
        const bad = (patch: Record<string, unknown>) => ({ ...base, providers: [{ ...provider, ...patch }] });
        assert.throws(() => normalizeConfig(bad({ baseUrl: 'http://user:pass@127.0.0.1:1234/v1' })), /用户名|密码|userinfo/);
        assert.throws(() => normalizeConfig(bad({ baseUrl: 'http://127.0.0.1:1234/v1?key=1' })), /query|fragment/i);
        assert.throws(() => normalizeConfig(bad({ baseUrl: 'file:///tmp/model' })), /http/);
        assert.throws(() => normalizeConfig(bad({ allowPlainHttp: false })), /明文|HTTP/);
    });

    it('bearer 必须有 secretRef，none 不能携带 secretRef', () => {
        const base = { ...defaultDecisionConfig(), enabled: true, defaultProviderId: 'local-executor' };
        assert.throws(() => normalizeConfig({ ...base, providers: [{ ...provider, authMode: 'bearer' }] }), /secretRef|凭据/);
        assert.throws(() => normalizeConfig({ ...base, providers: [{ ...provider, secretRef: 'leaked' }] }), /none|secretRef/);
    });

    it('custom 政策不能开启没有已实现保护的高影响工具', () => {
        const base = { ...defaultDecisionConfig() };
        assert.throws(() => normalizeConfig({
            ...base,
            customPolicies: [{ id: 'buy-all', label: '购物', allowedTools: ['stardew_buy'], allowedLocations: [], toolRestrictions: {}, budgetCaps: {} }]
        }), /stardew_buy|保护/);
        assert.throws(() => normalizeConfig({
            ...base,
            customPolicies: [{ id: 'use-any', label: '通用使用', allowedTools: ['stardew_use'], allowedLocations: [], toolRestrictions: {}, budgetCaps: {} }]
        }), /waterOnly|保护/);
        const ok = normalizeConfig({
            ...base,
            customPolicies: [{
                id: 'eat-carrot', label: '只吃胡萝卜', allowedTools: ['stardew_eat'],
                allowedLocations: ['Farm'],
                toolRestrictions: { stardew_eat: { allowedItemIds: ['(O)24'], maxCountPerAction: 1 } },
                budgetCaps: { maxGoldSpend: 0 }
            }]
        });
        assert.equal(ok.customPolicies.length, 1);
    });

    it('全局预算只能更严，超过硬上限会被压到上限', () => {
        const config = normalizeConfig({
            ...defaultDecisionConfig(),
            limits: { maxModelCalls: 9999, maxWriteActions: 9999, maxActiveMs: 99999999, maxAccountedTokens: 99999999, maxHttpAttempts: 9999 }
        });
        assert.equal(config.limits.maxModelCalls, 60);
        assert.equal(config.limits.maxWriteActions, 80);
        assert.equal(config.limits.maxActiveMs, 600000);
        assert.equal(config.limits.maxAccountedTokens, 120000);
        assert.equal(config.limits.maxHttpAttempts, 60);
    });
});

describe('配置存储与凭据', () => {
    it('未创建文件时 revision=0；保存后 revision+1 且以当前配置为底合并', () => {
        const paths = tempPaths();
        const store = new DecisionConfigStore(paths);
        assert.equal(store.revision, 0);
        assert.equal(store.current.enabled, false);

        const first = store.save({
            enabled: true,
            defaultProviderId: 'local-executor',
            providers: [provider],
            authorizedClientIds: ['tester'],
            clientLimits: { tester: { providerIds: ['local-executor'] } }
        }, 0);
        assert.equal(first.configRevision, 1);
        assert.equal(first.enabled, true);

        const second = store.save({ enabled: false }, 1);
        assert.equal(second.configRevision, 2);
        assert.equal(second.enabled, false);
        // 只提交 enabled 时，providers/clientLimits 不能被重置。
        assert.equal(second.providers.length, 1);
        assert.deepEqual(Object.keys(second.clientLimits), ['tester']);
        assert.throws(() => store.save({ enabled: false }, 1), /冲突|REVISION/);
    });

    it('凭据只写不回显：set/has/authorizationHeader/clear', () => {
        const paths = tempPaths();
        const secrets = new DecisionSecretStore(paths);
        const entry = { ...provider, authMode: 'bearer' as const, secretRef: 'local-executor' };
        assert.equal(secrets.has('local-executor'), false);
        assert.equal(secrets.authorizationHeader(entry), null);
        const result = secrets.set('local-executor', 'test-secret-value');
        assert.deepEqual(result, { configured: true });
        assert.equal(secrets.has('local-executor'), true);
        assert.equal(secrets.authorizationHeader(entry), 'Bearer test-secret-value');
        if (process.platform !== 'win32') {
            assert.equal(statSync(paths.decisionSecrets).mode & 0o777, 0o600, '凭据文件必须是 0600');
        }
        assert.deepEqual(secrets.clear('local-executor'), { configured: false });
        assert.equal(secrets.has('local-executor'), false);
    });

    it('authMode=none 显式返回 null，不把缺 Key 当匿名调用', () => {
        const paths = tempPaths();
        const secrets = new DecisionSecretStore(paths);
        assert.equal(secrets.authorizationHeader({ ...provider, authMode: 'none' }), null);
    });
});
