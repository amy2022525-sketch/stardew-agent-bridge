/**
 * 动作账本（SQLite，单写入者）。
 *
 * 只保存控制与观测记录，不承担游戏存档功能。写入顺序：
 *   记录意图 → 派发游戏动作 → 保存最终收据
 * 账本不可写时必须在派发前拒绝新写动作。
 *
 * 墓碑语义：同一 dedupKey 一旦写入（无论终态如何）就永不重新执行；
 * 终态缓存可以淘汰，墓碑不会。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BridgeError, buildReceipt, makeFault, isActorContext, type ActorContext, type ActionReceipt, type ActionStatus, type Checkpoint, type SessionMode, type SessionState } from '@sab/contracts';

export const LEDGER_SCHEMA_VERSION = 2;

export interface LedgerLogger {
    (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

export interface ActionRow {
    actorContext?: ActorContext;
    dedupKey: string;
    actionId: string;
    signature: string;
    command: string;
    clientId: string;
    controlSessionId: string | null;
    gameInstanceId: string;
    worldGeneration: number;
    status: ActionStatus;
    intentAt: string;
    finishedAt: string | null;
    receipt: ActionReceipt | null;
}

export interface RecordIntentInput {
    actorContext?: ActorContext;
    dedupKey: string;
    actionId: string;
    signature: string;
    command: string;
    clientId: string;
    controlSessionId: string | null;
    gameInstanceId: string;
    worldGeneration: number;
    intentAt: string;
}

export interface IntentLookup {
    kind: 'none' | 'same' | 'conflict';
    row?: ActionRow;
}

export interface LedgerEvent {
    at: string;
    kind: string;
    clientId: string | null;
    controlSessionId: string | null;
    actionId: string | null;
    payload: Record<string, unknown> | null;
}

export interface SessionRow {
    actorContext?: ActorContext | null;
    controlSessionId: string;
    clientId: string;
    clientName: string;
    state: SessionState;
    mode: SessionMode;
    leaseEpoch: number;
    gameInstanceId: string | null;
    worldGeneration: number | null;
    startedAt: string;
    lastActivityAt: string;
    expiresAt: string | null;
    closedAt: string | null;
    closeReason: string | null;
    checkpoint: Checkpoint | null;
}

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
}

export class ActionLedger {
    private db: DatabaseSync | null = null;
    private readonly logger?: LedgerLogger;
    private readonly limit: number;
    writable = false;
    lastError: string | null = null;
    schemaVersion = 0;
    backupPath: string | null = null;

    constructor(path: string, options: { limit?: number; logger?: LedgerLogger } = {}) {
        this.logger = options.logger;
        this.limit = options.limit ?? 65_536;
        try {
            this.db = new DatabaseSync(path);
            this.db.exec('PRAGMA synchronous = FULL;');
            this.migrate(path);
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.writable = true;
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.logger?.('error', `动作账本不可用：${this.lastError}`, { path });
            try { this.db?.close(); } catch { /* keep original error */ }
            this.db = null;
            this.writable = false;
        }
    }

    private requireDb(): DatabaseSync {
        if (!this.db || !this.writable) {
            throw new BridgeError('JOURNAL_UNAVAILABLE', this.lastError ?? '动作账本不可写，已拒绝派发写动作。');
        }
        return this.db;
    }

    private migrate(path: string): void {
        const db = this.db;
        if (!db) return;
        const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
        const previous = meta ? db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as SqlRow | undefined : undefined;
        const version = previous ? Number(previous.value) : 0;
        if (!Number.isSafeInteger(version) || version < 0 || version > LEDGER_SCHEMA_VERSION) throw new Error('Unsupported ledger schema; migration refused.');
        if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='actions'").get()) throw new Error('Unversioned existing ledger; migration refused.');
        if (version === 1 && path !== ':memory:') {
            const backup = `${path}.pre-mp-v2.${Date.now()}-${randomUUID()}.sqlite`;
            // VACUUM INTO includes committed WAL data and produces a consistent snapshot.
            db.prepare('VACUUM INTO ?').run(backup);
            if (process.platform !== 'win32') chmodSync(backup, 0o600);
            this.backupPath = backup;
            this.logger?.('info', '账本 v1 升级前的一致性备份已创建', { backupPath: backup });
        }
        db.exec('BEGIN IMMEDIATE');
        try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS actions (
                dedup_key TEXT PRIMARY KEY,
                action_id TEXT NOT NULL,
                signature TEXT NOT NULL,
                command TEXT NOT NULL,
                client_id TEXT NOT NULL,
                control_session_id TEXT,
                game_instance_id TEXT NOT NULL,
                world_generation INTEGER NOT NULL,
                status TEXT NOT NULL,
                intent_at TEXT NOT NULL,
                finished_at TEXT,
                receipt TEXT,
                reconcilations TEXT
            );
            CREATE INDEX IF NOT EXISTS actions_action_id ON actions(action_id);
            CREATE INDEX IF NOT EXISTS actions_world ON actions(game_instance_id, world_generation);
            CREATE TABLE IF NOT EXISTS sessions (
                control_session_id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                client_name TEXT NOT NULL,
                state TEXT NOT NULL,
                mode TEXT NOT NULL,
                lease_epoch INTEGER NOT NULL,
                game_instance_id TEXT,
                world_generation INTEGER,
                started_at TEXT NOT NULL,
                last_activity_at TEXT NOT NULL,
                expires_at TEXT,
                closed_at TEXT,
                close_reason TEXT,
                checkpoint TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                kind TEXT NOT NULL,
                client_id TEXT,
                control_session_id TEXT,
                action_id TEXT,
                payload TEXT
            );
        `);
        for (const table of ['actions', 'sessions']) {
            const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map(r => r.name));
            if (!columns.has('actor_context')) db.exec(`ALTER TABLE ${table} ADD COLUMN actor_context TEXT`);
            if (table === 'actions') {
                if (!columns.has('world_id')) db.exec('ALTER TABLE actions ADD COLUMN world_id TEXT');
                if (!columns.has('actor_farmer_id')) db.exec('ALTER TABLE actions ADD COLUMN actor_farmer_id TEXT');
            }
        }
        db.exec('CREATE INDEX IF NOT EXISTS actions_actor_scope ON actions(client_id, world_id, actor_farmer_id, action_id)');
        db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run('schema_version', String(LEDGER_SCHEMA_VERSION));
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as SqlRow | undefined;
        this.schemaVersion = asNumber(row?.value);
        db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    }

    countActions(): number {
        if (!this.db) return 0;
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM actions').get() as SqlRow | undefined;
            return asNumber(row?.n);
        } catch {
            return 0;
        }
    }

    lookup(dedupKey: string, signature: string): IntentLookup {
        const db = this.requireDb();
        const row = db.prepare('SELECT * FROM actions WHERE dedup_key = ?').get(dedupKey) as SqlRow | undefined;
        if (!row) return { kind: 'none' };
        const mapped = this.mapRow(row);
        return { kind: mapped.signature === signature ? 'same' : 'conflict', row: mapped };
    }

    recordIntent(input: RecordIntentInput): void {
        const db = this.requireDb();
        if (this.countActions() >= this.limit) {
            throw new BridgeError(
                'OUTPUT_LIMIT',
                `本次世界已达到 ${this.limit} 条动作记录上限：请正常保存并重新加载存档以重建会话，旧消费请求不会重放。`
            );
        }
        db.prepare(
            `INSERT INTO actions (dedup_key, action_id, signature, command, client_id, control_session_id,
                game_instance_id, world_generation, status, intent_at, actor_context, world_id, actor_farmer_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`
        ).run(
            input.dedupKey,
            input.actionId,
            input.signature,
            input.command,
            input.clientId,
            input.controlSessionId,
            input.gameInstanceId,
            input.worldGeneration,
            input.intentAt,
            input.actorContext ? JSON.stringify(input.actorContext) : null,
            input.actorContext?.worldId ?? null,
            input.actorContext?.actorFarmerId ?? null
        );
    }

    finish(dedupKey: string, receipt: ActionReceipt): void {
        const db = this.requireDb();
        db.prepare('UPDATE actions SET status = ?, finished_at = ?, receipt = ? WHERE dedup_key = ?').run(
            receipt.status,
            receipt.finishedAt ?? new Date().toISOString(),
            JSON.stringify(receipt),
            dedupKey
        );
    }

    /** 追加核对记录，不改变原始回执，也不触发重放。 */
    appendReconciliation(dedupKey: string, record: { at: string; status: ActionStatus; evidence: string }): void {
        const db = this.requireDb();
        const row = db.prepare('SELECT receipt, reconcilations FROM actions WHERE dedup_key = ?').get(dedupKey) as SqlRow | undefined;
        if (!row) return;
        const receiptRaw = asString(row.receipt);
        const receipt = receiptRaw ? (JSON.parse(receiptRaw) as ActionReceipt) : null;
        if (receipt) {
            receipt.reconciliation = [...(receipt.reconciliation ?? []), record];
            db.prepare('UPDATE actions SET receipt = ?, status = ?, reconcilations = ? WHERE dedup_key = ?').run(
                JSON.stringify(receipt),
                record.status,
                JSON.stringify(receipt.reconciliation),
                dedupKey
            );
        }
    }

    private readScope(clientId?: string, actor?: Pick<ActorContext, 'worldId' | 'actorFarmerId'>): { sql: string; params: string[] } {
        const clauses: string[] = [], params: string[] = [];
        if (clientId) { clauses.push('client_id = ?'); params.push(clientId); }
        if (actor) { clauses.push('world_id = ? AND actor_farmer_id = ?'); params.push(actor.worldId, actor.actorFarmerId); }
        return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
    }
    recent(limit = 20, clientId?: string, actor?: Pick<ActorContext, 'worldId' | 'actorFarmerId'>): ActionReceipt[] {
        if (!this.db) return [];
        const scope = this.readScope(clientId, actor);
        const rows = this.db.prepare(`SELECT receipt FROM actions WHERE receipt IS NOT NULL${scope.sql} ORDER BY intent_at DESC LIMIT ?`).all(...scope.params, limit) as SqlRow[];
        const out: ActionReceipt[] = [];
        for (const row of rows) {
            const raw = asString(row.receipt);
            if (!raw) continue;
            try {
                out.push(JSON.parse(raw) as ActionReceipt);
            } catch {
                /* 忽略损坏行 */
            }
        }
        return out;
    }

    findById(actionId: string, clientId?: string, actor?: Pick<ActorContext, 'worldId' | 'actorFarmerId'>): ActionReceipt | null {
        if (!this.db) return null;
        const scope = this.readScope(clientId, actor);
        const rows = this.db.prepare(`SELECT * FROM actions WHERE action_id = ?${scope.sql} ORDER BY intent_at DESC LIMIT 2`).all(actionId, ...scope.params) as SqlRow[];
        if (rows.length > 1) throw new BridgeError('AMBIGUOUS_ACTION_ID', '同一 actionId 有多个作用域，请指定世界和角色查询。');
        const row = rows[0];
        return row ? this.receiptOrUnresolved(row) : null;
    }

    /** 结果不明（unknown）的动作，供 status 提示调用者先核对。 */
    unresolved(limit = 20, clientId?: string, actor?: Pick<ActorContext, 'worldId' | 'actorFarmerId'>): ActionReceipt[] {
        if (!this.db) return [];
        const scope = this.readScope(clientId, actor);
        const rows = this.db.prepare(`SELECT * FROM actions WHERE (receipt IS NULL OR status IN ('unknown','accepted','running'))${scope.sql} ORDER BY intent_at DESC LIMIT ?`).all(...scope.params, limit) as SqlRow[];
        return rows.map(row => this.receiptOrUnresolved(row));
    }

    private receiptOrUnresolved(row: SqlRow): ActionReceipt {
        const action = this.mapRow(row);
        const receipt = action.receipt ?? buildReceipt({
            actionId: action.actionId, clientId: action.clientId, controlSessionId: action.controlSessionId,
            gameInstanceId: action.gameInstanceId, worldGeneration: action.worldGeneration < 0 ? null : action.worldGeneration,
            sceneGeneration: null, command: action.command, status: 'unknown', verified: false, effectKnown: false,
            startedAt: action.intentAt, finishedAt: null, nextAction: 'query_action',
            error: makeFault('RESULT_UNKNOWN', '已记录派发意图，尚无最终收据；不能据此判定未生效，也不能重放。', { effectKnown: false })
        });
        if (!action.receipt && action.actorContext) {
            receipt.schemaVersion = 2;
            receipt.multiplayer = { actor: action.actorContext, confirmationScope: 'none', durability: 'unknown', resourceScope: action.command === 'use' ? 'shared_world' : 'actor', worldContinues: null };
        }
        return receipt;
    }

    saveSession(session: SessionRow): void {
        if (!this.db) return;
        try {
            this.requireDb()
                .prepare(
                    `INSERT INTO sessions (control_session_id, client_id, client_name, state, mode, lease_epoch,
                        game_instance_id, world_generation, started_at, last_activity_at, expires_at, closed_at, close_reason, checkpoint, actor_context)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(control_session_id) DO UPDATE SET
                        state = excluded.state, mode = excluded.mode, lease_epoch = excluded.lease_epoch,
                        game_instance_id = excluded.game_instance_id, world_generation = excluded.world_generation,
                        last_activity_at = excluded.last_activity_at, expires_at = excluded.expires_at,
                        closed_at = excluded.closed_at, close_reason = excluded.close_reason, checkpoint = excluded.checkpoint, actor_context = excluded.actor_context`
                )
                .run(
                    session.controlSessionId,
                    session.clientId,
                    session.clientName,
                    session.state,
                    session.mode,
                    session.leaseEpoch,
                    session.gameInstanceId,
                    session.worldGeneration,
                    session.startedAt,
                    session.lastActivityAt,
                    session.expiresAt,
                    session.closedAt,
                    session.closeReason,
                    session.checkpoint ? JSON.stringify(session.checkpoint) : null,
                    session.actorContext ? JSON.stringify(session.actorContext) : null
                );
        } catch (error) {
            this.logger?.('warn', `保存控制会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    appendEvent(event: LedgerEvent): void {
        if (!this.db || !this.writable) return;
        try {
            this.db.prepare('INSERT INTO events (at, kind, client_id, control_session_id, action_id, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
                event.at,
                event.kind,
                event.clientId,
                event.controlSessionId,
                event.actionId,
                event.payload ? JSON.stringify(event.payload) : null
            );
            this.db.exec('DELETE FROM events WHERE seq <= (SELECT MAX(seq) - 5000 FROM events)');
        } catch (error) {
            this.logger?.('debug', `写入事件日志失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** 启动后核对：数据库里旧的 active 会话一律不恢复。 */
    invalidateOpenSessions(at: string): void {
        if (!this.db || !this.writable) return;
        try {
            this.db.prepare("UPDATE sessions SET state = 'closed', closed_at = ?, close_reason = 'bridge_restart' WHERE state IN ('active','stopping')").run(at);
            this.db.prepare("UPDATE actions SET status = 'unknown' WHERE status IN ('accepted','running')").run();
        } catch (error) {
            this.logger?.('warn', `启动清理未决记录失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private mapRow(row: SqlRow): ActionRow {
        const receiptRaw = asString(row.receipt);
        let receipt: ActionReceipt | null = null;
        if (receiptRaw) {
            try {
                receipt = JSON.parse(receiptRaw) as ActionReceipt;
            } catch {
                receipt = null;
            }
        }
        return {
            actorContext: (() => { try { const actor: unknown = JSON.parse(asString(row.actor_context) ?? 'null'); return isActorContext(actor) ? actor : undefined; } catch { return undefined; } })(),
            dedupKey: asString(row.dedup_key) ?? '',
            actionId: asString(row.action_id) ?? '',
            signature: asString(row.signature) ?? '',
            command: asString(row.command) ?? '',
            clientId: asString(row.client_id) ?? '',
            controlSessionId: asString(row.control_session_id),
            gameInstanceId: asString(row.game_instance_id) ?? '',
            worldGeneration: asNumber(row.world_generation),
            status: (asString(row.status) ?? 'unknown') as ActionStatus,
            intentAt: asString(row.intent_at) ?? '',
            finishedAt: asString(row.finished_at),
            receipt
        };
    }

    close(): void {
        try {
            this.db?.close();
        } catch {
            /* 忽略关闭错误 */
        }
        this.db = null;
        this.writable = false;
    }
}
