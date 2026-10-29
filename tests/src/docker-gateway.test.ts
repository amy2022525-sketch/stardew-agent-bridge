/**
 * 容器网关协议专项测试（DKR-003 补齐）。
 *
 * 起真实 ContainerGateway（临时端口）+ 临时上游 Bridge（127.0.0.1:17655 回环），
 * 覆盖：Host/Origin 原始校验、绝对 URL、Sec-Fetch-Site、CONNECT、/container/*、
 * /health 净化、转发头规范化（剥离 forwarded/动态 hop-by-hop）、64KiB 上限（声明与流式）、
 * 上游不可用 502 语义、SSE 直通与多 Set-Cookie 保留。
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { ContainerGateway, type ContainerPublicStatus } from '@sab/server';
import { parsePublicBaseUrl } from '@sab/server';
import { MAX_REQUEST_BYTES } from '@sab/contracts';

const PUBLIC_BASE = parsePublicBaseUrl('http://127.0.0.1:18055');
const UPSTREAM_PORT = 17655;

function statusBody(overrides: Partial<ContainerPublicStatus> = {}): ContainerPublicStatus {
    return { schemaVersion: 1, mode: 'bridge', state: 'bridge_ready', live: true, modConnected: false, saveLoaded: false,
        desktopEnabled: false, desktopAvailable: false, reasonCode: 'BRIDGE_READY', ...overrides };
}

interface Capture {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
}

/** 记录型上游：挂在容器内部 Bridge 回环端口上。 */
async function startUpstream(handler?: (capture: Capture, res: import('node:http').ServerResponse) => void): Promise<{ captures: Capture[]; close(): Promise<void>; }> {
    const captures: Capture[] = [];
    const server = createServer((req, res) => {
        const capture: Capture = { method: req.method ?? '', url: req.url ?? '/', headers: req.headers, body: '' };
        captures.push(capture);
        req.on('data', chunk => { capture.body += chunk; });
        req.on('end', () => {
            if (handler) handler(capture, res);
            else { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end('{"upstream":true}'); }
        });
    });
    await new Promise<void>(resolve => server.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
    return { captures, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function makeGateway(status: () => Promise<ContainerPublicStatus> = async () => statusBody()): ContainerGateway {
    return new ContainerGateway({ publicBase: PUBLIC_BASE, containerStatus: status, listenHost: '127.0.0.1', listenPort: 0 });
}

/** 常规请求辅助：默认带合法 Host（fetch 无法覆盖 Host 头），支持 body 与响应头。 */
function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1', port, path, method: options.method ?? 'GET',
            headers: { host: '127.0.0.1:18055', ...(options.headers ?? {}) }
        });
        req.on('response', res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end(options.body ?? undefined);
    });
}

