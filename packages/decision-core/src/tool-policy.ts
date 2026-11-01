/**
 * 工具许可（§15）：effectiveTools = 注册工具 ∩ Mod 当前能力 ∩ Web policy ∩ 任务收紧。
 * 通用参数防绕过：拒绝 actionId/controlSessionId/owner/epoch 注入；guard 为静态结构，
 * 不执行任何脚本/正则/SQL。政策快照冻结供审计，每轮再读收紧（放宽不自动扩权）。
 */
import type { ToolSpec } from "@sab/contracts";
import { BridgeError, getTool, isWorldWrite, TOOL_NAMES } from "@sab/contracts";
import type { DecisionPolicyView, ToolArgumentGuard } from "./ports.js";

/**
 * 永不暴露给执行模型的工具：控制会话、任务递归、配置/凭据、存档读写、联机、
 * 截图（D1 不依赖视觉模型）、暂停（会打开菜单，属于人工操作）与诊断。
 */
export const NEVER_FOR_EXECUTOR: readonly string[] = [
    "stardew_session", "stardew_stop", "stardew_task", "stardew_task_status",
    "stardew_context", "stardew_memory", "stardew_multiplayer", "stardew_saves",
    "stardew_load", "stardew_screenshot", "stardew_pause", "stardew_doctor"
];

/**
 * custom 政策里无法给出“已实现的参数级保护”的工具，一律拒绝保存（§15.2）：
 * - buy：需要按货架价格预留金额与对账，D1 未实现；
 * - interact/menu：需要目标种类与所选物品的联动保护，D1 未实现；
 * - wait：可被用来维持租约，不允许执行模型自行等待。
 */
export const CUSTOM_POLICY_DENIED_TOOLS: readonly string[] = [
    ...NEVER_FOR_EXECUTOR, "stardew_buy", "stardew_interact", "stardew_menu", "stardew_wait",
    // Recipe inputs and container withdrawal contents are not in the current snapshot.
    // An item allowlist cannot protect them without additional evidence.
    "stardew_craft", "stardew_container"
];

/** 可消费/改变物品的工具必须同时配置下列 guard，否则视为“没有实际保护”。 */
const REQUIRED_GUARDS: Record<string, readonly (keyof ToolArgumentGuard)[]> = {
    "stardew_use": ["waterOnly"],
    "stardew_ship": ["allowedItemIds", "maxCountPerAction"],
    "stardew_container": ["allowedItemIds", "maxCountPerAction"],
    "stardew_craft": ["allowedItemIds", "maxCountPerAction"],
    "stardew_place": ["allowedItemIds", "maxCountPerAction"],
    "stardew_eat": ["allowedItemIds", "maxCountPerAction"],
    "stardew_equip": ["allowedItemIds"]
};

export interface CustomPolicyCheck {
    ok: boolean;
    issues: string[];
}

/**
 * 校验 custom 政策的工具与 guard 组合。规则与 computeEffectiveTools 共用同一张表，
 * 避免“配置里写支持、运行时才报 UNSUPPORTED”。
 */
export function validateCustomPolicyTools(
    allowedTools: readonly string[],
    restrictions: Record<string, ToolArgumentGuard>
): CustomPolicyCheck {
    const issues: string[] = [];
    // guard 值必须是静态标量/字符串数组：不接受正则字符串、表达式或任意对象。
    for (const [toolName, guard] of Object.entries(restrictions)) {
        if (guard.waterOnly !== undefined && typeof guard.waterOnly !== "boolean") issues.push(`${toolName}.waterOnly 必须是布尔值`);
        if (guard.maxCountPerAction !== undefined && (!Number.isInteger(guard.maxCountPerAction) || guard.maxCountPerAction <= 0)) {
            issues.push(`${toolName}.maxCountPerAction 必须是正整数`);
        }
        if (guard.allowedItemIds !== undefined) {
            if (!Array.isArray(guard.allowedItemIds) || guard.allowedItemIds.length === 0
                || guard.allowedItemIds.some((id) => typeof id !== "string" || id.length === 0)) {
                issues.push(`${toolName}.allowedItemIds 必须是非空字符串数组`);
            }
        }
        if (guard.maxGoldSpendPerAction !== undefined && (typeof guard.maxGoldSpendPerAction !== "number" || !Number.isFinite(guard.maxGoldSpendPerAction) || guard.maxGoldSpendPerAction < 0)) {
            issues.push(`${toolName}.maxGoldSpendPerAction 必须是非负有限数`);
        }
    }
    for (const name of allowedTools) {
        const spec = getTool(name);
        if (!spec) {
            issues.push("未知工具：" + name);
            continue;
        }
        if (CUSTOM_POLICY_DENIED_TOOLS.includes(name)) {
            issues.push(`工具 ${name} 在 D1 没有已实现的参数级保护，不能由 custom 政策开启`);
            continue;
        }
        const required = REQUIRED_GUARDS[name];
        if (!required) continue;
        const guard = restrictions[name];
        if (!guard) {
            issues.push(`工具 ${name} 需要 ${required.join("/")} 保护`);
            continue;
        }
        for (const key of required) {
            if (key === "maxCountPerAction") {
                if (typeof guard.maxCountPerAction !== "number") issues.push(`工具 ${name} 需要 maxCountPerAction`);
            } else if (key === "allowedItemIds") {
                if (!Array.isArray(guard.allowedItemIds) || guard.allowedItemIds.length === 0) issues.push(`工具 ${name} 需要非空 allowedItemIds`);
            } else if (key === "waterOnly") {
                if (guard.waterOnly !== true) issues.push(`工具 ${name} 需要 waterOnly`);
            }
        }
    }
    return { ok: issues.length === 0, issues };
}

