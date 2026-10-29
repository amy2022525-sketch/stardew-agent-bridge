#!/usr/bin/env node
/**
 * Mod 构建工具（工具镜像内运行，DKR-009）。
 *
 * 边界：
 * - 只读游戏输入 `/input/game`（提供引用程序集路径）；
 * - 只写 Mod 产物卷 `/input/mod`（实际落盘 `.../staging/<txn>` 再原子切换 `current`）；
 * - 不加载 DLL、不启动游戏、不写宿主的游戏目录或存档；
 * - 产物白名单：StardewAgentBridge.dll + manifest.json 及必要的附带文档；
 *   绝不夹带游戏程序集、SMAPI、Harmony/MonoGame、pdb、obj、NuGet 缓存。
 *
 * 输出契约（§7.4）：`<root>/current/{StardewAgentBridge.dll,manifest.json,artifact.json}`
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, emitResult } from './config.mjs';
import { atomicWriteJson, hashTree, isoNow, newNonce, ownedPath, readJsonIfExists, sha256OfFile } from './lib.mjs';
import { claimVolume } from './volume-owner.mjs';
import { inspectGameSource } from './preflight.mjs';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const REQUIRED_MOD_UNIQUE_ID = 'StardewAgentBridge.Bridge';
export const ALLOWED_ARTIFACT_FILES = ['StardewAgentBridge.dll', 'manifest.json'];
export const FORBIDDEN_ARTIFACT_NAMES = [
    'Stardew Valley.dll',
    'StardewValley.dll',
    'StardewModdingAPI.dll',
    '0Harmony.dll',
    'MonoGame.Framework.dll',
    'StardewAgentBridge.pdb',
    'StardewAgentBridge.deps.json',
    'StardewAgentBridge.runtimeconfig.json'
];

export function newTransactionId(now = new Date()) {
    return `${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${newNonce(4)}`;
}

/**
 * 校验产物目录：白名单、必需文件、manifest 内容。返回 { ok, problems, manifest }。
 */
export function validateArtifactDir(dir, { exists = existsSync, readdir = readdirSync } = {}) {
    const problems = [];
    if (!exists(dir)) return { ok: false, problems: [`产物目录不存在：${dir}`], manifest: null };
    const entries = readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            problems.push(`产物目录不应含子目录：${entry.name}`);
            continue;
        }
        if (FORBIDDEN_ARTIFACT_NAMES.includes(entry.name)) {
            problems.push(`产物夹带了禁止的文件：${entry.name}`);
            continue;
        }
        if (!ALLOWED_ARTIFACT_FILES.includes(entry.name)) {
            problems.push(`产物含白名单之外的文件：${entry.name}`);
        }
    }
    for (const name of ['StardewAgentBridge.dll', 'manifest.json']) {
        if (!exists(path.join(dir, name))) problems.push(`产物缺少必需文件：${name}`);
    }
    const manifest = readJsonIfExists(path.join(dir, 'manifest.json'));
    if (exists(path.join(dir, 'manifest.json'))) {
        if (!manifest) problems.push('manifest.json 无法解析');
        else {
            if (manifest.UniqueID !== REQUIRED_MOD_UNIQUE_ID) problems.push(`manifest UniqueID 必须是 ${REQUIRED_MOD_UNIQUE_ID}`);
            if (manifest.EntryDll !== 'StardewAgentBridge.dll') problems.push('manifest EntryDll 必须是 StardewAgentBridge.dll');
            if (typeof manifest.MinimumApiVersion !== 'string') problems.push('manifest 缺少 MinimumApiVersion');
        }
    }
    return { ok: problems.length === 0, problems, manifest };
}

/** 生成 artifact.json（只记录本模块产物的哈希与来源信息）。 */
export function buildArtifactRecord({ dir, manifest, gameAssembly, dotnetVersion, builtAt = isoNow() }) {
    const artifacts = {};
    for (const name of ['StardewAgentBridge.dll', 'manifest.json']) {
        const file = path.join(dir, name);
        if (existsSync(file)) artifacts[name] = { size: statSync(file).size, sha256: sha256OfFile(file) };
    }
    return {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        modVersion: typeof manifest?.Version === 'string' ? manifest.Version : null,
        modUniqueId: manifest?.UniqueID ?? null,
        entryDll: manifest?.EntryDll ?? null,
        minimumApiVersion: manifest?.MinimumApiVersion ?? null,
        targetFramework: 'net6.0',
        platform: 'linux-x64',
        sourceCommit: process.env.SAB_SOURCE_COMMIT ?? null,
        gameAssemblySha256: gameAssembly && existsSync(gameAssembly) ? sha256OfFile(gameAssembly) : null,
        dotnetVersion: dotnetVersion ?? null,
        builtAt,
        artifacts
    };
}

/**
 * 主流程：staging → 校验 → 原子切换到 current。
 * `build` 回调负责真正调用 dotnet（由调用方注入，便于测试）。
 */
