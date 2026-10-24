/**
 * 本机数据目录与文件布局。
 *
 * 目录解析统一走 `@sab/platform`（`resolveDataRoot`），本文件只负责把它映射成
 * 具体文件路径并提供 `DataPaths` 接口。Windows 默认 `%LOCALAPPDATA%\StardewAgentBridge`
 * 保持不变；Linux 使用 XDG 规则（见 packages/platform/src/data-root.ts）。
 *
 * 首版在一个应用根目录内保留原有相对布局：config、credentials、endpoint、ledger、
 * logs、exports、screenshots。只对应用根按 XDG_DATA_HOME 选址，不声称已经按完整
 * XDG 分类拆开配置/缓存/状态。
 */
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    APP_DIRECTORY_NAME,
    PRIVATE_DIR_MODE,
    ensurePrivateDir,
    inspectLegacyDataRoot,
    resolveDataRootForProcess,
    type LegacyDataRootReport,
    type ResolvedDataRoot
} from '@sab/platform';

export interface DataPaths {
    root: string;
    config: string;
    credentials: string;
    endpoint: string;
    ledger: string;
    logs: string;
    exports: string;
    screenshots: string;
    webDist: string;
    /** 新增：实例锁（见 apps/server/src/instance-lock.ts）。 */
    lock: string;
    /** 新增：本应用图标等静态资源落地目录。 */
    icons: string;
}

/** 完整描述（含来源），供 doctor/launch 报告使用。 */
export function resolveDataRootDescriptor(override?: string): ResolvedDataRoot {
    return resolveDataRootForProcess(override);
}

export function resolveDataDir(override?: string): string {
    return resolveDataRootDescriptor(override).path;
}

/**
 * Web 静态目录的查找顺序（发布包里 server 与 web 是同级目录，源码里在 apps/web/dist）：
 * 1. 显式参数或 SAB_WEB_DIST；
 * 2. 可执行文件（或打包后的 bridge.mjs）旁边的 web/；
 * 3. 仓库内的 apps/web/dist。
 */
function resolveWebDist(sourceRoot: string, explicit?: string): string {
    if (explicit && explicit.trim().length > 0) return path.resolve(explicit);
    const env = process.env.SAB_WEB_DIST;
    if (env && env.trim().length > 0) return path.resolve(env);
    const candidates = [
        path.join(sourceRoot, 'web'),
        path.join(sourceRoot, '..', 'web'),
        path.resolve(sourceRoot, '../../web/dist'),
        path.resolve(process.cwd(), 'web'),
        path.resolve(process.cwd(), 'apps', 'web', 'dist')
    ];
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    }
    return candidates[candidates.length - 1]!;
}

export function dataPaths(root: string, webDist?: string): DataPaths {
    return {
        root,
        config: path.join(root, 'config.json'),
        credentials: path.join(root, 'credentials.json'),
        endpoint: path.join(root, 'endpoint.json'),
        ledger: path.join(root, 'ledger.sqlite'),
        logs: path.join(root, 'logs'),
        exports: path.join(root, 'exports'),
        screenshots: path.join(root, 'screenshots'),
        webDist: resolveWebDist(sourceRoot(), webDist),
        lock: path.join(root, 'bridge.lock'),
        icons: path.join(root, 'icons')
    };
}

/** 打包后 bridge.mjs 所在目录；源码运行时为仓库根目录。 */
function sourceRoot(): string {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        return here;
    } catch {
        return process.cwd();
    }
}

/** 不依赖调用者 cwd，兼容源码树和便携发布目录。 */
export function resolveStdioAdapter(): string {
    const here = sourceRoot();
    const candidates = [
        path.join(here, 'stdio-adapter.mjs'),
        path.resolve(here, '../../../adapters/stdio/dist/index.js')
    ];
    const resolved = candidates.find(candidate => existsSync(candidate));
    if (!resolved) throw new Error('未找到 stdio 适配器，请先构建项目或检查发布包文件清单。');
    return resolved;
}

/**
 * 新建数据目录。应用根本身与私人子目录使用 0700；
 * 只处理本应用自己的目录，绝不修改祖先目录权限。
 */
export function ensureDirs(paths: DataPaths): void {
    ensurePrivateDir(paths.root);
    for (const dir of [paths.logs, paths.exports, paths.screenshots, paths.icons]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
}

/** 旧 Linux 数据根诊断（只读，不合并、不删除）。 */
export function legacyDataRootReport(paths: DataPaths): LegacyDataRootReport {
    return inspectLegacyDataRoot({
        homeDir: os.homedir(),
        currentPath: paths.root,
        env: process.env,
        exists: candidate => existsSync(candidate)
    });
}

/** 把绝对路径替换成 `<home>` / `<data>`，用于脱敏日志与问题包。 */
export function redactPath(value: string, paths?: DataPaths): string {
    let out = value;
    const home = os.homedir();
    if (home) out = out.split(home).join('<home>');
    if (paths) out = out.split(paths.root).join('<data>');
    out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, '<home>');
    return out;
}

export { APP_DIRECTORY_NAME };
