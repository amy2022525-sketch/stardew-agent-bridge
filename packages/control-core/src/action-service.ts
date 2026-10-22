/**
 * 动作服务：唯一业务入口（MCP HTTP、stdio 适配器、Web API 全部经过这里）。
 *
 * 职责：
 *  - 参数校验 → 控制权校验 → 幂等/去重 → 意图持久化 → 派发游戏动作 → 收据落账 → 事件广播
 *  - 读工具直接转发并归一化；写工具必须持有有效控制会话
 *  - 任何结果不明都返回 unknown + effectKnown=false，并禁止自动重放消费动作
 */
import { randomUUID } from 'node:crypto';
import {
    ACTION_LEDGER_LIMIT,
    BridgeError,
    BRIDGE_VERSION,
    CONTRACTS_SCHEMA_VERSION,
    DEFAULT_ACTION_TIMEOUT_MS,
    SNAPSHOT_HARD_LIMIT_BYTES,
    actionSignature,
    buildReceipt,
    byteLength,
    dedupKey,
    describeIssues,
    getTool,
    makeFault,
    normalizeModCode,
    normalizeSnapshot,
    renderSnapshotText,
    trimSnapshotText,
    validateToolArguments,
    type ActionReceipt,
    type ActionStatus,
    type BridgeStatus,
    type ClientPresence,
    type ModHello,
    type ModResponse,
    type NextAction,
    type PauseReport,
    type SessionMode,
    type SnapshotSummary,
    type ToolSpec
} from '@sab/contracts';
import type { ModClient } from '@sab/game-client';
import type { ActionLedger, LedgerLogger } from './ledger.js';
import type { ControlManager } from './control-manager.js';
import type { EventLog } from './event-log.js';

export interface ToolContext {
    clientId: string;
    clientName: string;
    transport: 'http' | 'stdio' | 'web' | 'cli';
    signal?: AbortSignal;
}

export interface ToolImage {
    mimeType: string;
    dataBase64: string;
    sampledAt: string;
}

export interface ToolResult {
    isError: boolean;
    text: string;
    structured?: Record<string, unknown>;
    image?: ToolImage;
}

export interface ActionServiceOptions {
    mod: ModClient;
    control: ControlManager;
    ledger: ActionLedger;
    events: EventLog;
    logger?: LedgerLogger;
    presence?: () => ClientPresence[];
    port?: number;
    startedAt?: string;
    modPollMs?: number;
}

interface WorldTracker {
    instanceId: string | null;
    worldGeneration: number | null;
    sceneGeneration: number;
    location: string | null;
}

const EFFECT_KEYS = [
    'requestedCount', 'actualCount', 'goldBefore', 'goldAfter', 'inventoryDelta',
    'itemId', 'slot', 'count', 'quality', 'moved', 'energyBefore', 'energyAfter',
    'healthBefore', 'healthAfter', 'money', 'detail', 'changed', 'caught', 'fish',
    'defeated', 'damage', 'reason', 'stopReason', 'menuClosed', 'sleepStarted',
    'saved', 'daysAdvanced', 'date', 'outcome', 'phase', 'stages', 'target', 'player',
    'fishingState', 'requested', 'bought', 'shipped', 'spent', 'moneyBefore', 'moneyAfter',
    'verified', 'note', 'accepted', 'saveId'
];

function pickEffects(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') return null;
    const record = result as Record<string, unknown>;
    if (record.effects && typeof record.effects === 'object') return record.effects as Record<string, unknown>;
    const effects: Record<string, unknown> = {};
    for (const key of EFFECT_KEYS) {
        if (record[key] !== undefined && record[key] !== null) effects[key] = record[key];
    }
    return Object.keys(effects).length > 0 ? effects : null;
}

function extractPause(result: unknown): { state?: string; menuType?: string | null; selfOpened?: boolean } | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const pause = (result as Record<string, unknown>).pause;
    if (!pause || typeof pause !== 'object') return undefined;
    return pause as { state?: string; menuType?: string | null; selfOpened?: boolean };
}

