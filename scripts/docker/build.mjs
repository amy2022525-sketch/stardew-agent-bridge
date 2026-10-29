#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 打包产物布局契约（任务书 §6.3）。supervisor/healthcheck/lease-entrypoint 引用的入口必须与之一致。 */
export const BUNDLE_LAYOUT = {
    entries: [
        { name: 'bridge', source: 'apps/server/dist/cli.js', output: 'server/bridge.mjs' },
        { name: 'stdio-adapter', source: 'adapters/stdio/dist/index.js', output: 'server/stdio-adapter.mjs' },
        { name: 'container-gateway', source: 'apps/server/dist/container-gateway-entry.js', output: 'server/container-gateway.mjs' }
    ]
};

// 本机 Node 22.23.1 的 fs.cpSync(recursive) 会进程级静默死亡（退出码 127，C:/F: 目标均复现），
// 产物拷贝必须用 copyFileSync 手写递归；受控目录里只有常规文件与目录。
function copyTree(source, target) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name), to = path.join(target, entry.name);
        if (entry.isDirectory()) copyTree(from, to);
        else copyFileSync(from, to);
    }
}

/** 校验 bundle 产物：esbuild 入口、runtime 相对导入、固定资产全部真实存在。缺一项即失败，绝不带病出包。 */
export function verifyBundleLayout(output) {
    const missing = [];
    for (const entry of BUNDLE_LAYOUT.entries) {
        const file = path.join(output, entry.output);
        if (!existsSync(file) || statSync(file).size === 0) missing.push(entry.output);
    }
    const runtimeDir = path.join(output, 'container');
    const runtimeFiles = existsSync(runtimeDir) ? readdirSync(runtimeDir).filter(file => file.endsWith('.mjs')) : [];
    for (const file of runtimeFiles) {
        const text = readFileSync(path.join(runtimeDir, file), 'utf8');
        for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*[(\s])'(\.\/[^']+\.mjs)'/g)) {
            const target = match[1].replace(/^\.\//, '');
            if (!runtimeFiles.includes(target)) missing.push(`container/${file} → ${match[1]}`);
        }
    }
    for (const required of ['web/index.html', 'metadata/versions.json', 'metadata/build-info.json', 'metadata/bundled-dependencies.json', 'licenses/LICENSE', 'licenses/NOTICE.md']) {
        if (!existsSync(path.join(output, required))) missing.push(required);
    }
    if (missing.length) throw new Error(`BUNDLE_LAYOUT_INVALID: 产物缺失 ${missing.join(', ')}`);
    return { ok: true, checked: BUNDLE_LAYOUT.entries.length + runtimeFiles.length };
}

export async function bundleRuntime(output) {
    const { build } = await import('esbuild');
    const server = path.join(output, 'server');
    mkdirSync(server, { recursive: true });
    const licenses = new Map();
    for (const entry of BUNDLE_LAYOUT.entries) {
        const result = await build({ absWorkingDir: ROOT, entryPoints: [entry.source], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(output, entry.output),
            banner: { js: "import {createRequire as __sabRequire} from 'node:module';const require=__sabRequire(import.meta.url);" }, metafile: true, legalComments: 'eof', logLevel: 'warning' });
        for (const input of Object.keys(result.metafile.inputs).filter(input => input.includes('node_modules/'))) {
            let directory = path.dirname(path.resolve(ROOT, input));
            while (directory !== path.dirname(directory)) {
                if (existsSync(path.join(directory, 'package.json'))) {
                    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
                    if (pkg.name && pkg.version && !licenses.has(pkg.name)) {
                        const docs = readdirSync(directory).filter(file => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(file));
                        if (docs.length === 0) throw new Error(`Dependency license text missing: ${pkg.name}`);
                        const dest = path.join(output, 'licenses', pkg.name.replaceAll('/', '_'));
                        mkdirSync(dest, { recursive: true });
                        for (const doc of docs) copyFileSync(path.join(directory, doc), path.join(dest, doc));
                        licenses.set(pkg.name, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'unknown', files: docs });
                    }
                    if (pkg.name && pkg.version) break;
                }
                directory = path.dirname(directory);
            }
        }
    }
    const runtime = path.join(output, 'container'); mkdirSync(runtime, { recursive: true });
    for (const file of readdirSync(path.join(ROOT, 'scripts/docker/runtime')).filter(file => file.endsWith('.mjs'))) copyFileSync(path.join(ROOT, 'scripts/docker/runtime', file), path.join(runtime, file));
    copyTree(path.join(ROOT, 'apps/web/dist'), path.join(output, 'web'));
    mkdirSync(path.join(output, 'licenses'), { recursive: true });
    for (const file of ['LICENSE', 'NOTICE.md']) copyFileSync(path.join(ROOT, file), path.join(output, 'licenses', file));
    mkdirSync(path.join(output, 'metadata'), { recursive: true });
    copyFileSync(path.join(ROOT, 'docker/versions.json'), path.join(output, 'metadata/versions.json'));
    writeFileSync(path.join(output, 'metadata/bundled-dependencies.json'), JSON.stringify([...licenses.values()], null, 2));
    writeFileSync(path.join(output, 'metadata/build-info.json'), JSON.stringify({ specificationVersion: 1, applicationVersion: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, sourceCommit: process.env.SAB_SOURCE_COMMIT ?? 'unknown',
        workspaceDirty: process.env.SAB_WORKTREE_DIRTY ?? 'unknown', buildTimestamp: process.env.SAB_BUILD_TIMESTAMP ?? 'unknown', platform: 'linux/amd64', nodeVersion: process.version }, null, 2));
    verifyBundleLayout(output);
}
export function buildImage({ dockerPath = 'docker', target = 'bridge-runtime', project = 'stardew-agent-bridge', timestamp = new Date().toISOString() } = {}) {
    if (!['bridge-runtime', 'game-runtime', 'mod-build'].includes(target)) throw new Error('INVALID_IMAGE_TARGET');
    const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false });
    const dirty = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8', shell: false });
    const args = ['build', '--platform', 'linux/amd64', '--file', path.join(ROOT, 'docker', target === 'mod-build' ? 'Dockerfile.mod-build' : 'Dockerfile'),
        ...(target === 'mod-build' ? [] : ['--target', target]), '--tag', `local/${project}:${target}`, '--build-arg', `SAB_SOURCE_COMMIT=${head.status === 0 ? head.stdout.trim() : 'unknown'}`,
        '--build-arg', `SAB_WORKTREE_DIRTY=${dirty.status === 0 ? Boolean(dirty.stdout.trim()) : 'unknown'}`, '--build-arg', `SAB_BUILD_TIMESTAMP=${timestamp}`,
        '--build-arg', `SAB_UID=${process.env.SAB_UID ?? 1000}`, '--build-arg', `SAB_GID=${process.env.SAB_GID ?? 1000}`, ROOT];
    return spawnSync(dockerPath, args, { shell: false, stdio: 'inherit' }).status ?? 19;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    if (args.includes('--bundle')) await bundleRuntime(path.resolve(value('--output') ?? path.join(ROOT, 'artifacts/docker-bundle')));
    else if (args.includes('--help')) process.stdout.write('build.mjs --target bridge-runtime|game-runtime|mod-build; --bundle --output <directory>\n');
    else process.exitCode = buildImage({ target: args.includes('--target') ? value('--target') : 'bridge-runtime' });
}
