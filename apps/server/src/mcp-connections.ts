import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BRIDGE_VERSION } from '@sab/contracts';
import type { TransportMode } from './hosts.js';

export const MCP_CHECK_CLIENT_ID = 'web-mcp-check';

export function validMcpClientId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(value)
        && !Object.hasOwn(Object.prototype, value) && value !== 'web' && value !== MCP_CHECK_CLIENT_ID;
}

export interface McpConnectionCheck {
    ok: true;
    transport: TransportMode;
    toolCount: number;
    serverName: string;
    serverVersion: string;
    checkedAt: string;
    durationMs: number;
}

/** 使用真实 MCP 客户端检查握手、工具发现和只读状态；身份与 Agent 分开。 */
export async function checkMcpConnection(input: {
    transport: TransportMode;
    url: string;
    token: string;
    dataDir: string;
    adapterPath: string;
    signal: AbortSignal;
}): Promise<McpConnectionCheck> {
    const started = Date.now();
    const client = new Client({ name: 'stardew-web-connection-check', version: BRIDGE_VERSION });
    const transport = input.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(input.url), { authProvider: { token: async () => input.token } })
        : new StdioClientTransport({
            command: process.execPath,
            args: [input.adapterPath],
            env: { SAB_CLIENT_ID: MCP_CHECK_CLIENT_ID, SAB_HOME: input.dataDir, SAB_URL: input.url.replace(/\/mcp$/, '') },
            stderr: 'ignore'
        });
    try {
        await client.connect(transport, { signal: input.signal, timeout: 10_000 });
        const tools = await client.listTools({}, { signal: input.signal, timeout: 10_000 });
        if (!tools.tools.some(tool => tool.name === 'stardew_status')) throw new Error('未发现 stardew_status 工具。');
        const status = await client.callTool({ name: 'stardew_status', arguments: {} }, { signal: input.signal, timeout: 10_000 });
        if (status.isError) throw new Error('MCP 已连接，但只读状态查询失败。');
        const server = client.getServerVersion();
        return {
            ok: true, transport: input.transport, toolCount: tools.tools.length,
            serverName: server?.name ?? 'stardew-agent-bridge', serverVersion: server?.version ?? BRIDGE_VERSION,
            checkedAt: new Date().toISOString(), durationMs: Date.now() - started
        };
    } finally {
        await client.close();
    }
}