export class ActionService {
    private readonly mod: ModClient;
    private readonly control: ControlManager;
    private readonly ledger: ActionLedger;
    private readonly events: EventLog;
    private readonly logger?: LedgerLogger;
    private readonly presence: () => ClientPresence[];
    private readonly port: number;
    private readonly startedAt: string;
    private readonly modPollMs: number;
    private activeActionId: string | null = null;
    private activeCommand: string | null = null;
    private activeClientId: string | null = null;
    private actionCounter = 0;
    private world: WorldTracker = { instanceId: null, worldGeneration: null, sceneGeneration: 1, location: null };

    constructor(options: ActionServiceOptions) {
        this.mod = options.mod;
        this.control = options.control;
        this.ledger = options.ledger;
        this.events = options.events;
        this.logger = options.logger;
        this.presence = options.presence ?? (() => []);
        this.port = options.port ?? 0;
        this.startedAt = options.startedAt ?? new Date().toISOString();
        this.modPollMs = options.modPollMs ?? 1_000;
    }

    get worldTracker(): Readonly<WorldTracker> {
        return this.world;
    }

    get activeAction(): { actionId: string; command: string } | null {
        return this.activeActionId && this.activeCommand
            ? { actionId: this.activeActionId, command: this.activeCommand }
            : null;
    }

    // -----------------------------------------------------------------------
    // 工具执行入口
    // -----------------------------------------------------------------------

    async executeTool(toolName: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
        const validation = validateToolArguments(toolName, rawArgs);
        if (!validation.ok) {
            const message = validation.tool ? describeIssues(validation.issues) : '未知工具。';
            return this.errorResult('INVALID_ARGUMENT', `参数校验失败：${message}`, { issues: validation.issues });
        }
        const tool = validation.tool;
        const args = validation.args;
        try {
            if (tool.command === 'bridge:status') return this.statusResult(args);
            if (tool.command === 'bridge:session') return await this.handleSession(args, ctx);
            if (tool.command === 'stop') return await this.handleStop(args, ctx);
            if (tool.kind === 'read' || (tool.kind === 'mixed' && args.operation === 'list')) {
                return await this.runRead(tool, args, ctx);
            }
            return await this.runWrite(tool, args, ctx);
        } catch (error) {
            const bridgeError = BridgeError.from(error);
            this.logger?.('warn', `工具 ${toolName} 失败：${bridgeError.fault.code} ${bridgeError.message}`);
            return this.errorResult(bridgeError.fault.code, bridgeError.message, bridgeError.fault.detail ?? null);
        }
    }

    // -----------------------------------------------------------------------
    // 只读路径
    // -----------------------------------------------------------------------

    private async runRead(tool: ToolSpec, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        if (!this.mod.connected) {
            // 只读也要求游戏连接，但返回明确诊断而不是静默失败。
            return this.errorResult('GAME_UNAVAILABLE', `游戏 Mod 未连接，无法执行 ${tool.name}。可先用 stardew_status 查看 Bridge 侧诊断。`);
        }
        const modArgs = tool.modArgs ? tool.modArgs(args) : pickArgs(args);
        const response = await this.mod.request(tool.command, modArgs, {
            timeoutMs: tool.command === 'screenshot' ? 15_000 : DEFAULT_ACTION_TIMEOUT_MS,
            isWrite: false
        });
        if (response.status !== 'succeeded') {
            const code = normalizeModCode(response.error?.code);
            return this.errorResult(code, response.error?.message ?? `${tool.command} 失败。`);
        }
        return this.mapReadResult(tool, response, ctx);
    }

