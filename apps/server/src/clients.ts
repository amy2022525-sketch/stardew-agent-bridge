/**
 * 客户端在线表：只记录已认证客户端的最近活动，用于状态面板。
 * 不记录工具参数内容，也不把令牌写进这里。
 */
import type { ClientPresence } from '@sab/contracts';

interface Entry extends ClientPresence {
    toolCalls: number;
}

export class ClientRegistry {
    private readonly entries = new Map<string, Entry>();

    touch(clientId: string, clientName: string, transport: ClientPresence['transport']): void {
        const existing = this.entries.get(clientId);
        if (existing) {
            existing.clientName = clientName;
            existing.transport = transport;
            existing.lastSeenAt = new Date().toISOString();
            return;
        }
        this.entries.set(clientId, {
            clientId,
            clientName,
            transport,
            lastSeenAt: new Date().toISOString(),
            toolCalls: 0
        });
    }

    countCall(clientId: string): void {
        const entry = this.entries.get(clientId);
        if (entry) entry.toolCalls += 1;
    }

    list(): ClientPresence[] {
        return [...this.entries.values()]
            .map((entry) => ({ ...entry }))
            .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    }
}
