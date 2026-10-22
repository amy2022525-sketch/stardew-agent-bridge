#!/usr/bin/env node
/** 清理构建产物（不动 node_modules 与本机数据目录）。 */
import { readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const targets = [
    'packages/contracts/dist',
    'packages/game-client/dist',
    'packages/control-core/dist',
    'packages/mcp/dist',
    'apps/server/dist',
    'apps/web/dist',
    'apps/web/dist-types',
    'adapters/stdio/dist',
    'tests/dist',
    'release'
];

for (const target of targets) {
    const full = path.join(root, target);
    if (existsSync(full)) {
        rmSync(full, { recursive: true, force: true });
        process.stdout.write(`已删除 ${target}\n`);
    }
}

for (const dir of ['packages', 'apps', 'adapters', 'tests']) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
        const candidate = path.join(base, entry, 'tsconfig.tsbuildinfo');
        if (existsSync(candidate)) rmSync(candidate, { force: true });
    }
}

const rootTsBuildInfo = path.join(root, 'tsconfig.tsbuildinfo');
if (existsSync(rootTsBuildInfo)) rmSync(rootTsBuildInfo, { force: true });

process.stdout.write('清理完成。\n');
