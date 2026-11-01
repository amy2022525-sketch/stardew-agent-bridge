/**
 * 决策执行器非敏感配置（§11.3 / §15.2 / §18）。
 *
 * - 独立文件 `<dataRoot>/decision/config.json`，不与可导出的 Bridge config.json 混放密钥。
 * - 默认关闭：升级不会强制任何玩家配置模型服务。
 * - 配置有 revision，Web 写入走 CAS；禁止多处不一致的“默认 Key / 默认模型 / 默认权限”。
 * - 内置 observe-move / farm-care 两套政策；custom 必须使用已静态实现的参数保护，
 *   未知保护字段一律拒绝保存，绝不假装有保护。
 */
import { existsSync, readFileSync } from 'node:fs';
import {
    BridgeError,
    DEFAULT_POLICY_ID,
    type DecisionConfigView,
    type ProviderPublicView,
    type TaskBudget
} from '@sab/contracts';
import { BUDGET_DEFAULTS, validateCustomPolicyTools } from '@sab/decision-core';
import type { DecisionPolicyView, ProviderProfileConfig, ToolArgumentGuard } from '@sab/decision-core';
import { PRIVATE_FILE_MODE, atomicWriteFile, ensureFileMode } from '@sab/platform';
import type { DataPaths } from './paths.js';

export const DECISION_CONFIG_SCHEMA_VERSION = 1;
export const OBSERVE_MOVE_POLICY_ID = DEFAULT_POLICY_ID;
export const FARM_CARE_POLICY_ID = 'farm-care';
export const CUSTOM_POLICY_ID = 'custom';

export interface CustomPolicyConfig {
    id: string;
    label: string;
    allowedTools: string[];
    allowedLocations: string[];
    toolRestrictions: Record<string, ToolArgumentGuard>;
    budgetCaps: Record<string, number>;
}

export interface DecisionProviderEntry extends ProviderProfileConfig {
    /**
     * 容器部署可选：只允许 `<secretDir>/...` 下的只读 secret-file。
     * 不是任意路径；MCP 无法自选文件，只能由部署者在配置文件里固定。
     */
    secretFile?: string | null;
}

export interface DecisionLimits extends Required<TaskBudget> {
    maxHttpAttempts: number;
}

export interface ClientLimits {
    providerIds?: string[];
    policyIds?: string[];
    budget?: TaskBudget;
}

export interface DecisionConfigFile {
    schemaVersion: 1;
    configRevision: number;
    enabled: boolean;
    defaultProviderId: string | null;
    defaultPolicyId: string;
    providers: DecisionProviderEntry[];
    authorizedClientIds: string[];
    maxConcurrentTasks: 1;
    multiplayerAutomation: 'disabled';
    resumeAfterRestart: false;
    profiles: { id: string; label: string }[];
    activeProfileId: string;
    customPolicies: CustomPolicyConfig[];
    limits: DecisionLimits;
    clientLimits: Record<string, ClientLimits>;
    sharing: { sharedTaskReadAcrossClients: boolean };
    memory: { maxEntriesPerScope: number; maxContentChars: number; maxResults: number };
}

/** 允许把哪些现有工具交给执行模型；控制/任务/配置类工具永不在列。 */
/**
 * 只观察与移动。刻意不含 wait（写类动作，可能被用来维持租约）、doctor（诊断）
 * 与 screenshot（D1 不向执行模型提供视觉输入）。
 */
export const OBSERVE_MOVE_TOOLS: readonly string[] = [
    'stardew_status', 'stardew_snapshot', 'stardew_inspect',
    'stardew_move', 'stardew_closemenu'
];

export const FARM_CARE_TOOLS: readonly string[] = [...OBSERVE_MOVE_TOOLS, 'stardew_select', 'stardew_use'];