    private mapReadResult(tool: ToolSpec, response: ModResponse, ctx: ToolContext): ToolResult {
        const result = response.result;
        if (tool.command === 'snapshot') {
            const summary = this.trackSnapshot(result);
            const text = trimSnapshotText(renderSnapshotText(summary), SNAPSHOT_HARD_LIMIT_BYTES);
            const envelope = {
                kind: 'snapshot',
                snapshot: summary,
                text: text.value,
                truncated: text.truncated,
                bytes: text.bytes
            };
            if (text.bytes > SNAPSHOT_HARD_LIMIT_BYTES) {
                return this.errorResult('OUTPUT_LIMIT', `快照输出 ${text.bytes} 字节超过硬上限，请缩小 radius。`);
            }
            return { isError: false, text: text.value, structured: envelope };
        }
        if (tool.command === 'screenshot') {
            const record = (result ?? {}) as Record<string, unknown>;
            const base64 = typeof record.base64 === 'string' ? record.base64 : '';
            if (base64.length === 0) return this.errorResult('INTERNAL_ERROR', '截图返回空数据。');
            const sampledAt = new Date().toISOString();
            const bytes = Math.floor((base64.length * 3) / 4);
            return {
                isError: false,
                text: `截图已返回（PNG，约 ${Math.round(bytes / 1024)} KiB，采样时间 ${sampledAt}）。文字模型可忽略此图，改用 stardew_snapshot。`,
                structured: {
                    kind: 'screenshot',
                    mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
                    sampledAt,
                    bytes,
                    instanceId: this.mod.hello?.instanceId ?? null,
                    worldGeneration: this.world.worldGeneration,
                    sceneGeneration: this.world.sceneGeneration
                },
                image: {
                    mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
                    dataBase64: base64,
                    sampledAt
                }
            };
        }
        if (tool.command === 'hello') {
            const hello = (result ?? {}) as ModHello;
            const structured = {
                kind: 'doctor',
                bridge: {
                    version: BRIDGE_VERSION,
                    contractsSchemaVersion: CONTRACTS_SCHEMA_VERSION,
                    port: this.port
                },
                mod: hello,
                world: { ...this.world },
                caller: { clientId: ctx.clientId, transport: ctx.transport }
            };
            const text = [
                `Bridge 已连接游戏：mod=${hello.modVersion ?? '?'} game=${hello.gameVersion ?? '?'} smapi=${hello.smapiVersion ?? '?'} 协议=${hello.protocol ?? '?'}`,
                `存档=${hello.saveLoaded ? '已加载' : '标题页/加载中'} 单人=${hello.singlePlayer ? '是' : '否'} 代次 epoch=${hello.epoch ?? '?'}`,
                `暂停=${hello.pause?.state ?? 'unknown'} 看门狗=${hello.watchdog?.bridgeLinkUp ? '链路正常' : '链路断开'}`,
                `能力=${(hello.capabilities ?? []).length} 项；写命令=${(hello.writeCommands ?? []).length} 项`
            ].join('\n');
            return { isError: false, text, structured };
        }
        const structured = {
            kind: tool.command,
            command: tool.command,
            result,
            world: { ...this.world }
        };
        const serialized = JSON.stringify(result ?? null);
        if (byteLength(serialized) > SNAPSHOT_HARD_LIMIT_BYTES) {
            return this.errorResult('OUTPUT_LIMIT', `${tool.command} 输出过大（${byteLength(serialized)} 字节），请缩小范围。`);
        }
        return { isError: false, text: `${tool.command} 结果：${serialized}`, structured };
    }

    private trackSnapshot(result: unknown): SnapshotSummary {
        const raw = (result ?? {}) as Record<string, unknown>;
        const summary = normalizeSnapshot(raw, { sceneGeneration: this.world.sceneGeneration });
        const instanceId = summary.instanceId;
        const worldGeneration = summary.worldGeneration;
        const locationChanged = this.world.location !== null && this.world.location !== summary.location;
        if (locationChanged) this.world.sceneGeneration += 1;
        summary.sceneGeneration = this.world.sceneGeneration;
        this.world = {
            instanceId,
            worldGeneration,
            sceneGeneration: this.world.sceneGeneration,
            location: summary.location
        };
        this.control.bindWorld(instanceId, this.worldGenerationForSession());
        return summary;
    }

    /** 会话绑定的世界代次：标题页（无存档）时为 null。 */
    private worldGenerationForSession(): number | null {
        if (!this.mod.hello?.saveLoaded) return null;
        return this.world.worldGeneration;
    }

    // -----------------------------------------------------------------------
    // 写路径
    // -----------------------------------------------------------------------

