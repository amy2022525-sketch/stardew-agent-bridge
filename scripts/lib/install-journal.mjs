/**
 * Mod 安装/回退事务日志（journal）。
 *
 * 设计要点：
 * - 每一步都先用「临时文件 + rename」写成合法 JSON，再执行不可逆操作，
 *   因此崩溃后能按真实阶段恢复，而不是靠 finally 清理猜测；
 * - 回退时重新校验 journal 里记录的每个路径（组件级边界 + 符号链接），
 *   不信任历史内容；
 * - journal 损坏或路径被篡改时拒绝危险覆盖，保留现场与快照；
 * - 备份放在游戏根目录下的 `.stardew-agent-bridge-backups/`，始终在 Mods 之外。
 */
import { createHash } from 'node:crypto';
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
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    writeSync
} from 'node:fs';
import path from 'node:path';

export const JOURNAL_SCHEMA_VERSION = 1;
export const BACKUP_DIR_NAME = '.stardew-agent-bridge-backups';
export const JOURNAL_FILE_NAME = 'journal.json';
export const LATEST_FILE_NAME = 'latest.json';

export const PHASES = [
    'preflight',
    'staged',
    'backuped',
    'prepared',
    'retired_old',
    'committed',
    'verified',
    'failed',
    'rolled_back',
    'remove_only'
];

export const TERMINAL_STATUSES = ['rolled_back', 'remove_only'];

export function backupsRoot(gameRoot) {
    return path.join(gameRoot, BACKUP_DIR_NAME);
}

export function transactionDir(gameRoot, transactionId) {
    return path.join(backupsRoot(gameRoot), transactionId);
}

export function journalPath(gameRoot, transactionId) {
    return path.join(transactionDir(gameRoot, transactionId), JOURNAL_FILE_NAME);
}

export function latestPointerPath(gameRoot) {
    return path.join(backupsRoot(gameRoot), LATEST_FILE_NAME);
}

