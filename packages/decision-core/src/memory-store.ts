/**
 * 长期记忆存储（§13）：写入校验、修订 CAS、归档、supersede/conflict 并存、
 * 作用域条数上限。不悄悄覆盖历史事实；越限明确报 storage_limit。
 * 记忆内容是数据，绝不授予工具权限或覆盖系统规则（§13.1）。
 */
import {
    BridgeError,
    MEMORY_CONTENT_MAX_CHARS,
    MEMORY_MAX_RECORDS_PER_SCOPE,
    MEMORY_TITLE_MAX_CHARS,
    utf8ByteLength,
    isDecisionId,
} from '@sab/contracts';
import type {
    ConfidenceLabel,
    MemoryKind,
    MemoryRecord,
    MemorySourceType,
    MemoryStatus,
} from '@sab/contracts';
import { DecisionStore } from './store.js';
import { MEMORY_KINDS } from '@sab/contracts';

const MEMORY_STATUSES = new Set<MemoryStatus>(['active', 'superseded', 'archived', 'expired']);
const SOURCE_TYPES = new Set<MemorySourceType>(['native_game', 'main_model', 'executor', 'user']);
const CONFIDENCE_LABELS = new Set<ConfidenceLabel>(['observed', 'reported', 'inferred']);
const EVIDENCE_JSON_MAX_BYTES = 8 * 1024;
const CONFLICT_JSON_MAX_BYTES = 8 * 1024;

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
}

function charLength(value: string): number {
    return Array.from(value).length;
}

function stringList(value: unknown, what: string, max: number): string[] {
    if (!Array.isArray(value)) {
        throw new BridgeError('INVALID_ARGUMENT', what + ' 必须是字符串数组。');
    }
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || !isDecisionId(item)) {
            throw new BridgeError('INVALID_ARGUMENT', what + ' 含非法 ID。');
        }
        out.push(item);
    }
    if (out.length > max) {
        throw new BridgeError('INVALID_ARGUMENT', what + ' 超过 ' + max + ' 条上限。');
    }
    return out;
}

export interface AddMemoryInput {
    memoryId: string;
    scopeKey: string;
    ownerClientId: string;
    visibility: 'private' | 'shared';
    kind: MemoryKind;
    title: string;
    content: string;
    sourceType: MemorySourceType;
    sourceId: string | null;
    evidenceIds: string[];
    confidenceLabel: ConfidenceLabel;
    observedAt: string | null;
    expiresAt: string | null;
    supersedesId: string | null;
    /** 已授权的 Web/用户写入才允许 preference；服务层负责身份判定，这里只挡伪标。 */
    allowNativeSource: boolean;
}

export interface UpdateMemoryInput {
    expectedRevision: number;
    title?: string;
    content?: string;
    expiresAt?: string | null;
    /** 只可降级可信度（例如把 inferred 改 reported 也拒绝，只允许更保守）。 */
    confidenceLabel?: ConfidenceLabel;
}

export class MemoryStore {
    constructor(private readonly store: DecisionStore) {}