    private async runWrite(tool: ToolSpec, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const sessionId = typeof args.controlSessionId === 'string' ? args.controlSessionId : null;
        const session = this.control.requireWriter(ctx.clientId, sessionId);
        if (!this.mod.connected) {
            throw new BridgeError('GAME_UNAVAILABLE', '游戏 Mod 未连接，写动作已拒绝。');
        }
        const command = tool.command;
        const modArgs = tool.modArgs ? tool.modArgs(args) : pickArgs(args);
        const providedId = typeof args.actionId === 'string' ? args.actionId : null;
        const actionId = providedId ?? this.generateActionId(session.controlSessionId);
        const signature = actionSignature({
            clientId: ctx.clientId,
            controlSessionId: session.controlSessionId,
            command,
            args: modArgs
        });
        const instanceId = this.mod.hello?.instanceId ?? this.world.instanceId;
        if (!instanceId) throw new BridgeError('GAME_UNAVAILABLE', '缺少游戏实例标识，无法安全去重。');
        // -1 表示“执行时世界代次未知”（例如标题页或刚连接）：不得用于跨世界冲突判定。
        const recordedWorldGeneration = this.world.worldGeneration ?? -1;
        const key = dedupKey(instanceId, actionId);

        const existing = this.ledger.lookup(key, signature);
        if (existing.kind === 'conflict') {
            return this.errorResult(
                'IDEMPOTENCY_CONFLICT',
                `actionId ${actionId} 已用于不同参数（原命令 ${existing.row?.command ?? '?'}），原收据未被覆盖。请查询原收据或使用新的 actionId。`,
                { actionId, originalCommand: existing.row?.command ?? null }
            );
        }
        // 同一 actionId 但记录属于另一个世界（例如中途换过存档）：既不返回旧收据，也不重放。
        const recordedWorld = existing.row?.worldGeneration;
        if (
            existing.kind === 'same' &&
            typeof recordedWorld === 'number' && recordedWorld >= 0 &&
            this.world.worldGeneration !== null &&
            recordedWorld !== this.world.worldGeneration
        ) {
            return this.errorResult(
                'IDEMPOTENCY_CONFLICT',
                `actionId ${actionId} 的旧记录属于另一个世界（记录世界代次 ${recordedWorld}，当前 ${this.world.worldGeneration}）。请使用新的 actionId 并重新观察真实状态。`,
                { actionId, recordedWorldGeneration: recordedWorld, currentWorldGeneration: this.world.worldGeneration }
            );
        }
        if (existing.kind === 'same') {
            if (existing.row?.receipt) {
                return this.receiptResult(existing.row.receipt, `重复提交：返回 actionId ${actionId} 的原收据，未再次执行。`);
            }
            return this.errorResult(
                'RESULT_UNKNOWN',
                `actionId ${actionId} 已提交但尚无最终收据；请用 stardew_status 查询未决动作，不要用新 ID 重做消费动作。`,
                { actionId, status: existing.row?.status ?? 'accepted' }
            );
        }
        if (!this.ledger.writable) {
            throw new BridgeError('JOURNAL_UNAVAILABLE', this.ledger.lastError ?? '动作账本不可写，已拒绝派发写动作。');
        }
        if (this.activeActionId) {
            return this.errorResult(
                'ACTION_BUSY',
                `已有动作 ${this.activeActionId}（${this.activeCommand}）正在执行；不提供隐式排队，请等待或先 stop。`,
                { activeActionId: this.activeActionId, activeCommand: this.activeCommand }
            );
        }

        const startedAt = new Date().toISOString();
        this.ledger.recordIntent({
            dedupKey: key,
            actionId,
            signature,
            command,
            clientId: ctx.clientId,
            controlSessionId: session.controlSessionId,
            gameInstanceId: instanceId,
            worldGeneration: recordedWorldGeneration,
            intentAt: startedAt
        });
        this.activeActionId = actionId;
        this.activeCommand = tool.name;
        this.activeClientId = ctx.clientId;
        this.events.publish('action_accepted', {
            actionId,
            command,
            tool: tool.name,
            clientId: ctx.clientId,
            controlSessionId: session.controlSessionId
        });
        this.ledger.saveSession({ ...session, state: session.state, lastActivityAt: startedAt });

        let response: ModResponse | null = null;
        let transportError: BridgeError | null = null;
        try {
            if (ctx.signal?.aborted) throw new BridgeError('CANCELLED', '请求在派发前已取消。', { effectKnown: true, nextAction: 'observe' });
            const pending = this.mod.request(command, modArgs, {
                actionId,
                epoch: session.leaseEpoch,
                timeoutMs: tool.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
                isWrite: true
            });
            const onAbort = () => {
                void this.handleStop({ actionId }, ctx).catch(error => this.logger?.('warn', `取消 ${actionId} 未获确认：${String(error)}`));
            };
            ctx.signal?.addEventListener('abort', onAbort, { once: true });
            if (ctx.signal?.aborted) onAbort();
            try { response = await pending; }
            finally { ctx.signal?.removeEventListener('abort', onAbort); }
        } catch (error) {
            transportError = BridgeError.from(error);
            if (this.mod.connected && !transportError.fault.effectKnown) {
                try { await this.handleStop({ actionId }, ctx); } catch { /* 结果仍待核对；不会重放。 */ }
            }
        }

        const receipt = this.buildWriteReceipt({
            tool,
            ctx,
            session,
            actionId,
            command,
            startedAt,
            response,
            transportError
        });
        this.activeActionId = null;
        this.activeCommand = null;
        this.activeClientId = null;

        try {
            this.ledger.finish(key, receipt);
        } catch (error) {
            // 游戏已执行但账本写入失败：不重放，保留内存收据并在事件里标注。
            this.logger?.('error', `保存最终收据失败：${error instanceof Error ? error.message : String(error)}`);
        }
        void this.control.noteActivity(session.controlSessionId);
        this.control.attachReceipt(session.controlSessionId, actionId);
        this.events.publish(receipt.status === 'succeeded' ? 'action_succeeded' : `action_${receipt.status}`, {
            actionId,
            command,
            status: receipt.status,
            clientId: ctx.clientId,
            controlSessionId: session.controlSessionId,
            summary: receipt.summary,
            effects: receipt.effects
        });
        if (receipt.status === 'succeeded' || receipt.status === 'partial') {
            this.trackFromResult(response?.result);
        }
        return this.receiptResult(receipt);
    }

