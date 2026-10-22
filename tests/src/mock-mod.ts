/**
 * 模拟 Mod：按 `stardew-agent-bridge/1` 协议应答，用于契约、控制权、幂等与故障注入测试。
 *
 * 明确边界：模拟通过**不能**当作真实游戏验收。它验证的是 Bridge 侧契约与状态机；
 * 游戏内行为必须另行实机验收（见 docs/EVIDENCE.md）。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { MOD_PROTOCOL } from '@sab/contracts';

export interface MockRequestRecord {
    command: string;
    args: Record<string, unknown>;
    actionId?: string;
    epoch?: number;
    receivedAt: number;
}

export interface MockBehaviorResult {
    status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';
    result?: unknown;
    error?: { code: string; message: string; effectKnown?: boolean; nextAction?: string };
    /** 延迟后再应答，用于超时/取消场景。 */
    delayMs?: number;
    /** 直接断开连接，用于崩溃窗口场景。 */
    dropConnection?: boolean;
}

export type MockHandler = (request: MockRequestRecord) => MockBehaviorResult | null;

export interface MockModOptions {
    token: string;
    port?: number;
    saveLoaded?: boolean;
    location?: string;
    capabilities?: string[];
}

interface PendingAction {
    actionId: string;
    command: string;
    timer: NodeJS.Timeout;
}

export class MockMod {
    private readonly options: Required<Omit<MockModOptions, 'port'>> & { port: number };
    private server: WebSocketServer | null = null;
    private sockets = new Set<WebSocket>();
    private handlers = new Map<string, MockHandler>();
    private pendingAction: PendingAction | null = null;
    readonly requests: MockRequestRecord[] = [];
    epoch = 1;
    holder: string | null = null;
    pauseState: 'paused' | 'running' | 'blocked' | 'unknown' = 'running';
    pausedBySelf = false;
    location: string;
    saveLoaded: boolean;
    instanceId = 'mock-instance-1';
    snapshotSeq = 0;
    accessDenied = 0;

    constructor(options: MockModOptions) {
        this.options = {
            token: options.token,
            port: options.port ?? 0,
            saveLoaded: options.saveLoaded ?? true,
            location: options.location ?? 'Farm',
            capabilities: options.capabilities ?? [
                'snapshot', 'move', 'select', 'use', 'interact', 'menu', 'screenshot', 'status',
                'stop', 'wait', 'pause', 'closemenu', 'shop', 'buy', 'inspect', 'ship', 'container',
                'recipes', 'craft', 'place', 'eat', 'equip', 'fish', 'combat', 'saves', 'load',
                'control'
            ]
        };
        this.location = this.options.location;
        this.saveLoaded = this.options.saveLoaded;
    }

    get port(): number {
        return this.options.port;
    }

    setBehavior(command: string, handler: MockHandler): void {
        this.handlers.set(command, handler);
    }

    clearBehavior(command: string): void {
        this.handlers.delete(command);
    }

    commandCount(command: string): number {
        return this.requests.filter((request) => request.command === command).length;
    }

    async start(): Promise<number> {
        await new Promise<void>((resolve) => {
            const server = new WebSocketServer({
                host: '127.0.0.1',
                port: this.options.port,
                verifyClient: (info, callback) => {
                    const header = info.req.headers.authorization;
                    if (header !== `Bearer ${this.options.token}`) {
                        this.accessDenied += 1;
                        callback(false, 401, 'unauthorized');
                        return;
                    }
                    callback(true);
                }
            });
            server.on('listening', () => resolve());
            server.on('connection', (socket) => this.onConnection(socket));
            this.server = server;
        });
        const address = this.server?.address();
        const port = typeof address === 'object' && address ? address.port : this.options.port;
        (this.options as { port: number }).port = port;
        return port;
    }

    async stop(): Promise<void> {
        for (const socket of this.sockets) socket.terminate();
        this.sockets.clear();
        await new Promise<void>((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close(() => resolve());
            this.server = null;
        });
    }

    /** 模拟“崩溃/断线”：直接掐断当前连接。 */
    dropConnections(): void {
        for (const socket of this.sockets) socket.terminate();
        this.sockets.clear();
    }

