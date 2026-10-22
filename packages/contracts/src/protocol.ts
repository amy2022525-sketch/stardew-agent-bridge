/**
 * Stardew Agent Bridge 共享协议契约。
 *
 * 这里定义的字段同时用于：Mod 内部协议、MCP 工具收据、Web API 与文档示例。
 * 修改破坏兼容的字段必须提升 CONTRACTS_SCHEMA_VERSION 与/或 MOD_PROTOCOL 版本。
 */

export const CONTRACTS_SCHEMA_VERSION = 1;
export const BRIDGE_NAME = 'stardew-agent-bridge';
export const BRIDGE_VERSION = '0.1.0';
export const MOD_PROTOCOL = 'stardew-agent-bridge/1';
export const MOD_PROTOCOL_VERSION = 1;

/** 默认端点（安装时检测冲突，可在配置中修改）。 */
export const DEFAULT_BRIDGE_PORT = 17655;
export const DEFAULT_MOD_PORT = 17654;
export const DEFAULT_MOD_HOST = '127.0.0.1';

/** 设计默认时限（接口草案 §7，本地配置可收紧，模型不能放宽）。 */
export const LEASE_TTL_MS = 180_000;
export const HEARTBEAT_INTERVAL_MS = 1_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const FISH_MAX_MS = 55_000;
export const COMBAT_MAX_MS = 10_000;
export const WAIT_MAX_MS = 10_000;
export const PAUSE_ATTEMPT_MS = 2_000;
export const LOAD_MONITOR_MS = 120_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const SNAPSHOT_COMPACT_TARGET_BYTES = 32 * 1024;
export const SNAPSHOT_HARD_LIMIT_BYTES = 256 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const ACTION_LEDGER_LIMIT = 65_536;
export const RECEIPT_CACHE_LIMIT = 256;

/** 动作生命周期状态（接口草案 §5）。 */
export type ActionStatus =
    | 'accepted'
    | 'running'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'unknown';

export const TERMINAL_ACTION_STATUSES: readonly ActionStatus[] = [
    'succeeded', 'partial', 'failed', 'cancelled', 'unknown'
];

export type SessionState = 'available' | 'active' | 'stopping' | 'closed';
export type SessionMode = 'step' | 'realtime';
export type PauseState = 'paused' | 'running' | 'blocked' | 'unknown';

/** 失败后建议的下一步；调用者必须按此行动，不能自动重发消费动作。 */
export type NextAction =
    | 'observe'
    | 'query_action'
    | 'stop'
    | 'wait'
    | 'restart_control'
    | 'fix_environment'
    | 'upgrade'
    | 'none';

export type ToolKind = 'read' | 'write' | 'control' | 'mixed';

/** 目标引用格式，由 Mod 生成并校验：`@s<snapshotSeq>:<e|m><index>`。 */
export const TARGET_REF_PATTERN = '^@s[0-9]{1,9}:[em][0-9]{1,4}$';
export const ACTION_ID_PATTERN = '^[A-Za-z0-9_-]{1,80}$';
export const SAVE_ID_PATTERN = '^[A-Za-z0-9 ._@()-]{1,80}$';

// ---------------------------------------------------------------------------
// Mod 内部协议（Bridge ↔ SMAPI Mod）
// ---------------------------------------------------------------------------

export interface ModFault {
    code: string;
    message: string;
    effectKnown?: boolean;
    nextAction?: string;
}

export interface ModRequest {
    op: 'request';
    protocol: typeof MOD_PROTOCOL;
    requestId: string;
    command: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    /** 写动作的逻辑标识，独立于网络请求；用于去重与查询。 */
    actionId?: string;
    /** 当前控制权代次；写动作必须与 Mod 持有的代次一致。 */
    epoch?: number;
}

export type ModResponseStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export interface ModResponse {
    op: 'response';
    requestId: string;
    status: ModResponseStatus;
    result?: unknown;
    error?: ModFault | null;
    actionId?: string;
    epoch?: number;
    elapsedMs?: number;
}

export interface ModEvent {
    op: 'event';
    event: 'heartbeat' | 'lease' | 'watchdog' | 'notice';
    data?: unknown;
}

export type ModFrame = ModRequest | ModResponse | ModEvent;

/** Mod 握手结果（`hello` 命令）。 */
export interface ModHello {
    mode: 'game';
    kind: 'hello';
    protocol: string;
    instanceId: string;
    modVersion: string;
    gameVersion: string;
    smapiVersion: string;
    saveLoaded: boolean;
    worldGeneration: number;
    singlePlayer: boolean;
    capabilities: string[];
    writeCommands: string[];
    epoch: number;
    controller: string | null;
    lease: { held: boolean; holderName: string | null; expiresAt: string | null };
    pause: { state: PauseState; menuType: string | null; selfOpened: boolean };
    watchdog: { bridgeLinkUp: boolean; lastHeartbeatAt: string | null };
    window: { active: boolean; title: string };
    features: Record<string, boolean | number>;
}

/** Mod 侧控制权结果。 */
export interface ModControlResult {
    kind: 'control';
    epoch: number;
    holderName: string | null;
    expiresAt: string | null;
    pause: { state: PauseState; menuType: string | null; selfOpened: boolean };
}

