/**
 * 任务记忆业务（§13）：MCP 与 Web 共用。
 *
 * - 写入必须带来源；主模型只能写 main_model/user，不能伪造 native_game 或 observed。
 * - 读取按作用域 + owner + visibility 过滤，权限判断先于排序与返回。
 * - 过期条目仍可作为历史查询，但默认不作为执行模型的“当前事实”。
 * - archive 只隐藏记录，不删除动作账本事实。
 */
import {
    BridgeError,
    MEMORY_CONTENT_MAX_CHARS,
    MEMORY_KINDS,
    MEMORY_MAX_RECORDS_PER_SCOPE,
    MEMORY_MAX_RESULTS,
    MEMORY_QUERY_MAX_CHARS,
    MEMORY_TITLE_MAX_CHARS,
    isDecisionId,
    utf8ByteLength,
    type MemoryKind,
    type MemoryRecord
} from '@sab/contracts';
import type { DecisionStore, MemoryStore } from '@sab/decision-core';
import { newDecisionId, recentMemories, searchMemories } from '@sab/decision-core';
import type { DecisionConfigStore } from './decision-config.js';
import type { DecisionGamePort } from './decision-game-port.js';

export interface MemoryPrincipal {
    clientId: string;
    clientName: string;
    /** Web 管理员可管理所有 profile 的记忆（但仍不能读到他人私有备注以外的东西）。 */
    admin: boolean;
}

export interface MemorySearchInput {
    query?: string;
    kind?: MemoryKind;
    limit?: number;
    taskId?: string;
    profileId?: string;
}

export interface MemoryAddInput {
    title: string;
    content: string;
    kind: MemoryKind;
    sourceType: 'main_model' | 'user';
    evidenceIds?: string[];
    taskId?: string;
    profileId?: string;
    expiresAt?: string | null;
    /** 默认 private；玩家在 Web 写的偏好用 shared，执行模型才能在同一 profile 读到。 */
    visibility?: 'private' | 'shared';
}

export class DecisionMemoryService {
    constructor(
        private readonly memory: MemoryStore,
        private readonly store: DecisionStore,
        private readonly game: DecisionGamePort,
        private readonly config: DecisionConfigStore
    ) {}

    /** 解析作用域：优先用任务（须本人或已共享），否则用当前真实世界身份。 */
    resolveScope(principal: MemoryPrincipal, options: { taskId?: string; profileId?: string }): string {
        if (options.taskId !== undefined) {
            const task = this.store.loadTask(options.taskId);
            if (!task) throw new BridgeError('NOT_FOUND', '任务不存在或无权读取记忆。');
            if (task.ownerClientId !== principal.clientId && !principal.admin && !this.config.current.sharing.sharedTaskReadAcrossClients) {
                throw new BridgeError('NOT_FOUND', '任务不存在或无权读取记忆。');
            }
            return task.scope.scopeKey;
        }
        const profileId = options.profileId ?? this.config.current.activeProfileId;
        if (options.profileId !== undefined && !this.config.current.profiles.some((profile) => profile.id === options.profileId)) {
            throw new BridgeError('INVALID_ARGUMENT', 'profileId 不存在。');
        }
        const identity = this.game.latestWorldIdentity();
        if (identity) {
            return `p:${profileId}:${identity.worldId}:${identity.actorFarmerId}`;
        }
        const status = this.game.status();
        if (status.mod.instanceId && status.mod.worldGeneration !== null) {
            return `e:${profileId}:${status.mod.instanceId}:${String(status.mod.worldGeneration)}`;
        }
        throw new BridgeError('WORLD_IDENTITY_UNAVAILABLE', '当前没有可用的世界身份，无法定位记忆作用域。');
    }

    search(principal: MemoryPrincipal, input: MemorySearchInput): { scopeKey: string; memories: MemoryRecord[]; expiredIds: string[]; truncated: boolean } {
        const query = input.query ?? '';
        if (query.length > MEMORY_QUERY_MAX_CHARS) throw new BridgeError('INVALID_ARGUMENT', 'query 最多 ' + String(MEMORY_QUERY_MAX_CHARS) + ' 字符。');
        const scopeKey = this.resolveScope(principal, { taskId: input.taskId, profileId: input.profileId });
        const limit = Math.max(1, Math.min(MEMORY_MAX_RESULTS, input.limit ?? this.config.current.memory.maxResults));
        const result = searchMemories(this.store, {
            clientId: principal.clientId,
            scopeKey,
            query,
            kinds: input.kind ? [input.kind] : undefined,
            // 用户/主模型检索可以把过期条目当历史看，但会显式标出。
            includeExpiredAsHistory: true,
            limit
        }, Date.now());
        const memories: MemoryRecord[] = [];
        const expiredIds: string[] = [];
        for (const hit of result.hits) {
            memories.push(hit.expired ? { ...hit.record, status: 'expired' } : hit.record);
            if (hit.expired) expiredIds.push(hit.record.memoryId);
        }
        return { scopeKey, memories, expiredIds, truncated: result.truncated };
    }

    /** 执行模型上下文用：只取未过期、作用域内、可读的记录。 */
    forExecutor(clientId: string, scopeKey: string, count: number): MemoryRecord[] {
        return recentMemories(this.store, { clientId, scopeKey, count }, Date.now()).map((hit) => hit.record);
    }

