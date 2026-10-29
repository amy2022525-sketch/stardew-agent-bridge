/**
 * 收据与去重签名的构造规则（接口草案 §5、§6）。
 */
import { createHash } from 'node:crypto';
import type { ActorContext } from './multiplayer.js';
import {
    CONTRACTS_SCHEMA_VERSION,
    type ActionReceipt,
    type ActionStatus,
    type BridgeFault,
    type NextAction,
    type PauseReport
} from './protocol.js';

/** 稳定序列化：对象键排序，数组保持顺序。用于去重签名。 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

export interface SignatureInput {
    clientId: string;
    controlSessionId: string | null;
    command: string;
    args: Record<string, unknown>;
    actorContext?: ActorContext;
}

/** 去重签名：客户端 + 控制会话 + 命令 + 规范化参数。 */
export function actionSignature(input: SignatureInput): string {
    return createHash('sha256')
        .update(canonicalJson({
            clientId: input.clientId,
            controlSessionId: input.controlSessionId,
            command: input.command,
            args: input.args,
            ...(input.actorContext ? { actorContext: input.actorContext } : {})
        }))
        .digest('hex');
}

/**
 * 去重键：游戏实例 + actionId。
 *
 * 刻意不含“世界代次”：世界代次可能在首次观察之前未知（标题页、刚连接时），
 * 若放进键里会让同一 actionId 在绑定世界前后落到不同键上，从而重复执行消费动作。
 * 世界代次作为审计字段单独保存，由服务层在重放时显式比对（不同世界 → 冲突）。
 */
export function dedupKey(gameInstanceId: string, actionId: string): string {
    return `${gameInstanceId}#${actionId}`;
}

export interface BuildReceiptInput {
    actionId: string;
    clientId: string;
    controlSessionId: string | null;
    gameInstanceId: string | null;
    worldGeneration: number | null;
    sceneGeneration: number | null;
    command: string;
    status: ActionStatus;
    verified: boolean;
    effectKnown: boolean;
    startedAt: string;
    finishedAt?: string | null;
    stopReason?: string | null;
    effects?: Record<string, unknown> | null;
    pause?: PauseReport;
    error?: BridgeFault | null;
    nextAction?: NextAction;
}

export function defaultPauseReport(): PauseReport {
    return { requested: false, state: 'unknown', reason: null, menuType: null };
}

/** 生成一行紧凑摘要，强调结果与下一步，不给模型错误的成功暗示。 */
export function buildSummary(input: {
    command: string;
    status: ActionStatus;
    verified?: boolean;
    effects?: Record<string, unknown> | null;
    pause?: PauseReport;
    error?: BridgeFault | null;
}): string {
    const parts: string[] = [];
    const statusText: Record<ActionStatus, string> = {
        accepted: '已受理',
        running: '执行中',
        succeeded: input.verified ? '已完成并核验' : '已完成（待核验）',
        partial: '部分完成',
        failed: '失败',
        cancelled: '已停止',
        unknown: '结果不明'
    };
    parts.push(`${input.command}: ${statusText[input.status]}`);
    const effects = input.effects ?? null;
    if (effects) {
        const pairs: string[] = [];
        for (const [key, value] of Object.entries(effects)) {
            if (value === null || value === undefined) continue;
            if (typeof value === 'object') continue;
            pairs.push(`${key}=${String(value)}`);
        }
        if (pairs.length > 0) parts.push(pairs.join(' '));
    }
    if (input.pause?.requested) {
        const pauseText = input.pause.state === 'paused' ? '已暂停' : `暂停未完成(${input.pause.state})`;
        parts.push(pauseText);
    }
    if (input.error) parts.push(`错误 ${input.error.code}: ${input.error.message}`);
    if (input.error && input.error.nextAction !== 'none') parts.push(`下一步 ${input.error.nextAction}`);
    return parts.join('；');
}

export function buildReceipt(input: BuildReceiptInput): ActionReceipt {
    const pause = input.pause ?? defaultPauseReport();
    const error = input.error ?? null;
    return {
        schemaVersion: CONTRACTS_SCHEMA_VERSION,
        actionId: input.actionId,
        clientId: input.clientId,
        controlSessionId: input.controlSessionId,
        gameInstanceId: input.gameInstanceId,
        worldGeneration: input.worldGeneration,
        sceneGeneration: input.sceneGeneration,
        command: input.command,
        status: input.status,
        verified: input.verified,
        effectKnown: input.effectKnown,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt ?? null,
        stopReason: input.stopReason ?? null,
        effects: input.effects ?? null,
        pause,
        error,
        nextAction: input.nextAction ?? error?.nextAction ?? 'observe',
        summary: buildSummary({
            command: input.command,
            status: input.status,
            verified: input.verified,
            effects: input.effects ?? null,
            pause,
            error
        }),
        reconciliation: []
    };
}
