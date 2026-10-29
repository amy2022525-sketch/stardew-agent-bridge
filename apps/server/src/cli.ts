#!/usr/bin/env node
/**
 * 命令行入口：启动/复用常驻服务、只读诊断、发令牌、生成宿主配置、安装桌面入口。
 *
 * 所有输出用中文；退出码约定：
 *   0 成功；1 环境/验证/执行失败；2 端口或实例冲突；3 需要人工恢复的 Mod 安装事务。
 * JSON 输出使用稳定问题码（PATH_INVALID、DATA_ROOT_MISMATCH、INSTANCE_CONFLICT…），
 * 它们是 CLI 诊断码，不是游戏/MCP 错误协议的一部分。
 */
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, CONTRACTS_SCHEMA_VERSION } from '@sab/contracts';
import {
    NODE_MINIMUM_VERSION,
    assertDedicatedRoot,
    checkNodeVersion,
    currentPlatformId,
    installDesktopEntry,
    probeSqliteSupport,
    readJsonIfExists,
    removeDesktopEntry,
    type InstallDesktopEntryResult,
    type RemoveDesktopEntryResult,
    type ResolvedDataRoot
} from '@sab/platform';
import { AuthStore, loadConfig } from './config.js';
import { Bridge } from './bridge.js';
import { generateHostConfig, HOST_LABELS, HOST_SUPPORT_MATRIX, type HostId, type TransportMode } from './hosts.js';
import { acquireInstanceLock, isInstanceLockStale, readInstanceLock } from './instance-lock.js';
import { launchBridge, probeHealth, readEndpoint, type LaunchResult } from './launch.js';
import { Logger } from './logger.js';
import { compareModDataDirectory, listBridgeModDirs, locateModConfigs } from './mod-config.js';
import {
    dataPaths,
    ensureDirs,
    legacyDataRootReport,
    resolveDataRootDescriptor,
    resolveStdioAdapter,
    type DataPaths
} from './paths.js';

type FlagValue = string | boolean;