    private buildWriteReceipt(input: {
        tool: ToolSpec;
        ctx: ToolContext;
        session: { controlSessionId: string; leaseEpoch: number };
        actionId: string;
        command: string;
        startedAt: string;
        response: ModResponse | null;
        transportError: BridgeError | null;
    }): ActionReceipt {
        const finishedAt = new Date().toISOString();
        const pauseBase: PauseReport = { ...this.control.status(null, null, []).pause };
        if (input.transportError) {
            const code = input.transportError.fault.code;
            const effectKnown = input.transportError.fault.effectKnown;
            const status: ActionStatus = code === 'CANCELLED' ? 'cancelled' : effectKnown ? 'failed' : 'unknown';
            return buildReceipt({
                actionId: input.actionId,
                clientId: input.ctx.clientId,
                controlSessionId: input.session.controlSessionId,
                gameInstanceId: this.mod.hello?.instanceId ?? null,
                worldGeneration: this.world.worldGeneration,
                sceneGeneration: this.world.sceneGeneration,
                command: input.command,
                status,
                verified: false,
                effectKnown,
                startedAt: input.startedAt,
                finishedAt,
                stopReason: status === 'cancelled' ? 'cancelled' : null,
                effects: null,
                pause: { ...pauseBase, requested: true, state: 'unknown', reason: 'error' },
                error: input.transportError.fault
            });
        }
        const response = input.response!;
        const pauseFromMod = extractPause(response.result);
        if (pauseFromMod) this.control.updatePauseFrom(pauseFromMod);
        const pause: PauseReport = pauseFromMod
            ? {
                  requested: true,
                  state: (pauseFromMod.state === 'paused' || pauseFromMod.state === 'running' || pauseFromMod.state === 'blocked'
                      ? pauseFromMod.state
                      : 'unknown') as PauseReport['state'],
                  reason: pauseFromMod.selfOpened ? 'self_pause_menu' : pauseFromMod.menuType ? 'user_menu' : null,
                  menuType: pauseFromMod.menuType ?? null
              }
            : { ...pauseBase, requested: false };

        const rawCode = response.error?.code;
        let status: ActionStatus;
        if (response.status === 'succeeded') status = 'succeeded';
        else if (response.status === 'partial') status = 'partial';
        else if (response.status === 'cancelled') status = 'cancelled';
        else if (response.status === 'unknown') status = 'unknown';
        else status = rawCode === 'TIMEOUT' || rawCode === 'RESULT_UNKNOWN' ? 'unknown' : 'failed';
        const result = (response.result ?? {}) as Record<string, unknown>;
        if (status === 'succeeded') {
            if (input.command === 'load' && result.accepted === true) status = 'accepted';
            else if (result.outcome === 'partial' || result.outcome === 'stopped') status = 'partial';
            else if (input.command === 'buy' && typeof result.bought === 'number' && typeof result.requested === 'number' && result.bought < result.requested) status = 'partial';
        }

        const effectKnown = response.error?.effectKnown ?? (
            response.status === 'succeeded' || response.status === 'partial' || response.status === 'cancelled'
                ? true
                : status === 'failed'
                  ? true
                  : false);
        if (!effectKnown && status === 'failed') status = 'unknown';
        const effects = pickEffects(response.result);
        // 结果不明统一用 RESULT_UNKNOWN 表达，避免被误读成普通内部错误。
        const code: string = status === 'unknown' ? 'RESULT_UNKNOWN' : normalizeModCode(rawCode);
        const error =
            response.status === 'succeeded' || response.status === 'partial'
                ? null
                : makeFault(code, response.error?.message ?? `${input.command} 未成功完成。`, {
                      effectKnown,
                      nextAction: (response.error?.nextAction as NextAction | undefined) ?? undefined,
                      detail:
                          rawCode && rawCode !== code
                              ? { originalCode: rawCode, modStatus: response.status }
                              : null
                  });
        const nextAction: NextAction =
            status === 'succeeded' || status === 'partial'
                ? 'observe'
                : status === 'unknown'
                  ? 'query_action'
                  : (error?.nextAction ?? 'observe');
        return buildReceipt({
            actionId: input.actionId,
            clientId: input.ctx.clientId,
            controlSessionId: input.session.controlSessionId,
            gameInstanceId: this.mod.hello?.instanceId ?? null,
            worldGeneration: this.world.worldGeneration,
            sceneGeneration: this.world.sceneGeneration,
            command: input.command,
            status,
            verified: typeof result.verified === 'boolean' ? result.verified : status === 'succeeded' && typeof result.snapshot === 'object' && result.snapshot !== null,
            effectKnown,
            startedAt: input.startedAt,
            finishedAt,
            stopReason: status === 'cancelled' ? (code ?? 'cancelled') : null,
            effects,
            pause,
            error,
            nextAction
        });
    }