export interface EffectiveToolSet {
    toolNames: string[];
    /** 每个允许工具的完整 schema（从现有 registry 派生，不手抄参数表）。 */
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

export function computeEffectiveTools(policy: DecisionPolicyView, modCapabilities: readonly string[]): EffectiveToolSet {
    const registered = new Set<string>(TOOL_NAMES);
    const capabilities = new Set(modCapabilities);
    const names: string[] = [];
    for (const name of policy.allowedTools) {
        if (NEVER_FOR_EXECUTOR.includes(name)) continue;
        if (!registered.has(name)) continue;
        const tool = getTool(name);
        if (!tool) continue;
        if (tool.kind === "control") continue;
        if (tool.command === "bridge:status") {
            // 状态查询由 Bridge 本地合成，不经过 Mod；只读且对执行模型有用（控制者/未决动作/账本）。
            names.push(name);
            continue;
        }
        // 其它 bridge: 命令属于 Bridge 业务（任务/上下文/记忆），不是执行模型可选项。
        if (tool.command.startsWith("bridge:")) continue;
        if (capabilities.size > 0 && !capabilities.has(tool.command)) continue;
        names.push(name);
    }
    names.sort();
    return {
        toolNames: names,
        tools: names.map((name) => {
            const spec: ToolSpec = getTool(name) as ToolSpec;
            return { name: spec.name, description: spec.description, inputSchema: spec.inputSchema as Record<string, unknown> };
        })
    };
}

/** 任务级收紧：只能在政策交集上再缩小，不能放宽。 */
export function tightenWithTask(effective: EffectiveToolSet, taskAllowedTools?: string[]): EffectiveToolSet {
    if (!taskAllowedTools || taskAllowedTools.length === 0) return effective;
    const allow = new Set(taskAllowedTools);
    const toolNames = effective.toolNames.filter((n) => allow.has(n));
    return { toolNames, tools: effective.tools.filter((t) => allow.has(t.name)) };
}

/** 政策放宽检测：当前政策相对冻结快照只允许收紧。 */
export function detectPolicyChanges(frozen: DecisionPolicyView, current: DecisionPolicyView): { revokedTools: string[]; tightened: boolean; loosened: boolean } {
    const currentSet = new Set(current.allowedTools);
    const revokedTools = frozen.allowedTools.filter((n) => !currentSet.has(n));
    const loosenedTools = current.allowedTools.filter((n) => !new Set(frozen.allowedTools).has(n));
    const locationLoosened = current.allowedLocations.some((l) => !frozen.allowedLocations.includes(l) && frozen.allowedLocations.length > 0);
    return {
        revokedTools,
        tightened: revokedTools.length > 0 || current.allowedLocations.length < frozen.allowedLocations.length,
        loosened: loosenedTools.length > 0 || locationLoosened || current.revision > frozen.revision
    };
}

export interface GuardRejection {
    ok: false;
    reason: string;
}

export type GuardResult = { ok: true } | GuardRejection;

/**
 * 服务端注入字段防绕过：执行模型的 argumentsJson 里绝不允许出现这些键。
 */
export function rejectInjectedIdentityFields(args: Record<string, unknown>): GuardResult {
    for (const banned of ["actionId", "controlSessionId", "owner", "epoch", "clientId", "actor"]) {
        if (Object.prototype.hasOwnProperty.call(args, banned)) {
            return { ok: false, reason: `参数不允许包含服务端保留字段：${banned}` };
        }
    }
    return { ok: true };
}

/**
 * 静态参数 guard 检查。未知 guard 字段视为未实现 → 拒绝（不能假装有保护）。
 * water-only 需要“槽位→工具”的只读映射与本轮已观察的待浇作物集合，由 runner 从快照提供。
 */
export interface GuardContext {
    selectedToolForSlot(slot: string): "watering_can" | "other" | "unknown";
    currentSelectedSlot: number | null;
    itemIdForSlot(slot: number): string | null;
    /** 本轮需要浇水的作物与由游戏确认 refillable 的水源 ref。 */
    observedWaterTargets: ReadonlySet<string>;
}

export function checkToolGuard(toolName: string, args: Record<string, unknown>, guard: ToolArgumentGuard | undefined, context: GuardContext): GuardResult {
    if (!guard) return { ok: true };
    for (const key of Object.keys(guard)) {
        if (!["waterOnly", "maxCountPerAction", "allowedItemIds", "maxGoldSpendPerAction"].includes(key)) {
            return { ok: false, reason: `政策包含未实现的参数保护：${key}` };
        }
    }
    if (guard.waterOnly) {
        // 浇水闭环 = select（水壶槽位）+ use（已观察 needsWater 作物格）+ move；不开放其它写工具。
        if (toolName !== "stardew_use" && toolName !== "stardew_select" && toolName !== "stardew_move") {
            return { ok: false, reason: "water-only 政策只允许移动、选择工具与对作物使用" };
        }
        if (toolName === "stardew_select") {
            const tool = context.selectedToolForSlot(String(args.slot ?? ""));
            if (tool !== "watering_can") return { ok: false, reason: "water-only 政策下只允许选择水壶" };
        }
        if (toolName === "stardew_use") {
            if (context.currentSelectedSlot === null
                || context.selectedToolForSlot(String(context.currentSelectedSlot)) !== "watering_can") {
                return { ok: false, reason: "use 前必须确认当前实际选中水壶" };
            }
            const target = args.target;
            if (typeof target !== "string" || !context.observedWaterTargets.has(target)) {
                return { ok: false, reason: "use 的目标必须是本轮待浇作物或游戏确认可补水的水源" };
            }
        }
    }
    if (typeof guard.maxCountPerAction === "number") {
        const count = args.count ?? args.quantity ?? 1;
        if (typeof count === "number" && count > guard.maxCountPerAction) {
            return { ok: false, reason: `单次数量超过政策上限 ${String(guard.maxCountPerAction)}` };
        }
    }
    if (guard.allowedItemIds !== undefined) {
        // 空清单不是“不限制”，而是配置错误：运行时拒绝，绝不静默放行。
        if (guard.allowedItemIds.length === 0) return { ok: false, reason: "政策物品白名单为空，拒绝执行" };
        if (toolName === 'stardew_equip' && args.operation === 'unequip') {
            return { ok: false, reason: "D1 没有可归因的装备来源观察，不能按物品白名单卸下装备" };
        }
        const itemId = typeof args.slot === 'number'
            ? context.itemIdForSlot(args.slot) : args.itemId ?? args.item;
        if (typeof itemId !== "string" || !guard.allowedItemIds.includes(itemId)) {
            return { ok: false, reason: "物品不在政策允许清单" };
        }
    }
    if (typeof guard.maxGoldSpendPerAction === "number") {
        const price = args.maxPrice ?? args.price ?? args.gold;
        if (typeof price === "number" && price > guard.maxGoldSpendPerAction) {
            return { ok: false, reason: "单次金币支出超过政策上限" };
        }
    }
    return { ok: true };
}

/** Combine frozen and current policy without treating an empty intersection as unrestricted. */
export function intersectPolicies(frozen: DecisionPolicyView, current: DecisionPolicyView): DecisionPolicyView {
    const allowedLocations = frozen.allowedLocations.length === 0 ? [...current.allowedLocations]
        : current.allowedLocations.length === 0 ? [...frozen.allowedLocations]
        : frozen.allowedLocations.filter(location => current.allowedLocations.includes(location));
    if (frozen.allowedLocations.length > 0 && current.allowedLocations.length > 0 && allowedLocations.length === 0) {
        throw new BridgeError('POLICY_DENIED', '原政策与当前政策没有共同允许地图。');
    }
    const toolRestrictions: Record<string, ToolArgumentGuard> = {};
    for (const tool of new Set([...Object.keys(frozen.toolRestrictions), ...Object.keys(current.toolRestrictions)])) {
        const before = frozen.toolRestrictions[tool] ?? {};
        const after = current.toolRestrictions[tool] ?? {};
        const guard: ToolArgumentGuard = {};
        if (before.waterOnly || after.waterOnly) guard.waterOnly = true;
        if (before.allowedItemIds || after.allowedItemIds) {
            guard.allowedItemIds = before.allowedItemIds && after.allowedItemIds
                ? before.allowedItemIds.filter(id => after.allowedItemIds?.includes(id))
                : [...(before.allowedItemIds ?? after.allowedItemIds ?? [])];
        }
        for (const key of ['maxCountPerAction', 'maxGoldSpendPerAction'] as const) {
            const values = [before[key], after[key]].filter((value): value is number => typeof value === 'number');
            if (values.length) guard[key] = Math.min(...values);
        }
        toolRestrictions[tool] = guard;
    }
    return { ...frozen, revision: Math.max(frozen.revision, current.revision),
        allowedTools: frozen.allowedTools.filter(tool => current.allowedTools.includes(tool)),
        allowedLocations, toolRestrictions };
}

/** 地图允许列表检查（目的地级；路径级围栏 D1 未实现，custom 须拒绝该选项）。 */
export function checkLocationAllowed(location: string | null, allowedLocations: string[]): boolean {
    if (!location) return allowedLocations.length === 0;
    if (allowedLocations.length === 0) return true;
    return allowedLocations.includes(location);
}

export function isWriteTool(toolName: string): boolean {
    const tool = getTool(toolName);
    if (!tool) return false;
    return isWorldWrite(tool);
}