interface ParsedArgs {
    command: string;
    rest: string[];
    flags: Record<string, FlagValue>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [command = 'help', ...rest] = argv;
    const flags: Record<string, FlagValue> = {};
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

function stringFlag(flags: Record<string, FlagValue>, key: string): string | undefined {
    const value = flags[key];
    return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: Record<string, FlagValue>, key: string): number | undefined {
    const value = stringFlag(flags, key);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function boolFlag(flags: Record<string, FlagValue>, key: string): boolean {
    return flags[key] === true || flags[key] === 'true';
}

const HELP = `Stardew Agent Bridge ${BRIDGE_VERSION}（契约 schema ${CONTRACTS_SCHEMA_VERSION}）

用法：
  stardew-agent-bridge start [--data-dir <路径>] [--port <端口>]
      启动常驻 Bridge（HTTP MCP + Web 控制台）。Ctrl+C 正常退出。
      Windows 与 Linux 通用；同一数据根只允许一个实例。
  stardew-agent-bridge launch [--data-dir <路径>] [--port <端口>] [--no-open]
      启动或复用唯一的 Bridge，等它就绪后打开 Web 控制台（默认打开实际地址）。
  stardew-agent-bridge doctor [--data-dir <路径>] [--json] [--game-path <游戏目录>]
      只读诊断：数据根与来源、运行时、实例、Mod 配置一致性、Web 产物、账本。
      已有实例时通过只读接口查询；离线时不恢复真实账本、不创建凭据。
  stardew-agent-bridge token <list|issue|rotate|revoke> [clientId]
      管理客户端令牌（令牌只在 issue/rotate 时显示一次）。
  stardew-agent-bridge hosts --host <dsh|codex|claude-code|generic> [--transport http|stdio] [--client-id <id>]
      输出（并写入一个客户端令牌）对应宿主的 MCP 配置片段。
  stardew-agent-bridge desktop <install|remove> [--desktop-shortcut] [--data-dir <路径>]
      安装/移除用户菜单入口（只写本项目自己的文件，不删数据）。
  stardew-agent-bridge matrix
      打印宿主支持矩阵。
  stardew-agent-bridge version
      打印版本。

环境变量：
  SAB_HOME           覆盖数据目录（Linux 上必须是绝对路径）
  STARDEW_GAME_PATH  构建 Mod 时使用的游戏目录（Linux 上也用于诊断 Mod 配置）
  XDG_DATA_HOME      Linux 默认数据根（绝对路径时生效）
`;

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function cmdStart(flags: Record<string, FlagValue>): Promise<number> {
    const runtime = checkNodeVersion(process.version, NODE_MINIMUM_VERSION);
    if (!runtime.ok) {
        process.stderr.write(`${runtime.message}\n`);
        return 1;
    }
    const sqlite = await probeSqliteSupport();
    if (!sqlite.ok) {
        process.stderr.write(`${sqlite.message}\n`);
        return 1;
    }

    let descriptor: ResolvedDataRoot;
    try {
        descriptor = resolveDataRootDescriptor(stringFlag(flags, 'data-dir'));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    const paths = dataPaths(descriptor.path);
    try {
        assertDedicatedRoot(paths.root, { homeDir: os.homedir(), platform: currentPlatformId() });
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    ensureDirs(paths);
    for (const note of legacyDataRootReport(paths).notes) process.stderr.write(`提示：${note}\n`);

    // 重要：先取得该数据根的启动所有权，再构造 Bridge（= 再碰账本与会话记录）。
    const lock = acquireInstanceLock({
        lockPath: paths.lock,
        dataRoot: paths.root,
        programVersion: BRIDGE_VERSION,
        entry: process.argv[1] ?? '',
        deps: { platform: currentPlatformId() }
    });
    if (!lock.acquired) {
        process.stderr.write(`${lock.message}\n`);
        if (lock.record) {
            const health = await probeHealth(readEndpoint(paths.endpoint)?.port ?? loadConfigPort(paths), {
                platform: currentPlatformId(),
                env: process.env,
                homeDir: os.homedir(),
                cwd: process.cwd(),
                execPath: process.execPath,
                cliEntry: fileURLToPath(import.meta.url)
            });
            if (health) process.stderr.write(`该实例健康：http://127.0.0.1:${health.port}/（modConnected=${health.modConnected}）\n`);
        }
        return 2;
    }

    const portFlag = numberFlag(flags, 'port');
    const configOverride = portFlag === undefined ? {} : { bridgePort: portFlag };
    let bridge: Bridge | null = null;
    let reservedServer: Server | null = null;
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
        try {
            await bridge?.stop();
            if (!bridge && reservedServer) await new Promise<void>(resolve => reservedServer!.close(() => resolve()));
        } finally {
            lock.handle.release();
        }
    };

    const onSignal = (signal: string): void => {
        process.stdout.write(`收到 ${signal}，正在停止 Bridge…\n`);
        void cleanup().then(() => process.exit(0));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('exit', () => {
        // 兜底：正常退出路径也要释放本次持有的锁。
        if (!cleaned) {
            cleaned = true;
            try {
                lock.handle.release();
            } catch {
                /* 忽略 */
            }
        }
    });

    try {
        const desiredPort = portFlag ?? (existsSync(paths.config) ? loadConfig(paths).bridgePort : 17655);
        if (!Number.isInteger(desiredPort) || desiredPort < 1024 || desiredPort > 65535) throw new Error('端口必须是1024至65535的整数。');
        reservedServer = createServer();
        await new Promise<void>((resolve, reject) => {
            reservedServer!.once('error', reject);
            reservedServer!.listen(desiredPort, '127.0.0.1', resolve);
        });
        bridge = new Bridge({ dataDir: descriptor.path, configOverride, httpServer: reservedServer });
        const port = await bridge.start();
        // 容器模式下 config.json 的 publicBaseUrl 已由 Bridge 严格校验；
        // 有公共地址时展示给用户的是宿主映射地址，内部监听仍是回环。
        const publicBase = bridge.config.publicBaseUrl;
        process.stdout.write('Stardew Agent Bridge 已启动\n');
        if (publicBase) {
            process.stdout.write(`  Web 控制台（外部）：${publicBase}/\n`);
            process.stdout.write(`  MCP HTTP（外部）  ：${publicBase}/mcp\n`);
            process.stdout.write(`  内部监听          ：http://127.0.0.1:${port}/（容器内回环）\n`);
        } else {
            process.stdout.write(`  Web 控制台：http://127.0.0.1:${port}/\n`);
            process.stdout.write(`  MCP HTTP  ：http://127.0.0.1:${port}/mcp\n`);
        }
        process.stdout.write(`  数据目录  ：${paths.root}（来源 ${descriptor.source}）\n`);
        process.stdout.write(`  日志      ：${path.join(paths.logs, 'bridge.log')}\n`);
        process.stdout.write(`  实例锁    ：${paths.lock}\n`);
        process.stdout.write('按 Ctrl+C 停止。\n');
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await cleanup();
        if (message.includes('EADDRINUSE')) {
            process.stderr.write(`端口 ${bridge?.config.bridgePort ?? portFlag ?? ''} 已被占用。\n`);
            process.stderr.write('若这是本应用的另一个实例，请用 launch 复用它；否则用 --port 指定其他端口。\n');
            return 2;
        }
        process.stderr.write(`启动失败：${message}\n`);
        return 1;
    }
}

function loadConfigPort(paths: DataPaths): number {
    try {
        return loadConfig(paths).bridgePort;
    } catch {
        return 17655;
    }
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

function depsForLaunch(): Parameters<typeof launchBridge>[1] {
    return {
        platform: currentPlatformId(),
        env: process.env,
        homeDir: os.homedir(),
        cwd: process.cwd(),
        execPath: process.execPath,
        cliEntry: fileURLToPath(import.meta.url),
        log: (line: string) => process.stdout.write(`${line}\n`)
    };
}

async function cmdLaunch(flags: Record<string, FlagValue>): Promise<number> {
    const json = boolFlag(flags, 'json');
    const launchDeps = depsForLaunch();
    if (json) launchDeps.log = line => process.stderr.write(`${line}\n`);
    const result: LaunchResult = await launchBridge(
        {
            dataDir: stringFlag(flags, 'data-dir'),
            port: numberFlag(flags, 'port'),
            open: boolFlag(flags, 'no-open') ? false : true,
            programVersion: BRIDGE_VERSION
        },
        launchDeps
    );

    if (json) {
        process.stdout.write(`${JSON.stringify({ ...result, ok: result.code === 0 }, null, 2)}\n`);
        return result.code;
    }
    if (result.code !== 0) {
        process.stderr.write('启动或复用 Bridge 失败。\n');
        process.stderr.write(`  数据目录：${result.dataRoot}（来源 ${result.dataRootSource}）\n`);
        for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
        if (result.problemCode) process.stderr.write(`  问题码：${result.problemCode}\n`);
        return result.code;
    }
    process.stdout.write(`${result.reused ? '已复用' : '已启动'} Stardew Agent Bridge\n`);
    process.stdout.write(`  Web 控制台：${result.url}\n`);
    process.stdout.write(`  数据目录  ：${result.dataRoot}（来源 ${result.dataRootSource}）\n`);
    process.stdout.write(`  浏览器    ：${result.browserOpened ? '已打开默认浏览器' : result.browserError ?? '未打开（见下方说明）'}\n`);
    for (const note of result.problems) process.stdout.write(`  - ${note}\n`);
    return 0;
}

// ---------------------------------------------------------------------------
// doctor（只读）
// ---------------------------------------------------------------------------

interface DoctorReport {
    generatedAt: string;
    bridgeVersion: string;
    contractsSchemaVersion: number;
    platform: string;
    arch: string;
    command: 'doctor';
    runtime: {
        node: string;
        minimumNode: string;
        nodeOk: boolean;
        sqliteOk: boolean;
        sqliteMessage: string;
    };
    dataRoot: {
        path: string;
        source: string;
        exists: boolean;
        writable: boolean | null;
        legacy?: { path: string; exists: boolean; kind: string; notes: string[] };
    };
    instance: {
        endpointExists: boolean;
        endpointPort: number | null;
        healthOk: boolean;
        healthUrl: string | null;
        bridgeVersion: string | null;
        modConnected: boolean | null;
        saveLoaded: boolean | null;
        lockExists: boolean;
        lockStale: boolean | null;
        lockPid: number | null;
        lockVersion: string | null;
    };
    config: { path: string; exists: boolean; bridgePort: number | null; logLevel: string | null };
    credentials: { path: string; exists: boolean; clients: string[] };
    ledger: { path: string; exists: boolean; bytes: number | null; directoryWritable: boolean | null };
    web: { distPath: string; indexExists: boolean };
    mod: {
        checked: boolean;
        configs: {
            path: string;
            exists: boolean;
            dataDirectory: string | null;
            matchesBridgeRoot: boolean;
            gameRoot: string;
            source: string;
        }[];
        bridgeModDirs: string[];
    };
    problems: { code: string; message: string }[];
    problemCodes: string[];
}

function directoryWritable(dir: string): boolean | null {
    try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return null;
        // 不写文件：只用 access 语义判断（POSIX 上 mode 位只能提示，最终以真实写入为准）。
        return (stat.mode & 0o200) !== 0;
    } catch {
        return null;
    }
}

async function cmdDoctor(flags: Record<string, FlagValue>): Promise<number> {
    const json = boolFlag(flags, 'json');
    const problems: { code: string; message: string }[] = [];
    let descriptor: ResolvedDataRoot;
    try {
        descriptor = resolveDataRootDescriptor(stringFlag(flags, 'data-dir'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        command: 'doctor',
                        bridgeVersion: BRIDGE_VERSION,
                        generatedAt: new Date().toISOString(),
                        problems: [{ code: 'PATH_INVALID', message }],
                        problemCodes: ['PATH_INVALID']
                    },
                    null,
                    2
                )}\n`
            );
        } else {
            process.stderr.write(`${message}\n`);
        }
        return 1;
    }

    const paths = dataPaths(descriptor.path);
    const runtime = checkNodeVersion(process.version, NODE_MINIMUM_VERSION);
    const sqlite = await probeSqliteSupport();
    if (!runtime.ok) problems.push({ code: 'NODE_VERSION_UNSUPPORTED', message: runtime.message });
    if (!sqlite.ok) problems.push({ code: 'SQLITE_UNAVAILABLE', message: sqlite.message });

    // 只读探测：已有实例时通过 HTTP 只读接口取状态；绝不再构造第二个业务实例。
    const endpoint = readEndpoint(paths.endpoint);
    const launchDeps = depsForLaunch();
    const health = endpoint ? await probeHealth(endpoint.port, launchDeps) : null;
    const lock = readInstanceLock(paths.lock);
    const lockStale = lock ? isInstanceLockStale(lock, { platform: currentPlatformId() }) : null;

    let config: DoctorReport['config'] = { path: paths.config, exists: existsSync(paths.config), bridgePort: null, logLevel: null };
    if (config.exists) {
        try {
            const loaded = loadConfig(paths);
            config = { ...config, bridgePort: loaded.bridgePort, logLevel: loaded.logLevel };
        } catch (error) {
            problems.push({
                code: 'CONFIG_INVALID',
                message: `config.json 无法解析：${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    const credentialsRaw = readJsonIfExists<{ clients?: Record<string, unknown> }>(paths.credentials);
    const clients = credentialsRaw?.clients && typeof credentialsRaw.clients === 'object' ? Object.keys(credentialsRaw.clients) : [];

    let ledgerBytes: number | null = null;
    if (existsSync(paths.ledger)) {
        try {
            ledgerBytes = statSync(paths.ledger).size;
        } catch {
            ledgerBytes = null;
        }
    } else {
        // 损坏账本也可能是一个目录：保留现场，只报告，不建议直接删除。
        ledgerBytes = null;
    }
    if (existsSync(paths.ledger) && !statSync(paths.ledger).isFile()) {
        problems.push({
            code: 'LEDGER_INVALID',
            message:
                `账本路径不是普通文件：${paths.ledger}。请先停止 Bridge，把 ledger.sqlite、` +
                'ledger.sqlite-wal、ledger.sqlite-shm 一起备份到别处再排查；不要直接删除，否则会丢失去重与未决证据。'
        });
    }

    const modConfigs: DoctorReport['mod']['configs'] = [];
    const recorded = readJsonIfExists<{ gameRoot?: string }>(path.join(paths.root, 'mod-install.json'));
    let bridgeModDirs: string[] = [];
    if (currentPlatformId() === 'linux') {
        const reports = locateModConfigs({
            env: process.env,
            homeDir: os.homedir(),
            gamePath: stringFlag(flags, 'game-path') ?? process.env['STARDEW_GAME_PATH'] ?? undefined,
            recordedGameRoot: typeof recorded?.gameRoot === 'string' ? recorded.gameRoot : undefined
        });
        for (const report of reports) {
            const compared = compareModDataDirectory(report, paths.root);
            modConfigs.push({
                path: compared.path,
                exists: compared.exists,
                dataDirectory: compared.dataDirectory,
                matchesBridgeRoot: compared.matchesBridgeRoot,
                gameRoot: compared.gameRoot,
                source: compared.source
            });
            if (compared.exists && !compared.matchesBridgeRoot) {
                problems.push({
                    code: 'DATA_ROOT_MISMATCH',
                    message:
                        `Mod 配置的 DataDirectory（${compared.dataDirectory || '空'}）与 Bridge 数据根（${paths.root}）不一致：` +
                        `${compared.path}。Steam 启动不会继承 SAB_HOME，请用安装器重写该字段，或在启动前显式设置同一路径。`
                });
            }
        }
        for (const report of modConfigs) bridgeModDirs.push(...listBridgeModDirs(report.gameRoot));
        bridgeModDirs = [...new Set(bridgeModDirs)];
    }

    if (health) {
        if (lockStale === false && lock && lock.pid !== readEndpoint(paths.endpoint)?.pid) {
            problems.push({
                code: 'INSTANCE_CONFLICT',
                message: `实例锁（pid ${lock.pid}）与健康实例（pid ${endpoint?.pid ?? '?'}）不一致，请检查是否有残留实例。`
            });
        }
        if (!health.modConnected) {
            problems.push({
                code: 'MOD_NOT_CONNECTED',
                message:
                    '未连接到游戏 Mod。请确认：1) 星露谷通过 SMAPI 正常启动；2) Mods 里只有本项目的桥接 Mod；' +
                    '3) Mod 配置的 DataDirectory 与 Bridge 数据根一致；4) 已加载单人存档。'
            });
        }
    } else {
        if (lock && lockStale === false) {
            problems.push({
                code: 'INSTANCE_CONFLICT',
                message: `数据根被进程 ${lock.pid} 持锁，但 /health 探测失败。请先确认该进程状态，再决定是否手动结束它。`
            });
        }
        if (!existsSync(paths.root)) {
            problems.push({
                code: 'NOT_INITIALIZED',
                message: `数据根尚未初始化（${paths.root}）。首次运行 start/launch 时会创建目录与凭据；医生不会代你创建。`
            });
        }
    }

    const legacy = currentPlatformId() === 'linux' && existsSync(paths.root) ? legacyDataRootReport(paths) : undefined;
    if (legacy && legacy.kind !== 'none') {
        for (const note of legacy.notes) problems.push({ code: 'LEGACY_DATA_ROOT', message: note });
    }

    const report: DoctorReport = {
        generatedAt: new Date().toISOString(),
        bridgeVersion: BRIDGE_VERSION,
        contractsSchemaVersion: CONTRACTS_SCHEMA_VERSION,
        platform: process.platform,
        arch: process.arch,
        command: 'doctor',
        runtime: {
            node: process.version,
            minimumNode: NODE_MINIMUM_VERSION,
            nodeOk: runtime.ok,
            sqliteOk: sqlite.ok,
            sqliteMessage: sqlite.message
        },
        dataRoot: {
            path: paths.root,
            source: descriptor.source,
            exists: existsSync(paths.root),
            writable: directoryWritable(paths.root),
            ...(legacy ? { legacy: { path: legacy.legacyPath, exists: legacy.exists, kind: legacy.kind, notes: legacy.notes } } : {})
        },
        instance: {
            endpointExists: endpoint !== null,
            endpointPort: endpoint?.port ?? null,
            healthOk: health !== null,
            healthUrl: health ? `http://127.0.0.1:${health.port}/` : null,
            bridgeVersion: health?.bridgeVersion ?? null,
            modConnected: health ? health.modConnected : null,
            saveLoaded: health ? health.saveLoaded : null,
            lockExists: lock !== null,
            lockStale,
            lockPid: lock?.pid ?? null,
            lockVersion: lock?.programVersion ?? null
        },
        config,
        credentials: { path: paths.credentials, exists: credentialsRaw !== null, clients },
        ledger: {
            path: paths.ledger,
            exists: existsSync(paths.ledger),
            bytes: ledgerBytes,
            directoryWritable: directoryWritable(paths.root)
        },
        web: { distPath: paths.webDist, indexExists: existsSync(path.join(paths.webDist, 'index.html')) },
        mod: { checked: modConfigs.length > 0, configs: modConfigs, bridgeModDirs },
        problems,
        problemCodes: [...new Set(problems.map((problem) => problem.code))]
    };

    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return problems.length === 0 ? 0 : 1;
    }

    const lines: string[] = [];
    lines.push(`Stardew Agent Bridge ${BRIDGE_VERSION}（契约 ${CONTRACTS_SCHEMA_VERSION}）诊断`);
    lines.push(`  平台       ：${report.platform}/${report.arch}，Node ${report.runtime.node}（最低 ${NODE_MINIMUM_VERSION}）`);
    lines.push(`  Node/SQLite：${runtime.ok ? '版本可用' : '版本过低'}；${sqlite.ok ? '内置 SQLite 可用' : sqlite.message}`);
    lines.push(`  数据目录   ：${paths.root}（来源 ${descriptor.source}${report.dataRoot.exists ? '' : '，尚未创建'}）`);
    lines.push(`  配置       ：${paths.config}${config.exists ? `（bridgePort=${config.bridgePort}, logLevel=${config.logLevel}）` : '（缺失）'}`);
    lines.push(`  凭据       ：${credentialsRaw ? `已存在（客户端：${clients.join(', ') || '无'}；不显示内容）` : '缺失（首次 start/launch 时创建）'}`);
    lines.push(`  账本       ：${existsSync(paths.ledger) ? `已存在（${ledgerBytes ?? '?'} 字节）` : '尚未创建（首次 start 时创建）'}`);
    lines.push(`  Web 产物   ：${report.web.indexExists ? '已构建' : '缺失（运行 npm run build）'}`);
    if (health) {
        lines.push(`  Bridge     ：运行中 http://127.0.0.1:${health.port}/（版本 ${health.bridgeVersion}）`);
        lines.push(`  Mod 连接   ：${health.modConnected ? '已连接' : '未连接'}${health.gameVersion ? `（游戏 ${health.gameVersion}）` : ''}`);
        if (health.modConnected) lines.push(`  存档       ：${health.saveLoaded ? '已加载' : '未加载（标题页）'}`);
    } else {
        lines.push('  Bridge     ：未运行（只读探测失败或没有 endpoint）');
    }
    if (lock) {
        lines.push(`  实例锁     ：pid ${lock.pid}，版本 ${lock.programVersion}，${lockStale ? '已陈旧（可被接管）' : '有效'}`);
    } else {
        lines.push('  实例锁     ：不存在');
    }
    if (modConfigs.length > 0) {
        for (const entry of modConfigs) {
            lines.push(
                `  Mod 配置   ：${entry.path}${entry.exists ? `（DataDirectory=${entry.dataDirectory || '空'}，${entry.matchesBridgeRoot ? '与 Bridge 一致' : '与 Bridge 不一致'}）` : '（未找到）'}`
            );
        }
        if (bridgeModDirs.length > 0) lines.push(`  桥接 Mod   ：${bridgeModDirs.join(', ')}`);
    } else {
        lines.push('  Mod 配置   ：未检查（Linux 上需要 --game-path 或可发现的 Steam 库）');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (problems.length > 0) {
        process.stdout.write(`\n需要处理：\n${problems.map((item) => `  - [${item.code}] ${item.message}`).join('\n')}\n`);
        return 1;
    }
    process.stdout.write('\n诊断通过。\n');
    return 0;
}

// ---------------------------------------------------------------------------
// token / hosts / matrix
// ---------------------------------------------------------------------------

function cmdToken(flags: Record<string, FlagValue>, rest: string[]): number {
    const paths = dataPaths(dataDirPath(flags));
    ensureDirs(paths);
    const auth = new AuthStore(paths);
    const [action = 'list', clientId] = rest;
    if (action === 'list') {
        const clients = auth.listClients();
        if (flags.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, clients })}\n`);
            return 0;
        }
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
        if (flags.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, credential })}\n`);
            return 0;
        }
        process.stdout.write(`已创建/复用客户端 ${credential.clientId} 的令牌：\n${credential.token}\n`);
        process.stdout.write('令牌只在本机 credentials.json 保存；请勿提交到仓库或公开分享。\n');
        return 0;
    }
    if (action === 'rotate') {
        const credential = auth.rotate(clientId);
        if (flags.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, credential })}\n`);
            return 0;
        }
        process.stdout.write(`已轮换 ${credential.clientId} 的令牌：\n${credential.token}\n旧令牌立即失效。\n`);
        return 0;
    }
    if (action === 'revoke') {
        auth.revoke(clientId);
        if (flags.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, clientId })}\n`);
            return 0;
        }
        process.stdout.write(`已吊销客户端 ${clientId} 的令牌。\n`);
        return 0;
    }
    process.stderr.write(`未知 token 操作：${action}\n`);
    return 1;
}