    add(input: AddMemoryInput): MemoryRecord {
        if (!isDecisionId(input.memoryId)) throw new BridgeError('INVALID_ARGUMENT', 'memoryId 非法。');
        if (input.visibility !== 'private' && input.visibility !== 'shared') {
            throw new BridgeError('INVALID_ARGUMENT', 'visibility 非法。');
        }
        if (!MEMORY_KINDS.includes(input.kind)) throw new BridgeError('INVALID_ARGUMENT', 'kind 非法。');
        if (!SOURCE_TYPES.has(input.sourceType)) throw new BridgeError('INVALID_ARGUMENT', 'sourceType 非法。');
        if (!CONFIDENCE_LABELS.has(input.confidenceLabel)) throw new BridgeError('INVALID_ARGUMENT', 'confidenceLabel 非法。');
        if (input.sourceType === 'native_game' && !input.allowNativeSource) {
            // 模型（main_model/executor）不得伪造“游戏原生观察”来源（§13.2）。
            throw new BridgeError('POLICY_DENIED', 'sourceType=native_game 仅允许服务端原生观察路径写入。');
        }
        if (input.confidenceLabel === 'observed' && input.sourceType !== 'native_game') {
            throw new BridgeError('INVALID_ARGUMENT', 'observed 可信度必须来自 native_game 来源。');
        }
        if (charLength(input.title) === 0 || charLength(input.title) > MEMORY_TITLE_MAX_CHARS) {
            throw new BridgeError('INVALID_ARGUMENT', 'title 须为 1–' + MEMORY_TITLE_MAX_CHARS + ' 字符。');
        }
        if (charLength(input.content) === 0 || charLength(input.content) > MEMORY_CONTENT_MAX_CHARS) {
            throw new BridgeError('INVALID_ARGUMENT', 'content 须为 1–' + MEMORY_CONTENT_MAX_CHARS + ' 字符。');
        }
        const evidenceIds = stringList(input.evidenceIds, 'evidenceIds', 16);
        if (input.supersedesId !== null && !isDecisionId(input.supersedesId)) {
            throw new BridgeError('INVALID_ARGUMENT', 'supersedesId 非法。');
        }
        const db = this.store.database();
        const at = new Date().toISOString();
        return this.store.transaction(() => {
            const countRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope_key=? AND status='active'").get(input.scopeKey) as SqlRow | undefined;
            const active = countRow ? asNumber(countRow.n) : 0;
            if (active >= MEMORY_MAX_RECORDS_PER_SCOPE) {
                throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '作用域记忆已达 ' + MEMORY_MAX_RECORDS_PER_SCOPE + ' 条上限（storage_limit），需先在 Web 归档或清理历史摘要。', {
                    detail: { reason: 'storage_limit', scopeKey: input.scopeKey, limit: MEMORY_MAX_RECORDS_PER_SCOPE },
                });
            }
            const evidenceText = JSON.stringify(evidenceIds);
            if (utf8ByteLength(evidenceText) > EVIDENCE_JSON_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', 'evidenceIds 超出字节上限。');
            db.prepare(
                'INSERT INTO memories(memory_id, scope_key, owner_client_id, visibility, kind, title, content,' +
                ' source_type, source_id, evidence_ids_json, confidence_label, created_at, observed_at, expires_at,' +
                " status, revision, supersedes_id, conflict_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', 1, ?, '[]')"
            ).run(
                input.memoryId, input.scopeKey, input.ownerClientId, input.visibility, input.kind,
                input.title, input.content, input.sourceType, input.sourceId, evidenceText,
                input.confidenceLabel, at, input.observedAt, input.expiresAt, input.supersedesId,
            );
            if (input.supersedesId !== null) {
                const old = db.prepare('SELECT revision FROM memories WHERE memory_id=?').get(input.supersedesId) as SqlRow | undefined;
                if (old) {
                    db.prepare("UPDATE memories SET status='superseded', revision=revision+1 WHERE memory_id=? AND status='active'").run(input.supersedesId);
                }
            }
            const rec = this.get(input.memoryId);
            if (!rec) throw new BridgeError('INTERNAL_ERROR', '记忆写入后不可见。');
            return rec;
        });
    }

    get(memoryId: string): MemoryRecord | null {
        const db = this.store.database();
        const row = db.prepare('SELECT * FROM memories WHERE memory_id=?').get(memoryId) as SqlRow | undefined;
        return row ? MemoryStore.rowToRecord(row) : null;
    }

