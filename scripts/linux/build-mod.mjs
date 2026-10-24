#!/usr/bin/env node
/**
 * Linux 构建 Mod（只编译，不安装、不复制游戏程序集）。
 *
 * 与 Windows `build-mod.ps1` 等价：
 * 1. 解析游戏目录（--game-path / STARDEW_GAME_PATH / Steam 库发现）；
 * 2. 校验游戏程序集与 SMAPI；检查 .NET SDK；
 * 3. `dotnet restore` + `dotnet build`，`-p:GamePath=<目录>`；
 * 4. 只把 DLL 与 manifest.json 复制到 artifacts/mod/StardewAgentBridge；
 * 5. 审计产物（禁止游戏 DLL、PDB、存档）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GAME_DLL, inspectGameRoot, resolveGameRoot } from '../lib/game-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CSPROJ = path.join(REPO, 'mods', 'StardewAgentBridge', 'StardewAgentBridge.csproj');
const ARTIFACT = path.join(REPO, 'artifacts', 'mod', 'StardewAgentBridge');

function parseFlags(argv) {
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token || !token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            index += 1;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: false,
        encoding: 'utf8',
        env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
        ...options
    });
    return result;
}

function sdkVersions() {
    const result = run('dotnet', ['--list-sdks'], { capture: true });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => /^(\d+\.\d+\.\d+)/.exec(line.trim())?.[1])
        .filter(Boolean);
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function main(argv) {
    const flags = parseFlags(argv);
    const json = flags.json === true;
    const report = { command: 'build-mod', platform: 'linux', ok: false, problems: [], notes: [] };
    const done = (code) => {
        if (json) process.stdout.write(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
        return code;
    };
    const fail = (code, message) => {
        report.problems.push(message);
        if (!json) process.stderr.write(`[build-mod] ${message}\n`);
        return done(code);
    };

    if (!existsSync(CSPROJ)) return fail(1, `找不到 Mod 工程：${CSPROJ}`);

    const game = resolveGameRoot({
        explicit: typeof flags['game-path'] === 'string' ? flags['game-path'] : undefined,
        env: process.env,
        homeDir: os.homedir(),
        platform: 'linux'
    });
    if (!game.ok) return fail(1, game.problems.join(' '));
    report.gameRoot = game.gameRoot;

    const inspected = inspectGameRoot(game.gameRoot);
    if (inspected.problems.length > 0) return fail(1, inspected.problems.join(' '));
    if (!existsSync(path.join(game.gameRoot, GAME_DLL))) return fail(1, `缺少 ${GAME_DLL}`);

    const versions = sdkVersions();
    if (versions === null) {
        return fail(
            1,
            '找不到 dotnet。请安装 .NET SDK（本仓库开发与隔离测试使用 10.x；游戏 Mod 目标框架仍为 net6.0）。'
        );
    }
    report.dotnetSdks = versions;
    const majors = versions.map((value) => Number(value.split('.')[0]));
    if (!majors.some((major) => major >= 8)) {
        return fail(1, `已安装的 .NET SDK 版本过低：${versions.join(', ')}（至少需要 8.x，建议 10.x）。`);
    }
    if (!majors.some((major) => major >= 10)) {
        report.notes.push('未检测到 .NET SDK 10.x：Mod 可以编译，但 tests/mod 的隔离检查需要 10.x。');
    }

    const configuration = typeof flags.configuration === 'string' ? flags.configuration : 'Release';
    if (!['Release', 'Debug'].includes(configuration)) return fail(1, `未知配置：${configuration}`);

    const restoreArgs = ['restore', CSPROJ, '-s', 'https://api.nuget.org/v3/index.json'];
    const buildArgs = [
        'build',
        CSPROJ,
        '-c',
        configuration,
        `-p:GamePath=${game.gameRoot}`,
        '-p:UseSharedCompilation=false',
        '--no-restore'
    ];
    report.commands = [`dotnet ${restoreArgs.join(' ')}`, `dotnet ${buildArgs.join(' ')}`];

    if (flags['skip-restore'] !== true) {
        const restore = run('dotnet', restoreArgs);
        if (restore.status !== 0) return fail(1, 'dotnet restore 失败，详见上面的输出。');
    }
    const build = run('dotnet', buildArgs);
    if (build.status !== 0) return fail(1, 'dotnet build 失败，详见上面的输出。');

    const outDir = path.join(REPO, 'mods', 'StardewAgentBridge', 'bin', configuration, 'net6.0');
    const dll = path.join(outDir, 'StardewAgentBridge.dll');
    const manifest = path.join(REPO, 'mods', 'StardewAgentBridge', 'manifest.json');
    if (!existsSync(dll)) return fail(1, `构建完成但没有找到 ${dll}`);

    if (existsSync(ARTIFACT)) rmSync(ARTIFACT, { recursive: true, force: true });
    mkdirSync(ARTIFACT, { recursive: true });
    copyFileSync(dll, path.join(ARTIFACT, 'StardewAgentBridge.dll'));
    copyFileSync(manifest, path.join(ARTIFACT, 'manifest.json'));

    const forbidden = readdirSync(ARTIFACT).filter((name) =>
        ['Stardew Valley.dll', 'StardewModdingAPI.dll'].includes(name) || /\.(pdb|save)$/i.test(name)
    );
    if (forbidden.length > 0) return fail(1, `产物包含禁止分发的文件：${forbidden.join(', ')}`);

    report.ok = true;
    report.artifact = ARTIFACT;
    report.files = readdirSync(ARTIFACT)
        .filter((name) => statSync(path.join(ARTIFACT, name)).isFile())
        .map((name) => ({ name, bytes: statSync(path.join(ARTIFACT, name)).size, sha256: sha256(path.join(ARTIFACT, name)) }));

    if (!json) {
        process.stdout.write(`[build-mod] 游戏目录：${game.gameRoot}（来源 ${game.source}）\n`);
        process.stdout.write(`[build-mod] .NET SDK：${versions.join(', ')}\n`);
        process.stdout.write(`[build-mod] 产物：${ARTIFACT}\n`);
        for (const file of report.files) process.stdout.write(`  ${file.name}  ${file.bytes} 字节  ${file.sha256}\n`);
        for (const note of report.notes) process.stdout.write(`[build-mod] ${note}\n`);
        if (inspected.smapiVersion) process.stdout.write(`[build-mod] SMAPI 版本（探测）：${inspected.smapiVersion}\n`);
    }
    return done(0);
}