    private trackFromResult(result: unknown): void {
        if (!result || typeof result !== 'object') return;
        const snapshot = (result as Record<string, unknown>).snapshot;
        if (snapshot && typeof snapshot === 'object') this.trackSnapshot(snapshot);
    }

    private generateActionId(sessionId: string): string {
        this.actionCounter += 1;
        return `${sessionId.replace(/^ctrl_/, 'a')}-${Date.now().toString(36)}-${this.actionCounter}`;
    }

    // -----------------------------------------------------------------------
    // 控制会话与停止
    // -----------------------------------------------------------------------

    private async handleSession(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const operation = args.operation as 'start' | 'status' | 'checkpoint' | 'end';
        const sessionId = typeof args.controlSessionId === 'string' ? args.controlSessionId : null;
        if (operation === 'start') {
            const session = await this.control.start({
                clientId: ctx.clientId,
                clientName: ctx.clientName,
                mode: (args.mode as SessionMode | undefined) ?? 'step',
                label: typeof args.label === 'string' ? args.label : null
            });
            this.events.publish('session_started', {
                controlSessionId: session.controlSessionId,
                clientId: ctx.clientId,
                mode: session.mode
            });
            return {
                isError: false,
                text: `已取得控制权。controlSessionId=${session.controlSessionId} mode=${session.mode} epoch=${session.leaseEpoch} 租约到期=${session.expiresAt}。写动作请带上该会话（或显式传 controlSessionId）。`,
                structured: { kind: 'session', session }
            };
        }
        if (operation === 'status') {
            const sessions = this.control.list();
            const active = this.control.activeSession;
            return {
                isError: false,
                text: active
                    ? `当前控制者：${active.clientName}（${active.clientId}）会话 ${active.controlSessionId} epoch=${active.leaseEpoch} 到期=${active.expiresAt}`
                    : '当前没有活动控制会话。',
                structured: { kind: 'session', operation: 'status', active, sessions }
            };
        }
        if (operation === 'checkpoint') {
            const session = this.control.checkpoint(ctx.clientId, sessionId, {
                goal: typeof args.goal === 'string' ? args.goal : undefined,
                progress: typeof args.progress === 'string' ? args.progress : undefined,
                next: typeof args.next === 'string' ? args.next : undefined,
                constraints: typeof args.constraints === 'string' ? args.constraints : undefined
            });
            return {
                isError: false,
                text: `进度笔记已保存（会话 ${session.controlSessionId}）。恢复时请重新观察真实状态，笔记不等于存档事实。`,
                structured: { kind: 'session', operation: 'checkpoint', session }
            };
        }
        const session = await this.control.end(ctx.clientId, sessionId, 'client_end');
        this.events.publish('session_ended', {
            controlSessionId: session.controlSessionId,
            clientId: ctx.clientId
        });
        const pause = this.control.status(null, null, []).pause;
        return {
            isError: false,
            text: `控制会话已结束（暂停状态：${pause.state}${pause.reason ? ` / ${pause.reason}` : ''}）。`,
            structured: { kind: 'session', operation: 'end', session, pause }
        };
    }

