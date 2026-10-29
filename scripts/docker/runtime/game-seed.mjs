#!/usr/bin/env node
/** Work-copy transactions run only under the shared volume lease. Never modify input or HOME. */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, PORTS, emitResult, parseContainerConfig } from './config.mjs';
import { atomicWriteJson, copyTreeSafe, hashTree, isoNow, newNonce, ownedPath, readJsonIfExists, sha256OfFile } from './lib.mjs';
import { inspectGameSource, inspectModArtifacts, sourceDigest } from './preflight.mjs';

export const SEED_SCHEMA_VERSION = 1;
export const MOD_DIR_NAME = 'StardewAgentBridge';
export const SKIP_SOURCE_DIRS = ['Mods', 'Saves', '.local', '.config', 'steamapps', 'userdata'];
export const SEED_PHASES = ['prepared', 'copied', 'validated', 'committed', 'cleaned', 'rolled_back'];
export function seedPaths(root) {
    const base = path.join(root, '.sab-seed');
    return { base, journal: path.join(base, 'seed-journal.json'), managed: path.join(base, 'managed.json'),
        current: path.join(root, 'current'), staging: id => path.join(base, 'staging', id), retired: id => path.join(base, 'retired', id) };
}
export function newTransactionId(now = new Date()) { return `${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${newNonce(6)}`; }
export function validTransactionId(id) { return typeof id === 'string' && /^[0-9]{8}T[0-9]{6}-[a-f0-9]{8,16}$/.test(id); }
export function createJournal(fields) { return { schemaVersion: 1, ...fields, phase: 'prepared', createdAt: isoNow(), updatedAt: isoNow() }; }
export function writeJournal(file, journal) { const next = { ...journal, updatedAt: isoNow() }; atomicWriteJson(file, next); return next; }

function validateJournal(journal, workRoot) {
    if (!journal || journal.schemaVersion !== 1 || !validTransactionId(journal.transactionId) || !SEED_PHASES.includes(journal.phase)) throw new Error('SEED_JOURNAL_INVALID');
    const p = seedPaths(workRoot);
    for (const [key, expected] of [['targetPath', p.current], ['stagingPath', p.staging(journal.transactionId)], ['retiredPath', p.retired(journal.transactionId)]]) {
        if (journal[key] !== expected) throw new Error('SEED_JOURNAL_PATH_INVALID');
        ownedPath(workRoot, expected);
    }
    return p;
}
export function readJournal(file, { workRoot } = {}) {
    if (!existsSync(file)) return { ok: true, journal: null, problem: null };
    try { const journal = readJsonIfExists(file); validateJournal(journal, workRoot); return { ok: true, journal, problem: null }; }
    catch (error) { return { ok: false, journal: null, problem: error.message }; }
}
function removeStage(root, target) { rmSync(ownedPath(root, target), { recursive: true, force: true }); }
function matches(root, hashes) {
    if (!hashes || !Object.keys(hashes).length || !existsSync(root)) return false;
    const actual = hashTree(root);
    return JSON.stringify(actual) === JSON.stringify(hashes);
}

