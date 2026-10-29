/**
 * 控制会话管理器：显式会话、全局单写、租约与 Mod 侧控制权代次。
 *
 * 规则（接口草案 §4）：
 * - start 原子获取：已有人持有则 CONTROL_BUSY，不强占。
 * - 只读访问不续租；只有持有者自己的有效写活动续租。
 * - 租约到期 / 人工接管 / 世界改变 → 会话进入 stopping 再 closed，旧标识只能查历史收据。
 * - 任何情况下都不把过期标识自动恢复为 active。
 */
import { randomUUID } from 'node:crypto';
import {
    BridgeError,
    LEASE_TTL_MS,
    actorSessionKey,
    isActorContext,
    type Checkpoint,
    type ControlSessionInfo,
    type ControlStatus,
    type ModControlResult,
    type ModHello,
    type PauseReport,
    type SessionMode,
    type SessionState
} from '@sab/contracts';
import type { ModClient } from '@sab/game-client';
import type { ActionLedger, LedgerLogger } from './ledger.js';

export interface ControlManagerOptions {
    mod: ModClient;
    ledger?: ActionLedger | null;
    leaseTtlMs?: number;
    logger?: LedgerLogger;
    now?: () => number;
    emit?: (kind: string, payload: Record<string, unknown>) => void;
}

export interface StartOptions {
    clientId: string;
    clientName: string;
    mode?: SessionMode;
    label?: string | null;
}

interface MutableSession extends ControlSessionInfo {
    renewAt: number;
}

const SWEEP_INTERVAL_MS = 5_000;

export class ControlManager {
    private readonly mod: ModClient;
    private readonly ledger: ActionLedger | null;
    private readonly leaseTtlMs: number;
    private readonly logger?: LedgerLogger;
    private readonly now: () => number;
    private readonly emit: (kind: string, payload: Record<string, unknown>) => void;
    private readonly sessions = new Map<string, MutableSession>();
    private activeId: string | null = null;
    private acquiring = false;
    private takingOver = false;
    private sweeper: NodeJS.Timeout | null = null;
    private pause: PauseReport = { requested: false, state: 'unknown', reason: null, menuType: null };

    constructor(options: ControlManagerOptions) {
        this.mod = options.mod;
        this.ledger = options.ledger ?? null;
        this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
        this.logger = options.logger;
        this.now = options.now ?? (() => Date.now());
        this.emit = options.emit ?? (() => undefined);
        this.sweeper = setInterval(() => {
            void this.sweep();
        }, SWEEP_INTERVAL_MS);
        this.sweeper.unref?.();
    }

    /** 由动作服务在观察到新世界时调用。 */
    bindWorld(instanceId: string | null, worldGeneration: number | null): void {
        if (!this.activeId) return;
        const session = this.sessions.get(this.activeId);
        if (!session) return;
        if (session.worldGeneration === null && worldGeneration !== null) session.worldGeneration = worldGeneration;
        const instanceChanged = instanceId !== null && session.gameInstanceId !== null && instanceId !== session.gameInstanceId;
        const worldChanged = worldGeneration !== null && session.worldGeneration !== null && worldGeneration !== session.worldGeneration;
        if (!instanceChanged && !worldChanged) return;
        this.logger?.('warn', '检测到游戏实例或世界改变，关闭旧控制会话', { instanceId, worldGeneration });
        void this.closeSession(session, 'world_changed');
    }

    get activeSession(): ControlSessionInfo | null {
        if (!this.activeId) return null;
        return this.sessions.get(this.activeId) ?? null;
    }

    /** 取得控制权。两个客户端并发 start 时只有一个成功。 */
    async start(options: StartOptions): Promise<ControlSessionInfo> {
        if (this.activeId || this.acquiring || this.takingOver) {
            const holder = this.activeId ? this.sessions.get(this.activeId) : undefined;
            throw new BridgeError(
                'CONTROL_BUSY',
                `控制权已被 ${holder?.clientName ?? '其他客户端'} 持有（会话 ${this.activeId}）。请等待其 end 或由用户在网页人工接管。`
            );
        }
        if (!this.mod.connected) {
            throw new BridgeError('GAME_UNAVAILABLE', '游戏 Mod 未连接，无法取得控制权。');
        }
        this.acquiring = true;
        try { return await this.acquire(options); }
        finally { this.acquiring = false; }
    }