export async function runModBuild(options = {}) {
    const modRoot = options.modRoot ?? LAYOUT.inputMod;
    const projectDir = options.projectDir ?? '/opt/sab/modsrc';
    const gameRoot = options.gameRoot ?? LAYOUT.inputGame;
    const current = path.join(modRoot, 'current');
    const staging = path.join(modRoot, 'staging', newTransactionId());
    const notes = [];
    if (!(options.leaseHeld ?? process.env.SAB_LEASE_HELD === '1')) return { ok: false, code: 'OWNERSHIP_CONFLICT', exitCode: 13, notes: ['Mod 构建需要产物卷全程租约。'] };
    try { (options.claimVolume ?? claimVolume)(modRoot); }
    catch { return { ok: false, code: 'OWNERSHIP_CONFLICT', exitCode: 13, notes: ['产物卷归属不匹配。'] }; }
    const input = (options.inspectGame ?? inspectGameSource)(gameRoot);
    if (!input.ok) return { ok: false, code: 'INPUT_MISSING', exitCode: 11, notes: input.problems.map(p => p.message) };

    if (!existsSync(gameRoot)) {
        return { ok: false, code: 'INPUT_MISSING', exitCode: EXIT.INPUT_MISSING, notes: [`只读游戏输入未挂载：${gameRoot}`] };
    }
    if (!existsSync(projectDir)) {
        return { ok: false, code: 'INPUT_MISSING', exitCode: EXIT.INPUT_MISSING, notes: [`Mod 源码目录不存在：${projectDir}`] };
    }
    try {
        mkdirSync(staging, { recursive: true, mode: 0o755 });
    } catch (error) {
        return { ok: false, code: 'PERMISSION_DENIED', exitCode: EXIT.PERMISSION_DENIED, notes: [`无法创建产物 staging（检查 mod-artifacts 卷权限）：${error.message}`] };
    }

    const build = options.build ?? defaultDotnetBuild;
    let built;
    try {
        built = await build({ projectDir, gameRoot, outDir: staging });
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        return {
            ok: false,
            code: 'CONFIG_INVALID',
            exitCode: EXIT.CONFIG_INVALID,
            notes: [`Mod 构建失败：${error instanceof Error ? error.message : String(error)}`]
        };
    }
    notes.push(...(built?.notes ?? []));

    const validated = validateArtifactDir(staging);
    if (!validated.ok) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, code: 'CONFIG_INVALID', exitCode: EXIT.CONFIG_INVALID, notes: validated.problems };
    }
    const record = buildArtifactRecord({
        dir: staging,
        manifest: validated.manifest,
        gameAssembly: built?.gameAssembly ?? path.join(gameRoot, 'Stardew Valley.dll'),
        dotnetVersion: built?.dotnetVersion ?? null
    });
    atomicWriteJson(path.join(staging, 'artifact.json'), record, { mode: 0o644 });

    // 原子切换：先退休旧 current，再 rename staging → current。
    if (existsSync(current)) {
        const retired = path.join(modRoot, 'staging', `${path.basename(staging)}-retired`);
        renameSync(ownedPath(modRoot, current), ownedPath(modRoot, retired));
        try { renameSync(ownedPath(modRoot, staging), ownedPath(modRoot, current)); }
        catch (error) { renameSync(ownedPath(modRoot, retired), ownedPath(modRoot, current)); throw error; }
    } else {
        renameSync(staging, current);
    }
    return {
        ok: true,
        code: 'OK',
        exitCode: 0,
        notes: [...notes, `产物已发布：${current}（modVersion=${record.modVersion ?? 'unknown'}）`],
        current,
        artifact: record,
        files: hashTree(current)
    };
}

/** 真实 dotnet 构建（仅在工具镜像内执行；本仓库不运行）。 */
export async function defaultDotnetBuild({ projectDir, gameRoot, outDir, spawnImpl = nodeSpawn }) {
    const csproj = path.join(projectDir, 'StardewAgentBridge.csproj');
    if (!existsSync(csproj)) throw new Error(`找不到 csproj：${csproj}`);
    const args = [
        'build',
        csproj,
        '-c',
        'Release',
        '--nologo',
        `-p:GamePath=${gameRoot}`,
        `-p:OutputPath=${outDir}${path.sep}`,
        '-p:BaseIntermediateOutputPath=/tmp/sab-mod-obj/',
        '-p:EnableModDeploy=false',
        '-p:EnableModZip=false'
    ];
    const code = await new Promise((resolve, reject) => {
        const child = spawnImpl('dotnet', args, { shell: false, stdio: 'inherit', cwd: projectDir });
        child.on('error', reject);
        child.on('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`dotnet build 退出码 ${code}`);
    // 只保留白名单文件，其余（pdb/obj 缓存/依赖清单）一律删除。
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (entry.isDirectory() || !ALLOWED_ARTIFACT_FILES.includes(entry.name)) {
            rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
        }
    }
    return { notes: ['dotnet build 完成（产物已按白名单裁剪）'], gameAssembly: path.join(gameRoot, 'Stardew Valley.dll') };
}

export async function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const result = await runModBuild();
    return emitResult(
        {
            ok: result.ok,
            code: result.code,
            message: result.notes.join('；'),
            details: { current: result.current ?? null, modVersion: result.artifact?.modVersion ?? null },
            exitCode: result.exitCode
        },
        { json }
    );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
    main().then((code) => {
        process.exitCode = code;
    });
}
