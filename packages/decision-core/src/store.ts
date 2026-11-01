/**
 * decision.sqlite 存储层（§16）：任务、运行、步骤、事件、动作链接、观察、
 * 模型调用、幂等请求、执行槽与实例停止锁。
 *
 * 仿照 control-core ActionLedger：单写入者、PRAGMA synchronous=FULL、
 * 迁移前 VACUUM INTO 备份（非内存库）、WAL、短事务。
 * 未来版本或损坏的库保持原文件、标记 degraded，不删除重建（§16.2）。
 * JSON 字段按类型与字节上限校验，不存完整模型响应、Key 或隐藏推理。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
    BridgeError,
    isDecisionId,
    isTaskState,
    isTaskPhase,
    TASK_REQUEST_MAX_BYTES,
} from '@sab/contracts';
import type {
    ActionReceipt,
    BudgetUsage,
    PolicySnapshotView,
    TaskBlocker,
    TaskBudget,
    TaskCompletion,
    TaskDefinition,
    TaskOperation,
    TaskPhase,
    TaskPlanStep,
    TaskRecord,
    TaskScope,
    TaskState,
    StepStatus,
} from '@sab/contracts';
import { DECISION_SCHEMA_VERSION, createStatements } from './migrations.js';
import { decodeCursor, encodeCursor } from './ids.js';

export type DecisionLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// 大小上限（字节，UTF-8）。超限一律拒绝写入，不截断改写语义。
// ---------------------------------------------------------------------------
export const DEFINITION_JSON_MAX_BYTES = 32 * 1024;
export const BUDGET_JSON_MAX_BYTES = 8 * 1024;
export const RESULT_JSON_MAX_BYTES = 32 * 1024;
export const EVENT_PAYLOAD_MAX_BYTES = 4 * 1024;
export const OBSERVATION_PAYLOAD_MAX_BYTES = 32 * 1024;
export const OBSERVATION_META_MAX_BYTES = 2 * 1024;
export const RECEIPT_JSON_MAX_BYTES = 8 * 1024;
export const REQUEST_RESULT_MAX_BYTES = TASK_REQUEST_MAX_BYTES;
export const MODEL_USAGE_MAX_BYTES = 2 * 1024;
export const STEP_EVIDENCE_MAX_BYTES = 8 * 1024;

const USER_STOP_KEY = 'user_stop_la…d';
const USER_STOP_REASON_KEY = 'user_stop_reason';
const RUN_STATES = new Set(['active', 'ended', 'aborted']);
const DISPATCH_STATES = new Set(['prepared', 'receipted', 'unknown', 'stale']);
const STEP_STATUSES = new Set(['pending', 'active', 'reported_done', 'verified_done', 'skipped']);

export type RunState = 'active' | 'ended' | 'aborted';
export type DispatchState = 'prepared' | 'receipted' | 'unknown' | 'stale';
export type ModelCallStatus = 'started' | 'completed' | 'error' | 'timeout' | 'aborted';

export interface RunRow {
    runId: string;
    taskId: string;
    generation: number;
    state: RunState;
    providerId: string;
    providerConfigRevision: number;
    policyRevision: number;
    internalClientId: string;
    controlSessionId: string | null;
    startReason: string;
    endReason: string | null;
    startedAt: string;
    endedAt: string | null;
}

export interface ActionLinkRow {
    runId: string;
    attemptNo: number;
    taskId: string;
    actionId: string;
    toolName: string;
    argsHash: string;
    dispatchState: DispatchState;
    receipt: ActionReceipt | null;
    observationId: string | null;
    stepId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ObservationRow {
    observationId: string;
    taskId: string | null;
    runId: string | null;
    scopeKey: string;
    instanceId: string;
    worldGeneration: number;
    sceneGeneration: number;
    dateJson: string | null;
    coverageJson: string | null;
    payloadJson: string;
    at: string;
}

export interface ModelCallRow {
    callId: string;
    taskId: string;
    runId: string;
    generation: number;
    providerId: string;
    providerConfigRevision: number;
    reservedTokens: number;
    usageJson: string | null;
    usageUnknown: boolean;
    status: ModelCallStatus;
    errorCode: string | null;
    latencyMs: number | null;
    startedAt: string;
    endedAt: string | null;
}

export interface StoredRequest {
    ownerClientId: string;
    requestId: string;
    operation: TaskOperation;
    taskId: string | null;
    canonicalHash: string;
    resultJson: Record<string, unknown> | null;
    createdAt: string;
    tombstone: boolean;
}

export interface SlotInfo {
    taskId: string;
    generation: number;
    acquiredAt: string;
}

export interface ReserveRequestResult {
    kind: 'none' | 'same' | 'conflict';
    request: StoredRequest;
}

export interface TaskListPage {
    tasks: TaskRecord[];
    finalSummaries: Record<string, string>;
    nextCursor: string | null;
}

export interface DecisionEventRow {
    id: number;
    taskId: string;
    runId: string | null;
    kind: string;
    payload: Record<string, unknown> | null;
    at: string;
}

export interface StartupRecovery {
    recoveredTaskIds: string[];
    abortedRuns: number;
}

/** 内部扩展存储：result_json 除 TaskRecord 可变字段外另存终局摘要 finalSummary。 */
interface TaskMutable {
    plan: TaskPlanStep[] | null;
    currentRunId: string | null;
    pauseReason: string | null;
    blocker: TaskBlocker | null;
    completion: TaskCompletion | null;
    lastEvidenceSummary: string | null;
    finalSummary: string | null;
}

const EMPTY_MUTABLE: TaskMutable = {
    plan: null, currentRunId: null, pauseReason: null, blocker: null,
    completion: null, lastEvidenceSummary: null, finalSummary: null,
};

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
}

function asBool(value: unknown): boolean {
    return asNumber(value) !== 0;
}

const textEncoder = new TextEncoder();

function jsonBytes(value: string): number {
    return textEncoder.encode(value).length;
}

function parseJsonObject(text: string, what: string): SqlRow {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new BridgeError('TASK_STORAGE_UNAVAILABLE', what + ' 无法解析（决策库内容损坏？）。');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BridgeError('TASK_STORAGE_UNAVAILABLE', what + ' 不是 JSON 对象。');
    }
    return parsed as SqlRow;
}

export class DecisionStore {
    private db: DatabaseSync | null = null;
    private readonly logger?: DecisionLogger;
    private readonly dbPath: string;
    private txDepth = 0;
    writable = false;
    lastError: string | null = null;
    schemaVersion = 0;
    backupPath: string | null = null;

