/**
 * 只读检查已安装 Mod 的配置：Bridge 数据根与 Mod `DataDirectory` 是否一致。
 *
 * 为什么需要它：Steam 启动游戏时不会继承终端里的 `SAB_HOME`，所以安装器必须把
 * 解析后的绝对路径写进 Mod 配置。doctor 只读比对两边，**不会**复制凭据到多个地方
 * 去掩盖不一致。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { currentPlatformId, finalizePathFor, isAbsolutePathFor, parseLibraryFoldersVdf, readJsonIfExists, steamRootCandidates, gameRootInLibrary, GAME_DLL_NAME, SMAPI_DLL_NAME, type PlatformId } from '@sab/platform';

export interface ModConfigReport {
    /** Mod 配置文件的绝对路径。 */
    path: string;
    gameRoot: string;
    exists: boolean;
    /** 配置里的 DataDirectory（可能为空字符串）。 */
    dataDirectory: string | null;
    port: number | null;
    pauseAfterEachStep: boolean | null;
    matchesBridgeRoot: boolean;
    source: 'explicit' | 'steam' | 'record';
}

export interface LocateModConfigInput {
    platform?: PlatformId;
    env: Record<string, string | undefined>;
    homeDir: string;
    /** 显式游戏目录（--game-path）。 */
    gamePath?: string | undefined;
    /** 本应用记录的安装目录（<dataRoot>/mod-install.json）。 */
    recordedGameRoot?: string | undefined;
    exists?: (candidate: string) => boolean;
}

function safeRealpath(candidate: string): string | null {
    try {
        return realpathSync(candidate);
    } catch {
        return null;
    }
}

function looksLikeGameRoot(root: string, exists: (candidate: string) => boolean): boolean {
    return exists(path.join(root, GAME_DLL_NAME)) && exists(path.join(root, SMAPI_DLL_NAME));
}

/** Steam 库 → 星露谷目录的只读候选（不写入、不安装）。 */
export function steamGameRoots(input: LocateModConfigInput): { root: string; sandboxed: boolean }[] {
    const exists = input.exists ?? ((candidate: string) => existsSync(candidate));
    const out: { root: string; sandboxed: boolean }[] = [];
    const platform = input.platform ?? currentPlatformId();
    for (const candidate of steamRootCandidates(input.homeDir, platform)) {
        const steamRoot = safeRealpath(candidate.path);
        if (!steamRoot) continue;
        const libraryFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
        const libraries: string[] = [steamRoot];
        if (exists(libraryFile)) {
            try {
                const text = readFileSync(libraryFile, 'utf8').replace(/^\uFEFF/, '');
                for (const value of parseLibraryFoldersVdf(text)) {
                    const resolved = safeRealpath(value) ?? (exists(value) ? value : null);
                    if (resolved) libraries.push(resolved);
                }
            } catch {
                /* 读不了就当只有一个库 */
            }
        }
        for (const library of libraries) {
            const gameRoot = gameRootInLibrary(library, platform);
            if (!looksLikeGameRoot(gameRoot, exists)) continue;
            if (out.some((item) => item.root === gameRoot)) continue;
            out.push({ root: gameRoot, sandboxed: candidate.strength === 'sandboxed' });
        }
    }
    return out;
}

/** 只读列出可检查的 Mod 配置；不猜测游戏目录之外的路径。 */
export function locateModConfigs(input: LocateModConfigInput): ModConfigReport[] {
    const exists = input.exists ?? ((candidate: string) => existsSync(candidate));
    const reports: ModConfigReport[] = [];
    const push = (gameRoot: string, source: ModConfigReport['source']): void => {
        const file = path.join(gameRoot, 'Mods', 'StardewAgentBridge', 'config.json');
        const raw = readJsonIfExists<Record<string, unknown>>(file);
        reports.push({
            path: file,
            gameRoot,
            exists: raw !== null,
            dataDirectory: typeof raw?.['DataDirectory'] === 'string' ? (raw['DataDirectory'] as string) : null,
            port: typeof raw?.['Port'] === 'number' ? (raw['Port'] as number) : null,
            pauseAfterEachStep:
                typeof raw?.['PauseAfterEachStep'] === 'boolean' ? (raw['PauseAfterEachStep'] as boolean) : null,
            matchesBridgeRoot: false,
            source
        });
    };
    if (input.gamePath) {
        const root = safeRealpath(input.gamePath) ?? input.gamePath;
        push(root, 'explicit');
    }
    if (input.recordedGameRoot) {
        const root = safeRealpath(input.recordedGameRoot) ?? input.recordedGameRoot;
        if (!reports.some((report) => report.gameRoot === root)) push(root, 'record');
    }
    if (reports.length === 0) {
        for (const candidate of steamGameRoots({ ...input, exists })) {
            push(candidate.root, 'steam');
        }
    }
    return reports;
}

/** 与 Bridge 数据根比对（Linux 按精确大小写）。 */
export function compareModDataDirectory(report: ModConfigReport, bridgeDataRoot: string, platform: PlatformId = currentPlatformId()): ModConfigReport {
    const declared = (report.dataDirectory ?? '').trim();
    if (!declared || !isAbsolutePathFor(platform, declared) || !isAbsolutePathFor(platform, bridgeDataRoot)) {
        return { ...report, matchesBridgeRoot: false };
    }
    const normalize = (value: string): string => {
        const result = finalizePathFor(platform, value);
        return platform === 'win32' ? result.toLowerCase() : result;
    };
    return { ...report, matchesBridgeRoot: normalize(declared) === normalize(bridgeDataRoot) };
}

/** 列出属于本项目的桥接 Mod 目录（按 manifest UniqueID，诊断用，不移动任何文件）。 */
export function listBridgeModDirs(gameRoot: string, exists: (candidate: string) => boolean = candidate => existsSync(candidate)): string[] {
    const dir = path.join(gameRoot, 'Mods');
    const bridgeIds = ['AgentStardew.Bridge', 'StardewAgentBridge.Bridge'];
    try {
        if (!exists(dir)) return [];
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(dir, entry.name))
            .filter((candidate) => {
                const manifest = readJsonIfExists<{ UniqueID?: unknown }>(path.join(candidate, 'manifest.json'));
                return typeof manifest?.UniqueID === 'string' && bridgeIds.includes(manifest.UniqueID);
            });
    } catch {
        return [];
    }
}
