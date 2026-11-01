/**
 * 记忆检索（§13.3）：SQLite 普通字段 + 有界关键词 LIKE 匹配。
 * 不用 embeddings / FTS 扩展。候选最多 500、结果最多 12；
 * 排序优先作用域匹配、未过期、来源可信与时间相关。
 * 过期记忆仅在显式请求“作为历史”时返回，且标记 expired，不作当前事实。
 */
import {
    BridgeError,
    MEMORY_MAX_RESULTS,
    MEMORY_QUERY_MAX_CHARS,
    MEMORY_SEARCH_CANDIDATE_MAX,
    isDecisionId,
} from '@sab/contracts';
import type { MemoryKind, MemoryRecord } from '@sab/contracts';
import { DecisionStore } from './store.js';
import { MemoryStore } from './memory-store.js';

const MAX_TOKENS = 8;
const MAX_TOKEN_CHARS = 60;

export interface MemorySearchRequest {
    /** 请求方（认证层注入），用于私密可见性过滤。 */
    clientId: string;
    /** 当前任务/Web 上下文作用域；首版检索不跨 scope。 */
    scopeKey: string;
    query: string;
    kinds?: MemoryKind[];
    includeArchived?: boolean;
    /** 默认 false：过期记忆不提供给执行模型当当前依据。 */
    includeExpiredAsHistory?: boolean;
    limit?: number;
}

export interface MemorySearchHit {
    record: MemoryRecord;
    score: number;
    matchedTerms: string[];
    /** 过期但作为历史返回时为 true；调用方不得将其当当前事实。 */
    expired: boolean;
}

export interface MemorySearchResult {
    hits: MemorySearchHit[];
    candidateCount: number;
    /** 候选达到上限被截断：调用方应提示“可能有更多历史记忆”。 */
    truncated: boolean;
}

type SqlRow = Record<string, unknown>;

