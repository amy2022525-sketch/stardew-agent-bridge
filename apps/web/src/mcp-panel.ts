import type { ClientPresence } from '@sab/contracts';

type Transport = 'http' | 'stdio';
interface CheckResult { transport: Transport; toolCount: number; checkedAt: string; durationMs: number }
interface ConnectionInfo {
    url: string;
    toolCount: number;
    clients: ClientPresence[];
    checks: Partial<Record<Transport, CheckResult>>;
}
interface HostConfig {
    clientId: string;
    snippet: { content: string; targetFile: string; language: 'json' | 'toml'; notes: string[] };
}
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export function setupMcpPanel(api: Api): { refresh: () => Promise<void> } {
    const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const host = byId<HTMLSelectElement>('host-select');
    const transport = byId<HTMLSelectElement>('transport-select');
    const clientId = byId<HTMLInputElement>('mcp-client-id');
    const endpoint = byId<HTMLInputElement>('mcp-endpoint');
    const summary = byId('mcp-summary');
    const notice = byId('mcp-notice');
    const checkResult = byId('mcp-check-result');
    const snippet = byId('host-snippet');
    const target = byId('host-target');
    const notes = byId('host-notes');
    const generate = byId<HTMLButtonElement>('btn-host');
    const copy = byId<HTMLButtonElement>('btn-copy');
    const download = byId<HTMLButtonElement>('btn-download-config');
    const check = byId<HTMLButtonElement>('btn-check-mcp');
    let generated: HostConfig | null = null;
    let busy = false;
    let info: ConnectionInfo | null = null;
    const failedChecks = new Set<Transport>();
    endpoint.value = new URL('/mcp', location.href).href;

    function showCheck(): void {
        if (failedChecks.has(transport.value as Transport)) {
            checkResult.textContent = '最近一次检测未通过，请检查连接方式后重试。';
            return;
        }
        const result = info?.checks[transport.value as Transport];
        checkResult.textContent = result
            ? `${result.transport === 'http' ? 'HTTP' : 'stdio'} 通道检测通过：${result.toolCount} 个工具，只读状态查询成功；${new Date(result.checkedAt).toLocaleTimeString('zh-CN')}，耗时 ${result.durationMs} ms。导入配置后，让 Agent 调用 stardew_status 确认实际接入。`
            : '尚未检测。本机检测会完成 MCP 握手、工具发现和只读状态查询；Agent 的实际接入情况以调用记录为准。';
    }

    function clearConfig(): void {
        generated = null;
        copy.disabled = true;
        download.disabled = true;
        snippet.textContent = '选项已变化，请重新生成配置。';
        target.textContent = '选择 Agent 程序后生成配置。';
        notes.replaceChildren();
        notice.textContent = '';
        showCheck();
    }

    host.addEventListener('change', () => {
        clientId.value = host.value === 'generic' ? 'agent' : host.value;
        transport.value = host.value === 'generic' ? 'http' : 'stdio';
        clearConfig();
    });
    transport.addEventListener('change', clearConfig);
    clientId.addEventListener('input', clearConfig);

    async function refresh(): Promise<void> {
        try {
            info = await api<ConnectionInfo>('/api/v1/mcp');
            endpoint.value = info.url;
            summary.textContent = `MCP 服务已启动 · ${info.toolCount} 个工具`;
            summary.classList.add('online');
            const list = byId('mcp-clients');
            list.replaceChildren();
            for (const client of info.clients) {
                const row = document.createElement('li');
                row.className = 'mcp-client';
                for (const text of [client.clientName, client.clientId, client.transport === 'http' ? 'HTTP' : 'stdio', `最近调用 ${new Date(client.lastSeenAt).toLocaleString('zh-CN')} · ${client.toolCalls} 次`]) {
                    const cell = document.createElement('span');
                    cell.textContent = text;
                    row.append(cell);
                }
                list.append(row);
            }
            byId('mcp-clients-empty').classList.toggle('hidden', info.clients.length > 0);
            if (!busy) showCheck();
        } catch {
            summary.textContent = 'MCP 状态暂不可用';
            summary.classList.remove('online');
        }
    }

    async function run(button: HTMLButtonElement, label: string, action: () => Promise<void>): Promise<void> {
        if (busy) return;
        busy = true;
        const previous = button.textContent;
        button.textContent = label;
        for (const field of [host, transport, clientId, generate, check, copy, download]) field.disabled = true;
        notice.textContent = '';
        try { await action(); }
        catch (error) { notice.textContent = error instanceof Error ? error.message : String(error); }
        finally {
            busy = false;
            button.textContent = previous;
            for (const field of [host, transport, clientId, generate, check]) field.disabled = false;
            copy.disabled = !generated;
            download.disabled = !generated;
        }
    }

    generate.addEventListener('click', () => {
        if (!clientId.reportValidity()) return;
        void run(generate, '正在生成…', async () => {
            const data = await api<HostConfig>('/api/v1/mcp/config', {
                method: 'POST', body: JSON.stringify({ host: host.value, transport: transport.value, clientId: clientId.value.trim() })
            });
            generated = data;
            snippet.textContent = data.snippet.content;
            target.textContent = `导入位置：${data.snippet.targetFile}　连接名称：${data.clientId}`;
            notes.replaceChildren();
            for (const text of data.snippet.notes) {
                const li = document.createElement('li');
                li.textContent = text;
                notes.append(li);
            }
            notice.textContent = '配置已生成，可复制或下载后导入 Agent。配置仅供本机使用。';
        });
    });

    async function copyText(text: string, success: string): Promise<void> {
        try { await navigator.clipboard.writeText(text); notice.textContent = success; }
        catch { notice.textContent = '浏览器未允许复制，请选中上方内容手动复制。'; }
    }
    byId('btn-copy-endpoint').addEventListener('click', () => { void copyText(endpoint.value, 'MCP 地址已复制。HTTP 鉴权信息请从生成的配置中获取。'); });
    copy.addEventListener('click', () => { if (generated) void copyText(generated.snippet.content, '配置已复制，可在 Agent 的 MCP 设置中导入。'); });
    download.addEventListener('click', () => {
        if (!generated) return;
        const url = URL.createObjectURL(new Blob([generated.snippet.content], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `stardew-${generated.clientId}-mcp.${generated.snippet.language === 'toml' ? 'toml' : 'json'}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notice.textContent = '配置已下载，请在对应 Agent 中导入。';
    });
    check.addEventListener('click', () => {
        void run(check, '正在检测…', async () => {
            const mode = transport.value as Transport;
            checkResult.textContent = '正在建立 MCP 连接并读取工具列表与状态…';
            try {
                await api<CheckResult>('/api/v1/mcp/check', { method: 'POST', body: JSON.stringify({ transport: transport.value }) });
                failedChecks.delete(mode);
                await refresh();
                showCheck();
            } catch (error) {
                failedChecks.add(mode);
                checkResult.textContent = '本次检测未通过，请检查连接方式后重试。';
                throw error;
            }
        });
    });
    return { refresh };
}
