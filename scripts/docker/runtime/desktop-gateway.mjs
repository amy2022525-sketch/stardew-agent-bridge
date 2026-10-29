#!/usr/bin/env node
/** Restricted noVNC HTTP/WebSocket entrance; the VNC password exchange remains end-to-end RFB. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function createDesktopGateway({ publicPort, listenPort = 6080, upstreamPort = 6081, host = '0.0.0.0' }) {
    const hosts = new Set([`localhost:${publicPort}`, `127.0.0.1:${publicPort}`]);
    const origins = new Set([...hosts].map(host => `http://${host}`));
    const allowed = (req, upgrade = false) => {
        const raw = req.rawHeaders.filter((_, i) => i % 2 === 0).map(key => key.toLowerCase());
        return raw.filter(key => key === 'host').length === 1 && raw.filter(key => key === 'origin').length <= 1 &&
            hosts.has(req.headers.host) && (req.headers.origin ? origins.has(req.headers.origin) : !upgrade) &&
            req.headers['sec-fetch-site'] !== 'cross-site' && req.url?.startsWith('/') && !req.url.startsWith('//') && ['GET', 'HEAD'].includes(req.method);
    };
    const sockets = new Set();
    const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
        if (!allowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
        const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: { host: `127.0.0.1:${upstreamPort}` }, timeout: 5000 }, reply => {
            res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        upstream.on('timeout', () => upstream.destroy());
        res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
        upstream.end();
    });
    server.headersTimeout = 10_000; server.requestTimeout = 10_000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => {
        if (!allowed(req, true)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: 'GET', path: req.url,
            headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` }, timeout: 5000 });
        upstream.on('upgrade', (res, peer, peerHead) => {
            peer.setTimeout(0);
            const headers = res.rawHeaders.reduce((text, value, i, all) => i % 2 === 0 ? text + `${value}: ${all[i + 1]}\r\n` : text, '');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
            if (peerHead.length) socket.write(peerHead);
            if (head.length) peer.write(head);
            peer.pipe(socket); socket.pipe(peer);
            peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
            socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
        });
        upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy());
        upstream.on('timeout', () => upstream.destroy()); upstream.end();
    });
    return { server, start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, host, () => resolve(server.address().port)); }),
        stop: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(resolve); }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.SAB_NOVNC_PORT ?? 6080);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) process.exitCode = 10;
    else { const gateway = createDesktopGateway({ publicPort: port }); gateway.start().catch(() => { process.exitCode = 16; });
        const stop = () => void gateway.stop(); process.on('SIGTERM', stop); process.on('SIGINT', stop); }
}
