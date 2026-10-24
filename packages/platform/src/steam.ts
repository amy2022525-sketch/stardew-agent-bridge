/**
 * Steam/GOG 目录候选与 `libraryfolders.vdf` 解析（纯函数，不读写磁盘）。
 *
 * 只解析出「路径数据」：任何来自 VDF 或用户输入的路径都只作为数据使用，
 * 不参与 shell 命令拼接，也不会被当成命令执行。
 */
import path from 'node:path';
import type { PlatformId } from './data-root.js';

export interface SteamRootCandidate {
    /** 候选 Steam 根目录。 */
    path: string;
    /**
     * primary：官方推荐入口；
     * additional：兼容入口（旧式符号链接目录）；
     * sandboxed：Flatpak/Snap 等沙箱路径，只能被诊断发现，不能据此宣称支持。
     */
    strength: 'primary' | 'additional' | 'sandboxed';
}

/** Linux 上可能存在的 Steam 根目录；调用方负责 realpath 与存在性检查。 */
export function steamRootCandidates(homeDir: string, platform: PlatformId = 'linux'): SteamRootCandidate[] {
    if (platform === 'win32') {
        return [
            { path: path.win32.join('C:\\Program Files (x86)\\Steam'), strength: 'primary' },
            { path: path.win32.join('C:\\Program Files\\Steam'), strength: 'additional' }
        ];
    }
    const home = homeDir || '';
    return [
        { path: path.posix.join(home, '.local', 'share', 'Steam'), strength: 'primary' },
        { path: path.posix.join(home, '.steam', 'steam'), strength: 'primary' },
        { path: path.posix.join(home, '.steam', 'root'), strength: 'additional' },
        { path: path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), strength: 'sandboxed' },
        { path: path.posix.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), strength: 'sandboxed' }
    ];
}

/** VDF 转义还原：`\\\\` → `\`，`\"` → `"`。顺序固定，避免二次反转义。 */
export function unescapeVdfString(raw: string): string {
    return raw.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

/**
 * 从 `libraryfolders.vdf` 文本里取出所有 Steam 库根（`"path" "<目录>"`）。
 * 支持旧式 `"1" { "path" ... }` 与新版带 `apps` 段的格式；不 grep 后拼命令。
 */
export function parseLibraryFoldersVdf(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const pattern = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const raw = match[1];
        if (typeof raw !== 'string') continue;
        const value = unescapeVdfString(raw).trim();
        if (!value) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

/** 某个 Steam 库根下的星露谷目录。 */
export function gameRootInLibrary(libraryRoot: string, platform: PlatformId = 'linux'): string {
    return platform === 'win32'
        ? path.win32.join(libraryRoot, 'steamapps', 'common', 'Stardew Valley')
        : path.posix.join(libraryRoot, 'steamapps', 'common', 'Stardew Valley');
}

export const GAME_DLL_NAME = 'Stardew Valley.dll';
export const SMAPI_DLL_NAME = 'StardewModdingAPI.dll';
export const SMAPI_INTERNAL_DIR = 'smapi-internal';

/**
 * 组件级边界判断：`/games/Stardew-old` 不算 `/games/Stardew` 的内部。
 * Linux 上按真实大小写比较，不做大小写折叠。
 */
export function isPathInside(root: string, candidate: string, platform: PlatformId = 'linux'): boolean {
    const api = platform === 'win32' ? path.win32 : path.posix;
    const normalize = (value: string): string => {
        const resolved = api.resolve(value);
        return platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const boundary = normalize(root);
    const target = normalize(candidate);
    if (target === boundary) return true;
    const withSep = boundary.endsWith(api.sep) ? boundary : `${boundary}${api.sep}`;
    return target.startsWith(withSep);
}

/** 相对边界检查：把 candidate 相对 root 的路径分段，拒绝 `..` 逃逸。 */
export function relativeInside(root: string, candidate: string, platform: PlatformId = 'linux'): string | null {
    if (!isPathInside(root, candidate, platform)) return null;
    const api = platform === 'win32' ? path.win32 : path.posix;
    const rel = api.relative(api.resolve(root), api.resolve(candidate));
    if (!rel) return '.';
    if (rel.split(/[\\/]/).includes('..')) return null;
    return rel.split(/[\\/]/).join('/');
}