    constructor(path: string, options: { logger?: DecisionLogger } = {}) {
        this.dbPath = path;
        this.logger = options.logger;
        try {
            this.db = new DatabaseSync(path);
            // 迁移期间 requireDb() 需要可用的连接；writable 在连接建立后、迁移前置位，
            // 迁移失败时由 catch 重新置 false 并关闭连接。
            this.writable = true;
            this.db.exec('PRAGMA foreign_keys = ON;');
            this.db.exec('PRAGMA synchronous = FULL;');
            this.migrate();
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.restrictPermissions();
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.logger?.('error', '决策库不可用：' + this.lastError, { path });
            try { this.db?.close(); } catch { /* 保留原始错误 */ }
            this.db = null;
            this.writable = false;
        }
    }

    /** 任务库含目标与偏好：Linux/macOS 下尽力收紧到 0600（Windows 依赖用户数据根 ACL）。 */
    private restrictPermissions(): void {
        if (process.platform === 'win32' || this.dbPath === ':memory:') return;
        for (const file of [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm']) {
            try { chmodSync(file, 0o600); } catch { /* 文件可能尚未创建或文件系统不支持 */ }
        }
    }

    close(): void {
        // WAL/SHM 可能在运行期才创建：关闭前再收紧一次，避免只保护主库文件。
        this.restrictPermissions();
        try { this.db?.close(); } catch { /* 忽略关闭失败 */ }
        this.db = null;
        this.writable = false;
    }

    /** 包内部：memory-store 等复用同一连接的短语句入口。仅限本包使用。 */
    database(): DatabaseSync {
        return this.requireDb();
    }

    private requireDb(): DatabaseSync {
        if (!this.db || !this.writable) {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', this.lastError ?? '决策库不可写，已拒绝任务变更。');
        }
        return this.db;
    }

    /** 短事务；同层嵌套自动合并（BEGIN IMMEDIATE 只发一次）。 */
    transaction<T>(fn: () => T): T {
        const db = this.requireDb();
        if (this.txDepth > 0) {
            this.txDepth += 1;
            try {
                return fn();
            } finally {
                this.txDepth -= 1;
            }
        }
        db.exec('BEGIN IMMEDIATE');
        this.txDepth = 1;
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
            throw error;
        } finally {
            this.txDepth -= 1;
        }
    }

    // -----------------------------------------------------------------------
    // 迁移（§16.2）
    // -----------------------------------------------------------------------
    private migrate(): void {
        const db = this.requireDb();
        const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get() as SqlRow | undefined;
        let version = 0;
        if (tableRow) {
            const valueRow = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as SqlRow | undefined;
            version = valueRow ? Number(valueRow.value) : 0;
        }
        if (!Number.isSafeInteger(version) || version < 0) {
            throw new Error('决策库 schema_version 非法：' + String(version));
        }
        if (version > DECISION_SCHEMA_VERSION) {
            throw new Error('决策库版本 v' + version + ' 高于本 Bridge 支持 v' + DECISION_SCHEMA_VERSION + '，保持原文件不改动。');
        }
        if (version > 0 && version < DECISION_SCHEMA_VERSION && this.dbPath !== ':memory:') {
            this.backupPath = this.dbPath + '.pre-v' + DECISION_SCHEMA_VERSION + '-' + Date.now() + '-' + randomBytes(4).toString('hex') + '.bak';
            db.exec("VACUUM INTO '" + this.backupPath.replace(/'/g, "''") + "'");
            if (process.platform !== 'win32') {
                try { chmodSync(this.backupPath, 0o600); } catch { /* 尽力收紧权限 */ }
            }
            this.logger?.('warn', '决策库已升级并备份', { from: version, to: DECISION_SCHEMA_VERSION, backup: this.backupPath });
        }
        for (const statement of createStatements()) {
            db.exec(statement);
        }
        const existing = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as SqlRow | undefined;
        if (!existing) {
            db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(DECISION_SCHEMA_VERSION));
            db.prepare("INSERT INTO meta(key, value) VALUES('created_at', ?)").run(new Date().toISOString());
        } else if (Number(existing.value) !== DECISION_SCHEMA_VERSION) {
            db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(DECISION_SCHEMA_VERSION));
        }
        this.schemaVersion = DECISION_SCHEMA_VERSION;
    }