export const BUILTIN_POLICY_VIEWS: readonly DecisionPolicyView[] = [
    {
        policyId: OBSERVE_MOVE_POLICY_ID,
        label: '只观察与移动',
        revision: 1,
        allowedTools: [...OBSERVE_MOVE_TOOLS],
        allowedLocations: [],
        toolRestrictions: {},
        budgetCaps: { maxGoldSpend: 0 }
    },
    {
        policyId: FARM_CARE_POLICY_ID,
        label: '农场照料（浇水）',
        revision: 1,
        allowedTools: [...FARM_CARE_TOOLS],
        allowedLocations: [],
        toolRestrictions: {
            // 浇水闭环：只允许选择水壶、对已观察且需要浇水的作物格使用。
            stardew_use: { waterOnly: true },
            stardew_select: { waterOnly: true }
        },
        budgetCaps: { maxGoldSpend: 0 }
    }
];

const SUPPORTED_GUARD_KEYS = ['waterOnly', 'maxCountPerAction', 'allowedItemIds', 'maxGoldSpendPerAction'] as const;

export function defaultDecisionConfig(): DecisionConfigFile {
    return {
        schemaVersion: DECISION_CONFIG_SCHEMA_VERSION,
        configRevision: 0,
        enabled: false,
        defaultProviderId: null,
        defaultPolicyId: DEFAULT_POLICY_ID,
        providers: [],
        authorizedClientIds: [],
        maxConcurrentTasks: 1,
        multiplayerAutomation: 'disabled',
        resumeAfterRestart: false,
        profiles: [{ id: 'default', label: '默认存档分组' }],
        activeProfileId: 'default',
        customPolicies: [],
        limits: {
            maxModelCalls: BUDGET_DEFAULTS.maxModelCalls,
            maxWriteActions: BUDGET_DEFAULTS.maxWriteActions,
            maxActiveMs: BUDGET_DEFAULTS.maxActiveMs,
            maxAccountedTokens: BUDGET_DEFAULTS.maxAccountedTokens,
            maxHttpAttempts: BUDGET_DEFAULTS.maxHttpAttempts
        },
        clientLimits: {},
        sharing: { sharedTaskReadAcrossClients: false },
        memory: { maxEntriesPerScope: 2000, maxContentChars: 2000, maxResults: 12 }
    };
}

/** 读取配置；损坏/未来版本时返回 disabled 配置并保留原文件（不删除、不重建）。 */
export function loadDecisionConfig(paths: DataPaths): { config: DecisionConfigFile; revision: number; error: string | null; raw: DecisionConfigFile } {
    const file = paths.decisionConfig;
    if (!existsSync(file)) {
        return { config: defaultDecisionConfig(), revision: 0, error: null, raw: defaultDecisionConfig() };
    }
    try {
        ensureFileMode(file, PRIVATE_FILE_MODE);
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const normalized = normalizeConfig(parsed);
        // 手写/旧版配置可能没有 configRevision：磁盘上已存在即视为 revision 1，
        // 否则 GET 返回 1、PUT 用 1 却被判冲突（0），陷入无法保存的死循环。
        if ((parsed as Record<string, unknown>)['configRevision'] === undefined && normalized.configRevision === 0) {
            normalized.configRevision = 1;
        }
        return { config: normalized, revision: normalized.configRevision, error: null, raw: normalized };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const disabled = { ...defaultDecisionConfig(), enabled: false };
        // 保留原文件：只让执行器降级，不覆盖用户配置。
        return { config: disabled, revision: 0, error: '决策配置无法解析，执行器已降级为禁用：' + message, raw: disabled };
    }
}

/**
 * 归一化 + 校验。缺失的可选字段按文档默认补齐（UI 与后端共享同一套默认）。
 * 任何会扩大权限或与本版能力冲突的值都直接拒绝。
 */
