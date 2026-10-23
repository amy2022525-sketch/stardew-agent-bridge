/**
 * Web 控制台（无框架，仅 TypeScript + DOM）。
 * 只调用本机 /api/v1 接口；所有写操作需网页会话 + CSRF，且经过同一业务核心。
 */
import type { ActionReceipt, BridgeStatus, ControlSessionInfo } from '@sab/contracts';
import { setupMcpPanel } from './mcp-panel.js';

interface TimelineEvent {
    seq: number;
    at: string;
    kind: string;
    payload: Record<string, unknown>;
}

const els = {
    modDot: document.getElementById('mod-dot') as HTMLElement,
    version: document.getElementById('bridge-version') as HTMLElement,
    pausePill: document.getElementById('pause-pill') as HTMLElement,
    statusGrid: document.getElementById('status-grid') as HTMLElement,
    statusNotice: document.getElementById('status-notice') as HTMLElement,
    controlGrid: document.getElementById('control-grid') as HTMLElement,
    snapshot: document.getElementById('snapshot-text') as HTMLElement,
    screenshotWrap: document.getElementById('screenshot-wrap') as HTMLElement,
    screenshot: document.getElementById('screenshot') as HTMLImageElement,
    timeline: document.getElementById('timeline') as HTMLElement,
    notes: document.getElementById('notes-text') as HTMLElement,
    hostSnippet: document.getElementById('host-snippet') as HTMLElement,
    hostTarget: document.getElementById('host-target') as HTMLElement,
    hostNotes: document.getElementById('host-notes') as HTMLElement,
    diag: document.getElementById('diag-text') as HTMLElement
};

let csrfToken = '';
let currentStatus: BridgeStatus | null = null;
let actionNotice: string | null = null;
let mcpPanel: ReturnType<typeof setupMcpPanel> | null = null;
function showNotice(text: string): void {
    actionNotice = text;
    els.statusNotice.textContent = text;
}

function setKv(target: HTMLElement, pairs: [string, string][]): void {
    target.innerHTML = '';
    for (const [key, value] of pairs) {
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.textContent = value;
        target.append(dt, dd);
    }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('x-sab-csrf', csrfToken);
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const payload = (await response.json()) as { error?: string; message?: string; fault?: { message?: string } };
            detail = payload.fault?.message ?? payload.message ?? payload.error ?? detail;
        } catch {
            /* 非 JSON 错误 */
        }
        throw new Error(detail);
    }
    return (await response.json()) as T;
}

