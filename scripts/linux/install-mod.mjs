#!/usr/bin/env node
/**
 * Linux Mod 安装（事务化）。
 *
 * 目标：把项目构建出的 Mod 以「可回退、可恢复、不会毁掉旧版本」的方式装进
 * `<游戏目录>/Mods/StardewAgentBridge`，并把解析后的绝对 `DataDirectory`
 * 写进 Mod 配置——因为通过 Steam 启动游戏不会继承终端的 SAB_HOME。
 *
 * 安全边界：
 * - 只写 `<游戏目录>/Mods/StardewAgentBridge` 与 `<游戏目录>/.stardew-agent-bridge-backups/`；
 * - 游戏在运行或无法确认进程状态时拒绝写入；
 * - 全程 journal 记录阶段，可在任意失败点按真实阶段恢复；
 * - 不执行 sudo、不结束游戏进程、不扫描任意磁盘、不动存档或其他 Mod。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertDedicatedRoot, atomicWriteJson, ensurePrivateDir, resolveDataRoot } from '@sab/platform';
import {
    GAME_DLL,
    MOD_DIR_NAME,
    MOD_ID,
    assertInside,
    inspectGameRoot,
    isBridgeUniqueId,
    isGameRunning,
    listModDirs,
    readInstallRecord,
    resolveGameRoot
} from '../lib/game-paths.mjs';
import {
    copyTree,
    createJournal,
    hashTree,
    journalPath as journalPathOf,
    listTransactions,
    movePath,
    newTransactionId,
    readJournal,
    readLatest,
    recordPhase,
    sameDevice,
    transactionDir,
    verifyTree,
    writeLatest,
    writeJournal
} from '../lib/install-journal.mjs';

const VERSION = readPackageVersion();
const TARGET_NAME = MOD_DIR_NAME;

function readPackageVersion() {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const release = path.resolve(here, '..', 'manifest.release.json');
        const file = existsSync(release) ? release : path.resolve(here, '..', '..', 'package.json');
        return JSON.parse(readFileSync(file, 'utf8')).version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function parseFlags(argv) {
    const flags = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) continue;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[index + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                index += 1;
            } else {
                flags[key] = true;
            }
        } else {
            flags._.push(token);
        }
    }
    return flags;
}

const HELP = `用法：install-mod.mjs --game-path <游戏目录> [选项]

选项：
  --game-path <目录>   星露谷安装目录（原生 Linux 安装；Steam 库可自动发现）
  --artifact <目录>    待安装的 Mod 目录（默认仓库 artifacts/mod/StardewAgentBridge 或包内 mod/）
  --data-dir <目录>    要写入 Mod 配置的绝对数据根（默认按 XDG 规则解析）
  --port <端口>        写入 Mod 配置的 WebSocket 端口（默认沿用已有值或 17654）
  --json               输出机器可读 JSON
  --dry-run            只做只读检查与计划，不写入任何文件
  --help               显示帮助

退出码：0 成功；1 校验失败或已安全回退；2 游戏在运行/状态不明；3 需要人工恢复。
`;

/** 测试与故障注入：环境变量 SAB_FAIL_AT 指定在某个阶段抛出，用于验证恢复路径。 */
function maybeFail(phase) {
    if (process.env.SAB_CRASH_AT === phase) process.exit(99);
    if (process.env.SAB_FAIL_AT === phase) {
        throw new Error(`故障注入：在 ${phase} 阶段模拟失败`);
    }
}

function defaultArtifactDirs() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [
        path.resolve(here, '..', 'mod'),
        path.resolve(here, '..', '..', 'artifacts', 'mod', TARGET_NAME),
        path.resolve(here, '..', '..', 'mod'),
        path.resolve(here, '..', '..', '..', 'mod')
    ];
}