export function normalizeConfig(input: unknown): DecisionConfigFile {
    const base = defaultDecisionConfig();
    const raw = (input ?? {}) as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new BridgeError('INVALID_ARGUMENT', '决策配置必须是 JSON 对象。');
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
        throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '决策配置版本不受支持，保持原文件不变。');
    }
    const config: DecisionConfigFile = {
        ...base,
        configRevision: intOr(raw.configRevision, base.configRevision, 0, Number.MAX_SAFE_INTEGER),
        enabled: raw.enabled === true,
        defaultProviderId: nullableString(raw.defaultProviderId),
        defaultPolicyId: typeof raw.defaultPolicyId === 'string' && raw.defaultPolicyId.length > 0 ? raw.defaultPolicyId : base.defaultPolicyId,
        providers: normalizeProviders(raw.providers),
        authorizedClientIds: normalizeClientIds(raw.authorizedClientIds),
        maxConcurrentTasks: 1,
        multiplayerAutomation: 'disabled',
        resumeAfterRestart: false,
        profiles: normalizeProfiles(raw.profiles, base.profiles),
        activeProfileId: typeof raw.activeProfileId === 'string' && raw.activeProfileId.length > 0 ? raw.activeProfileId : 'default',
        customPolicies: normalizeCustomPolicies(raw.customPolicies),
        limits: normalizeLimits(raw.limits, base.limits),
        clientLimits: normalizeClientLimits(raw.clientLimits),
        sharing: { sharedTaskReadAcrossClients: (raw.sharing as Record<string, unknown> | undefined)?.sharedTaskReadAcrossClients === true },
        memory: normalizeMemory(raw.memory)
    };
    if (raw.multiplayerAutomation !== undefined && raw.multiplayerAutomation !== 'disabled') {
        throw new BridgeError('INVALID_ARGUMENT', '本版本不支持联机自动任务，multiplayerAutomation 只能为 disabled。');
    }
    if (raw.resumeAfterRestart === true) {
        throw new BridgeError('INVALID_ARGUMENT', '重启后自动续跑不受支持：resumeAfterRestart 只能为 false。');
    }
    if (!config.profiles.some((profile) => profile.id === config.activeProfileId)) {
        throw new BridgeError('INVALID_ARGUMENT', 'activeProfileId 必须是已存在的 profile。');
    }
    if (config.defaultProviderId !== null && !config.providers.some((provider) => provider.id === config.defaultProviderId)) {
        throw new BridgeError('INVALID_ARGUMENT', 'defaultProviderId 必须是已配置的 provider。');
    }
    if (config.enabled && config.defaultProviderId === null) {
        throw new BridgeError('PROVIDER_NOT_CONFIGURED', '启用前必须指定默认执行模型。');
    }
    if (!policyExists(config, config.defaultPolicyId)) throw new BridgeError('INVALID_ARGUMENT', 'defaultPolicyId 不存在。');
    return config;
}

