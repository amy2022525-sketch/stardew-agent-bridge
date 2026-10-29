#!/usr/bin/env node
/**
 * 启动预检（只读）。
 *
 * 必须在启动游戏、Bridge 业务核心和网关之前完成，并且**不打开 SQLite 账本**、
 * 不创建凭据、不写持久状态。任何不合格项都以具体类别失败，而不是笼统报错。
 */
import { existsSync, statSync, readdirSync, lstatSync, readFileSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, emitResult, parseContainerConfig } from './config.mjs';
import { freeBytes, humanBytes, inspectElf, isExecutable, isInside, isSymlink, realpathInside, readJsonIfExists, sha256OfFile, sha256OfText, sniffKind } from './lib.mjs';
import { restorePending } from './backup.mjs';

/** 常见 Linux 入口名（只是候选；必须由真实文件内容与目录结构确认）。 */
export const GAME_EXECUTABLE_CANDIDATES = ['StardewValley', 'Stardew Valley', 'StardewValleyLauncher', 'Stardew Valley.exe'];
export const GAME_ASSEMBLY_CANDIDATES = ['StardewValley.dll', 'Stardew Valley.dll'];
export const SMAPI_ASSEMBLY_CANDIDATES = ['StardewModdingAPI.dll'];
export const REQUIRED_MOD_UNIQUE_ID = 'StardewAgentBridge.Bridge';
export const REQUIRED_MOD_DLL = 'StardewAgentBridge.dll';

function problem(code, message, details = {}) {
    return { code, message, ...details };
}

/**
 * 检查只读游戏输入目录。
 * 返回 { ok, problems, info }，problems 里带分类，便于操作者定位缺失类别。
 */
