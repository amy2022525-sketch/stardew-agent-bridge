/**
 * 任务查询（§17.2 get/list/wait）：只读，不延长控制租约，不因客户端断开取消后台任务。
 * wait 是长轮询而非订阅：每次只等一个 stateVersion 变化，超时返回当前快照。
 */
import { BridgeError, isTaskState, type TaskState, type TaskView } from '@sab/contracts';
import type { DecisionStore, TaskListPage } from './store.js';
import type { TaskService, Principal } from './task-service.js';
import type { Clock } from './clock.js';

export interface TaskQueryOptions {
    store: DecisionStore;
    service: TaskService;
    clock: Clock;
    /** Web 管理员：可读全部任务；MCP 客户端默认只读自己的。 */
    isAdmin: (principal: Principal) => boolean;
    /** Web 明确打开“跨客户端共享只读”后才允许读他人任务。 */
    sharingEnabled: () => boolean;
    /** 当前活动 profile：共享读只在同一 profile 内生效。 */
    activeProfileId?: () => string;
    /** 每个客户端最多同时 2 个 wait；超出明确拒绝。 */
    maxWaitsPerClient?: number;
}

interface WaitSlot {
    count: number;
}

const WAIT_POLL_MS = 200;
const WAIT_TIMEOUT_MAX_MS = 15_000;

export class TaskQueryService {
    private readonly waits = new Map<string, WaitSlot>();

    constructor(private readonly deps: TaskQueryOptions) {}

    get(principal: Principal, taskId: string): TaskView {
        this.deps.service.assertExternal(principal);
        const task = this.deps.store.loadTask(taskId);
        if (!task) throw new BridgeError('NOT_FOUND', '任务不存在或无权读取。');
        if (task.ownerClientId !== principal.clientId && !this.canReadOthers(principal)) {
            throw new BridgeError('NOT_FOUND', '任务不存在或无权读取。');
        }
        return this.deps.service.toView(task);
    }

    list(principal: Principal, options: { cursor?: string | null; limit?: number; state?: TaskState | null }): { tasks: TaskView[]; nextCursor: string | null } {
        this.deps.service.assertExternal(principal);
        if (options.state !== undefined && options.state !== null && !isTaskState(options.state)) {
            throw new BridgeError('INVALID_ARGUMENT', 'state 非法。');
        }
        const limit = Math.max(1, Math.min(50, options.limit ?? 20));
        const states = options.state ? [options.state] : undefined;
        let page: TaskListPage;
        if (this.canReadOthers(principal)) {
            page = this.deps.store.listAllTasks({ states, limit, cursor: options.cursor ?? null });
            if (!this.deps.isAdmin(principal)) {
                // 非管理员只看到与当前 profile 相同的共享任务；分页按过滤后结果返回。
                const profileId = this.currentProfileId();
                page = {
                    ...page,
                    tasks: page.tasks.filter((task) => task.scope.profileId === profileId || task.ownerClientId === principal.clientId)
                };
            }
        } else {
            page = this.deps.store.listTasks(principal.clientId, { states, limit, cursor: options.cursor ?? null });
        }
        return { tasks: page.tasks.map((task) => this.deps.service.toView(task)), nextCursor: page.nextCursor };
    }

    /**
     * 等待任务变化。signal 只取消这次等待，不取消任务（§17.4）。
     * HTTP 断开由调用方 abort，同样只结束等待。
     */
    async wait(
        principal: Principal,
        input: { taskId: string; afterStateVersion: number; timeoutMs?: number; signal?: AbortSignal }
    ): Promise<{ changed: boolean; waitedMs: number; task: TaskView }> {
        this.deps.service.assertExternal(principal);
        const task = this.deps.store.loadTask(input.taskId);
        if (!task) throw new BridgeError('NOT_FOUND', '任务不存在或无权读取。');
        if (task.ownerClientId !== principal.clientId && !this.canReadOthers(principal)) {
            throw new BridgeError('NOT_FOUND', '任务不存在或无权读取。');
        }
        if (!Number.isInteger(input.afterStateVersion) || input.afterStateVersion < 0) {
            throw new BridgeError('INVALID_ARGUMENT', 'afterStateVersion 必须是非负整数。');
        }
        const timeoutMs = Math.max(0, Math.min(WAIT_TIMEOUT_MAX_MS, input.timeoutMs ?? 5000));
        this.acquireWaitSlot(principal.clientId);
        const startedAt = this.deps.clock.nowMs();
        try {
            for (;;) {
                const current = this.deps.store.loadTask(input.taskId);
                if (!current) throw new BridgeError('NOT_FOUND', '任务已不存在。');
                if (current.stateVersion > input.afterStateVersion) {
                    return { changed: true, waitedMs: this.deps.clock.nowMs() - startedAt, task: this.deps.service.toView(current) };
                }
                const elapsed = this.deps.clock.nowMs() - startedAt;
                if (elapsed >= timeoutMs) {
                    return { changed: false, waitedMs: elapsed, task: this.deps.service.toView(current) };
                }
                if (input.signal?.aborted) throw new BridgeError('CANCELLED', '等待已取消；后台任务不受影响。');
                await sleep(Math.min(WAIT_POLL_MS, timeoutMs - elapsed), input.signal);
            }
        } finally {
            this.releaseWaitSlot(principal.clientId);
        }
    }

    private canReadOthers(principal: Principal): boolean {
        return this.deps.isAdmin(principal) || this.deps.sharingEnabled();
    }

    private currentProfileId(): string {
        // 共享读只按当前活动 profile 生效；profile 由 config 提供，这里用保守默认。
        return this.deps.activeProfileId?.() ?? 'default';
    }

    private acquireWaitSlot(clientId: string): void {
        const max = this.deps.maxWaitsPerClient ?? 2;
        const slot = this.waits.get(clientId) ?? { count: 0 };
        if (slot.count >= max) throw new BridgeError('EXECUTOR_BUSY', `同一客户端最多 ${String(max)} 个并发 wait，请先结束已有等待。`);
        slot.count += 1;
        this.waits.set(clientId, slot);
    }

    private releaseWaitSlot(clientId: string): void {
        const slot = this.waits.get(clientId);
        if (!slot) return;
        slot.count = Math.max(0, slot.count - 1);
        if (slot.count === 0) this.waits.delete(clientId);
    }
}

/** 可被 abort 打断的等待；不吞掉 abort 原因之外的错误。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new BridgeError('CANCELLED', '等待已取消；后台任务不受影响。'));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
