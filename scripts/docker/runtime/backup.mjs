#!/usr/bin/env node
/** Offline snapshots and per-volume restore transactions. Mount roots and the lease inode never move. */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { LAYOUT, EXIT } from './config.mjs';
import { atomicWriteJson, atomicWriteFile, hashTree, isoNow, newNonce, ownedPath, readJsonIfExists, safeRelative, sha256OfFile } from './lib.mjs';

export const BACKUP_SCHEMA_VERSION = 1;
export const TARGETS = { data: { path: LAYOUT.data }, home: { path: LAYOUT.gameHome } };
export const VOLATILE_NAMES = new Set(['endpoint.json', 'bridge.lock', 'container-volume.lock', '.lease-probe', 'status.json', 'runtime-stop.json', 'game-launch.json']);
const RESERVED = new Set(['.sab-restore', '.maintenance', 'container-volume.lock', '.lease-probe', '.volume-owner.json']);
const skip = rel => VOLATILE_NAMES.has(rel.split('/')[0]) || RESERVED.has(rel.split('/')[0]);
const failure = (code, message) => ({ ok: false, code, exitCode: EXIT[code], notes: [message] });
const lease = deps => (deps.leaseHeld ?? process.env.SAB_LEASE_HELD === '1') && !(deps.isVolumeBusy?.());
export function newBackupId(now = new Date()) { return `backup-${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${newNonce(6)}`; }
export function validBackupId(id) { return typeof id === 'string' && /^backup-\d{8}T\d{6}-[a-f0-9]{12}$/.test(id); }
const rootOf = (key, deps) => path.resolve((deps.targets ?? TARGETS)[key]?.path ?? '');
const journalFile = deps => ownedPath(rootOf('data', deps), path.join(rootOf('data', deps), '.maintenance', 'restore.json'));
function privateCopy(source, destination) {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o600);
}
function checkedRoot(key, deps) {
    if (!Object.hasOwn(deps.targets ?? TARGETS, key)) throw new Error('UNKNOWN_VOLUME');
    const root = rootOf(key, deps);
    ownedPath(root, root, { allowRoot: true });
    if (!lstatSync(root).isDirectory()) throw new Error('VOLUME_MISSING');
    return root;
}

export function createBackup({ dest = LAYOUT.backups, targets = ['data', 'home'] } = {}, deps = {}) {
    if (!lease(deps)) return failure('OWNERSHIP_CONFLICT', '离线备份要求全程持有数据卷租约。');
    try {
        if (restorePending(deps)) return failure('RECOVERY_REQUIRED', '先恢复未完成的维护事务。');
        if (!targets.length || targets.some(key => !['data', 'home'].includes(key)) || new Set(targets).size !== targets.length) throw new Error('INVALID_BACKUP_SECTIONS');
        const id = newBackupId();
        const root = ownedPath(dest, path.join(dest, id));
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const files = [];
        for (const key of targets) {
            const source = checkedRoot(key, deps);
            const inventory = hashTree(source, { skip, maxEntries: 50_000, maxBytes: 8 * 1024 ** 3 });
            mkdirSync(path.join(root, 'payload', key), { recursive: true, mode: 0o700 });
            for (const [relative, info] of Object.entries(inventory)) {
                const relativePath = `payload/${key}/${relative}`;
                const target = ownedPath(root, path.join(root, relativePath));
                privateCopy(ownedPath(source, path.join(source, relative)), target);
                if (sha256OfFile(target) !== info.sha256) throw new Error('SOURCE_CHANGED_DURING_BACKUP');
                files.push({ path: relativePath, size: info.size, sha256: info.sha256, mode: '0600' });
            }
        }
        const metadata = { workdir: readJsonIfExists(path.join(deps.gameWork ?? LAYOUT.gameWork, '.sab-seed', 'managed.json')),
            build: readJsonIfExists(path.join(LAYOUT.metadata, 'build-info.json')) };
        atomicWriteJson(path.join(root, 'metadata', 'versions.json'), metadata);
        files.push({ path: 'metadata/versions.json', size: statSync(path.join(root, 'metadata', 'versions.json')).size, sha256: sha256OfFile(path.join(root, 'metadata', 'versions.json')), mode: '0600' });
        const manifest = { schemaVersion: 1, backupId: id, createdAt: isoNow(), sourceCommit: metadata.build?.sourceCommit ?? null,
            bridgeVersion: deps.bridgeVersion ?? '0.2.0-preview.1', gameVersion: metadata.workdir?.gameVersion ?? null,
            modVersion: metadata.workdir?.modVersion ?? null, offlineConfirmed: true, sections: targets, files };
        atomicWriteJson(path.join(root, 'backup.json'), manifest);
        // COMPLETE is last and binds exactly this manifest. Partial directories are never restorable.
        atomicWriteFile(path.join(root, 'COMPLETE'), sha256OfFile(path.join(root, 'backup.json')) + '\n');
        const verified = verifyBackup(root);
        if (!verified.ok) throw new Error('FINAL_BACKUP_VALIDATION_FAILED');
        return { ok: true, code: 'OK', exitCode: 0, backupId: id, path: root, manifest, notes: ['离线目录备份已完成并校验。'] };
    } catch (error) { return failure('BACKUP_INVALID', error.message); }
}