/** 事务 ID：时间戳 + 随机后缀，避免同一秒内两次安装撞名。 */
export function newTransactionId(now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const random = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${random}`;
}

/** 目录名白名单：只允许单段名字，拒绝 `..`、分隔符与空串。 */
export function sanitizeName(name) {
    if (typeof name !== 'string') return null;
    if (name.length === 0 || name === '.' || name === '..') return null;
    if (name.includes('/') || name.includes('\\')) return null;
    return name;
}

export function createJournal({ gameRoot, dataRoot, transactionId, programVersion, targetName }) {
    const now = new Date().toISOString();
    return {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        transactionId,
        programVersion,
        gameRoot,
        dataRoot,
        createdAt: now,
        updatedAt: now,
        phase: 'preflight',
        status: 'in_progress',
        targetName,
        targetPath: path.join(gameRoot, 'Mods', targetName),
        snapshotPath: transactionDir(gameRoot, transactionId),
        stagingPath: path.join(transactionDir(gameRoot, transactionId), 'staging'),
        previous: [],
        hashes: { staging: {}, backup: {} },
        config: { written: false, dataDirectory: null, port: null },
        failure: null,
        events: [{ at: now, phase: 'preflight', note: '事务开始' }]
    };
}

/** 原子写 journal；任何一次写入都是完整的合法 JSON。 */
export function writeJournal(file, journal) {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = { ...journal, updatedAt: new Date().toISOString() };
    const tmp = path.join(dir, `.${JOURNAL_FILE_NAME}.tmp-${process.pid}-${Date.now().toString(36)}`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
    return next;
}

/** 读取并校验 journal；损坏时返回 problem 而不是抛出，交给调用方拒绝危险操作。 */
export function readJournal(file) {
    try {
        if (!existsSync(file)) return { ok: false, journal: null, problem: `找不到事务文件：${file}` };
        const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof parsed !== 'object' || parsed === null) return { ok: false, journal: null, problem: 'journal 不是对象' };
        if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
            return { ok: false, journal: null, problem: `不支持的 journal schema：${parsed.schemaVersion}` };
        }
        if (typeof parsed.gameRoot !== 'string' || typeof parsed.transactionId !== 'string') {
            return { ok: false, journal: null, problem: 'journal 缺少 gameRoot/transactionId' };
        }
        if (!PHASES.includes(parsed.phase)) return { ok: false, journal: null, problem: `未知阶段：${parsed.phase}` };
        return { ok: true, journal: parsed, problem: null };
    } catch (error) {
        return { ok: false, journal: null, problem: `journal 损坏：${error instanceof Error ? error.message : String(error)}` };
    }
}

/** 只记录阶段与说明，不修改业务字段。 */
export function recordPhase(journal, phase, note) {
    const now = new Date().toISOString();
    return {
        ...journal,
        phase,
        updatedAt: now,
        events: [...(journal.events ?? []), { at: now, phase, note }].slice(-40)
    };
}

export function isTerminal(journal) {
    return TERMINAL_STATUSES.includes(journal?.status);
}

/** 写入 latest 指针（供回退默认选取最近一次事务）。 */
export function writeLatest(gameRoot, journal) {
    const file = latestPointerPath(gameRoot);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const payload = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        transactionId: journal.transactionId,
        gameRoot: journal.gameRoot,
        phase: journal.phase,
        status: journal.status,
        updatedAt: journal.updatedAt
    };
    writeJournalAtomic(file, payload);
    return payload;
}

function writeJournalAtomic(file, value) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
}

export function readLatest(gameRoot) {
    const file = latestPointerPath(gameRoot);
    try {
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

/** 按时间倒序列出所有事务目录（只读）。 */
export function listTransactions(gameRoot) {
    const root = backupsRoot(gameRoot);
    if (!existsSync(root)) return [];
    const out = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, JOURNAL_FILE_NAME);
        if (!existsSync(file)) continue;
        const parsed = readJournal(file);
        out.push({ transactionId: entry.name, file, ok: parsed.ok, journal: parsed.journal, problem: parsed.problem });
    }
    return out.sort((left, right) => (left.transactionId < right.transactionId ? 1 : -1));
}

/** 递归哈希（不跟随符号链接）。 */
export function hashTree(dir) {
    const out = {};
    if (!existsSync(dir)) return out;
    const walk = (current, prefix) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                walk(full, rel);
                continue;
            }
            out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
        }
    };
    walk(dir, '');
    return out;
}

/** 递归复制（逐文件读写，保留常规权限位，不跟随符号链接）。 */
export function copyTree(from, to) {
    const copied = [];
    const skipped = [];
    mkdirSync(to, { recursive: true, mode: 0o755 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        const stat = lstatSync(source);
        if (stat.isSymbolicLink()) {
            skipped.push(entry.name);
            continue;
        }
        if (stat.isDirectory()) {
            const nested = copyTree(source, target);
            copied.push(...nested.copied.map((item) => `${entry.name}/${item}`));
            skipped.push(...nested.skipped.map((item) => `${entry.name}/${item}`));
            continue;
        }
        copyFileSync(source, target);
        try {
            chmodSync(target, stat.mode & 0o777);
        } catch {
            /* 某些文件系统不支持改权限，忽略 */
        }
        copied.push(entry.name);
    }
    return { copied, skipped };
}

/** 校验目录哈希；返回缺失/不一致的条目。 */
export function verifyTree(dir, hashes) {
    const problems = [];
    for (const [rel, expected] of Object.entries(hashes ?? {})) {
        const file = path.join(dir, ...rel.split('/'));
        try {
            const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
            if (actual !== expected) problems.push(`内容不一致：${rel}`);
        } catch {
            problems.push(`缺少文件：${rel}`);
        }
    }
    return problems;
}

/** 同设备原子移动；跨设备时明确抛错，由调用方决定是否降级为复制 + 校验。 */
export function movePath(from, to) {
    renameSync(from, to);
}

export function sameDevice(left, right) {
    try {
        let a = existsSync(left) ? statSync(left) : statSync(path.dirname(left));
        let b = existsSync(right) ? statSync(right) : statSync(path.dirname(right));
        return a.dev === b.dev;
    } catch {
        return false;
    }
}

export function removeEmptyDir(dir) {
    try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
        /* 忽略 */
    }
}

export function forceRemove(target) {
    rmSync(target, { recursive: true, force: true });
}
