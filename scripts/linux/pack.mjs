#!/usr/bin/env node
/**
 * Linux 发布包（本地产物，不上传）。
 *
 * 产出 `<out>/StardewAgentBridge-<版本>-linux-x64/`：
 *   bin/stardew-agent-bridge        启动入口（0755，exec 包内 Node）
 *   runtime/node                    包内 Node（Linux x64，附 LICENSE）
 *   server/bridge.mjs               单文件 Bridge（含依赖）
 *   server/stdio-adapter.mjs        单文件 stdio 适配器
 *   web/                            控制台静态产物
 *   mod/                            Mod（full 包；bridge-only-ci 不含）
 *   scripts/                        安装/回退/桌面入口（自包含 MJS）
 *   assets/                         项目图标
 *   docs/、LICENSE、NOTICE.md、CHANGELOG.md、README*
 *   manifest.release.json、CHECKSUMS.txt
 *
 * 安全边界：包内不出现游戏程序集、存档、凭据、账本、源码映射或 node_modules；
 * 不自动上传、不打标签、不生成 Release。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { checkNodeVersion, inspectElfHeader } from '@sab/platform';
import { collectLicenses } from '../collect-licenses.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TARGET_ID = 'linux-x64';

function parseFlags(argv) {
    const flags = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) continue;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[index + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                index += 1;
            } else {
                flags[key] = true;
            }
        } else {
            flags._.push(token);
        }
    }
    return flags;
}

const HELP = `用法：pack.mjs --runtime-root <含 bin/node 的目录> [选项]

选项：
  --target <id>            目标平台（当前只支持 linux-x64）
  --runtime-root <目录>    包内 Node 运行时根目录（必须含 bin/node 与 LICENSE*）
  --out <目录>             输出目录（默认 release/StardewAgentBridge-<版本>-linux-x64）
  --skip-mod               bridge-only 包（CI 用；不含 mod/，manifest 标 packageKind=bridge-only-ci）
  --node-version <版本>    无法执行目标平台 node 时显式声明版本（CI 交叉打包用）
  --allow-unverified-runtime  允许在无法执行/无法确认版本时继续（仅 CI 交叉打包，本机验收不使用）
  --verify                 打包后立刻运行 scripts/verify-package.mjs
  --json                   输出机器可读 JSON
`;

function readVersion() {
    const parsed = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const version = String(parsed.version ?? '');
    if (!/^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`无效的发布版本号：${version}`);
    return version;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: REPO, stdio: 'inherit', shell: false, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`命令失败（退出码 ${result.status}）：${command} ${args.join(' ')}`);
}

function esbuild(entry, outfile) {
    const banner = "import { createRequire as __sabCreateRequire } from 'node:module'; const require = __sabCreateRequire(import.meta.url);";
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile,
        banner: { js: banner }, minifyWhitespace: true, legalComments: 'none', logLevel: 'warning' });
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...walk(full, rel));
        } else {
            out.push({ rel, full });
        }
    }
    return out;
}

/** 校验包内 Node：必须存在、可执行、是 Linux x64 ELF，并带许可证。 */
export function inspectRuntime(runtimeRoot, { allowUnverified = false, declaredVersion = null } = {}) {
    const problems = [];
    const notes = [];
    const candidates = [path.join(runtimeRoot, 'bin', 'node'), path.join(runtimeRoot, 'node')];
    const nodePath = candidates.find((candidate) => existsSync(candidate)) ?? null;
    if (!nodePath) {
        return { ok: false, problems: [`运行时根目录里没有 bin/node 或 node：${runtimeRoot}`], notes, nodePath: null, version: null, licensePath: null };
    }
    try {
        const mode = statSync(nodePath).mode;
        if ((mode & 0o111) === 0) problems.push(`包内 node 没有执行权限：${nodePath}（mode ${(mode & 0o777).toString(8)}）`);
    } catch (error) {
        problems.push(`无法读取 ${nodePath}：${error.message}`);
    }
    const elf = inspectElfHeader(nodePath);
    if (!elf) {
        problems.push(`包内 node 不是 ELF 可执行文件：${nodePath}`);
    } else if (!elf.compatibleWithLinuxX64) {
        problems.push(`包内 node 架构不匹配：class=${elf.class} machine=${elf.machineName}（需要 Linux x86-64）`);
    }
    const licenseCandidates = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-NODE.txt'];
    const licensePath = licenseCandidates.map((name) => path.join(runtimeRoot, name)).find((candidate) => existsSync(candidate)) ?? null;
    if (!licensePath) problems.push(`包内 Node 缺少许可证文件（${licenseCandidates.join(' / ')}）：${runtimeRoot}`);

    let version = declaredVersion;
    const probe = spawnSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 10_000, shell: false });
    if (probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim().length > 0) {
        version = probe.stdout.trim();
    } else {
        notes.push(
            `无法直接执行目标平台 node 读取版本（${probe.error?.message ?? `退出码 ${probe.status}`}）；` +
                (declaredVersion ? `使用 --node-version 声明值 ${declaredVersion}。` : '请用 --node-version 声明或在本机 Linux 上打包。')
        );
        if (!version) problems.push('无法确认包内 Node 版本：请用 --node-version 声明，或在本机 Linux 打包。');
    }
    if (version && !checkNodeVersion(version).ok) problems.push(`包内 Node 版本过低或无效：${version}（需要 22.13 或更高）`);
    if (problems.length > 0 && allowUnverified) {
        notes.push('已按 --allow-unverified-runtime 继续；该包只能用于 CI 的 bridge-only 验证，不能作为正式发布包。');
        return { ok: true, problems: [], notes, nodePath, version, licensePath };
    }
    return { ok: problems.length === 0, problems, notes, nodePath, version, licensePath };
}

