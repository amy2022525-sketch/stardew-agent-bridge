/**
 * 私有目录/文件的权限与原子写入。
 *
 * 约束：
 * - 专用应用根新建为 0700，凭据、锁、endpoint 等私人文件为 0600；
 * - 写入采用「同目录临时文件 + fsync + 原子 rename」，不暴露半截 JSON；
 * - 只处理本应用自己的文件，绝不递归 chmod 用户 HOME、Steam 目录或其他祖先。
 */
import { createHash } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync
} from 'node:fs';
import path from 'node:path';
import type { PlatformId } from './data-root.js';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PUBLIC_FILE_MODE = 0o644;

export interface FsOptions {
    platform?: PlatformId;
}

function posix(platform: PlatformId | undefined): boolean {
    return (platform ?? 'linux') !== 'win32';
}

export function fileExists(candidate: string): boolean {
    try {
        return existsSync(candidate);
    } catch {
        return false;
    }
}

export function modeOf(candidate: string): number | null {
    try {
        return statSync(candidate).mode & 0o777;
    } catch {
        return null;
    }
}

export function isSymlink(candidate: string): boolean {
    try {
        return lstatSync(candidate).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * 自动初始化的数据根不能是 `/` 或用户 HOME 本身：必须是专用子目录。
 */
export function assertDedicatedRoot(root: string, options: { homeDir: string; platform?: PlatformId } = { homeDir: '' }): void {
    const platform = options.platform ?? 'linux';
    const normalized = path.posix.normalize(root.replace(/\\/g, '/'));
    if (normalized === '/' || normalized === '') {
        throw new Error(`拒绝把文件系统根目录当作应用数据根：${root}`);
    }
    if (options.homeDir) {
        const home = path.posix.normalize(options.homeDir.replace(/\\/g, '/'));
        if (normalized === home) {
            throw new Error(`拒绝把用户主目录本身当作应用数据根：${root}（请使用专用子目录）`);
        }
    }
    if (platform === 'win32' && /^[a-zA-Z]:[\\/]?$/.test(root)) {
        throw new Error(`拒绝把驱动器根目录当作应用数据根：${root}`);
    }
}

/** 新建私有目录（0700）；已存在的目录不动其权限。 */
export function ensurePrivateDir(dir: string, options: FsOptions = {}): void {
    if (!fileExists(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (posix(options.platform)) {
        const mode = modeOf(dir);
        // 只修正本应用创建的目录本身；不递归、不触碰祖先。
        if (mode !== null && mode !== PRIVATE_DIR_MODE) chmodSync(dir, PRIVATE_DIR_MODE);
    }
}

/** 把已有文件修正到期望模式；不是本应用文件时由调用方决定是否调用。 */
export function ensureFileMode(file: string, mode: number, options: FsOptions = {}): boolean {
    if (!posix(options.platform)) return false;
    const current = modeOf(file);
    if (current === null || current === mode) return false;
    chmodSync(file, mode);
    return true;
}

export interface AtomicWriteOptions extends FsOptions {
    mode?: number;
    encoding?: BufferEncoding;
}

/**
 * 原子写入：同目录临时文件 → fsync → rename。失败时清理临时文件并抛出。
 * `mode` 在创建临时文件时就生效，rename 之后权限随文件保留。
 */
export function atomicWriteFile(file: string, data: string | Buffer, options: AtomicWriteOptions = {}): void {
    const mode = options.mode ?? PRIVATE_FILE_MODE;
    const dir = path.dirname(file);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, options.encoding ?? 'utf8');
    const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${suffix}`);
    let fd: number | null = null;
    try {
        fd = openSync(tmp, 'wx', mode);
        try {
            writeSync(fd, buffer);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
            fd = null;
        }
        if (posix(options.platform)) chmodSync(tmp, mode);
        renameSync(tmp, file);
        ensureFileMode(file, mode, options);
    } catch (error) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                /* 忽略 */
            }
        }
        try {
            unlinkSync(tmp);
        } catch {
            /* 临时文件可能从未创建 */
        }
        throw error;
    }
}

export function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions = {}): void {
    atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function readJsonIfExists<T = unknown>(file: string): T | null {
    try {
        if (!fileExists(file)) return null;
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/** 读取文本并去掉 UTF-8 BOM（SMAPI/Windows 生成的配置常带 BOM）。 */
export function readTextFile(file: string): string {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function sha256OfFile(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sha256OfText(text: string): string {
    return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
