import { createHash } from 'node:crypto';
import { BridgeError } from './errors.js';

export const MOD_PROTOCOL_V2 = 'stardew-agent-bridge/2' as const;
export const MULTIPLAYER_SCHEMA_VERSION = 2;
export interface ActorContext {
    worldId: string; hostFarmerId: string; hostSessionId: string; actorFarmerId: string;
    actorSessionId: string; connectionId: string; policyRevision: number; permissionLeaseId: string;
    worldGeneration: number; sceneGeneration: number; dayGeneration: number;
}
export interface MultiplayerStatus {
    enabled: boolean; role: 'farmhand' | 'host-coordinator'; state: string; reason: string;
    worldId: string | null; actorFarmerId: string | null; hostFarmerId: string | null;
    actorSessionId: string; hostSessionId: string | null; connectionId: string | null;
    policyRevision: number; permissionLeaseHeld: boolean; permissionRemainingMs: number;
    actorContext: ActorContext | null; phase: string; phaseSequence: number; dayGeneration: number; saveRevision: number;
    policy?: Record<string, unknown> | null;
}
export interface MultiplayerReceiptDetail {
    actor: ActorContext;
    confirmationScope: 'none' | 'local_observed' | 'host_observed' | 'replicated_observed';
    durability: 'not_saved' | 'host_save_observed_after_effect' | 'unknown';
    resourceScope: 'actor' | 'shared_world' | 'shared_wallet' | 'shared_container';
    worldContinues: boolean | null;
}
export function canonicalFarmerId(value: unknown): string {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === '-0' || value.length > 20) throw new BridgeError('INVALID_ARGUMENT', 'Farmer ID 必须为规范 Int64 字符串。');
    const id = BigInt(value);
    if (id < -(1n << 63n) || id > (1n << 63n) - 1n) throw new BridgeError('INVALID_ARGUMENT', 'Farmer ID 超出 Int64。');
    return value;
}
export function isActorContext(value: unknown): value is ActorContext {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    try { canonicalFarmerId(v.actorFarmerId); canonicalFarmerId(v.hostFarmerId); } catch { return false; }
    return typeof v.worldId === 'string' && v.worldId.length > 0 && v.worldId.length <= 100
        && ['hostSessionId', 'actorSessionId', 'connectionId', 'permissionLeaseId'].every(k => typeof v[k] === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v[k] as string))
        && ['policyRevision', 'worldGeneration', 'sceneGeneration', 'dayGeneration'].every(k => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0);
}
export function requireActor(status: MultiplayerStatus | undefined): ActorContext {
    if (!status?.enabled) throw new BridgeError('HOST_COORDINATOR_REQUIRED', '联机需要本地 participant 与兼容主机 coordinator。');
    if (!status.permissionLeaseHeld || !isActorContext(status.actorContext)) throw new BridgeError(status.reason === 'none' ? 'HOST_PERMISSION_REQUIRED' : status.reason, '主机许可/角色绑定未就绪，请查看 stardew_multiplayer。');
    return { ...status.actorContext };
}
export function multiplayerDedupKey(scope: Pick<ActorContext, 'worldId' | 'actorFarmerId'>, actionId: string): string {
    canonicalFarmerId(scope.actorFarmerId);
    return 'mp2#' + createHash('sha256').update(JSON.stringify([scope.worldId, scope.actorFarmerId, actionId])).digest('hex');
}
export function actorSessionKey(scope: ActorContext | null | undefined): string | null {
    return scope ? JSON.stringify([scope.worldId, scope.hostSessionId, scope.actorFarmerId, scope.actorSessionId, scope.connectionId, scope.policyRevision]) : null;
}
