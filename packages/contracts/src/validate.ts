/**
 * 工具参数校验：JSON Schema（MCP 层）+ 业务边界（游戏侧仍独立校验）。
 * 任何非法参数必须在产生游戏副作用之前被拒绝。
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema, ToolSpec } from './tools.js';
import { getTool } from './tools.js';

// ajv 8 只发布 CommonJS 入口，这里用 createRequire 显式加载以保证 ESM 下行为一致。
const require = createRequire(import.meta.url);
type AjvInstance = { compile(schema: unknown): ValidateFunction };
const AjvCtor = require('ajv') as new (options?: Record<string, unknown>) => AjvInstance;
const ajv = new AjvCtor({ allErrors: true, strict: false, coerceTypes: false, allowUnionTypes: true });
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

    return issues;
}

/** 把校验问题压成单行可读文本，供 MCP isError 结果使用。 */
export function describeIssues(issues: ValidationIssue[]): string {
    return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}