export function verifyBackup(dir, deps = {}) {
    try {
        const root = path.resolve(dir);
        ownedPath(root, root, { allowRoot: true });
        const manifestFile = ownedPath(root, path.join(root, 'backup.json'));
        const complete = ownedPath(root, path.join(root, 'COMPLETE'));
        if (!existsSync(complete) || !existsSync(manifestFile) || statSync(manifestFile).size > 16 * 1024 ** 2 || statSync(complete).size > 100) throw new Error('BACKUP_INCOMPLETE');
        const digest = sha256OfFile(manifestFile);
        if (readFileSync(complete, 'utf8').trim() !== digest) throw new Error('MANIFEST_DIGEST_MISMATCH');
        const manifest = readJsonIfExists(manifestFile);
        if (!manifest || manifest.schemaVersion !== 1 || !validBackupId(manifest.backupId) || manifest.offlineConfirmed !== true || typeof manifest.bridgeVersion !== 'string' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 50_000) throw new Error('INVALID_MANIFEST');
        if (!Array.isArray(manifest.sections) || !manifest.sections.length || manifest.sections.some(key => !['data', 'home'].includes(key)) || new Set(manifest.sections).size !== manifest.sections.length) throw new Error('INVALID_SECTIONS');
        if (deps.bridgeVersion && manifest.bridgeVersion !== deps.bridgeVersion) throw new Error('BRIDGE_VERSION_MISMATCH');
        const seen = new Set();
        let bytes = 0;
        for (const item of manifest.files) {
            safeRelative(item.path);
            const parts = item.path.split('/');
            if (!(item.path === 'metadata/versions.json' || parts[0] === 'payload' && manifest.sections.includes(parts[1]) && parts.length >= 3 && !skip(parts.slice(2).join('/')))) throw new Error('INVALID_PAYLOAD_PATH');
            const key = item.path.toLowerCase();
            if (seen.has(key)) throw new Error('DUPLICATE_PAYLOAD_PATH');
            seen.add(key);
            if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(item.sha256) || item.mode !== '0600') throw new Error('INVALID_FILE_RECORD');
            bytes += item.size;
            if (bytes > 8 * 1024 ** 3) throw new Error('BACKUP_TOO_LARGE');
        }
        const actual = hashTree(root, { skip: rel => rel === 'backup.json' || rel === 'COMPLETE', maxEntries: 50_000, maxBytes: 8 * 1024 ** 3 });
        if (Object.keys(actual).length !== manifest.files.length) throw new Error('UNLISTED_PAYLOAD');
        for (const item of manifest.files) if (actual[item.path]?.sha256 !== item.sha256 || actual[item.path]?.size !== item.size) throw new Error('PAYLOAD_HASH_MISMATCH');
        return { ok: true, code: 'OK', exitCode: 0, manifest, digest, notes: ['备份清单、完成标记与全部载荷一致。'] };
    } catch (error) { return failure('BACKUP_INVALID', error.message); }
}

