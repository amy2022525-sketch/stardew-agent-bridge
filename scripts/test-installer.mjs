#!/usr/bin/env node
/**
 * 安装/回退测试入口（跨平台分派）。
 *
 * - Windows：原样转发到 tests/scripts/install-rollback.ps1（保持既有行为与既有断言）；
 * - Linux：运行 tests/scripts/install-rollback-linux.mjs（临时目录伪造游戏目录，
 *   含故障注入与恢复路径断言，不接触真实游戏或 Steam）。
 *
 * 注意：本脚本会真实创建/移动临时文件，但不触碰任何真实游戏目录。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

if (process.platform === 'win32') {
    const script = path.join(repo, 'tests', 'scripts', 'install-rollback.ps1');
    const result = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...process.argv.slice(2)],
        { stdio: 'inherit', shell: false }
    );
    process.exitCode = result.error ? 1 : result.status ?? 1;
} else {
    const result = spawnSync(
        process.execPath,
        [path.join(repo, 'tests', 'scripts', 'install-rollback-linux.mjs'), ...process.argv.slice(2)],
        { stdio: 'inherit', shell: false }
    );
    process.exitCode = result.error ? 1 : result.status ?? 1;
}