    // -----------------------------------------------------------------------
    // meta 与实例停止锁
    // -----------------------------------------------------------------------
    getMeta(key: string): string | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as SqlRow | undefined;
        return row ? asString(row.value) : null;
    }

    setMeta(key: string, value: string): void {
        const db = this.requireDb();
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    }

    isUserStopLatched(): { latched: boolean; reason: string | null } {
        const latched = this.getMeta(USER_STOP_KEY) === '1';
        const reason = this.getMeta(USER_STOP_REASON_KEY);
        return { latched, reason: latched ? reason : null };
    }

    setUserStopLatched(latched: boolean, reason: string | null): void {
        this.setMeta(USER_STOP_KEY, latched ? '1' : '0');
        if (latched) {
            this.setMeta(USER_STOP_REASON_KEY, (reason ?? '未注明原因').slice(0, 240));
        } else {
            this.setMeta(USER_STOP_REASON_KEY, '');
        }
    }

    // -----------------------------------------------------------------------
    // tasks（§08.1 / §16.1）
    // -----------------------------------------------------------------------
    private static serializeTask(record: TaskRecord): {
        definitionText: string; budgetText: string; mutable: TaskMutable;
    } {
        const definition = JSON.stringify({
            schemaVersion: 1,
            definition: record.definition,
            scope: record.scope,
            policySnapshot: record.policySnapshot,
            providerRef: record.providerRef,
        });
        if (jsonBytes(definition) > DEFINITION_JSON_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '任务定义超出存储上限。');
        }
        const budget = JSON.stringify({ schemaVersion: 1, budgetLimit: record.budgetLimit, budgetUsed: record.budgetUsed });
        if (jsonBytes(budget) > BUDGET_JSON_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '任务预算超出存储上限。');
        }
        return { definitionText: definition, budgetText: budget, mutable: DecisionStore.mutableOf(record) };
    }

    private static mutableOf(record: TaskRecord): TaskMutable {
        return {
            plan: record.plan,
            currentRunId: record.currentRunId,
            pauseReason: record.pauseReason,
            blocker: record.blocker,
            completion: record.completion,
            lastEvidenceSummary: record.lastEvidenceSummary,
            finalSummary: null,
        };
    }

    createTask(record: TaskRecord, finalSummary?: string | null): void {
        const db = this.requireDb();
        assertId(record.taskId, 'taskId');
        assertId(record.ownerClientId, 'ownerClientId');
        if (!isTaskState(record.state) || !isTaskPhase(record.phase)) {
            throw new BridgeError('INVALID_ARGUMENT', '任务状态或阶段非法。');
        }
        const { definitionText, budgetText, mutable } = DecisionStore.serializeTask(record);
        if (finalSummary !== undefined && finalSummary !== null) {
            mutable.finalSummary = finalSummary;
        }
        const resultText = JSON.stringify({ schemaVersion: 1, ...mutable });
        if (jsonBytes(resultText) > RESULT_JSON_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '任务结果区超出存储上限。');
        }
        db.prepare(
            'INSERT INTO tasks(task_id, owner_client_id, scope_key, definition_revision, state_version, state, phase,' +
            ' definition_json, budget_json, result_json, created_at, updated_at, archived)' +
            ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)'
        ).run(
            record.taskId, record.ownerClientId, record.scope.scopeKey, record.definitionRevision,
            record.stateVersion, record.state, record.phase,
            definitionText, budgetText, resultText, record.createdAt, record.updatedAt,
        );
    }

    loadTask(taskId: string): TaskRecord | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) as SqlRow | undefined;
        return row ? DecisionStore.rowToTask(row) : null;
    }

    /** 取终局摘要（仅存储扩展，TaskRecord 本体不含）。 */
    getFinalSummary(taskId: string): string | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT result_json FROM tasks WHERE task_id=?').get(taskId) as SqlRow | undefined;
        if (!row) return null;
        const text = asString(row.result_json);
        if (!text) return null;
        const parsed = parseJsonObject(text, 'tasks.result_json');
        return typeof parsed.finalSummary === 'string' ? parsed.finalSummary : null;
    }

    /**
     * CAS 写回：next.stateVersion 必须等于 expectedStateVersion + 1，
     * 且不得改 owner/scope/taskId/created_at。冲突抛 TASK_REVISION_CONFLICT。
     */
    updateTask(next: TaskRecord, expectedStateVersion: number): void {
        const db = this.requireDb();
        if (next.stateVersion !== expectedStateVersion + 1) {
            throw new BridgeError('TASK_REVISION_CONFLICT', 'updateTask 版本号不连续（TASK_REVISION_CONFLICT）：next 必须等于 expected+1。');
        }
        const current = db.prepare('SELECT owner_client_id, scope_key, created_at, result_json FROM tasks WHERE task_id=?').get(next.taskId) as SqlRow | undefined;
        if (!current) throw new BridgeError('NOT_FOUND', '任务不存在：' + next.taskId);
        if (asString(current.owner_client_id) !== next.ownerClientId || asString(current.scope_key) !== next.scope.scopeKey) {
            throw new BridgeError('TASK_SCOPE_CHANGED', '不允许变更任务归属或作用域。');
        }
        const { definitionText, budgetText, mutable } = DecisionStore.serializeTask(next);
        // 保留旧 finalSummary（updateTask 不覆盖终局摘要，除非显式走 setFinalSummary）
        const oldResultText = asString(current.result_json) ?? null;
        if (oldResultText) {
            try {
                const oldParsed = JSON.parse(oldResultText) as SqlRow;
                if (typeof oldParsed.finalSummary === 'string') mutable.finalSummary = oldParsed.finalSummary;
            } catch { /* 保留默认 null */ }
        }
        const resultText = JSON.stringify({ schemaVersion: 1, ...mutable });
        if (jsonBytes(resultText) > RESULT_JSON_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '任务结果区超出存储上限。');
        }
        const info = db.prepare(
            'UPDATE tasks SET definition_revision=?, state_version=?, state=?, phase=?, definition_json=?,' +
            ' budget_json=?, result_json=?, updated_at=? WHERE task_id=? AND state_version=?'
        ).run(
            next.definitionRevision, next.stateVersion, next.state, next.phase, definitionText,
            budgetText, resultText, next.updatedAt, next.taskId, expectedStateVersion,
        );
        if (Number(info.changes) !== 1) {
            throw new BridgeError('TASK_REVISION_CONFLICT', '任务状态版本冲突，请重新读取后提交。', { detail: { taskId: next.taskId } });
        }
    }

    /**
     * 只更新预算用量，不改变 state_version：Web 轮询能看到进行中的真实用量，
     * 又不会让 stardew_task_status(wait) 因“纯粹计费变化”被反复唤醒。
     */
    updateBudgetUsage(taskId: string, usage: BudgetUsage): void {
        const db = this.requireDb();
        const row = db.prepare('SELECT budget_json FROM tasks WHERE task_id=?').get(taskId) as SqlRow | undefined;
        if (!row) return;
        const text = asString(row.budget_json);
        const parsed = text ? parseJsonObject(text, 'tasks.budget_json') : null;
        if (!parsed) return;
        const next = JSON.stringify({ ...parsed, budgetUsed: usage });
        if (jsonBytes(next) > BUDGET_JSON_MAX_BYTES) return;
        db.prepare('UPDATE tasks SET budget_json=? WHERE task_id=?').run(next, taskId);
    }

    /** 终局摘要写入（runner 完成/失败/取消时调用一次）。 */
    setFinalSummary(taskId: string, summary: string): void {
        const db = this.requireDb();
        const row = db.prepare('SELECT result_json FROM tasks WHERE task_id=?').get(taskId) as SqlRow | undefined;
        if (!row) throw new BridgeError('NOT_FOUND', '任务不存在：' + taskId);
        const text = asString(row.result_json);
        const mutable: TaskMutable = text ? { ...EMPTY_MUTABLE, ...sanitizeMutable(parseJsonObject(text, 'tasks.result_json')) } : { ...EMPTY_MUTABLE };
        mutable.finalSummary = summary.slice(0, 2000);
        const next = JSON.stringify({ schemaVersion: 1, ...mutable });
        if (jsonBytes(next) > RESULT_JSON_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '终局摘要过大。');
        }
        db.prepare('UPDATE tasks SET result_json=?, updated_at=? WHERE task_id=?').run(next, new Date().toISOString(), taskId);
    }

    /** 归档（软删除）：任务与请求保留为 tombstone，未决动作与证据不删（§16.3）。 */
    archiveTask(taskId: string, at: string): void {
        const db = this.requireDb();
        this.transaction(() => {
            const info = db.prepare('UPDATE tasks SET archived=1, updated_at=? WHERE task_id=?').run(at, taskId);
            if (Number(info.changes) !== 1) throw new BridgeError('NOT_FOUND', '任务不存在：' + taskId);
            db.prepare('UPDATE task_requests SET tombstone=1 WHERE task_id=?').run(taskId);
        });
    }

    listTasks(ownerClientId: string, options: {
        states?: TaskState[];
        includeArchived?: boolean;
        limit: number;
        cursor?: string | null;
    }): TaskListPage {
        const db = this.requireDb();
        const limit = Math.max(1, Math.min(50, Math.trunc(options.limit)));
        const clauses: string[] = ['owner_client_id=?'];
        const params: (string | number)[] = [ownerClientId];
        if (!options.includeArchived) clauses.push('archived=0');
        if (options.states && options.states.length > 0) {
            const bad = options.states.filter((s) => !isTaskState(s));
            if (bad.length > 0) throw new BridgeError('INVALID_ARGUMENT', '非法状态过滤：' + bad.join(','));
            clauses.push('state IN (' + options.states.map(() => '?').join(',') + ')');
            params.push(...options.states);
        }
        if (options.cursor) {
            const decoded = decodeCursor(options.cursor);
            const r = decoded ? Number(decoded.r) : Number.NaN;
            if (!Number.isSafeInteger(r) || r <= 0) throw new BridgeError('INVALID_ARGUMENT', '分页游标非法。');
            clauses.push('rowid < ?');
            params.push(r);
        }
        const rows = db.prepare(
            'SELECT rowid AS _rowid, * FROM tasks WHERE ' + clauses.join(' AND ') + ' ORDER BY rowid DESC LIMIT ?'
        ).all(...params, limit + 1) as SqlRow[];
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const tasks: TaskRecord[] = [];
        const finalSummaries: Record<string, string> = {};
        for (const row of page) {
            const task = DecisionStore.rowToTask(row);
            tasks.push(task);
            const resultText = asString(row.result_json);
            if (resultText) {
                try {
                    const parsed = JSON.parse(resultText) as SqlRow;
                    if (typeof parsed.finalSummary === 'string' && parsed.finalSummary.length > 0) {
                        finalSummaries[task.taskId] = parsed.finalSummary;
                    }
                } catch { /* 列表不因单行损坏而失败 */ }
            }
        }
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? encodeCursor({ r: asNumber(last._rowid) }) : null;
        return { tasks, finalSummaries, nextCursor };
    }

    /** Web 管理员视图：跨 owner 列出（仅由已认证 Web 会话调用）。 */
    listAllTasks(options: {
        states?: TaskState[];
        includeArchived?: boolean;
        limit: number;
        cursor?: string | null;
    }): TaskListPage {
        const db = this.requireDb();
        const limit = Math.max(1, Math.min(50, Math.trunc(options.limit)));
        const clauses: string[] = ['1=1'];
        const params: (string | number)[] = [];
        if (!options.includeArchived) clauses.push('archived=0');
        if (options.states && options.states.length > 0) {
            const bad = options.states.filter((s) => !isTaskState(s));
            if (bad.length > 0) throw new BridgeError('INVALID_ARGUMENT', '非法状态过滤：' + bad.join(','));
            clauses.push('state IN (' + options.states.map(() => '?').join(',') + ')');
            params.push(...options.states);
        }
        if (options.cursor) {
            const decoded = decodeCursor(options.cursor);
            const r = decoded ? Number(decoded.r) : Number.NaN;
            if (!Number.isSafeInteger(r) || r <= 0) throw new BridgeError('INVALID_ARGUMENT', '分页游标非法。');
            clauses.push('rowid < ?');
            params.push(r);
        }
        const rows = db.prepare(
            'SELECT rowid AS _rowid, * FROM tasks WHERE ' + clauses.join(' AND ') + ' ORDER BY rowid DESC LIMIT ?'
        ).all(...params, limit + 1) as SqlRow[];
        return DecisionStore.toPage(rows, limit);
    }

    /** 列表分页的共用装配：避免两套分页口径。 */
    private static toPage(rows: SqlRow[], limit: number): TaskListPage {
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const tasks: TaskRecord[] = [];
        const finalSummaries: Record<string, string> = {};
        for (const row of page) {
            const task = DecisionStore.rowToTask(row);
            tasks.push(task);
            const resultText = asString(row.result_json);
            if (resultText) {
                try {
                    const parsed = JSON.parse(resultText) as SqlRow;
                    if (typeof parsed.finalSummary === 'string' && parsed.finalSummary.length > 0) {
                        finalSummaries[task.taskId] = parsed.finalSummary;
                    }
                } catch { /* 列表不因单行损坏而失败 */ }
            }
        }
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? encodeCursor({ r: asNumber(last._rowid) }) : null;
        return { tasks, finalSummaries, nextCursor };
    }

    static rowToTask(row: SqlRow): TaskRecord {        const definitionText = asString(row.definition_json);
        const budgetText = asString(row.budget_json);
        if (!definitionText || !budgetText) {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '任务行缺少 definition/budget。');
        }
        const defEnv = parseJsonObject(definitionText, 'tasks.definition_json');
        const budgetEnv = parseJsonObject(budgetText, 'tasks.budget_json');
        if (defEnv.schemaVersion !== 1 || budgetEnv.schemaVersion !== 1) {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '任务 JSON 封装版本不受支持。');
        }
        const scope = defEnv.scope as TaskScope | undefined;
        const definition = defEnv.definition as TaskDefinition | undefined;
        const policySnapshot = defEnv.policySnapshot as PolicySnapshotView | undefined;
        if (!scope || !definition || !policySnapshot || typeof defEnv.providerRef !== 'string') {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '任务定义缺少必要字段。');
        }
        const resultText = asString(row.result_json);
        let mutable: TaskMutable = { ...EMPTY_MUTABLE };
        if (resultText) {
            try {
                mutable = { ...EMPTY_MUTABLE, ...sanitizeMutable(parseJsonObject(resultText, 'tasks.result_json')) };
            } catch {
                throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '任务结果区损坏：' + String(row.task_id));
            }
        }
        const state = asString(row.state);
        const phase = asString(row.phase);
        if (!isTaskState(state) || !isTaskPhase(phase)) {
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '任务状态字段损坏：' + String(row.task_id));
        }
        const record: TaskRecord = {
            schemaVersion: 1,
            taskId: String(row.task_id),
            ownerClientId: String(row.owner_client_id),
            definition,
            definitionRevision: asNumber(row.definition_revision),
            stateVersion: asNumber(row.state_version),
            state,
            phase,
            scope,
            policySnapshot,
            providerRef: defEnv.providerRef,
            budgetLimit: budgetEnv.budgetLimit as TaskRecord['budgetLimit'],
            budgetUsed: budgetEnv.budgetUsed as BudgetUsage,
            plan: mutable.plan,
            currentRunId: mutable.currentRunId,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            pauseReason: mutable.pauseReason,
            blocker: mutable.blocker,
            completion: mutable.completion,
            lastEvidenceSummary: mutable.lastEvidenceSummary,
        };
        return record;
    }

    // -----------------------------------------------------------------------
    // runs
    // -----------------------------------------------------------------------
    insertRun(run: RunRow): void {
        const db = this.requireDb();
        assertId(run.runId, 'runId');
        assertId(run.taskId, 'taskId');
        if (!RUN_STATES.has(run.state)) throw new BridgeError('INVALID_ARGUMENT', 'run 状态非法。');
        db.prepare(
            'INSERT INTO runs(run_id, task_id, generation, state, provider_id, provider_config_revision, policy_revision,' +
            ' internal_client_id, control_session_id, start_reason, end_reason, started_at, ended_at)' +
            ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
            run.runId, run.taskId, run.generation, run.state, run.providerId, run.providerConfigRevision,
            run.policyRevision, run.internalClientId, run.controlSessionId, run.startReason,
            run.endReason, run.startedAt, run.endedAt,
        );
    }

    getRun(runId: string): RunRow | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) as SqlRow | undefined;
        return row ? DecisionStore.rowToRun(row) : null;
    }

    latestActiveRun(taskId: string): RunRow | null {
        const db = this.requireDb();
        const row = db.prepare("SELECT * FROM runs WHERE task_id=? AND state='active' ORDER BY generation DESC LIMIT 1").get(taskId) as SqlRow | undefined;
        return row ? DecisionStore.rowToRun(row) : null;
    }

    listRuns(taskId: string, limit = 20): RunRow[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY generation DESC LIMIT ?').all(taskId, Math.max(1, Math.min(100, limit))) as SqlRow[];
        return rows.map(DecisionStore.rowToRun);
    }

    /** run 绑定内部控件会话：只在取得会话后写一次，供重启后审计。 */
    updateRunControl(runId: string, controlSessionId: string | null): void {
        const db = this.requireDb();
        db.prepare('UPDATE runs SET control_session_id=? WHERE run_id=?').run(controlSessionId, runId);
    }

    /** 记录本次 run 实际使用的 provider 配置版本，便于复现“当时用的是哪份配置”。 */
    updateRunProvider(runId: string, providerId: string, providerConfigRevision: number): void {
        const db = this.requireDb();
        db.prepare('UPDATE runs SET provider_id=?, provider_config_revision=? WHERE run_id=?')
            .run(providerId, providerConfigRevision, runId);
    }

    endRun(runId: string, state: 'ended' | 'aborted', endReason: string, endedAt: string): void {        const db = this.requireDb();
        db.prepare("UPDATE runs SET state=?, end_reason=?, ended_at=? WHERE run_id=? AND state='active'").run(state, endReason.slice(0, 240), endedAt, runId);
    }

    static rowToRun(row: SqlRow): RunRow {
        return {
            runId: String(row.run_id),
            taskId: String(row.task_id),
            generation: asNumber(row.generation),
            state: asString(row.state) as RunState,
            providerId: String(row.provider_id),
            providerConfigRevision: asNumber(row.provider_config_revision),
            policyRevision: asNumber(row.policy_revision),
            internalClientId: String(row.internal_client_id),
            controlSessionId: asString(row.control_session_id),
            startReason: String(row.start_reason),
            endReason: asString(row.end_reason),
            startedAt: String(row.started_at),
            endedAt: asString(row.ended_at),
        };
    }

    // -----------------------------------------------------------------------
    // executor_slot：单执行槽（§16.1 阻止双任务并发占位）
    // -----------------------------------------------------------------------
    tryAcquireSlot(taskId: string, generation: number, at: string): boolean {
        const db = this.requireDb();
        return this.transaction(() => {
            const row = db.prepare('SELECT task_id, generation FROM executor_slot WHERE id=1').get() as SqlRow | undefined;
            if (!row) {
                db.prepare('INSERT INTO executor_slot(id, task_id, generation, acquired_at) VALUES(1,?,?,?)').run(taskId, generation, at);
                return true;
            }
            if (asString(row.task_id) === taskId) {
                const old = asNumber(row.generation);
                if (generation >= old) {
                    db.prepare('UPDATE executor_slot SET generation=?, acquired_at=? WHERE id=1').run(generation, at);
                }
                return true;
            }
            return false;
        });
    }

    releaseSlot(taskId: string, generation: number): boolean {
        const db = this.requireDb();
        const info = db.prepare('DELETE FROM executor_slot WHERE id=1 AND task_id=? AND generation=?').run(taskId, generation);
        return Number(info.changes) === 1;
    }

    currentSlot(): SlotInfo | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT task_id, generation, acquired_at FROM executor_slot WHERE id=1').get() as SqlRow | undefined;
        if (!row) return null;
        return { taskId: String(row.task_id), generation: asNumber(row.generation), acquiredAt: String(row.acquired_at) };
    }

    clearSlot(): void {
        const db = this.requireDb();
        db.prepare('DELETE FROM executor_slot').run();
    }

    // -----------------------------------------------------------------------
    // task_steps（计划的服务器侧副本）
    // -----------------------------------------------------------------------
    replaceSteps(taskId: string, steps: TaskPlanStep[]): void {
        const db = this.requireDb();
        this.transaction(() => {
            db.prepare('DELETE FROM task_steps WHERE task_id=?').run(taskId);
            const insert = db.prepare('INSERT INTO task_steps(task_id, step_id, seq, title, done_when, status, evidence_ids_json) VALUES(?,?,?,?,?,?,?)');
            steps.forEach((step, index) => {
                assertId(step.stepId, 'stepId');
                if (!STEP_STATUSES.has(step.status)) throw new BridgeError('INVALID_ARGUMENT', '步骤状态非法。');
                const evidenceText = JSON.stringify(step.evidenceIds ?? []);
                if (jsonBytes(evidenceText) > STEP_EVIDENCE_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '步骤证据列表过大。');
                insert.run(taskId, step.stepId, index + 1, step.title.slice(0, 400), step.doneWhen.slice(0, 1000), step.status, evidenceText);
            });
        });
    }

    loadSteps(taskId: string): TaskPlanStep[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY seq ASC').all(taskId) as SqlRow[];
        return rows.map((row) => {
            let evidenceIds: string[] = [];
            try {
                const parsed: unknown = JSON.parse(asString(row.evidence_ids_json) ?? '[]');
                if (Array.isArray(parsed)) evidenceIds = parsed.filter((x): x is string => typeof x === 'string');
            } catch { /* 视为空证据 */ }
            return {
                stepId: String(row.step_id),
                title: String(row.title),
                doneWhen: String(row.done_when),
                status: asString(row.status) as StepStatus,
                evidenceIds,
            };
        });
    }

    updateStepStatus(taskId: string, stepId: string, status: StepStatus, evidenceIds: string[]): void {
        const db = this.requireDb();
        if (!STEP_STATUSES.has(status)) throw new BridgeError('INVALID_ARGUMENT', '步骤状态非法。');
        const text = JSON.stringify(evidenceIds);
        if (jsonBytes(text) > STEP_EVIDENCE_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '步骤证据列表过大。');
        db.prepare('UPDATE task_steps SET status=?, evidence_ids_json=? WHERE task_id=? AND step_id=?').run(status, text, taskId, stepId);
    }

    // -----------------------------------------------------------------------
    // task_events（SSE 重放与 wait 判定用；只存脱敏小摘要）
    // -----------------------------------------------------------------------
    appendEvent(taskId: string, kind: string, options: { runId?: string | null; payload?: Record<string, unknown> | null } = {}): number {
        const db = this.requireDb();
        assertId(taskId, 'taskId');
        const payloadText = options.payload === undefined || options.payload === null ? null : JSON.stringify(options.payload);
        if (payloadText !== null && jsonBytes(payloadText) > EVENT_PAYLOAD_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', '事件载荷超过 4 KiB 上限，必须改为摘要。');
        }
        const info = db.prepare('INSERT INTO task_events(task_id, run_id, kind, payload_json, at) VALUES(?,?,?,?,?)')
            .run(taskId, options.runId ?? null, kind.slice(0, 80), payloadText, new Date().toISOString());
        return Number(info.lastInsertRowid);
    }

    maxEventId(): number {
        const db = this.requireDb();
        const row = db.prepare('SELECT MAX(id) AS m FROM task_events').get() as SqlRow | undefined;
        return row ? asNumber(row.m) : 0;
    }

    listEvents(taskId: string, afterId: number, limit = 50): DecisionEventRow[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?')
            .all(taskId, afterId, Math.max(1, Math.min(200, limit))) as SqlRow[];
        return rows.map((row) => {
            let payload: Record<string, unknown> | null = null;
            const text = asString(row.payload_json);
            if (text) {
                try {
                    const parsed: unknown = JSON.parse(text);
                    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
                } catch { /* 损坏载荷按空处理 */ }
            }
            return {
                id: asNumber(row.id),
                taskId: String(row.task_id),
                runId: asString(row.run_id),
                kind: String(row.kind),
                payload,
                at: String(row.at),
            };
        });
    }

    // -----------------------------------------------------------------------
    // action_links（§10.3 写动作事务的服务端侧记录）
    // -----------------------------------------------------------------------
    insertActionPrepared(input: {
        runId: string; attemptNo: number; taskId: string; actionId: string;
        toolName: string; argsHash: string; observationId: string | null; stepId: string | null; at: string;
    }): { inserted: boolean; row: ActionLinkRow } {
        const db = this.requireDb();
        assertId(input.actionId, 'actionId');
        return this.transaction(() => {
            const existing = this.getActionLink(input.runId, input.attemptNo);
            if (existing) return { inserted: false, row: existing };
            db.prepare(
                'INSERT INTO action_links(run_id, attempt_no, task_id, action_id, tool_name, args_hash, dispatch_state, receipt_json, observation_id, step_id, created_at, updated_at)' +
                ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
            ).run(
                input.runId, input.attemptNo, input.taskId, input.actionId, input.toolName, input.argsHash,
                'prepared', null, input.observationId, input.stepId, input.at, input.at,
            );
            const row = this.getActionLink(input.runId, input.attemptNo);
            if (!row) throw new BridgeError('INTERNAL_ERROR', 'action_link 插入后不可见。');
            return { inserted: true, row };
        });
    }

    getActionLink(runId: string, attemptNo: number): ActionLinkRow | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM action_links WHERE run_id=? AND attempt_no=?').get(runId, attemptNo) as SqlRow | undefined;
        return row ? DecisionStore.rowToActionLink(row) : null;
    }

    findActionLinkByActionId(actionId: string): ActionLinkRow | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM action_links WHERE action_id=? LIMIT 1').get(actionId) as SqlRow | undefined;
        return row ? DecisionStore.rowToActionLink(row) : null;
    }

    markActionReceipted(runId: string, attemptNo: number, receipt: ActionReceipt, at: string): void {
        const db = this.requireDb();
        const text = JSON.stringify(receipt);
        if (jsonBytes(text) > RECEIPT_JSON_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '收据摘要过大。');
        db.prepare("UPDATE action_links SET dispatch_state='receipted', receipt_json=?, updated_at=? WHERE run_id=? AND attempt_no=?")
            .run(text, at, runId, attemptNo);
    }

    markActionState(runId: string, attemptNo: number, state: 'unknown' | 'stale', at: string): void {
        const db = this.requireDb();
        if (!DISPATCH_STATES.has(state)) throw new BridgeError('INVALID_ARGUMENT', '派发状态非法。');
        db.prepare('UPDATE action_links SET dispatch_state=?, updated_at=? WHERE run_id=? AND attempt_no=?')
            .run(state, at, runId, attemptNo);
    }

    setActionObservation(runId: string, attemptNo: number, observationId: string, at: string): void {
        const db = this.requireDb();
        db.prepare('UPDATE action_links SET observation_id=?, updated_at=? WHERE run_id=? AND attempt_no=?')
            .run(observationId, at, runId, attemptNo);
    }

    listActionLinksForTask(taskId: string, limit = 50): ActionLinkRow[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM action_links WHERE task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT ?')
            .all(taskId, Math.max(1, Math.min(200, limit))) as SqlRow[];
        return rows.map(DecisionStore.rowToActionLink);
    }

    /** 未决（prepared/unknown）动作 ID：完成判定与 resolve 都必须带上（§14/§16.3）。 */
    unresolvedActionIdsForTask(taskId: string): string[] {
        const db = this.requireDb();
        const rows = db.prepare("SELECT action_id FROM action_links WHERE task_id=? AND dispatch_state IN('prepared','unknown')").all(taskId) as SqlRow[];
        return rows.map((row) => String(row.action_id));
    }

    static rowToActionLink(row: SqlRow): ActionLinkRow {
        let receipt: ActionReceipt | null = null;
        const text = asString(row.receipt_json);
        if (text) {
            try {
                receipt = JSON.parse(text) as ActionReceipt;
            } catch { /* 损坏收据摘要按未决处理 */ }
        }
        return {
            runId: String(row.run_id),
            attemptNo: asNumber(row.attempt_no),
            taskId: String(row.task_id),
            actionId: String(row.action_id),
            toolName: String(row.tool_name),
            argsHash: String(row.args_hash),
            dispatchState: asString(row.dispatch_state) as DispatchState,
            receipt,
            observationId: asString(row.observation_id),
            stepId: asString(row.step_id),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        };
    }

    // -----------------------------------------------------------------------
    // observations（每轮新鲜快照的摘要/结构化证据，不存完整模型响应）
    // -----------------------------------------------------------------------
    insertObservation(row: ObservationRow): void {
        const db = this.requireDb();
        assertId(row.observationId, 'observationId');
        if (jsonBytes(row.payloadJson) > OBSERVATION_PAYLOAD_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '观察载荷超过 32 KiB。');
        if (row.dateJson !== null && jsonBytes(row.dateJson) > OBSERVATION_META_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '观察日期元数据过大。');
        if (row.coverageJson !== null && jsonBytes(row.coverageJson) > OBSERVATION_META_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '观察覆盖元数据过大。');
        db.prepare(
            'INSERT INTO observations(observation_id, task_id, run_id, scope_key, instance_id, world_generation, scene_generation, date_json, coverage_json, payload_json, at)' +
            ' VALUES(?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
            row.observationId, row.taskId, row.runId, row.scopeKey, row.instanceId, row.worldGeneration,
            row.sceneGeneration, row.dateJson, row.coverageJson, row.payloadJson, row.at,
        );
    }

    getObservation(observationId: string): ObservationRow | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM observations WHERE observation_id=?').get(observationId) as SqlRow | undefined;
        return row ? DecisionStore.rowToObservation(row) : null;
    }

    listObservationsForRun(runId: string, limit = 20): ObservationRow[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM observations WHERE run_id=? ORDER BY at DESC LIMIT ?').all(runId, Math.max(1, Math.min(100, limit))) as SqlRow[];
        return rows.map(DecisionStore.rowToObservation);
    }

    static rowToObservation(row: SqlRow): ObservationRow {
        return {
            observationId: String(row.observation_id),
            taskId: asString(row.task_id),
            runId: asString(row.run_id),
            scopeKey: String(row.scope_key),
            instanceId: String(row.instance_id),
            worldGeneration: asNumber(row.world_generation),
            sceneGeneration: asNumber(row.scene_generation),
            dateJson: asString(row.date_json),
            coverageJson: asString(row.coverage_json),
            payloadJson: String(row.payload_json),
            at: String(row.at),
        };
    }

    // -----------------------------------------------------------------------
    // model_calls（§28.1 埋点；不存 Key/隐藏推理/原始响应）
    // -----------------------------------------------------------------------
    insertModelCall(row: ModelCallRow): void {
        const db = this.requireDb();
        assertId(row.callId, 'callId');
        db.prepare(
            'INSERT INTO model_calls(call_id, task_id, run_id, generation, provider_id, provider_config_revision,' +
            ' reserved_tokens, usage_json, usage_unknown, status, error_code, latency_ms, started_at, ended_at)' +
            ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
            row.callId, row.taskId, row.runId, row.generation, row.providerId, row.providerConfigRevision,
            row.reservedTokens, row.usageJson, row.usageUnknown ? 1 : 0, row.status, row.errorCode,
            row.latencyMs, row.startedAt, row.endedAt,
        );
    }

    finishModelCall(callId: string, finish: {
        status: ModelCallStatus; usageJson: string | null; usageUnknown: boolean;
        errorCode: string | null; latencyMs: number | null; endedAt: string;
    }): void {
        const db = this.requireDb();
        if (finish.usageJson !== null && jsonBytes(finish.usageJson) > MODEL_USAGE_MAX_BYTES) {
            throw new BridgeError('INVALID_ARGUMENT', 'usage 摘要过大。');
        }
        db.prepare('UPDATE model_calls SET status=?, usage_json=?, usage_unknown=?, error_code=?, latency_ms=?, ended_at=? WHERE call_id=?')
            .run(finish.status, finish.usageJson, finish.usageUnknown ? 1 : 0, finish.errorCode, finish.latencyMs, finish.endedAt, callId);
    }

    listModelCallsForTask(taskId: string, limit = 50): ModelCallRow[] {
        const db = this.requireDb();
        const rows = db.prepare('SELECT * FROM model_calls WHERE task_id=? ORDER BY started_at DESC LIMIT ?').all(taskId, Math.max(1, Math.min(200, limit))) as SqlRow[];
        return rows.map((row) => ({
            callId: String(row.call_id),
            taskId: String(row.task_id),
            runId: String(row.run_id),
            generation: asNumber(row.generation),
            providerId: String(row.provider_id),
            providerConfigRevision: asNumber(row.provider_config_revision),
            reservedTokens: asNumber(row.reserved_tokens),
            usageJson: asString(row.usage_json),
            usageUnknown: asBool(row.usage_unknown),
            status: asString(row.status) as ModelCallStatus,
            errorCode: asString(row.error_code),
            latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : asNumber(row.latency_ms),
            startedAt: String(row.started_at),
            endedAt: asString(row.ended_at),
        }));
    }

    // -----------------------------------------------------------------------
    // task_requests（幂等：none / same / conflict；tombstone 永不复活，§16.3）
    // -----------------------------------------------------------------------
    lookupRequest(ownerClientId: string, requestId: string): StoredRequest | null {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM task_requests WHERE owner_client_id=? AND request_id=?').get(ownerClientId, requestId) as SqlRow | undefined;
        return row ? DecisionStore.rowToRequest(row) : null;
    }

    reserveRequest(input: {
        ownerClientId: string; requestId: string; operation: TaskOperation;
        taskId: string | null; canonicalHash: string; createdAt: string;
    }): ReserveRequestResult {
        const db = this.requireDb();
        assertId(input.requestId, 'requestId');
        return this.transaction(() => {
            const existing = this.lookupRequest(input.ownerClientId, input.requestId);
            if (existing) {
                if (existing.operation === input.operation && existing.canonicalHash === input.canonicalHash) {
                    return { kind: 'same' as const, request: existing };
                }
                return { kind: 'conflict' as const, request: existing };
            }
            db.prepare(
                'INSERT INTO task_requests(owner_client_id, request_id, operation, task_id, canonical_hash, result_json, created_at, tombstone)' +
                ' VALUES(?,?,?,?,?,?,?,0)'
            ).run(input.ownerClientId, input.requestId, input.operation, input.taskId, input.canonicalHash, null, input.createdAt);
            const created = this.lookupRequest(input.ownerClientId, input.requestId);
            if (!created) throw new BridgeError('INTERNAL_ERROR', 'request 预留后不可见。');
            return { kind: 'none' as const, request: created };
        });
    }

    setRequestResult(ownerClientId: string, requestId: string, result: Record<string, unknown>): void {
        const db = this.requireDb();
        const text = JSON.stringify(result);
        if (jsonBytes(text) > REQUEST_RESULT_MAX_BYTES) throw new BridgeError('INVALID_ARGUMENT', '幂等结果超出 64 KiB。');
        db.prepare('UPDATE task_requests SET result_json=? WHERE owner_client_id=? AND request_id=?').run(text, ownerClientId, requestId);
    }

    getRequestResult(ownerClientId: string, requestId: string): Record<string, unknown> | null {
        const request = this.lookupRequest(ownerClientId, requestId);
        return request ? request.resultJson : null;
    }

    static rowToRequest(row: SqlRow): StoredRequest {
        let resultJson: Record<string, unknown> | null = null;
        const text = asString(row.result_json);
        if (text) {
            try {
                const parsed: unknown = JSON.parse(text);
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) resultJson = parsed as Record<string, unknown>;
            } catch { /* 损坏结果按空处理，重放方将重新执行 */ }
        }
        return {
            ownerClientId: String(row.owner_client_id),
            requestId: String(row.request_id),
            operation: String(row.operation) as TaskOperation,
            taskId: asString(row.task_id),
            canonicalHash: String(row.canonical_hash),
            resultJson,
            createdAt: String(row.created_at),
            tombstone: asBool(row.tombstone),
        };
    }

    // -----------------------------------------------------------------------
    // 启动恢复（§16.3）：queued/running/pausing → needs_review；活动 run 标 aborted
    // -----------------------------------------------------------------------
    recoverOnStartup(): StartupRecovery {
        const db = this.requireDb();
        const at = new Date().toISOString();
        return this.transaction(() => {
            const rows = db.prepare(
                "SELECT task_id, state_version, result_json FROM tasks WHERE state IN('queued','running','pausing') AND archived=0"
            ).all() as SqlRow[];
            const recoveredTaskIds: string[] = [];
            for (const row of rows) {
                const taskId = String(row.task_id);
                let mutable: TaskMutable = { ...EMPTY_MUTABLE };
                const text = asString(row.result_json);
                if (text) {
                    try {
                        mutable = { ...EMPTY_MUTABLE, ...sanitizeMutable(parseJsonObject(text, 'tasks.result_json')) };
                    } catch { /* 损坏结果区以默认值继续恢复，证据保留在其它表 */ }
                }
                mutable.currentRunId = null;
                mutable.blocker = {
                    code: 'RESULT_UNKNOWN',
                    summary: 'Bridge 重启：任务转入 needs_review；旧控制权与未决动作需复核后恢复，不自动重放。',
                    evidenceIds: [],
                    raisedAt: at,
                };
                const next = JSON.stringify({ schemaVersion: 1, ...mutable });
                db.prepare("UPDATE tasks SET state='needs_review', phase='idle', state_version=?, result_json=?, updated_at=? WHERE task_id=?")
                    .run(asNumber(row.state_version) + 1, next, at, taskId);
                db.prepare('INSERT INTO task_events(task_id, run_id, kind, payload_json, at) VALUES(?,?,?,?,?)')
                    .run(taskId, null, 'bridge_restart_needs_review', JSON.stringify({ blocker: mutable.blocker.summary }), at);
                recoveredTaskIds.push(taskId);
            }
            const runInfo = db.prepare("UPDATE runs SET state='aborted', end_reason='bridge_restart', ended_at=? WHERE state='active'").run(at);
            db.prepare('DELETE FROM executor_slot').run();
            return { recoveredTaskIds, abortedRuns: Number(runInfo.changes) };
        });
    }
}