function policyExists(config: DecisionConfigFile, policyId: string): boolean {
    return BUILTIN_POLICY_VIEWS.some((p) => p.policyId === policyId) || config.customPolicies.some((p) => p.id === policyId);
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function normalizeProviders(value: unknown): DecisionProviderEntry[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BridgeError('INVALID_ARGUMENT', 'providers 必须是数组。');
    if (value.length > 8) throw new BridgeError('INVALID_ARGUMENT', 'providers 最多 8 个。');
    const seen = new Set<string>();
    return value.map((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const id = String(raw.id ?? '');
        if (!ID_RE.test(id)) throw new BridgeError('INVALID_ARGUMENT', 'provider id 非法：' + id);
        if (seen.has(id)) throw new BridgeError('INVALID_ARGUMENT', 'provider id 重复：' + id);
        seen.add(id);
        const protocol = raw.protocol === 'openai-responses' || raw.protocol === 'openai-chat-compatible' ? raw.protocol : null;
        if (!protocol) throw new BridgeError('PROVIDER_UNSUPPORTED', 'provider 协议必须是 openai-responses 或 openai-chat-compatible。');
        const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
        validateEndpointShape(baseUrl, raw.allowPlainHttp === true);
        const model = typeof raw.model === 'string' ? raw.model.trim() : '';
        if (model.length === 0) throw new BridgeError('PROVIDER_NOT_CONFIGURED', 'provider 缺少模型 ID。');
        const authMode = raw.authMode === 'bearer' ? 'bearer' : raw.authMode === 'none' ? 'none' : null;
        if (!authMode) throw new BridgeError('PROVIDER_NOT_CONFIGURED', 'authMode 必须显式声明 bearer 或 none。');
        const secretRef = authMode === 'bearer' ? nullableString(raw.secretRef) : null;
        if (authMode === 'bearer' && secretRef === null) throw new BridgeError('PROVIDER_NOT_CONFIGURED', 'authMode=bearer 需要 secretRef。');
        if (authMode === 'none' && nullableString(raw.secretRef) !== null) throw new BridgeError('INVALID_ARGUMENT', 'authMode=none 时不应设置 secretRef。');
        const decisionFormat = raw.decisionFormat === 'json_object' || raw.decisionFormat === 'plain_json' || raw.decisionFormat === 'json_schema'
            ? raw.decisionFormat
            : 'json_schema';
        const maxOutputParameter = raw.maxOutputParameter === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
        const secretFile = nullableString(raw.secretFile);
        if (secretFile !== null && !/^\/run\/secrets\/[A-Za-z0-9._-]{1,64}$/.test(secretFile)) {
            throw new BridgeError('INVALID_ARGUMENT', 'secretFile 只允许 /run/secrets/ 下的只读固定文件。');
        }
        return {
            id,
            label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 80) : id,
            protocol,
            baseUrl,
            model,
            authMode,
            secretRef,
            secretFile,
            decisionFormat,
            maxOutputParameter,
            timeoutMs: intOr(raw.timeoutMs, 30_000, 5_000, 90_000),
            maxOutputTokens: intOr(raw.maxOutputTokens, 2048, 256, 8192),
            allowPrivateNetwork: raw.allowPrivateNetwork === true,
            allowPlainHttp: raw.allowPlainHttp === true,
            supportsTemperature: raw.supportsTemperature === true,
            temperature: typeof raw.temperature === 'number' && Number.isFinite(raw.temperature) ? raw.temperature : undefined,
            supportsReasoning: raw.supportsReasoning === true,
            reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.slice(0, 32) : undefined
        };
    });
}

/** 只做结构校验，不做 DNS：保存配置时绝不触发网络请求。 */
export function validateEndpointShape(baseUrl: string, allowPlainHttp: boolean): void {
    if (baseUrl.length === 0) throw new BridgeError('PROVIDER_NOT_CONFIGURED', 'provider 缺少 baseUrl。');
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new BridgeError('INVALID_ARGUMENT', 'baseUrl 不是合法 URL。');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BridgeError('INVALID_ARGUMENT', 'baseUrl 只允许 http/https。');
    if (url.protocol === 'http:' && !allowPlainHttp) throw new BridgeError('INVALID_ARGUMENT', '明文 HTTP 需同时设置 allowPlainHttp=true。');
    if (url.username !== '' || url.password !== '') throw new BridgeError('INVALID_ARGUMENT', 'baseUrl 不允许包含用户名或密码。');
    if (url.search !== '' || url.hash !== '') throw new BridgeError('INVALID_ARGUMENT', 'baseUrl 不允许 query 或 fragment。');
    if (url.hostname === '') throw new BridgeError('INVALID_ARGUMENT', 'baseUrl 缺少主机名。');
}

function normalizeClientIds(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BridgeError('INVALID_ARGUMENT', 'authorizedClientIds 必须是数组。');
    const out: string[] = [];
    for (const item of value) {
        // 先识别保留命名空间：它的冒号本就不符合普通 clientId 规则，先报“内部身份”才准确。
        if (typeof item === 'string' && item.startsWith('sab-internal-decision:')) {
            throw new BridgeError('INVALID_ARGUMENT', '内部执行身份不能出现在授权名单。');
        }
        if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(item)) {
            throw new BridgeError('INVALID_ARGUMENT', 'authorizedClientIds 含非法 clientId。');
        }
        if (!out.includes(item)) out.push(item);
    }
    return out;
}