const BIN_SCRIPT = `#!/bin/sh
# Stardew Agent Bridge 启动入口。
# 强制使用包内 Node：不依赖 PATH 中的系统 node/npm。
set -eu
case "$0" in
  */*) sab_bin_dir=\${0%/*} ;;
  *) sab_bin_dir=. ;;
esac
root=$(CDPATH= cd -- "$sab_bin_dir/.." && pwd -P)
node="$root/runtime/node"
if [ ! -x "$node" ]; then
  echo "找不到包内运行时：$node" >&2
  exit 1
fi
exec "$node" "$root/server/bridge.mjs" "$@"
`;

export function main(argv) {
    const flags = parseFlags(argv);
    if (flags.help === true) {
        process.stdout.write(HELP);
        return 0;
    }
    const json = flags.json === true;
    const report = { command: 'pack', platform: 'linux', target: TARGET_ID, ok: false, problems: [], notes: [] };
    const done = (code) => {
        if (json) process.stdout.write(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
        return code;
    };
    const fail = (message) => {
        report.problems.push(message);
        if (!json) process.stderr.write(`[pack] ${message}\n`);
        return done(1);
    };

    const target = typeof flags.target === 'string' ? flags.target : TARGET_ID;
    if (target !== TARGET_ID) {
        return fail(`本版只支持 --target ${TARGET_ID}（收到 ${target}）；macOS/ARM 另列后续工作。`);
    }
    const runtimeRoot = typeof flags['runtime-root'] === 'string' ? path.resolve(flags['runtime-root']) : null;
    if (!runtimeRoot) {
        return fail(
            '必须提供 --runtime-root（含 bin/node 与 LICENSE* 的 Linux x64 Node 目录）。' +
                '发布包不能依赖系统 node，也不能在安装时下载 npm 依赖。'
        );
    }
    if (!existsSync(runtimeRoot)) return fail(`运行时根目录不存在：${runtimeRoot}`);

    let version;
    try {
        version = readVersion();
    } catch (error) {
        return fail(error.message);
    }
    report.version = version;

    const runtime = inspectRuntime(runtimeRoot, {
        allowUnverified: flags['allow-unverified-runtime'] === true,
        declaredVersion: typeof flags['node-version'] === 'string' ? flags['node-version'] : null
    });
    if (!runtime.ok) return fail(runtime.problems.join(' '));
    report.notes.push(...runtime.notes);
    report.nodeVersion = runtime.version;

    const packageKind = flags['skip-mod'] === true ? 'bridge-only-ci' : 'full';
    report.packageKind = packageKind;
    if (flags['allow-unverified-runtime'] === true && packageKind !== 'bridge-only-ci') {
        return fail('--allow-unverified-runtime 只允许用于 bridge-only-ci，禁止用于完整包。');
    }

    const outDir = path.resolve(
        typeof flags.out === 'string' ? flags.out : path.join(REPO, 'release', `StardewAgentBridge-${version}-${TARGET_ID}`)
    );
    if (!existsSync(path.join(REPO, 'apps', 'web', 'dist', 'index.html'))) {
        return fail('Web 产物缺失：请先运行 npm run build。');
    }
    if (packageKind === 'full') {
        const modDir = path.join(REPO, 'artifacts', 'mod', 'StardewAgentBridge');
        if (!existsSync(path.join(modDir, 'StardewAgentBridge.dll'))) {
            return fail('Mod 产物缺失：请先运行 npm run build:mod（或使用 --skip-mod 生成 bridge-only 包）。');
        }
    }

    // 只清理本项目已识别的输出，拒绝覆盖用户目录或跟随符号链接。
    const relativeToOutput = path.relative(outDir, REPO);
    if (outDir === REPO || relativeToOutput === '' || (!relativeToOutput.startsWith(`..${path.sep}`) && relativeToOutput !== '..' && !path.isAbsolute(relativeToOutput))) {
        return fail('输出目录不能是源码目录或其祖先。');
    }
    if (existsSync(outDir)) {
        if (lstatSync(outDir).isSymbolicLink() || !lstatSync(outDir).isDirectory()) return fail('输出目录必须是普通目录。');
        if (readdirSync(outDir).length > 0) {
            let previous;
            try { previous = JSON.parse(readFileSync(path.join(outDir, 'manifest.release.json'), 'utf8')); } catch {}
            if (previous?.name !== 'Stardew Agent Bridge' || previous?.target !== TARGET_ID) return fail('拒绝清理没有本项目发布清单的非空目录。');
        }
        const resolvedOutput = path.resolve(outDir);
        if (resolvedOutput === path.parse(resolvedOutput).root || resolvedOutput === os.homedir()) return fail('拒绝清理文件系统根或用户主目录。');
        rmSync(resolvedOutput, { recursive: true, force: true });
    }
    for (const dir of ['bin', 'runtime', 'server', 'web', 'mod', 'scripts', 'assets', 'docs']) {
        mkdirSync(path.join(outDir, dir), { recursive: true });
    }
    report.outDir = outDir;

    // 1) 包内运行时
    copyFileSync(runtime.nodePath, path.join(outDir, 'runtime', 'node'));
    chmodSync(path.join(outDir, 'runtime', 'node'), 0o755);
    if (runtime.licensePath) copyFileSync(runtime.licensePath, path.join(outDir, 'runtime', 'LICENSE.txt'));

    // 2) server 与 stdio 适配器（单文件）
    esbuild(path.join(REPO, 'apps', 'server', 'src', 'cli.ts'), path.join(outDir, 'server', 'bridge.mjs'));
    esbuild(path.join(REPO, 'adapters', 'stdio', 'src', 'index.ts'), path.join(outDir, 'server', 'stdio-adapter.mjs'));
    collectLicenses(outDir, REPO);

    // 3) Web
    for (const file of walk(path.join(REPO, 'apps', 'web', 'dist'))) {
        if (file.rel.endsWith('.map')) continue;
        mkdirSync(path.dirname(path.join(outDir, 'web', file.rel)), { recursive: true });
        copyFileSync(file.full, path.join(outDir, 'web', file.rel));
    }

    // 4) Mod（full）
    if (packageKind === 'full') {
        const modDir = path.join(REPO, 'artifacts', 'mod', 'StardewAgentBridge');
        for (const name of readdirSync(modDir)) {
            const source = path.join(modDir, name);
            if (!statSync(source).isFile()) continue;
            copyFileSync(source, path.join(outDir, 'mod', name));
        }
    }

    // 5) 自包含脚本（esbuild 打包 @sab/platform 与 lib，不残留源码树引用）
    esbuild(path.join(REPO, 'scripts', 'install-mod.mjs'), path.join(outDir, 'scripts', 'install-mod.mjs'));
    esbuild(path.join(REPO, 'scripts', 'rollback-mod.mjs'), path.join(outDir, 'scripts', 'rollback-mod.mjs'));
    esbuild(path.join(REPO, 'scripts', 'linux', 'desktop-entry.mjs'), path.join(outDir, 'scripts', 'desktop-entry.mjs'));
    for (const name of ['install-mod.mjs', 'rollback-mod.mjs', 'desktop-entry.mjs']) {
        chmodSync(path.join(outDir, 'scripts', name), 0o755);
    }

    // 6) 启动入口
    writeFileSync(path.join(outDir, 'bin', 'stardew-agent-bridge'), BIN_SCRIPT, { mode: 0o755 });
    chmodSync(path.join(outDir, 'bin', 'stardew-agent-bridge'), 0o755);

    // 7) 图标与文档
    const icon = path.join(REPO, 'assets', 'stardew-agent-bridge.svg');
    if (existsSync(icon)) {
        copyFileSync(icon, path.join(outDir, 'assets', 'stardew-agent-bridge.svg'));
    } else {
        report.notes.push('缺少 assets/stardew-agent-bridge.svg：桌面入口安装会报 ICON_MISSING。');
    }
    for (const name of ['README.md', 'README.en.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md']) {
        const source = path.join(REPO, name);
        if (existsSync(source)) copyFileSync(source, path.join(outDir, name));
    }
    for (const name of ['LINUX_INSTALL.md', 'LINUX_DEVELOPMENT.md', 'LINUX_ACCEPTANCE.md', 'PLATFORM_MATRIX.md', 'PROTOCOL.md', 'CLIENTS.md', 'AGENT_GUIDE.md', 'ACCEPTANCE.md', 'TROUBLESHOOTING.md', 'MULTIPLAYER_INSTALL.md', 'MULTIPLAYER_ACCEPTANCE.md', 'DOCKER_INSTALL.md', 'RELEASE_VALIDATION_20261029.md']) {
        const source = path.join(REPO, 'docs', name);
        if (existsSync(source)) copyFileSync(source, path.join(outDir, 'docs', name));
    }

    // 8) 发布清单
    const files = walk(outDir)
        .filter((file) => !['manifest.release.json', 'CHECKSUMS.txt'].includes(file.rel))
        .sort((left, right) => (left.rel < right.rel ? -1 : 1))
        .map((file) => ({
            path: file.rel,
            bytes: statSync(file.full).size,
            mode: (statSync(file.full).mode & 0o777).toString(8).padStart(4, '0'),
            sha256: sha256(file.full)
        }));
    const manifest = {
        schemaVersion: 1,
        name: 'Stardew Agent Bridge',
        version,
        target,
        packageKind,
        runtime: { node: runtime.version, bundled: true, verifiedExecutable: !runtime.notes.some(note => note.includes('无法直接执行')) && flags['allow-unverified-runtime'] !== true },
        createdAt: new Date().toISOString(),
        entry: 'bin/stardew-agent-bridge',
        server: 'server/bridge.mjs',
        stdioAdapter: 'server/stdio-adapter.mjs',
        hasMod: packageKind === 'full',
        files
    };
    writeFileSync(path.join(outDir, 'manifest.release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const checksums = [
        ...files.map((file) => `${file.sha256}  ${file.path}`),
        `${sha256(path.join(outDir, 'manifest.release.json'))}  manifest.release.json`
    ].join('\n');
    writeFileSync(path.join(outDir, 'CHECKSUMS.txt'), `${checksums}\n`);

    // 9) 禁止文件审计
    const forbidden = walk(outDir).filter((file) => {
        const name = path.basename(file.rel);
        if (['Stardew Valley.dll', 'StardewModdingAPI.dll', 'credentials.json', 'ledger.sqlite', 'endpoint.json'].includes(name)) return true;
        if (/\.(save|zip|pdb|map)$/i.test(name)) return true;
        if (file.rel.includes('node_modules/')) return true;
        return false;
    });
    if (forbidden.length > 0) {
        return fail(`发布目录包含禁止分发的文件：${forbidden.map((file) => file.rel).join(', ')}`);
    }

    // 10) 脚本自包含检查
    for (const name of ['install-mod.mjs', 'rollback-mod.mjs', 'desktop-entry.mjs']) {
        const text = readFileSync(path.join(outDir, 'scripts', name), 'utf8');
        if (/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"](?:@sab\/|[^'"]*(?:\/packages\/|packages\/platform\/dist))/.test(text)) {
            return fail(`scripts/${name} 仍引用源码树路径，发布包必须自包含。`);
        }
    }

    report.ok = true;
    report.files = files.length;
    report.totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

    if (flags.verify === true) {
        const verify = spawnSync(
            process.execPath,
            [path.join(REPO, 'scripts', 'verify-package.mjs'), outDir, ...(packageKind === 'full' ? [] : ['--bridge-only'])],
            { cwd: REPO, stdio: 'inherit', shell: false }
        );
        if (verify.status !== 0) return fail('verify-package.mjs 未通过。');
        report.notes.push('已运行 verify-package.mjs。');
    }

    if (!json) {
        process.stdout.write(`[pack] 输出目录：${outDir}\n`);
        process.stdout.write(`[pack] 类型：${packageKind}，目标：${target}，包内 Node：${runtime.version}\n`);
        process.stdout.write(`[pack] 文件数：${files.length}，合计 ${(report.totalBytes / 1024 / 1024).toFixed(1)} MB\n`);
        for (const note of report.notes) process.stdout.write(`[pack] ${note}\n`);
        process.stdout.write('[pack] 压缩包由你手动生成（tar czf），脚本不上传、不打标签。\n');
    }
    return done(0);
}
