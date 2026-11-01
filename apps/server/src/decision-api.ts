/**
 * Web 管理接口（§18）：`/api/v1/decision/*`。
 *
 * - 只接受已认证网页会话；写操作由 Bridge 先行校验 Origin 与 CSRF。
 * - Bearer MCP 客户端不能调用 provider/secret 管理接口。
 * - 密钥写入只返回 configured:true；响应与日志永不包含明文。
 * - 打开网页、保存配置、doctor 都不自动调用收费模型；probe 必须由用户点击。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    BridgeError,
    MAX_REQUEST_BYTES,
    TASK_LIST_MAX_LIMIT,
    isTaskState,
    type DecisionStatusView,
    type TaskState
} from '@sab/contracts';
import {
    createDecisionProvider,
    newDecisionId,
    type ContextTokenStore,
    type DecisionStore,
    type TaskQueryService,
    type TaskService,
    type DecisionProvider,
    type Principal
} from '@sab/decision-core';
import type { DecisionConfigStore } from './decision-config.js';
import { policyViewOf } from './decision-config.js';
import type { DecisionSecretStore } from './decision-secrets.js';
import type { DecisionGamePort } from './decision-game-port.js';
import type { DecisionMemoryService } from './decision-memory.js';
import { readBody, sendJson } from './http-util.js';

export interface DecisionApiDeps {
    config: DecisionConfigStore;
    secrets: DecisionSecretStore;
    service: TaskService;
    query: TaskQueryService;
    memory: DecisionMemoryService;
    tokens: ContextTokenStore;
    game: DecisionGamePort;
    store: DecisionStore;
    bootId: string;
    enabled: () => boolean;
    stopLatched: () => { latched: boolean; reason: string | null };
    arm: (reason: string) => void;
    pauseForConfigChange: (reason: string) => string[];
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

// Web 是本地管理员会话：可查看/暂停/取消任意 Agent 的任务（仍受同一状态机与证据规则约束）。
const WEB_PRINCIPAL: Principal = { clientId: 'web', clientName: 'Web 控制台（人工）', transport: 'web', admin: true };

export class DecisionApi {
    constructor(private readonly deps: DecisionApiDeps) {}

    /** 返回 true 表示已处理该路径。 */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
        const pathname = url.pathname;
        if (!pathname.startsWith('/api/v1/decision/')) return false;
        const method = (req.method ?? 'GET').toUpperCase();
        const tail = pathname.slice('/api/v1/decision/'.length);
        try {
            if (tail === 'status' && method === 'GET') {
                sendJson(res, 200, this.status());
                return true;
            }
            if (tail === 'config' && method === 'GET') {
                sendJson(res, 200, this.deps.config.view((ref) => this.deps.config.current.providers.some((entry) => entry.secretRef === ref && this.deps.secrets.hasProvider(entry))));
                return true;
            }
            if (tail === 'config' && method === 'PUT') {
                const body = await this.readJson(req);
                const expectedRevision = Number(body['expectedRevision']);
                if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
                    throw new BridgeError('INVALID_ARGUMENT', 'expectedRevision 必须是非负整数。');
                }
                const input = (body['config'] ?? body) as unknown;
                const next = this.deps.config.save(input, expectedRevision);
                const paused = this.deps.pauseForConfigChange('配置已更新，进行中的自动任务已暂停');
                sendJson(res, 200, { ...this.deps.config.view((ref) => this.deps.config.current.providers.some((entry) => entry.secretRef === ref && this.deps.secrets.hasProvider(entry))), pausedTaskIds: paused, configRevision: next.configRevision });
                return true;
            }
            const secretMatch = /^providers\/([A-Za-z0-9][A-Za-z0-9._:-]{0,79})\/secret$/.exec(tail);
            if (secretMatch) {
                const providerId = secretMatch[1] as string;
                const provider = this.deps.config.current.providers.find((entry) => entry.id === providerId);
                if (!provider || !provider.secretRef) throw new BridgeError('NOT_FOUND', '该 provider 没有可管理的凭据。');
                if (method === 'POST') {
                    const body = await this.readJson(req);
                    const value = typeof body['value'] === 'string' ? body['value'] : '';
                    this.deps.secrets.set(provider.secretRef, value);
                    const paused = this.deps.pauseForConfigChange('凭据已更新，进行中的自动任务已暂停');
                    sendJson(res, 200, { configured: true, providerId, pausedTaskIds: paused });
                    return true;
                }
                if (method === 'DELETE') {
                    this.deps.secrets.clear(provider.secretRef);
                    const paused = this.deps.pauseForConfigChange('凭据已清除，进行中的自动任务已暂停');
                    sendJson(res, 200, { configured: false, providerId, pausedTaskIds: paused });
                    return true;
                }
            }
            const probeMatch = /^providers\/([A-Za-z0-9][A-Za-z0-9._:-]{0,79})\/probe$/.exec(tail);
            if (probeMatch && method === 'POST') {
                const providerId = probeMatch[1] as string;
                sendJson(res, 200, await this.probe(providerId));
                return true;
            }
            if (tail === 'arm' && method === 'POST') {
                this.deps.arm('web_arm');
                sendJson(res, 200, { ok: true, stopLatched: false, note: '已允许自动执行；恢复旧任务仍需显式 resume。' });
                return true;
            }
            if (tail === 'tasks' && method === 'GET') {
                const stateParam = url.searchParams.get('state');
                const state: TaskState | null = stateParam && isTaskState(stateParam) ? stateParam : null;
                const limit = Math.min(TASK_LIST_MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20));
                const page = this.deps.query.list(WEB_PRINCIPAL, { cursor: url.searchParams.get('cursor'), limit, state });
                sendJson(res, 200, { schemaVersion: 1, ...page });
                return true;
            }
            if (tail === 'tasks' && method === 'POST') {
                const body = await this.readJson(req);
                const contextToken = typeof body['contextToken'] === 'string' && body['contextToken'].length > 0
                    ? body['contextToken']
                    : this.issueWebToken();
                const result = await this.deps.service.submit(WEB_PRINCIPAL, {
                    requestId: typeof body['requestId'] === 'string' && body['requestId'].length > 0 ? body['requestId'] : newDecisionId('req'),
                    contextToken,
                    title: String(body['title'] ?? ''),
                    goal: String(body['goal'] ?? ''),
                    providerId: typeof body['providerId'] === 'string' ? body['providerId'] : undefined,
                    policyId: typeof body['policyId'] === 'string' ? body['policyId'] : undefined,
                    // 旧 Mod 没有稳定身份时，Web 派单默认退回临时作用域；显式 persistent 仍会被拒绝。
                    scopeMode: body['scopeMode'] === 'ephemeral'
                        ? 'ephemeral'
                        : body['scopeMode'] === 'persistent'
                            ? 'persistent'
                            : this.deps.game.latestWorldIdentity() ? 'persistent' : 'ephemeral',
                    constraints: (body['constraints'] ?? undefined) as never,
                    budget: (body['budget'] ?? undefined) as never,
                    successCriteria: (body['successCriteria'] ?? undefined) as never
                });
                sendJson(res, 200, result);
                return true;
            }
            const taskMatch = /^tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,79})(?:\/([a-z]+))?(?:\/(events))?$/.exec(tail);
            if (taskMatch) {
                const taskId = taskMatch[1] as string;
                const operation = taskMatch[2] ?? null;
                if (operation === null && method === 'GET') {
                    sendJson(res, 200, this.deps.query.get(WEB_PRINCIPAL, taskId));
                    return true;
                }
                if (operation === 'events' && method === 'GET') {
                    const after = Number(url.searchParams.get('after') ?? '0') || 0;
                    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50') || 50));
                    sendJson(res, 200, { events: this.deps.store.listEvents(taskId, after, limit) });
                    return true;
                }
                if (operation !== null && method === 'POST') {
                    sendJson(res, 200, await this.taskOperation(taskId, operation, await this.readJson(req)));
                    return true;
                }
                if (operation === null && method === 'DELETE') {
                    sendJson(res, 200, this.deps.service.archive(WEB_PRINCIPAL, taskId));
                    return true;
                }
            }
            if (tail === 'memories' && method === 'GET') {
                const taskId = url.searchParams.get('taskId');
                const query = url.searchParams.get('query') ?? '';
                const result = this.deps.memory.search(
                    { clientId: 'web', clientName: 'Web 控制台', admin: true },
                    { query, taskId: taskId ?? undefined, limit: Number(url.searchParams.get('limit') ?? '20') || 20 }
                );
                sendJson(res, 200, result);
                return true;
            }
            if (tail === 'memories' && method === 'POST') {
                const body = await this.readJson(req);
                const record = this.deps.memory.add(
                    { clientId: 'web', clientName: 'Web 控制台', admin: true },
                    {
                        title: String(body['title'] ?? ''),
                        content: String(body['content'] ?? ''),
                        kind: (body['kind'] ?? 'preference') as never,
                        sourceType: 'user',
                        // 玩家备注默认共享给同一 profile 的执行模型（否则写了也不会被用到）。
                        visibility: 'shared',
                        taskId: typeof body['taskId'] === 'string' ? body['taskId'] : undefined
                    }
                );
                sendJson(res, 200, { ok: true, memory: record });
                return true;
            }
            const memoryMatch = /^memories\/([A-Za-z0-9][A-Za-z0-9._:-]{0,79})$/.exec(tail);
            if (memoryMatch) {
                const memoryId = memoryMatch[1] as string;
                const principal = { clientId: 'web', clientName: 'Web 控制台', admin: true };
                if (method === 'PATCH') {
                    const body = await this.readJson(req);
                    const record = this.deps.memory.update(principal, memoryId, {
                        expectedRevision: Number(body['expectedRevision']),
                        title: typeof body['title'] === 'string' ? body['title'] : undefined,
                        content: typeof body['content'] === 'string' ? body['content'] : undefined
                    });
                    sendJson(res, 200, { ok: true, memory: record });
                    return true;
                }
                if (method === 'DELETE') {
                    const record = this.deps.memory.archive(principal, memoryId);
                    sendJson(res, 200, { ok: true, memory: record });
                    return true;
                }
            }
            sendJson(res, 404, { error: '未知的决策接口路径。' });
            return true;
        } catch (error) {
            const bridge = BridgeError.from(error);
            sendJson(res, statusOf(bridge.fault.code), { fault: bridge.fault });
            return true;
        }
    }

    // -----------------------------------------------------------------------
    private status(): DecisionStatusView {
        const config = this.deps.config.current;
        const latch = this.deps.stopLatched();
        const slot = this.deps.store.currentSlot();
        const provider = config.providers.find((entry) => entry.id === config.defaultProviderId) ?? null;
        const providerConfigured = provider !== null && (provider.authMode === 'none' || this.deps.secrets.hasProvider(provider));
        const health: DecisionStatusView['health'] = this.deps.config.error !== null || this.deps.store.lastError !== null
            ? 'degraded'
            : this.deps.enabled()
                ? 'ok'
                : 'disabled';
        return {
            schemaVersion: 1,
            bootId: this.deps.bootId,
            enabled: this.deps.enabled(),
            health,
            healthReason: this.deps.config.error ?? this.deps.store.lastError ?? null,
            stopLatched: latch.latched,
            stopReason: latch.reason,
            activeTaskId: slot?.taskId ?? null,
            configRevision: config.configRevision,
            providerConfigured,
            defaultProviderId: config.defaultProviderId,
            defaultPolicyId: config.defaultPolicyId,
            activeProfileId: config.activeProfileId,
            capabilities: {
                protocols: ['openai-responses', 'openai-chat-compatible'],
                policies: ['observe-move', 'farm-care', ...config.customPolicies.map((policy) => policy.id)],
                multiplayerAutomation: false,
                fileSecretSupported: true
            }
        };
    }

    private async probe(providerId: string): Promise<Record<string, unknown>> {
        const config = this.deps.config.current;
        const entry = config.providers.find((provider) => provider.id === providerId);
        if (!entry) throw new BridgeError('NOT_FOUND', 'provider 不存在。');
        if (entry.authMode === 'bearer' && !this.deps.secrets.hasProvider(entry)) {
            throw new BridgeError('PROVIDER_NOT_CONFIGURED', '该 provider 尚未配置凭据。');
        }
        const provider: DecisionProvider = createDecisionProvider(entry, {
            authorizationHeader: (cfg) => this.deps.secrets.authorizationHeader(cfg as never)
        });
        const started = Date.now();
        try {
            const response = await provider.decide({
                systemPrompt: '你是连通性检测。只输出一个 JSON 对象：{"ok":true}。不要输出其他文字。',
                contextJson: '{"probe":true}',
                // 检测用最小 schema：不能复用 DecisionEnvelope，否则模型返回决策包会让探针误判失败。
                outputSchema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok']
                },
                maxOutputTokens: 64,
                signal: AbortSignal.timeout(Math.min(20_000, entry.timeoutMs ?? 30_000))
            });
            const parsed = parseProbe(response.decisionText);
            return {
                ok: parsed,
                ...(parsed ? {} : { error: { code: 'DECISION_OUTPUT_INVALID', message: '模型未返回检测要求的 JSON：{"ok":true}。' } }),
                protocol: entry.protocol,
                jsonOutput: parsed,
                latencyMs: Date.now() - started,
                finishReason: response.finishReason,
                usageSource: response.usage.source,
                note: '本次检测可能产生一次真实模型调用；只验证“能返回有效决策格式”，不代表游戏动作可用。'
            };
        } catch (error) {
            const bridge = BridgeError.from(error);
            const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : bridge.fault.code;
            return {
                ok: false,
                protocol: entry.protocol,
                jsonOutput: false,
                latencyMs: Date.now() - started,
                error: { code: code.slice(0, 80), message: bridge.message.slice(0, 200) },
                note: '检测失败只说明该配置当前不可用；未执行任何游戏动作。'
            };
        }
    }

    /** Web 派单缺少 token 时由服务端就地签发（仅当前会话、仅当前世界）。 */
    private issueWebToken(): string {
        const identity = this.deps.game.latestWorldIdentity();
        const status = this.deps.game.status();
        if (!status.mod.connected || !status.mod.saveLoaded) throw new BridgeError('GAME_UNAVAILABLE', '游戏未连接或未加载存档。');
        const profileId = this.deps.config.current.activeProfileId;
        const canPersistent = identity !== null;
        if (!canPersistent && (status.mod.instanceId === null || status.mod.worldGeneration === null)) {
            throw new BridgeError('WORLD_IDENTITY_UNAVAILABLE', '缺少稳定世界身份或实例信息。');
        }
        const scopeKey = canPersistent
            ? `p:${profileId}:${identity?.worldId ?? ''}:${identity?.actorFarmerId ?? ''}`
            : `e:${profileId}:${String(status.mod.instanceId)}:${String(status.mod.worldGeneration)}`;
        return this.deps.tokens.issue({
            clientId: 'web',
            profileId,
            scopeKey,
            worldId: identity?.worldId ?? null,
            actorFarmerId: identity?.actorFarmerId ?? null,
            instanceId: status.mod.instanceId,
            worldGeneration: status.mod.worldGeneration,
            nowMs: Date.now()
        }).token;
    }

    private async taskOperation(taskId: string, operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const requestId = typeof body['requestId'] === 'string' && body['requestId'].length > 0 ? body['requestId'] : newDecisionId('req');
        switch (operation) {
            case 'pause':
                return this.deps.service.pause(WEB_PRINCIPAL, taskId, requestId, typeof body['reason'] === 'string' ? body['reason'] : undefined);
            case 'cancel':
                return this.deps.service.cancel(WEB_PRINCIPAL, taskId, requestId, typeof body['reason'] === 'string' ? body['reason'] : undefined);
            case 'resume':
                return this.deps.service.resume(WEB_PRINCIPAL, taskId, requestId, Number(body['expectedRevision']), typeof body['contextToken'] === 'string' ? body['contextToken'] : this.issueWebToken());
            case 'reply':
                return this.deps.service.reply(WEB_PRINCIPAL, taskId, requestId, Number(body['expectedRevision']), typeof body['contextToken'] === 'string' ? body['contextToken'] : this.issueWebToken(), String(body['answer'] ?? ''));
            case 'update':
                return this.deps.service.update(WEB_PRINCIPAL, taskId, {
                    requestId,
                    expectedRevision: Number(body['expectedRevision']),
                    patch: (body['patch'] ?? {}) as never
                });
            case 'resolve':
                return this.deps.service.resolve(WEB_PRINCIPAL, taskId, requestId, {
                    expectedRevision: Number(body['expectedRevision']),
                    resolution: body['resolution'] as 'accept_completion' | 'reviewed_pause' | 'reject_completion',
                    note: String(body['note'] ?? ''),
                    evidenceIds: Array.isArray(body['evidenceIds']) ? body['evidenceIds'].filter((id): id is string => typeof id === 'string') : undefined
                });
            default:
                throw new BridgeError('INVALID_ARGUMENT', '未知任务操作：' + operation);
        }
    }

    private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
        const body = await readBody(req, MAX_REQUEST_BYTES);
        if (body.length === 0) return {};
        try {
            const parsed: unknown = JSON.parse(body.toString('utf8'));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
            return parsed as Record<string, unknown>;
        } catch {
            throw new BridgeError('INVALID_ARGUMENT', '请求体不是合法 JSON 对象。');
        }
    }
}