    /** 修订 CAS 更新：只开放文本与过期时间；kind/source/visibility/scope 不可变。 */
    update(memoryId: string, actorClientId: string, input: UpdateMemoryInput): MemoryRecord {
        const db = this.store.database();
        return this.store.transaction(() => {
            const current = this.get(memoryId);
            if (!current) throw new BridgeError('NOT_FOUND', '记忆不存在：' + memoryId);
            if (current.ownerClientId !== actorClientId) {
                throw new BridgeError('DECISION_NOT_AUTHORIZED', '只能修订自己的记忆。');
            }
            if (current.revision !== input.expectedRevision) {
                throw new BridgeError('TASK_REVISION_CONFLICT', '记忆修订版本冲突，请重新读取。', { detail: { memoryId, currentRevision: current.revision } });
            }
            if (current.status === 'archived') throw new BridgeError('INVALID_ARGUMENT', '已归档记忆不可修订。');
            let title = current.title;
            let content = current.content;
            let confidence = current.confidenceLabel;
            const expiresAt = input.expiresAt === undefined ? current.expiresAt : input.expiresAt;
            if (input.title !== undefined) {
                if (charLength(input.title) === 0 || charLength(input.title) > MEMORY_TITLE_MAX_CHARS) {
                    throw new BridgeError('INVALID_ARGUMENT', 'title 长度非法。');
                }
                title = input.title;
            }
            if (input.content !== undefined) {
                if (charLength(input.content) === 0 || charLength(input.content) > MEMORY_CONTENT_MAX_CHARS) {
                    throw new BridgeError('INVALID_ARGUMENT', 'content 长度非法。');
                }
                content = input.content;
            }
            if (input.confidenceLabel !== undefined) {
                if (!CONFIDENCE_LABELS.has(input.confidenceLabel)) {
                    throw new BridgeError('INVALID_ARGUMENT', '未知的 confidenceLabel。');
                }
                const rank: Record<ConfidenceLabel, number> = { observed: 2, reported: 1, inferred: 0 };
                if (rank[input.confidenceLabel] > rank[current.confidenceLabel]) {
                    throw new BridgeError('POLICY_DENIED', '不允许升级记忆可信度。');
                }
                confidence = input.confidenceLabel;
            }
            // 过期时间必须是可解析时间或 null；否则排序/过期判断会得到 NaN。
            if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
                throw new BridgeError('INVALID_ARGUMENT', 'expiresAt 必须是可解析的时间。');
            }
            const info = db.prepare(
                'UPDATE memories SET title=?, content=?, confidence_label=?, expires_at=?, revision=revision+1 WHERE memory_id=? AND revision=?'
            ).run(title, content, confidence, expiresAt, memoryId, input.expectedRevision);
            if (Number(info.changes) !== 1) {
                throw new BridgeError('TASK_REVISION_CONFLICT', '记忆修订版本冲突，请重新读取。');
            }
            const next = this.get(memoryId);
            if (!next) throw new BridgeError('INTERNAL_ERROR', '记忆更新后不可见。');
            return next;
        });
    }

    archive(memoryId: string, actorClientId: string): MemoryRecord {
        const db = this.store.database();
        const current = this.get(memoryId);
        if (!current) throw new BridgeError('NOT_FOUND', '记忆不存在：' + memoryId);
        if (current.ownerClientId !== actorClientId) {
            throw new BridgeError('DECISION_NOT_AUTHORIZED', '只能归档自己的记忆。');
        }
        db.prepare("UPDATE memories SET status='archived', revision=revision+1 WHERE memory_id=?").run(memoryId);
        const next = this.get(memoryId);
        if (!next) throw new BridgeError('INTERNAL_ERROR', '记忆归档后不可见。');
        return next;
    }

    /** 标记两条并存冲突（不覆盖任何一条历史事实，§13.3）。 */
    markConflict(memoryIdA: string, memoryIdB: string): void {
        const db = this.store.database();
        this.store.transaction(() => {
            for (const [self, other] of [[memoryIdA, memoryIdB], [memoryIdB, memoryIdA]] as const) {
                const row = db.prepare('SELECT conflict_ids_json FROM memories WHERE memory_id=?').get(self) as SqlRow | undefined;
                if (!row) continue;
                let ids: string[] = [];
                try {
                    const parsed: unknown = JSON.parse(asString(row.conflict_ids_json) ?? '[]');
                    ids = stringList(parsed, 'conflict_ids_json', 32);
                } catch { ids = []; }
                if (!ids.includes(other)) ids.push(other);
                const text = JSON.stringify(ids);
                if (utf8ByteLength(text) > CONFLICT_JSON_MAX_BYTES) continue;
                db.prepare('UPDATE memories SET conflict_ids_json=? WHERE memory_id=?').run(text, self);
            }
        });
    }

    /** 懒过期：读取/检索时把已过 expiresAt 的 active 记录视为 expired。 */
    isEffectivelyExpired(record: MemoryRecord, nowMs: number): boolean {
        if (record.status === 'expired') return true;
        if (!record.expiresAt) return false;
        const t = Date.parse(record.expiresAt);
        return Number.isFinite(t) && t <= nowMs;
    }

    countActiveForScope(scopeKey: string): number {
        const db = this.store.database();
        const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope_key=? AND status='active'").get(scopeKey) as SqlRow | undefined;
        return row ? asNumber(row.n) : 0;
    }

    static rowToRecord(row: SqlRow): MemoryRecord {
        let evidenceIds: string[] = [];
        try {
            const parsed: unknown = JSON.parse(asString(row.evidence_ids_json) ?? '[]');
            if (Array.isArray(parsed)) evidenceIds = parsed.filter((x): x is string => typeof x === 'string');
        } catch { /* 损坏证据列表按空处理 */ }
        const visibility = asString(row.visibility) === 'shared' ? 'shared' : 'private';
        const statusRaw = asString(row.status);
        const status: MemoryStatus = statusRaw !== null && (MEMORY_STATUSES as Set<string>).has(statusRaw)
            ? (statusRaw as MemoryStatus)
            : 'active';
        return {
            schemaVersion: 1,
            memoryId: String(row.memory_id),
            scopeKey: String(row.scope_key),
            ownerClientId: String(row.owner_client_id),
            visibility,
            kind: asString(row.kind) as MemoryKind,
            title: String(row.title),
            content: String(row.content),
            sourceType: asString(row.source_type) as MemorySourceType,
            sourceId: asString(row.source_id),
            evidenceIds,
            confidenceLabel: asString(row.confidence_label) as ConfidenceLabel,
            createdAt: String(row.created_at),
            observedAt: asString(row.observed_at),
            expiresAt: asString(row.expires_at),
            status,
            revision: asNumber(row.revision),
            supersedesId: asString(row.supersedes_id),
        };
    }
}
