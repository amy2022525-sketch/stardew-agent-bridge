#!/usr/bin/env node
/**
 * Linux Mod 回退 / 停用。
 *
 * 三种用法：
 *   --remove-only        只停用当前安装（旧版仍留在快照区，之后还能恢复）
 *   默认                 停用当前安装并恢复事务里记录的旧桥接目录
 *   --transaction <id>   指定事务（默认取 latest 指针或最近一次）
 *
 * 安全边界：
 * - 只碰 `<游戏目录>/Mods` 与 `<游戏目录>/.stardew-agent-bridge-backups/`；
 * - 不碰存档、游戏本体与其他 Mod；
 * - 重复执行幂等；journal 损坏、路径被篡改、恢复目标已存在时拒绝危险覆盖并保留现场。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from '@sab/platform';
import {
    MOD_DIR_NAME,
    MOD_ID,
    assertInside,
    isGameRunning,
    readInstallRecord,
    resolveGameRoot
} from '../lib/game-paths.mjs';
import {
    backupsRoot,
    copyTree,
    hashTree,
    journalPath as journalPathOf,
    listTransactions,
    movePath,
    readJournal,
    readLatest,
    recordPhase,
    transactionDir,
    verifyTree,
    writeJournal
} from '../lib/install-journal.mjs';

const TARGET_NAME = MOD_DIR_NAME;

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

const HELP = `用法：rollback-mod.mjs [--game-path <游戏目录>] [--transaction <id>] [--remove-only] [--json]

选项：
  --game-path <目录>   星露谷安装目录（默认取安装记录或 Steam 库发现）
  --transaction <id>   指定要回退的事务（默认 latest 指针或最近一次）
  --remove-only        只停用当前安装，保留旧版快照以便之后恢复
  --data-dir <目录>    数据根（读取安装记录；默认按 XDG 规则解析）
  --json               输出机器可读 JSON

退出码：0 成功或已幂等；2 游戏运行中/状态不明；3 需要人工恢复；1 校验失败。
`;

function readManifest(dir) {
    try {
        return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

export function main(argv) {
    const flags = parseFlags(argv);
    if (flags.help === true) {
        process.stdout.write(HELP);
        return 0;
    }
    const json = flags.json === true;
    const removeOnly = flags['remove-only'] === true;
    const report = { command: 'rollback', platform: 'linux', ok: false, removeOnly, phase: 'preflight', problems: [], notes: [] };
    const done = (code) => {
        if (json) process.stdout.write(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
        return code;
    };
    const fail = (exitCode, codeName, messages) => {
        report.ok = false;
        report.code = codeName;
        report.problems.push(...messages.filter(Boolean));
        if (!json) {
            for (const message of report.problems) process.stderr.write(`[rollback-mod] ${message}\n`);
            process.stderr.write(`[rollback-mod] 失败码：${codeName}\n`);
        }
        return done(exitCode);
    };

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
    } catch (error) {
        return fail(1, 'PATH_INVALID', [error instanceof Error ? error.message : String(error)]);
    }
    report.dataRoot = dataRoot.path;

    const record = readInstallRecord(dataRoot.path);
    const game = resolveGameRoot({
        explicit: typeof flags['game-path'] === 'string' ? flags['game-path'] : undefined,
        env: process.env,
        homeDir: os.homedir(),
        platform: 'linux',
        recordedGameRoot: record?.gameRoot
    });
    if (!game.ok) return fail(1, 'GAME_NOT_FOUND', game.problems);
    report.gameRoot = game.gameRoot;
    for (const candidate of [path.join(game.gameRoot, 'Mods'), backupsRoot(game.gameRoot), path.join(game.gameRoot, 'Mods', TARGET_NAME)]) {
        const safe = assertInside(game.gameRoot, candidate, 'linux');
        if (!safe.ok) return fail(3, 'JOURNAL_TAMPERED', [safe.reason]);
    }

    const running = isGameRunning({ gameRoot: game.gameRoot, platform: 'linux' });
    if (running.running === null) return fail(2, 'GAME_STATE_UNKNOWN', [running.reason ?? '无法确认游戏进程状态。']);
    if (running.running) {
        return fail(2, 'GAME_RUNNING', [`游戏正在运行（${running.reason}）。请先正常退出游戏再回退。`]);
    }

    // 选择事务
    const requested = typeof flags.transaction === 'string' ? flags.transaction : null;
    const latest = readLatest(game.gameRoot);
    let transactionId = requested ?? latest?.transactionId ?? null;
    if (!transactionId) {
        const all = listTransactions(game.gameRoot);
        transactionId = all[0]?.transactionId ?? null;
    }
    if (!transactionId) {
        return fail(1, 'NO_TRANSACTION', [
            `没有找到本项目在该游戏目录下的安装事务：${backupsRoot(game.gameRoot)}`,
            '拒绝猜测或删除现有目录。'
        ]);
    }
    report.transactionId = transactionId;
    if (typeof transactionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(transactionId)) {
        return fail(3, 'JOURNAL_TAMPERED', ['事务ID必须是本项目生成的单段目录名。']);
    }

    const snapshot = transactionDir(game.gameRoot, transactionId);
    const journalFile = journalPathOf(game.gameRoot, transactionId);
    const parsed = readJournal(journalFile);
    if (!parsed.ok) {
        return fail(3, 'JOURNAL_INVALID', [
            `事务 ${transactionId} 的 journal 不可用：${parsed.problem}`,
            `现场与快照保持不动：${snapshot}。请人工核对后再决定是否手动处理。`
        ]);
    }
    let journal = parsed.journal;
    const modsDir = path.join(game.gameRoot, 'Mods');
    const targetPath = path.join(modsDir, TARGET_NAME);

    // 重新校验所有记录路径（不信任历史内容）
    const pathProblems = [];
    if (journal.gameRoot !== game.gameRoot || journal.transactionId !== transactionId || journal.snapshotPath !== snapshot || journal.targetPath !== targetPath || journal.targetName !== TARGET_NAME) {
        pathProblems.push('journal 的游戏根、事务ID、快照或目标与当前选择不一致。');
    }
    if (!Array.isArray(journal.previous)) return fail(3, 'JOURNAL_TAMPERED', ['journal.previous 必须是数组。']);
    for (const entry of journal.previous ?? []) {
        const destination = path.join(modsDir, entry.name);
        const allowedDestination = assertInside(modsDir, destination, 'linux');
        if (!allowedDestination.ok) pathProblems.push(allowedDestination.reason);
        for (const candidate of [entry.backupPath, entry.retiredPath]) {
            if (!candidate) continue;
            const allowed = assertInside(snapshot, candidate, 'linux');
            if (!allowed.ok) pathProblems.push(allowed.reason);
        }
        if (typeof entry.name !== 'string' || entry.name !== path.basename(entry.name) || entry.name === '..') {
            pathProblems.push(`备份记录中的目录名不合法：${entry.name}`);
        }
    }
    if (pathProblems.length > 0) {
        return fail(3, 'JOURNAL_TAMPERED', [
            '事务记录里的路径未通过安全校验，已拒绝执行：',
            ...pathProblems,
            `现场保持不动：${snapshot}`
        ]);
    }

    // 幂等：已经回退过
    if (journal.status === 'rolled_back' || (journal.status === 'failed' && journal.recoveryRequired === false)) {
        report.ok = true;
        report.phase = 'rolled_back';
        report.notes.push(`事务 ${transactionId} 已经回退过，本次不移动当前目录（它可能是已恢复的旧版或后续新安装）。`);
        return done(0);
    }
    if (journal.status === 'remove_only' && removeOnly) {
        report.ok = true;
        report.phase = 'remove_only';
        report.notes.push('当前事务已经是停用状态；旧版仍在快照区，可用不带 --remove-only 的命令恢复。');
        if (!json) process.stdout.write('[rollback-mod] 已经是停用状态，未做改动。\n');
        return done(0);
    }

    // 当前安装必须属于本项目
    let movedCurrent = null;
    const originalTarget = journal.previous.find(entry => entry.name === TARGET_NAME);
    const targetIsUntouchedOriginal = journal.status !== 'installed' && originalTarget && !existsSync(originalTarget.retiredPath);
    if (existsSync(targetPath) && !targetIsUntouchedOriginal) {
        const manifest = readManifest(targetPath);
        if (!manifest || manifest.UniqueID !== MOD_ID) {
            return fail(3, 'TARGET_FOREIGN', [
                `当前目录不是本项目 Mod（${targetPath}），拒绝移动或删除。`,
                `现场保持不动：${snapshot}`
            ]);
        }
        const park = path.join(snapshot, `rollback-current-${new Date().toISOString().replace(/[-:.]/g, '')}`);
        try {
            mkdirSync(snapshot, { recursive: true, mode: 0o700 });
            movePath(targetPath, park);
            movedCurrent = park;
            report.parkedCurrent = park;
        } catch (error) {
            return fail(3, 'MOVE_FAILED', [`无法把当前安装移到快照区：${error.message}`, `现场保持不动：${snapshot}`]);
        }
    } else {
        report.notes.push('目标目录当前不存在（可能已停用），继续按事务记录恢复旧版。');
    }

    if (removeOnly) {
        journal = recordPhase(journal, 'remove_only', '只停用当前安装，旧版保留在快照区');
        journal = { ...journal, status: 'remove_only' };
        journal = writeJournal(journalFile, journal);
        report.ok = true;
        report.phase = 'remove_only';
        report.notes.push(
            `旧版仍保存在 ${path.join(snapshot, 'retired')} 与 ${path.join(snapshot, 'previous')}；`,
            `如需恢复，运行：node scripts/rollback-mod.mjs --game-path "${game.gameRoot}" --transaction ${transactionId}（不带 --remove-only）。`
        );
        if (!json) {
            process.stdout.write(`[rollback-mod] 已停用当前安装${movedCurrent ? `（移到 ${movedCurrent}）` : ''}。\n`);
            for (const note of report.notes) process.stdout.write(`[rollback-mod] ${note}\n`);
        }
        return done(0);
    }

    // 恢复旧版
    const restored = [];
    const problems = [];
    for (const entry of journal.previous ?? []) {
        const destination = path.join(modsDir, entry.name);
        if (existsSync(destination)) {
            if (journal.status !== 'installed' && !existsSync(entry.retiredPath)) {
                const mismatch = verifyTree(destination, journal.hashes?.backup?.[entry.name] ?? {});
                if (mismatch.length === 0) { restored.push(`${entry.name}（原目录未移动）`); continue; }
            }
            problems.push(`恢复目标已存在，拒绝覆盖：${destination}`);
            continue;
        }
        const retired = entry.retiredPath;
        const backup = entry.backupPath;
        try {
            if (retired && existsSync(retired)) {
                movePath(retired, destination);
                restored.push(`${entry.name}（原位移动）`);
            } else if (backup && existsSync(backup)) {
                const copy = copyTree(backup, destination);
                if (copy.skipped.length > 0) {
                    problems.push(`恢复 ${entry.name} 时遇到符号链接，已跳过：${copy.skipped.join(', ')}`);
                }
                const hashes = hashTree(destination);
                const mismatch = verifyTree(destination, journal.hashes?.backup?.[entry.name] ?? hashes);
                if (mismatch.length > 0) problems.push(`恢复校验失败（${entry.name}）：${mismatch.join('；')}`);
                else restored.push(`${entry.name}（从备份复制）`);
            } else {
                problems.push(`事务里记录的 ${entry.name} 既没有原位目录也没有备份文件。`);
            }
        } catch (error) {
            problems.push(`恢复 ${entry.name} 失败：${error.message}`);
        }
    }

    journal = recordPhase(journal, 'rolled_back', `恢复到 ${restored.length} 个旧目录`);
    journal = { ...journal, status: problems.length === 0 ? 'rolled_back' : 'failed', failure: problems.length === 0 ? null : { phase: 'rolled_back', message: problems.join('；') } };
    journal = writeJournal(journalFile, journal);

    report.restored = restored;
    if (problems.length > 0) {
        return fail(3, 'RESTORE_INCOMPLETE', [
            ...problems,
            `快照与 journal 保留在：${snapshot}`,
            '请按 docs/TROUBLESHOOTING.md 人工核对；本程序不会删除现场。'
        ]);
    }
    report.ok = true;
    report.phase = 'rolled_back';
    report.notes.push('游戏存档与游戏本体未被修改。');
    if (!json) {
        if (movedCurrent) process.stdout.write(`[rollback-mod] 当前安装已移到：${movedCurrent}\n`);
        for (const item of restored) process.stdout.write(`[rollback-mod] 已恢复：${item}\n`);
        for (const note of report.notes) process.stdout.write(`[rollback-mod] ${note}\n`);
    }
    return done(0);
}
