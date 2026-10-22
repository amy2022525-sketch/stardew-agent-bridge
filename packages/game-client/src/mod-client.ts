/**
 * Mod 连接客户端：本地 WebSocket、配对凭据、协议握手、心跳与在途请求路由。
 *
 * 设计要点：
 * - 只有一条到 Mod 的连接；Bridge 是唯一写者，多个 Agent 共享这条连接。
 * - 心跳使用 `hello`（只读），失败或超时立刻判定链路断开；游戏侧另有独立 watchdog。
 * - 连接断开时所有在途写请求以 RESULT_UNKNOWN 结束：不猜测成功，也不自动重发。
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
    BridgeError,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    MOD_PROTOCOL,
    normalizeModCode,
    type ModEvent,
    type ModHello,
    type ModRequest,
    type ModResponse
} from '@sab/contracts';

export interface ModClientOptions {
    host?: string;
    port?: number;
    token: string;
    clientName?: string;
    requestTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    autoReconnect?: boolean;
    reconnectDelayMs?: number;
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

interface PendingRequest {
    resolve: (response: ModResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    command: string;
    isWrite: boolean;
}

export type ModLinkState = 'disconnected' | 'connecting' | 'handshaking' | 'ready';

export interface ModRequestOptions {
    actionId?: string;
    epoch?: number;
    timeoutMs?: number;
    /** 是否属于改变游戏状态的命令（决定断线时的错误语义）。 */
    isWrite?: boolean;
}

const WRITE_COMMANDS = new Set([
    'move', 'select', 'use', 'interact', 'menu', 'buy', 'pause', 'closemenu', 'wait',
    'ship', 'container', 'craft', 'place', 'eat', 'equip', 'fish', 'combat', 'load'
]);

export class ModClient extends EventEmitter {
    private readonly options: Required<Omit<ModClientOptions, 'logger'>> & { logger?: ModClientOptions['logger'] };
    private socket: WebSocket | null = null;
    private state: ModLinkState = 'disconnected';
    private pending = new Map<string, PendingRequest>();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private watchdogTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private sequence = 0;
    private stopping = false;
    private consecutiveFailures = 0;

    hello: ModHello | null = null;
    lastFrameAt: number | null = null;
    lastHeartbeatAt: number | null = null;
    lastError: string | null = null;
    reconnectAttempts = 0;

    constructor(options: ModClientOptions) {
        super();
        this.options = {
            host: options.host ?? '127.0.0.1',
            port: options.port ?? 17654,
            token: options.token,
            clientName: options.clientName ?? 'bridge',
            requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
            heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
            heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
            autoReconnect: options.autoReconnect ?? true,
            reconnectDelayMs: options.reconnectDelayMs ?? 2_000,
            logger: options.logger
        };
    }

    get linkState(): ModLinkState {
        return this.state;
    }

    get connected(): boolean {
        return this.state === 'ready';
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
        this.options.logger?.(level, message, meta);
    }

    connect(): void {
        if (this.state === 'connecting' || this.state === 'handshaking' || this.state === 'ready') return;
        this.stopping = false;
        this.state = 'connecting';
        const url = `ws://${this.options.host}:${this.options.port}/`;
        const socket = new WebSocket(url, {
            headers: {
                authorization: `Bearer ${this.options.token}`,
                'x-sab-client': this.options.clientName,
                'x-sab-protocol': MOD_PROTOCOL
            },
            handshakeTimeout: 5_000,
            perMessageDeflate: false
        });
        this.socket = socket;

        socket.on('open', () => {
            this.state = 'handshaking';
            this.lastFrameAt = Date.now();
            this.log('info', 'Mod WebSocket 已连接，开始握手');
            void this.handshake();
        });

        socket.on('message', (data) => {
            this.lastFrameAt = Date.now();
            this.onFrame(data.toString());
        });

        socket.on('error', (error) => {
            this.lastError = error.message;
            this.log('warn', `Mod WebSocket 错误：${error.message}`);
        });

        socket.on('close', (code) => {
            this.onClosed(`socket_closed:${code}`);
        });
    }

    private async handshake(): Promise<void> {
        try {
            const response = await this.request('hello', {}, { timeoutMs: 5_000 });
            if (response.status !== 'succeeded') {
                throw new BridgeError(
                    normalizeModCode(response.error?.code),
                    response.error?.message ?? 'Mod 握手失败'
                );
            }
            const hello = response.result as ModHello;
            if (!hello || hello.kind !== 'hello') throw new BridgeError('PROTOCOL_MISMATCH', 'Mod 握手返回结构不符合协议');
            this.hello = hello;
            this.state = 'ready';
            this.reconnectAttempts = 0;
            this.consecutiveFailures = 0;
            this.lastError = null;
            this.startHeartbeat();
            this.log('info', `Mod 握手成功 mod=${hello.modVersion} game=${hello.gameVersion} smapi=${hello.smapiVersion} proto=${hello.protocol}`);
            this.emit('ready', hello);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            this.log('error', `Mod 握手失败：${message}`);
            this.emit('handshake_failed', error);
            this.socket?.terminate();
        }
    }

    private startHeartbeat(): void {
        this.stopTimers();
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeat();
        }, this.options.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();

