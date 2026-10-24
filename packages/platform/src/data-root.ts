/**
 * 跨平台应用数据根解析：Node 侧唯一实现。
 *
 * 规则（与 Mod 的 C# `PlatformPaths.cs` 完全一致，见 docs/LINUX_DEVELOPMENT.md）：
 *
 * | 场景 | 规则 |
 * | --- | --- |
 * | 显式 `--data-dir` / Mod `config.DataDirectory` | 最高优先；相对值按调用者 cwd 解析（Mod 侧要求绝对路径） |
 * | 非空 `SAB_HOME` | 其次；Linux 上必须是绝对路径，相对值明确报错 |
 * | Windows 默认 | `%LOCALAPPDATA%\StardewAgentBridge`，缺失时 `~/AppData/Local/StardewAgentBridge` |
 * | Linux 默认 | 绝对 `XDG_DATA_HOME` 下的 `StardewAgentBridge`，否则 `~/.local/share/StardewAgentBridge` |
 * | Linux 上的 LOCALAPPDATA | 忽略 |
 * | Linux 上相对的 XDG_DATA_HOME | 视为无效并回退到默认 |
 *
 * 不同目标平台一律使用该平台自己的路径语义（`path.win32` / `path.posix`），
 * 从不把宿主 `path.resolve()` 的结果冒充另一个平台的结果。
 */
import os from 'node:os';
import path from 'node:path';

export type PlatformId = 'win32' | 'linux';

/** 应用目录名：大小写准确，不在任何组件里混用小写 slug。 */
export const APP_DIRECTORY_NAME = 'StardewAgentBridge';

export type DataRootSource = 'explicit' | 'SAB_HOME' | 'LOCALAPPDATA' | 'XDG_DATA_HOME' | 'default';

export interface ResolveDataRootInput {
    /** CLI `--data-dir` 或 Mod `config.DataDirectory`。 */
    explicit?: string | undefined;
    /** 注入环境便于测试；生产代码传 `process.env`。 */
    env: Record<string, string | undefined>;
    platform: PlatformId;
    homeDir: string;
    cwd: string;
    /**
     * 显式值是否必须绝对。
     * Mod 与安装器写入的配置要求绝对（true）；CLI `--data-dir ./x` 允许相对（false，按 cwd 解析）。
     */
    requireAbsoluteExplicit?: boolean;
}

export interface ResolvedDataRoot {
    path: string;
    source: DataRootSource;
    platform: PlatformId;
}

export type DataRootErrorCode = 'PATH_INVALID' | 'NO_HOME';

export class DataRootError extends Error {
    readonly code: DataRootErrorCode;

    constructor(code: DataRootErrorCode, message: string) {
        super(message);
        this.name = 'DataRootError';
        this.code = code;
    }
}

function apiFor(platform: PlatformId): typeof path.posix {
    // path.win32 与 path.posix 的公共形状一致；这里用 posix 的类型代表两者。
    return (platform === 'win32' ? path.win32 : path.posix) as unknown as typeof path.posix;
}

/** 该目标平台上的绝对路径判断。 */
export function isAbsolutePathFor(platform: PlatformId, value: string): boolean {
    return apiFor(platform).isAbsolute(value);
}

/** 按目标平台语义拼接路径（不解析符号链接、不读取磁盘）。 */
export function joinPathFor(platform: PlatformId, ...parts: string[]): string {
    return finalizePathFor(platform, apiFor(platform).join(...parts));
}

/** 去掉末尾分隔符（保留根），并做目标平台规范化。 */
export function finalizePathFor(platform: PlatformId, value: string): string {
    const api = apiFor(platform);
    if (!value) return value;
    const normalized = api.normalize(value);
    if (normalized === '.' || normalized === './') return '.';
    const root = api.parse(normalized).root;
    let out = normalized;
    while (out.length > root.length + 1 && /[\\/]$/.test(out)) out = out.slice(0, -1);
    if (out.length === root.length + 1 && /[\\/]$/.test(out)) out = out.slice(0, -1);
    return out;
}

function trimOrEmpty(value: string | undefined | null): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** 相对值按调用者 cwd 解析；绝不借用宿主进程的工作目录。 */
function resolveAgainst(value: string, base: string, platform: PlatformId): string {
    const api = apiFor(platform);
    if (api.isAbsolute(value)) return api.normalize(value);
    return api.normalize(api.join(base, value));
}

/** Node 进程的平台标识；非 Windows 一律按 POSIX/XDG 规则处理（本轮只验收 Linux）。 */
export function currentPlatformId(): PlatformId {
    return process.platform === 'win32' ? 'win32' : 'linux';
}