function readRestore(deps) {
    const file = journalFile(deps);
    if (!existsSync(file)) return null;
    const j = readJsonIfExists(file);
    if (!j || j.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(j.transactionId) || !validBackupId(j.backupId) || !['preparing', 'prepared', 'committing', 'committed', 'rolling_back', 'rolled_back'].includes(j.phase) || !Array.isArray(j.volumes) || j.volumes.length > 2) throw new Error('RESTORE_JOURNAL_INVALID');
    const seen = new Set();
    for (const volume of j.volumes) {
        if (!['data', 'home'].includes(volume.key) || seen.has(volume.key)) throw new Error('RESTORE_VOLUME_INVALID');
        seen.add(volume.key);
        const root = checkedRoot(volume.key, deps);
        ownedPath(root, path.join(root, '.sab-restore', j.transactionId));
        for (const name of [...volume.oldNames, ...volume.newNames]) { safeRelative(name); if (name.includes('/') || RESERVED.has(name)) throw new Error('RESTORE_ENTRY_INVALID'); }
    }
    return j;
}
export function restorePending(deps = {}) {
    try { const j = readRestore(deps); return Boolean(j && !['committed', 'rolled_back'].includes(j.phase)); }
    catch { return true; }
}
function saveRestore(journal, deps) { atomicWriteJson(journalFile(deps), { ...journal, updatedAt: isoNow() }); }
const txRoot = (volume, journal, deps) => ownedPath(checkedRoot(volume.key, deps), path.join(rootOf(volume.key, deps), '.sab-restore', journal.transactionId));

/** Explicit recovery rolls back each volume using observed renames, including the rename-before-journal gap. */
export function recoverRestore(deps = {}) {
    if (!lease(deps)) return failure('OWNERSHIP_CONFLICT', '恢复维护事务需要数据卷租约。');
    try {
        const j = readRestore(deps);
        if (!j || ['committed', 'rolled_back'].includes(j.phase)) return { ok: true, code: 'OK', exitCode: 0, notes: ['没有未完成的恢复事务。'] };
        j.phase = 'rolling_back'; saveRestore(j, deps);
        for (const volume of [...j.volumes].reverse()) {
            const root = checkedRoot(volume.key, deps), tx = txRoot(volume, j, deps);
            const marker = readJsonIfExists(path.join(tx, 'owner.json'));
            if (marker?.transactionId !== j.transactionId || marker?.digest !== j.digest) throw new Error('RESTORE_OWNER_MISMATCH');
            for (const name of volume.newNames) {
                const current = ownedPath(root, path.join(root, name)), staged = ownedPath(tx, path.join(tx, 'new', name)), old = ownedPath(tx, path.join(tx, 'old', name));
                if (existsSync(current) && !existsSync(staged) && (existsSync(old) || !volume.oldNames.includes(name))) renameSync(current, staged);
            }
            for (const name of volume.oldNames) {
                const old = ownedPath(tx, path.join(tx, 'old', name)), current = ownedPath(root, path.join(root, name));
                if (existsSync(old)) { if (existsSync(current)) throw new Error('RESTORE_ROLLBACK_COLLISION'); renameSync(old, current); }
            }
        }
        j.phase = 'rolled_back'; saveRestore(j, deps);
        return { ok: true, code: 'OK', exitCode: 0, notes: ['各卷已回到同一组旧数据；事务现场保留。'] };
    } catch (error) { return failure('RECOVERY_REQUIRED', error.message); }
}

