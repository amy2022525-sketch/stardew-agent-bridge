/**
 * `launch`：启动或复用唯一的 Bridge 实例，等它就绪后打开 Web 控制台。
 *
 * 铁律：
 * - 先做**只读**探测（endpoint.json + `/health`），绝不为了"看看有没有在跑"
 *   去构造第二个业务实例；
 * - 只在确认需要启动时才 spawn 一个 `start` 子进程，由它自己在持锁后初始化账本；
 * - 连续双击桌面入口只会复用实例并打开网页，不会清空控制权、不会产生第二个守护进程；
 * - Bridge 正常但浏览器打不开时，仍明确显示真实地址，并把两件事分开报告。
 */
import { spawn } from 'node:child_process';
import { DEFAULT_BRIDGE_PORT } from '@sab/contracts';
import { readJsonIfExists, type PlatformId, type ResolvedDataRoot } from '@sab/platform';
import { acquireInstanceLock, isInstanceLockStale, readInstanceLock } from './instance-lock.js';
import { dataPaths, resolveDataRootDescriptor, type DataPaths } from './paths.js';

export interface EndpointInfo {
    publicBaseUrl?: string;
    publicMcpUrl?: string;
    port: number;
    mcpUrl?: string | undefined;
    pid?: number | undefined;
    bridgeVersion?: string | undefined;
    startedAt?: string | undefined;
    dataRoot?: string | undefined;
    processStart?: string | null | undefined;
}

export interface FetchLikeResponse {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchLikeResponse>;

export interface SpawnedChild {
    pid?: number | undefined;
    exitCode: number | null;
    onExit(callback: (code: number | null) => void): void;
    onError?(callback: (error: string) => void): void;
    unref(): void;
    kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: 'ignore'; env?: Record<string, string | undefined>; cwd?: string }
) => SpawnedChild;

export interface LaunchDeps {
    platform: PlatformId;
    env: Record<string, string | undefined>;
    homeDir: string;
    cwd: string;
    /** 真实 Node 可执行文件（源码运行是 process.execPath，便携包内是 runtime/node）。 */
    execPath: string;
    /** CLI 入口（源码是 apps/server/dist/cli.js，便携包内是 server/bridge.mjs）。 */
    cliEntry: string;
    fetchImpl?: FetchLike;
    spawnProcess?: SpawnProcess;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    /** 仅测试/容器用：指向伪造的 `/proc`，让实例锁的启动身份判定可复现。 */
    procRoot?: string;
}

export const defaultSpawnProcess: SpawnProcess = (command, args, options) => {
    const child = spawn(command, args, {
        detached: options.detached,
        stdio: options.stdio,
        shell: false,
        ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {})
    });
    return {
        pid: child.pid,
        get exitCode() {
            return child.exitCode;
        },
        onExit: (callback) => {
            child.once('exit', (code) => callback(code));
        },
        onError: (callback) => {
            child.once('error', (error) => callback(error.message));
        },
        unref: () => child.unref(),
        kill: (signal) => child.kill(signal)
    };
};

function fetchOf(deps: LaunchDeps): FetchLike {
    return deps.fetchImpl ?? (fetch as unknown as FetchLike);
}

function nowOf(deps: LaunchDeps): () => number {
    return deps.now ?? (() => Date.now());
}

function sleepOf(deps: LaunchDeps): (ms: number) => Promise<void> {
    return deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function readEndpoint(file: string): EndpointInfo | null {
    const raw = readJsonIfExists<Partial<EndpointInfo>>(file);
    if (!raw || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
    return {
        port: raw.port,
        mcpUrl: typeof raw.mcpUrl === 'string' ? raw.mcpUrl : undefined,
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        bridgeVersion: typeof raw.bridgeVersion === 'string' ? raw.bridgeVersion : undefined,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
        dataRoot: typeof raw.dataRoot === 'string' ? raw.dataRoot : undefined,
        processStart: typeof raw.processStart === 'string' ? raw.processStart : null
    };
}

export interface HealthInfo {
    ok: boolean;
    bridgeVersion: string;
    modConnected: boolean;
    port: number;
    saveLoaded: boolean | null;
    gameVersion: string | null;
    dataRoot: string | null;
    pid: number | null;
    processStart: string | null;
}

/** 只读健康探测：只发一个 GET /health，不创建任何业务对象。 */
export async function probeHealth(port: number, deps: LaunchDeps): Promise<HealthInfo | null> {
    try {
        const response = await fetchOf(deps)(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1500)
        });
        if (!response.ok) return null;
        const body = (await response.json()) as Record<string, unknown>;
        if (body['ok'] !== true) return null;
        return {
            ok: true,
            bridgeVersion: typeof body['bridgeVersion'] === 'string' ? body['bridgeVersion'] : '?',
            modConnected: body['modConnected'] === true,
            port,
            saveLoaded: typeof body['saveLoaded'] === 'boolean' ? (body['saveLoaded'] as boolean) : null,
            gameVersion: typeof body['gameVersion'] === 'string' ? (body['gameVersion'] as string) : null,
            dataRoot: typeof body['dataRoot'] === 'string' ? body['dataRoot'] : null,
            pid: typeof body['pid'] === 'number' ? body['pid'] : null,
            processStart: typeof body['processStart'] === 'string' ? body['processStart'] : null
        };
    } catch {
        return null;
    }
}