function dataDirPath(flags: Record<string, FlagValue>): string {
    return resolveDataRootDescriptor(stringFlag(flags, 'data-dir')).path;
}

function cmdHosts(flags: Record<string, FlagValue>): number {
    const host = (stringFlag(flags, 'host') ?? 'dsh') as HostId;
    const transport = (stringFlag(flags, 'transport') ?? 'http') as TransportMode;
    if (!HOST_LABELS[host]) {
        process.stderr.write(`未知宿主：${host}（可选 dsh / codex / claude-code / generic）\n`);
        return 1;
    }
    if (transport !== 'http' && transport !== 'stdio') {
        process.stderr.write(`未知传输：${transport}（可选 http / stdio）\n`);
        return 1;
    }
    const paths = dataPaths(dataDirPath(flags));
    ensureDirs(paths);
    const auth = new AuthStore(paths);
    const clientId = stringFlag(flags, 'client-id') ?? (host === 'generic' ? 'agent' : host);
    const credential = auth.issue(clientId, HOST_LABELS[host]);
    const endpoint = readEndpoint(paths.endpoint);
    const endpointPort = endpoint?.port ?? loadConfigPort(paths);
    // 容器模式：endpoint 可能带公共地址字段；宿主 CLI 在本机运行时只认回环地址。
    // （Docker 部署的 MCP 配置由 scripts/docker/manage.mjs mcp-config 生成。）
    const publicBase = typeof endpoint?.['publicBaseUrl'] === 'string' ? (endpoint['publicBaseUrl'] as string) : null;
    const bridgeUrl = publicBase ? `${publicBase}/mcp` : `http://127.0.0.1:${endpointPort}/mcp`;
    const snippet = generateHostConfig({
        host,
        transport,
        clientId,
        clientName: HOST_LABELS[host],
        token: credential.token,
        bridgeUrl,
        stdioAdapterPath: resolveStdioAdapter(),
        nodeExecutable: process.execPath,
        dataDir: paths.root,
        containerMode: publicBase !== null
    });
    process.stdout.write(`# ${HOST_LABELS[host]} / ${transport}\n# 目标位置：${snippet.targetFile}\n\n`);
    process.stdout.write(`${snippet.content}\n\n`);
    for (const note of snippet.notes) process.stdout.write(`# 注意：${note}\n`);
    process.stdout.write(`# 平台：${process.platform}/${process.arch}；数据根 ${paths.root}（来源 ${stringFlag(flags, 'data-dir') ? 'explicit' : 'default/env'}）\n`);
    process.stdout.write('# 该模板尚未在 Linux 真实宿主验收；请按 docs/CLIENTS.md 的短任务清单核对。\n');
    return 0;
}

