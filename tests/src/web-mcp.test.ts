import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startStack, type Stack } from './helpers.js';

const stacks: Stack[] = [];
async function setup(saveLoaded = true) {
    const stack = await startStack({ saveLoaded });
    stacks.push(stack);
    const base = `http://127.0.0.1:${stack.bridgePort}`;
    const sessionResponse = await fetch(base + '/api/v1/session');
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
    const request = (route: string, body?: unknown) => fetch(base + route, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { cookie, origin: base, 'content-type': 'application/json', 'x-sab-csrf': csrfToken }
    });
    return { stack, base, cookie, request };
}
after(async () => { for (const stack of stacks) await stack.stop(); });

describe('Web MCP 连接', () => {
    it('连接信息需要网页会话，不公开凭据；跨源和缺少 CSRF 的配置请求被拒绝', async () => {
        const { stack, base, cookie, request } = await setup();
        assert.equal((await fetch(base + '/api/v1/mcp')).status, 401);
        const info = await request('/api/v1/mcp');
        assert.equal(info.status, 200);
        const body = await info.text();
        assert.ok(!body.includes(stack.token));
        assert.ok(!body.includes(stack.bridge.auth.modToken));
        assert.equal((JSON.parse(body) as { toolCount: number }).toolCount, 29);
        assert.equal((await fetch(base + '/api/v1/mcp/config', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
        assert.equal((await fetch(base + '/api/v1/mcp/check', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"transport":"http"}' })).status, 403);
        assert.equal((await fetch(base + '/api/v1/mcp', { headers: { cookie, origin: 'https://untrusted.example' } })).status, 403);
    });

    it('通用 HTTP 配置可被真实 MCP 客户端使用，重复生成不更换令牌', async () => {
        const { stack, request } = await setup();
        const payload = { host: 'generic', transport: 'http', clientId: 'my-agent' };
        const first = await request('/api/v1/mcp/config', payload);
        assert.equal(first.status, 200);
        const config = await first.json() as { snippet: { host: string; content: string }; token: string };
        assert.equal(config.snippet.host, 'generic');
        const again = await (await request('/api/v1/mcp/config', payload)).json() as { token: string };
        assert.equal(again.token, config.token);
        const { stardew } = JSON.parse(config.snippet.content).mcpServers;
        const client = new Client({ name: 'web-config-test', version: '1.0.0' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(stardew.url), { authProvider: { token: async () => config.token } }));
            assert.equal((await client.listTools()).tools.length, 29);
            assert.deepEqual((await (await request('/api/v1/mcp')).json() as { clients: unknown[] }).clients, []);
            assert.notEqual((await client.callTool({ name: 'stardew_status', arguments: {} })).isError, true);
        } finally { await client.close(); }
        const info = await (await request('/api/v1/mcp')).json() as { clients: { clientId: string; toolCalls: number }[] };
        assert.equal(info.clients.find(client => client.clientId === 'my-agent')?.toolCalls, 1);
        assert.equal(stack.mod.commandCount('acquire'), 0);
    });

    it('拒绝无效宿主、传输和保留连接名称，避免写入非法凭据', async () => {
        const { stack, request } = await setup();
        const count = stack.bridge.auth.listClients().length;
        for (const payload of [
            { host: '__proto__', transport: 'http', clientId: 'valid-agent' },
            { host: 'dsh', transport: 'invalid', clientId: 'valid-agent' },
            ...['__proto__', 'constructor', 'web', 'web-mcp-check', '../file', 'x'].map(clientId => ({ host: 'dsh', transport: 'stdio', clientId }))
        ]) assert.equal((await request('/api/v1/mcp/config', payload)).status, 400);
        assert.equal(stack.bridge.auth.listClients().length, count);
        assert.equal((await request('/api/v1/mcp/check', { transport: 'invalid' })).status, 400);
    });

    it('HTTP 检测真实完成握手、29 工具发现和只读调用，不将自检冒充 Agent 接入', async () => {
        const { stack, request } = await setup(false);
        const response = await request('/api/v1/mcp/check', { transport: 'http' });
        assert.equal(response.status, 200);
        const result = await response.json() as { ok: boolean; toolCount: number; saveLoaded: boolean; transport: string };
        assert.equal(result.ok, true);
        assert.equal(result.toolCount, 29);
        assert.equal(result.transport, 'http');
        assert.equal(result.saveLoaded, false);
        const info = await (await request('/api/v1/mcp')).json() as { clients: unknown[]; checks: { http: { ok: boolean } } };
        assert.deepEqual(info.clients, []);
        assert.equal(info.checks.http.ok, true);
        assert.equal(stack.bridge.control.activeSession, null);
        assert.equal(stack.mod.commandCount('acquire'), 0);
    });

    it('stdio 检测经过真实适配器返回同一 Bridge，不取得控制权', async () => {
        const { stack, request } = await setup();
        const response = await request('/api/v1/mcp/check', { transport: 'stdio' });
        assert.equal(response.status, 200);
        const result = await response.json() as { ok: boolean; toolCount: number; transport: string };
        assert.equal(result.ok, true);
        assert.equal(result.toolCount, 29);
        assert.equal(result.transport, 'stdio');
        assert.equal(stack.bridge.control.activeSession, null);
        assert.equal(stack.mod.commandCount('acquire'), 0);
    });
});
