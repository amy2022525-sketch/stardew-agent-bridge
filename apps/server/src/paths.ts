/**
 * 本机数据目录与文件布局。
 *
 * 默认 `%LOCALAPPDATA%\StardewAgentBridge`（可用 SAB_HOME 覆盖）。
 * 凭据、日志、数据库与静态文件分离；这些目录都不进入仓库。
 */
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
}

export function resolveDataDir(override?: string): string {
    if (override && override.trim().length > 0) return path.resolve(override);
    if (process.env.SAB_HOME && process.env.SAB_HOME.trim().length > 0) return path.resolve(process.env.SAB_HOME);
    const base = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.length > 0 ? process.env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'StardewAgentBridge');
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
        webDist: resolveWebDist(sourceRoot(), webDist)
    };
}

/** 打包后 bridge.mjs 所在目录；源码运行时为仓库根目录。 */
function sourceRoot(): string {
    try {
        const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
        return here;
    } catch {
        return process.cwd();
    }
}

export function ensureDirs(paths: DataPaths): void {
    for (const dir of [paths.root, paths.logs, paths.exports, paths.screenshots]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
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
