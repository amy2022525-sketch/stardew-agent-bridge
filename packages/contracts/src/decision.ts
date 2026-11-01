/**
 * 决策执行器（双模型任务自动化）契约：任务模型、身份与作用域、
 * DecisionEnvelope、记忆记录与决策错误外形。
 *
 * 本文件只包含纯类型、常量与无副作用的校验辅助；运行时与存储逻辑
 * 在 @sab/decision-core 与 apps/server 中实现。
 * 依据 docs/DECISION_EXECUTOR_DEVELOPMENT_HANDOVER_20261030.md 第 07/08/10/13/17/20/30 节。
 */
import { makeFault } from './errors.js';
import type { ErrorCode } from './errors.js';
import type { BridgeFault, NextAction, WorldIdentity } from './protocol.js';

export const DECISION_SCHEMA_VERSION = 1;

/** 内置默认政策：只观察与移动（不含任何消费/经济动作）。 */
export const DEFAULT_POLICY_ID = 'observe-move';

/** 执行器内部身份保留前缀：客户端注册与 token 签发路径必须拒绝外部使用该命名空间。 */
export const INTERNAL_DECISION_CLIENT_PREFIX = 'sab-internal-decision:';

/** 统一安全 ASCII ID（taskId/requestId/stepId/memoryId/observationId 等）：1–80 个字符。 */
export const DECISION_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$';
const DECISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const DECISION_ID_MAX_LENGTH = 80;

export const TASK_TITLE_MAX_CHARS = 120;
export const TASK_GOAL_MAX_CHARS = 4096;
export const TASK_PLAN_MAX_STEPS = 12;
export const TASK_STEP_TITLE_MAX_CHARS = 120;
export const TASK_STEP_DONE_WHEN_MAX_CHARS = 500;
export const TASK_MAX_CONSTRAINT_LOCATIONS = 16;
export const TASK_MAX_CONSTRAINTS = 16;
export const TASK_MAX_CRITERIA = 16;
export const TASK_MAX_TILES_PER_CRITERION = 64;
/** 请求总字节上限：复用当前 64 KiB 限制。 */
export const TASK_REQUEST_MAX_BYTES = 64 * 1024;
/** 决策包 argumentsJson 上限：8 KiB。 */
export const DECISION_ARGUMENTS_JSON_MAX_BYTES = 8 * 1024;
export const DECISION_BRIEF_REASON_MAX_CHARS = 240;
export const DECISION_MAX_EVIDENCE_IDS = 16;
export const DECISION_RETRY_MAX_PER_DECISION = 2;
export const DECISION_REPLAN_MAX_PER_RUN = 2;
export const DECISION_CORRECTION_MAX_PER_DECISION = 1;

/** 派单上下文 token：60 秒有效、128 bit 随机、进程内保存、重启作废、日志必须遮蔽。 */
export const CONTEXT_TOKEN_TTL_MS = 60_000;
export const CONTEXT_TOKEN_RANDOM_BYTES = 16;

export const TASK_WAIT_TIMEOUT_MAX_MS = 15_000;
export const TASK_LIST_MIN_LIMIT = 1;
export const TASK_LIST_MAX_LIMIT = 50;
export const TASK_WAIT_MAX_PER_CLIENT = 2;

export const MEMORY_QUERY_MAX_CHARS = 500;
export const MEMORY_TITLE_MAX_CHARS = 120;
export const MEMORY_CONTENT_MAX_CHARS = 2000;
export const MEMORY_MAX_RECORDS_PER_SCOPE = 2000;
export const MEMORY_SEARCH_CANDIDATE_MAX = 500;
export const MEMORY_MAX_RESULTS = 12;

/** 给执行模型的上下文总量上限与最近动作摘要条数。 */
export const CONTEXT_JSON_MAX_BYTES = 48 * 1024;
export const CONTEXT_RECENT_ACTION_SUMMARY_MAX = 8;

export function isDecisionId(value: unknown): value is string {
    return typeof value === 'string' && DECISION_ID_RE.test(value);
}

/** UTF-8 字节长度：字节上限与字符上限必须分别检查。 */
export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------
// 08.1 状态机与枚举
// ---------------------------------------------------------------------------

export type TaskState =
    | 'queued' | 'running' | 'pausing' | 'paused'
    | 'waiting_main' | 'needs_review'
    | 'completed' | 'failed' | 'cancelled';

export const TASK_STATES: readonly TaskState[] = [
    'queued', 'running', 'pausing', 'paused', 'waiting_main', 'needs_review', 'completed', 'failed', 'cancelled'
];

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