function sanitizeMutable(parsed: SqlRow): Partial<TaskMutable> {
    const out: Partial<TaskMutable> = {};
    if (Array.isArray(parsed.plan)) {
        out.plan = (parsed.plan as unknown[]).filter((x): x is TaskPlanStep =>
            x !== null && typeof x === 'object' && typeof (x as TaskPlanStep).stepId === 'string');
    } else if (parsed.plan === null) {
        out.plan = null;
    }
    out.currentRunId = typeof parsed.currentRunId === 'string' ? parsed.currentRunId : null;
    out.pauseReason = typeof parsed.pauseReason === 'string' ? parsed.pauseReason : null;
    out.blocker = parsed.blocker !== null && typeof parsed.blocker === 'object' ? parsed.blocker as TaskBlocker : null;
    out.completion = parsed.completion !== null && typeof parsed.completion === 'object' ? parsed.completion as TaskCompletion : null;
    out.lastEvidenceSummary = typeof parsed.lastEvidenceSummary === 'string' ? parsed.lastEvidenceSummary : null;
    out.finalSummary = typeof parsed.finalSummary === 'string' ? parsed.finalSummary : null;
    return out;
}

function assertId(value: string, what: string): void {
    if (!isDecisionId(value)) {
        throw new BridgeError('INVALID_ARGUMENT', what + ' 非法或超长。');
    }
}

/** 供 task-service 复用的阶段/状态检查别名（不改变导出面）。 */
export function isKnownPhase(value: unknown): value is TaskPhase {
    return isTaskPhase(value);
}