function resolveArtifact(explicit) {
    const candidates = explicit ? [path.resolve(explicit)] : defaultArtifactDirs();
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        const dll = path.join(candidate, 'StardewAgentBridge.dll');
        const manifestFile = path.join(candidate, 'manifest.json');
        if (!existsSync(dll)) continue;
        if (!existsSync(manifestFile)) {
            return { ok: false, dir: candidate, problems: [`产物缺少 manifest.json：${candidate}`] };
        }
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
            return { ok: false, dir: candidate, problems: [`manifest.json 无法解析：${error.message}`] };
        }
        if (manifest.UniqueID !== MOD_ID) {
            return { ok: false, dir: candidate, problems: [`manifest UniqueID 不是 ${MOD_ID}：${manifest.UniqueID}`] };
        }
        return { ok: true, dir: candidate, manifest, problems: [] };
    }
    return {
        ok: false,
        dir: null,
        problems: [
            `没有找到可安装的 Mod 产物（查找：${candidates.join(' / ')}）。`,
            '请先运行 npm run build:mod（Linux 需要 .NET SDK 与本机游戏程序集）。'
        ]
    };
}

function directoryWritable(dir) {
    const probe = path.join(dir, `.sab-write-probe-${process.pid}`);
    try {
        writeFileSync(probe, 'probe', { flag: 'wx' });
        unlinkSync(probe);
        return true;
    } catch {
        try {
            if (existsSync(probe)) unlinkSync(probe);
        } catch {
            /* 忽略 */
        }
        return false;
    }
}

/** 合并配置：保留未知键与原格式，只覆盖本程序拥有的字段。 */
function mergeModConfig(existingText, { dataDirectory, port }) {
    let existing = {};
    if (typeof existingText === 'string' && existingText.trim().length > 0) {
        const stripped = existingText.replace(/^\uFEFF/, '');
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    }
    const merged = { ...existing };
    merged.DataDirectory = dataDirectory;
    if (typeof port === 'number' && Number.isFinite(port)) merged.Port = port;
    if (merged.Port === undefined) merged.Port = 17654;
    if (merged.StopHotkey === undefined) merged.StopHotkey = 'F9';
    if (merged.LinkTimeoutSeconds === undefined) merged.LinkTimeoutSeconds = 5;
    if (merged.PauseAfterEachStep === undefined) merged.PauseAfterEachStep = true;
    return { merged, hadUnknownKeys: Object.keys(existing).some((key) => !['DataDirectory', 'Port', 'StopHotkey', 'LinkTimeoutSeconds', 'PauseAfterEachStep'].includes(key)) };
}

function writeInstallRecord(dataRoot, record) {
    ensurePrivateDir(dataRoot, { platform: 'linux' });
    atomicWriteJson(path.join(dataRoot, 'mod-install.json'), record, { platform: 'linux' });
}

/** 失败恢复：按 journal 记录的真实阶段把旧安装放回 Mods，并保留现场。 */
function restoreAfterFailure(gameRoot, journal) {
    const modsDir = path.join(gameRoot, 'Mods');
    const restored = [];
    const problems = [];
    const targetPath = journal.targetPath ?? path.join(modsDir, TARGET_NAME);

    // 若新目录已经落到目标位置，先把它移到快照区保留，避免与旧版同名。
    const originalTarget = (journal.previous ?? []).find(entry => entry.name === TARGET_NAME);
    const targetMayBeNew = originalTarget ? existsSync(originalTarget.retiredPath) : ['retired_old', 'committed', 'verified'].includes(journal.phase);
    if (targetMayBeNew && existsSync(targetPath)) {
        const parked = path.join(journal.snapshotPath, `failed-current-${Date.now().toString(36)}`);
        try {
            movePath(targetPath, parked);
            restored.push(`已把未完成的新安装移到 ${parked}`);
        } catch (error) {
            problems.push(`无法移动未完成的新安装（${targetPath}）：${error.message}`);
        }
    }
    for (const entry of journal.previous ?? []) {
        const retired = entry.retiredPath;
        const destination = path.join(modsDir, entry.name);
        if (!existsSync(retired) || existsSync(destination)) continue;
        try {
            movePath(retired, destination);
            restored.push(`已恢复旧目录 ${entry.name}`);
        } catch (error) {
            problems.push(`恢复 ${entry.name} 失败：${error.message}`);
        }
    }
    return { restored, problems };
}