export function resolveDataRoot(input: ResolveDataRootInput): ResolvedDataRoot {
    const platform = input.platform;
    const env = input.env ?? {};
    const homeDir = trimOrEmpty(input.homeDir);
    const cwd = input.cwd || (platform === 'win32' ? 'C:\\' : '/');

    const explicit = trimOrEmpty(input.explicit);
    if (explicit) {
        if (input.requireAbsoluteExplicit === true && !isAbsolutePathFor(platform, explicit)) {
            throw new DataRootError('PATH_INVALID', `数据目录必须是绝对路径：${explicit}`);
        }
        return { path: finalizePathFor(platform, resolveAgainst(explicit, cwd, platform)), source: 'explicit', platform };
    }

    const sabHome = trimOrEmpty(env['SAB_HOME']);
    if (sabHome) {
        if (platform === 'linux' && !isAbsolutePathFor('linux', sabHome)) {
            throw new DataRootError(
                'PATH_INVALID',
                `Linux 上 SAB_HOME 必须是绝对路径（收到 "${sabHome}"）。请使用 "$HOME/..." 这样的绝对路径，` +
                    '否则启动目录不同会分裂成多个数据根。'
            );
        }
        return { path: finalizePathFor(platform, resolveAgainst(sabHome, cwd, platform)), source: 'SAB_HOME', platform };
    }

    if (platform === 'linux') {
        const xdg = trimOrEmpty(env['XDG_DATA_HOME']);
        // XDG 规范要求绝对路径；相对值视为无效并回退默认，但来源会写清楚。
        if (xdg && isAbsolutePathFor('linux', xdg)) {
            return {
                path: finalizePathFor('linux', path.posix.join(xdg, APP_DIRECTORY_NAME)),
                source: 'XDG_DATA_HOME',
                platform
            };
        }
        if (!homeDir) {
            throw new DataRootError('NO_HOME', '缺少用户主目录，无法确定默认数据目录；请设置 SAB_HOME 或使用 --data-dir。');
        }
        return {
            path: finalizePathFor('linux', path.posix.join(homeDir, '.local', 'share', APP_DIRECTORY_NAME)),
            source: 'default',
            platform
        };
    }

    const localAppData = trimOrEmpty(env['LOCALAPPDATA']);
    if (localAppData) {
        return {
            path: finalizePathFor('win32', path.win32.join(localAppData, APP_DIRECTORY_NAME)),
            source: 'LOCALAPPDATA',
            platform
        };
    }
    if (!homeDir) {
        throw new DataRootError('NO_HOME', '缺少 %LOCALAPPDATA% 与用户主目录，无法确定默认数据目录；请设置 SAB_HOME 或使用 --data-dir。');
    }
    return {
        path: finalizePathFor('win32', path.win32.join(homeDir, 'AppData', 'Local', APP_DIRECTORY_NAME)),
        source: 'default',
        platform
    };
}

/** 生产代码入口：读取真实平台、环境与主目录。 */
export function resolveDataRootForProcess(explicit?: string): ResolvedDataRoot {
    return resolveDataRoot({
        explicit,
        env: process.env,
        platform: currentPlatformId(),
        homeDir: os.homedir(),
        cwd: process.cwd()
    });
}

/**
 * 旧 Linux 数据根的诊断（只读，不合并、不删除、不复制凭据）。
 * 历史上 Node 侧曾把 `~/AppData/Local/StardewAgentBridge` 当作默认目录。
 */
export interface LegacyDataRootReport {
    legacyPath: string;
    exists: boolean;
    currentPath: string;
    currentExists: boolean;
    kind: 'none' | 'legacy-only' | 'both';
    notes: string[];
}

export function inspectLegacyDataRoot(input: {
    homeDir: string;
    currentPath: string;
    env: Record<string, string | undefined>;
    exists?: (candidate: string) => boolean;
}): LegacyDataRootReport {
    const exists = input.exists ?? (() => false);
    const legacyPath = path.posix.join(input.homeDir, 'AppData', 'Local', APP_DIRECTORY_NAME);
    const legacyExists = legacyPath !== input.currentPath && exists(legacyPath);
    const currentExists = exists(input.currentPath);
    const kind = legacyExists ? (currentExists ? 'both' : 'legacy-only') : 'none';
    const notes: string[] = [];
    if (kind === 'legacy-only') {
        notes.push(
            `只发现旧目录 ${legacyPath}。本版默认使用 ${input.currentPath}；如需继续沿用旧数据，请显式设置 ` +
                'SAB_HOME 指向旧目录（绝对路径），本程序不会自动合并两份凭据或账本。'
        );
    } else if (kind === 'both') {
        notes.push(
            `新旧数据根同时存在（旧 ${legacyPath} / 新 ${input.currentPath}）。请用 --data-dir 或 SAB_HOME ` +
                '明确选择一个，本程序不会自动覆盖或合并任何一份。'
        );
    }
    return { legacyPath, exists: legacyExists, currentPath: input.currentPath, currentExists, kind, notes };
}
