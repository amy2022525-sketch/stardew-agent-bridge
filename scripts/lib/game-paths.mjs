/**
 * 游戏目录发现与只读校验（MJS 版，供安装/回退/构建/打包脚本使用）。
 *
 * 规则来源只有一处：`@sab/platform` 的 VDF 解析与路径边界判断。
 * 本文件只负责「读磁盘 + 组织结构化结果」，不写入任何游戏文件。
 *
 * 任何来自 VDF、环境变量或命令行的路径都只作为数据使用：脚本从不把它们
 * 拼接进 `sh -c`，所有外部命令都以 argv 数组直接 spawn。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { gameRootInLibrary, isPathInside, parseLibraryFoldersVdf, steamRootCandidates } from '@sab/platform';

export const GAME_DIR_NAME = 'Stardew Valley';
export const GAME_DLL = 'Stardew Valley.dll';
export const SMAPI_DLL = 'StardewModdingAPI.dll';
export const SMAPI_INTERNAL = 'smapi-internal';
export const MOD_DIR_NAME = 'StardewAgentBridge';
export const MOD_ID = 'StardewAgentBridge.Bridge';
export const LEGACY_MOD_IDS = ['AgentStardew.Bridge'];

export function realpathSafe(candidate) {
    try {
        return realpathSync(candidate);
    } catch {
        return null;
    }
}

function isFile(candidate) {
    try {
        return statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function isDir(candidate) {
    try {
        return statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/** Steam 根目录候选（含 realpath 后的实际路径与沙箱标记）。 */
export function steamRoots({ homeDir, platform = 'linux' }) {
    const out = [];
    for (const candidate of steamRootCandidates(homeDir ?? '', platform)) {
        const resolved = realpathSafe(candidate.path);
        if (!resolved || !isDir(resolved)) continue;
        if (out.some((item) => item.root === resolved)) continue;
        out.push({ root: resolved, strength: candidate.strength, declared: candidate.path });
    }
    return out;
}

/** 某个 Steam 根下的所有库根（含自身）。 */
export function steamLibraries(steamRoot) {
    const libraries = [steamRoot];
    const libraryFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    if (!isFile(libraryFile)) return libraries;
    let text;
    try {
        text = readFileSync(libraryFile, 'utf8').replace(/^\uFEFF/, '');
    } catch {
        return libraries;
    }
    for (const declared of parseLibraryFoldersVdf(text)) {
        const resolved = realpathSafe(declared) ?? (isDir(declared) ? declared : null);
        if (!resolved) continue;
        if (libraries.includes(resolved)) continue;
        libraries.push(resolved);
    }
    return libraries;
}

/** 只读列出所有可能含星露谷的目录。 */
export function discoverGameCandidates({ homeDir, platform = 'linux' }) {
    const candidates = [];
    for (const steam of steamRoots({ homeDir, platform })) {
        for (const library of steamLibraries(steam.root)) {
            const gameRoot = gameRootInLibrary(library, platform);
            if (!isFile(path.join(gameRoot, GAME_DLL))) continue;
            if (candidates.some((item) => item.gameRoot === gameRoot)) continue;
            candidates.push({ gameRoot, source: 'steam', steamRoot: steam.root, sandboxed: steam.strength === 'sandboxed' });
        }
    }
    return candidates;
}

/**
 * 解析游戏目录。
 * 优先级：显式 --game-path / STARDEW_GAME_PATH → 本应用记录 → Steam 库自动发现。
 * 多个不同游戏目录同时可发现时报 GAME_PATH_AMBIGUOUS，由用户显式指定，绝不猜。
 */
