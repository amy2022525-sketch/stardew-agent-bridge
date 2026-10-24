#!/usr/bin/env node
/**
 * Linux 桌面入口脚本（发布包内也会打包成自包含 MJS）。
 *
 * 用法：
 *   desktop-entry.mjs install [--desktop-shortcut] [--data-dir <绝对路径>]
 *   desktop-entry.mjs remove  [--desktop-shortcut]
 *   desktop-entry.mjs print   [--data-dir <绝对路径>]   # 只打印，不写文件
 *
 * 只写本项目自己的文件（带 X-SAB-Managed 标记），移除时只删带标记的入口；
 * 绝不删除数据目录、凭据、账本或游戏存档。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentPlatformId, installDesktopEntry, removeDesktopEntry, renderDesktopEntry, resolveDataRoot } from '@sab/platform';

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

const HELP = `用法：desktop-entry.mjs <install|remove|print> [选项]

选项：
  --desktop-shortcut   同时创建用户桌面快捷方式
  --data-dir <路径>    Bridge 数据根（默认按 XDG 规则解析，必须绝对）
  --json               输出机器可读 JSON
`;

/** 包内/源码两种布局下找到 CLI 入口，供 Exec 使用（绝对路径）。 */
function resolveCliEntry(explicitRoot) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        explicitRoot ? path.join(explicitRoot, 'server', 'bridge.mjs') : null,
        path.join(here, '..', 'server', 'bridge.mjs'),
        path.join(here, '..', '..', 'apps', 'server', 'dist', 'cli.js')
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveIcon(explicitRoot) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        explicitRoot ? path.join(explicitRoot, 'assets', 'stardew-agent-bridge.svg') : null,
        path.join(here, '..', 'assets', 'stardew-agent-bridge.svg'),
        path.join(here, '..', '..', 'assets', 'stardew-agent-bridge.svg')
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function main(argv) {
    const flags = parseFlags(argv);
    if (flags.help === true) {
        process.stdout.write(HELP);
        return 0;
    }
    const action = flags._[0] ?? 'install';
    const json = flags.json === true;
    if (currentPlatformId() === 'win32') {
        process.stderr.write('桌面入口只适用于 Linux；Windows 请使用 .ps1 入口或自行创建快捷方式。\n');
        return 1;
    }

    let dataRoot;
    try {
        dataRoot = resolveDataRoot({
            explicit: typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined,
            env: process.env,
            platform: 'linux',
            homeDir: os.homedir(),
            cwd: process.cwd(),
            requireAbsoluteExplicit: true
        });
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }

    const ctx = {
        env: process.env,
        homeDir: os.homedir(),
        platform: 'linux',
        runCommand: (file, args) => {
            const result = spawnSync(file, args, { encoding: 'utf8', shell: false, timeout: 5000 });
            return { status: result.status, stdout: result.stdout ?? '' };
        }
    };

    const cliEntry = resolveCliEntry(typeof flags.root === 'string' ? flags.root : null);
    if (!cliEntry) {
        process.stderr.write('找不到 Bridge 入口（server/bridge.mjs 或 apps/server/dist/cli.js），请先构建或使用完整发布包。\n');
        return 1;
    }
    const spec = {
        name: 'Stardew Agent Bridge',
        nameLocalized: '星露谷 Agent 桥接',
        comment: '启动或复用本机星露谷桥接服务，并在浏览器中打开控制台。',
        execPath: process.execPath,
        args: [cliEntry, 'launch', '--data-dir', dataRoot.path],
        iconPath: '',
        workingDirectory: path.dirname(dataRoot.path)
    };

    if (action === 'print') {
        process.stdout.write(renderDesktopEntry({ ...spec, iconPath: resolveIcon(typeof flags.root === 'string' ? flags.root : null) ?? '' }));
        return 0;
    }

    if (action === 'install') {
        const iconSource = resolveIcon(typeof flags.root === 'string' ? flags.root : null);
        const result = installDesktopEntry({
            ctx,
            spec,
            desktopShortcut: flags['desktop-shortcut'] === true,
            ...(iconSource ? { iconSource } : {}),
            iconTargetDir: path.join(dataRoot.path, 'icons')
        });
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
            process.stdout.write(`菜单入口：${result.entryFile}\n`);
            if (result.desktopFile) process.stdout.write(`桌面快捷方式：${result.desktopFile}\n`);
            for (const note of result.notes) process.stdout.write(`  - ${note}\n`);
            if (!result.ok) process.stderr.write(`安装未完成（${result.code ?? 'UNKNOWN'}）。\n`);
        }
        return result.ok ? 0 : 1;
    }

    if (action === 'remove') {
        const result = removeDesktopEntry({ ctx, desktopShortcut: flags['desktop-shortcut'] !== false });
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
            for (const file of result.removed) process.stdout.write(`已移除：${file}\n`);
            if (result.removed.length === 0) process.stdout.write('没有移除任何文件。\n');
            for (const note of result.notes) process.stdout.write(`  - ${note}\n`);
        }
        return 0;
    }

    process.stderr.write(`未知操作：${action}（可选 install / remove / print）\n`);
    return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
