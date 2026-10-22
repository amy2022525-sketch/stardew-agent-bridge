/**
 * node:http ↔ Web 标准 Request/Response 适配（MCP HTTP 传输与 Web API 共用）。
 * 自己实现是为了避免额外依赖，同时完整支持 SSE 流式响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function toWebRequest(req: IncomingMessage, body?: Buffer): Request {
    const host = req.headers.host ?? '127.0.0.1';
    const url = `http://${host}${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
        } else {
            headers.set(key, value);
        }
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const init: RequestInit & { duplex?: 'half' } = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
        init.body = body && body.length > 0 ? body : Readable.toWeb(req);
        init.duplex = 'half';
    }
    return new Request(url, init);
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
    res.statusCode = response.status;
    if (response.statusText) res.statusMessage = response.statusText;
    response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        res.setHeader(key, value);
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length > 0) res.setHeader('set-cookie', cookies);
    if (!response.body) {
        res.end();
        return;
    }
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await new Promise<void>((resolve, reject) => {
        stream.on('error', (error) => {
            res.destroy(error as Error);
            reject(error);
        });
        res.on('close', () => resolve());
        stream.pipe(res);
        res.on('finish', () => resolve());
    });
}

/** 读取请求体，超过上限立刻拒绝（不把超大请求解析进内存）。 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.length;
        if (total > limit) {
            throw Object.assign(new Error(`请求体超过 ${limit} 字节上限`), { code: 'BODY_TOO_LARGE' });
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders?: Record<string, string>): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
    }
    res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
    res.statusCode = status;
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-store');
    res.end(text);
}

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

export function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
}

export function isLoopback(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
