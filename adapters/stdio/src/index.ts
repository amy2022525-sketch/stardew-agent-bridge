#!/usr/bin/env node
/**
 * stdio MCP 适配器。
 *
 * 只做转发：把 stdio 上的 MCP 调用转成对同一个常驻 Bridge 的已认证 HTTP 调用。
 * 因此 stdio 与 HTTP 两个传输共享同一控制权、账本与收据，不存在第二套业务逻辑。
 *
 * 令牌来源：SAB_HOME 下受当前用户保护的 credentials.json（`SAB_TOKEN` 可覆盖）。
 * 令牌绝不来自命令行参数，也不会写进 stdout；stdout 只承载 MCP 消息。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createToolServer, type ToolExecutor, type ToolResult } from '@sab/mcp';

interface EndpointFile {
    port?: number;
    mcpUrl?: string;
}

function writeStderr(message: string): void {
    process.stderr.write(`${new Date().toISOString()} [stdio-adapter] ${message}\n`);
}

function dataDir(): string {
    const override = process.env.SAB_HOME;
    if (override && override.trim().length > 0) return path.resolve(override);
    const base = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.length > 0
        ? process.env.LOCALAPPDATA
        : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'StardewAgentBridge');
}

function readJson(file: string): Record<string, unknown> | null {
    try {
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

interface Resolved {
    url: string;
    token: string | null;
    clientId: string;
}

function resolveClient(): Resolved {
    const root = dataDir();
    const clientId = process.env.SAB_CLIENT_ID ?? 'stdio';
    const endpoint = readJson(path.join(root, 'endpoint.json')) as EndpointFile | null;
    const url =
        process.env.SAB_URL ??
        (endpoint?.mcpUrl ? endpoint.mcpUrl.replace(/\/mcp$/, '') : `http://127.0.0.1:17655`);
    let token: string | null = process.env.SAB_TOKEN ?? null;
    if (!token) {
        const credentials = readJson(path.join(root, 'credentials.json'));
        const clients = credentials?.['clients'] as Record<string, { token?: string }> | undefined;
        const entry = clients?.[clientId] ?? clients?.['stdio'] ?? null;
        token = typeof entry?.token === 'string' ? entry.token : null;
    }
    return { url, token, clientId };
}

const executor: ToolExecutor = {
    async executeTool(toolName: string, args: unknown, ctx): Promise<ToolResult> {
        const resolved = resolveClient();
        if (!resolved.token) {
            return {
                isError: true,
                text:
                    `错误 BRIDGE_NOT_RUNNING: 没有找到客户端 ${resolved.clientId} 的本地令牌。\n` +
                    `请先启动 Bridge（npm start 或 stardew-agent-bridge start）以生成数据目录与凭据，` +
                    `或用 stardew-agent-bridge token issue ${resolved.clientId} 创建令牌。`,
                structured: { kind: 'error', fault: { code: 'BRIDGE_NOT_RUNNING', effectKnown: true, nextAction: 'fix_environment' } }
            };
        }
        let response: Response;
        try {
            response = await fetch(`${resolved.url}/api/v1/tool/${encodeURIComponent(toolName)}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${resolved.token}`
                },
                body: JSON.stringify(args ?? {}),
                signal: AbortSignal.timeout(readTimeout(toolName))
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                text:
                    `错误 BRIDGE_NOT_RUNNING: 无法连接本地 Bridge（${resolved.url}）：${message}\n` +
                    '请启动 Stardew Agent Bridge 常驻服务后重试；这与游戏是否运行无关。',
                structured: { kind: 'error', fault: { code: 'BRIDGE_NOT_RUNNING', effectKnown: true, nextAction: 'fix_environment' } }
            };
        }
        if (response.status === 401 || response.status === 403) {
            return {
                isError: true,
                text:
                    `错误 AUTH_FAILED: Bridge 拒绝了客户端 ${resolved.clientId} 的令牌。\n` +
                    `请用 stardew-agent-bridge token rotate ${resolved.clientId} 轮换，并更新宿主配置。`,
                structured: { kind: 'error', fault: { code: 'AUTH_FAILED', effectKnown: true, nextAction: 'fix_environment' } }
            };
        }
        if (!response.ok) {
            return {
                isError: true,
                text: `错误 INTERNAL_ERROR: Bridge 返回 HTTP ${response.status}。请查看 Bridge 日志。`,
                structured: { kind: 'error', fault: { code: 'INTERNAL_ERROR', effectKnown: false, nextAction: 'query_action' } }
            };
        }
        const payload = (await response.json()) as ToolResult;
        return {
            isError: payload.isError === true,
            text: typeof payload.text === 'string' ? payload.text : '(空结果)',
            structured: payload.structured,
            image: payload.image
        };
    }
};

function readTimeout(toolName: string): number {
    if (toolName === 'stardew_fish') return 75_000;
    if (toolName === 'stardew_load') return 140_000;
    if (toolName === 'stardew_move') return 45_000;
    return 35_000;
}

function main(): void {
    const resolved = resolveClient();
    if (!resolved.token) {
        writeStderr(`未找到客户端 ${resolved.clientId} 的令牌；工具调用将返回明确错误而不是静默失败。`);
    }
    writeStderr(`已启动，目标 Bridge=${resolved.url} clientId=${resolved.clientId}`);
    const handle = serveStdio(() =>
        createToolServer({
            serverInfo: { name: 'stardew-agent-bridge-stdio', version: '0.1.0' },
            executor,
            resolveContext: () => ({ clientId: resolved.clientId, clientName: `stdio:${resolved.clientId}`, transport: 'stdio' }),
            logger: (level, message, meta) => writeStderr(`${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`)
        })
    );
    process.on('SIGINT', () => {
        void handle.close().then(() => process.exit(0));
    });
}

main();