    private async handleStop(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const requestedActionId = typeof args.actionId === 'string' ? args.actionId : null;
        if (this.activeActionId && this.activeClientId !== ctx.clientId) {
            return this.errorResult('CONTROL_REQUIRED', '只能停止自己发起的动作；人工紧急停止请使用网页接管或游戏内热键。');
        }
        if (!this.activeActionId || (requestedActionId && requestedActionId !== this.activeActionId)) {
            return {
                isError: false,
                text: '该客户端当前没有在途动作，未向游戏发送 stop。',
                structured: { kind: 'stop', sent: false, reason: 'no_owned_action' }
            };
        }
        if (!this.mod.connected) {
            return this.errorResult('GAME_UNAVAILABLE', '游戏 Mod 未连接，无法发送 stop。');
        }
        const targetActionId = this.activeActionId;
        const response = await this.mod.request('stop', { actionId: targetActionId }, {
            timeoutMs: 5_000,
            isWrite: false
        });
        if (response.status !== 'succeeded') return this.errorResult(response.error?.code ?? 'RESULT_UNKNOWN', response.error?.message ?? '游戏未确认停止。');
        this.control.updatePauseFrom(extractPause(response.result));
        const result = (response.result ?? {}) as Record<string, unknown>;
        const pause = this.control.status(null, null, []).pause;
        this.events.publish('action_stopped', {
            actionId: targetActionId,
            clientId: ctx.clientId,
            releasedInputs: result.releasedInputs ?? null
        });
        return {
            isError: false,
            text: `已发送停止指令。释放输入=${JSON.stringify(result.releasedInputs ?? [])} 暂停=${pause.state}${pause.reason ? ` / ${pause.reason}` : ''}`,
            structured: { kind: 'stop', sent: true, mod: response.result, pause }
        };
    }

    // -----------------------------------------------------------------------
    // 状态与收据查询
    // -----------------------------------------------------------------------

