#!/usr/bin/env node
/** Only the lease entrypoint may invoke modifying maintenance operations. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, emitResult, parseContainerConfig } from './config.mjs';
import { claimVolume } from './volume-owner.mjs';
import { createBackup, listBackups, restoreBackup, verifyBackup, recoverRestore, validBackupId } from './backup.mjs';
import { prepareWorkdir } from './game-seed.mjs';
import { runPreflight } from './preflight.mjs';
import { ownedPath } from './lib.mjs';

/** For diagnostics/tests only. Real writes keep the exclusive lease for their entire lifetime. */
export function isVolumeBusy({ lockFile = LAYOUT.leaseLock, spawnImpl = spawnSync, flockBin = '/usr/bin/flock' } = {}) {
    const result = spawnImpl(flockBin, ['-n', '-E', '13', lockFile, 'true'], { shell: false, stdio: 'ignore' });
    return { busy: result.status === 13, unknown: Boolean(result.error) || ![0, 13].includes(result.status), detail: result.error ? 'FLOCK_UNAVAILABLE' : `exit=${result.status}` };
}
export function main(argv = process.argv.slice(2), deps = {}) {
    if (argv.includes('--help')) { process.stdout.write('maintenance.mjs backup-create|backup-list|backup-verify|backup-restore|recover-restore|prepare-update|check-input [--backup-id ID] [--json]\n'); return 0; }
    const json = argv.includes('--json'), command = argv[0] ?? 'backup-list';
    const fail = (code, message) => emitResult({ ok: false, code, exitCode: EXIT[code], message }, { json });
    if (!(deps.leaseHeld ?? process.env.SAB_LEASE_HELD === '1')) return fail('OWNERSHIP_CONFLICT', '通过数据卷租约入口运行维护命令。');
    const parsed = parseContainerConfig(process.env);
    if (!parsed.ok) return emitResult(parsed, { json });
    try { (deps.claimVolume ?? claimVolume)(parsed.config.home); }
    catch { return fail('OWNERSHIP_CONFLICT', '数据卷不属于本 project。'); }
    let result;
    if (command === 'backup-create') result = createBackup({}, deps);
    else if (command === 'backup-list') result = { ok: true, code: 'OK', exitCode: 0, details: { backups: listBackups() }, notes: ['完整备份清单。'] };
    else if (command === 'recover-restore') result = recoverRestore(deps);
    else if (command === 'prepare-update') result = prepareWorkdir(parsed.config, { ...deps, prepareUpdate: true });
    else if (command === 'check-input') {
        const pre = runPreflight(parsed.config); result = { ...pre, notes: pre.ok ? ['输入检查通过。'] : pre.problems.map(p => p.message), details: {} };
    } else if (['backup-verify', 'backup-restore'].includes(command)) {
        const id = argv[argv.indexOf('--backup-id') + 1];
        if (!argv.includes('--backup-id') || !validBackupId(id)) return fail('CONFIG_INVALID', '提供有效的 --backup-id；不接受任意宿主路径。');
        const from = ownedPath(LAYOUT.backups, path.join(LAYOUT.backups, id));
        result = command === 'backup-verify' ? verifyBackup(from) : restoreBackup({ from }, deps);
    } else return fail('CONFIG_INVALID', '未知维护命令。');
    return emitResult({ ...result, message: result.notes?.join('; ') ?? '', details: result.details ?? { backupId: result.backupId ?? null, restored: result.restored ?? null } }, { json });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = main(); } catch { process.stderr.write('维护操作失败；数据与事务现场保留。\n'); process.exitCode = 14; }
}
