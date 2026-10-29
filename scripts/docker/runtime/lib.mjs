#!/usr/bin/env node
/**
 * 容器运行时公共辅助（纯函数 + 受控文件操作）。
 *
 * 只依赖 Node 标准库，便于被 esbuild 打进 /opt/sab 的单文件 bundle，
 * 也便于单元测试注入临时目录。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    statfsSync,
    unlinkSync,
    writeSync
} from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PUBLIC_FILE_MODE = 0o644;

export function isoNow(now = new Date()) {
    return now.toISOString();
}

export function newNonce(bytes = 8) {
    return randomBytes(bytes).toString('hex');
}

export function readJsonIfExists(file) {
    try {
        if (!existsSync(file)) return null;
        if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 32 * 1024 * 1024) return null;
        return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

/** 原子写：同目录临时文件 → fsync → rename；权限在创建时即生效。 */
export function atomicWriteFile(file, data, { mode = PRIVATE_FILE_MODE } = {}) {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}-${newNonce(3)}`);
    let fd = null;
    try {
        fd = openSync(tmp, 'wx', mode);
        try {
            writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
            fd = null;
        }
        renameSync(tmp, file);
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
            /* 临时文件可能未创建 */
        }
        throw error;
    }
}

export function atomicWriteJson(file, value, options = {}) {
    atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function sha256OfFile(file) {
    const hash = createHash('sha256');
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(256 * 1024);
        let bytes;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
        return hash.digest('hex');
    } finally { closeSync(fd); }
}

export function sha256OfText(text) {
    return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** 读取文件头 N 字节（不整文件读入，避免把 GB 级游戏二进制读进内存）。 */
function readHead(file, bytes) {
    let fd = null;
    try {
        fd = openSync(file, 'r');
        const buffer = Buffer.alloc(bytes);
        const read = readSync(fd, buffer, 0, bytes, 0);
        return buffer.subarray(0, read);
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                /* 忽略 */
            }
        }
    }
}

/** 首 4 字节类型嗅探（不执行文件）。 */
export function sniffKind(file) {
    const head = readHead(file, 4);
    if (!head || head.length < 2) return 'unknown';
    if (head.length >= 4 && head[0] === 0x7f && head.subarray(1, 4).toString('ascii') === 'ELF') return 'elf';
    if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
    if (head[0] === 0x23 && head[1] === 0x21) return 'script';
    return 'unknown';
}

export function inspectElf(file) {
    const head = readHead(file, 20);
    if (!head || head.length < 20) return null;
    if (!(head[0] === 0x7f && head.subarray(1, 4).toString('ascii') === 'ELF')) return null;
    const bits = head[4] === 2 ? 64 : 32;
    const machine = head[18] | (head[19] << 8);
    return {
        class: bits,
        machine,
        machineName: machine === 62 ? 'x86-64' : machine === 183 ? 'aarch64' : `machine-${machine}`,
        compatibleWithLinuxX64: bits === 64 && machine === 62
    };
}

export function modeOf(file) {
    try {
        return lstatSync(file).mode & 0o777;
    } catch {
        return null;
    }
}

export function isExecutable(file) {
    const mode = modeOf(file);
    return mode !== null && (mode & 0o111) !== 0;
}

export function isSymlink(file) {
    try {
        return lstatSync(file).isSymbolicLink();
    } catch {
        return false;
    }
}

export function isInside(root, candidate) {
    const normalizedRoot = path.resolve(root);
    const normalized = path.resolve(candidate);
    if (normalized === normalizedRoot) return true;
    return normalized.startsWith(`${normalizedRoot}${path.sep}`);
}

/** realpath 必须在 root 内；用于拒绝指到输入根之外的符号链接。 */
export function realpathInside(root, candidate) {
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(candidate);
        return isInside(realRoot, real);
    } catch {
        return false;
    }
}

export function listEntries(dir) {
    return readdirSync(dir, { withFileTypes: true });
}

/**
 * 受控递归复制：保留常规权限位，拒绝符号链接/设备/FIFO。
 * 用于工作副本初始化；不跟随符号链接，也不复制到输入根之外。
 */
export function copyTreeSafe(from, to, { maxEntries = 200_000, skip = () => false, privateFiles = false, allowInternalSymlinks = false } = {}) {
    const copied = [];
    const rejected = [];
    let count = 0;
    const walk = (source, target, prefix) => {
        mkdirSync(target, { recursive: true, mode: privateFiles ? 0o700 : 0o755 });
        for (const entry of listEntries(source)) {
            let sourcePath = path.join(source, entry.name);
            const targetPath = path.join(target, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (skip(rel, entry)) continue;
            let stat;
            try {
                stat = lstatSync(sourcePath);
            } catch {
                rejected.push({ path: rel, reason: 'UNREADABLE' });
                continue;
            }
            if (stat.isSymbolicLink()) {
                const resolved = realpathSync(sourcePath);
                if (!allowInternalSymlinks || !isInside(realpathSync(from), resolved) || lstatSync(resolved).isDirectory()) {
                    rejected.push({ path: rel, reason: 'SYMLINK' });
                    continue;
                }
                sourcePath = resolved;
                stat = lstatSync(resolved);
            }
            if (stat.isFIFO?.() || stat.isSocket?.() || stat.isBlockDevice?.() || stat.isCharacterDevice?.()) {
                rejected.push({ path: rel, reason: 'SPECIAL_FILE' });
                continue;
            }
            count += 1;
            if (count > maxEntries) throw new Error(`复制条目数超过上限 ${maxEntries}，已中止（可能不是游戏目录）。`);
            if (stat.isDirectory()) {
                walk(sourcePath, targetPath, rel);
                continue;
            }
            if (!stat.isFile() || stat.nlink > 1) {
                rejected.push({ path: rel, reason: 'SPECIAL_OR_HARDLINK' });
                continue;
            }
            copyFileSync(sourcePath, targetPath);
            try {
                chmodSync(targetPath, privateFiles ? 0o600 : stat.mode & 0o777);
            } catch {
                /* 某些卷不支持改权限，保留默认 */
            }
            copied.push(rel);
        }
    };
    walk(from, to, '');
    return { copied, rejected, count };
}

/** 目录清单：相对路径 → {size, mode, sha256}；不跟随符号链接。 */
export function hashTree(dir, { maxEntries = 200_000, maxBytes = 32 * 1024 ** 3, skip = () => false } = {}) {
    const out = {};
    let count = 0;
    let bytes = 0;
    const walk = (current, prefix) => {
        for (const entry of listEntries(current)) {
            const full = path.join(current, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (skip(rel, entry)) continue;
            safeRelative(rel);
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) throw new Error(`SYMLINK_REJECTED: ${rel}`);
            if (stat.isDirectory()) {
                walk(full, rel);
                continue;
            }
            count += 1;
            if (count > maxEntries) throw new Error(`清单条目数超过上限 ${maxEntries}。`);
            if (!stat.isFile() || stat.nlink > 1) throw new Error(`SPECIAL_OR_HARDLINK_REJECTED: ${rel}`);
            bytes += stat.size;
            if (bytes > maxBytes) throw new Error('文件总大小超过限制。');
            out[rel] = { size: stat.size, mode: (stat.mode & 0o777).toString(8).padStart(4, '0'), sha256: sha256OfFile(full) };
        }
    };
    walk(dir, '');
    return out;
}

/** A portable, unambiguous payload name. Never permit Windows drive/ADS or traversal forms. */
export function safeRelative(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('UNSAFE_PATH');
    }
    return value;
}

/** Validate a resolved target and every existing ancestor before writes or recursive cleanup. */
export function ownedPath(root, candidate, { allowRoot = false } = {}) {
    const base = path.resolve(root);
    const target = path.resolve(candidate);
    if (!isInside(base, target) || (!allowRoot && base === target)) throw new Error('PATH_OUTSIDE_OWNER');
    let current = base;
    for (const part of ['', ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
        if (part) current = path.join(current, part);
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_OWNER_PATH');
    }
    return target;
}

export function processStartToken(pid = process.pid) {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; }
    catch { return null; }
}

/** 只核对关键文件（不做全量哈希）：普通重启路径用。 */
export function verifyKeyFiles(dir, keys) {
    const problems = [];
    for (const key of keys) {
        const file = path.join(dir, key);
        if (!existsSync(file)) problems.push(`缺少关键文件：${key}`);
    }
    return problems;
}

export function freeBytes(target) {
    try {
        const stat = statfsSync(target);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch {
        return null;
    }
}

export function humanBytes(bytes) {
    if (bytes === null || bytes === undefined) return '未知';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = Number(bytes);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 状态文件写入（原子、0600）；generation + startNonce 让健康检查能拒绝旧状态。 */
export function writeStatusFile(file, status) {
    atomicWriteJson(file, { ...status, updatedAt: isoNow() }, { mode: PRIVATE_FILE_MODE });
}

/** 简单组件前缀日志（写 stderr，由 Docker json-file 轮换）。 */
export function componentLogger(component) {
    return (level, message, meta) => {
        const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
        process.stderr.write(`${new Date().toISOString()} [${component}] ${level} ${message}${suffix}\n`);
    };
}