function escapeLike(term: string): string {
    return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function tokenize(query: string): string[] {
    const cleaned = query.toLowerCase().trim();
    if (cleaned.length === 0) return [];
    const parts = cleaned.split(/\s+/).filter((t) => t.length > 0).slice(0, MAX_TOKENS);
    return Array.from(new Set(parts.map((t) => t.slice(0, MAX_TOKEN_CHARS))));
}

const SOURCE_WEIGHT: Record<string, number> = { native_game: 3, user: 3, main_model: 2, executor: 1 };
const CONFIDENCE_WEIGHT: Record<string, number> = { observed: 2, reported: 1, inferred: 0 };

function recencyBonus(createdAt: string, nowMs: number): number {
    const t = Date.parse(createdAt);
    if (!Number.isFinite(t)) return 0;
    const days = Math.max(0, (nowMs - t) / 86_400_000);
    if (days <= 7) return 2;
    if (days <= 30) return 1;
    return 0;
}

export function searchMemories(store: DecisionStore, request: MemorySearchRequest, nowMs: number): MemorySearchResult {
    if (!isDecisionId(request.clientId)) throw new BridgeError('INVALID_ARGUMENT', 'clientId 非法。');
    if (request.scopeKey.length === 0 || request.scopeKey.length > 256) {
        throw new BridgeError('INVALID_ARGUMENT', 'scopeKey 非法。');
    }
    const queryChars = Array.from(request.query ?? '').length;
    if (queryChars > MEMORY_QUERY_MAX_CHARS) {
        throw new BridgeError('INVALID_ARGUMENT', '检索词不得超过 ' + MEMORY_QUERY_MAX_CHARS + ' 字符。');
    }
    const terms = tokenize(request.query);
    const limit = Math.max(1, Math.min(MEMORY_MAX_RESULTS, Math.trunc(request.limit ?? MEMORY_MAX_RESULTS)));

    const db = store.database();
    const clauses: string[] = ['scope_key=?', "(owner_client_id=? OR visibility='shared')"];
    const params: (string | number)[] = [request.scopeKey, request.clientId];
    if (!request.includeArchived) clauses.push("status <> 'archived'");
    if (request.kinds && request.kinds.length > 0) {
        const bad = request.kinds.filter((k) => typeof k !== 'string');
        if (bad.length > 0) throw new BridgeError('INVALID_ARGUMENT', 'kind 过滤非法。');
        clauses.push('kind IN (' + request.kinds.map(() => '?').join(',') + ')');
        params.push(...request.kinds);
    }
    let sql = 'SELECT * FROM memories WHERE ' + clauses.join(' AND ');
    const storeAccess = new MemoryStore(store);
    if (terms.length > 0) {
        const likeClauses = terms.map(() => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
        sql += ' AND ' + likeClauses.join(' AND ');
        for (const term of terms) {
            const pattern = '%' + escapeLike(term) + '%';
            params.push(pattern, pattern);
        }
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(MEMORY_SEARCH_CANDIDATE_MAX);

    const rows = db.prepare(sql).all(...params) as SqlRow[];
    const truncated = rows.length >= MEMORY_SEARCH_CANDIDATE_MAX;

    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
        let record: MemoryRecord;
        try {
            record = MemoryStore.rowToRecord(row);
        } catch {
            continue; // 单条损坏不影响整体检索
        }
        const expired = storeAccess.isEffectivelyExpired(record, nowMs);
        if (expired && !request.includeExpiredAsHistory) continue;

        let score = 0;
        const matchedTerms: string[] = [];
        const titleLower = record.title.toLowerCase();
        const contentLower = record.content.toLowerCase();
        for (const term of terms) {
            let matched = false;
            if (titleLower.includes(term)) {
                score += 2;
                matched = true;
            }
            if (contentLower.includes(term)) {
                score += 1;
                matched = true;
            }
            if (matched) matchedTerms.push(term);
        }
        if (terms.length > 0 && matchedTerms.length === 0) continue;
        if (record.status === 'active') score += 3;
        else if (record.status === 'superseded') score += 1;
        score += SOURCE_WEIGHT[record.sourceType] ?? 0;
        score += CONFIDENCE_WEIGHT[record.confidenceLabel] ?? 0;
        if (record.confidenceLabel === 'observed' && record.sourceType !== 'native_game') score -= 2;
        score += recencyBonus(record.createdAt, nowMs);
        if (expired) score -= 4;
        hits.push({ record, score, matchedTerms, expired });
    }

    hits.sort((a, b) => (b.score - a.score) || (Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt)));
    return { hits: hits.slice(0, limit), candidateCount: rows.length, truncated };
}

/** 空查询时的兜底：返回当前作用域最近的可信记忆（用于会话开头注入少量背景）。 */
export function recentMemories(store: DecisionStore, request: Omit<MemorySearchRequest, 'query'> & { count: number }, nowMs: number): MemorySearchHit[] {
    const db = store.database();
    const count = Math.max(1, Math.min(MEMORY_MAX_RESULTS, Math.trunc(request.count)));
    const clauses: string[] = ['scope_key=?', "(owner_client_id=? OR visibility='shared')", "status='active'"];
    const params: (string | number)[] = [request.scopeKey, request.clientId];
    let sql = 'SELECT * FROM memories WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?';
    params.push(MEMORY_SEARCH_CANDIDATE_MAX);
    const rows = db.prepare(sql).all(...params) as SqlRow[];
    const storeAccess = new MemoryStore(store);
    const out: MemorySearchHit[] = [];
    for (const row of rows) {
        let record: MemoryRecord;
        try {
            record = MemoryStore.rowToRecord(row);
        } catch {
            continue;
        }
        const expired = storeAccess.isEffectivelyExpired(record, nowMs);
        if (expired) continue;
        let score = 3 + (SOURCE_WEIGHT[record.sourceType] ?? 0) + (CONFIDENCE_WEIGHT[record.confidenceLabel] ?? 0) + recencyBonus(record.createdAt, nowMs);
        if (record.confidenceLabel === 'observed' && record.sourceType !== 'native_game') score -= 2;
        out.push({ record, score, matchedTerms: [], expired: false });
        if (out.length >= count * 3) break;
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, count);
}