export function inspectGameSource(root, { exists = existsSync } = {}) {
    const problems = [];
    const info = { root, gameAssembly: null, launcher: null, smapi: null, contentDir: null, version: null };
    if (!root) return { ok: false, problems: [problem('INPUT_MISSING', '未提供游戏输入目录。')], info };
    if (!exists(root)) return { ok: false, problems: [problem('INPUT_MISSING', `游戏输入目录不存在：${root}`)], info };

    const entries = (() => {
        try {
            return statSync(root).isDirectory();
        } catch {
            return false;
        }
    })();
    if (!entries) return { ok: false, problems: [problem('INPUT_MISSING', `游戏输入路径不是目录：${root}`)], info };

    // 1) 游戏程序集（.NET 程序集，跨平台 DLL）
    for (const name of GAME_ASSEMBLY_CANDIDATES) {
        const candidate = path.join(root, name);
        if (exists(candidate)) {
            info.gameAssembly = candidate;
            break;
        }
    }
    if (!info.gameAssembly) {
        problems.push(
            problem('INPUT_MISSING', `游戏输入缺少程序集（${GAME_ASSEMBLY_CANDIDATES.join(' / ')}）。这不是有效的 Linux 游戏目录。`)
        );
    }

    // 2) Content 目录
    const contentDir = path.join(root, 'Content');
    if (exists(contentDir) && statSync(contentDir).isDirectory()) info.contentDir = contentDir;
    else problems.push(problem('INPUT_MISSING', '游戏输入缺少 Content 目录（说明内容资源未随目录一起提供）。'));

    // 3) Linux 启动器：必须是 Linux 可执行文件，不能是 Windows PE
    for (const name of GAME_EXECUTABLE_CANDIDATES) {
        const candidate = path.join(root, name);
        if (!exists(candidate)) continue;
        const kind = sniffKind(candidate);
        if (kind === 'pe' || name.toLowerCase().endsWith('.exe')) {
            problems.push(
                problem(
                    'CONFIG_INVALID',
                    `游戏输入中的启动器是 Windows PE 文件（${name}）。请提供 **Linux 原生** 游戏与 SMAPI；` +
                        '当前 Windows Steam 目录不能直接替代，本版也不支持 Wine/Proton。'
                )
            );
            continue;
        }
        const elf = inspectElf(candidate);
        if (kind === 'elf' && elf && !elf.compatibleWithLinuxX64) {
            problems.push(problem('CONFIG_INVALID', `启动器架构不匹配：${name} 是 ${elf.machineName}，镜像目标为 linux/amd64。`));
            continue;
        }
        if (!isExecutable(candidate)) {
            problems.push(
                problem('PERMISSION_DENIED', `启动器没有执行位：${candidate}。请保留原始权限（不要用会丢权限的方式复制）。`)
            );
            continue;
        }
        info.launcher = candidate;
        break;
    }
    if (!info.launcher) {
        problems.push(
            problem('INPUT_MISSING', `未找到可执行的 Linux 启动器（候选：${GAME_EXECUTABLE_CANDIDATES.join(' / ')}）。`)
        );
    }

    // 4) SMAPI：程序集 + smapi-internal 目录
    for (const name of SMAPI_ASSEMBLY_CANDIDATES) {
        const candidate = path.join(root, name);
        if (exists(candidate)) info.smapi = candidate;
    }
    const smapiInternal = path.join(root, 'smapi-internal');
    const hasSmapiInternal = exists(smapiInternal) && statSync(smapiInternal).isDirectory();
    if (!info.smapi || !hasSmapiInternal) {
        problems.push(
            problem(
                'INPUT_MISSING',
                `游戏输入缺少已安装的 SMAPI（需要 StardewModdingAPI.dll 与 smapi-internal/）。` +
                    '请先在 Linux 上安装兼容 SMAPI，再把整个游戏目录作为只读输入。'
            )
        );
    }

    // 5) 入口符号链接：只允许指向输入根内部
    for (const candidate of [info.launcher, info.gameAssembly, info.smapi].filter(Boolean)) {
        if (isSymlink(candidate) && !realpathInside(root, candidate)) {
            problems.push(problem('CONFIG_INVALID', `输入中的符号链接指到输入根之外：${candidate}`));
        }
    }

    // 6) 版本探测（只读；读不到就如实 unknown）
    const versionFile = path.join(root, 'Stardew Valley.deps.json');
    if (exists(versionFile)) {
        try {
            const deps = readJsonIfExists(versionFile);
            const key = Object.keys(deps?.libraries ?? {}).find(key => /^Stardew ?Valley\//i.test(key));
            if (key) info.version = key.split('/')[1];
        } catch {
            /* 保持 unknown */
        }
    }

    const nativeSmapi = path.join(root, 'StardewModdingAPI');
    if (!exists(nativeSmapi) || !inspectElf(nativeSmapi)?.compatibleWithLinuxX64 || !isExecutable(nativeSmapi) || !realpathInside(root, nativeSmapi)) problems.push(problem('INPUT_MISSING', '需要 Linux x64 原生 StardewModdingAPI 可执行入口。'));
    const metadata = readJsonIfExists(path.join(root, 'SAB_INPUT.json'));
    const smapiDeps = readJsonIfExists(path.join(root, 'StardewModdingAPI.deps.json'));
    const smapiKey = Object.keys(smapiDeps?.libraries ?? {}).find(key => /^(SMAPI|StardewModdingAPI)\//i.test(key));
    if (metadata?.schemaVersion === 1 && metadata.platform === 'linux-x64') info.version ??= metadata.gameVersion;
    info.smapiVersion = smapiKey?.split('/')[1] ?? metadata?.smapiVersion ?? null;
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(info.version ?? '') || !/^\d+\.\d+\.\d+$/.test(info.smapiVersion ?? '')) problems.push(problem('CONFIG_INVALID', '无法识别版本；请提供带 schemaVersion=1、platform=linux-x64、gameVersion、smapiVersion 的 SAB_INPUT.json。'));
    return { ok: problems.length === 0, problems, info };
}

/**
 * 检查 Mod 产物契约（§7.4）：
 * current/{StardewAgentBridge.dll, manifest.json, artifact.json}
 * 三个文件齐全、manifest 字段正确、artifact.json 哈希与实际一致、无夹带游戏文件。
 */
export function inspectModArtifacts(dir, { exists = existsSync } = {}) {
    const problems = [];
    const info = { dir, manifest: null, artifact: null };
    if (!exists(dir)) {
        return { ok: false, problems: [problem('INPUT_MISSING', `Mod 产物目录不存在：${dir}（请先运行 mod-build 工具）`)], info };
    }
    const dll = path.join(dir, REQUIRED_MOD_DLL);
    for (const entry of readdirSync(dir)) {
        const stat = lstatSync(path.join(dir, entry));
        if (!['StardewAgentBridge.dll', 'manifest.json', 'artifact.json'].includes(entry) || !stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) problems.push(problem('CONFIG_INVALID', 'Mod 产物含不允许的文件或链接。'));
    }
    const manifestFile = path.join(dir, 'manifest.json');
    const artifactFile = path.join(dir, 'artifact.json');
    for (const [label, file] of [['DLL', dll], ['manifest.json', manifestFile], ['artifact.json', artifactFile]]) {
        if (!exists(file)) problems.push(problem('INPUT_MISSING', `Mod 产物缺少${label}：${file}`));
    }
    if (problems.length > 0) return { ok: false, problems, info };

    const manifest = readJsonIfExists(manifestFile);
    if (!manifest) return { ok: false, problems: [problem('CONFIG_INVALID', `manifest.json 无法解析：${manifestFile}`)], info };
    info.manifest = manifest;
    if (manifest.UniqueID !== REQUIRED_MOD_UNIQUE_ID) {
        problems.push(problem('CONFIG_INVALID', `manifest UniqueID 必须是 ${REQUIRED_MOD_UNIQUE_ID}（收到 ${manifest.UniqueID}）。`));
    }
    if (manifest.EntryDll !== REQUIRED_MOD_DLL) {
        problems.push(problem('CONFIG_INVALID', `manifest EntryDll 必须是 ${REQUIRED_MOD_DLL}（收到 ${manifest.EntryDll}）。`));
    }

    const artifact = readJsonIfExists(artifactFile);
    if (!artifact) return { ok: false, problems: [...problems, problem('CONFIG_INVALID', `artifact.json 无法解析：${artifactFile}`)], info };
    info.artifact = artifact;
    if (artifact.schemaVersion !== 1) {
        problems.push(problem('CONFIG_INVALID', `artifact.json schemaVersion 必须是 1（收到 ${artifact.schemaVersion}）。`));
    }
    if (typeof artifact.modVersion === 'string' && typeof manifest.Version === 'string' && artifact.modVersion !== manifest.Version) {
        problems.push(
            problem('CONFIG_INVALID', `artifact.json 的 modVersion（${artifact.modVersion}）与 manifest 版本（${manifest.Version}）不一致。`)
        );
    }
    const recorded = artifact.artifacts ?? {};
    for (const [name, file] of [[REQUIRED_MOD_DLL, dll], ['manifest.json', manifestFile]]) {
        const expected = recorded[name]?.sha256;
        if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
            problems.push(problem('CONFIG_INVALID', `artifact.json 未记录 ${name} 的 SHA-256。`));
            continue;
        }
        const actual = sha256OfFile(file);
        if (actual !== expected) {
            problems.push(problem('CONFIG_INVALID', `产物哈希不一致：${name}（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）。`));
        }
    }

    // 白名单：不允许夹带游戏程序集、SMAPI、Harmony/MonoGame、pdb、obj、NuGet 缓存。
    const forbidden = [
        'Stardew Valley.dll',
        'StardewValley.dll',
        'StardewModdingAPI.dll',
        '0Harmony.dll',
        'MonoGame.Framework.dll'
    ];
    for (const name of forbidden) {
        if (exists(path.join(dir, name))) problems.push(problem('CONFIG_INVALID', `Mod 产物夹带了游戏/SMAPI 文件：${name}`));
    }
    for (const pattern of ['.pdb', '.deps.json', '.runtimeconfig.json']) {
        if (exists(path.join(dir, `${REQUIRED_MOD_DLL}${pattern}`))) {
            problems.push(problem('CONFIG_INVALID', `Mod 产物不应包含 ${REQUIRED_MOD_DLL}${pattern}。`));
        }
    }
    return { ok: problems.length === 0, problems, info };
}

