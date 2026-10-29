#!/usr/bin/env node
/**
 * 构建编排：先 TypeScript 项目引用编译，再打包 Web 控制台。
 * 用法：node scripts/build.mjs [--check-only]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildSync } from 'esbuild';
import { syncSourceAssets } from './source-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check-only');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false,
        ...options
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

console.log('[build] TypeScript 项目引用编译…');
run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false']);
syncSourceAssets(root);

console.log('[build] 类型检查 Web 控制台…');
run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'apps/web', '--noEmit', '--pretty', 'false']);

if (checkOnly) {
    console.log('[build] 仅类型检查完成。');
    process.exit(0);
}


console.log('[build] 打包 Web 控制台…');
const webRoot = path.join(root, 'apps', 'web');
const dist = path.join(webRoot, 'dist');
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

buildSync({ entryPoints: [path.join(webRoot, 'src', 'main.ts')], bundle: true, format: 'esm', target: 'es2022',
    sourcemap: true, outfile: path.join(dist, 'app.js'), logLevel: 'warning' });

for (const asset of ['index.html']) {
    copyFileSync(path.join(webRoot, asset), path.join(dist, asset));
}
copyFileSync(path.join(webRoot, 'src', 'styles.css'), path.join(dist, 'styles.css'));

console.log(`[build] 完成。Web 产物：${path.relative(root, dist)}`);
