#!/usr/bin/env node
/**
 * 跨平台 Mod 构建入口。
 *
 * - Linux：走 scripts/linux/build-mod.mjs；
 * - Windows：原样转发到 scripts/build-mod.ps1（保持既有行为与既有测试入口）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function toPowerShellArgs(argv) {
    const mapped = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) continue;
        if (token === '--json') continue;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[index + 1];
            const name = key
                .split('-')
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join('');
            if (next && !next.startsWith('--')) {
                mapped.push(`-${name}`, next);
                index += 1;
            } else {
                mapped.push(`-${name}`);
            }
            continue;
        }
        mapped.push(token);
    }
    return mapped;
}

if (process.platform === 'win32') {
    const result = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'build-mod.ps1'), ...toPowerShellArgs(process.argv.slice(2))],
        { stdio: 'inherit', shell: false }
    );
    process.exitCode = result.error ? 1 : result.status ?? 1;
} else {
    const { main } = await import('./linux/build-mod.mjs');
    process.exitCode = main(process.argv.slice(2));
}