export function isTaskState(value: unknown): value is TaskState {
    return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminalTaskState(value: unknown): value is TaskState {
    return isTaskState(value) && (TERMINAL_TASK_STATES as readonly string[]).includes(value);
}

export type TaskPhase =
    | 'preflight' | 'planning' | 'observing' | 'thinking'
    | 'validating' | 'acting' | 'verifying' | 'reporting' | 'idle';

export const TASK_PHASES: readonly TaskPhase[] = [
    'preflight', 'planning', 'observing', 'thinking', 'validating', 'acting', 'verifying', 'reporting', 'idle'
];

export function isTaskPhase(value: unknown): value is TaskPhase {
    return typeof value === 'string' && (TASK_PHASES as readonly string[]).includes(value);
}

export type CompletionEvidence = 'verified_observation' | 'main_reviewed' | 'none';

export type ScopeMode = 'persistent' | 'ephemeral';

/** 短计划步骤状态：只有具备机器条件与有效证据才能 verified_done。 */
export type StepStatus = 'pending' | 'active' | 'reported_done' | 'verified_done' | 'skipped';

export type CriterionStatus = 'met' | 'not_met' | 'unverifiable';

export type TaskOperation = 'submit' | 'update' | 'pause' | 'resume' | 'cancel' | 'reply' | 'resolve';

export const TASK_OPERATIONS: readonly TaskOperation[] = ['submit', 'update', 'pause', 'resume', 'cancel', 'reply', 'resolve'];

export type TaskStatusOperation = 'get' | 'list' | 'wait';

export type ContextOperation = 'current';

export type MemoryOperation = 'search' | 'get' | 'add' | 'update' | 'archive';

export const MEMORY_OPERATIONS: readonly MemoryOperation[] = ['search', 'get', 'add', 'update', 'archive'];

/** resolve 仅限三种复核结论；未知事实不因复核而被改写为成功。 */
export type ResolutionKind = 'accept_completion' | 'reviewed_pause' | 'reject_completion';

export const RESOLUTION_KINDS: readonly ResolutionKind[] = ['accept_completion', 'reviewed_pause', 'reject_completion'];

// ---------------------------------------------------------------------------
// 08.2 submit 输入
// ---------------------------------------------------------------------------

export interface TaskConstraints {
    /** 地图级允许地点；路径级围栏本版本未实现，custom 政策须拒绝。 */
    locations?: string[];
    stopEnergyAtOrBelow?: number | null;
    stopHealthAtOrBelow?: number | null;
    /** 24 小时制游戏时间整数（如 2300）。 */
    latestStartGameTime?: number | null;
    /** D1 只允许 false：自然跨日进入 needs_review。 */
    allowDayChange?: boolean;
    maxGoldSpend?: number | null;
}

export interface TaskBudget {
    maxModelCalls?: number;
    maxWriteActions?: number;
    maxActiveMs?: number;
    maxAccountedTokens?: number;
}

/**
 * 服务端合成后的“有效预算”：四个维度必有值，另含 HTTP 尝试上限。
 * 任务行、runner、BudgetMeter 共用同一形状，避免可选字段在运行时被当成 undefined。
 */
export type EffectiveTaskBudget = Required<TaskBudget> & { maxHttpAttempts: number };

export type TaskSuccessCriterion =
    | { kind: 'at_tile'; location: string; x: number; y: number; tolerance?: number }
    | { kind: 'inventory_at_least'; itemId: string; count: number; quality?: number }
    | { kind: 'crop_tiles_watered'; location: string; tiles: { x: number; y: number }[] }
    | { kind: 'manual_review'; note?: string };

export const SUCCESS_CRITERION_KINDS: readonly TaskSuccessCriterion['kind'][] = [
    'at_tile', 'inventory_at_least', 'crop_tiles_watered', 'manual_review'
];

export interface TaskSubmitInput {
    operation: 'submit';
    requestId: string;
    /** 来自 stardew_context 的短期绑定 token；scope 由服务端从 token 解析，不信任正文。 */
    contextToken: string;
    title: string;
    goal: string;
    providerId?: string;
    policyId?: string;
    scopeMode?: ScopeMode;
    profileId?: string;
    constraints?: TaskConstraints;
    budget?: TaskBudget;
    successCriteria?: TaskSuccessCriterion[];
}

// ---------------------------------------------------------------------------
// 07 作用域与任务记录
// ---------------------------------------------------------------------------

export interface TaskScope {
    mode: ScopeMode;
    profileId: string;
    worldId: string | null;
    actorFarmerId: string | null;
    instanceId: string | null;
    worldGeneration: number | null;
    /**
     * 持久键 (profileId, worldId, actorFarmerId)；临时键 (profileId, instanceId, worldGeneration)。
     * 仅作为数据库数据绑定，不得拼接文件路径或 SQL。
     */
    scopeKey: string;
}

export interface TaskPlanStepDefinition {
    stepId: string;
    title: string;
    /** doneWhen 是解释文本，不能当可执行判定式。 */
    doneWhen: string;
}

export interface TaskPlanStep extends TaskPlanStepDefinition {
    status: StepStatus;
    evidenceIds: string[];
}

export interface BudgetUsage {
    modelCalls: number;
    writeActions: number;
    httpAttempts: number;
    activeMs: number;
    accountedTokens: number;
    /** 用量未知时保留保守预留并置位，不得当作 0。 */
    usageUnknown: boolean;
}

export interface TaskBlocker {
    code: ErrorCode;
    summary: string;
    evidenceIds: string[];
    raisedAt: string;
}

export interface CriterionResult {
    index: number;
    status: CriterionStatus;
    evidenceIds: string[];
}

export interface TaskCompletion {
    evidenceLevel: CompletionEvidence;
    criterionResults: CriterionResult[];
    /** worldSaved 不因任务完成或动作回执成功而写成 saved。 */
    worldSaved: 'unknown' | 'saved';
}

export interface PolicySnapshotView {
    policyId: string;
    revision: number;
    allowedTools: string[];
    allowedLocations: string[];
    toolRestrictions: Record<string, unknown>;
    capturedAt: string;
}

export interface TaskDefinition {
    title: string;
    goal: string;
    providerId: string;
    constraints: TaskConstraints;
    budget: TaskBudget;
    successCriteria: TaskSuccessCriterion[];
}

export interface TaskRecord {
    schemaVersion: 1;
    taskId: string;
    /** 来自认证层，不能由请求正文冒填。 */
    ownerClientId: string;
    definition: TaskDefinition;
    /** 仅目标、限制、计划定义或恢复授权实质变化时 +1。 */
    definitionRevision: number;
    /** 动作进度只增加 stateVersion。 */
    stateVersion: number;
    state: TaskState;
    phase: TaskPhase;
    scope: TaskScope;
    policySnapshot: PolicySnapshotView;
    providerRef: string;
    /** 服务端 effective = min(用户全局, provider, 任务)；缺省取更严。 */
    budgetLimit: EffectiveTaskBudget;
    budgetUsed: BudgetUsage;
    plan: TaskPlanStep[] | null;
    currentRunId: string | null;
    createdAt: string;
    updatedAt: string;
    pauseReason: string | null;
    blocker: TaskBlocker | null;
    completion: TaskCompletion | null;
    lastEvidenceSummary: string | null;
}

// ---------------------------------------------------------------------------
// 08.3 接单结果与完成结果不能混淆
// ---------------------------------------------------------------------------

export interface TaskAcceptedResult {
    schemaVersion: 1;
    accepted: true;
    taskId: string;
    state: 'queued';
    phase: 'preflight';
    definitionRevision: number;
    stateVersion: number;
    completed: false;
    nextPollAfterMs: number;
    resumeRequiresUser: boolean;
}

export interface TaskFinalResult {
    schemaVersion: 1;
    taskId: string;
    state: TaskState;
    phase: TaskPhase;
    summary: string;
    completion: TaskCompletion | null;
    budgetUsed: BudgetUsage;
    /** 有未决动作时不得宣称 verified_observation 完成。 */
    unresolvedActionIds: string[];
    remainingWork: string[];
}

// ---------------------------------------------------------------------------
// 07.3 / 17.2 stardew_context 返回外形
// ---------------------------------------------------------------------------

export interface DecisionContextInfo {
    profileId: string;
    automationEnabled: boolean;
    userStopLatched: boolean;
    gameOnline: boolean;
    /** 游戏离线时为 null：可查询概况，但不能派发任务。 */
    contextToken: string | null;
    contextExpiresAt: string | null;
    worldIdentity: WorldIdentity | null;
    instanceId: string | null;
    worldGeneration: number | null;
    /** 旧 Mod 无稳定身份时须显式 ephemeral 才能派发。 */
    scopeModeOptions: ScopeMode[];
    availableProviderIds: string[];
    availablePolicyIds: string[];
}

// ---------------------------------------------------------------------------
// 10.4 / 30 DecisionEnvelope
// ---------------------------------------------------------------------------

export type DecisionKind = 'plan' | 'act' | 'finish' | 'ask_main';

export interface DecisionEnvelope {
    schemaVersion: 1;
    kind: DecisionKind;
    observationId: string;
    stepId: string | null;
    toolName: string | null;
    /** JSON 对象字符串，≤8 KiB；先 parse 再用工具 schema 验证，不能 eval。 */
    argumentsJson: string | null;
    plan: TaskPlanStepDefinition[] | null;
    /** 玩家可读理由，≤240 字符；不要求隐藏思维链。 */
    briefReason: string;
    /** ≤16 且仅可引用服务器本轮提供、本任务作用域内的证据。 */
    evidenceIds: string[];
    question: string | null;
}

export const DECISION_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        kind: { type: 'string', enum: ['plan', 'act', 'finish', 'ask_main'] },
        observationId: { type: 'string' },
        stepId: { type: ['string', 'null'] },
        toolName: { type: ['string', 'null'] },
        argumentsJson: { type: ['string', 'null'] },
        plan: {
            type: ['array', 'null'],
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    stepId: { type: 'string' },
                    title: { type: 'string' },
                    doneWhen: { type: 'string' }
                },
                required: ['stepId', 'title', 'doneWhen']
            }
        },
        briefReason: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
        question: { type: ['string', 'null'] }
    },
    required: [
        'schemaVersion', 'kind', 'observationId', 'stepId', 'toolName',
        'argumentsJson', 'plan', 'briefReason', 'evidenceIds', 'question'
    ]
};