function normalizeProfiles(value: unknown, fallback: { id: string; label: string }[]): { id: string; label: string }[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new BridgeError('INVALID_ARGUMENT', 'profiles 必须是 1–20 项。');
    const seen = new Set<string>();
    return value.map((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const id = String(raw.id ?? '');
        if (!ID_RE.test(id)) throw new BridgeError('INVALID_ARGUMENT', 'profile id 非法：' + id);
        if (seen.has(id)) throw new BridgeError('INVALID_ARGUMENT', 'profile id 重复：' + id);
        seen.add(id);
        return { id, label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 80) : id };
    });
}

function normalizeCustomPolicies(value: unknown): CustomPolicyConfig[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 16) throw new BridgeError('INVALID_ARGUMENT', 'customPolicies 最多 16 项。');
    const seen = new Set<string>();
    return value.map((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        const id = String(raw.id ?? '');
        if (!ID_RE.test(id)) throw new BridgeError('INVALID_ARGUMENT', '政策 id 非法：' + id);
        if (id === OBSERVE_MOVE_POLICY_ID || id === FARM_CARE_POLICY_ID) throw new BridgeError('INVALID_ARGUMENT', '自定义政策不能覆盖内置 id。');
        if (seen.has(id)) throw new BridgeError('INVALID_ARGUMENT', '政策 id 重复：' + id);
        seen.add(id);
        const allowedTools = Array.isArray(raw.allowedTools) ? raw.allowedTools.filter((t): t is string => typeof t === 'string') : [];
        if (allowedTools.length === 0) throw new BridgeError('INVALID_ARGUMENT', '自定义政策必须至少允许一个工具。');
        const restrictionsRaw = (raw.toolRestrictions ?? {}) as Record<string, unknown>;
        const toolRestrictions: Record<string, ToolArgumentGuard> = {};
        for (const [toolName, guardRaw] of Object.entries(restrictionsRaw)) {
            const guard = (guardRaw ?? {}) as Record<string, unknown>;
            for (const key of Object.keys(guard)) {
                if (!(SUPPORTED_GUARD_KEYS as readonly string[]).includes(key)) {
                    throw new BridgeError('INVALID_ARGUMENT', `工具 ${toolName} 使用了未实现的参数保护：${key}`);
                }
            }
            toolRestrictions[toolName] = guard as ToolArgumentGuard;
        }
        const budgetCapsRaw = (raw.budgetCaps ?? {}) as Record<string, unknown>;
        const budgetCaps: Record<string, number> = {};
        for (const [key, cap] of Object.entries(budgetCapsRaw)) {
            if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) throw new BridgeError('INVALID_ARGUMENT', 'budgetCaps 必须是非负有限数。');
            budgetCaps[key] = cap;
        }
        // 工具与 guard 必须成对成立：没有已实现保护的高影响工具不能“先放开再祈祷”。
        const toolCheck = validateCustomPolicyTools(allowedTools, toolRestrictions);
        if (!toolCheck.ok) {
            throw new BridgeError('INVALID_ARGUMENT', '自定义政策不可用：' + toolCheck.issues.join('；'));
        }
        return {
            id,
            label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.slice(0, 80) : id,
            allowedTools,
            allowedLocations: Array.isArray(raw.allowedLocations) ? raw.allowedLocations.filter((l): l is string => typeof l === 'string') : [],
            toolRestrictions,
            budgetCaps
        };
    });
}

function normalizeLimits(value: unknown, fallback: DecisionLimits): DecisionLimits {
    const raw = (value ?? {}) as Record<string, unknown>;
    const clamp = (key: keyof DecisionLimits, hardMax: number): number => {
        const candidate = raw[key];
        if (candidate === undefined) return fallback[key];
        if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate <= 0) throw new BridgeError('INVALID_ARGUMENT', key + ' 必须是正整数。');
        // 全局上限只能更严，不能超过代码硬上限。
        return Math.min(candidate, hardMax);
    };
    return {
        maxModelCalls: clamp('maxModelCalls', BUDGET_DEFAULTS.maxModelCalls),
        maxWriteActions: clamp('maxWriteActions', BUDGET_DEFAULTS.maxWriteActions),
        maxActiveMs: clamp('maxActiveMs', BUDGET_DEFAULTS.maxActiveMs),
        maxAccountedTokens: clamp('maxAccountedTokens', BUDGET_DEFAULTS.maxAccountedTokens),
        maxHttpAttempts: clamp('maxHttpAttempts', BUDGET_DEFAULTS.maxHttpAttempts)
    };
}

