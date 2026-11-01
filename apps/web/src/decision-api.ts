/**
 * 决策执行器 Web API 客户端。
 *
 * 只调用本机 `/api/v1/decision/*`；CSRF 与凭据由 main.ts 的请求函数统一处理。
 * 前端永不保存模型密钥：写入后立即清空输入框，也不写 localStorage/sessionStorage。
 */
import type {
    DecisionConfigView,
    DecisionStatusView,
    MemoryRecord,
    TaskListResult,
    TaskView
} from '@sab/contracts';

/** main.ts 注入的已认证请求函数（自带 CSRF 与错误归一化）。 */
export type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface TaskOperationBody {
    requestId?: string;
    expectedRevision?: number;
    contextToken?: string;
    answer?: string;
    reason?: string;
    resolution?: 'accept_completion' | 'reviewed_pause' | 'reject_completion';
    note?: string;
    /** 接受完成候选时引用的证据 ID；服务端会校验它们属于该任务。 */
    evidenceIds?: string[];
    patch?: Record<string, unknown>;
}

export interface ProbeResult {
    ok: boolean;
    protocol: string;
    jsonOutput: boolean;
    latencyMs: number;
    finishReason?: string;
    usageSource?: string;
    error?: { code: string; message: string };
    note?: string;
}

export interface DecisionEventsPage {
    events: { id: number; taskId: string; runId: string | null; kind: string; payload: Record<string, unknown> | null; at: string }[];
}

export interface DecisionApiClient {
    status(): Promise<DecisionStatusView>;
    config(): Promise<DecisionConfigView>;
    saveConfig(config: Record<string, unknown>, expectedRevision: number): Promise<DecisionConfigView & { pausedTaskIds?: string[] }>;
    setSecret(providerId: string, value: string): Promise<{ configured: boolean; pausedTaskIds?: string[] }>;
    clearSecret(providerId: string): Promise<{ configured: boolean; pausedTaskIds?: string[] }>;
    probe(providerId: string): Promise<ProbeResult>;
    arm(): Promise<{ ok: boolean }>;
    listTasks(cursor?: string | null, limit?: number): Promise<TaskListResult>;
    getTask(taskId: string): Promise<TaskView>;
    taskOperation(taskId: string, operation: string, body: TaskOperationBody): Promise<Record<string, unknown>>;
    events(taskId: string, after?: number): Promise<DecisionEventsPage>;
    listMemories(taskId?: string | null): Promise<{ scopeKey: string; memories: MemoryRecord[]; expiredIds: string[]; truncated: boolean }>;
}

export function createDecisionApi(request: ApiFn): DecisionApiClient {
    const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
    return {
        status: () => request<DecisionStatusView>('/api/v1/decision/status'),
        config: () => request<DecisionConfigView>('/api/v1/decision/config'),
        saveConfig: (config, expectedRevision) =>
            request('/api/v1/decision/config', { method: 'PUT', body: JSON.stringify({ expectedRevision, config }) }),
        setSecret: (providerId, value) =>
            request(`/api/v1/decision/providers/${encodeURIComponent(providerId)}/secret`, json({ value })),
        clearSecret: (providerId) =>
            request(`/api/v1/decision/providers/${encodeURIComponent(providerId)}/secret`, { method: 'DELETE' }),
        probe: (providerId) =>
            request(`/api/v1/decision/providers/${encodeURIComponent(providerId)}/probe`, json({})),
        arm: () => request('/api/v1/decision/arm', json({})),
        listTasks: (cursor, limit) => {
            const params = new URLSearchParams();
            if (cursor) params.set('cursor', cursor);
            if (limit) params.set('limit', String(limit));
            const suffix = params.toString();
            return request(`/api/v1/decision/tasks${suffix ? `?${suffix}` : ''}`);
        },
        getTask: (taskId) => request(`/api/v1/decision/tasks/${encodeURIComponent(taskId)}`),
        taskOperation: (taskId, operation, body) =>
            request(`/api/v1/decision/tasks/${encodeURIComponent(taskId)}/${encodeURIComponent(operation)}`, json(body)),
        events: (taskId, after) =>
            request(`/api/v1/decision/tasks/${encodeURIComponent(taskId)}/events?after=${String(after ?? 0)}&limit=50`),
        listMemories: (taskId) =>
            request(`/api/v1/decision/memories${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`)
    };
}
