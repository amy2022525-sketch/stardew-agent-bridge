/**
 * Docker runtime 事务合成测试（P0-3）：game-seed 工作副本事务 + backup/restore 跨卷事务。
 *
 * 只用临时目录与注入的崩溃钩子（deps.checkpoint 抛 simulateCrash），不接触真实存档、
 * 不启动真实游戏/Docker。验证的是：崩溃窗口后可恢复、篡改被拒绝、幂等重放安全。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../..');
const load = async (relative: string): Promise<any> => await import(pathToFileURL(path.join(REPO, relative)).href);

const seed = await load('scripts/docker/runtime/game-seed.mjs');
const backup = await load('scripts/docker/runtime/backup.mjs');

function tempRoot(): string { return mkdtempSync(path.join(os.tmpdir(), 'sab-rt-')); }

/** 合成一个最小 Linux 游戏输入 + Mod 产物目录。 */
function makeInputs(root: string): { gameDir: string; modDir: string } {
    const gameDir = path.join(root, 'input-game');
    const modDir = path.join(root, 'input-mod');
    mkdirSync(path.join(gameDir, 'Content'), { recursive: true });
    writeFileSync(path.join(gameDir, 'StardewModdingAPI'), '#!/bin/sh\n');
    chmodSync(path.join(gameDir, 'StardewModdingAPI'), 0o755);
    writeFileSync(path.join(gameDir, 'Stardew Valley.dll'), 'pe');
    writeFileSync(path.join(gameDir, 'Content', 'x.dat'), 'content');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'StardewAgentBridge.dll'), 'dll');
    writeFileSync(path.join(modDir, 'manifest.json'), JSON.stringify({ Version: '0.1.0' }));
    return { gameDir, modDir };
}

function makeLayout(root: string, inputs: { gameDir: string; modDir: string }) {
    return {
        app: path.join(root, 'opt/sab'), server: path.join(root, 'opt/sab/server'), container: path.join(root, 'opt/sab/container'),
        web: path.join(root, 'opt/sab/web'), metadata: path.join(root, 'opt/sab/metadata'), licenses: path.join(root, 'opt/sab/licenses'),
        inputGame: inputs.gameDir, inputMod: path.join(root, 'input-mod-root'), gameWork: path.join(root, 'srv/game'),
        gameHome: path.join(root, 'home/sab'), data: path.join(root, 'var/lib/sab'), backups: path.join(root, 'var/backups/sab'),
        run: path.join(root, 'run/sab'), secrets: path.join(root, 'run/secrets'), node: process.execPath,
        leaseLock: path.join(root, 'var/lib/sab/container-volume.lock'), entry: path.join(root, 'opt/sab/container/lease-entrypoint.mjs')
    };
}

const fakeInspectors = (inputs: { gameDir: string; modDir: string }) => ({
    inspectGame: (dir: string) => {
        assert.equal(dir, inputs.gameDir);
        return { ok: true, info: { launcher: 'StardewModdingAPI', gameAssembly: 'Stardew Valley.dll', version: '1.6.15' } };
    },
    inspectMod: (dir: string) => {
        assert.equal(dir, inputs.modDir);
        return { ok: true, info: { manifest: { Version: '0.1.0' }, artifact: { artifacts: { dll: 'a1' } } } };
    }
});

function crashAt(phase: string): (name: string) => void {
    return name => {
        if (name === phase) { const error = new Error(`crash@${phase}`); (error as Error & { simulateCrash?: boolean }).simulateCrash = true; throw error; }
    };
}

