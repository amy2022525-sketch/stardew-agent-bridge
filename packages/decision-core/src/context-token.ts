/**
 * 短期派单上下文 token（§07.3 / §17.2）：128 bit 随机、60 秒有效、仅存散列、
 * 进程内保存、重启即作废。token 不是控制租约，只用于把任务绑定到具体存档/角色，
 * 不授予任何额外工具权限，日志与导出必须遮蔽明文。
 */
import { randomBytes } from 'node:crypto';
import { CONTEXT_TOKEN_RANDOM_BYTES, CONTEXT_TOKEN_TTL_MS } from '@sab/contracts';
import type { ContextTokenPort } from './ports.js';
import { sha256Hex } from './ids.js';
import type { ContextTokenRecord } from './world-scope.js';

export interface BindContextTokenInput {
    clientId: string;
    profileId: string;
    scopeKey: string;
    worldId: string | null;
    actorFarmerId: string | null;
    instanceId: string | null;
    worldGeneration: number | null;
    nowMs: number;
}

export class ContextTokenStore implements ContextTokenPort {
    private readonly records = new Map<string, ContextTokenRecord>();

    /** 签发：明文只返回一次，存储键是 sha256(token)。 */
    issue(input: BindContextTokenInput): { token: string; record: ContextTokenRecord } {
        const token = randomBytes(CONTEXT_TOKEN_RANDOM_BYTES).toString('base64url');
        const tokenHash = sha256Hex(token);
        const record: ContextTokenRecord = {
            tokenHash,
            clientId: input.clientId,
            profileId: input.profileId,
            scopeKey: input.scopeKey,
            worldId: input.worldId,
            actorFarmerId: input.actorFarmerId,
            instanceId: input.instanceId,
            worldGeneration: input.worldGeneration,
            issuedAtMs: input.nowMs,
            expiresAtMs: input.nowMs + CONTEXT_TOKEN_TTL_MS,
            consumed: false
        };
        this.prune(input.nowMs);
        this.records.set(tokenHash, record);
        return { token, record };
    }

    lookup(tokenHash: string): ContextTokenRecord | null {
        const record = this.records.get(tokenHash);
        if (!record) return null;
        if (Date.now() >= record.expiresAtMs) {
            this.records.delete(tokenHash);
            return null;
        }
        return record;
    }

    consume(tokenHash: string, taskId: string): boolean {
        const record = this.records.get(tokenHash);
        if (!record) return false;
        if (record.consumed) return false;
        record.consumed = true;
        // 消费不删除：保留到过期，便于审计“该 token 已绑定到哪个任务”，但不含明文。
        record.boundTaskId = taskId;
        return true;
    }

    /** 撤权或停止锁：让某客户端的全部未消费 token 立即失效。 */
    revokeForClient(clientId: string): number {
        let removed = 0;
        for (const [hash, record] of this.records) {
            if (record.clientId === clientId) {
                this.records.delete(hash);
                removed += 1;
            }
        }
        return removed;
    }

    clear(): void {
        this.records.clear();
    }

    /** 清理过期记录；由签发与查询路径惰性调用，无独立定时器。 */
    prune(nowMs: number): number {
        let removed = 0;
        for (const [hash, record] of this.records) {
            if (nowMs >= record.expiresAtMs) {
                this.records.delete(hash);
                removed += 1;
            }
        }
        return removed;
    }

    get size(): number {
        return this.records.size;
    }
}

/** 供服务端计算 token 散列（明文只出现在签发响应里一次）。 */
export function contextTokenHash(token: string): string {
    return sha256Hex(token);
}
