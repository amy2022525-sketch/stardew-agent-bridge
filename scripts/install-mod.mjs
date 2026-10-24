#!/usr/bin/env node
/**
 * 跨平台 Mod 安装入口。
 *
 * - Linux：走 scripts/linux/install-mod.mjs（事务化安装 + journal）；
 * - Windows：原样转发到 scripts/install-mod.ps1，保持既有行为与既有测试入口。
 *
 * 参数以 argv 数组直接 spawn，任何路径都只作为参数数据传递，不经过 shell。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 把 `--k v` / `--flag` 映射成 PowerShell 参数（-Key v / -Flag）。 */
function toPowerShellArgs(argv) {
    const mapped = [];
    const unsupported = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) continue;
        if (token === '--json' || token === '--dry-run') {
            unsupported.push(token);
            continue;
        }
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
    return { mapped, unsupported };
}

if (process.platform === 'win32') {
    const { mapped, unsupported } = toPowerShellArgs(process.argv.slice(2));
    if (unsupported.length > 0) {
        process.stderr.write(
            `[install-mod] Windows 入口暂不支持：${unsupported.join(', ')}（PowerShell 版安装器没有对应选项）。\n`
        );
        process.exitCode = 1;
    } else {
        const result = spawnSync(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'install-mod.ps1'), ...mapped],
            { stdio: 'inherit', shell: false }
        );
        if (result.error) {
            process.stderr.write(`[install-mod] 无法调用 PowerShell：${result.error.message}\n`);
            process.exitCode = 1;
        } else {
            process.exitCode = result.status ?? 1;
        }
    }
} else {
    const { main } = await import('./linux/install-mod.mjs');
    process.exitCode = await main(process.argv.slice(2));
}
