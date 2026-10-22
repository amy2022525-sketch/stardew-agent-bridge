/**
 * 传输一致性测试：同一常驻 Bridge 同时服务 HTTP MCP 与 stdio 适配器。
 * 断言两者工具面一致、结果结构一致，并且共享同一控制权与账本。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startStack, type Stack } from './helpers.js';

const stacks: Stack[] = [];
const clients: Client[] = [];

async function stack(): Promise<Stack> {
    const created = await startStack();
    stacks.push(created);
    return created;
}

function authProvider(token: string) {
    return { token: async () => token };
}

async function httpClient(s: Stack, token = s.token, modern = false): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.bridgePort}/mcp`), {
        authProvider: authProvider(token)
    });
    const client = new Client({ name: 'test-http', version: '1.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(transport);
    clients.push(client);
    return client;
}

after(async () => {
    for (const client of clients) {
        try {
            await client.close();
        } catch {
            /* 忽略关闭错误 */
        }
    }
    for (const created of stacks) await created.stop();
});

describe('HTTP MCP', () => {
    it('真实 MCP 调用保留 Bearer 客户端身份，不把所有宿主合并为 unknown', async () => {
        const s = await stack();
        const a = await httpClient(s);
        const other = s.bridge.auth.issue('second-client', 'Second client');
        const b = await httpClient(s, other.token);
        const doctor = await a.callTool({ name: 'stardew_doctor', arguments: {} });
        assert.equal((doctor.structuredContent as { caller?: { clientId?: string } }).caller?.clientId, s.clientId);
        const started = await a.callTool({ name: 'stardew_session', arguments: { operation: 'start' } });
        const id = (started.structuredContent as { session: { controlSessionId: string } }).session.controlSessionId;
        const denied = await b.callTool({ name: 'stardew_select', arguments: { slot: 0, controlSessionId: id } });
        assert.equal(denied.isError, true);
        assert.equal(s.mod.commandCount('select'), 0);
    });

    for (const modern of [false, true]) it(`取消真实 HTTP MCP 写请求会向 Mod 发送该动作的定向停止（${modern ? '2026' : '2025'}）`, async () => {
        const s = await stack();
        const client = await httpClient(s, s.token, modern);
        await client.callTool({ name: 'stardew_session', arguments: { operation: 'start' } });
        s.mod.setBehavior('wait', () => ({ status: 'succeeded', delayMs: 750, result: { changed: true } }));
        const abort = new AbortController();
        const running = client.callTool({ name: 'stardew_wait', arguments: { milliseconds: 1000, actionId: 'cancel-http' } }, { signal: abort.signal }).catch(() => undefined);
        const deadline = Date.now() + 2500;
        while (!s.mod.commandCount('wait') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(s.mod.commandCount('wait'), 1);
        abort.abort();
        await running;
        while (!s.mod.commandCount('stop') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(s.mod.requests.find(request => request.command === 'stop')?.args.actionId, 'cancel-http', `era=${client.getProtocolEra()} version=${client.getNegotiatedProtocolVersion()}`);
        await new Promise(resolve => setTimeout(resolve, 800));
    });

    it('暴露 28 个工具，名称与契约一致', async () => {
        const s = await stack();
        const client = await httpClient(s);
        const { tools } = await client.listTools();
        assert.equal(tools.length, 28);
        const names = tools.map((tool) => tool.name).sort();
        assert.ok(names.includes('stardew_snapshot'));
        assert.ok(names.includes('stardew_session'));
        assert.equal(names.some((name) => name.includes('warp')), false);
        for (const tool of tools) assert.ok((tool.description ?? '').length > 5);
    });

    it('只读工具返回文本与结构化结果', async () => {
        const s = await stack();
        const client = await httpClient(s);
        const result = await client.callTool({ name: 'stardew_snapshot', arguments: { radius: 4 } });
        assert.notEqual(result.isError, true);
        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content.find((item) => item.type === 'text')?.text ?? '';
        assert.match(text, /观察/);
        const structured = result.structuredContent as { snapshot?: { location?: string } } | undefined;
        assert.equal(structured?.snapshot?.location, 'Farm');
    });

    it('参数校验失败返回 isError=true 而不是异常', async () => {
        const s = await stack();
        const client = await httpClient(s);
        const result = await client.callTool({ name: 'stardew_snapshot', arguments: { radius: 99 } });
        assert.equal(result.isError, true);
    });

    it('无控制会话的写入被拒绝，建立会话后成功', async () => {
        const s = await stack();
        const client = await httpClient(s);
        const denied = await client.callTool({ name: 'stardew_select', arguments: { slot: 0 } });
        assert.equal(denied.isError, true);
        assert.match(String((denied.content as Array<{ text?: string }>)[0]?.text ?? ''), /CONTROL_REQUIRED/);

        const started = await client.callTool({
            name: 'stardew_session',
            arguments: { operation: 'start', mode: 'step', goal: '通过 HTTP 测试' }
        });
        assert.notEqual(started.isError, true);
        const ok = await client.callTool({ name: 'stardew_select', arguments: { slot: 0 } });
        assert.notEqual(ok.isError, true);
        assert.equal(s.mod.commandCount('select'), 1);
    });

    it('错误令牌无法连接 MCP 端点', async () => {
        const s = await stack();
        await assert.rejects(async () => {
            const client = await httpClient(s, 'wrong-token-value');
            await client.listTools();
        });
    });

    it('/health 与 /api/v1/status 可访问，未带令牌的状态请求被拒', async () => {
        const s = await stack();
        const health = await fetch(`http://127.0.0.1:${s.bridgePort}/health`);
        assert.equal(health.status, 200);
        const healthBody = (await health.json()) as { ok: boolean; modConnected: boolean };
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.modConnected, true);

        const anonymous = await fetch(`http://127.0.0.1:${s.bridgePort}/api/v1/status`);
        assert.equal(anonymous.status, 401);

        const authorized = await fetch(`http://127.0.0.1:${s.bridgePort}/api/v1/status`, {
            headers: { authorization: `Bearer ${s.token}` }
        });
        assert.equal(authorized.status, 200);
        const status = (await authorized.json()) as { mod: { connected: boolean }; contractsSchemaVersion: number };
        assert.equal(status.mod.connected, true);
        assert.equal(typeof status.contractsSchemaVersion, 'number');
        assert.ok(status.contractsSchemaVersion > 0);
    });
});

describe('stdio 适配器一致性', () => {
    it('同一 Bridge 下 stdio 与 HTTP 工具面一致，且共享控制权', async () => {
        const s = await stack();
        const http = await httpClient(s);
        const httpTools = (await http.listTools()).tools.map((tool) => tool.name).sort();

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve(process.cwd(), 'adapters', 'stdio', 'dist', 'index.js')],
            env: {
                ...process.env as Record<string, string>,
                SAB_HOME: s.dataDir,
                SAB_CLIENT_ID: s.clientId,
                SAB_URL: `http://127.0.0.1:${s.bridgePort}`
            },
            stderr: 'ignore'
        });
        const stdioClient = new Client({ name: 'test-stdio', version: '1.0.0' });
        await stdioClient.connect(transport);
        clients.push(stdioClient);

        const stdioTools = (await stdioClient.listTools()).tools.map((tool) => tool.name).sort();
        assert.deepEqual(stdioTools, httpTools, 'stdio 与 HTTP 必须暴露同一工具面');

        const snapshot = await stdioClient.callTool({ name: 'stardew_snapshot', arguments: { radius: 3 } });
        assert.notEqual(snapshot.isError, true);
        const structured = snapshot.structuredContent as { snapshot?: { location?: string } } | undefined;
        assert.equal(structured?.snapshot?.location, 'Farm');

        // 通过 HTTP 建立会话后，stdio 侧应看到同一控制者（共享状态，而不是各自一套）
        await http.callTool({ name: 'stardew_session', arguments: { operation: 'start', mode: 'step' } });
        const status = await stdioClient.callTool({ name: 'stardew_status', arguments: {} });
        const text = String((status.content as Array<{ text?: string }>)[0]?.text ?? '');
        assert.match(text, /控制者|控制会话/);
    });
});
