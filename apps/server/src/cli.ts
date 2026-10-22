#!/usr/bin/env node
/**
 * 命令行入口：启动常驻服务、诊断、发令牌、生成宿主配置。
 * 所有输出用中文；错误退出码非 0，便于脚本判断。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, CONTRACTS_SCHEMA_VERSION } from '@sab/contracts';
import { AuthStore, loadConfig } from './config.js';
import { Bridge } from './bridge.js';
import { generateHostConfig, HOST_LABELS, HOST_SUPPORT_MATRIX, type HostId, type TransportMode } from './hosts.js';
import { Logger } from './logger.js';
import { dataPaths, ensureDirs, resolveDataDir } from './paths.js';

interface ParsedArgs {
    command: string;
    rest: string[];
    flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [command = 'help', ...rest] = argv;
    const flags: Record<string, string | boolean> = {};
    const positional: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index]!;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = rest[index + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                index += 1;
            } else {
                flags[key] = true;
            }
        } else {
            positional.push(token);
        }
    }
    return { command, rest: positional, flags };
}

function dataDirFrom(flags: Record<string, string | boolean>): string {
    const value = flags['data-dir'];
    return resolveDataDir(typeof value === 'string' ? value : undefined);
}

const HELP = `Stardew Agent Bridge ${BRIDGE_VERSION}（契约 schema ${CONTRACTS_SCHEMA_VERSION}）

用法：
  stardew-agent-bridge start [--data-dir <路径>] [--port <端口>]
      启动常驻 Bridge（HTTP MCP + Web 控制台）。Ctrl+C 正常退出。
  stardew-agent-bridge doctor [--data-dir <路径>]
      诊断：数据目录、端口、Mod 连接、Web 产物、账本可写性。
  stardew-agent-bridge token <list|issue|rotate|revoke> [clientId]
      管理客户端令牌（令牌只在 issue/rotate 时显示一次）。
  stardew-agent-bridge hosts --host <dsh|codex|claude-code> [--transport http|stdio] [--client-id <id>]
      输出（并写入一个客户端令牌）对应宿主的 MCP 配置片段。
  stardew-agent-bridge matrix
      打印宿主支持矩阵。
  stardew-agent-bridge version
      打印版本。

环境变量：
  SAB_HOME      覆盖数据目录（默认 %LOCALAPPDATA%\\StardewAgentBridge）
  STARDEW_GAME_PATH  构建 Mod 时使用的游戏目录
`;

async function cmdStart(flags: Record<string, string | boolean>): Promise<number> {
    const dataDir = dataDirFrom(flags);
    const paths = dataPaths(dataDir);
    ensureDirs(paths);
    const portFlag = flags.port;
    const configOverride = typeof portFlag === 'string' ? { bridgePort: Number(portFlag) } : {};
    const bridge = new Bridge({ dataDir, configOverride });

    const shutdown = async (signal: string) => {
        bridge.logger.info(`收到 ${signal}，正在停止 Bridge…`);
        await bridge.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    try {
        const port = await bridge.start();
        process.stdout.write(`Stardew Agent Bridge 已启动\n`);
        process.stdout.write(`  Web 控制台：http://127.0.0.1:${port}/\n`);
        process.stdout.write(`  MCP HTTP  ：http://127.0.0.1:${port}/mcp\n`);
        process.stdout.write(`  数据目录  ：${paths.root}\n`);
        process.stdout.write(`  日志      ：${path.join(paths.logs, 'bridge.log')}\n`);
        process.stdout.write(`按 Ctrl+C 停止。\n`);
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('EADDRINUSE')) {
            process.stderr.write(`端口 ${bridge.config.bridgePort} 已被占用。\n`);
            process.stderr.write('可能已有一个 Bridge 在运行：请打开 Web 控制台确认，或用 --port 指定其他端口。\n');
            return 2;
        }
        process.stderr.write(`启动失败：${message}\n`);
        return 1;
    }
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<number> {
    const dataDir = dataDirFrom(flags);
    const paths = dataPaths(dataDir);
    ensureDirs(paths);
    const config = loadConfig(paths);
    const auth = new AuthStore(paths);
    const logger = new Logger({ level: 'warn', paths, console: false });
    const lines: string[] = [];
    lines.push(`Stardew Agent Bridge ${BRIDGE_VERSION}（契约 ${CONTRACTS_SCHEMA_VERSION}）诊断`);
    lines.push(`  数据目录   ：${paths.root}`);
    lines.push(`  配置       ：${paths.config} (bridgePort=${config.bridgePort}, modPort=${config.modPort})`);
    lines.push(`  凭据       ：${existsSync(paths.credentials) ? '已存在（不显示内容）' : '缺失，将自动生成'}`);
    lines.push(`  客户端令牌 ：${auth.listClients().map((entry) => entry.clientId).join(', ') || '（无）'}`);
    lines.push(`  Web 产物   ：${existsSync(path.join(paths.webDist, 'index.html')) ? '已构建' : '缺失（运行 npm run build）'}`);
    lines.push(`  账本       ：${existsSync(paths.ledger) ? '已存在' : '尚未创建（首次启动时创建）'}`);

    const bridge = new Bridge({ dataDir, logger });
    const problems: string[] = [];
    try {
        let port: number;
        try {
            port = await bridge.start();
            lines.push(`  Bridge     ：已在 127.0.0.1:${port} 启动（诊断用临时实例）`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('EADDRINUSE')) {
                lines.push(`  Bridge     ：端口 ${config.bridgePort} 已被占用（很可能已有一个 Bridge 在运行）`);
                const health = await probeHealth(config.bridgePort);
                lines.push(`  健康检查   ：${health ?? '无法访问 /health'}`);
                return 0;
            }
            throw error;
        }
        // 等待 Mod 握手（最多 4 秒）
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline && !bridge.mod.connected) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (bridge.mod.connected) {
            const hello = bridge.mod.hello;
            lines.push(`  Mod 连接   ：已连接 mod=${hello?.modVersion} game=${hello?.gameVersion} smapi=${hello?.smapiVersion}`);
            lines.push(`  存档       ：${hello?.saveLoaded ? '已加载' : '标题页/未加载'}；epoch=${hello?.epoch}`);
        } else {
            lines.push('  Mod 连接   ：未连接');
            problems.push(
                `未连接到游戏 Mod（ws://${config.modHost}:${config.modPort}）。请确认：1) 星露谷通过 SMAPI 启动；2) Mods 目录已安装 StardewAgentBridge；3) 已在 Bridge 启动过一次以生成凭据，然后重进存档。`
            );
        }
        lines.push(`  账本可写   ：${bridge.ledger.writable ? '是' : `否（${bridge.ledger.lastError}）`}`);
        if (!bridge.ledger.writable) problems.push('动作账本不可写：写动作会被拒绝。请检查数据目录权限或删除损坏的 ledger.sqlite 后重启。');
    } finally {
        await bridge.stop();
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (problems.length > 0) {
        process.stdout.write(`\n需要处理：\n${problems.map((item) => `  - ${item}`).join('\n')}\n`);
        return 1;
    }
    process.stdout.write('\n诊断通过。\n');
    return 0;
}

function cmdToken(flags: Record<string, string | boolean>, rest: string[]): number {
    const paths = dataPaths(dataDirFrom(flags));
    ensureDirs(paths);
    const auth = new AuthStore(paths);
    const [action = 'list', clientId] = rest;
    if (action === 'list') {
        const clients = auth.listClients();
        if (clients.length === 0) {
            process.stdout.write('当前没有客户端令牌。用 token issue <clientId> 创建。\n');
            return 0;
        }
        for (const entry of clients) {
            process.stdout.write(`${entry.clientId}\t${entry.clientName}\t创建于 ${entry.createdAt}\n`);
        }
        return 0;
    }
    if (!clientId) {
        process.stderr.write('需要 clientId，例如：token issue codex\n');
        return 1;
    }
    if (action === 'issue') {
        const credential = auth.issue(clientId);
        process.stdout.write(`已创建/复用客户端 ${credential.clientId} 的令牌：\n${credential.token}\n`);
        process.stdout.write('令牌只在本机 credentials.json 保存；请勿提交到仓库或公开分享。\n');
        return 0;
    }
    if (action === 'rotate') {
        const credential = auth.rotate(clientId);
        process.stdout.write(`已轮换 ${credential.clientId} 的令牌：\n${credential.token}\n旧令牌立即失效。\n`);
        return 0;
    }
    if (action === 'revoke') {
        auth.revoke(clientId);
        process.stdout.write(`已吊销客户端 ${clientId} 的令牌。\n`);
        return 0;
    }
    process.stderr.write(`未知 token 操作：${action}\n`);
    return 1;
}

function cmdHosts(flags: Record<string, string | boolean>): number {
    const host = (typeof flags.host === 'string' ? flags.host : 'dsh') as HostId;
    const transport = (typeof flags.transport === 'string' ? flags.transport : 'http') as TransportMode;
    if (!HOST_LABELS[host]) {
        process.stderr.write(`未知宿主：${host}（可选 dsh / codex / claude-code）\n`);
        return 1;
    }
    const paths = dataPaths(dataDirFrom(flags));
    ensureDirs(paths);
    const auth = new AuthStore(paths);
    const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : host;
    const credential = auth.issue(clientId, HOST_LABELS[host]);
    const endpointPort = readEndpointPort(paths.endpoint) ?? loadConfig(paths).bridgePort;
    const snippet = generateHostConfig({
        host,
        transport,
        clientId,
        clientName: HOST_LABELS[host],
        token: credential.token,
        bridgeUrl: `http://127.0.0.1:${endpointPort}/mcp`,
        stdioAdapterPath: path.resolve(process.cwd(), 'adapters', 'stdio', 'dist', 'index.js'),
        nodeExecutable: process.execPath,
        dataDir: paths.root
    });
    process.stdout.write(`# ${HOST_LABELS[host]} / ${transport}\n# 目标位置：${snippet.targetFile}\n\n`);
    process.stdout.write(`${snippet.content}\n\n`);
    for (const note of snippet.notes) process.stdout.write(`# 注意：${note}\n`);
    return 0;
}

function readEndpointPort(file: string): number | null {
    try {
        if (!existsSync(file)) return null;
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { port?: number };
        return typeof raw.port === 'number' ? raw.port : null;
    } catch {
        return null;
    }
}

async function probeHealth(port: number): Promise<string | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return `HTTP ${response.status}`;
        const body = (await response.json()) as Record<string, unknown>;
        return `已运行（版本 ${String(body.bridgeVersion ?? '?')}，游戏连接 ${body.modConnected ? '正常' : '未连接'}）`;
    } catch (error) {
        return `探测失败：${error instanceof Error ? error.message : String(error)}`;
    }
}

function cmdMatrix(): number {
    process.stdout.write('宿主支持矩阵：\n');
    for (const row of HOST_SUPPORT_MATRIX) {
        process.stdout.write(`  ${row.host.padEnd(12)} HTTP=${row.http}  stdio=${row.stdio}  ${row.note}\n`);
    }
    return 0;
}

export async function main(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);
    switch (parsed.command) {
        case 'start':
            return cmdStart(parsed.flags);
        case 'doctor':
            return cmdDoctor(parsed.flags);
        case 'token':
            return cmdToken(parsed.flags, parsed.rest);
        case 'hosts':
            return cmdHosts(parsed.flags);
        case 'matrix':
            return cmdMatrix();
        case 'version':
        case '--version':
            process.stdout.write(`${BRIDGE_VERSION}\n`);
            return 0;
        case 'help':
        case '--help':
        case '-h':
            process.stdout.write(HELP);
            return 0;
        default:
            process.stderr.write(`未知命令：${parsed.command}\n\n${HELP}`);
            return 1;
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
    main(process.argv.slice(2))
        .then((code) => {
            if (code !== 0) process.exitCode = code;
        })
        .catch((error: unknown) => {
            process.stderr.write(`致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
