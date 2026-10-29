#!/usr/bin/env node
/** One stable kernel lease surrounds the entire runtime OR maintenance operation. */
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, emitResult, parseContainerConfig } from './config.mjs';
import { ownedPath } from './lib.mjs';

export const HELP = 'lease-entrypoint.mjs [--mode bridge|game] [--entry supervisor|maintenance|mod-build] [--check] [-- <entry arguments>]\n';
export function checkVolumeAccess({ dataDir = LAYOUT.data, lockFile = LAYOUT.leaseLock } = {}) {
    try {
        ownedPath(dataDir, lockFile);
        const stat = lstatSync(dataDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据卷不是正常目录。');
        accessSync(dataDir, constants.W_OK | constants.R_OK | constants.X_OK);
        if (existsSync(lockFile)) {
            const lock = lstatSync(lockFile);
            if (!lock.isFile() || lock.nlink !== 1 || (process.platform !== 'win32' && (lock.mode & 0o777) !== 0o600)) throw new Error('租约文件类型或权限不符。');
        }
        return { ok: true, message: '数据卷可访问（只读检查）。' };
    } catch (error) { return { ok: false, message: error.message }; }
}
export function spawnWithLease({ lockFile = LAYOUT.leaseLock, nodeBin = LAYOUT.node, entry = path.join(LAYOUT.container, 'supervisor.mjs'), extraArgs = [], env = process.env, spawnImpl = spawn, flockBin = '/usr/bin/flock' } = {}) {
    const args = ['--no-fork', '-n', '-E', '13', lockFile, nodeBin, entry, ...extraArgs];
    return { child: spawnImpl(flockBin, args, { shell: false, stdio: 'inherit', env: { ...env, SAB_LEASE_HELD: '1' } }), args: [flockBin, ...args] };
}
export async function main(argv = process.argv.slice(2), deps = {}) {
    if (argv.includes('--help')) { process.stdout.write(HELP); return 0; }
    const split = argv.indexOf('--');
    const own = split < 0 ? argv : argv.slice(0, split);
    const rest = split < 0 ? [] : argv.slice(split + 1);
    const value = flag => own.indexOf(flag) < 0 ? undefined : own[own.indexOf(flag) + 1];
    const entryName = value('--entry') ?? 'supervisor';
    const json = own.includes('--json');
    if (!['supervisor', 'maintenance', 'mod-build'].includes(entryName)) return emitResult({ ok: false, code: 'CONFIG_INVALID', message: '受控入口无效。', exitCode: 10 }, { json });
    const parsed = parseContainerConfig(process.env, { mode: value('--mode') });
    if (!parsed.ok) return emitResult(parsed, { json });
    const dataDir = entryName === 'mod-build' ? LAYOUT.inputMod : parsed.config.home;
    const lockFile = entryName === 'mod-build' ? path.join(dataDir, 'artifact.lock') : LAYOUT.leaseLock;
    const access = (deps.checkVolumeAccess ?? checkVolumeAccess)({ dataDir, lockFile });
    if (!access.ok) return emitResult({ ok: false, code: 'PERMISSION_DENIED', message: access.message, exitCode: 12 }, { json });
    if (own.includes('--check')) return emitResult({ ok: true, code: 'OK', message: access.message }, { json });
    process.umask(0o077);
    if (!deps.spawnWithLease) { const fd = openSync(ownedPath(dataDir, lockFile), 'a', 0o600); closeSync(fd); }
    const { child } = (deps.spawnWithLease ?? spawnWithLease)({ lockFile, nodeBin: deps.nodeBin ?? LAYOUT.node,
        entry: path.join(LAYOUT.container, `${entryName}.mjs`), extraArgs: entryName === 'supervisor' ? ['--mode', parsed.config.mode] : rest });
    const term = () => child.kill('SIGTERM');
    const interrupt = () => child.kill('SIGINT');
    process.on('SIGTERM', term); process.on('SIGINT', interrupt);
    try {
        const result = await new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('exit', (code, signal) => resolve({ code, signal })); });
        if (result.error) return emitResult({ ok: false, code: 'CHILD_EXITED', message: '无法启动持锁子进程。', exitCode: 16 }, { json });
        if (result.code === 13) return emitResult({ ok: false, code: 'OWNERSHIP_CONFLICT', message: '数据卷正被其他运行或维护进程持有。', exitCode: 13 }, { json });
        return result.code ?? (result.signal ? 143 : EXIT.CHILD_EXITED);
    } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('受控入口启动失败。\n'); process.exitCode = 16; });
