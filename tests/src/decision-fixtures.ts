/**
 * 决策执行器测试用的合成 fixture（synthetic）。
 *
 * - 不含真实密钥、真实玩家存档或真实游戏数据；
 * - FakeProvider 只实现 DecisionProvider 接口，绝不访问网络；
 * - FakeGamePort 记录调用序列，便于断言“派发了哪些动作、几次、给谁”。
 */
import type {
    ActionReceipt,
    BridgeStatus,
    ControlSessionInfo,
    SnapshotSummary,
    WorldIdentity,
    DecisionEnvelope
} from '@sab/contracts';
import type {
    AuthzPort,
    DecisionPolicyView,
    DispatchWriteRequest,
    DispatchWriteResult,
    GamePort,
    ProviderResolverPort,
    ReadOnlyResult,
    StartControlResult
} from '@sab/decision-core';
import type { DecisionProvider, ProviderCallResult } from '@sab/decision-core';

export const TEST_IDENTITY: WorldIdentity = {
    schemaVersion: 1,
    source: 'native_game',
    worldId: '1234567890123456789',
    actorFarmerId: '9007199254740993'
};

export function snapshot(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
    return {
        snapshotId: overrides.snapshotId ?? 'snap_1',
        instanceId: 'inst-1',
        worldGeneration: 3,
        sceneGeneration: 1,
        location: 'Farm',
        date: { season: 'spring', day: 3, year: 1 },
        time: 900,
        player: {
            name: '测试农夫',
            money: 500,
            health: 100,
            maxHealth: 100,
            energy: 70,
            maxEnergy: 100,
            position: { x: 60, y: 15 },
            selectedSlot: 0,
            maxItems: 36
        },
        inventory: [
            { slot: 0, itemId: '(T)WateringCan', name: '水壶', count: 1, tool: 'watering_can', water: 20, waterCapacity: 40 }
        ],
        entities: [
            { ref: '@s1:e1', kind: 'crop', name: '防风草', tile: { x: 64, y: 18 }, watered: false, needsWater: true },
            { ref: '@s1:e2', kind: 'crop', name: '防风草', tile: { x: 65, y: 18 }, watered: false, needsWater: true }
        ],
        exits: [],
        menu: null,
        control: { ready: true, blockedBy: [] },
        shipping: null,
        truncated: false,
        worldIdentity: TEST_IDENTITY,
        coverage: { location: 'Farm', bounds: { x: 54, y: 9, width: 13, height: 13 }, complete: true },
        sampledAt: '2026-10-30T01:00:00.000Z',
        ...overrides
    };
}

export function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
    return {
        ok: true,
        bridgeVersion: '0.3.5',
        contractsSchemaVersion: 1,
        startedAt: '2026-10-30T00:00:00.000Z',
        now: '2026-10-30T01:00:00.000Z',
        port: 18055,
        modPollMs: 1000,
        mod: {
            connected: true,
            instanceId: 'inst-1',
            modVersion: '0.2.0',
            gameVersion: '1.6',
            smapiVersion: '4.0',
            protocol: 'sab/2',
            capabilities: [],
            lastHeartbeatAt: '2026-10-30T01:00:00.000Z',
            paused: 'unknown',
            epoch: 5,
            controller: null,
            lastError: null,
            reconnectAttempts: 0,
            saveLoaded: true,
            singlePlayer: true,
            worldGeneration: 3,
            sceneGeneration: 0,
            writeCommands: ['move', 'select', 'use']
        },
        control: {
            holder: null,
            activeActionId: null,
            activeCommand: null,
            unresolvedActionIds: [],
            mode: null,
            pause: { requested: false, state: 'unknown', reason: null, menuType: null }
        },
        ledger: { writable: true, schemaVersion: 2, actionCount: 0, openWorlds: [], lastError: null },
        clients: [],
        notice: null,
        ...overrides
    };
}

export function receipt(actionId: string, overrides: Partial<ActionReceipt> = {}): ActionReceipt {
    return {
        schemaVersion: 2,
        actionId,
        clientId: 'sab-internal-decision:tester',
        controlSessionId: 'session-1',
        command: 'use',
        status: 'succeeded',
        verified: true,
        effectKnown: true,
        summary: '已对目标使用水壶',
        startedAt: '2026-10-30T01:00:00.000Z',
        finishedAt: '2026-10-30T01:00:01.000Z',
        effects: { watered: 1 },
        nextAction: 'observe',
        pause: { requested: false, state: 'unknown', reason: null, menuType: null },
        ...overrides
    } as ActionReceipt;
}

/** 可编排的假游戏端口：记录每次写派发与观察。 */
export class FakeGamePort implements GamePort {
    readonly writes: DispatchWriteRequest[] = [];
    readonly reads: { toolName: string; args: Record<string, unknown> }[] = [];
    readonly snapshots: SnapshotSummary[] = [snapshot()];
    snapshotIndex = 0;
    controlBusy = false;
    controlSessions = 0;
    endedSessions: string[] = [];
    private readonly results: DispatchWriteResult[] = [];

    private statusValue: BridgeStatus;

    constructor(initial: BridgeStatus = status()) {
        this.statusValue = initial;
    }

    setStatus(next: BridgeStatus): void {
        this.statusValue = next;
    }

    enqueueWriteResult(result: DispatchWriteResult): void {
        this.results.push(result);
    }

    pushSnapshot(next: SnapshotSummary): void {
        this.snapshots.push(next);
    }

    status(): BridgeStatus {
        return this.statusValue;
    }