// ---------------------------------------------------------------------------
// 13 记忆记录
// ---------------------------------------------------------------------------

export type MemoryKind =
    | 'task_working' | 'episodic' | 'preference' | 'strategy' | 'observed_fact';

export const MEMORY_KINDS: readonly MemoryKind[] = [
    'task_working', 'episodic', 'preference', 'strategy', 'observed_fact'
];

export type MemorySourceType = 'native_game' | 'main_model' | 'executor' | 'user';

/** observed|reported|inferred；记忆文本不能覆盖规则与授权。 */
export type ConfidenceLabel = 'observed' | 'reported' | 'inferred';

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'expired';

export interface MemoryRecord {
    schemaVersion: 1;
    memoryId: string;
    scopeKey: string;
    ownerClientId: string;
    kind: MemoryKind;
    title: string;
    content: string;
    sourceType: MemorySourceType;
    sourceId: string | null;
    evidenceIds: string[];
    confidenceLabel: ConfidenceLabel;
    createdAt: string;
    observedAt: string | null;
    /** 过期记忆默认不提供给执行模型当作当前事实。 */
    expiresAt: string | null;
    status: MemoryStatus;
    revision: number;
    supersedesId: string | null;
    /** 跨 owner 默认不可见；共享必须在 Web 打开。 */
    visibility: 'private' | 'shared';
}