export interface ModStopResult {
    kind: 'status';
    activeActionId: string | null;
    command: string | null;
    releasedInputs: string[];
    pause: { state: PauseState; menuType: string | null; selfOpened: boolean };
}

// ---------------------------------------------------------------------------
// 统一收据（MCP structuredContent / Web API）
// ---------------------------------------------------------------------------

export interface PauseReport {
    /** 调用方是否请求了暂停（默认分步模式为真）。 */
    requested: boolean;
    state: PauseState;
    /** 归一化原因：`self_pause_menu` / `user_menu` / `event` / `transition` / `error` … */
    reason: string | null;
    menuType?: string | null;
}

export interface BridgeFault {
    code: string;
    message: string;
    effectKnown: boolean;
    nextAction: NextAction;
    detail?: Record<string, unknown> | null;
}

export interface ReconciliationRecord {
    at: string;
    status: ActionStatus;
    evidence: string;
}

export interface ActionReceipt {
    schemaVersion: number;
    actionId: string;
    clientId: string;
    controlSessionId: string | null;
    gameInstanceId: string | null;
    worldGeneration: number | null;
    sceneGeneration: number | null;
    command: string;
    status: ActionStatus;
    /** 是否经过游戏侧后验核验（资源/位置/菜单变化）。 */
    verified: boolean;
    effectKnown: boolean;
    startedAt: string;
    finishedAt: string | null;
    stopReason: string | null;
    effects: Record<string, unknown> | null;
    pause: PauseReport;
    error: BridgeFault | null;
    nextAction: NextAction;
    /** 给文字模型的紧凑摘要，一行内说明结果与下一步。 */
    summary: string;
    reconciliation: ReconciliationRecord[];
}

// ---------------------------------------------------------------------------
// 控制会话与状态
// ---------------------------------------------------------------------------

export interface Checkpoint {
    goal: string | null;
    progress: string | null;
    next: string | null;
    constraints: string | null;
    receiptIds: string[];
    updatedAt: string;
}

export interface ControlSessionInfo {
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

export interface ModLinkStatus {
    connected: boolean;
    protocol: string | null;
    instanceId: string | null;
    modVersion: string | null;
    gameVersion: string | null;
    smapiVersion: string | null;
    saveLoaded: boolean;
    worldGeneration: number | null;
    sceneGeneration: number | null;
    capabilities: string[];
    lastHeartbeatAt: string | null;
    paused: PauseState;
    epoch: number;
    controller: string | null;
    lastError: string | null;
    reconnectAttempts: number;
}

export interface ClientPresence {
    clientId: string;
    clientName: string;
    transport: 'http' | 'stdio' | 'web' | 'cli';
    lastSeenAt: string;
    toolCalls: number;
}

export interface ControlStatus {
    holder: {
        clientId: string;
        clientName: string;
        controlSessionId: string;
        leaseEpoch: number;
        expiresAt: string;
        mode: SessionMode;
    } | null;
    activeActionId: string | null;
    activeCommand: string | null;
    unresolvedActionIds: string[];
    mode: SessionMode | null;
    pause: PauseReport;
}

export interface BridgeStatus {
    ok: boolean;
    bridgeVersion: string;
    contractsSchemaVersion: number;
    startedAt: string;
    now: string;
    port: number;
    modPollMs: number;
    mod: ModLinkStatus;
    control: ControlStatus;
    ledger: {
        writable: boolean;
        schemaVersion: number;
        actionCount: number;
        openWorlds: string[];
        lastError: string | null;
    };
    clients: ClientPresence[];
    notice: string | null;
}

/** 紧凑快照摘要（Web 与 MCP 文字输出共用）。 */
export interface SnapshotSummary {
    snapshotId: string;
    instanceId: string;
    worldGeneration: number;
    sceneGeneration: number;
    location: string;
    date: { season: string; day: number; year: number } | null;
    time: number | null;
    player: {
        name: string;
        money: number | null;
        health: number | null;
        maxHealth: number | null;
        energy: number | null;
        maxEnergy: number | null;
        position: { x: number; y: number } | null;
        selectedSlot: number | null;
        maxItems: number | null;
    } | null;
    inventory: InventoryEntry[];
    entities: EntitySummary[];
    exits: EntitySummary[];
    menu: { type: string; text: string; options: { ref: string; label: string }[] } | null;
    control: { ready: boolean; blockedBy: string[] };
    shipping: { itemId: string; count: number; quality: number }[] | null;
    truncated: boolean;
    sampledAt: string;
}

export interface InventoryEntry {
    slot: number;
    itemId: string;
    name: string;
    count: number;
    quality?: number;
    category?: number;
    tool?: string;
    water?: number;
    waterCapacity?: number;
}

export interface EntitySummary {
    ref: string;
    kind: string;
    name: string;
    tile: { x: number; y: number };
    passable?: boolean;
    action?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Web API 请求体
// ---------------------------------------------------------------------------

export interface ControlStartRequest {
    mode?: SessionMode;
    label?: string;
}

export interface ControlTakeoverRequest {
    reason?: string;
}

export interface ProblemBundleRequest {
    note?: string;
    includeScreenshot?: boolean;
}