function parseProbe(text: string): boolean {
    try {
        const value: unknown = JSON.parse(text.trim());
        return value !== null && typeof value === 'object' && (value as Record<string, unknown>)['ok'] === true;
    } catch {
        return false;
    }
}

function statusOf(code: string): number {
    switch (code) {
        case 'NOT_FOUND': return 404;
        case 'DECISION_NOT_AUTHORIZED':
        case 'AUTH_FAILED': return 403;
        case 'TASK_REVISION_CONFLICT':
        case 'TASK_IDEMPOTENCY_CONFLICT':
        case 'EXECUTOR_BUSY':
        case 'CONTROL_BUSY':
        case 'RESULT_UNKNOWN': return 409;
        case 'PROVIDER_NOT_CONFIGURED':
        case 'PROVIDER_AUTH_FAILED':
        case 'PROVIDER_UNSUPPORTED':
        case 'PROVIDER_RATE_LIMITED':
        case 'DECISION_DISABLED':
        case 'POLICY_DENIED':
        case 'BUDGET_EXHAUSTED':
        case 'CONTEXT_EXPIRED':
        case 'USER_STOP_LATCHED':
        case 'WORLD_IDENTITY_UNAVAILABLE':
        case 'TASK_SCOPE_CHANGED': return 400;
        case 'TASK_STORAGE_UNAVAILABLE': return 503;
        default: return 400;
    }
}

/** 供 Web 面板展示“政策详情”，不泄露凭据。 */
export function describePolicy(config: DecisionConfigStore, policyId: string): Record<string, unknown> | null {
    const view = policyViewOf(config.current, policyId);
    if (!view) return null;
    return {
        policyId: view.policyId,
        label: view.label,
        revision: view.revision,
        allowedTools: view.allowedTools,
        allowedLocations: view.allowedLocations,
        toolRestrictions: view.toolRestrictions
    };
}