export interface ExistingInstance {
    health: HealthInfo;
    endpoint: EndpointInfo | null;
    url: string;
}

/** 复用判定：endpoint 指向的本机实例确实健康，且数据根一致。 */
export async function findExistingInstance(paths: DataPaths, dataRoot: string, deps: LaunchDeps): Promise<ExistingInstance | null> {
    const endpoint = readEndpoint(paths.endpoint);
    if (!endpoint) return null;
    if (endpoint.dataRoot && endpoint.dataRoot !== dataRoot) return null;
    const health = await probeHealth(endpoint.port, deps);
    if (!health) return null;
    if (health.dataRoot !== dataRoot || health.bridgeVersion === '?') return null;
    if (typeof endpoint.pid === 'number' && endpoint.pid !== health.pid) return null;
    if (endpoint.processStart && endpoint.processStart !== health.processStart) return null;
    return { health, endpoint, url: `http://127.0.0.1:${health.port}/` };
}

export interface LaunchOptions {
    dataDir?: string | undefined;
    port?: number | undefined;
    /** 默认 true：就绪后打开默认浏览器。 */
    open?: boolean | undefined;
    timeoutMs?: number | undefined;
    pollIntervalMs?: number | undefined;
    programVersion: string;
}

export type LaunchProblemCode =
    | 'DATA_ROOT_INVALID'
    | 'INSTANCE_CONFLICT'
    | 'PORT_CONFLICT'
    | 'START_FAILED'
    | 'START_TIMEOUT';

export interface LaunchResult {
    code: number;
    dataRoot: string;
    dataRootSource: string;
    port: number;
    url: string;
    reused: boolean;
    started: boolean;
    browserOpened: boolean;
    browserError: string | null;
    problems: string[];
    problemCode: LaunchProblemCode | null;
    logFile: string;
}

function resultBase(dataRoot: string, dataRootSource: string, logFile: string): Omit<LaunchResult, 'code' | 'port' | 'url' | 'reused' | 'started' | 'browserOpened' | 'browserError' | 'problems' | 'problemCode'> {
    return { dataRoot, dataRootSource, logFile };
}

export async function launchBridge(options: LaunchOptions, deps: LaunchDeps): Promise<LaunchResult> {
    const log = deps.log ?? (() => {});
    const sleep = sleepOf(deps);
    const now = nowOf(deps);
    const timeoutMs = options.timeoutMs ?? 20_000;
    const pollIntervalMs = options.pollIntervalMs ?? 200;

    let resolved: ResolvedDataRoot;
    try {
        resolved = resolveDataRootDescriptor(options.dataDir);
    } catch (error) {
        return {
            ...resultBase(options.dataDir ?? '', 'explicit', ''),
            code: 1,
            port: 0,
            url: '',
            reused: false,
            started: false,
            browserOpened: false,
            browserError: null,
            problems: [error instanceof Error ? error.message : String(error)],
            problemCode: 'DATA_ROOT_INVALID'
        };
    }
    const paths = dataPaths(resolved.path);
    const logFile = `${paths.logs}/bridge.log`;
    const base = resultBase(resolved.path, resolved.source, logFile);

    // 1) 只读探测已有实例。
    const existing = await findExistingInstance(paths, resolved.path, deps);
    if (existing) {
        log(`复用已在运行的 Bridge：${existing.url}（版本 ${existing.health.bridgeVersion}）`);
        const opened = await maybeOpenWeb(existing.url, options.open, deps);
        return {
            ...base,
            code: 0,
            port: existing.health.port,
            url: existing.url,
            reused: true,
            started: false,
            browserOpened: opened.ok,
            browserError: opened.error,
            problems: opened.notes,
            problemCode: null
        };
    }

    // 2) 活锁但没有健康端口：说明另一个实例正在启动或已损坏，不要抢。
    const lock = readInstanceLock(paths.lock);
    if (lock && !isInstanceLockStale(lock, { platform: deps.platform, procRoot: deps.procRoot })) {
        const provisional = lock.pid !== process.pid ? await waitForReadiness(paths, resolved.path, deps, { deadline: now() + Math.min(timeoutMs, 5_000), intervalMs: pollIntervalMs }) : null;
        if (provisional) {
            const opened = await maybeOpenWeb(provisional.url, options.open, deps);
            return {
                ...base,
                code: 0,
                port: provisional.health.port,
                url: provisional.url,
                reused: true,
                started: false,
                browserOpened: opened.ok,
                browserError: opened.error,
                problems: opened.notes,
                problemCode: null
            };
        }
        return {
            ...base,
            code: 2,
            port: endpointPort(paths),
            url: `http://127.0.0.1:${endpointPort(paths)}/`,
            reused: false,
            started: false,
            browserOpened: false,
            browserError: null,
            problems: [
                `数据根 ${resolved.path} 已被进程 ${lock.pid}（版本 ${lock.programVersion}）持锁，但端口探测未通过。`,
                '请先运行 doctor 查看该实例状态；若确认它已卡死，请手动结束该进程后重试，本程序不会按进程名批量结束进程。'
            ],
            problemCode: 'INSTANCE_CONFLICT'
        };
    }

    // 3) 清理陈旧锁与陈旧 endpoint（只清理本次确实判定为陈旧的记录）。
    if (lock && isInstanceLockStale(lock, { platform: deps.platform, procRoot: deps.procRoot })) {
        const handle = acquireInstanceLock({
            lockPath: paths.lock,
            dataRoot: resolved.path,
            programVersion: options.programVersion,
            deps: { platform: deps.platform, procRoot: deps.procRoot }
        });
        if (handle.acquired) handle.handle.release();
    }

    // 4) 启动子进程：由它自己持锁、初始化账本并写 endpoint。
    const args = [deps.cliEntry, 'start', '--data-dir', resolved.path];
    if (typeof options.port === 'number') args.push('--port', String(options.port));
    const child = (deps.spawnProcess ?? defaultSpawnProcess)(deps.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...deps.env, SAB_HOME: resolved.path },
        cwd: deps.cwd
    });
    let exited: number | null = null;
    let spawnError: string | null = null;
    child.onExit((code) => {
        exited = code;
    });
    child.onError?.((error) => {
        spawnError = error;
    });
    child.unref();

    const ready = await waitForReadiness(paths, resolved.path, deps, {
        deadline: now() + timeoutMs,
        intervalMs: pollIntervalMs,
        isDead: () => exited !== null || spawnError !== null
    });

    if (!ready) {
        const detail: string[] = [];
        if (spawnError) detail.push(`无法启动进程：${spawnError}`);
        else if (exited !== null) detail.push(`子进程已退出（退出码 ${exited}）`);
        else detail.push(`等待就绪超时（${timeoutMs} 毫秒）`);
        detail.push(`请查看日志：${logFile}`);
        const conflict = exited === 2;
        return {
            ...base,
            code: conflict ? 2 : 1,
            port: endpointPort(paths),
            url: `http://127.0.0.1:${endpointPort(paths)}/`,
            reused: false,
            started: false,
            browserOpened: false,
            browserError: null,
            problems: detail,
            problemCode: conflict ? 'PORT_CONFLICT' : 'START_FAILED'
        };
    }

    const opened = await maybeOpenWeb(ready.url, options.open, deps);
    return {
        ...base,
        code: 0,
        port: ready.health.port,
        url: ready.url,
        reused: false,
        started: true,
        browserOpened: opened.ok,
        browserError: opened.error,
        problems: opened.notes,
        problemCode: null
    };
}