// ---------------------------------------------------------------------------
// 20 决策错误外形
// ---------------------------------------------------------------------------

export interface DecisionFault extends BridgeFault {
    retryable: boolean;
    taskId?: string;
}

const RETRYABLE_DECISION_CODES: ReadonlySet<string> = new Set<string>([
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_TIMEOUT',
    'CONTEXT_EXPIRED',
    'DECISION_OUTPUT_INVALID',
    'TASK_REVISION_CONFLICT',
    'PAUSE_NOT_CONFIRMED'
]);

export function isRetryableDecisionCode(code: ErrorCode): boolean {
    return RETRYABLE_DECISION_CODES.has(code);
}

export function decisionFault(code: ErrorCode, message?: string, overrides?: { taskId?: string; effectKnown?: boolean }): DecisionFault {
    const base: BridgeFault = makeFault(code, message, overrides?.effectKnown === undefined ? undefined : { effectKnown: overrides.effectKnown });
    const fault: DecisionFault = { ...base, retryable: isRetryableDecisionCode(code) };
    if (overrides && overrides.taskId !== undefined) fault.taskId = overrides.taskId;
    return fault;
}

/** 旧 ref/lease/actionId 永不跨 run 恢复；重绑定必须全字段匹配（10.5）。 */
export type DecisionNextAction = NextAction;

// ---------------------------------------------------------------------------
// 对外 DTO（MCP 状态查询与 Web 面板共用；只含公开字段）
// ---------------------------------------------------------------------------