    async freshSnapshot(): Promise<SnapshotSummary> {
        const index = Math.min(this.snapshotIndex, this.snapshots.length - 1);
        this.snapshotIndex += 1;
        return this.snapshots[index] as SnapshotSummary;
    }

    latestWorldIdentity(): WorldIdentity | null {
        return this.snapshots[0]?.worldIdentity ?? TEST_IDENTITY;
    }

    async startControlSession(_internalClientId: string, _name: string): Promise<StartControlResult> {
        if (this.controlBusy) return { ok: false, code: 'CONTROL_BUSY', message: '控制权被占用' };
        this.controlSessions += 1;
        return {
            ok: true,
            session: {
                controlSessionId: 'session-1',
                clientId: _internalClientId,
                clientName: _name,
                state: 'active',
                mode: 'step',
                leaseEpoch: 5,
                gameInstanceId: 'inst-1',
                worldGeneration: 3,
                startedAt: '2026-10-30T01:00:00.000Z',
                lastActivityAt: '2026-10-30T01:00:00.000Z',
                expiresAt: '2026-10-30T01:03:00.000Z',
                closedAt: null,
                closeReason: null,
                checkpoint: null
            }
        };
    }

    async endControlSession(_internalClientId: string, controlSessionId: string): Promise<void> {
        this.endedSessions.push(controlSessionId);
    }

    noteActivity(): void {
        /* 读操作不续租；测试不模拟心跳 */
    }

    async dispatchWrite(request: DispatchWriteRequest): Promise<DispatchWriteResult> {
        this.writes.push(request);
        return this.results.shift() ?? { kind: 'receipt', receipt: receipt(request.actionId, { command: 'use' }) };
    }

    async stopActiveAction(): Promise<DispatchWriteResult> {
        return { kind: 'receipt', receipt: receipt('stop', { status: 'cancelled', effectKnown: false }) };
    }

    async runReadOnly(_internalClientId: string, toolName: string, args: Record<string, unknown>): Promise<ReadOnlyResult> {
        this.reads.push({ toolName, args });
        return { ok: true, text: `${toolName} ok`, structured: { kind: toolName } };
    }
}

/** 按脚本返回决策包的假模型：不访问网络，不做隐式兜底。 */
export class FakeProvider implements DecisionProvider {
    readonly id = 'fake';
    readonly label = 'Fake Provider';
    readonly protocol = 'openai-chat-compatible' as const;
    readonly calls: { systemPrompt: string; contextJson: string }[] = [];

    constructor(private decisions: (string | Error | ((context: string) => string))[]) {}

    async decide(request: { systemPrompt: string; contextJson: string }): Promise<ProviderCallResult> {
        this.calls.push({ systemPrompt: request.systemPrompt, contextJson: request.contextJson });
        const next = this.decisions.shift();
        if (next === undefined) throw new Error('FakeProvider 决策脚本已耗尽');
        if (next instanceof Error) throw next;
        return {
            decisionText: typeof next === 'function' ? next(request.contextJson) : next,
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'provider' },
            latencyMs: 5,
            finishReason: 'stop'
        };
    }
}

export function envelope(partial: Partial<DecisionEnvelope> & Pick<DecisionEnvelope, 'kind'>): string {
    return JSON.stringify({
        schemaVersion: 1,
        observationId: partial.observationId ?? 'obs_placeholder',
        stepId: partial.stepId ?? null,
        toolName: partial.toolName ?? null,
        argumentsJson: partial.argumentsJson ?? null,
        plan: partial.plan ?? null,
        briefReason: partial.briefReason ?? '测试决策',
        evidenceIds: partial.evidenceIds ?? [],
        question: partial.question ?? null,
        ...partial
    });
}

export const TEST_POLICY: DecisionPolicyView = {
    policyId: 'farm-care',
    label: '农场照料（浇水）',
    revision: 1,
    allowedTools: ['stardew_status', 'stardew_snapshot', 'stardew_move', 'stardew_select', 'stardew_use'],
    allowedLocations: ['Farm'],
    toolRestrictions: { stardew_use: { waterOnly: true }, stardew_select: { waterOnly: true } },
    budgetCaps: { maxGoldSpend: 0 }
};

export class FakeAuthz implements AuthzPort {
    authorized = true;
    policy: DecisionPolicyView | null = TEST_POLICY;

    isClientAuthorized(): boolean {
        return this.authorized;
    }

    isProviderAllowed(): boolean {
        return true;
    }

    isPolicyAllowed(): boolean {
        return this.policy !== null;
    }

    policySnapshot(): DecisionPolicyView | null {
        return this.policy;
    }

    currentPolicyTightening(): DecisionPolicyView | null {
        return this.policy;
    }

    effectiveBudgetLimits(): Record<string, number> {
        return { maxModelCalls: 60, maxWriteActions: 80, maxActiveMs: 600_000, maxAccountedTokens: 120_000, maxHttpAttempts: 60 };
    }

    multiplayerAutomationAllowed(): boolean {
        return false;
    }
}

export class FakeProviders implements ProviderResolverPort {
    constructor(private readonly provider: DecisionProvider) {}

    async resolveProvider(): Promise<{ provider: DecisionProvider; configRevision: number }> {
        return { provider: this.provider, configRevision: 1 };
    }

    publicProviderIds(): string[] {
        return [this.provider.id];
    }
}

export class RecordingEvents {
    readonly events: { kind: string; taskId: string; payload: Record<string, unknown> }[] = [];

    emit(event: { kind: string; taskId: string; payload: Record<string, unknown> }): void {
        this.events.push(event);
    }
}
