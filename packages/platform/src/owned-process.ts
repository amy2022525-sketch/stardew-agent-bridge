/**
 * 进程归属：只操作「本次启动的」进程。
 *
 * - Linux 上用 `/proc/<pid>/stat` 的 starttime（第 22 个字段）与 `/proc/<pid>/exe`
 *   作为启动身份，避免 PID 复用后被误判为同一进程；
 * - 绝不按进程名批量结束 Node 或游戏；
 * - 无法确认身份时返回 `unknown`，由调用方保守处理。
 */
import { closeSync, openSync, readFileSync, readSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import type { PlatformId } from './data-root.js';

export interface ProcessIdentity {
    pid: number;
    /** Linux 进程启动时刻（jiffies 计数，字符串保存避免精度问题）；Windows 上为 null。 */
    startTime: string | null;
    /** 可执行文件真实路径（Linux `/proc/<pid>/exe`）；不可得时为 null。 */
    exePath: string | null;
}

export interface ProcessProbeOptions {
    platform?: PlatformId;
    procRoot?: string;
}

function procRootOf(options: ProcessProbeOptions): string {
    return options.procRoot ?? '/proc';
}

function readProcStat(pid: number, procRoot: string): string | null {
    try {
        const text = readFileSync(path.posix.join(procRoot, String(pid), 'stat'), 'utf8');
        // comm 字段可能包含空格与括号，取最后一个 ')' 之后的部分。
        const index = text.lastIndexOf(')');
        return index >= 0 ? text.slice(index + 1).trim() : null;
    } catch {
        return null;
    }
}

/** starttime 是整个 stat 行的第 22 个字段；comm 之后 state 是第 3 个字段。 */
export function parseProcStartTime(statTail: string): string | null {
    const fields = statTail.split(/\s+/);
    const value = fields[19];
    return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

export function readProcessIdentity(pid: number, options: ProcessProbeOptions = {}): ProcessIdentity | null {
    const platform = options.platform ?? 'linux';
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (platform === 'win32') {
        if (!isPidAlive(pid)) return null;
        return { pid, startTime: null, exePath: null };
    }
    const procRoot = procRootOf(options);
    const stat = readProcStat(pid, procRoot);
    if (stat === null) return null;
    let exePath: string | null = null;
    try {
        exePath = readlinkSync(path.posix.join(procRoot, String(pid), 'exe'));
    } catch {
        exePath = null;
    }
    return { pid, startTime: parseProcStartTime(stat), exePath };
}

export function processIdentityOfCurrentProcess(options: ProcessProbeOptions = {}): ProcessIdentity {
    return (
        readProcessIdentity(process.pid, options) ?? {
            pid: process.pid,
            startTime: null,
            exePath: process.execPath
        }
    );
}

/** 裸 PID 存活判断（`kill(pid, 0)`），只用于兜底，不用于判定归属。 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'EPERM';
    }
}

/**
 * 归属判断：PID 存在 **且** 启动身份一致才算同一个进程。
 * 记录里没有 startTime（例如 Windows 或旧锁文件）时退回 PID 存活判断，并由调用方在报告里标注。
 */
export function isIdentityAlive(identity: Pick<ProcessIdentity, 'pid' | 'startTime'>, options: ProcessProbeOptions = {}): boolean {
    const platform = options.platform ?? 'linux';
    if (platform === 'win32') return isPidAlive(identity.pid);
    const current = readProcessIdentity(identity.pid, options);
    if (!current) return false;
    if (identity.startTime === null || current.startTime === null) return true;
    return identity.startTime === current.startTime;
}

export type TerminateResult = 'sent' | 'not_owned' | 'gone';

/**
 * 只结束身份匹配的进程。身份不一致（PID 复用）时返回 not_owned，绝不误杀。
 */
export function terminateIdentity(
    identity: ProcessIdentity,
    signal: NodeJS.Signals = 'SIGTERM',
    options: ProcessProbeOptions = {}
): TerminateResult {
    if (!isIdentityAlive(identity, options)) return 'gone';
    if (identity.startTime !== null) {
        const current = readProcessIdentity(identity.pid, options);
        if (!current || (current.startTime !== null && current.startTime !== identity.startTime)) return 'not_owned';
    }
    try {
        process.kill(identity.pid, signal);
        return 'sent';
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'not_owned';
    }
}

/** 读取本机既有文件的首字节，用于识别 ELF/PE（打包与运行时校验用，不执行文件）。 */
export function sniffBinaryKind(file: string): 'elf' | 'pe' | 'script' | 'unknown' {
    let fd: number | null = null;
    try {
        fd = openSync(file, 'r');
        const head = Buffer.alloc(4);
        const read = readSync(fd, head, 0, 4, 0);
        if (read >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf';
        if (read >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'pe';
        if (read >= 2 && head[0] === 0x23 && head[1] === 0x21) return 'script';
        return 'unknown';
    } catch {
        return 'unknown';
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

export interface ElfHeader {
    kind: 'elf';
    class: 32 | 64;
    machine: number;
    machineName: string;
    compatibleWithLinuxX64: boolean;
}

/** 解析 ELF 头（不执行文件）：用于验证包内 Node 是 Linux x64 构建。 */
export function inspectElfHeader(file: string): ElfHeader | null {
    let fd: number | null = null;
    try {
        fd = openSync(file, 'r');
        const head = Buffer.alloc(20);
        const read = readSync(fd, head, 0, 20, 0);
        if (read < 20) return null;
        if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) return null;
        const bits = head[4] === 2 ? 64 : 32;
        const machine = head[18] === undefined || head[19] === undefined ? 0 : head[18] | (head[19] << 8);
        const machineName = machine === 62 ? 'x86-64' : machine === 183 ? 'aarch64' : `machine-${machine}`;
        return { kind: 'elf', class: bits, machine, machineName, compatibleWithLinuxX64: bits === 64 && machine === 62 };
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