function endpointPort(paths: DataPaths): number {
    return readEndpoint(paths.endpoint)?.port ?? DEFAULT_BRIDGE_PORT;
}

interface ReadinessWait {
    deadline: number;
    intervalMs: number;
    isDead?: () => boolean;
}

async function waitForReadiness(
    paths: DataPaths,
    dataRoot: string,
    deps: LaunchDeps,
    wait: ReadinessWait
): Promise<ExistingInstance | null> {
    const now = nowOf(deps);
    const sleep = sleepOf(deps);
    while (now() < wait.deadline) {
        if (wait.isDead?.() === true) return null;
        const instance = await findExistingInstance(paths, dataRoot, deps);
        if (instance) return instance;
        await sleep(wait.intervalMs);
    }
    return null;
}

interface OpenWebOutcome {
    ok: boolean;
    error: string | null;
    notes: string[];
}

/** 打开默认浏览器；失败只影响"打开网页"，不影响 Bridge 是否已就绪。 */
export async function maybeOpenWeb(url: string, open: boolean | undefined, deps: LaunchDeps): Promise<OpenWebOutcome> {
    if (open === false) return { ok: false, error: null, notes: ['已按 --no-open 跳过打开浏览器。'] };
    if (deps.platform === 'linux' && !(deps.env['DISPLAY'] ?? deps.env['WAYLAND_DISPLAY'])) {
        return {
            ok: false,
            error: null,
            notes: ['没有检测到 DISPLAY/WAYLAND_DISPLAY：已跳过打开浏览器，请手动访问上面的地址。这也不表示无图形界面的游戏已被支持。']
        };
    }
    const command = deps.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = deps.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    let error: string | null = null;
    try {
        const child = (deps.spawnProcess ?? defaultSpawnProcess)(command, args, {
            detached: true,
            stdio: 'ignore',
            env: deps.env,
            cwd: deps.cwd
        });
        child.onError?.((message) => {
            error = message;
        });
        child.unref();
    } catch (spawnFailure) {
        return {
            ok: false,
            error: spawnFailure instanceof Error ? spawnFailure.message : String(spawnFailure),
            notes: [`无法调用 ${command} 打开浏览器；Bridge 本身已就绪。`]
        };
    }
    await sleepOf(deps)(250);
    if (error) {
        return {
            ok: false,
            error,
            notes: [`无法调用 ${command} 打开浏览器（${error}）；Bridge 本身已就绪，请手动访问 ${url}。`]
        };
    }
    return { ok: true, error: null, notes: [] };
}