    private async acquire(options: StartOptions): Promise<ControlSessionInfo> {
        const multiplayer = this.mod.hello?.singlePlayer === false;
        if (multiplayer && options.mode !== 'realtime') throw new BridgeError('REALTIME_REQUIRED', '联机世界不会随本地菜单暂停；请显式使用 mode=realtime。');
        const mode: SessionMode = options.mode ?? 'step';
        const leaseExpiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
        // 先由 Mod 确认新代次；只有拿到 epoch 才认为控制权交接完成。
        const result = await this.mod.request(
            'control',
            { operation: 'acquire', holder: options.label ?? options.clientName, leaseExpiresAt, mode },
            { isWrite: true, timeoutMs: 10_000 }
        );
        if (result.status !== 'succeeded') {
            throw new BridgeError(
                result.error?.code ?? 'INTERNAL_ERROR',
                result.error?.message ?? 'Mod 未确认控制权交接。'
            );
        }
        const control = result.result as ModControlResult;
        if (!control || typeof control.epoch !== 'number') {
            throw new BridgeError('PROTOCOL_MISMATCH', 'Mod 控制权回执缺少 epoch。');
        }
        const session: MutableSession = {
            controlSessionId: `ctrl_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            clientId: options.clientId,
            clientName: options.clientName,
            state: 'active',
            mode,
            leaseEpoch: control.epoch,
            gameInstanceId: this.mod.hello?.instanceId ?? null,
            worldGeneration: this.mod.hello?.worldGeneration ?? null,
            startedAt: new Date(this.now()).toISOString(),
            lastActivityAt: new Date(this.now()).toISOString(),
            expiresAt: leaseExpiresAt,
            closedAt: null,
            closeReason: null,
            checkpoint: null,
            actorContext: multiplayer && isActorContext(result.actorContext) ? { ...result.actorContext } : undefined,
            renewAt: this.now() + 60_000
        };
        if (multiplayer && !session.actorContext) throw new BridgeError('PROTOCOL_MISMATCH', '联机控制回执缺少有效角色上下文。');
        this.sessions.set(session.controlSessionId, session);
        this.activeId = session.controlSessionId;
        this.updatePauseFrom(control.pause);
        this.persist(session);
        this.emit('control_started', {
            controlSessionId: session.controlSessionId,
            clientId: session.clientId,
            clientName: session.clientName,
            mode: session.mode,
            epoch: session.leaseEpoch
        });
        this.logger?.('info', `控制会话已建立 ${session.controlSessionId} epoch=${session.leaseEpoch} client=${session.clientName}`);
        return this.snapshot(session);
    }

    /** 续租：只有持有者的有效活动才调用。 */
    async noteActivity(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || session.state !== 'active') return;
        session.lastActivityAt = new Date(this.now()).toISOString();
        session.expiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
        if (this.mod.connected) {
            session.renewAt = this.now() + 60_000;
            try {
                const response = await this.mod.request(
                    'control',
                    { operation: 'renew', epoch: session.leaseEpoch, leaseExpiresAt: session.expiresAt },
                    { isWrite: false, timeoutMs: 5_000 }
                );
                if (response.status !== 'succeeded') await this.closeSession(session, 'renew_rejected', { revokeMod: false });
            } catch {
                this.logger?.('debug', '续租通知 Mod 失败，将在下次活动重试');
            }
        }
        this.persist(session);
    }

    /** 解析写动作的控制会话：显式指定优先；否则要求该客户端恰好一个活动会话。 */
    requireWriter(clientId: string, requestedSessionId?: string | null): ControlSessionInfo {
        if (requestedSessionId) {
            const session = this.sessions.get(requestedSessionId);
            if (!session) throw new BridgeError('CONTROL_EXPIRED', '控制会话不存在或已结束，请重新 start。');
            if (session.clientId !== clientId) {
                throw new BridgeError('CONTROL_REQUIRED', '该控制会话属于其他客户端，不能借用。');
            }
            if (session.state !== 'active') {
                throw new BridgeError('CONTROL_EXPIRED', `控制会话已 ${session.state}（${session.closeReason ?? '结束'}），请重新 start。`);
            }
            if (session.expiresAt && Date.parse(session.expiresAt) <= this.now()) {
                void this.closeSession(session, 'lease_expired');
                throw new BridgeError('CONTROL_EXPIRED', '控制租约已到期，请重新 start。');
            }
            return this.snapshot(session);
        }
        const owned = [...this.sessions.values()].filter((session) => session.clientId === clientId && session.state === 'active');
        if (owned.length === 0) {
            throw new BridgeError('CONTROL_REQUIRED', '写动作需要活动控制会话：请先调用 stardew_session(operation=start)。');
        }
        if (owned.length > 1) {
            throw new BridgeError('CONTROL_REQUIRED', '该客户端有多个活动控制会话，请在调用中显式指定 controlSessionId。');
        }
        return this.requireWriter(clientId, owned[0]!.controlSessionId);
    }

    async end(clientId: string, requestedSessionId?: string | null, reason = 'client_end'): Promise<ControlSessionInfo> {
        const session = requestedSessionId
            ? this.sessions.get(requestedSessionId) ?? null
            : [...this.sessions.values()].find((entry) => entry.clientId === clientId && entry.state === 'active') ?? null;
        if (!session) throw new BridgeError('CONTROL_EXPIRED', '没有可结束的活动控制会话。');
        if (session.clientId !== clientId) throw new BridgeError('CONTROL_REQUIRED', '只能结束自己的控制会话。');
        await this.closeSession(session, reason);
        return this.snapshot(session);
    }

    /** 人工接管（网页/CLI）：撤销旧代次、停止输入、记录真实暂停结果。 */
    async takeover(reason = 'manual_takeover'): Promise<{ closedSessionIds: string[]; pause: PauseReport; epoch: number }> {
        if (this.takingOver) throw new BridgeError('CONTROL_BUSY', '已有人工接管正在执行。');
        this.takingOver = true;
        try { return await this.performTakeover(reason); }
        finally { this.takingOver = false; }
    }

    private async performTakeover(reason: string): Promise<{ closedSessionIds: string[]; pause: PauseReport; epoch: number }> {
        while (this.acquiring) await new Promise(resolve => setTimeout(resolve, 5));
        if (!this.mod.connected) throw new BridgeError('GAME_UNAVAILABLE', '游戏 Mod 未连接，无法接管。');
        const result = await this.mod.request('control', { operation: 'takeover' }, { isWrite: true, timeoutMs: 10_000 });
        if (result.status !== 'succeeded') {
            throw new BridgeError(result.error?.code ?? 'INTERNAL_ERROR', result.error?.message ?? 'Mod 未确认接管。');
        }
        const control = result.result as ModControlResult;
        this.updatePauseFrom(control.pause);
        const closed: string[] = [];
        for (const session of [...this.sessions.values()]) {
            if (session.state === 'active' || session.state === 'stopping') {
                await this.closeSession(session, reason, { revokeMod: false });
                closed.push(session.controlSessionId);
            }
        }
        this.emit('control_takeover', { closedSessionIds: closed, reason, epoch: control.epoch, pause: control.pause });
        this.logger?.('info', `人工接管完成，关闭会话 ${closed.length} 个`);
        return { closedSessionIds: closed, pause: this.pause, epoch: control.epoch };
    }

    private async closeSession(session: MutableSession, reason: string, options: { revokeMod?: boolean } = {}): Promise<void> {
        if (session.state === 'closed') return;
        session.state = 'stopping';
        this.persist(session);
        if (options.revokeMod !== false && this.mod.connected) {
            try {
                const response = await this.mod.request(
                    'control',
                    { operation: 'release', epoch: session.leaseEpoch, pause: session.mode === 'step' },
                    { isWrite: true, timeoutMs: 10_000 }
                );
                if (response.status === 'succeeded') this.updatePauseFrom((response.result as ModControlResult).pause);
            } catch (error) {
                this.logger?.('warn', `释放控制权时 Mod 未确认：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        session.state = 'closed';
        session.closedAt = new Date(this.now()).toISOString();
        session.closeReason = reason;
        if (this.activeId === session.controlSessionId) this.activeId = null;
        this.persist(session);
        this.emit('control_closed', {
            controlSessionId: session.controlSessionId,
            clientId: session.clientId,
            reason,
            pause: this.pause
        });
        this.logger?.('info', `控制会话关闭 ${session.controlSessionId} reason=${reason}`);
    }

    /** 保存 Agent 显式提交的进度笔记；只验证引用存在，不把自由文本当成客观事实。 */
    checkpoint(
        clientId: string,
        sessionId: string | null,
        input: { goal?: string; progress?: string; next?: string; constraints?: string }
    ): ControlSessionInfo {
        const session = sessionId
            ? this.sessions.get(sessionId) ?? null
            : this.activeId
              ? this.sessions.get(this.activeId) ?? null
              : null;
        if (!session) throw new BridgeError('CONTROL_EXPIRED', '没有可写入 checkpoint 的控制会话。');
        if (session.clientId !== clientId) throw new BridgeError('CONTROL_REQUIRED', '只能修改自己的控制会话。');
        const checkpoint: Checkpoint = {
            goal: input.goal ?? session.checkpoint?.goal ?? null,
            progress: input.progress ?? session.checkpoint?.progress ?? null,
            next: input.next ?? session.checkpoint?.next ?? null,
            constraints: input.constraints ?? session.checkpoint?.constraints ?? null,
            receiptIds: session.checkpoint?.receiptIds ?? [],
            updatedAt: new Date(this.now()).toISOString()
        };
        session.checkpoint = checkpoint;
        this.persist(session);
        return this.snapshot(session);
    }

    /** 记录本次会话相关的收据 ID，便于恢复。 */
    attachReceipt(sessionId: string | null, receiptId: string): void {
        if (!sessionId) return;
        const session = this.sessions.get(sessionId);
        if (!session?.checkpoint) return;
        session.checkpoint.receiptIds = [...new Set([...session.checkpoint.receiptIds, receiptId])].slice(-50);
        this.persist(session);
    }

    updatePauseFrom(pause: { state?: string; menuType?: string | null; selfOpened?: boolean } | undefined): void {
        if (!pause) return;
        const state = pause.state;
        this.pause = {
            requested: true,
            state: state === 'paused' || state === 'running' || state === 'blocked' ? state : 'unknown',
            reason: pause.selfOpened ? 'self_pause_menu' : pause.menuType ? 'user_menu' : null,
            menuType: pause.menuType ?? null
        };
    }

    setPause(pause: PauseReport): void {
        this.pause = pause;
    }

    fromHello(hello: ModHello | null): void {
        if (!hello) return;
        this.updatePauseFrom(hello.pause);
        this.bindWorld(hello.instanceId, hello.worldGeneration ?? null);
        const holder = this.activeId ? this.sessions.get(this.activeId) : undefined;
        if (holder?.state === 'active' && holder.actorContext && (!hello.multiplayer?.permissionLeaseHeld
            || actorSessionKey(holder.actorContext) !== actorSessionKey(hello.multiplayer?.actorContext))) {
            void this.closeSession(holder, 'multiplayer_context_changed', { revokeMod: false });
            return;
        }
        if (holder?.state === 'active' && hello.epoch > holder.leaseEpoch) {
            void this.closeSession(holder, 'mod_control_changed', { revokeMod: false });
        }
    }

    status(activeActionId: string | null, activeCommand: string | null, unresolved: string[]): ControlStatus {
        const holder = this.activeSession;
        return {
            holder: holder
                ? {
                      clientId: holder.clientId,
                      clientName: holder.clientName,
                      controlSessionId: holder.controlSessionId,
                      leaseEpoch: holder.leaseEpoch,
                      expiresAt: holder.expiresAt ?? new Date(this.now() + this.leaseTtlMs).toISOString(),
                      mode: holder.mode
                  }
                : null,
            activeActionId,
            activeCommand,
            unresolvedActionIds: unresolved,
            mode: holder?.mode ?? null,
            pause: this.pause
        };
    }

    list(): ControlSessionInfo[] {
        return [...this.sessions.values()].map((session) => this.snapshot(session));
    }

    async sweep(): Promise<void> {
        for (const session of [...this.sessions.values()]) {
            if (session.state !== 'active') continue;
            if (session.expiresAt && Date.parse(session.expiresAt) <= this.now()) {
                this.logger?.('info', `控制租约到期 ${session.controlSessionId}`);
                await this.closeSession(session, 'lease_expired');
            }
        }
    }

    private snapshot(session: MutableSession): ControlSessionInfo {
        return {
            controlSessionId: session.controlSessionId,
            clientId: session.clientId,
            clientName: session.clientName,
            state: session.state as SessionState,
            mode: session.mode,
            leaseEpoch: session.leaseEpoch,
            gameInstanceId: session.gameInstanceId,
            worldGeneration: session.worldGeneration,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            expiresAt: session.expiresAt,
            closedAt: session.closedAt,
            closeReason: session.closeReason,
            checkpoint: session.checkpoint,
            actorContext: session.actorContext ? { ...session.actorContext } : undefined
        };
    }

    private persist(session: ControlSessionInfo): void {
        this.ledger?.saveSession({ ...session });
    }

    stop(): void {
        if (this.sweeper) clearInterval(this.sweeper);
        this.sweeper = null;
    }
}