/** 检查可写挂载点与磁盘空间（只读探测：不创建业务文件）。 */
export function inspectMounts(config, { exists = existsSync, free = freeBytes, platform = 'linux' } = {}) {
    const problems = [];
    const details = {};
    const writable = [
        ['数据卷', config.home],
        ['运行目录', LAYOUT.run]
    ];
    if (config.mode === 'game') {
        writable.push(['游戏 HOME', LAYOUT.gameHome], ['工作副本卷', LAYOUT.gameWork]);
    }
    for (const [label, dir] of writable) {
        if (!exists(dir)) {
            problems.push(problem('PERMISSION_DENIED', `${label}未挂载：${dir}`));
            continue;
        }
        let stat;
        try {
            stat = statSync(dir);
        } catch (error) {
            problems.push(problem('PERMISSION_DENIED', `${label}不可读：${dir}（${error.message}）`));
            continue;
        }
        if (!stat.isDirectory()) {
            problems.push(problem('PERMISSION_DENIED', `${label}不是目录：${dir}`));
            continue;
        }
        const bytes = free(dir);
        try { accessSync(dir, constants.W_OK | constants.R_OK | constants.X_OK); }
        catch { problems.push(problem('PERMISSION_DENIED', `${label}不可写。`)); }
        details[label] = { path: dir, freeBytes: bytes, free: humanBytes(bytes) };
        if (bytes !== null && bytes < 64 * 1024 * 1024) {
            problems.push(problem('PERMISSION_DENIED', `${label}可用空间不足（${humanBytes(bytes)}）：${dir}`));
        }
    }
    if (platform === 'linux') {
        // 私有目录不应是全局可写（不会 chmod 777 来"修复"）。
        for (const [label, dir] of [['数据卷', config.home]]) {
            try {
                const mode = statSync(dir).mode & 0o777;
                details[label] = { ...(details[label] ?? {}), mode: mode.toString(8) };
                if (mode !== 0o700) {
                    problems.push(problem('PERMISSION_DENIED', `${label}权限过宽（${mode.toString(8)}），应为 0700：${dir}`));
                }
            } catch {
                /* 已在上面报告 */
            }
        }
    }
    if (config.mode === 'game') {
        if (!exists(LAYOUT.inputGame)) {
            problems.push(problem('INPUT_MISSING', `游戏输入未挂载：${LAYOUT.inputGame}（Compose long bind，禁止自动创建）`));
        }
        if (!exists(LAYOUT.inputMod)) {
            problems.push(problem('INPUT_MISSING', `Mod 产物卷未挂载：${LAYOUT.inputMod}`));
        }
    }
    return { ok: problems.length === 0, problems, details };
}

