/**
 * decision.sqlite 的 schema（§16.1）。schema_version 从 1 开始；迁移前必须 VACUUM INTO 备份。
 * 只由成功持有实例锁的 Bridge 启动路径调用；doctor/网页查看不得触发（§16.2）。
 */
export const DECISION_SCHEMA_VERSION = 1;

/** WAL/SHM 之外的主库文件路径由调用方给出；备份名含时间戳与随机段。 */
export function createStatements(): readonly string[] {
    return [
        `CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS tasks (
            task_id TEXT PRIMARY KEY,
            owner_client_id TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            definition_revision INTEGER NOT NULL,
            state_version INTEGER NOT NULL,
            state TEXT NOT NULL,
            phase TEXT NOT NULL,
            definition_json TEXT NOT NULL,
            budget_json TEXT NOT NULL,
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
        )`,
        `CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_client_id, state, updated_at)`,
        `CREATE INDEX IF NOT EXISTS tasks_scope ON tasks(scope_key, state)`,
        `CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            state TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            provider_config_revision INTEGER NOT NULL,
            policy_revision INTEGER NOT NULL,
            internal_client_id TEXT NOT NULL,
            control_session_id TEXT,
            start_reason TEXT NOT NULL,
            end_reason TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, generation)`,
        `CREATE TABLE IF NOT EXISTS task_requests (
            owner_client_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            task_id TEXT,
            canonical_hash TEXT NOT NULL,
            result_json TEXT,
            created_at TEXT NOT NULL,
            tombstone INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (owner_client_id, request_id)
        )`,
        `CREATE TABLE IF NOT EXISTS task_steps (
            task_id TEXT NOT NULL,
            step_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            title TEXT NOT NULL,
            done_when TEXT NOT NULL,
            status TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (task_id, step_id)
        )`,
        `CREATE TABLE IF NOT EXISTS task_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            run_id TEXT,
            kind TEXT NOT NULL,
            payload_json TEXT,
            at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS task_events_scope ON task_events(task_id, id)`,
        `CREATE TABLE IF NOT EXISTS action_links (
            run_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            task_id TEXT NOT NULL,
            action_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_hash TEXT NOT NULL,
            dispatch_state TEXT NOT NULL,
            receipt_json TEXT,
            observation_id TEXT,
            step_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (run_id, attempt_no)
        )`,
        `CREATE INDEX IF NOT EXISTS action_links_task ON action_links(task_id, dispatch_state)`,
        `CREATE TABLE IF NOT EXISTS observations (
            observation_id TEXT PRIMARY KEY,
            task_id TEXT,
            run_id TEXT,
            scope_key TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            world_generation INTEGER NOT NULL,
            scene_generation INTEGER NOT NULL,
            date_json TEXT,
            coverage_json TEXT,
            payload_json TEXT NOT NULL,
            at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS observations_run ON observations(run_id, at)`,
        `CREATE TABLE IF NOT EXISTS model_calls (
            call_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            provider_id TEXT NOT NULL,
            provider_config_revision INTEGER NOT NULL,
            reserved_tokens INTEGER NOT NULL,
            usage_json TEXT,
            usage_unknown INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_code TEXT,
            latency_ms INTEGER,
            started_at TEXT NOT NULL,
            ended_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS model_calls_task ON model_calls(task_id, run_id)`,
        `CREATE TABLE IF NOT EXISTS memories (
            memory_id TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL,
            owner_client_id TEXT NOT NULL,
            visibility TEXT NOT NULL DEFAULT 'private',
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            confidence_label TEXT NOT NULL,
            created_at TEXT NOT NULL,
            observed_at TEXT,
            expires_at TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            revision INTEGER NOT NULL DEFAULT 1,
            supersedes_id TEXT,
            conflict_ids_json TEXT NOT NULL DEFAULT '[]'
        )`,
        `CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope_key, status, created_at)`,
        `CREATE TABLE IF NOT EXISTS executor_slot (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            task_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            acquired_at TEXT NOT NULL
        )`
    ];
}