describe('game-seed 工作副本事务', () => {
    it('空卷首次初始化：current + managed + cleaned journal；输入与 HOME 不被改动', () => {
        const root = tempRoot();
        try {
            const inputs = makeInputs(root);
            const layout = makeLayout(root, inputs);
            const config = { modArtifacts: inputs.modDir, home: layout.data };
            const result = seed.prepareWorkdir(config, { layout, leaseHeld: true, ...fakeInspectors(inputs) });
            assert.equal(result.ok, true);
            assert.equal(result.state, 'initialized');
            assert.ok(existsSync(path.join(layout.gameWork, 'current', 'StardewModdingAPI')));
            assert.ok(existsSync(path.join(layout.gameWork, 'current', 'Mods', 'StardewAgentBridge', 'StardewAgentBridge.dll')));
            const journal = JSON.parse(readFileSync(path.join(layout.gameWork, '.sab-seed', 'seed-journal.json'), 'utf8'));
            assert.equal(journal.phase, 'cleaned');
            // 输入只读目录内容保持原样（没有 Mods 注入回输入）。
            assert.ok(!existsSync(path.join(inputs.gameDir, 'Mods')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('未持锁直接调用被拒绝（LEASE_REQUIRED / OWNERSHIP_CONFLICT）', () => {
        const root = tempRoot();
        try {
            const inputs = makeInputs(root);
            const layout = makeLayout(root, inputs);
            const result = seed.prepareWorkdir({ modArtifacts: inputs.modDir, home: layout.data }, { layout, leaseHeld: false, ...fakeInspectors(inputs) });
            assert.equal(result.ok, false);
            assert.equal(result.reasonCode, 'LEASE_REQUIRED');
            assert.equal(result.code, 'OWNERSHIP_CONFLICT');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('普通重启复用副本；输入变化拒绝启动，prepare-update 后重建且旧副本保留', () => {
        const root = tempRoot();
        try {
            const inputs = makeInputs(root);
            const layout = makeLayout(root, inputs);
            const config = { modArtifacts: inputs.modDir, home: layout.data };
            const deps = { layout, leaseHeld: true, ...fakeInspectors(inputs) };
            assert.equal(seed.prepareWorkdir(config, deps).state, 'initialized');
            const reused = seed.prepareWorkdir(config, deps);
            assert.equal(reused.state, 'reused');

            writeFileSync(path.join(inputs.gameDir, 'Stardew Valley.dll'), 'changed');
            const refused = seed.prepareWorkdir(config, deps);
            assert.equal(refused.ok, false);
            assert.equal(refused.reasonCode, 'INPUT_CHANGED');

            const updated = seed.prepareWorkdir(config, { ...deps, prepareUpdate: true });
            assert.equal(updated.ok, true);
            assert.equal(updated.state, 'initialized');
            const retired = readdirSync(path.join(layout.gameWork, '.sab-seed', 'retired'), { withFileTypes: true });
            assert.equal(retired.length, 1, '旧副本必须保留在 retired 下');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    for (const phase of ['copied', 'validated', 'new_installed', 'committed']) {
        it(`崩溃注入 ${phase}（首次初始化）后：SEED_INTERRUPTED，重跑完成恢复，无残留 staging`, () => {
            const root = tempRoot();
            try {
                const inputs = makeInputs(root);
                const layout = makeLayout(root, inputs);
                const config = { modArtifacts: inputs.modDir, home: layout.data };
                const deps = { layout, leaseHeld: true, ...fakeInspectors(inputs), checkpoint: crashAt(phase) };
                const crashed = seed.prepareWorkdir(config, deps);
                assert.equal(crashed.ok, false);
                assert.equal(crashed.reasonCode, 'SEED_INTERRUPTED');

                // 重跑（不带崩溃钩子）应完成恢复并得到可用副本。
                const recovered = seed.prepareWorkdir(config, { layout, leaseHeld: true, ...fakeInspectors(inputs) });
                assert.equal(recovered.ok, true, `恢复失败：${JSON.stringify(recovered)}`);
                assert.ok(['reused', 'initialized'].includes(recovered.state));
                assert.ok(existsSync(path.join(layout.gameWork, 'current', 'StardewModdingAPI')));
                const staging = path.join(layout.gameWork, '.sab-seed', 'staging');
                assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, '崩溃后 staging 必须被清理');
            } finally { rmSync(root, { recursive: true, force: true }); }
        });
    }

    it('崩溃注入 old_retired（重建场景：旧目录刚退休、新目录未就位）后恢复，旧副本不被丢', () => {
        const root = tempRoot();
        try {
            const inputs = makeInputs(root);
            const layout = makeLayout(root, inputs);
            const config = { modArtifacts: inputs.modDir, home: layout.data };
            const deps = { layout, leaseHeld: true, ...fakeInspectors(inputs) };
            assert.equal(seed.prepareWorkdir(config, deps).state, 'initialized');

            writeFileSync(path.join(inputs.gameDir, 'Stardew Valley.dll'), 'changed');
            const crashed = seed.prepareWorkdir(config, { ...deps, prepareUpdate: true, checkpoint: crashAt('old_retired') });
            assert.equal(crashed.ok, false);
            assert.equal(crashed.reasonCode, 'SEED_INTERRUPTED');

            // 恢复后旧副本回到 current；输入仍变化，因此重建需带 prepareUpdate。
            const recovered = seed.prepareWorkdir(config, { ...deps, prepareUpdate: true });
            assert.equal(recovered.ok, true, JSON.stringify(recovered));
            assert.ok(existsSync(path.join(layout.gameWork, 'current', 'StardewModdingAPI')));
            const staging = path.join(layout.gameWork, '.sab-seed', 'staging');
            assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, '崩溃后 staging 必须被清理');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('损坏/越界 journal 被拒绝启动，不允许绕过恢复', () => {
        const root = tempRoot();
        try {
            const inputs = makeInputs(root);
            const layout = makeLayout(root, inputs);
            const base = path.join(layout.gameWork, '.sab-seed');
            mkdirSync(base, { recursive: true });
            writeFileSync(path.join(base, 'seed-journal.json'), '{');
            const result = seed.prepareWorkdir({ modArtifacts: inputs.modDir, home: layout.data }, { layout, leaseHeld: true, ...fakeInspectors(inputs) });
            assert.equal(result.ok, false);
            assert.equal(result.reasonCode, 'SEED_JOURNAL_INVALID');

            const escape = { schemaVersion: 1, transactionId: seed.newTransactionId(), phase: 'validated',
                targetPath: path.join(root, 'elsewhere'), stagingPath: path.join(base, 'staging', 'x'), retiredPath: path.join(base, 'retired', 'x') };
            writeFileSync(path.join(base, 'seed-journal.json'), JSON.stringify(escape));
            const result2 = seed.prepareWorkdir({ modArtifacts: inputs.modDir, home: layout.data }, { layout, leaseHeld: true, ...fakeInspectors(inputs) });
            assert.equal(result2.ok, false);
            assert.equal(result2.reasonCode, 'SEED_JOURNAL_INVALID');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe('backup / restore 跨卷事务', () => {
    function makeVolumes(root: string): { dataDir: string; homeDir: string; targets: Record<string, { path: string }> } {
        const dataDir = path.join(root, 'var/lib/sab');
        const homeDir = path.join(root, 'home/sab');
        mkdirSync(path.join(dataDir, 'ledger'), { recursive: true });
        writeFileSync(path.join(dataDir, 'ledger', 'events.jsonl'), '{"n":1}\n');
        writeFileSync(path.join(dataDir, 'bridge.lock'), 'volatile-must-be-skipped');
        mkdirSync(homeDir, { recursive: true });
        writeFileSync(path.join(homeDir, 'note.txt'), 'home-content');
        return { dataDir, homeDir, targets: { data: { path: dataDir }, home: { path: homeDir } } };
    }

    it('创建 → 完整校验；篡改载荷/删 COMPLETE/加未列文件/改清单 全部被拒绝', () => {
        const root = tempRoot();
        try {
            const volumes = makeVolumes(root);
            const dest = path.join(root, 'backups');
            const created = backup.createBackup({ dest }, { leaseHeld: true, targets: volumes.targets, gameWork: path.join(root, 'srv/game') });
            assert.equal(created.ok, true, JSON.stringify(created));
            const backupDir = path.join(dest, created.backupId!);
            assert.ok(existsSync(path.join(backupDir, 'COMPLETE')));
            assert.equal(backup.verifyBackup(backupDir).ok, true);
            // 易失文件不进备份。
            assert.ok(!existsSync(path.join(backupDir, 'payload', 'data', 'bridge.lock')));

            // 篡改载荷字节。
            const payload = path.join(backupDir, 'payload', 'home', 'note.txt');
            writeFileSync(payload, 'tampered');
            assert.equal(backup.verifyBackup(backupDir).notes[0], 'PAYLOAD_HASH_MISMATCH');
            writeFileSync(payload, 'home-content');
            assert.equal(backup.verifyBackup(backupDir).ok, true);

            rmSync(path.join(backupDir, 'COMPLETE'));
            assert.equal(backup.verifyBackup(backupDir).notes[0], 'BACKUP_INCOMPLETE');
            writeFileSync(path.join(backupDir, 'COMPLETE'), `${createHash('sha256').update(readFileSync(path.join(backupDir, 'backup.json'))).digest('hex')}\n`);

            writeFileSync(path.join(backupDir, 'payload', 'home', 'unlisted.txt'), 'x');
            assert.equal(backup.verifyBackup(backupDir).notes[0], 'UNLISTED_PAYLOAD');
            rmSync(path.join(backupDir, 'payload', 'home', 'unlisted.txt'));

            writeFileSync(path.join(backupDir, 'backup.json'), '{}');
            assert.equal(backup.verifyBackup(backupDir).notes[0], 'MANIFEST_DIGEST_MISMATCH');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('未持租约时创建/恢复都被拒绝', () => {
        const root = tempRoot();
        try {
            const volumes = makeVolumes(root);
            const refused = backup.createBackup({ dest: path.join(root, 'backups') }, { leaseHeld: false, targets: volumes.targets, gameWork: path.join(root, 'srv/game') });
            assert.equal(refused.code, 'OWNERSHIP_CONFLICT');
            const busy = backup.createBackup({ dest: path.join(root, 'backups') }, { leaseHeld: true, isVolumeBusy: () => true, targets: volumes.targets, gameWork: path.join(root, 'srv/game') });
            assert.equal(busy.code, 'OWNERSHIP_CONFLICT');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('恢复：旧内容进事务目录，重复恢复同一备份是幂等 no-op', () => {
        const root = tempRoot();
        try {
            const volumes = makeVolumes(root);
            const dest = path.join(root, 'backups');
            const deps = { leaseHeld: true, targets: volumes.targets, gameWork: path.join(root, 'srv/game') };
            const created = backup.createBackup({ dest }, deps);

            // 恢复前修改卷内容，恢复后应回到备份时状态。
            writeFileSync(path.join(volumes.homeDir, 'note.txt'), 'changed-after-backup');
            const restored = backup.restoreBackup({ from: path.join(dest, created.backupId!) }, deps);
            assert.equal(restored.ok, true, JSON.stringify(restored));
            assert.equal(readFileSync(path.join(volumes.homeDir, 'note.txt'), 'utf8'), 'home-content');
            assert.equal(backup.restorePending(deps), false);

            const again = backup.restoreBackup({ from: path.join(dest, created.backupId!) }, deps);
            assert.equal(again.ok, true);
            assert.ok(again.notes.some((note: string) => note.includes('已经恢复')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('崩溃注入（提交中移动了旧目录后崩溃）→ recover-restore 回到旧组合，然后可重试恢复', () => {
        const root = tempRoot();
        try {
            const volumes = makeVolumes(root);
            const dest = path.join(root, 'backups');
            const deps = { leaseHeld: true, targets: volumes.targets, gameWork: path.join(root, 'srv/game') };
            const created = backup.createBackup({ dest }, deps);
            const from = path.join(dest, created.backupId!);

            writeFileSync(path.join(volumes.homeDir, 'note.txt'), 'post-backup-edit');
            const crashed = backup.restoreBackup({ from }, { ...deps, checkpoint: crashAt('old_moved') });
            assert.equal(crashed.ok, false);
            assert.equal(crashed.code, 'RECOVERY_REQUIRED');
            assert.equal(backup.restorePending(deps), true, '崩溃后必须处于待恢复状态');

            // 新恢复操作在未恢复前被阻止。
            assert.equal(backup.restoreBackup({ from }, deps).code, 'RECOVERY_REQUIRED');

            const recovered = backup.recoverRestore(deps);
            assert.equal(recovered.ok, true, JSON.stringify(recovered));
            assert.equal(readFileSync(path.join(volumes.homeDir, 'note.txt'), 'utf8'), 'post-backup-edit', '回滚应恢复到崩溃前（而非备份）状态');
            assert.equal(backup.restorePending(deps), false);

            const retried = backup.restoreBackup({ from }, deps);
            assert.equal(retried.ok, true, JSON.stringify(retried));
            assert.equal(readFileSync(path.join(volumes.homeDir, 'note.txt'), 'utf8'), 'home-content');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('workdir 版本与备份清单不一致时拒绝恢复', () => {
        const root = tempRoot();
        try {
            const volumes = makeVolumes(root);
            const gameWork = path.join(root, 'srv/game');
            mkdirSync(path.join(gameWork, '.sab-seed'), { recursive: true });
            writeFileSync(path.join(gameWork, '.sab-seed', 'managed.json'), JSON.stringify({ gameVersion: '1.6.15', modVersion: '0.1.0' }));
            const dest = path.join(root, 'backups');
            const deps = { leaseHeld: true, targets: volumes.targets, gameWork };
            const created = backup.createBackup({ dest }, deps);
            assert.equal(created.manifest!.gameVersion, '1.6.15');

            writeFileSync(path.join(gameWork, '.sab-seed', 'managed.json'), JSON.stringify({ gameVersion: '1.6.9', modVersion: '0.1.0' }));
            const refused = backup.restoreBackup({ from: path.join(dest, created.backupId!) }, deps);
            assert.equal(refused.ok, false);
            assert.ok(refused.notes.some((note: string) => note.includes('WORKDIR_VERSION_MISMATCH')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
