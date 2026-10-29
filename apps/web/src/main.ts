/**
 * Web 控制台（无框架，仅 TypeScript + DOM）。
 * 只调用本机 /api/v1 接口；所有写操作需网页会话 + CSRF，且经过同一业务核心。
 * Docker 模式下额外读取同源网关的净化状态 /container/live（原生部署 404 时整体隐藏）。
 */
import type { ActionReceipt, BridgeStatus, ControlSessionInfo } from '@sab/contracts';
import { setupMcpPanel } from './mcp-panel.js';
import { desktopLinkUrl, dockerStatusHint, fetchDockerStatus, type DockerStatusView } from './docker-status.mjs';

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
    dockerCard: document.getElementById('docker-card') as HTMLElement,
    dockerTitle: document.getElementById('docker-title') as HTMLElement,
    dockerDetail: document.getElementById('docker-detail') as HTMLElement,
    desktopLink: document.getElementById('btn-desktop') as HTMLAnchorElement,
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
    renderMultiplayer();
    renderControl();
    renderNotes();
}

function renderMultiplayer(): void {
    const status = currentStatus; if (!status) return;
    const mp = status.mod.multiplayer; const active = status.mod.singlePlayer === false;
    document.getElementById('multiplayer-card')?.classList.toggle('hidden', !active && !mp?.enabled);
    const grid = document.getElementById('multiplayer-grid');
    if (grid && mp) setKv(grid, [ ['状态 / 原因', `${mp.state} / ${mp.reason}`], ['世界', mp.worldId ?? '—'],
        ['我的农场工 ID', mp.actorFarmerId ?? '—'], ['主机 ID', mp.hostFarmerId ?? '—'], ['主机会话', mp.hostSessionId ?? '—'],
        ['连接', mp.connectionId ?? '—'], ['许可', mp.permissionLeaseHeld ? `有效，剩余 ${mp.permissionRemainingMs} ms` : '尚无有效许可'],
        ['政策版本 / 世界阶段', `${mp.policyRevision} / ${mp.phase}`] ]);
    const policy = document.getElementById('multiplayer-policy'); if (policy) policy.textContent = mp?.policy ? JSON.stringify(mp.policy, null, 2) : '主机尚未提供本角色的政策。';
    const pause = document.getElementById('btn-pause') as HTMLButtonElement | null; if (pause) pause.disabled = active;
    const bind = document.getElementById('btn-bind-actor') as HTMLButtonElement | null; if (bind) bind.disabled = !active || !mp?.enabled || !!status.control.holder;
    const note = document.getElementById('multiplayer-notice'); if (note) note.textContent = active ? '实时联机：停止或打开自己的背包都不能保证世界暂停。共享交易、箱子、睡觉确认和放置等操作尚未开放。' : '联机 profile 等待通过原生 Co-op 进入农场工。';
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

function renderDockerCard(docker: DockerStatusView | null): void {
    // 原生（非 Docker）部署没有 /container/live：整卡保持隐藏，页面其余功能不受影响。
    if (!docker) {
        els.dockerCard.classList.add('hidden');
        return;
    }
    els.dockerCard.classList.remove('hidden');
    const hint = dockerStatusHint(docker);
    if (hint) {
        els.dockerTitle.textContent = hint.title;
        els.dockerDetail.textContent = hint.detail;
    }
    setKv(document.getElementById('docker-grid') as HTMLElement, [
        ['模式 / 状态', `${docker.mode === 'game' ? 'game（含游戏）' : 'bridge（无游戏）'} / ${docker.state}`],
        ['Mod 握手', docker.modConnected ? '已连接' : '未连接'],
        ['存档', docker.saveLoaded ? '已加载' : '未加载'],
        ['桌面通道', docker.desktopEnabled ? (docker.desktopAvailable ? '可用' : '已启用但降级') : '未启用']
    ]);
    const url = desktopLinkUrl(docker);
    els.desktopLink.classList.toggle('hidden', url === null);
    if (url !== null) {
        els.desktopLink.href = url;
        els.desktopLink.rel = 'noopener noreferrer';
        els.desktopLink.target = '_blank';
    }
}


async function refreshStatus(): Promise<void> {
    try {
        currentStatus = await api<BridgeStatus>('/api/v1/status');
        renderStatus();
        await mcpPanel?.refresh();
    } catch (error) {
        els.statusNotice.textContent = `读取状态失败：${error instanceof Error ? error.message : String(error)}`;
    }
    renderDockerCard(await fetchDockerStatus());
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
        const mode = (document.getElementById('control-mode') as HTMLSelectElement).value;
        if (currentStatus?.mod.singlePlayer === false && mode !== 'realtime') throw new Error('联机需要选择“实时（世界继续运行）”。');
        await api('/api/v1/control/start', { method: 'POST', body: JSON.stringify({ mode }) });
    });
    on('btn-bind-actor', async () => {
        await api('/api/v1/multiplayer/bind', { method: 'POST', body: '{}' });
        showNotice('已绑定当前世界和自己的农场工；请让真人主机批准该角色，然后以实时模式开始控制。');
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