function fmtTime(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function renderStatus(): void {
    const status = currentStatus;
    if (!status) return;
    els.version.textContent = `v${status.bridgeVersion} · 契约 ${status.contractsSchemaVersion}`;
    els.modDot.classList.toggle('online', status.mod.connected);
    const pause = status.control.pause;
    els.pausePill.textContent = `暂停：${pause.state}${pause.reason ? ` / ${pause.reason}` : ''}`;
    setKv(els.statusGrid, [
        ['游戏连接', status.mod.connected ? '已连接' : '未连接'],
        ['Mod / 游戏 / SMAPI', `${status.mod.modVersion ?? '—'} / ${status.mod.gameVersion ?? '—'} / ${status.mod.smapiVersion ?? '—'}`],
        ['内部协议', status.mod.protocol ?? '—'],
        ['存档', status.mod.saveLoaded ? '已加载' : '标题页或加载中'],
        ['游戏实例', status.mod.instanceId ?? '—'],
        ['世界 / 场景代次', `${status.mod.worldGeneration ?? '—'} / ${status.mod.sceneGeneration}`],
        ['控制权代次 epoch', String(status.mod.epoch)],
        ['Mod 最后心跳', fmtTime(status.mod.lastHeartbeatAt)],
        ['动作账本', status.ledger.writable ? `可写（${status.ledger.actionCount} 条）` : `不可写：${status.ledger.lastError ?? '未知'}`],
        ['在线客户端', status.clients.map((client) => `${client.clientName}(${client.transport})`).join('、') || '（无）'],
        ['服务端口', String(status.port)]
    ]);
    els.statusNotice.textContent = actionNotice ?? status.notice ?? '';
    renderControl();
    renderNotes();
}

function renderControl(): void {
    const status = currentStatus;
    if (!status) return;
    const holder = status.control.holder;
    setKv(els.controlGrid, [
        ['当前控制者', holder ? `${holder.clientName}（${holder.clientId}）` : '无'],
        ['控制会话', holder?.controlSessionId ?? '—'],
        ['模式 / 过期时间', holder ? `${holder.mode} / ${fmtTime(holder.expiresAt)}` : '—'],
        ['在途动作', status.control.activeActionId ? `${status.control.activeCommand} (${status.control.activeActionId})` : '无'],
        ['未决动作', status.control.unresolvedActionIds.length > 0 ? status.control.unresolvedActionIds.join(', ') : '无']
    ]);
}

function renderNotes(): void {
    void (async () => {
        try {
            const data = await api<{ sessions: ControlSessionInfo[]; active: ControlSessionInfo | null }>('/api/v1/sessions');
            const sessions = data.sessions.filter((session) => session.state === 'active' || session.checkpoint);
            if (sessions.length === 0) {
                els.notes.textContent = '（尚无进度笔记）';
                return;
            }
            els.notes.textContent = sessions
                .map((session) => {
                    const checkpoint = session.checkpoint;
                    return [
                        `会话 ${session.controlSessionId}（${session.clientName}，${session.state}）`,
                        `  目标：${checkpoint?.goal ?? '—'}`,
                        `  进度：${checkpoint?.progress ?? '—'}`,
                        `  下一步：${checkpoint?.next ?? '—'}`,
                        `  约束：${checkpoint?.constraints ?? '—'}`,
                        `  更新：${fmtTime(checkpoint?.updatedAt ?? null)}`
                    ].join('\n');
                })
                .join('\n\n');
        } catch {
            /* 忽略笔记读取失败 */
        }
    })();
}

function addTimelineEvent(event: TimelineEvent): void {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(event.at);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = event.kind;
    const body = document.createElement('span');
    const summary = event.payload['summary'] ?? event.payload['status'] ?? event.payload['reason'] ?? '';
    const actionId = event.payload['actionId'] ?? '';
    body.textContent = `${actionId ? `[${actionId}] ` : ''}${String(summary)}`;
    li.append(time, kind, body);
    els.timeline.prepend(li);
    while (els.timeline.childElementCount > 200) els.timeline.lastElementChild?.remove();
}

async function refreshStatus(): Promise<void> {
    try {
        currentStatus = await api<BridgeStatus>('/api/v1/status');
        renderStatus();
        await mcpPanel?.refresh();
    } catch (error) {
        els.statusNotice.textContent = `读取状态失败：${error instanceof Error ? error.message : String(error)}`;
    }
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    return api<{ isError: boolean; text: string }>(`/api/v1/tool/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify(args)
    });
}

async function takeSnapshot(): Promise<void> {
    try {
        const result = await callTool('stardew_snapshot', { radius: 5 });
        els.snapshot.textContent = result.text;
        await refreshStatus();
        await loadReceipts();
    } catch (error) {
        els.snapshot.textContent = `快照失败：${error instanceof Error ? error.message : String(error)}`;
    }
}

async function loadReceipts(): Promise<void> {
    try {
        const data = await api<{ receipts: ActionReceipt[] }>('/api/v1/receipts?limit=20');
        els.timeline.innerHTML = '';
        for (const receipt of data.receipts.slice().reverse()) {
            addTimelineEvent({
                seq: 0,
                at: receipt.finishedAt ?? receipt.startedAt,
                kind: `action_${receipt.status}`,
                payload: { actionId: receipt.actionId, summary: `${receipt.command}: ${receipt.status}${receipt.error ? ` (${receipt.error.code})` : ''}` }
            });
        }
    } catch {
        /* 忽略 */
    }
}

function wire(): void {
    const on = (id: string, handler: () => void | Promise<void>) => {
        const button = document.getElementById(id);
        button?.addEventListener('click', () => {
            void (async () => {
                actionNotice = null;
                try {
                    await handler();
                } catch (error) {
                    showNotice(`${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    await refreshStatus();
                }
            })();
        });
    };

    on('btn-refresh', refreshStatus);
    on('btn-snapshot', takeSnapshot);
    on('btn-start', async () => {
        await api('/api/v1/control/start', { method: 'POST', body: JSON.stringify({ mode: 'step' }) });
    });
    on('btn-takeover', async () => {
        const result = await api<{ closedSessionIds: string[]; pause: { state: string } }>('/api/v1/control/takeover', {
            method: 'POST',
            body: JSON.stringify({ reason: 'web' })
        });
        showNotice(`已接管：关闭 ${result.closedSessionIds.length} 个会话，暂停状态 ${result.pause.state}。`);
    });
    on('btn-end', async () => {
        await api('/api/v1/control/end', { method: 'POST', body: '{}' });
    });
    on('btn-stop', async () => {
        const result = await callTool('stardew_stop', {});
        showNotice(result.text);
    });
    on('btn-pause', async () => {
        const result = await callTool('stardew_pause', {});
        showNotice(result.text);
    });
    on('btn-closemenu', async () => {
        const result = await callTool('stardew_closemenu', {});
        showNotice(result.text);
    });
    on('btn-screenshot', async () => {
        const response = await fetch('/api/v1/screenshot');
        if (!response.ok) throw new Error(`截图失败：HTTP ${response.status}`);
        const blob = await response.blob();
        els.screenshot.src = URL.createObjectURL(blob);
        els.screenshotWrap.classList.remove('hidden');
    });
    on('btn-diag', async () => {
        const data = await api<Record<string, unknown>>('/api/v1/diagnostics');
        els.diag.textContent = JSON.stringify(data, null, 2);
    });
    on('btn-bundle', async () => {
        const data = await api<{ file: string; note: string }>('/api/v1/diagnostics/export', { method: 'POST', body: '{}' });
        showNotice(`问题包已导出：${data.file}（${data.note}）`);
    });
}

async function boot(): Promise<void> {
    try {
        const session = await api<{ csrfToken: string }>('/api/v1/session');
        csrfToken = session.csrfToken;
    } catch {
        els.statusNotice.textContent = '无法建立网页会话。';
    }
    wire();
    mcpPanel = setupMcpPanel(api);
    await refreshStatus();
    await loadReceipts();
    const source = new EventSource('/api/v1/events');
    source.onmessage = (message) => {
        try {
            addTimelineEvent(JSON.parse(message.data) as TimelineEvent);
            if ((JSON.parse(message.data) as TimelineEvent).kind.startsWith('action_')) void refreshStatus();
        } catch {
            /* 忽略格式错误 */
        }
    };
    setInterval(() => void refreshStatus(), 5_000);
}

void boot();
