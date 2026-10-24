#!/usr/bin/env node
/**
 * Linux Mod 安装/回退隔离测试（不接触真实游戏、不进 Steam、不需要联网）。
 *
 * 用临时目录伪造「游戏目录 + Mods + 旧版 Mod」，逐项验证：
 *   全新安装 / 升级覆盖 / 只停用 / 恢复旧版 / 重复回退幂等 /
 *   阶段失败注入后的恢复 / journal 被篡改时拒绝执行 /
 *   目标目录属于别的 Mod / 游戏运行中拒绝 / --dry-run 不写文件 / 相对 --data-dir 报错。
 *
 * 供 `npm run test:installer` 在 Linux 上调用；Windows 仍走原有 PowerShell 测试。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const INSTALL = path.join(REPO, 'scripts', 'install-mod.mjs');
const ROLLBACK = path.join(REPO, 'scripts', 'rollback-mod.mjs');
const MOD_ID = 'StardewAgentBridge.Bridge';
const BACKUPS = '.stardew-agent-bridge-backups';

const results = [];
let area = null;

function freshArea(label) {
    if (area) rmSync(area, { recursive: true, force: true });
    area = mkdtempSync(path.join(os.tmpdir(), `sab-installer-${label}-`));
    return area;
}

function makeGame(root, { withSmapi = true } = {}) {
    mkdirSync(path.join(root, 'Mods'), { recursive: true });
    writeFileSync(path.join(root, 'Stardew Valley.dll'), 'fake-game-assembly');
    if (withSmapi) {
        writeFileSync(path.join(root, 'StardewModdingAPI.dll'), 'fake-smapi-assembly');
        mkdirSync(path.join(root, 'smapi-internal'), { recursive: true });
        writeFileSync(path.join(root, 'smapi-internal', 'smapi-version.json'), JSON.stringify({ version: '4.5.2' }));
    }
    return root;
}

function makeArtifact(dir, { version = '0.1.0', uniqueId = MOD_ID } = {}) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'StardewAgentBridge.dll'), `fake-mod-assembly-${version}`);
    writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ Name: 'Stardew Agent Bridge', UniqueID: uniqueId, Version: version, EntryDll: 'StardewAgentBridge.dll' }, null, 2)
    );
    return dir;
}

function makeModDir(gameRoot, name, { version = '0.0.9', uniqueId = MOD_ID, config = null } = {}) {
    const dir = path.join(gameRoot, 'Mods', name);
    makeArtifact(dir, { version, uniqueId });
    if (config) writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
    return dir;
}

function run(script, args, env = {}) {
    const result = spawnSync(process.execPath, [script, ...args, '--json'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, ...env }
    });
    let parsed = null;
    const stdout = String(result.stdout ?? '');
    const start = stdout.indexOf('{');
    if (start >= 0) {
        try {
            parsed = JSON.parse(stdout.slice(start));
        } catch {
            parsed = null;
        }
    }
    return { status: result.status, report: parsed, stdout, stderr: String(result.stderr ?? '') };
}

function journalOf(gameRoot) {
    const root = path.join(gameRoot, BACKUPS);
    if (!existsSync(root)) return null;
    const latest = path.join(root, 'latest.json');
    const id = existsSync(latest) ? JSON.parse(readFileSync(latest, 'utf8')).transactionId : null;
    const candidates = id
        ? [id]
        : readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
              .reverse();
    for (const transactionId of candidates) {
        const file = path.join(root, transactionId, 'journal.json');
        if (existsSync(file)) return { transactionId, file, journal: JSON.parse(readFileSync(file, 'utf8')) };
    }
    return null;
}

const steps = [];
async function step(name, fn) {
    try {
        await fn();
        steps.push({ name, ok: true });
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (error) {
        steps.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
        process.stdout.write(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}\n`);
    }
}

function assertExit(result, expected, hint) {
    assert.equal(result.status, expected, `${hint}（实际退出码 ${result.status}）\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}

async function main() {
    process.stdout.write('[test-installer] Linux 安装/回退隔离测试开始\n');

    await step('全新安装：写入目标目录、绝对 DataDirectory 与安装记录', async () => {
        const base = freshArea('fresh');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const data = path.join(base, '数据 root');
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]);
        assertExit(result, 0, '全新安装应当成功');
        const target = path.join(game, 'Mods', 'StardewAgentBridge');
        assert.ok(existsSync(path.join(target, 'StardewAgentBridge.dll')), '目标目录必须有 DLL');
        const config = JSON.parse(readFileSync(path.join(target, 'config.json'), 'utf8'));
        assert.equal(config.DataDirectory, data, 'DataDirectory 必须是解析后的绝对路径');
        assert.ok(existsSync(path.join(data, 'mod-install.json')), '必须写安装记录');
        const record = JSON.parse(readFileSync(path.join(data, 'mod-install.json'), 'utf8'));
        assert.equal(record.gameRoot, game);
        const journal = journalOf(game);
        assert.ok(journal, '必须有事务 journal');
        assert.equal(journal.journal.status, 'installed');
        assert.equal(journal.journal.phase, 'verified');
        for (const name of ['Stardew Valley.dll', 'StardewModdingAPI.dll']) {
            assert.ok(!existsSync(path.join(target, name)), `不得把 ${name} 复制进 Mods`);
        }
    });

    await step('升级安装：旧目录进入快照并保留未知配置键', async () => {
        const base = freshArea('upgrade');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1', config: { Port: 17654, CustomKey: '保留我' } });
        const artifact = makeArtifact(path.join(base, 'artifact'), { version: '0.1.0' });
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]);
        assertExit(result, 0, '升级安装应当成功');
        const config = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'config.json'), 'utf8'));
        assert.equal(config.CustomKey, '保留我', '未知键必须保留');
        assert.equal(config.DataDirectory, data);
        const journal = journalOf(game);
        assert.equal(journal.journal.previous.length, 1);
        const backupConfig = path.join(journal.journal.previous[0].backupPath, 'config.json');
        assert.ok(existsSync(backupConfig), '旧配置必须进快照');
    });

    await step('只停用：目标目录移除、旧版留在快照', async () => {
        const base = freshArea('remove-only');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        assertExit(run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]), 0, '安装应成功');
        const removed = run(ROLLBACK, ['--game-path', game, '--data-dir', data, '--remove-only']);
        assertExit(removed, 0, '只停用应当成功');
        assert.ok(!existsSync(path.join(game, 'Mods', 'StardewAgentBridge')), '目标目录应已移除');
        const journal = journalOf(game);
        assert.equal(journal.journal.status, 'remove_only');
    });

    await step('恢复旧版：取回快照里的旧目录，重复执行幂等', async () => {
        const base = freshArea('restore');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'), { version: '0.1.0' });
        assertExit(run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]), 0, '安装应成功');
        assertExit(run(ROLLBACK, ['--game-path', game, '--data-dir', data, '--remove-only']), 0, '停用应成功');
        const restored = run(ROLLBACK, ['--game-path', game, '--data-dir', data]);
        assertExit(restored, 0, '恢复应当成功');
        const manifest = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json'), 'utf8'));
        assert.equal(manifest.Version, '0.0.1', '必须恢复旧版本');
        const beforeSnapshot = readdirSync(journalOf(game).journal.snapshotPath).sort();
        const again = run(ROLLBACK, ['--game-path', game, '--data-dir', data]);
        assertExit(again, 0, '重复回退必须幂等成功');
        assert.ok(existsSync(path.join(game, 'Mods', 'StardewAgentBridge')), '幂等执行不得删除已恢复目录');
        assert.deepEqual(readdirSync(journalOf(game).journal.snapshotPath).sort(), beforeSnapshot, '重复回退不能再次移动旧版或新增停用目录');
    });

    await step('故障注入：prepared 阶段失败后旧目录仍在原位', async () => {
        const base = freshArea('fail-prepared');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data], { SAB_FAIL_AT: 'prepared' });
        assertExit(result, 1, '故障注入应返回失败');
        const manifest = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json'), 'utf8'));
        assert.equal(manifest.Version, '0.0.1', '旧版必须仍在原位');
        const journal = journalOf(game);
        assert.equal(journal.journal.status, 'failed');
    });

    await step('故障注入：retired_old 阶段失败后旧目录被放回', async () => {
        const base = freshArea('fail-retired');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data], { SAB_FAIL_AT: 'retired_old' });
        assertExit(result, 1, '故障注入应返回失败');
        const manifest = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json'), 'utf8'));
        assert.equal(manifest.Version, '0.0.1', '旧版必须被放回 Mods');
    });

    await step('故障注入：committed 阶段失败后新目录被移走、旧目录恢复', async () => {
        const base = freshArea('fail-committed');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data], { SAB_FAIL_AT: 'committed' });
        assertExit(result, 1, '故障注入应返回失败');
        const manifest = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json'), 'utf8'));
        assert.equal(manifest.Version, '0.0.1', '旧版必须被恢复');
        const parked = readdirSync(journalOf(game).journal.snapshotPath).filter((name) => name.startsWith('failed-current-'));
        assert.equal(parked.length, 1, '未完成的新安装必须被移到快照区保留');
    });

    await step('Mods 符号链接逃逸：修改前拒绝，不写入链接目标', async () => {
        const base = freshArea('mods-symlink');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const outside = path.join(base, 'outside');
        mkdirSync(outside);
        rmSync(path.join(game, 'Mods'), { recursive: true });
        symlinkSync(outside, path.join(game, 'Mods'), 'dir');
        const result = run(INSTALL, ['--game-path', game, '--artifact', makeArtifact(path.join(base, 'artifact')), '--data-dir', path.join(base, 'data')]);
        assertExit(result, 1, 'Mods 链接必须被拒绝');
        assert.equal(result.report?.code, 'PATH_ESCAPE');
        assert.deepEqual(readdirSync(outside), []);
    });

    await step('备份根符号链接逃逸：拒绝写入外部目录', async () => {
        const base = freshArea('backup-symlink');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const outside = path.join(base, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, path.join(game, BACKUPS), 'dir');
        const result = run(INSTALL, ['--game-path', game, '--artifact', makeArtifact(path.join(base, 'artifact')), '--data-dir', path.join(base, 'data')]);
        assertExit(result, 1, '备份根链接必须被拒绝');
        assert.deepEqual(readdirSync(outside), []);
    });

    await step('事务 ID 路径逃逸：拒绝读取相邻事务', async () => {
        const base = freshArea('transaction-escape');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const result = run(ROLLBACK, ['--game-path', game, '--data-dir', path.join(base, 'data'), '--transaction', '../outside']);
        assertExit(result, 3, '越界事务 ID 必须被拒绝');
        assert.equal(result.report?.code, 'JOURNAL_TAMPERED');
    });

    for (const phase of ['prepared', 'retired_old', 'committed']) {
        await step(`进程中断：${phase} 阶段退出后拒绝新安装并允许显式恢复`, async () => {
            const base = freshArea(`crash-${phase}`);
            const game = makeGame(path.join(base, 'Stardew Valley'));
            const data = path.join(base, 'data');
            makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
            const artifact = makeArtifact(path.join(base, 'artifact'));
            const args = ['--game-path', game, '--artifact', artifact, '--data-dir', data];
            assertExit(run(INSTALL, args, { SAB_CRASH_AT: phase }), 99, '模拟进程中断');
            const info = journalOf(game);
            assert.ok(info);
            assertExit(run(INSTALL, args), 3, '未恢复事务必须阻止新安装');
            assertExit(run(ROLLBACK, ['--game-path', game, '--data-dir', data, '--transaction', info.transactionId]), 0, '恢复应成功');
            const manifest = JSON.parse(readFileSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json'), 'utf8'));
            assert.equal(manifest.Version, '0.0.1');
        });
    }

    await step('journal 被篡改：回退拒绝执行并保留现场', async () => {
        const base = freshArea('tamper');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { version: '0.0.1' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        assertExit(run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]), 0, '安装应成功');
        const info = journalOf(game);
        const tampered = JSON.parse(readFileSync(info.file, 'utf8'));
        tampered.previous = [{ ...(tampered.previous[0] ?? {}), name: '../逃逸', backupPath: '/etc/passwd', retiredPath: '/etc' }];
        writeFileSync(info.file, JSON.stringify(tampered, null, 2));
        const result = run(ROLLBACK, ['--game-path', game, '--data-dir', data]);
        assertExit(result, 3, '被篡改的 journal 必须拒绝执行');
        assert.equal(result.report?.code, 'JOURNAL_TAMPERED');
        assert.ok(existsSync(path.join(game, 'Mods', 'StardewAgentBridge')), '现场必须保持不动');
    });

    await step('目标目录属于别的 Mod：拒绝覆盖', async () => {
        const base = freshArea('foreign');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        makeModDir(game, 'StardewAgentBridge', { uniqueId: 'SomeOther.Author.Mod' });
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]);
        assertExit(result, 1, '必须拒绝覆盖无关 Mod');
        assert.equal(result.report?.code, 'TARGET_FOREIGN');
        assert.ok(existsSync(path.join(game, 'Mods', 'StardewAgentBridge', 'manifest.json')), '无关目录不得被移动');
    });

    await step('游戏运行中：拒绝安装', async () => {
        const base = freshArea('running');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { cwd: game, stdio: 'ignore' });
        try {
            await new Promise((resolve) => setTimeout(resolve, 300));
            const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]);
            assertExit(result, 2, '游戏运行时必须拒绝安装');
            assert.equal(result.report?.code, 'GAME_RUNNING');
            assert.ok(!existsSync(path.join(game, 'Mods', 'StardewAgentBridge')), '拒绝时不得留下半成品');
        } finally {
            holder.kill('SIGKILL');
        }
    });

    await step('缺少 SMAPI：拒绝安装', async () => {
        const base = freshArea('no-smapi');
        const game = makeGame(path.join(base, 'Stardew Valley'), { withSmapi: false });
        const data = path.join(base, 'data');
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data]);
        assertExit(result, 1, '缺少 SMAPI 必须拒绝');
        assert.equal(result.report?.code, 'GAME_INCOMPLETE');
    });

    await step('--dry-run：只读预演，不创建任何目录', async () => {
        const base = freshArea('dry');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', data, '--dry-run']);
        assertExit(result, 0, '预演应成功');
        assert.ok(!existsSync(path.join(game, BACKUPS)), '预演不得创建快照目录');
        assert.ok(!existsSync(path.join(game, 'Mods', 'StardewAgentBridge')), '预演不得安装');
        assert.ok(!existsSync(path.join(data, 'mod-install.json')), '预演不得写安装记录');
    });

    await step('相对 --data-dir：直接报错，不落盘', async () => {
        const base = freshArea('relative');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const artifact = makeArtifact(path.join(base, 'artifact'));
        const result = run(INSTALL, ['--game-path', game, '--artifact', artifact, '--data-dir', 'relative/dir']);
        assertExit(result, 1, '相对数据根必须报错');
        assert.equal(result.report?.code, 'PATH_INVALID');
        assert.ok(!existsSync(path.join(process.cwd(), 'relative')), '不得创建相对目录');
    });

    await step('产物缺少 DLL：报 ARTIFACT_MISSING', async () => {
        const base = freshArea('artifact');
        const game = makeGame(path.join(base, 'Stardew Valley'));
        const data = path.join(base, 'data');
        const empty = path.join(base, 'empty-artifact');
        mkdirSync(empty, { recursive: true });
        const result = run(INSTALL, ['--game-path', game, '--artifact', empty, '--data-dir', data]);
        assertExit(result, 1, '缺少产物必须报错');
        assert.equal(result.report?.code, 'ARTIFACT_MISSING');
    });

    const failed = steps.filter((item) => !item.ok);
    const summary = {
        platform: process.platform,
        total: steps.length,
        passed: steps.length - failed.length,
        failed: failed.length,
        results: steps
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (area) rmSync(area, { recursive: true, force: true });
    area = null;
    return failed.length === 0 ? 0 : 1;
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        process.stderr.write(`[test-installer] 未捕获错误：${error instanceof Error ? error.stack : String(error)}\n`);
        if (area) rmSync(area, { recursive: true, force: true });
        process.exitCode = 1;
    });
