/**
 * 事件流：单调递增序号 + 环形缓冲 + 订阅者。
 * Web 断流重连时若发现序号缺口，必须重新取全量状态，不能用增量冒充完成状态。
 */
import type { ActionLedger } from './ledger.js';

export interface BridgeEvent {
    seq: number;
    at: string;
    kind: string;
    payload: Record<string, unknown>;
}

export class EventLog {
    private next = 1;
    private readonly buffer: BridgeEvent[] = [];
    private readonly subscribers = new Set<(event: BridgeEvent) => void>();
    private readonly capacity: number;
    private readonly ledger: ActionLedger | null;
    private readonly now: () => number;

    constructor(options: { capacity?: number; ledger?: ActionLedger | null; now?: () => number } = {}) {
        this.capacity = options.capacity ?? 1_000;
        this.ledger = options.ledger ?? null;
        this.now = options.now ?? (() => Date.now());
    }

    get lastSeq(): number {
        return this.next - 1;
    }

    publish(kind: string, payload: Record<string, unknown> = {}): BridgeEvent {
        const event: BridgeEvent = {
            seq: this.next++,
            at: new Date(this.now()).toISOString(),
            kind,
            payload
        };
        this.buffer.push(event);
        while (this.buffer.length > this.capacity) this.buffer.shift();
        this.ledger?.appendEvent({
            at: event.at,
            kind,
            clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
            controlSessionId: typeof payload.controlSessionId === 'string' ? payload.controlSessionId : null,
            actionId: typeof payload.actionId === 'string' ? payload.actionId : null,
            payload
        });
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                /* 单个订阅者失败不影响其他订阅者 */
            }
        }
        return event;
    }

    since(seq: number): BridgeEvent[] {
        return this.buffer.filter((event) => event.seq > seq);
    }

    recent(limit = 100): BridgeEvent[] {
        return this.buffer.slice(-limit);
    }

    subscribe(callback: (event: BridgeEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }
}