export interface ResidualWorkView {
    pendingSteps: string[];
    unverifiedSteps: string[];
    blockers: string[];
}

/** 单任务视图：任务本体 + 未决动作 + 剩余工作 + 终局摘要。 */
export interface TaskView {
    schemaVersion: 1;
    task: TaskRecord;
    unresolvedActionIds: string[];
    remainingWork: ResidualWorkView;
    finalSummary: string | null;
    /** 任务来自哪个 Agent（owner 是外部身份，内部执行身份另记在 run 上）。 */
    origin: { kind: 'main_model' | 'web'; clientId: string };
    nextPollAfterMs: number;
}

export interface TaskListResult {
    schemaVersion: 1;
    tasks: TaskView[];
    nextCursor: string | null;
}

export interface TaskWaitResult {
    schemaVersion: 1;
    changed: boolean;
    waitedMs: number;
    task: TaskView;
}

/** 功能状态（GET /api/v1/decision/status）。 */
export interface DecisionStatusView {
    schemaVersion: 1;
    /** 本次 Bridge 启动标识；变化说明进程已重启，面板必须全量刷新而不是比较旧 seq。 */
    bootId: string;
    enabled: boolean;
    /** 配置/库/Mod 的综合健康度：ok / degraded / disabled。 */
    health: 'ok' | 'degraded' | 'disabled';
    healthReason: string | null;
    stopLatched: boolean;
    stopReason: string | null;
    activeTaskId: string | null;
    configRevision: number;
    providerConfigured: boolean;
    defaultProviderId: string | null;
    defaultPolicyId: string;
    activeProfileId: string;
    capabilities: {
        protocols: string[];
        policies: string[];
        multiplayerAutomation: boolean;
        fileSecretSupported: boolean;
    };
}

/** 非敏感配置视图：绝不包含 Key、Authorization、secretRef 指向的真实文件。 */
export interface DecisionConfigView {
    schemaVersion: 1;
    configRevision: number;
    enabled: boolean;
    defaultProviderId: string | null;
    defaultPolicyId: string;
    providers: ProviderPublicView[];
    authorizedClientIds: string[];
    limits: TaskBudget & { maxHttpAttempts: number };
    activeProfileId: string;
    profiles: { id: string; label: string }[];
    policies: { id: string; label: string; builtin: boolean }[];
    /** 自定义政策的完整定义；缺失时 Web 保存会保留旧值（见 decision-panel）。 */
    customPolicies?: CustomPolicyPublicView[];
    memory: { maxEntriesPerScope: number; maxContentChars: number; maxResults: number };
    sharing: { sharedTaskReadAcrossClients: boolean };
    multiplayerAutomation: 'disabled' | 'enabled';
    resumeAfterRestart: boolean;
}

export interface ProviderPublicView {
    id: string;
    label: string;
    protocol: 'openai-responses' | 'openai-chat-compatible';
    model: string;
    /** 服务地址（仅 Web 管理接口返回，供编辑回写；MCP 的 stardew_context 不返回它）。 */
    baseUrl: string;
    /** 只表示“本项目管理的凭据里是否已有记录”，不返回任何密钥内容。 */
    hasSecret: boolean;
    authMode: 'bearer' | 'none';
    decisionFormat: 'json_schema' | 'json_object' | 'plain_json';
    timeoutMs: number;
    maxOutputTokens: number;
    allowPrivateNetwork: boolean;
    allowPlainHttp: boolean;
    /** 配置里能看出是本地服务，但绝不代表它已经连通。 */
    localLike: boolean;
    /** 高级项原样回写，避免 Web 保存一次就丢掉手写配置。 */
    maxOutputParameter: 'max_completion_tokens' | 'max_tokens';
    supportsTemperature: boolean;
    temperature?: number;
    supportsReasoning: boolean;
    reasoningEffort?: string;
    /** 容器只读 secret-file（/run/secrets/...）；不是任意路径。 */
    secretFile: string | null;
    /**
     * 本项目管理的凭据逻辑引用名（不是文件路径、环境变量名或密钥本身）。
     * Web 编辑配置时需原样回写，避免保存一次就丢掉凭据绑定。
     */
    secretRef: string | null;
}

/** custom 政策的公开定义：用于 Web 编辑回写，不含任何可执行表达式。 */
export interface CustomPolicyPublicView {
    id: string;
    label: string;
    allowedTools: string[];
    allowedLocations: string[];
    toolRestrictions: Record<string, unknown>;
    budgetCaps: Record<string, number>;
}