/** Infer rename completion from owned paths; a crash between rename and journal must preserve the old copy. */
export function recoverInterruptedTransaction({ workRoot, journal, deps = {} }) {
    try {
        if (!journal) return { ok: true, action: 'none', notes: [] };
        const p = validateJournal(journal, workRoot);
        if (['cleaned', 'rolled_back'].includes(journal.phase)) return { ok: true, action: 'none', notes: [] };
        const { targetPath: current, stagingPath: staging, retiredPath: old } = journal;
        if (journal.phase === 'committed') {
            if (!matches(current, journal.hashes)) throw new Error('COMMITTED_COPY_INVALID');
            atomicWriteJson(p.managed, journal.managed);
            writeJournal(p.journal, { ...journal, phase: 'cleaned' });
            return { ok: true, action: 'finalized', notes: ['已完成提交记录；上一工作副本仍保留。'] };
        }
        if (existsSync(old)) {
            if (existsSync(current)) {
                if (existsSync(staging) || !matches(current, journal.hashes)) throw new Error('AMBIGUOUS_WORKDIR_STATE');
                renameSync(current, staging);
            }
            renameSync(old, current);
        } else if (!existsSync(staging) && existsSync(current) && journal.phase === 'validated' && !journal.hadCurrent) {
            if (!matches(current, journal.hashes)) throw new Error('NEW_COPY_INVALID');
            atomicWriteJson(p.managed, journal.managed);
            writeJournal(p.journal, { ...journal, phase: 'cleaned' });
            return { ok: true, action: 'finalized', notes: ['已核实首次提交完成。'] };
        }
        if (existsSync(staging)) (deps.remove ?? (target => removeStage(workRoot, target)))(ownedPath(workRoot, staging));
        if (journal.previousManaged) atomicWriteJson(p.managed, journal.previousManaged);
        writeJournal(p.journal, { ...journal, phase: 'rolled_back' });
        return { ok: true, action: 'rolled_back', notes: ['未完成事务已回退；旧副本保留。'] };
    } catch (error) { return { ok: false, action: 'refuse', notes: [error.message] }; }
}

export function deployMod({ gameRoot, artifactDir, dataDir = LAYOUT.data, port = PORTS.modInternal }) {
    try {
        const target = ownedPath(gameRoot, path.join(gameRoot, 'Mods', MOD_DIR_NAME));
        mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of ['StardewAgentBridge.dll', 'manifest.json']) copyFileSync(path.join(artifactDir, name), path.join(target, name));
        const file = path.join(target, 'config.json');
        const existing = readJsonIfExists(file) ?? {};
        atomicWriteJson(file, { ...existing, DataDirectory: dataDir, Port: port });
        return { ok: true, target, problems: [] };
    } catch (error) { return { ok: false, problems: [error.message] }; }
}

