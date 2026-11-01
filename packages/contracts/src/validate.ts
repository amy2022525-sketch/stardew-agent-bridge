/**
 * 工具参数校验：JSON Schema（MCP 层）+ 业务边界（游戏侧仍独立校验）。
 * 任何非法参数必须在产生游戏副作用之前被拒绝。
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema, ToolSpec } from './tools.js';
import { getTool } from './tools.js';
import {
    DECISION_ID_MAX_LENGTH,
    isDecisionId,
    MEMORY_CONTENT_MAX_CHARS,
    MEMORY_KINDS,
    MEMORY_QUERY_MAX_CHARS,
    MEMORY_TITLE_MAX_CHARS,
    SUCCESS_CRITERION_KINDS,
    TASK_GOAL_MAX_CHARS,
    TASK_LIST_MAX_LIMIT,
    TASK_MAX_CONSTRAINT_LOCATIONS,
    TASK_MAX_CRITERIA,
    TASK_MAX_TILES_PER_CRITERION,
    TASK_REQUEST_MAX_BYTES,
    TASK_TITLE_MAX_CHARS,
    TASK_WAIT_TIMEOUT_MAX_MS,
    utf8ByteLength
} from './decision.js';

// 静态导入让发布打包器把 Ajv 一起收进单文件，安装后无需开发目录的 node_modules。
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, allowUnionTypes: true });
const compiled = new Map<string, ValidateFunction>();

function compile(name: string, schema: JsonSchema): ValidateFunction {
    const cached = compiled.get(name);
    if (cached) return cached;
    const fn = ajv.compile(schema);
    compiled.set(name, fn);
    return fn;
}

export interface ValidationIssue {
    path: string;
    message: string;
}

export type ValidationResult =
    | { ok: true; tool: ToolSpec; args: Record<string, unknown> }
    | { ok: false; tool: ToolSpec | undefined; issues: ValidationIssue[] };

function formatAjvError(error: { instancePath?: string; message?: string; params?: unknown }): ValidationIssue {
    const path = error.instancePath && error.instancePath.length > 0 ? error.instancePath.replace(/^\//, '') : '(root)';
    return { path, message: error.message ?? '参数不合法' };
}

/**
 * 校验工具参数。返回规范化后的参数（未提供 controlSessionId/actionId 时保持缺省）。
 */
