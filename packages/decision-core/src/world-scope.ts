/**
 * 作用域与 contextToken（§07/§12.1/§31）：
 * persistent 键 = (profileId, worldId, actorFarmerId)；ephemeral 键 = (profileId, instanceId, worldGeneration)。
 * scopeKey 只作为数据库数据绑定参数，绝不拼接文件路径或 SQL。
 */
import { CONTEXT_TOKEN_TTL_MS, type ScopeMode, type TaskScope, type WorldIdentity } from "@sab/contracts";
import type { Clock } from "./clock.js";

export interface ScopeInputs {
    mode: ScopeMode;
    profileId: string;
    worldIdentity: WorldIdentity | null;
    instanceId: string | null;
    worldGeneration: number | null;
}

/** 规范化作用域键；输入不完整时返回 null（调用方必须拒绝派发）。 */
export function buildScopeKey(inputs: ScopeInputs): string | null {
    if (!inputs.profileId) return null;
    if (inputs.mode === "persistent") {
        if (!inputs.worldIdentity) return null;
        return `p:${inputs.profileId}:${inputs.worldIdentity.worldId}:${inputs.worldIdentity.actorFarmerId}`;
    }
    if (inputs.instanceId === null || inputs.worldGeneration === null) return null;
    return `e:${inputs.profileId}:${inputs.instanceId}:${String(inputs.worldGeneration)}`;
}

export function scopeFromWorldIdentity(profileId: string, identity: WorldIdentity): Omit<TaskScope, "scopeKey" | "mode" | "instanceId"> {
    // persistent 作用域不使用 worldGeneration，但字段保留为 null 以保持形状一致。
    return { profileId, worldId: identity.worldId, actorFarmerId: identity.actorFarmerId, worldGeneration: null };
}

export interface TaskScopeRecord {
    mode: ScopeMode;
    profileId: string;
    worldId: string | null;
    actorFarmerId: string | null;
    instanceId: string | null;
    worldGeneration: number | null;
    scopeKey: string;
}

/** 快照与任务作用域一致性（世界不符 → 条件 unverifiable / 任务 needs_review）。 */
export function snapshotMatchesScope(snapshotWorldId: string | null | undefined, snapshotInstanceId: string, snapshotGeneration: number, scope: TaskScopeRecord): boolean {
    if (scope.mode === "persistent") {
        return typeof snapshotWorldId === "string" && snapshotWorldId === scope.worldId;
    }
    return snapshotInstanceId === scope.instanceId && snapshotGeneration === scope.worldGeneration;
}

export interface ContextTokenRecord {
    tokenHash: string;
    clientId: string;
    profileId: string;
    scopeKey: string;
    worldId: string | null;
    actorFarmerId: string | null;
    instanceId: string | null;
    worldGeneration: number | null;
    issuedAtMs: number;
    expiresAtMs: number;
    /** 一次性消费标记（§17.2：token 与 clientId/profile/世界四元组绑定）。 */
    consumed: boolean;
    /** 已消费并绑定到的任务；仅用于审计，不含明文 token。 */
    boundTaskId?: string;
}

export function issueTokenRecord(init: Omit<ContextTokenRecord, "expiresAtMs" | "consumed">, clock: Clock): ContextTokenRecord {
    return { ...init, expiresAtMs: init.issuedAtMs + CONTEXT_TOKEN_TTL_MS, consumed: false };
}

export function tokenIsUsable(token: ContextTokenRecord, clientId: string, nowMs: number): boolean {
    if (token.consumed) return false;
    if (token.clientId !== clientId) return false;
    return nowMs < token.expiresAtMs;
}

export type DateChangeVerdict = "same_day" | "day_changed" | "unknown";

/** 游戏日期比较：跨日默认暂停（allowDayChange 只能 false → 进入 needs_review 由 runner 处理）。 */
export function compareGameDate(a: { season: string; day: number; year: number } | null | undefined, b: { season: string; day: number; year: number } | null | undefined): DateChangeVerdict {
    if (!a || !b) return "unknown";
    if (a.season === b.season && a.day === b.day && a.year === b.year) return "same_day";
    return "day_changed";
}

/** 旧 ref（@s…/@mp2_…）不入长期记忆；只允许本轮新鲜观察使用。 */
export function isTransientEntityRef(value: string): boolean {
    return value.startsWith("@s") || value.startsWith("@mp2_");
}