    getStatus(): BridgeStatus {
        const hello = this.mod.hello;
        const unresolved = this.ledger.unresolved(10).map((receipt) => receipt.actionId);
        const control = this.control.status(this.activeActionId, this.activeCommand, unresolved);
        return {
            ok: true,
            bridgeVersion: process.env.SAB_VERSION ?? '0.1.0',
            contractsSchemaVersion: CONTRACTS_SCHEMA_VERSION,
            startedAt: this.startedAt,
            now: new Date().toISOString(),
            port: this.port,
            modPollMs: this.modPollMs,
            mod: {
                connected: this.mod.connected,
                protocol: hello?.protocol ?? null,
                instanceId: hello?.instanceId ?? this.world.instanceId,
                modVersion: hello?.modVersion ?? null,
                gameVersion: hello?.gameVersion ?? null,
                smapiVersion: hello?.smapiVersion ?? null,
                saveLoaded: hello?.saveLoaded ?? false,
                worldGeneration: this.world.worldGeneration,
                sceneGeneration: this.world.sceneGeneration,
                capabilities: hello?.capabilities ?? [],
                lastHeartbeatAt: this.mod.lastHeartbeatAt ? new Date(this.mod.lastHeartbeatAt).toISOString() : null,
                paused: (hello?.pause?.state as BridgeStatus['mod']['paused']) ?? 'unknown',
                epoch: hello?.epoch ?? 0,
                controller: hello?.controller ?? null,
                lastError: this.mod.lastError,
                reconnectAttempts: this.mod.reconnectAttempts
            },
            control,
            ledger: {
                writable: this.ledger.writable,
                schemaVersion: this.ledger.schemaVersion,
                actionCount: this.ledger.countActions(),
                openWorlds: [],
                lastError: this.ledger.lastError
            },
            clients: this.presence(),
            notice: this.mod.connected ? null : '等待游戏连接：请通过 SMAPI 启动星露谷，并确认桥接 Mod 已加载。'
        };
    }

    private statusResult(args: Record<string, unknown>): ToolResult {
        const status = this.getStatus();
        const receipt = typeof args.actionId === 'string' ? this.ledger.findById(args.actionId) : null;
        const recentReceipts = this.ledger.recent(5);
        const unresolvedReceipts = this.ledger.unresolved(10);
        const text = [
            `Bridge ${status.bridgeVersion} 端口 ${status.port}`,
            `Mod 连接=${status.mod.connected ? '是' : '否'} 实例=${status.mod.instanceId ?? '-'} 存档=${status.mod.saveLoaded ? '已加载' : '未加载'}`,
            `控制者=${status.control.holder ? `${status.control.holder.clientName}(${status.control.holder.clientId})` : '无'} 在途动作=${status.control.activeActionId ?? '无'}`,
            `未决动作=${status.control.unresolvedActionIds.length} 账本可写=${status.ledger.writable ? '是' : '否'} 记录=${status.ledger.actionCount}`,
            `暂停=${status.control.pause.state}${status.control.pause.reason ? ` / ${status.control.pause.reason}` : ''}`
        ].join('\n');
        const records = { receipt, recentReceipts, unresolvedReceipts };
        return { isError: false, text: `${text}\n收据=${JSON.stringify(records)}`, structured: { kind: 'status', status, ...records } };
    }

    resolveReceipt(actionId: string): ActionReceipt | null {
        return this.ledger.findById(actionId);
    }

    recentReceipts(limit = 20, clientId?: string): ActionReceipt[] {
        return this.ledger.recent(limit, clientId);
    }

    private receiptResult(receipt: ActionReceipt, extraNote?: string): ToolResult {
        const isError = receipt.status === 'failed' || receipt.status === 'cancelled' || receipt.status === 'unknown';
        const lines = [receipt.summary];
        if (extraNote) lines.push(extraNote);
        if (receipt.effects) lines.push(`effects=${JSON.stringify(receipt.effects)}`);
        lines.push(`暂停=${receipt.pause.state}${receipt.pause.reason ? `/${receipt.pause.reason}` : ''} 后验=${receipt.verified ? '是' : '否'} 下一步=${receipt.nextAction}`);
        return {
            isError,
            text: lines.join('\n'),
            structured: { kind: 'action', receipt }
        };
    }

    private errorResult(code: string, message: string, detail: Record<string, unknown> | null = null): ToolResult {
        const fault = makeFault(code, message, { detail });
        return {
            isError: true,
            text: `错误 ${fault.code}: ${fault.message}（effectKnown=${fault.effectKnown} 下一步=${fault.nextAction}）`,
            structured: { kind: 'error', fault }
        };
    }

    ledgerLimit(): number {
        return ACTION_LEDGER_LIMIT;
    }
}

function pickArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === 'actionId' || key === 'controlSessionId') continue;
        out[key] = value;
    }
    return out;
}