export async function main(argv) {
    const flags = parseFlags(argv);
    if (flags.help === true) {
        process.stdout.write(HELP);
        return 0;
    }
    const json = flags.json === true;
    const dryRun = flags['dry-run'] === true;
    const report = { command: 'install', platform: 'linux', ok: false, dryRun, phase: 'preflight', problems: [], notes: [] };
    const done = (code) => {
        if (json) process.stdout.write(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
        return code;
    };
    const fail = (code, codeName, messages, exitCode = 1) => {
        report.ok = false;
        report.code = codeName;
        report.problems.push(...messages.filter(Boolean));
        if (!json) {
            for (const message of report.problems) process.stderr.write(`[install-mod] ${message}\n`);
            process.stderr.write(`[install-mod] 失败码：${codeName}\n`);
        }
        return done(exitCode);
    };

    // 1) 数据根（写入 Mod 配置的必须是绝对路径）
    let dataRoot;
    try {
        dataRoot = resolveDataRoot({
            explicit: typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined,
            env: process.env,
            platform: 'linux',
            homeDir: os.homedir(),
            cwd: process.cwd(),
            requireAbsoluteExplicit: true
        });
        assertDedicatedRoot(dataRoot.path, { homeDir: os.homedir(), platform: 'linux' });
    } catch (error) {
        return fail(1, 'PATH_INVALID', [error instanceof Error ? error.message : String(error)]);
    }
    report.dataRoot = dataRoot.path;
    report.dataRootSource = dataRoot.source;

    // 2) 产物
    const artifact = resolveArtifact(typeof flags.artifact === 'string' ? flags.artifact : undefined);
    if (!artifact.ok) return fail(1, 'ARTIFACT_MISSING', artifact.problems);
    report.artifact = artifact.dir;

    // 3) 游戏目录
    const record = readInstallRecord(dataRoot.path);
    const game = resolveGameRoot({
        explicit: typeof flags['game-path'] === 'string' ? flags['game-path'] : undefined,
        env: process.env,
        homeDir: os.homedir(),
        platform: 'linux',
        recordedGameRoot: record?.gameRoot
    });
    if (!game.ok) {
        return fail(game.candidates.length > 1 ? 1 : 1, game.candidates.length > 1 ? 'GAME_PATH_AMBIGUOUS' : 'GAME_NOT_FOUND', game.problems);
    }
    report.gameRoot = game.gameRoot;
    report.gameRootSource = game.source;
    if (game.problems.length > 0) report.notes.push(...game.problems);
    for (const candidate of [path.join(game.gameRoot, 'Mods'), path.join(game.gameRoot, '.stardew-agent-bridge-backups'), path.join(game.gameRoot, 'Mods', TARGET_NAME)]) {
        const safe = assertInside(game.gameRoot, candidate, 'linux');
        if (!safe.ok) return fail(1, 'PATH_ESCAPE', [safe.reason]);
    }

    // 4) 进程状态（无法确认就拒绝写入）
    const running = isGameRunning({ gameRoot: game.gameRoot, platform: 'linux' });
    report.gameRunning = running.running;
    if (running.running === null) return fail(2, 'GAME_STATE_UNKNOWN', [running.reason ?? '无法确认游戏进程状态。'], 2);
    if (running.running) {
        return fail(
            2,
            'GAME_RUNNING',
            [`游戏正在运行（${running.reason}）。SMAPI 不支持热加载新 Mod，请先正常退出游戏再安装。`],
            2
        );
    }

    // 5) 目录结构
    const inspected = inspectGameRoot(game.gameRoot);
    if (inspected.problems.length > 0) return fail(1, 'GAME_INCOMPLETE', inspected.problems);
    if (!inspected.modsDirExists) {
        return fail(1, 'MODS_MISSING', [`找不到 Mods 目录：${inspected.modsDir}。请先启动一次带 SMAPI 的游戏以生成它。`]);
    }
    if (!directoryWritable(inspected.modsDir)) {
        return fail(1, 'MODS_NOT_WRITABLE', [`Mods 目录不可写：${inspected.modsDir}。本程序不会调用 sudo，请修正权限后重试。`]);
    }

    // 6) 未完成事务
    for (const transaction of listTransactions(game.gameRoot)) {
        if (!transaction.ok || transaction.journal.status === 'in_progress' ||
            (transaction.journal.status === 'failed' && transaction.journal.recoveryRequired !== false)) {
            return fail(3, 'RECOVERY_REQUIRED', [`事务 ${transaction.transactionId} 尚未完成或无法核验，请先恢复；本次没有开始新安装。`], 3);
        }
    }
    const latest = readLatest(game.gameRoot);
    if (latest && latest.transactionId) {
        if (typeof latest.transactionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(latest.transactionId)) return fail(3, 'RECOVERY_REQUIRED', ['latest 中的事务ID无效，已拒绝读取越界路径。'], 3);
        const previousJournal = readJournal(journalPathOf(game.gameRoot, latest.transactionId));
        if (previousJournal.ok && previousJournal.journal.status === 'in_progress') {
            return fail(
                3,
                'RECOVERY_REQUIRED',
                [
                    `发现未完成的安装事务 ${latest.transactionId}（阶段 ${previousJournal.journal.phase}）。`,
                    `请先运行：node scripts/rollback-mod.mjs --game-path "${game.gameRoot}" --transaction ${latest.transactionId}`,
                    '或按 docs/TROUBLESHOOTING.md 的说明人工核对；本程序不会自动删除现场。'
                ],
                3
            );
        }
        if (!previousJournal.ok) {
            report.notes.push(`上一次事务的 journal 无法解析（${previousJournal.problem}），本次安装会新建事务，旧快照保持不动。`);
        }
    }

    // 7) 现有桥接目录
    const targetPath = path.join(inspected.modsDir, TARGET_NAME);
    const mods = listModDirs(inspected.modsDir);
    const previous = [];
    for (const entry of mods) {
        const isTarget = entry.dir === targetPath;
        if (isTarget && entry.uniqueId !== MOD_ID) {
            return fail(1, 'TARGET_FOREIGN', [
                `目标目录已存在但不是本项目的 Mod（UniqueID=${entry.uniqueId ?? '缺失'}）：${entry.dir}`,
                '为安全起见拒绝覆盖，也不会移动无关目录。'
            ]);
        }
        if (isTarget || (entry.uniqueId && isBridgeUniqueId(entry.uniqueId))) {
            previous.push({ name: entry.name, uniqueId: entry.uniqueId });
        }
    }
    report.previous = previous.map((entry) => entry.name);

    // 旧 Mod 配置（保留未知键）
    const previousConfigPath = path.join(targetPath, 'config.json');
    let previousConfigText = null;
    if (existsSync(previousConfigPath)) {
        try {
            previousConfigText = readFileSync(previousConfigPath, 'utf8');
        } catch (error) {
            return fail(1, 'CONFIG_INVALID', [`已有 Mod 配置无法读取：${error.message}`]);
        }
    }
    let mergedConfig;
    try {
        mergedConfig = mergeModConfig(previousConfigText, {
            dataDirectory: dataRoot.path,
            port: typeof flags.port === 'string' ? Number(flags.port) : undefined
        });
    } catch (error) {
        return fail(1, 'CONFIG_INVALID', [
            `已有 Mod 配置不是合法 JSON（${previousConfigPath}）：${error.message}`,
            '原文件不会被修改；请先修正或手动备份后重试。'
        ]);
    }
    report.config = { path: path.join(targetPath, 'config.json'), dataDirectory: dataRoot.path, port: mergedConfig.merged.Port };
    if (mergedConfig.hadUnknownKeys) report.notes.push('已有配置含未知键，已原样保留。');

    if (dryRun) {
        report.ok = true;
        report.phase = 'preflight';
        report.notes.push('--dry-run：只做只读检查，没有写入任何文件。');
        if (!json) {
            process.stdout.write(`[install-mod] 预演：目标 ${targetPath}\n`);
            process.stdout.write(`[install-mod] 预演：数据根 ${dataRoot.path}（来源 ${dataRoot.source}）\n`);
            for (const note of report.notes) process.stdout.write(`[install-mod] ${note}\n`);
        }
        return done(0);
    }

    // 8) 事务
    const transactionId = newTransactionId();
    const snapshot = transactionDir(game.gameRoot, transactionId);
    let journal = createJournal({
        gameRoot: game.gameRoot,
        dataRoot: dataRoot.path,
        transactionId,
        programVersion: VERSION,
        targetName: TARGET_NAME
    });
    const journalFile = journalPathOf(game.gameRoot, transactionId);
    report.transactionId = transactionId;

    const advance = (phase, note) => {
        journal = recordPhase(journal, phase, note);
        journal = writeJournal(journalFile, journal);
        report.phase = phase;
        maybeFail(phase);
        return journal;
    };

    try {
        mkdirSync(path.join(snapshot, 'previous'), { recursive: true, mode: 0o700 });
        mkdirSync(path.join(snapshot, 'retired'), { recursive: true, mode: 0o700 });
        journal = writeJournal(journalFile, journal);
        advance('preflight', '预检通过');

        // 8.1 stage：复制到快照区并校验哈希
        const staging = path.join(snapshot, 'staging');
        const copied = copyTree(artifact.dir, staging);
        if (copied.skipped.length > 0) {
            throw Object.assign(new Error(`产物中包含符号链接，已拒绝：${copied.skipped.join(', ')}`), { code: 'SYMLINK_UNSUPPORTED' });
        }
        journal.hashes.staging = hashTree(staging);
        const stagingProblems = verifyTree(staging, journal.hashes.staging);
        if (stagingProblems.length > 0) {
            throw Object.assign(new Error(`暂存校验失败：${stagingProblems.join('；')}`), { code: 'STAGE_INCOMPLETE' });
        }
        if (!existsSync(path.join(staging, 'StardewAgentBridge.dll')) || !existsSync(path.join(staging, 'manifest.json'))) {
            throw Object.assign(new Error('暂存目录缺少 DLL 或 manifest.json'), { code: 'STAGE_INCOMPLETE' });
        }
        advance('staged', `已暂存 ${Object.keys(journal.hashes.staging).length} 个文件`);

        // 8.2 backup：把现有桥接目录复制到快照区（不移动，先保证可恢复）
        journal.previous = previous.map((entry) => ({
            name: entry.name,
            uniqueId: entry.uniqueId,
            backupPath: path.join(snapshot, 'previous', entry.name),
            retiredPath: path.join(snapshot, 'retired', entry.name)
        }));
        for (const entry of journal.previous) {
            const back = path.join(snapshot, 'previous', entry.name);
            const result = copyTree(path.join(inspected.modsDir, entry.name), back);
            if (result.skipped.length > 0) {
                throw Object.assign(new Error(`旧目录含符号链接，拒绝处理：${entry.name}`), { code: 'SYMLINK_UNSUPPORTED' });
            }
            journal.hashes.backup[entry.name] = hashTree(back);
            const problems = verifyTree(back, journal.hashes.backup[entry.name]);
            if (problems.length > 0) {
                throw Object.assign(new Error(`备份校验失败（${entry.name}）：${problems.join('；')}`), { code: 'BACKUP_INCOMPLETE' });
            }
        }
        advance('backuped', `已备份 ${journal.previous.length} 个现有目录`);

        // 8.3 configure：只看备份里的旧配置，保留未知键
        if (previousConfigText !== null) {
            const backupConfig = path.join(snapshot, 'previous', TARGET_NAME, 'config.json');
            if (!existsSync(backupConfig)) writeFileSync(backupConfig, previousConfigText, 'utf8');
        }
        writeFileSync(path.join(staging, 'config.json'), `${JSON.stringify(mergedConfig.merged, null, 2)}\n`, 'utf8');
        journal.config = { written: true, dataDirectory: dataRoot.path, port: mergedConfig.merged.Port };
        // 配置文件也纳入哈希校验范围
        journal.hashes.staging['config.json'] = hashTree(staging)['config.json'];
        advance('prepared', '已写入 Mod 配置（DataDirectory 为绝对路径）');

        // 8.4 commit：先移走旧目录，再把暂存目录原子放到目标位置
        if (!sameDevice(staging, path.dirname(targetPath))) {
            throw Object.assign(new Error(`暂存目录与 Mods 目录不在同一文件系统，拒绝跨设备 rename：${staging}`), {
                code: 'CROSS_DEVICE'
            });
        }
        for (const entry of journal.previous) {
            const source = path.join(inspected.modsDir, entry.name);
            if (!existsSync(source)) continue;
            const safe = assertInside(inspected.modsDir, source, 'linux');
            if (!safe.ok) throw Object.assign(new Error(safe.reason), { code: 'PATH_ESCAPE' });
            movePath(source, entry.retiredPath);
        }
        advance('retired_old', '旧桥接目录已移入快照区');
        movePath(staging, targetPath);
        advance('committed', '新 Mod 已放到目标目录');

        // 8.5 verify
        const installedManifest = JSON.parse(readFileSync(path.join(targetPath, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (installedManifest.UniqueID !== MOD_ID) {
            throw Object.assign(new Error(`安装后 manifest 标识异常：${installedManifest.UniqueID}`), { code: 'VERIFY_FAILED' });
        }
        if (!existsSync(path.join(targetPath, GAME_DLL))) {
            report.notes.push('提示：安装目录内没有游戏 DLL（正常，本程序从不复制游戏文件）。');
        }
        const installedConfig = JSON.parse(readFileSync(path.join(targetPath, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (installedConfig.DataDirectory !== dataRoot.path) {
            throw Object.assign(new Error('安装后配置的 DataDirectory 与预期不一致'), { code: 'VERIFY_FAILED' });
        }
        // 审计：不允许把游戏本体或存档带进 Mods
        if (existsSync(path.join(targetPath, 'Stardew Valley.dll')) || existsSync(path.join(targetPath, 'StardewModdingAPI.dll'))) {
            throw Object.assign(new Error('安装目录出现游戏程序集，已中止'), { code: 'VERIFY_FAILED' });
        }
        journal = recordPhase(journal, 'verified', '安装校验通过');
        journal = { ...journal, status: 'installed' };
        journal = writeJournal(journalFile, journal);
        writeLatest(game.gameRoot, journal);
        writeInstallRecord(dataRoot.path, {
            schemaVersion: 1,
            gameRoot: game.gameRoot,
            transactionId,
            installedAt: new Date().toISOString(),
            dataDirectory: dataRoot.path,
            programVersion: VERSION
        });

        report.ok = true;
        report.phase = 'verified';
        report.installedTo = targetPath;
        report.notes.push(
            '下一步：1) 启动一次 Bridge 生成凭据（stardew-agent-bridge start 或桌面入口）；',
            '2) 通过 SMAPI 启动游戏并加载单人存档；3) 运行 stardew-agent-bridge doctor 确认 Mod 连接与 DataDirectory 一致。'
        );
        if (!json) {
            process.stdout.write(`[install-mod] 已安装到：${targetPath}\n`);
            process.stdout.write(`[install-mod] 事务：${transactionId}\n`);
            process.stdout.write(`[install-mod] 数据根（已写入 Mod 配置）：${dataRoot.path}\n`);
            for (const note of report.notes) process.stdout.write(`[install-mod] ${note}\n`);
        }
        return done(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal = { ...journal, status: 'failed', failure: { phase: journal.phase, message, code: error?.code ?? 'UNKNOWN' } };
        try {
            journal = writeJournal(journalFile, journal);
        } catch {
            /* journal 写不进去时仍继续尝试恢复 */
        }
        const restore = restoreAfterFailure(game.gameRoot, journal);
        journal = { ...journal, recoveryRequired: restore.problems.length > 0 };
        try { journal = writeJournal(journalFile, journal); } catch {}
        report.restored = restore.restored;
        const exitCode = restore.problems.length === 0 ? 1 : 3;
        return fail(exitCode, error?.code ?? 'INSTALL_FAILED', [
            `安装失败（阶段 ${journal.phase}）：${message}`,
            `事务快照与 journal 保留在：${snapshot}`,
            ...restore.restored,
            ...restore.problems
        ], exitCode);
    }
}