export function validateToolArguments(toolName: string, rawArgs: unknown): ValidationResult {
    const tool = getTool(toolName);
    if (!tool) return { ok: false, tool: undefined, issues: [{ path: '(tool)', message: `未知工具：${toolName}` }] };
    if (rawArgs !== undefined && rawArgs !== null && typeof rawArgs !== 'object') {
        return { ok: false, tool, issues: [{ path: '(root)', message: 'arguments 必须是对象' }] };
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const fn = compile(tool.name, tool.inputSchema);
    if (!fn(args)) {
        return { ok: false, tool, issues: (fn.errors ?? []).map(formatAjvError) };
    }
    const business = checkBusinessRules(tool, args);
    if (business.length > 0) return { ok: false, tool, issues: business };
    return { ok: true, tool, args };
}

/** 业务规则：schema 无法表达的互斥、条件必填与跨字段范围。 */
export function checkBusinessRules(tool: ToolSpec, args: Record<string, unknown>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const add = (path: string, message: string) => issues.push({ path, message });

    if (tool.command === 'move') {
        const hasNear = typeof args.near === 'string';
        const hasX = typeof args.x === 'number';
        const hasY = typeof args.y === 'number';
        if (hasNear === (hasX || hasY)) add('near', 'move 需要 near 或 x/y 之一，且互斥');
        if (!hasNear && hasX !== hasY) add('x', 'x 与 y 必须同时提供');
        if (hasX && hasY && (args.x as number) < -1) add('x', 'x 必须 ≥ -1');
        if (hasX && hasY && (args.y as number) < -1) add('y', 'y 必须 ≥ -1');
    }

    if (tool.command === 'container') {
        const operation = args.operation;
        if (operation !== 'list') {
            if (typeof args.slot !== 'number') add('slot', `${String(operation)} 需要 slot`);
            if (typeof args.count !== 'number') add('count', `${String(operation)} 需要 count`);
            if (typeof args.slot === 'number') {
                const max = operation === 'withdraw' ? 71 : 35;
                if (args.slot < 0 || args.slot > max) add('slot', `${String(operation)} 的 slot 必须在 0–${max}`);
            }
        }
    }

    if (tool.command === 'equip') {
        if (args.operation === 'unequip' && typeof args.slot !== 'number') add('slot', 'unequip 需要接收装备的空背包槽位');
    }

    if (tool.command === 'combat') {
        if (typeof args.milliseconds === 'number' && typeof args.minHealth === 'number' && args.milliseconds < 100) {
            add('milliseconds', 'milliseconds 必须 ≥ 100');
        }
    }

    if (tool.command === 'bridge:session') {
        const operation = args.operation;
        if (operation !== 'start' && operation !== 'status' && operation !== 'checkpoint' && operation !== 'end') {
            add('operation', 'operation 需要 start/status/checkpoint/end');
        }
        if (operation === 'start' && args.mode !== undefined && args.mode !== 'step' && args.mode !== 'realtime') {
            add('mode', 'mode 需要 step 或 realtime');
        }
        if (operation === 'checkpoint') {
            const any = ['goal', 'progress', 'next', 'constraints'].some((key) => typeof args[key] === 'string');
            if (!any) add('goal', 'checkpoint 至少需要 goal/progress/next/constraints 之一');
        }
    }

    // ---------------- 决策执行器新工具（bridge:decision_*） ----------------
    const needString = (key: string, label: string) => {
        if (typeof args[key] !== 'string' || (args[key] as string).trim().length === 0) add(key, label + ' 需要非空 ' + key);
    };
    const needRevision = (label: string) => {
        if (typeof args.expectedRevision !== 'number' || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 1) {
            add('expectedRevision', label + ' 需要正整数 expectedRevision');
        }
    };

    if (tool.command === 'bridge:decision_task') {
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (!isDecisionId(args.requestId)) add('requestId', 'requestId 必须是 1–' + DECISION_ID_MAX_LENGTH + ' 个字符的安全 ASCII ID');
        for (const key of ['taskId', 'providerId', 'policyId', 'profileId']) {
            if (args[key] !== undefined && !isDecisionId(args[key])) add(key, key + ' 必须是 1–' + DECISION_ID_MAX_LENGTH + ' 个字符的安全 ASCII ID');
        }
        if (operation === 'submit') {
            needString('contextToken', 'submit');
            needString('title', 'submit');
            needString('goal', 'submit');
            if (typeof args.title === 'string' && args.title.length > TASK_TITLE_MAX_CHARS) add('title', 'title 最多 ' + TASK_TITLE_MAX_CHARS + ' 字符');
            if (typeof args.goal === 'string') {
                if (args.goal.length > TASK_GOAL_MAX_CHARS) add('goal', 'goal 最多 ' + TASK_GOAL_MAX_CHARS + ' 字符');
                if (args.goal.trim().length === 0) add('goal', 'goal 不能为空');
            }
            if (utf8ByteLength(JSON.stringify(args)) > TASK_REQUEST_MAX_BYTES) add('(root)', '请求整体超过 ' + TASK_REQUEST_MAX_BYTES + ' 字节上限');
            const constraints = (args.constraints ?? undefined) as Record<string, unknown> | undefined;
            if (constraints !== undefined) {
                if (Array.isArray(constraints.locations)) {
                    if (constraints.locations.length > TASK_MAX_CONSTRAINT_LOCATIONS) add('constraints.locations', 'locations 最多 ' + TASK_MAX_CONSTRAINT_LOCATIONS + ' 项');
                    for (const loc of constraints.locations) {
                        if (typeof loc !== 'string' || loc.length === 0 || loc.length > 64) add('constraints.locations', '地点必须是 64 字符以内的非空字符串');
                    }
                }
                for (const key of ['stopEnergyAtOrBelow', 'stopHealthAtOrBelow', 'latestStartGameTime', 'maxGoldSpend']) {
                    const v = constraints[key];
                    if (v !== undefined && v !== null) {
                        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) add('constraints.' + key, key + ' 必须是非负有限数');
                    }
                }
                if (typeof constraints.latestStartGameTime === 'number' && constraints.latestStartGameTime > 2600) add('constraints.latestStartGameTime', 'latestStartGameTime 超出游戏时间范围');
                if (constraints.allowDayChange === true) add('constraints.allowDayChange', '本版本禁止跨日续跑，allowDayChange 仅支持 false');
            }
            const budget = (args.budget ?? undefined) as Record<string, unknown> | undefined;
            if (budget !== undefined) {
                for (const key of ['maxModelCalls', 'maxWriteActions', 'maxActiveMs', 'maxAccountedTokens']) {
                    const v = budget[key];
                    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) add('budget.' + key, key + ' 必须是正整数');
                }
            }
            if (args.successCriteria !== undefined) {
                if (!Array.isArray(args.successCriteria)) {
                    add('successCriteria', 'successCriteria 必须是数组');
                } else {
                    if (args.successCriteria.length > TASK_MAX_CRITERIA) add('successCriteria', '成功条件最多 ' + TASK_MAX_CRITERIA + ' 条');
                    args.successCriteria.forEach((item, index) => {
                        const criterion = item as Record<string, unknown>;
                        const kind = criterion ? criterion.kind : undefined;
                        if (typeof kind !== 'string' || !(SUCCESS_CRITERION_KINDS as readonly string[]).includes(kind)) {
                            add('successCriteria.' + index, '未知成功条件 kind');
                            return;
                        }
                        if (kind === 'crop_tiles_watered') {
                            const tiles = criterion.tiles;
                            if (!Array.isArray(tiles) || tiles.length === 0) add('successCriteria.' + index, 'crop_tiles_watered 需要非空 tiles');
                            else if (tiles.length > TASK_MAX_TILES_PER_CRITERION) add('successCriteria.' + index, '每条成功条件最多 ' + TASK_MAX_TILES_PER_CRITERION + ' 格');
                            else {
                                for (const tile of tiles) {
                                    const t = tile as Record<string, unknown>;
                                    if (!t || typeof t.x !== 'number' || typeof t.y !== 'number' || !Number.isInteger(t.x) || !Number.isInteger(t.y) || t.x < 0 || t.y < 0) {
                                        add('successCriteria.' + index, '地块坐标必须是非负整数');
                                        break;
                                    }
                                }
                            }
                        }
                        if (kind === 'at_tile') {
                            const tolerance = criterion.tolerance;
                            if (tolerance !== undefined && (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)) {
                                add('successCriteria.' + index, 'tolerance 必须在 0–1');
                            }
                            if (typeof criterion.x !== 'number' || typeof criterion.y !== 'number' || criterion.x < 0 || criterion.y < 0) {
                                add('successCriteria.' + index, 'at_tile 需要非负整数坐标');
                            }
                        }
                        if (kind === 'inventory_at_least') {
                            if (typeof criterion.count !== 'number' || !Number.isInteger(criterion.count) || criterion.count <= 0) {
                                add('successCriteria.' + index, 'inventory_at_least 需要正整数 count');
                            }
                            if (typeof criterion.itemId !== 'string' || criterion.itemId.length === 0) add('successCriteria.' + index, 'inventory_at_least 需要 itemId');
                        }
                    });
                }
            }
        }
        if (operation === 'update') {
            needString('taskId', 'update');
            needRevision('update');
            if (args.patch === undefined || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
                add('patch', 'update 需要 patch 对象');
            } else {
                const allowedPatch = ['title', 'goal', 'constraints', 'budget', 'successCriteria'];
                for (const key of Object.keys(args.patch as Record<string, unknown>)) {
                    if (!allowedPatch.includes(key)) add('patch.' + key, 'patch 字段不在白名单（' + allowedPatch.join('/') + '）');
                }
            }
        }
        if (operation === 'pause' || operation === 'cancel') needString('taskId', operation);
        if (operation === 'resume' || operation === 'reply') {
            needString('taskId', operation);
            needString('contextToken', operation);
            needRevision(operation);
            if (operation === 'reply') {
                needString('answer', 'reply');
                if (typeof args.answer === 'string' && args.answer.length > TASK_GOAL_MAX_CHARS) add('answer', 'answer 过长');
            }
        }
        if (operation === 'resolve') {
            needString('taskId', 'resolve');
            needRevision('resolve');
            if (args.resolution !== 'accept_completion' && args.resolution !== 'reviewed_pause' && args.resolution !== 'reject_completion') {
                add('resolution', 'resolution 限定 accept_completion/reviewed_pause/reject_completion');
            }
            needString('note', 'resolve');
        }
    }

    if (tool.command === 'bridge:decision_task_status') {
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (operation !== 'list') needString('taskId', operation);
        if (args.taskId !== undefined && !isDecisionId(args.taskId)) add('taskId', 'taskId 必须是 1–' + DECISION_ID_MAX_LENGTH + ' 个字符的安全 ASCII ID');
        if (operation === 'list' && args.limit !== undefined) {
            if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > TASK_LIST_MAX_LIMIT) {
                add('limit', 'limit 必须在 1–' + TASK_LIST_MAX_LIMIT);
            }
        }
        if (operation === 'wait') {
            if (typeof args.afterStateVersion !== 'number' || !Number.isInteger(args.afterStateVersion) || args.afterStateVersion < 0) {
                add('afterStateVersion', 'wait 需要非负整数 afterStateVersion');
            }
            if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isInteger(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > TASK_WAIT_TIMEOUT_MAX_MS)) {
                add('timeoutMs', 'timeoutMs 必须在 0–' + TASK_WAIT_TIMEOUT_MAX_MS);
            }
        }
    }

    if (tool.command === 'bridge:decision_context') {
        if (args.operation !== 'current') add('operation', 'operation 仅支持 current');
        if (args.profileId !== undefined && !isDecisionId(args.profileId)) add('profileId', 'profileId 必须是 1–' + DECISION_ID_MAX_LENGTH + ' 个字符的安全 ASCII ID');
    }

    if (tool.command === 'bridge:decision_memory') {
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (operation === 'search') {
            if (typeof args.query !== 'string' || args.query.length === 0) add('query', 'search 需要 query');
            else if (args.query.length > MEMORY_QUERY_MAX_CHARS) add('query', 'query 最多 ' + MEMORY_QUERY_MAX_CHARS + ' 字符');
        }
        if (operation === 'get' || operation === 'archive') {
            needString('memoryId', operation);
            if (args.memoryId !== undefined && !isDecisionId(args.memoryId)) add('memoryId', 'memoryId 必须是安全 ASCII ID');
        }
        if (operation === 'add') {
            needString('title', 'add');
            needString('content', 'add');
            if (typeof args.title === 'string' && args.title.length > MEMORY_TITLE_MAX_CHARS) add('title', 'title 最多 ' + MEMORY_TITLE_MAX_CHARS + ' 字符');
            if (typeof args.content === 'string' && args.content.length > MEMORY_CONTENT_MAX_CHARS) add('content', 'content 最多 ' + MEMORY_CONTENT_MAX_CHARS + ' 字符');
            if (typeof args.kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(args.kind)) add('kind', 'add 需要已知记忆 kind');
            if (args.sourceType !== 'main_model' && args.sourceType !== 'user') add('sourceType', 'add 必须声明来源（main_model/user）；不得伪标 native_game');
        }
        if (operation === 'update') {
            needString('memoryId', 'update');
            needRevision('update');
        }
        if (typeof args.expiresAt === 'string' && Number.isNaN(Date.parse(args.expiresAt))) {
            add('expiresAt', 'expiresAt 必须是可解析的 ISO 时间或 null');
        }
    }

    return issues;
}

/** 把校验问题压成单行可读文本，供 MCP isError 结果使用。 */
export function describeIssues(issues: ValidationIssue[]): string {
    return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}