export function resolveGameRoot({ explicit, env = {}, homeDir, platform = 'linux', recordedGameRoot }) {
    const problems = [];
    const fromEnv = typeof env.STARDEW_GAME_PATH === 'string' ? env.STARDEW_GAME_PATH.trim() : '';
    const explicitValue = (explicit ?? '').trim() || fromEnv || '';
    if (explicitValue) {
        const resolved = realpathSafe(explicitValue) ?? explicitValue;
        if (!isDir(resolved)) {
            return { ok: false, gameRoot: null, source: 'explicit', candidates: [], problems: [`游戏目录不存在：${resolved}`] };
        }
        return { ok: true, gameRoot: resolved, source: explicit ? 'explicit' : 'env', candidates: [], problems: [] };
    }
    if (recordedGameRoot) {
        const resolved = realpathSafe(recordedGameRoot) ?? recordedGameRoot;
        if (isFile(path.join(resolved, GAME_DLL))) {
            return { ok: true, gameRoot: resolved, source: 'record', candidates: [], problems: [] };
        }
        problems.push(`本应用记录的安装目录已失效：${recordedGameRoot}`);
    }
    const candidates = discoverGameCandidates({ homeDir, platform });
    const sandboxed = candidates.filter((item) => item.sandboxed);
    if (sandboxed.length > 0) {
        problems.push(
            `发现沙箱（Flatpak/Snap）候选：${sandboxed.map((item) => item.gameRoot).join(', ')}。` +
                '本版只验收原生安装；沙箱环境需要 --game-path 显式指定，且不在本轮验收范围内。'
        );
    }
    if (candidates.length === 1) {
        return { ok: true, gameRoot: candidates[0].gameRoot, source: 'steam', candidates, problems };
    }
    if (candidates.length > 1) {
        return {
            ok: false,
            gameRoot: null,
            source: 'steam',
            candidates,
            problems: [
                `发现多个星露谷目录：${candidates.map((item) => item.gameRoot).join(', ')}。请用 --game-path 明确指定一个。`,
                ...problems
            ]
        };
    }
    problems.unshift('未找到星露谷安装目录。请用 --game-path 指定，或设置 STARDEW_GAME_PATH。本版不扫描任意磁盘。');
    return { ok: false, gameRoot: null, source: 'none', candidates, problems };
}

/** 只读校验游戏目录结构与 SMAPI。 */
export function inspectGameRoot(gameRoot) {
    const problems = [];
    const gameDll = path.join(gameRoot, GAME_DLL);
    const smapiDll = path.join(gameRoot, SMAPI_DLL);
    const smapiInternal = path.join(gameRoot, SMAPI_INTERNAL);
    const modsDir = path.join(gameRoot, 'Mods');
    if (!isFile(gameDll)) problems.push(`缺少 ${GAME_DLL}：${gameDll}`);
    if (!isFile(smapiDll)) problems.push(`缺少 ${SMAPI_DLL}：${gameRoot}（请先安装 SMAPI 4.5.2 或更高版本）`);
    let smapiVersion = null;
    try {
        const versionFile = path.join(smapiInternal, 'smapi-version.json');
        if (isFile(versionFile)) {
            const parsed = JSON.parse(readFileSync(versionFile, 'utf8'));
            if (typeof parsed?.version === 'string') smapiVersion = parsed.version;
        }
    } catch {
        smapiVersion = null;
    }
    return {
        gameRoot,
        gameDllExists: isFile(gameDll),
        smapiDllExists: isFile(smapiDll),
        smapiInternalExists: isDir(smapiInternal),
        smapiVersion,
        modsDir,
        modsDirExists: isDir(modsDir),
        problems
    };
}

/**
 * 组件级边界判断：`/games/Stardew-old` 不是 `/games/Stardew` 的内部；
 * Linux 上按真实大小写比较。
 */