/** 汇总预检：返回 { ok, code, exitCode, checks, details }。 */
export function runPreflight(config, deps = {}) {
    const exists = deps.exists ?? existsSync;
    const checks = [];
    if ((deps.restorePending ?? restorePending)({ targets: { data: { path: config.home }, home: { path: LAYOUT.gameHome } } })) {
        return { ok: false, code: 'RECOVERY_REQUIRED', exitCode: 14, checks: [], details: {}, problems: [problem('RECOVERY_REQUIRED', '存在未完成恢复事务，先运行 recover-restore。')] };
    }
    const mounts = inspectMounts(config, { exists, free: deps.free });
    checks.push({ name: 'mounts', ok: mounts.ok, problems: mounts.problems });

    let code = mounts.ok ? 'OK' : (mounts.problems.find((item) => item.code === 'INPUT_MISSING') ? 'INPUT_MISSING' : 'PERMISSION_DENIED');
    const details = { mounts: mounts.details };

    if (config.mode === 'game') {
        const source = inspectGameSource(LAYOUT.inputGame, { exists });
        checks.push({ name: 'gameSource', ok: source.ok, problems: source.problems });
        details.gameSource = {
            gameAssembly: source.info.gameAssembly,
            launcher: source.info.launcher,
            smapi: source.info.smapi,
            version: source.info.version
        };
        const mod = inspectModArtifacts(config.modArtifacts, { exists });
        checks.push({ name: 'modArtifacts', ok: mod.ok, problems: mod.problems });
        details.modArtifacts = { manifestVersion: mod.info.manifest?.Version ?? null, modVersion: mod.info.artifact?.modVersion ?? null };
        if (!source.ok && code === 'OK') code = source.problems.some((p) => p.code === 'INPUT_MISSING') ? 'INPUT_MISSING' : 'CONFIG_INVALID';
        if (!mod.ok && code === 'OK') code = mod.problems.some((p) => p.code === 'INPUT_MISSING') ? 'INPUT_MISSING' : 'CONFIG_INVALID';
    }

    if (config.desktopEnabled) {
        try {
            const password = readFileSync(config.vncPasswordFile, 'utf8').trimEnd();
            if (!/^[A-Za-z0-9]{8}$/.test(password)) throw new Error('INVALID_SECRET');
        } catch { checks.push({ name: 'desktopSecret', ok: false, problems: [problem('CONFIG_INVALID', '桌面需要可读的 8 位字母数字 VNC 密码文件。')] }); code = 'CONFIG_INVALID'; }
    }
    const problems = checks.flatMap((check) => check.problems);
    return { ok: problems.length === 0, code: problems.length === 0 ? 'OK' : code, exitCode: problems.length === 0 ? 0 : EXIT[code] ?? 1, checks, problems, details };
}

