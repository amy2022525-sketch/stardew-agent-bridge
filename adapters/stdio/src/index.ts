#!/usr/bin/env node
/**
 * stdio MCP 适配器。
 *
 * 只做转发：把 stdio 上的 MCP 调用转成对同一个常驻 Bridge 的已认证 HTTP 调用。
 * 因此 stdio 与 HTTP 两个传输共享同一控制权、账本与收据，不存在第二套业务逻辑。
 *
 * 令牌来源：SAB_HOME 下受当前用户保护的 credentials.json（`SAB_TOKEN` 可覆盖）。
 * 令牌绝不来自命令行参数，也不会写进 stdout；stdout 只承载 MCP 消息。
 *
 * 生命周期：只为自己的 session 与在途请求负责。宿主关闭 stdin 或本进程收到
 * SIGTERM/SIGINT 时，只关闭本适配器；常驻 Bridge 继续为其他客户端服务。
 */
import os from 'node:os';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createToolServer, type ToolExecutor, type ToolResult } from '@sab/mcp';
import { BRIDGE_VERSION, getTool } from '@sab/contracts';
import { currentPlatformId, installShutdownHooks, readJsonIfExists, resolveDataRoot } from '@sab/platform';

interface EndpointFile {
    port?: number;
    mcpUrl?: string;
}

function writeStderr(message: string): void {
    process.stderr.write(`${new Date().toISOString()} [stdio-adapter] ${message}\n`);
}

/** 与 Bridge 共用同一套解析规则；相对 SAB_HOME 在 Linux 上直接报错而不是猜测。 */
function dataDir(): string {
    return resolveDataRoot({
        env: process.env,
        platform: currentPlatformId(),
        homeDir: os.homedir(),
        cwd: process.cwd()
    }).path;
}

interface Resolved {
    url: string;
    token: string | null;
    clientId: string;
    dataRoot: string;
    problem: string | null;
}

function resolveClient(): Resolved {
    const clientId = process.env.SAB_CLIENT_ID ?? 'stdio';
    let root: string;
    try {
        root = dataDir();
    } catch (error) {
        return {
            url: 'http://127.0.0.1:17655',
            token: null,
            clientId,
            dataRoot: '',
            problem: error instanceof Error ? error.message : String(error)
        };
    }
    const endpoint = readJsonIfExists<EndpointFile>(path.join(root, 'endpoint.json'));
    const url =
        process.env.SAB_URL ??
        (typeof endpoint?.mcpUrl === 'string' ? endpoint.mcpUrl.replace(/\/mcp$/, '') : 'http://127.0.0.1:17655');
    let token: string | null = process.env.SAB_TOKEN ?? null;
    if (!token) {
        const credentials = readJsonIfExists<{ clients?: Record<string, { token?: string }> }>(
            path.join(root, 'credentials.json')
        );
        const clients = credentials?.clients;
        const entry = clients?.[clientId] ?? null;
        token = typeof entry?.token === 'string' ? entry.token : null;
    }
    return { url, token, clientId, dataRoot: root, problem: null };
}

const executor: ToolExecutor = {
    async executeTool(toolName: string, args: unknown, ctx): Promise<ToolResult> {
        const resolved = resolveClient();
        if (resolved.problem) {
            return {
                isError: true,
                text: `错误 CONFIG_INVALID: ${resolved.problem}\n请把 SAB_HOME 设为绝对路径，或用 stardew-agent-bridge hosts 生成的配置重新导入。`,
                structured: { kind: 'error', fault: { code: 'CONFIG_INVALID', effectKnown: true, nextAction: 'fix_environment' } }
            };
        }
        if (!resolved.token) {
            return {
                isError: true,
                text:
                    `错误 BRIDGE_NOT_RUNNING: 没有找到客户端 ${resolved.clientId} 的本地令牌。\n` +
                    `请先启动 Bridge（npm start 或 stardew-agent-bridge start）以生成数据目录与凭据，` +
                    `或用 stardew-agent-bridge token issue ${resolved.clientId} 创建令牌。\n` +
                    `当前数据根：${resolved.dataRoot}`,
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
                signal: AbortSignal.any([AbortSignal.timeout(readTimeout(toolName)), ...(ctx.signal ? [ctx.signal] : [])]),
                redirect: 'error'
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const tool = getTool(toolName);
            const operation = (args as { operation?: string } | null)?.operation;
            const mayWrite = tool?.kind !== 'read' && !(tool?.kind === 'mixed' && operation === 'list');
            if (mayWrite) return {
                isError: true,
                text: `错误 RESULT_UNKNOWN: Bridge 请求未获得最终响应：${message}。请查询原 actionId 并重新观察，不能自动重放消费动作。`,
                structured: { kind: 'error', fault: { code: 'RESULT_UNKNOWN', effectKnown: false, nextAction: 'query_action' } }
            };
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
    if (resolved.problem) {
        writeStderr(`数据根解析失败：${resolved.problem}`);
    } else if (!resolved.token) {
        writeStderr(`未找到客户端 ${resolved.clientId} 的令牌（数据根 ${resolved.dataRoot}）；工具调用将返回明确错误而不是静默失败。`);
    }
    writeStderr(`已启动，目标 Bridge=${resolved.url} clientId=${resolved.clientId} 数据根=${resolved.dataRoot || '(未确定)'}`);
    const handle = serveStdio(() =>
        createToolServer({
            serverInfo: { name: 'stardew-agent-bridge-stdio', version: BRIDGE_VERSION },
            executor,
            resolveContext: () => ({ clientId: resolved.clientId, clientName: `stdio:${resolved.clientId}`, transport: 'stdio' }),
            logger: (level, message, meta) => writeStderr(`${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`)
        })
    );

    // 只关闭本适配器：常驻 Bridge 与别人的会话不受影响。
    installShutdownHooks({
        name: 'stdio 适配器',
        watchStdin: true,
        log: (line) => writeStderr(line),
        cleanup: async () => {
            await handle.close();
        }
    });
}

main();