export function restoreBackup({ from, targets, isVolumeBusy } = {}, deps = {}) {
    if (!lease(deps) || isVolumeBusy?.()) return failure('OWNERSHIP_CONFLICT', '离线恢复需要全程持有数据卷租约。');
    const verified = verifyBackup(from, { bridgeVersion: deps.bridgeVersion ?? '0.2.0-preview.1' });
    if (!verified.ok) return verified;
    try {
        if (restorePending(deps)) return failure('RECOVERY_REQUIRED', '存在未完成恢复；先执行 recover-restore。');
        const previous = readRestore(deps);
        if (previous?.phase === 'committed' && previous.digest === verified.digest) return { ok: true, code: 'OK', exitCode: 0, notes: ['该备份已经恢复；未再次移动目录。'] };
        const keys = targets ?? verified.manifest.sections;
        if (!keys.length || keys.some(key => !verified.manifest.sections.includes(key)) || new Set(keys).size !== keys.length) throw new Error('INVALID_RESTORE_SECTIONS');
        const work = readJsonIfExists(path.join(deps.gameWork ?? LAYOUT.gameWork, '.sab-seed', 'managed.json'));
        if (verified.manifest.gameVersion && (!work || work.gameVersion !== verified.manifest.gameVersion || work.modVersion !== verified.manifest.modVersion)) throw new Error('WORKDIR_VERSION_MISMATCH');
        const j = { schemaVersion: 1, transactionId: newNonce(12), backupId: verified.manifest.backupId, digest: verified.digest, phase: 'preparing', volumes: [], createdAt: isoNow() };
        // Validate every current tree before any target write. Reserve names stay at a stable inode.
        for (const key of keys) {
            const root = checkedRoot(key, deps);
            hashTree(root, { skip: rel => RESERVED.has(rel.split('/')[0]) });
            const source = path.join(from, 'payload', key);
            const oldNames = readdirSync(root).filter(name => !RESERVED.has(name));
            const newNames = readdirSync(source);
            const volume = { key, oldNames, newNames };
            const tx = txRoot(volume, j, deps);
            mkdirSync(path.join(tx, 'new'), { recursive: true, mode: 0o700 }); mkdirSync(path.join(tx, 'old'), { mode: 0o700 });
            atomicWriteJson(path.join(tx, 'owner.json'), { transactionId: j.transactionId, digest: j.digest });
            j.volumes.push(volume);
        }
        saveRestore(j, deps);
        for (const volume of j.volumes) {
            const tx = txRoot(volume, j, deps);
            for (const item of verified.manifest.files.filter(f => f.path.startsWith(`payload/${volume.key}/`))) {
                const rel = item.path.slice(`payload/${volume.key}/`.length);
                const target = ownedPath(tx, path.join(tx, 'new', rel));
                privateCopy(ownedPath(from, path.join(from, item.path)), target);
                if (sha256OfFile(target) !== item.sha256) throw new Error('BACKUP_CHANGED_DURING_RESTORE');
            }
        }
        j.phase = 'prepared'; saveRestore(j, deps); deps.checkpoint?.('prepared', j);
        j.phase = 'committing'; saveRestore(j, deps);
        for (const volume of j.volumes) {
            const root = checkedRoot(volume.key, deps), tx = txRoot(volume, j, deps);
            for (const name of volume.oldNames) { renameSync(ownedPath(root, path.join(root, name)), ownedPath(tx, path.join(tx, 'old', name))); deps.checkpoint?.('old_moved', { key: volume.key, name }); }
            for (const name of volume.newNames) { renameSync(ownedPath(tx, path.join(tx, 'new', name)), ownedPath(root, path.join(root, name))); deps.checkpoint?.('new_installed', { key: volume.key, name }); }
        }
        j.phase = 'committed'; saveRestore(j, deps);
        return { ok: true, code: 'OK', exitCode: 0, notes: ['文件恢复已完成；旧数据保留，运行实例身份由下次启动新建。'], restored: keys };
    } catch (error) {
        if (!error.simulateCrash) recoverRestore(deps);
        return failure('RECOVERY_REQUIRED', error.message);
    }
}

export function listBackups(dest = LAYOUT.backups) {
    if (!existsSync(dest)) return [];
    return readdirSync(dest, { withFileTypes: true }).filter(entry => entry.isDirectory() && validBackupId(entry.name)).flatMap(entry => {
        const checked = verifyBackup(ownedPath(dest, path.join(dest, entry.name)));
        return checked.ok ? [{ backupId: checked.manifest.backupId, createdAt: checked.manifest.createdAt, sections: checked.manifest.sections, bridgeVersion: checked.manifest.bridgeVersion }] : [];
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