export function assertInside(root, target, platform = 'linux') {
    const absolute = path.resolve(target);
    if (!isPathInside(root, absolute, platform)) {
        return { ok: false, absolute, reason: `目标不在允许目录内：${absolute}（允许：${root}）` };
    }
    if (absolute === path.resolve(root)) {
        return { ok: false, absolute, reason: `目标不能是允许目录本身：${absolute}` };
    }
    let component = path.parse(absolute).root;
    for (const segment of absolute.slice(component.length).split(path.sep)) {
        if (!segment) continue;
        component = path.join(component, segment);
        try {
            if (lstatSync(component).isSymbolicLink()) {
                return { ok: false, absolute, reason: `不操作含符号链接的路径：${component}` };
            }
        } catch (error) {
            if (error.code !== 'ENOENT') return { ok: false, absolute, reason: `无法检查路径：${component}（${error.code}）` };
        }
    }
    return { ok: true, absolute, reason: null };
}

/** 游戏是否在运行：按可执行文件真实路径/cwd/命令行匹配，不按进程名一刀切。 */
export function isGameRunning({ gameRoot, platform = 'linux', procRoot = '/proc' }) {
    if (platform !== 'linux') {
        return { running: null, pids: [], reason: '当前平台不支持在 MJS 入口判断进程状态；Windows 请使用 .ps1 入口。' };
    }
    const needle = gameRoot;
    const pids = [];
    let entries;
    try {
        entries = readdirSync(procRoot, { withFileTypes: true });
    } catch {
        return { running: null, pids: [], reason: `无法读取 ${procRoot}，无法确认游戏进程状态。` };
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (pid === process.pid) continue;
        const base = path.join(procRoot, entry.name);
        let exe = null;
        try {
            exe = readlinkSync(path.join(base, 'exe'));
        } catch {
            exe = null;
        }
        let cmdline = '';
        try {
            cmdline = readFileSync(path.join(base, 'cmdline'), 'utf8');
        } catch {
            cmdline = '';
        }
        let cwd = null;
        try {
            cwd = readlinkSync(path.join(base, 'cwd'));
        } catch {
            cwd = null;
        }
        const exeInside = exe !== null && isPathInside(gameRoot, stripDeletedSuffix(exe), 'linux');
        const cwdInside = cwd !== null && stripDeletedSuffix(cwd) === gameRoot;
        const cmdInside = cmdline.split('\u0000').some((arg) => {
            if (!arg) return false;
            if (arg.includes(`${GAME_DLL}`) || arg.includes(`${path.sep}${GAME_DIR_NAME}`)) {
                return arg.includes(gameRoot);
            }
            return false;
        });
        if (exeInside || cwdInside || cmdInside) pids.push(pid);
    }
    return {
        running: pids.length > 0,
        pids,
        reason: pids.length > 0 ? `检测到游戏相关进程：${pids.join(', ')}` : null
    };
}

function stripDeletedSuffix(value) {
    return value.replace(/ \(deleted\)$/, '');
}

/** 本应用的安装记录（位于数据根，不在游戏目录里乱写文件）。 */
export function installRecordPath(dataRoot) {
    return path.join(dataRoot, 'mod-install.json');
}

export function readInstallRecord(dataRoot) {
    try {
        const file = installRecordPath(dataRoot);
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

/** 读取 mods 目录下所有同时含 manifest.json 的目录及其 UniqueID。 */
export function listModDirs(modsDir) {
    const out = [];
    if (!isDir(modsDir)) return out;
    for (const entry of readdirSync(modsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(modsDir, entry.name);
        const manifestFile = path.join(dir, 'manifest.json');
        if (!isFile(manifestFile)) {
            out.push({ dir, name: entry.name, manifest: null, uniqueId: null, broken: true });
            continue;
        }
        let manifest = null;
        try {
            manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
        } catch {
            manifest = null;
        }
        out.push({
            dir,
            name: entry.name,
            manifest,
            uniqueId: typeof manifest?.UniqueID === 'string' ? manifest.UniqueID : null,
            broken: manifest === null
        });
    }
    return out;
}

export function isBridgeUniqueId(uniqueId) {
    return uniqueId === MOD_ID || LEGACY_MOD_IDS.includes(uniqueId);
}