export function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const modeFlagIndex = argv.indexOf('--mode');
    const mode = modeFlagIndex >= 0 ? argv[modeFlagIndex + 1] : undefined;
    const parsed = parseContainerConfig(process.env, { ...(mode ? { mode } : {}) });
    if (!parsed.ok) return emitResult(parsed, { json });
    const result = runPreflight(parsed.config);
    if (!result.ok) {
        return emitResult(
            { ok: false, code: result.code, message: result.problems.map((item) => item.message).join('；'), details: { problems: result.problems, checks: result.checks }, exitCode: result.exitCode },
            { json }
        );
    }
    return emitResult({ ok: true, code: 'OK', message: `预检通过（模式 ${parsed.config.mode}）。`, details: { checks: result.checks.length } }, { json });
}

/** 工作副本源摘要：用于发现输入变化（只哈希关键文件，不重复全量复制）。 */
export function sourceDigest(root, { exists = existsSync } = {}) {
    const files = {};
    for (const name of [...GAME_ASSEMBLY_CANDIDATES, ...SMAPI_ASSEMBLY_CANDIDATES, 'StardewModdingAPI', 'StardewValley', 'SAB_INPUT.json', 'StardewModdingAPI.deps.json', 'Stardew Valley.deps.json']) {
        const file = path.join(root, name);
        if (!exists(file)) continue;
        try {
            files[name] = sha256OfFile(file);
        } catch {
            /* 读不到就不进摘要，由预检报错 */
        }
    }
    const canonical = JSON.stringify(Object.keys(files).sort().map((name) => [name, files[name]]));
    return { files, digest: sha256OfText(canonical) };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
    process.exitCode = main();
}