    private onConnection(socket: WebSocket): void {
        this.sockets.add(socket);
        socket.on('message', (data) => {
            void this.onMessage(socket, data.toString());
        });
        socket.on('close', () => this.sockets.delete(socket));
    }

    private async onMessage(socket: WebSocket, text: string): Promise<void> {
        let frame: Record<string, unknown>;
        try {
            frame = JSON.parse(text) as Record<string, unknown>;
        } catch {
            return;
        }
        if (frame['op'] !== 'request') return;
        if (frame['protocol'] !== MOD_PROTOCOL) {
            socket.send(
                JSON.stringify({
                    op: 'response',
                    requestId: frame['requestId'],
                    status: 'failed',
                    error: { code: 'INCOMPATIBLE_PROTOCOL', message: '协议名不匹配' }
                })
            );
            return;
        }
        const record: MockRequestRecord = {
            command: String(frame['command'] ?? ''),
            args: (frame['args'] ?? {}) as Record<string, unknown>,
            actionId: typeof frame['actionId'] === 'string' ? frame['actionId'] : undefined,
            epoch: typeof frame['epoch'] === 'number' ? frame['epoch'] : undefined,
            receivedAt: Date.now()
        };
        this.requests.push(record);

        const custom = this.handlers.get(record.command);
        if (custom) {
            const outcome = custom(record);
            if (outcome) {
                await this.reply(socket, frame, record, outcome);
                return;
            }
        }

        await this.reply(socket, frame, record, this.defaultBehavior(record));
    }

    private async reply(
        socket: WebSocket,
        frame: Record<string, unknown>,
        record: MockRequestRecord,
        outcome: MockBehaviorResult
    ): Promise<void> {
        if (outcome.dropConnection) {
            socket.terminate();
            return;
        }
        if (outcome.delayMs && outcome.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
        }
        if (socket.readyState !== socket.OPEN) return;
        socket.send(
            JSON.stringify({
                op: 'response',
                requestId: frame['requestId'],
                status: outcome.status,
                result: outcome.result ?? null,
                error: outcome.error ?? null,
                actionId: record.actionId ?? null,
                epoch: this.epoch,
                elapsedMs: 1
            })
        );
    }

    private defaultBehavior(record: MockRequestRecord): MockBehaviorResult {
        switch (record.command) {
            case 'hello':
                return { status: 'succeeded', result: this.hello() };
            case 'control':
                return { status: 'succeeded', result: this.handleControl(record) };
            case 'stop':
                return { status: 'succeeded', result: this.handleStop() };
            case 'snapshot':
                return { status: 'succeeded', result: this.snapshot() };
            case 'screenshot':
                return {
                    status: 'succeeded',
                    result: { mimeType: 'image/png', base64: Buffer.from('fake-png').toString('base64') }
                };
            case 'saves':
                return {
                    status: 'succeeded',
                    result: { kind: 'saves', saves: [{ saveId: 'TestFarm_392011', farmer: 'Tester', daysPlayed: 12 }] }
                };
            case 'shop':
                return {
                    status: 'succeeded',
                    result: { kind: 'shop', shopId: 'SeedShop', money: 500, items: [{ itemId: '(O)472', price: 40, stock: 5 }] }
                };
            case 'inspect':
                return { status: 'succeeded', result: { kind: 'inspect', target: record.args['target'], passable: true } };
            case 'recipes':
                return { status: 'succeeded', result: { kind: 'recipes', recipes: [] } };
            default:
                if (!this.saveLoaded) {
                    return { status: 'failed', error: { code: 'NO_SAVE_LOADED', message: '没有已加载存档。' } };
                }
                return { status: 'succeeded', result: this.actionResult(record) };
        }
    }

    private hello(): Record<string, unknown> {
        return {
            mode: 'game',
            kind: 'hello',
            protocol: MOD_PROTOCOL,
            instanceId: this.instanceId,
            modVersion: '0.1.0',
            gameVersion: '1.6.15',
            smapiVersion: '4.5.2',
            saveLoaded: this.saveLoaded,
            singlePlayer: true,
            capabilities: this.options.capabilities,
            writeCommands: ['move', 'select', 'use', 'interact', 'menu', 'buy', 'pause', 'closemenu', 'wait'],
            epoch: this.epoch,
            controller: this.holder,
            lease: { held: this.holder !== null, holderName: this.holder, expiresAt: null },
            pause: { state: this.pauseState, menuType: null, selfOpened: this.pausedBySelf },
            watchdog: { bridgeLinkUp: true, lastHeartbeatAt: new Date().toISOString() },
            window: { active: true, title: 'Stardew Valley' },
            features: { cropMaturity: true, shipping: true, mailbox: true, inventory: true, realtime: true }
        };
    }