export function prepareWorkdir(config, deps = {}) {
    const layout = deps.layout ?? LAYOUT;
    const workRoot = layout.gameWork;
    const p = seedPaths(workRoot);
    const fail = (reason, notes, code = 'RECOVERY_REQUIRED') => ({ ok: false, code, exitCode: EXIT[code], reasonCode: reason, notes, current: p.current });
    if (!(deps.leaseHeld ?? process.env.SAB_LEASE_HELD === '1')) return fail('LEASE_REQUIRED', ['必须通过持锁入口准备工作副本。'], 'OWNERSHIP_CONFLICT');
    try {
        ownedPath(workRoot, p.base);
        mkdirSync(p.base, { recursive: true, mode: 0o700 });
        const read = readJournal(p.journal, { workRoot });
        if (!read.ok) return fail('SEED_JOURNAL_INVALID', [read.problem]);
        if (read.journal && !['cleaned', 'rolled_back'].includes(read.journal.phase)) {
            const recovered = recoverInterruptedTransaction({ workRoot, journal: read.journal });
            if (!recovered.ok) return fail('SEED_RECOVERY_REFUSED', recovered.notes);
        }
        const source = (deps.inspectGame ?? inspectGameSource)(layout.inputGame);
        if (!source.ok) return fail('INPUT_INVALID', source.problems.map(p => p.message), source.problems.some(p => p.code === 'INPUT_MISSING') ? 'INPUT_MISSING' : 'CONFIG_INVALID');
        const mod = (deps.inspectMod ?? inspectModArtifacts)(config.modArtifacts);
        if (!mod.ok) return fail('MOD_ARTIFACT_INVALID', mod.problems.map(p => p.message), 'INPUT_MISSING');
        const digest = sourceDigest(layout.inputGame);
        const modDigest = JSON.stringify(mod.info.artifact.artifacts);
        const managed = readJsonIfExists(p.managed);
        if (existsSync(p.current) && (!managed || managed.status !== 'complete')) return fail('UNMANAGED_WORKDIR', ['现有工作目录没有有效的归属记录。']);
        if (managed && existsSync(p.current) && !deps.prepareUpdate) {
            if (managed.sourceDigest !== digest.digest || managed.modArtifactDigest !== modDigest) return fail('INPUT_CHANGED', ['游戏或 Mod 输入变化；停止后执行 prepare-update。']);
            for (const [name, expected] of Object.entries(managed.keyHashes ?? {})) {
                ownedPath(p.current, path.join(p.current, name));
                if (!existsSync(path.join(p.current, name)) || sha256OfFile(path.join(p.current, name)) !== expected) return fail('WORKDIR_CHANGED', ['关键文件变化，拒绝启动。']);
            }
            return { ok: true, code: 'OK', exitCode: 0, state: 'reused', current: p.current, notes: ['工作副本与输入匹配，已复用。'] };
        }
        const id = newTransactionId();
        const staging = p.staging(id);
        const retired = p.retired(id);
        mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
        let journal = createJournal({ transactionId: id, targetPath: p.current, stagingPath: staging, retiredPath: retired,
            previousManaged: managed, hadCurrent: existsSync(p.current), hashes: null, managed: null });
        writeJournal(p.journal, journal);
        const checkpoint = phase => { journal = { ...journal, phase }; writeJournal(p.journal, journal); deps.checkpoint?.(phase, journal); };
        try {
            deps.checkpoint?.('prepared', journal);
            const copied = copyTreeSafe(layout.inputGame, staging, { allowInternalSymlinks: true, skip: rel => SKIP_SOURCE_DIRS.includes(rel.split('/')[0]) });
            if (copied.rejected.length) throw new Error('INPUT_SPECIAL_FILE_REJECTED');
            checkpoint('copied');
            const deployed = deployMod({ gameRoot: staging, artifactDir: config.modArtifacts, dataDir: config.home });
            if (!deployed.ok) throw new Error(deployed.problems.join('; '));
            journal.hashes = hashTree(staging);
            const keyNames = [path.basename(source.info.launcher), path.basename(source.info.gameAssembly), 'StardewModdingAPI', 'StardewModdingAPI.dll', 'Mods/StardewAgentBridge/StardewAgentBridge.dll'];
            const keyHashes = {};
            for (const name of new Set(keyNames)) if (existsSync(path.join(staging, name))) keyHashes[name] = sha256OfFile(path.join(staging, name));
            journal.managed = { schemaVersion: 1, status: 'complete', transactionId: id, sourceDigest: digest.digest, modArtifactDigest: modDigest,
                gameVersion: source.info.version, modVersion: mod.info.manifest.Version, keyHashes, previous: managed?.transactionId ?? null, completedAt: isoNow() };
            checkpoint('validated');
            if (existsSync(p.current)) { mkdirSync(path.dirname(retired), { recursive: true, mode: 0o700 }); renameSync(p.current, retired); deps.checkpoint?.('old_retired', journal); }
            renameSync(staging, p.current);
            deps.checkpoint?.('new_installed', journal);
            checkpoint('committed');
            atomicWriteJson(p.managed, journal.managed);
            checkpoint('cleaned');
            return { ok: true, code: 'OK', exitCode: 0, state: 'initialized', current: p.current, transactionId: id, notes: ['工作副本已完整提交；源文件和 HOME 未改动，上一副本保留。'] };
        } catch (error) {
            if (!error.simulateCrash) recoverInterruptedTransaction({ workRoot, journal });
            return fail('SEED_INTERRUPTED', [error.message]);
        }
    } catch (error) { return fail('SEED_FAILED', [error.message]); }
}
export function main(argv = process.argv.slice(2)) {
    const parsed = parseContainerConfig(process.env, { mode: 'game' });
    if (!parsed.ok) return emitResult(parsed, { json: argv.includes('--json') });
    const result = prepareWorkdir(parsed.config);
    return emitResult({ ...result, message: result.notes.join('; ') }, { json: argv.includes('--json') });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