function cmdMatrix(): number {
    process.stdout.write('宿主支持矩阵：\n');
    for (const row of HOST_SUPPORT_MATRIX) {
        process.stdout.write(`  ${row.host.padEnd(12)} HTTP=${row.http}  stdio=${row.stdio}  ${row.note}\n`);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// desktop
// ---------------------------------------------------------------------------

function packageRootFromCliEntry(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // 源码：apps/server/dist；便携包：<pkg>/server。
    if (existsSync(path.join(here, '..', '..', '..', 'assets', 'stardew-agent-bridge.svg'))) return path.resolve(here, '..', '..', '..');
    return path.resolve(here, '..');
}

function iconSourceCandidates(): string[] {
    const pkgRoot = packageRootFromCliEntry();
    return [
        path.join(pkgRoot, 'assets', 'stardew-agent-bridge.svg'),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'stardew-agent-bridge.svg')
    ];
}

function cmdDesktop(flags: Record<string, FlagValue>, rest: string[]): number {
    const action = rest[0] ?? 'install';
    const json = boolFlag(flags, 'json');
    const paths = dataPaths(dataDirPath(flags));
    const ctx = {
        env: process.env,
        homeDir: os.homedir(),
        platform: currentPlatformId(),
        runCommand: (file: string, args: string[]) => {
            const result = spawnSync(file, args, { encoding: 'utf8', shell: false, timeout: 5000 });
            return { status: result.status, stdout: result.stdout ?? '' };
        }
    };

    if (action === 'install') {
        const iconSource = iconSourceCandidates().find(candidate => existsSync(candidate));
        let result: InstallDesktopEntryResult;
        try {
            result = installDesktopEntry({
                ctx,
                spec: {
                    name: 'Stardew Agent Bridge',
                    nameLocalized: '星露谷 Agent 桥接',
                    comment: '启动或复用本机星露谷桥接服务，并在浏览器中打开控制台。',
                    execPath: process.execPath,
                    args: [fileURLToPath(import.meta.url), 'launch', '--data-dir', paths.root],
                    iconPath: '',
                    workingDirectory: path.dirname(paths.root)
                },
                desktopShortcut: boolFlag(flags, 'desktop-shortcut'),
                ...(iconSource ? { iconSource } : {}),
                iconTargetDir: paths.icons
            });
        } catch (error) {
            process.stderr.write(`安装桌面入口失败：${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
        if (json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return result.ok ? 0 : 1;
        }
        process.stdout.write(`菜单入口：${result.entryFile}\n`);
        if (result.desktopFile) process.stdout.write(`桌面快捷方式：${result.desktopFile}\n`);
        for (const note of result.notes) process.stdout.write(`  - ${note}\n`);
        if (!result.ok) {
            process.stderr.write(`安装未完成（${result.code ?? 'UNKNOWN'}）。\n`);
            return 1;
        }
        process.stdout.write('提示：请用 desktop-file-validate 与实际点击验收；移除入口不会删除数据。\n');
        return 0;
    }

    if (action === 'remove') {
        const result: RemoveDesktopEntryResult = removeDesktopEntry({
            ctx,
            desktopShortcut: flags['desktop-shortcut'] !== false
        });
        if (json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        if (result.removed.length === 0) process.stdout.write('没有移除任何文件。\n');
        for (const file of result.removed) process.stdout.write(`已移除：${file}\n`);
        for (const note of result.notes) process.stdout.write(`  - ${note}\n`);
        return 0;
    }

    process.stderr.write(`未知 desktop 操作：${action}（可选 install / remove）\n`);
    return 1;
}

// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);
    switch (parsed.command) {
        case 'start':
            return cmdStart(parsed.flags);
        case 'launch':
            return cmdLaunch(parsed.flags);
        case 'doctor':
            return cmdDoctor(parsed.flags);
        case 'token':
            return cmdToken(parsed.flags, parsed.rest);
        case 'hosts':
            return cmdHosts(parsed.flags);
        case 'desktop':
            return cmdDesktop(parsed.flags, parsed.rest);
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