    private handleControl(record: MockRequestRecord): Record<string, unknown> {
        const operation = String(record.args['operation'] ?? '');
        if (operation === 'acquire') {
            this.epoch += 1;
            this.holder = String(record.args['holder'] ?? 'bridge');
            this.pauseState = 'running';
            this.pausedBySelf = false;
        } else if (operation === 'release') {
            this.holder = null;
            if (record.args['pause'] === true) {
                this.pauseState = 'paused';
                this.pausedBySelf = true;
            }
        } else if (operation === 'takeover') {
            this.epoch += 1;
            this.holder = null;
            this.clearPendingAction();
            this.pauseState = 'paused';
            this.pausedBySelf = false;
        }
        return {
            kind: 'control',
            epoch: this.epoch,
            holderName: this.holder,
            expiresAt: null,
            pause: { state: this.pauseState, menuType: null, selfOpened: this.pausedBySelf }
        };
    }

    private handleStop(): Record<string, unknown> {
        const pending = this.pendingAction;
        this.clearPendingAction();
        this.pauseState = 'paused';
        this.pausedBySelf = true;
        return {
            kind: 'status',
            activeActionId: pending?.actionId ?? null,
            command: pending?.command ?? null,
            releasedInputs: ['move', 'tool'],
            pause: { state: this.pauseState, menuType: null, selfOpened: true }
        };
    }

    private clearPendingAction(): void {
        if (this.pendingAction) clearTimeout(this.pendingAction.timer);
        this.pendingAction = null;
    }

    private actionResult(record: MockRequestRecord): Record<string, unknown> {
        this.pauseState = 'paused';
        this.pausedBySelf = true;
        return {
            kind: 'action',
            location: this.location,
            position: { x: 10, y: 12 },
            changed: true,
            detail: `${record.command} 已完成（模拟）`,
            effects:
                record.command === 'buy'
                    ? { itemId: record.args['itemId'], requestedCount: record.args['count'], actualCount: record.args['count'], goldBefore: 500, goldAfter: 460 }
                    : { changed: true },
            pause: { state: 'paused', menuType: 'GameMenu', selfOpened: true },
            snapshot: this.snapshot()
        };
    }

    private snapshot(): Record<string, unknown> {
        this.snapshotSeq += 1;
        return {
            snapshotId: `s${this.snapshotSeq}`,
            instanceId: this.instanceId,
            saveGeneration: 3,
            location: this.location,
            date: { season: 'spring', day: 5, year: 1 },
            time: 620,
            player: {
                name: 'Tester',
                money: 500,
                health: 100,
                maxHealth: 100,
                energy: 240,
                maxEnergy: 270,
                position: { x: 10, y: 12 },
                selectedSlot: 0,
                maxItems: 36
            },
            inventory: [
                { slot: 0, itemId: '(T)Hoe', name: '锄头', count: 1, tool: 'Hoe' },
                { slot: 1, itemId: '(O)472', name: '防风草种子', count: 15 },
                { slot: 2, itemId: '(O)24', name: '防风草', count: 3, quality: 1 }
            ],
            entities: [
                { ref: '@s1:e1', kind: 'soil', name: '耕地', tile: { x: 11, y: 12 }, passable: true, tilled: true, watered: false },
                { ref: '@s1:e2', kind: 'object', name: '杂草', tile: { x: 9, y: 12 }, passable: false }
            ],
            navigation: { exits: [{ ref: '@s1:e3', kind: 'exit', name: '农场小屋', tile: { x: 10, y: 13 } }] },
            menu: null,
            control: { ready: true, blockedBy: [] },
            shipping: [{ itemId: '(O)24', count: 2, quality: 0 }],
            observation: { truncated: false }
        };
    }
}
