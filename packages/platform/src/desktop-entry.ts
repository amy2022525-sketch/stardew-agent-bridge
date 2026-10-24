/**
 * Linux 桌面入口（Desktop Entry）生成与移除。
 *
 * 依据 Desktop Entry 规范：
 * - `Exec` 只写已解析的绝对路径，绝不经 `sh -c`；
 * - 参数按规范转义（引号、反斜杠、`$`、反引号、`%` 字段码）；
 * - 菜单入口写进有效 `XDG_DATA_HOME` 下的 `applications/`；
 * - `--desktop-shortcut` 通过 `user-dirs.dirs` / `xdg-user-dir` 找到真实桌面目录（兼容中文“桌面”）；
 * - 只移除带本项目归属标记的入口，绝不删除用户数据。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, PUBLIC_FILE_MODE } from './fs-safe.js';
import type { PlatformId } from './data-root.js';

export const DESKTOP_MANAGED_MARKER = 'X-SAB-Managed=true';
export const DESKTOP_ENTRY_FILENAME = 'stardew-agent-bridge.desktop';

export interface DesktopEntryContext {
    env: Record<string, string | undefined>;
    homeDir: string;
    platform?: PlatformId;
    /** 可注入的命令执行器（生产代码用 spawnSync），便于测试。 */
    runCommand?: (file: string, args: string[]) => { status: number | null; stdout: string };
}

/**
 * 按 Desktop Entry 规范转义单个 Exec 参数。
 * 含保留字符的参数整体加双引号，内部 `"`、`` ` ``、`$`、`\` 用反斜杠转义，`%` 变成 `%%`。
 */
