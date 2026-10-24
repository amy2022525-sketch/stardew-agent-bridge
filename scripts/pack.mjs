#!/usr/bin/env node
/**
 * 跨平台打包入口。
 *
 * - Linux：走 scripts/linux/pack.mjs（包内 Node + 自包含脚本 + manifest.release.json）；
 * - Windows：原样转发到 scripts/pack.ps1，保持既有产物结构与既有验收流程。
 *
 * Windows 与 Linux 是两个独立发布包，Linux 适配不改变 Windows 包验证。
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
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pack.ps1'), ...toPowerShellArgs(process.argv.slice(2))],
        { stdio: 'inherit', shell: false }
    );
    process.exitCode = result.error ? 1 : result.status ?? 1;
} else {
    const { main } = await import('./linux/pack.mjs');
    process.exitCode = main(process.argv.slice(2));
}
