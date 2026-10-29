/**
 * bridge.lock 是诊断记录；伴随目录通过原子发布非空目录串行化获取与接管。
 * owner 必须先在候选目录写完，再 rename 发布，避免 mkdir 与写 owner 之间
 * 的空目录被另一个陈旧锁清理者删除。rmdir 无法删除已发布的非空新目录。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIdentityAlive, processIdentityOfCurrentProcess, readJsonIfExists, readProcessIdentity, type PlatformId } from '@sab/platform';
export const INSTANCE_LOCK_SCHEMA_VERSION = 1;
const INCOMPLETE_GRACE_MS = 10_000;
export interface InstanceLockRecord {
    schemaVersion: number; pid: number; nonce: string; dataRoot: string; programVersion: string;
    entry: string; startedAt: string; processStart: string | null;
}
export interface InstanceLockDeps {
    platform?: PlatformId; procRoot?: string; now?: () => Date; nonce?: () => string;
}
export interface AcquireLockInput {
    lockPath: string; dataRoot: string; programVersion: string; entry?: string; deps?: InstanceLockDeps;
}
export interface InstanceLockHandle {
    readonly record: InstanceLockRecord; stillOwned(): boolean; release(): void;
}
export type AcquireLockResult =
    | { acquired: true; handle: InstanceLockHandle }
    | { acquired: false; reason: 'held' | 'unwritable'; record: InstanceLockRecord | null; message: string };
function platformOf(deps: InstanceLockDeps): PlatformId {
    return deps.platform ?? (process.platform === 'win32' ? 'win32' : 'linux');
}
export function readInstanceLock(file: string): InstanceLockRecord | null {
    const raw = readJsonIfExists<Partial<InstanceLockRecord>>(file);
    if (!raw || typeof raw.pid !== 'number' || typeof raw.nonce !== 'string') return null;
    return {
        schemaVersion: raw.schemaVersion ?? INSTANCE_LOCK_SCHEMA_VERSION, pid: raw.pid, nonce: raw.nonce,
        dataRoot: raw.dataRoot ?? '', programVersion: raw.programVersion ?? '', entry: raw.entry ?? '',
        startedAt: raw.startedAt ?? '', processStart: typeof raw.processStart === 'string' ? raw.processStart : null
    };
}
export function isInstanceLockStale(record: InstanceLockRecord, deps: InstanceLockDeps = {}): boolean {
    const options = { platform: platformOf(deps), procRoot: deps.procRoot };
    if (!Number.isInteger(record.pid) || record.pid <= 0) return true;
    if (record.processStart === null) return !isIdentityAlive({ pid: record.pid, startTime: null }, options);
    const current = readProcessIdentity(record.pid, options);
    if (!current) return true;
    return current.startTime !== null && current.startTime !== record.processStart;
}
export function writeLockFile(file: string, record: InstanceLockRecord): void {
    const tmp = file + '.tmp-' + randomUUID();
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        try { writeSync(fd, JSON.stringify(record) + '\n'); } finally { closeSync(fd); }
        renameSync(tmp, file);
    } catch (error) {
        try { unlinkSync(tmp); } catch {}
        throw error;
    }
}
function oldEnough(file: string): boolean {
    try { return Date.now() - statSync(file).mtimeMs >= INCOMPLETE_GRACE_MS; } catch { return false; }
}
function removeOwner(directory: string, ownerFile: string): void {
    try { unlinkSync(ownerFile); } catch {}
    try { rmdirSync(directory); } catch {}
}
function recoverOwnerDirectory(directory: string, deps: InstanceLockDeps): boolean {
    let names: string[];
    try { names = readdirSync(directory); } catch { return !existsSync(directory); }
    if (names.length === 0 && !oldEnough(directory)) return false;
    for (const name of names) {
        if (!/^\d+-[a-zA-Z0-9-]+\.json(?:\.tmp-[a-zA-Z0-9-]+)?$/.test(name)) return false;
        const owner = readInstanceLock(path.join(directory, name));
        if (owner) {
            if (!isInstanceLockStale(owner, deps)) return false;
        } else {
            const pid = Number(name.split('-')[0]);
            if (isIdentityAlive({ pid, startTime: null }, { platform: platformOf(deps), procRoot: deps.procRoot }) ||
                !oldEnough(path.join(directory, name))) return false;
        }
    }
    for (const name of names) {
        // 文件名含唯一 nonce。目录换代后，不会误删新实例的 owner。
        try { unlinkSync(path.join(directory, name)); } catch {}
    }
    try { rmdirSync(directory); return true; } catch { return !existsSync(directory); }
}
export function acquireInstanceLock(input: AcquireLockInput): AcquireLockResult {
    const deps = input.deps ?? {};
    const identity = processIdentityOfCurrentProcess({ platform: platformOf(deps), procRoot: deps.procRoot });
    const record: InstanceLockRecord = {
        schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION, pid: process.pid, nonce: (deps.nonce ?? randomUUID)(),
        dataRoot: input.dataRoot, programVersion: input.programVersion, entry: input.entry ?? process.argv[1] ?? '',
        startedAt: (deps.now ?? (() => new Date()))().toISOString(), processStart: identity.startTime
    };
    if (!/^[a-zA-Z0-9-]+$/.test(record.nonce)) throw new Error('实例 nonce 格式无效。');
    const directory = input.lockPath + '.owners';
    const ownerFile = path.join(directory, record.pid + '-' + record.nonce + '.json');
    const candidate = directory + '.candidate-' + record.pid + '-' + record.nonce;
    const candidateOwner = path.join(candidate, path.basename(ownerFile));
    const held = (existing = readInstanceLock(input.lockPath)): AcquireLockResult => ({
        acquired: false, reason: 'held', record: existing,
        message: '数据根 ' + input.dataRoot + ' 已有 Bridge 持锁或正在启动；同一个数据根只允许一个实例，请复用 launch/doctor。'
    });
    try {
        mkdirSync(candidate, { mode: 0o700 });
        writeLockFile(candidateOwner, record);
        for (let attempt = 0; attempt < 4; attempt++) {
            try { renameSync(candidate, directory); } catch (error) {
                // Linux 返回 ENOTEMPTY，Windows 还可能返回 EACCES/EPERM。
                // 只有目标确实存在时才走锁恢复，不能掩盖其他写入错误。
                if (existsSync(directory)) {
                    if (recoverOwnerDirectory(directory, deps)) continue;
                    return held();
                }
                return { acquired: false, reason: 'unwritable', record: null, message: String(error) };
            }
            try {
                const existing = readInstanceLock(input.lockPath);
                if ((existing && !isInstanceLockStale(existing, deps)) ||
                    (!existing && existsSync(input.lockPath) && !oldEnough(input.lockPath))) {
                    removeOwner(directory, ownerFile);
                    return held(existing);
                }
                writeLockFile(input.lockPath, record);
                return {
                    acquired: true,
                    handle: {
                        record,
                        stillOwned: () => readInstanceLock(input.lockPath)?.nonce === record.nonce && existsSync(ownerFile),
                        release: () => {
                            if (readInstanceLock(input.lockPath)?.nonce === record.nonce) {
                                try { unlinkSync(input.lockPath); } catch {}
                            }
                            removeOwner(directory, ownerFile);
                        }
                    }
                };
            } catch (error) {
                removeOwner(directory, ownerFile);
                return { acquired: false, reason: 'unwritable', record: null, message: String(error) };
            }
        }
        return held();
    } catch (error) {
        return { acquired: false, reason: 'unwritable', record: null, message: String(error) };
    } finally {
        removeOwner(candidate, candidateOwner);
    }
}