function normalizeClientLimits(value: unknown): Record<string, ClientLimits> {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BridgeError('INVALID_ARGUMENT', 'clientLimits 必须是对象。');
    const out: Record<string, ClientLimits> = {};
    for (const [clientId, rawLimits] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(clientId)) throw new BridgeError('INVALID_ARGUMENT', 'clientLimits 含非法 clientId。');
        const raw = (rawLimits ?? {}) as Record<string, unknown>;
        const limits: ClientLimits = {};
        if (Array.isArray(raw.providerIds)) limits.providerIds = raw.providerIds.filter((p): p is string => typeof p === 'string');
        if (Array.isArray(raw.policyIds)) limits.policyIds = raw.policyIds.filter((p): p is string => typeof p === 'string');
        if (raw.budget !== undefined) {
            const budget = (raw.budget ?? {}) as Record<string, unknown>;
            const normalized: TaskBudget = {};
            for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens'] as const) {
                const v = budget[key];
                if (v === undefined) continue;
                if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new BridgeError('INVALID_ARGUMENT', 'clientLimits.budget 必须是正整数。');
                normalized[key] = v;
            }
            limits.budget = normalized;
        }
        out[clientId] = limits;
    }
    return out;
}

function normalizeMemory(value: unknown): DecisionConfigFile['memory'] {
    const raw = (value ?? {}) as Record<string, unknown>;
    const cap = (key: 'maxEntriesPerScope' | 'maxContentChars' | 'maxResults', hardMax: number, fallback: number): number => {
        const v = raw[key];
        if (v === undefined) return fallback;
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new BridgeError('INVALID_ARGUMENT', 'memory.' + key + ' 必须是正整数。');
        return Math.min(v, hardMax);
    };
    return {
        maxEntriesPerScope: cap('maxEntriesPerScope', 2000, 2000),
        maxContentChars: cap('maxContentChars', 2000, 2000),
        maxResults: cap('maxResults', 12, 12)
    };
}

/** 政策视图：内置或自定义；未知返回 null（调用方拒绝派单）。 */
export function policyViewOf(config: DecisionConfigFile, policyId: string): DecisionPolicyView | null {
    const builtin = BUILTIN_POLICY_VIEWS.find((p) => p.policyId === policyId);
    if (builtin) {
        const revision = Math.max(1, config.configRevision);
        return { ...builtin, revision };
    }
    const custom = config.customPolicies.find((p) => p.id === policyId);
    if (!custom) return null;
    return {
        policyId: custom.id,
        label: custom.label,
        revision: Math.max(1, config.configRevision),
        allowedTools: [...custom.allowedTools],
        allowedLocations: [...custom.allowedLocations],
        toolRestrictions: custom.toolRestrictions,
        budgetCaps: custom.budgetCaps
    };
}

export function publicProviderView(entry: DecisionProviderEntry, hasSecret: boolean): ProviderPublicView {
    let localLike = false;
    try {
        const url = new URL(entry.baseUrl);
        localLike = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname.endsWith('.local')
            || url.hostname.startsWith('192.168.') || url.hostname.startsWith('10.');
    } catch {
        localLike = false;
    }
    return {
        id: entry.id,
        label: entry.label,
        protocol: entry.protocol,
        model: entry.model,
        baseUrl: entry.baseUrl,
        hasSecret,
        authMode: entry.authMode,
        decisionFormat: entry.decisionFormat,
        timeoutMs: entry.timeoutMs ?? 30_000,
        maxOutputTokens: entry.maxOutputTokens ?? 2048,
        allowPrivateNetwork: entry.allowPrivateNetwork === true,
        allowPlainHttp: entry.allowPlainHttp === true,
        localLike,
        secretRef: entry.secretRef,
        maxOutputParameter: entry.maxOutputParameter ?? 'max_completion_tokens',
        supportsTemperature: entry.supportsTemperature === true,
        temperature: entry.temperature,
        supportsReasoning: entry.supportsReasoning === true,
        reasoningEffort: entry.reasoningEffort,
        secretFile: entry.secretFile ?? null
    };
}

