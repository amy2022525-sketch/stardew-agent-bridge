import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

const { createDesktopGateway } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/docker/runtime/desktop-gateway.mjs')).href) as {
    createDesktopGateway(input: { publicPort: number; listenPort: number; upstreamPort: number; host: string }): { start(): Promise<number>; stop(): Promise<void> };
};

async function fixture() {
    const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('noVNC fixture'); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on('connection', socket => socket.on('message', data => socket.send(data)));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const gateway = createDesktopGateway({ publicPort: 6080, listenPort: 0, upstreamPort: (upstream.address() as AddressInfo).port, host: '127.0.0.1' });
    const port = await gateway.start();
    return { port, gateway, stop: async () => { await gateway.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())); wss.close(); } };
}

function http(port: number, headers: Record<string, string>, method = 'GET'): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path: '/vnc.html', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject); req.end();
    });
}
function websocket(port: number, origin?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify`, { headers: { host: '127.0.0.1:6080', ...(origin ? { origin } : {}) } });
        ws.once('open', () => resolve(ws)); ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); reject(new Error(String(res.statusCode))); });
    });
}
describe('Docker desktop gateway real HTTP/WebSocket', () => {
    it('allows local desktop pages and rejects foreign Host, Origin, Fetch Metadata and writes', async () => {
        const f = await fixture();
        try {
            assert.equal(await http(f.port, { host: '127.0.0.1:6080' }), 200);
            assert.equal(await http(f.port, { host: 'evil.example:6080' }), 403);
            assert.equal(await http(f.port, { host: '127.0.0.1:6080', origin: 'https://evil.example' }), 403);
            assert.equal(await http(f.port, { host: '127.0.0.1:6080', 'sec-fetch-site': 'cross-site' }), 403);
            assert.equal(await http(f.port, { host: '127.0.0.1:6080' }, 'POST'), 403);
        } finally { await f.stop(); }
    });
    it('requires a matching Origin on upgrades and preserves the binary desktop stream', async () => {
        const f = await fixture(); let ws: WebSocket | undefined;
        try {
            await assert.rejects(websocket(f.port), /403/);
            await assert.rejects(websocket(f.port, 'http://evil.example:6080'), /403/);
            ws = await websocket(f.port, 'http://127.0.0.1:6080');
            const reply = new Promise<Buffer>(resolve => ws!.once('message', data => resolve(Buffer.from(data as Buffer))));
            ws.send(Buffer.from([0, 1, 2, 255]));
            assert.deepEqual(await reply, Buffer.from([0, 1, 2, 255]));
        } finally { ws?.terminate(); await f.stop(); }
    });
    it('shutdown closes upgraded sockets without waiting indefinitely for a browser', async () => {
        const f = await fixture();
        const ws = await websocket(f.port, 'http://localhost:6080');
        const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
        try { await f.gateway.stop(); await closed; assert.equal(ws.readyState, WebSocket.CLOSED); }
        finally { ws.terminate(); await f.stop(); }
    });
});