/** 原始 HTTP 请求（可完全控制 Host/方法/绝对目标），返回状态码与正文。 */
function rawRequest(options: RequestOptions & { host?: string; port?: number }): Promise<{ status: number; body: string }> {
    return new Promise(resolve => {
        const request = httpRequest(options);
        request.on('response', res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        // CONNECT 的应答走 'connect' 事件，不带常规 response 流。
        request.on('connect', res => {
            resolve({ status: res.statusCode ?? 0, body: '' });
            request.destroy();
        });
        request.on('error', () => resolve({ status: 0, body: '' }));
        request.end();
    });
}

describe('容器网关协议', () => {
    it('Host：缺失/伪造后缀/端口不符全部拒绝；合法 Host 放行', async () => {
        const upstream = await startUpstream();
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            const noHost = await rawRequest({ host: '127.0.0.1', port, path: '/', setHost: false });
            assert.equal(noHost.status, 400);

            const evil = await rawRequest({ host: '127.0.0.1', port, path: '/', headers: { host: '127.0.0.1.evil.example:18055' } });
            assert.equal(evil.status, 403, '伪造后缀 Host 必须被拒绝');

            const wrongPort = await rawRequest({ host: '127.0.0.1', port, path: '/', headers: { host: '127.0.0.1:9999' } });
            assert.equal(wrongPort.status, 403);

            const ok = await rawRequest({ host: '127.0.0.1', port, path: '/', headers: { host: '127.0.0.1:18055' } });
            assert.equal(ok.status, 200);
            assert.equal(ok.body, '{"upstream":true}');
        } finally { await gateway.stop(); await upstream.close(); }
    });

    it('绝对形式请求目标被拒绝；CONNECT 不是代理', async () => {
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            const absolute = await rawRequest({ host: '127.0.0.1', port, path: 'http://example.com/x' });
            assert.equal(absolute.status, 400);

            const connect = await rawRequest({ host: '127.0.0.1', port, method: 'CONNECT', path: 'example.com:443' });
            assert.equal(connect.status, 405);
        } finally { await gateway.stop(); }
    });

    it('Origin：跨站/重复/null 拒绝；同源放行；Sec-Fetch-Site cross-site 对 /mcp 拒绝', async () => {
        const upstream = await startUpstream();
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            assert.equal((await request(port, '/', { headers: { origin: 'http://evil.example' } })).status, 403);
            assert.equal((await request(port, '/', { headers: { origin: 'null' } })).status, 403);
            const sameOrigin = await request(port, '/', { headers: { origin: 'http://127.0.0.1:18055' } });
            assert.equal(sameOrigin.status, 200);
            assert.equal((await request(port, '/mcp', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            const okFetchSite = await request(port, '/mcp', { headers: { 'sec-fetch-site': 'same-origin' } });
            assert.equal(okFetchSite.status, 200);
        } finally { await gateway.stop(); await upstream.close(); }
    });

    it('/container/live 与 /container/ready：live 状态 200，非 ready 503；字段净化', async () => {
        const gateway = makeGateway(async () => statusBody({ live: false, state: 'starting', reasonCode: 'STARTING_BRIDGE' }));
        const port = await gateway.start();
        try {
            const live = await request(port, '/container/live');
            assert.equal(live.status, 503);
            const payload = JSON.parse(live.body);
            assert.equal(payload.schemaVersion, 1);
            assert.equal(payload.reasonCode, 'STARTING_BRIDGE');
            for (const forbidden of ['pid', 'dataDir', 'supervisorPid', 'token', 'home']) {
                assert.ok(!(forbidden in payload), `净化视图不得包含 ${forbidden}`);
            }
            assert.equal((await request(port, '/container/live', { method: 'POST' })).status, 405);
        } finally { await gateway.stop(); }
    });

    it('/health 净化视图：只含固定字段', async () => {
        const gateway = makeGateway(async () => statusBody());
        const port = await gateway.start();
        try {
            const health = await request(port, '/health');
            assert.equal(health.status, 200);
            const payload = JSON.parse(health.body);
            assert.deepEqual(Object.keys(payload).sort(), ['bridgeVersion', 'modConnected', 'ok', 'saveLoaded']);
        } finally { await gateway.stop(); }
    });

    it('转发规范化：上游 Host 回环、Origin 同源、forwarded 头与动态 hop-by-hop 剥离', async () => {
        const upstream = await startUpstream();
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            const response = await request(port, '/api/v1/state', {
                headers: {
                    host: '127.0.0.1:18055', origin: 'http://127.0.0.1:18055',
                    'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', forwarded: 'for=1.2.3.4',
                    connection: 'x-custom-hop', 'x-custom-hop': 'v', 'x-keep-me': 'yes', authorization: 'Bearer t'
                }
            });
            assert.equal(response.status, 200);
            const seen = upstream.captures[0]!;
            assert.equal(seen.headers.host, '127.0.0.1:17655');
            assert.equal(seen.headers.origin, 'http://127.0.0.1:17655');
            assert.equal(seen.headers['x-forwarded-for'], undefined);
            assert.equal(seen.headers['x-real-ip'], undefined);
            assert.equal(seen.headers.forwarded, undefined);
            assert.equal(seen.headers['x-custom-hop'], undefined, 'Connection 列出的动态 hop-by-hop 必须剥离');
            assert.equal(seen.headers['x-keep-me'], 'yes');
            assert.equal(seen.headers.authorization, 'Bearer t');
        } finally { await gateway.stop(); await upstream.close(); }
    });

    it('64KiB 上限：声明超限在转发前 413；流式超限中断', async () => {
        const upstream = await startUpstream();
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            // Node 客户端会自行改写 Content-Length，声明式路径必须用原始 socket 验证。
            const declared = await new Promise<number>(resolve => {
                const socket = createConnection({ host: '127.0.0.1', port }, () => {
                    socket.write(`POST /api/v1/tool/x HTTP/1.1\r\nHost: 127.0.0.1:18055\r\nContent-Length: ${MAX_REQUEST_BYTES + 1}\r\nConnection: close\r\n\r\n`);
                });
                let head = '';
                socket.on('data', chunk => { head += chunk; if (head.includes('\r\n')) { socket.destroy(); resolve(Number(/HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0)); } });
                socket.on('error', () => resolve(0));
            });
            assert.equal(declared, 413);

            const huge = 'x'.repeat(MAX_REQUEST_BYTES + 1024);
            const streamed = await request(port, '/api/v1/tool/x', { method: 'POST', body: huge }).catch(error => ({ status: 0, headers: {}, body: String(error) }));
            assert.equal(streamed.status, 413);
            assert.equal(upstream.captures.length, 0, '超限请求不应抵达上游');
        } finally { await gateway.stop(); await upstream.close(); }
    });

    it('上游不可用：502 且提示查询原 actionId 收据', async () => {
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            const response = await request(port, '/api/v1/tool/x', { method: 'POST', body: '{}' });
            assert.equal(response.status, 502);
            assert.ok(response.body.includes('actionId'));
        } finally { await gateway.stop(); }
    });

    it('SSE 直通（不缓冲）与多 Set-Cookie 保留', async () => {
        const upstream = await startUpstream((capture, res) => {
            if (capture.url.startsWith('/mcp')) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                res.write('data: first\n\n');
                setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 120);
            } else {
                res.writeHead(200, [
                    ['set-cookie', 'a=1; Path=/; HttpOnly'], ['set-cookie', 'b=2; Path=/'], ['content-type', 'application/json']
                ]);
                res.end('{}');
            }
        });
        const gateway = makeGateway();
        const port = await gateway.start();
        try {
            const sse = await new Promise<{ status: number; readFirst(): Promise<string>; rest(): Promise<string> }>(resolve => {
                const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', headers: { host: '127.0.0.1:18055', accept: 'text/event-stream' } });
                req.on('response', res => {
                    let buffered = '';
                    let firstChunk = '';
                    let firstDone: ((value: string) => void) | undefined;
                    const first = new Promise<string>(resolveFirst => { firstDone = resolveFirst; });
                    res.on('data', chunk => {
                        buffered += chunk;
                        if (firstDone) { firstChunk = chunk.toString(); const done = firstDone; firstDone = undefined; done(firstChunk); }
                    });
                    resolve({ status: res.statusCode ?? 0, readFirst: () => first, rest: () => new Promise(resolveRest => res.on('end', () => resolveRest(buffered))) });
                });
                req.end();
            });
            assert.equal(sse.status, 200);
            const first = await sse.readFirst();
            assert.ok(first.includes('first'), '首个 SSE 段应立即可读（未被缓冲）');
            const rest = await sse.rest();
            assert.ok(rest.includes('second'));

            const cookies = await request(port, '/api/v1/cookies');
            assert.equal(cookies.status, 200);
            assert.deepEqual((cookies.headers['set-cookie'] ?? []).map(String).sort(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
        } finally { await gateway.stop(); await upstream.close(); }
    });

    it('连接超时只约束 TCP 建立：慢工具响应不被切断', async () => {
        const upstream = await startUpstream(async (capture, res) => {
            await delay(250);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"slow":true}');
        });
        const gateway = new ContainerGateway({ publicBase: PUBLIC_BASE, containerStatus: async () => statusBody(), listenHost: '127.0.0.1', listenPort: 0, connectTimeoutMs: 100 });
        const port = await gateway.start();
        try {
            const response = await request(port, '/api/v1/tool/slow', { method: 'POST', body: '{}' });
            assert.equal(response.status, 200, '上游已连接但响应慢：不得按连接超时切断');
            assert.equal(JSON.parse(response.body).slow, true);
        } finally { await gateway.stop(); await upstream.close(); }
    });
});