/** 只读存储：文件写入统一走原子替换 + 0600。 */
export class DecisionConfigStore {
    private config: DecisionConfigFile;
    private loadError: string | null;

    constructor(private readonly paths: DataPaths) {
        const loaded = loadDecisionConfig(paths);
        this.config = loaded.config;
        this.loadError = loaded.error;
    }

    get current(): DecisionConfigFile {
        return this.config;
    }

    get revision(): number {
        return this.config.configRevision;
    }

    get error(): string | null {
        return this.loadError;
    }

    reload(): void {
        const loaded = loadDecisionConfig(this.paths);
        this.config = loaded.config;
        this.loadError = loaded.error;
    }

    /** CAS 写入：revision 必须匹配，成功后 revision+1。 */
    save(input: unknown, expectedRevision: number): DecisionConfigFile {
        if (this.loadError !== null) {
            // 配置损坏时内存里是禁用默认值；直接保存会覆盖原文件，先要求人工处理。
            throw new BridgeError('TASK_STORAGE_UNAVAILABLE', '决策配置当前无法解析，已拒绝覆盖；请先修复或备份原文件。');
        }
        if (expectedRevision !== this.config.configRevision) {
            throw new BridgeError('TASK_REVISION_CONFLICT', '配置版本冲突：请刷新后重试。', {
                detail: { expectedRevision, currentRevision: this.config.configRevision }
            });
        }
        // 以当前配置为底再覆盖入参：Web 只提交自己编辑的字段时，不会把 clientLimits、
        // profiles、sharing、memory 等未提交配置悄悄重置为默认值。
        const merged = { ...structuredCloneSafe(this.config), ...(input as Record<string, unknown>), configRevision: expectedRevision + 1 };
        const next = normalizeConfig(merged);
        this.persist(next);
        this.config = next;
        this.loadError = null;
        return next;
    }

    patch(patch: Record<string, unknown>, expectedRevision: number): DecisionConfigFile {
        const merged = { ...structuredCloneSafe(this.config), ...patch, configRevision: expectedRevision + 1 };
        return this.save(merged, expectedRevision);
    }

    private persist(config: DecisionConfigFile): void {
        atomicWriteFile(this.paths.decisionConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    }

    view(hasSecret: (ref: string | null) => boolean): DecisionConfigView {
        return {
            schemaVersion: 1,
            configRevision: this.config.configRevision,
            enabled: this.config.enabled,
            defaultProviderId: this.config.defaultProviderId,
            defaultPolicyId: this.config.defaultPolicyId,
            providers: this.config.providers.map((provider) => publicProviderView(provider, hasSecret(provider.secretRef))),
            authorizedClientIds: [...this.config.authorizedClientIds],
            limits: { ...this.config.limits },
            activeProfileId: this.config.activeProfileId,
            profiles: this.config.profiles.map((profile) => ({ ...profile })),
            policies: [
                ...BUILTIN_POLICY_VIEWS.map((policy) => ({ id: policy.policyId, label: policy.label, builtin: true })),
                ...this.config.customPolicies.map((policy) => ({ id: policy.id, label: policy.label, builtin: false }))
            ],
            customPolicies: this.config.customPolicies.map((policy) => ({
                id: policy.id,
                label: policy.label,
                allowedTools: [...policy.allowedTools],
                allowedLocations: [...policy.allowedLocations],
                toolRestrictions: { ...policy.toolRestrictions } as Record<string, unknown>,
                budgetCaps: { ...policy.budgetCaps }
            })),
            memory: { ...this.config.memory },
            sharing: { ...this.config.sharing },
            multiplayerAutomation: this.config.multiplayerAutomation,
            resumeAfterRestart: this.config.resumeAfterRestart
        };
    }
}

/** 只用于复制配置对象；配置文件本身是纯 JSON，不含函数。 */
function structuredCloneSafe<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