        this.watchdogTimer = setInterval(() => {
            const last = this.lastFrameAt ?? 0;
            if (Date.now() - last > this.options.heartbeatTimeoutMs) {
                this.log('warn', `Mod 心跳超时（${Date.now() - last}ms 未收到帧），断开连接`);
                this.socket?.terminate();
                this.onClosed('heartbeat_timeout');
            }
        }, Math.max(250, Math.floor(this.options.heartbeatTimeoutMs / 2)));
        this.watchdogTimer.unref?.();
    }

    private stopTimers(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.heartbeatTimer = null;
        this.watchdogTimer = null;
    }

    private async sendHeartbeat(): Promise<void> {
        if (this.state !== 'ready') return;
        try {
            const response = await this.request('hello', {}, { timeoutMs: Math.max(1_000, this.options.heartbeatTimeoutMs) });
            if (response.status === 'succeeded') {
                this.hello = response.result as ModHello;
                this.lastHeartbeatAt = Date.now();
                this.consecutiveFailures = 0;
                this.emit('heartbeat', this.hello);
            } else {
                this.consecutiveFailures += 1;
            }
        } catch {
            this.consecutiveFailures += 1;
        }
        if (this.consecutiveFailures >= 3) {
            this.log('warn', 'Mod 心跳连续失败，主动断开等待重连');
            this.socket?.terminate();
            this.onClosed('heartbeat_failures');
        }
    }

    private onFrame(text: string): void {
        let frame: unknown;
        try {
            frame = JSON.parse(text);
        } catch {
            this.log('warn', '收到无法解析的 Mod 帧，已忽略');
            return;
        }
        const record = frame as Record<string, unknown>;
        const op = record.op;
        if (op === 'event') {
            this.emit('event', frame as ModEvent);
            return;
        }
        if (op !== undefined && op !== 'response') {
            this.log('warn', `收到未知 op=${String(op)} 的 Mod 帧`);
            return;
        }
        const response = frame as ModResponse;
        const requestId = typeof response.requestId === 'string' ? response.requestId : '';
        const pending = this.pending.get(requestId);
        if (!pending) {
            // 迟到的响应（可能来自超时请求）：只记录，不重放。
            this.log('debug', `忽略迟到响应 ${requestId}`);
            return;
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(response);
    }

    private onClosed(reason: string): void {
        const wasReady = this.state === 'ready';
        this.stopTimers();
        this.state = 'disconnected';
        this.hello = null;
        const socket = this.socket;
        this.socket = null;
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();

        for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            if (pending.isWrite) {
                pending.reject(
                    new BridgeError(
                        'RESULT_UNKNOWN',
                        `与游戏的连接在动作 ${pending.command} 执行期间断开（${reason}），结果不明：请 stop、查询原收据并重新观察。`,
                        { effectKnown: false, nextAction: 'query_action' }
                    )
                );
            } else {
                pending.reject(new BridgeError('GAME_UNAVAILABLE', `与游戏的连接已断开（${reason}）。`));
            }
            this.pending.delete(requestId);
        }

        if (wasReady) this.emit('disconnected', reason);
        if (!this.stopping && this.options.autoReconnect) this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectAttempts += 1;
        const delay = Math.min(this.options.reconnectDelayMs * Math.min(this.reconnectAttempts, 10), 15_000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    /** 发送一条命令；传输失败以 BridgeError 抛出，业务失败通过 ModResponse.error 返回。 */
    request(command: string, args: Record<string, unknown>, options: ModRequestOptions = {}): Promise<ModResponse> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new BridgeError('GAME_UNAVAILABLE', '游戏 Mod 未连接。'));
        }
        if (this.pending.size >= 32) {
            return Promise.reject(new BridgeError('ACTION_BUSY', 'Mod 在途请求过多，请稍后重试。'));
        }
        const requestId = `r${++this.sequence}-${Date.now().toString(36)}`;
        const isWrite = options.isWrite ?? WRITE_COMMANDS.has(command);
        const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
        const request: ModRequest = {
            op: 'request',
            protocol: MOD_PROTOCOL,
            requestId,
            command,
            args,
            timeoutMs
        };
        if (options.actionId) request.actionId = options.actionId;
        if (typeof options.epoch === 'number') request.epoch = options.epoch;

        return new Promise<ModResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(
                    isWrite
                        ? new BridgeError('RESULT_UNKNOWN', `动作 ${command} 在 ${timeoutMs}ms 内没有回执，结果不明。`, {
                              effectKnown: false,
                              nextAction: 'query_action'
                          })
                        : new BridgeError('TIMEOUT', `请求 ${command} 超时。`)
                );
            }, timeoutMs + 1_000);
            timer.unref?.();
            this.pending.set(requestId, { resolve, reject, timer, command, isWrite });
            try {
                this.socket?.send(JSON.stringify(request));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new BridgeError('GAME_UNAVAILABLE', `发送请求失败：${error instanceof Error ? error.message : String(error)}`));
            }
        });
    }

    /** 优雅关闭：不再重连。 */
    async close(): Promise<void> {
        this.stopping = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopTimers();
        const socket = this.socket;
        this.socket = null;
        this.state = 'disconnected';
        if (!socket) return;
        await new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.close();
            setTimeout(() => {
                socket.terminate();
                resolve();
            }, 500).unref?.();
        });
    }
}
