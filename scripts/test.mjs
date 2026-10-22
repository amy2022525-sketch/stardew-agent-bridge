#!/usr/bin/env node
/**
 * 测试编排：先编译（含测试），再用 node:test 运行。
 * 模拟测试与真实游戏实测必须分开记录，这里只负责模拟与契约层。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false']);

const testDir = path.join(root, 'tests', 'dist', 'src');
if (!existsSync(testDir)) {
    console.error(`[test] 没有找到编译后的测试目录：${testDir}`);
    process.exit(1);
}

run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...readdirSync(testDir).filter(file => file.endsWith('.test.js')).map(file => path.join(testDir, file))]);