export function escapeExecArgument(value: string, options: { quoteAlways?: boolean } = {}): string {
    const percentEscaped = value.replace(/%/g, '%%');
    const reserved = /[\s"'\\><~|&;$*?#()`]/;
    if (!options.quoteAlways && !reserved.test(percentEscaped) && percentEscaped.length > 0) return percentEscaped;
    const escaped = percentEscaped.replace(/(["`$\\])/g, '\\$1');
    return `"${escaped}"`;
}

export function buildExecLine(execPath: string, args: string[]): string {
    return [execPath, ...args].map((part) => escapeExecArgument(part)).join(' ');
}

export interface DesktopEntrySpec {
    name: string;
    nameLocalized?: string | undefined;
    comment: string;
    execPath: string;
    args: string[];
    iconPath: string;
    workingDirectory?: string | undefined;
    terminal?: boolean;
    extraActions?: { id: string; name: string; execPath: string; args: string[] }[];
}

export function renderDesktopEntry(spec: DesktopEntrySpec): string {
    const lines = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.5',
        `Name=${spec.name}`,
        `Name[zh_CN]=${spec.nameLocalized ?? spec.name}`,
        `Comment=${spec.comment}`,
        `Exec=${buildExecLine(spec.execPath, spec.args)}`,
        `Icon=${spec.iconPath}`,
        'Terminal=false',
        'Categories=Utility;Game;',
        'StartupNotify=false',
        DESKTOP_MANAGED_MARKER
    ];
    if (spec.workingDirectory) lines.push(`Path=${spec.workingDirectory}`);
    return `${lines.join('\n')}\n`;
}

function posixJoin(...parts: string[]): string {
    return path.posix.join(...parts);
}

function isAbsolutePosix(value: string): boolean {
    return value.startsWith('/');
}

/** 有效 XDG_DATA_HOME：绝对、非空；否则回退 `~/.local/share`。 */
export function resolveXdgDataHome(ctx: DesktopEntryContext): { path: string; source: 'XDG_DATA_HOME' | 'default' } {
    const raw = (ctx.env['XDG_DATA_HOME'] ?? '').trim();
    if (raw && isAbsolutePosix(raw)) return { path: raw, source: 'XDG_DATA_HOME' };
    if (!ctx.homeDir) throw new Error('缺少用户主目录，无法确定 applications 目录；请设置 XDG_DATA_HOME。');
    return { path: posixJoin(ctx.homeDir, '.local', 'share'), source: 'default' };
}

export function resolveApplicationsDir(ctx: DesktopEntryContext): string {
    return posixJoin(resolveXdgDataHome(ctx).path, 'applications');
}

function expandHome(value: string, homeDir: string): string {
    return value.replace(/^\$HOME/, homeDir).replace(/^~(?=\/|$)/, homeDir);
}

/** 从 `~/.config/user-dirs.dirs` 读取桌面目录（兼容中文“桌面”等本地化名称）。 */
export function readUserDirsDesktop(file: string, homeDir: string): string | null {
    try {
        if (!existsSync(file)) return null;
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        for (const line of text.split(/\r?\n/)) {
            const match = /^\s*XDG_DESKTOP_DIR\s*=\s*"(.*)"\s*$/.exec(line);
            if (!match) continue;
            const value = expandHome(match[1] ?? '', homeDir).trim();
            if (value && isAbsolutePosix(value)) return value;
        }
        return null;
    } catch {
        return null;
    }
}

export interface DesktopDirResolution {
    path: string;
    source: 'user-dirs.dirs' | 'xdg-user-dir' | 'fallback';
}

/** 真实桌面目录：user-dirs.dirs → `xdg-user-dir DESKTOP` → `~/Desktop`。 */
export function resolveDesktopDir(ctx: DesktopEntryContext): DesktopDirResolution {
    const userDirs = readUserDirsDesktop(posixJoin(ctx.homeDir, '.config', 'user-dirs.dirs'), ctx.homeDir);
    if (userDirs) return { path: userDirs, source: 'user-dirs.dirs' };
    const runner = ctx.runCommand;
    if (runner) {
        try {
            const result = runner('xdg-user-dir', ['DESKTOP']);
            const output = result.stdout.trim();
            if (result.status === 0 && output && isAbsolutePosix(output)) {
                return { path: output, source: 'xdg-user-dir' };
            }
        } catch {
            /* 命令不存在时退回默认目录 */
        }
    }
    if (!ctx.homeDir) throw new Error('缺少用户主目录，无法确定桌面目录。');
    return { path: posixJoin(ctx.homeDir, 'Desktop'), source: 'fallback' };
}

export interface InstallDesktopEntryOptions {
    ctx: DesktopEntryContext;
    spec: Omit<DesktopEntrySpec, 'execPath' | 'args'> & { execPath: string; args: string[] };
    /** 是否额外创建用户桌面快捷方式。 */
    desktopShortcut?: boolean;
    /** 需要复制到数据目录的项目图标源文件；不存在时返回说明而不是伪造路径。 */
    iconSource?: string | undefined;
    /** 图标落地目录（一般是 <dataRoot>/icons）；为空时直接用 iconPath。 */
    iconTargetDir?: string | undefined;
}

export interface InstallDesktopEntryResult {
    ok: boolean;
    entryFile: string;
    desktopFile: string | null;
    iconPath: string;
    notes: string[];
    code?: 'ICON_MISSING' | 'PLATFORM_UNSUPPORTED' | 'ENTRY_EXISTS';
}

export interface RemoveDesktopEntryResult {
    ok: boolean;
    removed: string[];
    skipped: string[];
    notes: string[];
}

function resolveIcon(
    options: InstallDesktopEntryOptions
): { ok: true; iconPath: string; notes: string[] } | { ok: false; code: 'ICON_MISSING'; notes: string[] } {
    const notes: string[] = [];
    const { iconSource, iconTargetDir } = options;
    if (iconSource && iconTargetDir && existsSync(iconSource)) {
        mkdirSync(iconTargetDir, { recursive: true });
        const target = path.join(iconTargetDir, path.basename(iconSource));
        writeFileSync(target, readFileSync(iconSource));
        chmodSync(target, PUBLIC_FILE_MODE);
        notes.push(`项目图标已复制到 ${target}。`);
        return { ok: true, iconPath: target, notes };
    }
    const declared = options.spec.iconPath;
    if (declared && existsSync(declared)) return { ok: true, iconPath: declared, notes };
    return {
        ok: false,
        code: 'ICON_MISSING',
        notes: [`找不到项目图标文件（${iconSource ?? declared ?? '未指定'}）。本程序不复制游戏官方图标，请先运行 npm run build 或使用完整发布包。`]
    };
}

/** 安装菜单入口，可选创建桌面快捷方式。已存在时覆盖同一路径（幂等）。 */
export function installDesktopEntry(options: InstallDesktopEntryOptions): InstallDesktopEntryResult {
    const ctx = options.ctx;
    if ((ctx.platform ?? 'linux') === 'win32') {
        return {
            ok: false,
            entryFile: '',
            desktopFile: null,
            iconPath: '',
            notes: ['桌面入口只适用于 Linux；Windows 请使用 .ps1 入口或快捷方式。'],
            code: 'PLATFORM_UNSUPPORTED'
        };
    }
    const applicationsDir = resolveApplicationsDir(ctx);
    mkdirSync(applicationsDir, { recursive: true });
    const entryFile = posixJoin(applicationsDir, DESKTOP_ENTRY_FILENAME);
    const notes: string[] = [];
    if (existsSync(entryFile) && !isManagedEntry(entryFile)) {
        return { ok: false, entryFile, desktopFile: null, iconPath: '', notes: ['同名菜单入口不属于本项目，已保留并拒绝覆盖。'], code: 'ENTRY_EXISTS' };
    }

    const icon = resolveIcon(options);
    notes.push(...icon.notes);
    const iconPath = icon.ok ? icon.iconPath : '';

    const body = renderDesktopEntry({ ...options.spec, iconPath });
    atomicWriteFile(entryFile, body, { platform: 'linux', mode: 0o755 });
    chmodSync(entryFile, 0o755);
    notes.push(`菜单入口：${entryFile}（0755）。用 desktop-file-validate 与实际点击验收。`);

    let desktopFile: string | null = null;
    if (options.desktopShortcut) {
        const desktop = resolveDesktopDir(ctx);
        try {
            mkdirSync(desktop.path, { recursive: true });
            desktopFile = posixJoin(desktop.path, DESKTOP_ENTRY_FILENAME);
            if (existsSync(desktopFile) && !isManagedEntry(desktopFile)) throw new Error('同名桌面文件不属于本项目，已保留。');
            atomicWriteFile(desktopFile, body, { platform: 'linux', mode: 0o755 });
            chmodSync(desktopFile, 0o755);
            notes.push(`桌面快捷方式：${desktopFile}（来源 ${desktop.source}）。`);
        } catch (error) {
            notes.push(`创建桌面快捷方式失败（${desktop.path}）：${error instanceof Error ? error.message : String(error)}`);
            desktopFile = null;
        }
    }
    return { ok: icon.ok, entryFile, desktopFile, iconPath, notes, ...(icon.ok ? {} : { code: icon.code }) };
}

function isManagedEntry(file: string): boolean {
    try {
        const text = readFileSync(file, 'utf8');
        return text.includes(DESKTOP_MANAGED_MARKER);
    } catch {
        return false;
    }
}

/** 只移除带本项目标记的入口；其他文件原样保留并说明。 */
export function removeDesktopEntry(options: { ctx: DesktopEntryContext; desktopShortcut?: boolean }): RemoveDesktopEntryResult {
    const ctx = options.ctx;
    const removed: string[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    const targets: string[] = [posixJoin(resolveApplicationsDir(ctx), DESKTOP_ENTRY_FILENAME)];
    if (options.desktopShortcut !== false) {
        try {
            targets.push(posixJoin(resolveDesktopDir(ctx).path, DESKTOP_ENTRY_FILENAME));
        } catch {
            /* 桌面目录不可得时只处理菜单入口 */
        }
    }
    for (const file of targets) {
        if (!existsSync(file)) continue;
        if (!isManagedEntry(file)) {
            skipped.push(file);
            notes.push(`${file} 不属于本项目（缺少 ${DESKTOP_MANAGED_MARKER}），已跳过。`);
            continue;
        }
        try {
            const mode = statSync(file).mode;
            void mode;
            rmSync(file, { force: true });
            removed.push(file);
        } catch (error) {
            notes.push(`移除 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (removed.length === 0 && skipped.length === 0) notes.push('没有找到本项目安装的桌面入口。');
    notes.push('移除桌面入口不会删除数据目录、凭据、账本或游戏存档。');
    return { ok: true, removed, skipped, notes };
}