    get(principal: MemoryPrincipal, memoryId: string): MemoryRecord {
        if (!isDecisionId(memoryId)) throw new BridgeError('INVALID_ARGUMENT', 'memoryId 非法。');
        const record = this.memory.get(memoryId);
        if (!record) throw new BridgeError('NOT_FOUND', '记忆不存在。');
        if (record.ownerClientId !== principal.clientId && record.visibility !== 'shared' && !principal.admin) {
            throw new BridgeError('NOT_FOUND', '记忆不存在或无权读取。');
        }
        return record;
    }

    add(principal: MemoryPrincipal, input: MemoryAddInput): MemoryRecord {
        // Web 手工写入不经过 MCP schema：kind 必须是契约枚举，否则面板/执行器会读到未知类型。
        if (!MEMORY_KINDS.includes(input.kind)) throw new BridgeError('INVALID_ARGUMENT', '未知的记忆类型。');
        if (input.title.length > MEMORY_TITLE_MAX_CHARS) throw new BridgeError('INVALID_ARGUMENT', 'title 过长。');
        if (input.content.length > MEMORY_CONTENT_MAX_CHARS) throw new BridgeError('INVALID_ARGUMENT', 'content 过长。');
        if (utf8ByteLength(input.content) > MEMORY_CONTENT_MAX_CHARS * 4) throw new BridgeError('INVALID_ARGUMENT', 'content 字节数过大。');
        if (input.sourceType !== 'main_model' && input.sourceType !== 'user') {
            throw new BridgeError('POLICY_DENIED', '只能声明 main_model 或 user 来源。');
        }
        // 临时目标引用（@s12:e3 / @mp2_...）只在当前观察有效，不能写进长期记忆当可执行地址。
        if (/(?:@s[0-9]{1,9}:[em][0-9]{1,4}|@mp2_[A-Za-z0-9_-]{22}_[em][0-9]{1,4})/.test(input.content)) {
            throw new BridgeError('INVALID_ARGUMENT', '记忆不能保存临时目标引用；请描述稳定的地块/对象特征。');
        }
        if (input.kind === 'preference' && !principal.admin) {
            // 偏好只能由 Web 用户/管理员写；主模型不能替我设定偏好并借此收紧规则。
            throw new BridgeError('POLICY_DENIED', '偏好只能由玩家在 Web 中写入。');
        }
        // 写入必须拥有该任务：共享只读不能变成“往别人任务里塞记忆”。
        if (input.taskId !== undefined) {
            const task = this.store.loadTask(input.taskId);
            if (!task || (task.ownerClientId !== principal.clientId && !principal.admin)) {
                throw new BridgeError('NOT_FOUND', '任务不存在或无权写入记忆。');
            }
        }
        const scopeKey = this.resolveScope(principal, { taskId: input.taskId, profileId: input.profileId });
        if (this.memory.countActiveForScope(scopeKey) >= Math.min(MEMORY_MAX_RECORDS_PER_SCOPE, this.config.current.memory.maxEntriesPerScope)) {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '记忆已达作用域上限（storage_limit），请先在 Web 归档。');
        }
        const now = new Date().toISOString();
        return this.memory.add({
            memoryId: newDecisionId('mem'),
            scopeKey,
            ownerClientId: principal.clientId,
            visibility: input.visibility ?? 'private',
            kind: input.kind,
            title: input.title,
            content: input.content,
            sourceType: input.sourceType,
            sourceId: input.taskId ?? null,
            evidenceIds: (input.evidenceIds ?? []).filter(isDecisionId).slice(0, 16),
            confidenceLabel: 'reported',
            observedAt: now,
            expiresAt: normalizeExpiresAt(input.expiresAt),
            supersedesId: null,
            allowNativeSource: false
        });
    }

    update(principal: MemoryPrincipal, memoryId: string, input: { expectedRevision: number; title?: string; content?: string; expiresAt?: string | null; confidenceLabel?: MemoryRecord['confidenceLabel'] }): MemoryRecord {
        const record = this.get(principal, memoryId);
        if (record.ownerClientId !== principal.clientId && !principal.admin) {
            throw new BridgeError('DECISION_NOT_AUTHORIZED', '只能修订自己的记忆。');
        }
        // MemoryStore 的 CAS 以 owner 身份校验；Web 管理员代改时沿用记录 owner，不篡改归属。
        const actor = principal.admin ? record.ownerClientId : principal.clientId;
        return this.memory.update(memoryId, actor, {
            ...input,
            expiresAt: input.expiresAt === undefined ? undefined : normalizeExpiresAt(input.expiresAt)
        });
    }

    archive(principal: MemoryPrincipal, memoryId: string): MemoryRecord {
        const record = this.get(principal, memoryId);
        if (record.ownerClientId !== principal.clientId && !principal.admin) {
            throw new BridgeError('DECISION_NOT_AUTHORIZED', '只能归档自己的记忆。');
        }
        // 归档走 owner 视角：管理员代为归档时以记录 owner 身份执行，避免越权改写归属。
        return this.memory.archive(memoryId, record.ownerClientId);
    }
}

/** 过期时间只接受可解析的 ISO 时间或 null；非法值直接拒绝而不是写入垃圾。 */
function normalizeExpiresAt(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) throw new BridgeError('INVALID_ARGUMENT', 'expiresAt 必须是可解析的时间。');
    return new Date(ts).toISOString();
}
