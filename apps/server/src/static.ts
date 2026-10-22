/**
 * Web 静态文件服务（apps/web/dist）。
 * 只提供打包产物；未知路径回落到 index.html，但不允许路径穿越。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

export interface StaticResult {
    served: boolean;
    status: number;
}

export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse): StaticResult {
    const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const normalized = path.normalize(relative).replace(/^([.][.][/\\])+/, '');
    const candidate = path.join(rootDir, normalized);
    const resolved = path.resolve(candidate);
    const rootResolved = path.resolve(rootDir);
    if (!resolved.startsWith(rootResolved)) {
        return { served: false, status: 403 };
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        const index = path.join(rootResolved, 'index.html');
        if (existsSync(index)) {
            sendFile(index, res);
            return { served: true, status: 200 };
        }
        return { served: false, status: 404 };
    }
    sendFile(resolved, res);
    return { served: true, status: 200 };
}

function sendFile(file: string, res: ServerResponse): void {
    const extension = path.extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
    res.setHeader('cache-control', extension === '.html' ? 'no-store' : 'public, max-age=60');
    res.setHeader('x-content-type-options', 'nosniff');
    createReadStream(file).pipe(res);
}
