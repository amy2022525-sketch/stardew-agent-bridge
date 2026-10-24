/**
 * 桌面入口测试。
 *
 * 重点：
 * - Exec 行转义必须按 Desktop Entry 规范（含空白/引号/`%` 的参数不能被拆行或当成 field code）；
 * - 目录解析只认 XDG 规则，且在 Windows 上明确拒绝而不是写一半；
 * - 移除只删带本项目标记的入口，绝不删别人创建的同名文件。
 *
 * 需要真实写文件的部分只在 Linux 上执行（PATH 语义与权限位一致）。
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
    buildExecLine,
    DESKTOP_ENTRY_FILENAME,
    DESKTOP_MANAGED_MARKER,
    escapeExecArgument,
    installDesktopEntry,
    readUserDirsDesktop,
    removeDesktopEntry,
    renderDesktopEntry,
    resolveApplicationsDir,
    resolveDesktopDir,
    resolveXdgDataHome
} from '@sab/platform';

const areas: string[] = [];
const linuxOnly = process.platform === 'linux';

function tempDir(label: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sab-desktop-${label}-`));
    areas.push(dir);
    return dir;
}

after(() => {
    for (const dir of areas) rmSync(dir, { recursive: true, force: true });
});

const spec = {
    name: 'Stardew Agent Bridge',
    nameLocalized: '星露谷 Agent 桥接',
    comment: '启动本机桥接服务',
    execPath: '/opt/sab/runtime/node',
    args: ['/opt/sab/server/bridge.mjs', 'launch', '--data-dir', '/home/player/.local/share/StardewAgentBridge'],
    iconPath: '/home/player/.local/share/StardewAgentBridge/icons/stardew-agent-bridge.svg'
};

describe('Exec 转义', () => {
    it('普通参数不加引号', () => {
        assert.equal(escapeExecArgument('launch'), 'launch');
        assert.equal(escapeExecArgument('/opt/sab/server/bridge.mjs'), '/opt/sab/server/bridge.mjs');
    });

    it('含空白的参数整体加引号', () => {
        assert.equal(escapeExecArgument('/home/玩家/星露谷 数据'), '"/home/玩家/星露谷 数据"');
    });

    it('引号、反斜杠、$ 与反引号被转义', () => {
        assert.equal(escapeExecArgument('a"b'), '"a\\"b"');
        assert.equal(escapeExecArgument('a\\b'), '"a\\\\b"');
        assert.equal(escapeExecArgument('a$b'), '"a\\$b"');
        assert.equal(escapeExecArgument('a`b'), '"a\\`b"');
    });

    it('% 一定被转义成 %%，避免被当成 field code', () => {
        assert.equal(escapeExecArgument('100%'), '100%%');
        assert.equal(escapeExecArgument('a%b'), 'a%%b');
    });

    it('空参数加引号以免被吞掉', () => {
        assert.equal(escapeExecArgument(''), '""');
    });

    it('Exec 行按参数逐个转义后拼接', () => {
        const line = buildExecLine('/opt/sab/runtime/node', ['a b', 'c']);
        assert.equal(line, '/opt/sab/runtime/node "a b" c');
    });
});

describe('入口文件内容', () => {
    it('包含必填字段与本项目标记', () => {
        const text = renderDesktopEntry(spec);
        assert.ok(text.startsWith('[Desktop Entry]\n'));
        assert.ok(text.includes('Type=Application'));
        assert.ok(text.includes('Name=Stardew Agent Bridge'));
        assert.ok(text.includes('Name[zh_CN]=星露谷 Agent 桥接'));
        assert.ok(text.includes('Exec='));
        assert.ok(text.includes('Icon='));
        assert.ok(text.includes('Terminal=false'));
        assert.ok(text.includes(DESKTOP_MANAGED_MARKER), '必须带本项目标记，便于安全移除');
        assert.ok(text.endsWith('\n'));
    });

    it('workingDirectory 映射为 Path=', () => {
        const text = renderDesktopEntry({ ...spec, workingDirectory: '/home/player' });
        assert.ok(text.includes('Path=/home/player'));
    });
});

describe('XDG 目录解析', () => {
    it('绝对 XDG_DATA_HOME 优先，否则回退 ~/.local/share', () => {
        assert.deepEqual(resolveXdgDataHome({ env: { XDG_DATA_HOME: '/data/xdg' }, homeDir: '/home/player' }), {
            path: '/data/xdg',
            source: 'XDG_DATA_HOME'
        });
        assert.deepEqual(resolveXdgDataHome({ env: { XDG_DATA_HOME: 'relative' }, homeDir: '/home/player' }), {
            path: '/home/player/.local/share',
            source: 'default'
        });
        assert.equal(resolveApplicationsDir({ env: {}, homeDir: '/home/player' }), '/home/player/.local/share/applications');
    });

    it('user-dirs.dirs 里的中文桌面目录被正确识别', () => {
        const home = tempDir('userdirs');
        mkdirSync(path.join(home, '.config'), { recursive: true });
        writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="/home/player/桌面"\n');
        assert.equal(readUserDirsDesktop(path.join(home, '.config', 'user-dirs.dirs'), '/home/player'), '/home/player/桌面');
        assert.deepEqual(resolveDesktopDir({ env: {}, homeDir: home }), { path: '/home/player/桌面', source: 'user-dirs.dirs' });
    });

    it('user-dirs.dirs 使用 $HOME 时被展开', () => {
        const home = tempDir('userdirs-home');
        mkdirSync(path.join(home, '.config'), { recursive: true });
        writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Desktop"\n');
        assert.equal(readUserDirsDesktop(path.join(home, '.config', 'user-dirs.dirs'), '/home/player'), '/home/player/Desktop');
    });

    it('没有 user-dirs.dirs 时依次尝试 xdg-user-dir，再回退 ~/Desktop', () => {
        const home = tempDir('userdirs-fallback');
        assert.deepEqual(resolveDesktopDir({ env: {}, homeDir: home }), { path: path.posix.join(home, 'Desktop'), source: 'fallback' });
        const viaCommand = resolveDesktopDir({
            env: {},
            homeDir: home,
            runCommand: () => ({ status: 0, stdout: '/home/player/私人/桌面\n' })
        });
        assert.deepEqual(viaCommand, { path: '/home/player/私人/桌面', source: 'xdg-user-dir' });
    });
});

describe('安装与移除', () => {
    it('Windows 平台明确拒绝（PLATFORM_UNSUPPORTED）', () => {
        const home = tempDir('win');
        const result = installDesktopEntry({
            ctx: { env: {}, homeDir: home, platform: 'win32' },
            spec
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'PLATFORM_UNSUPPORTED');
        assert.equal(result.entryFile, '');
    });

    it(
        '安装写入 0755 入口；缺图标时明确报 ICON_MISSING 但不写坏路径',
        { skip: linuxOnly ? false : '仅 Linux 验证真实写入' },
        () => {
            const home = tempDir('install');
            const xdg = path.join(home, 'xdg');
            const result = installDesktopEntry({
                ctx: { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' },
                spec
            });
            assert.equal(result.entryFile, path.join(xdg, 'applications', DESKTOP_ENTRY_FILENAME));
            assert.ok(existsSync(result.entryFile));
            const text = readFileSync(result.entryFile, 'utf8');
            assert.ok(text.includes(DESKTOP_MANAGED_MARKER));
            assert.equal(result.ok, false);
            assert.equal(result.code, 'ICON_MISSING');
            assert.equal(result.iconPath, '');
        }
    );

    it('有图标源时复制到数据目录并写进 Icon=', { skip: linuxOnly ? false : '仅 Linux 验证真实写入' }, () => {
        const home = tempDir('install-icon');
        const xdg = path.join(home, 'xdg');
        const iconSource = path.join(home, 'stardew-agent-bridge.svg');
        writeFileSync(iconSource, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const iconTargetDir = path.join(home, 'data', 'icons');
        const result = installDesktopEntry({
            ctx: { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' },
            spec,
            iconSource,
            iconTargetDir,
            desktopShortcut: true
        });
        assert.equal(result.ok, true);
        assert.equal(result.iconPath, path.join(iconTargetDir, 'stardew-agent-bridge.svg'));
        assert.ok(existsSync(result.iconPath));
        const text = readFileSync(result.entryFile, 'utf8');
        assert.ok(text.includes(`Icon=${result.iconPath}`));
        assert.ok(result.desktopFile !== null);
        assert.ok(existsSync(result.desktopFile!));
    });

    it('安装时拒绝覆盖不属于本项目的同名菜单入口', { skip: linuxOnly ? false : '仅 Linux 验证真实写入' }, () => {
        const home = tempDir('install-foreign');
        const xdg = path.join(home, 'xdg');
        const applications = path.join(xdg, 'applications');
        mkdirSync(applications, { recursive: true });
        const foreign = path.join(applications, DESKTOP_ENTRY_FILENAME);
        const original = '[Desktop Entry]\nType=Application\nName=保留的菜单入口\n';
        writeFileSync(foreign, original);
        const result = installDesktopEntry({ ctx: { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' }, spec });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'ENTRY_EXISTS');
        assert.equal(readFileSync(foreign, 'utf8'), original);
    });

    it('移除只删带标记的入口：别家同名文件保留并说明', { skip: linuxOnly ? false : '仅 Linux 验证真实写入' }, () => {
        const home = tempDir('remove-foreign');
        const xdg = path.join(home, 'xdg');
        const applications = path.join(xdg, 'applications');
        mkdirSync(applications, { recursive: true });
        const foreign = path.join(applications, DESKTOP_ENTRY_FILENAME);
        writeFileSync(foreign, '[Desktop Entry]\nType=Application\nName=别人家的入口\n');
        chmodSync(foreign, 0o755);

        const result = removeDesktopEntry({ ctx: { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' }, desktopShortcut: false });
        assert.deepEqual(result.removed, []);
        assert.deepEqual(result.skipped, [foreign]);
        assert.ok(result.notes.some((note) => note.includes('不属于本项目')));
        assert.ok(existsSync(foreign), '别人的文件必须保留');
    });

    it('安装后移除：删掉本项目入口并说明不动用户数据', { skip: linuxOnly ? false : '仅 Linux 验证真实写入' }, () => {
        const home = tempDir('remove-own');
        const xdg = path.join(home, 'xdg');
        const ctx = { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' as const };
        const installed = installDesktopEntry({ ctx, spec });
        assert.ok(existsSync(installed.entryFile));
        const removed = removeDesktopEntry({ ctx, desktopShortcut: false });
        assert.deepEqual(removed.removed, [installed.entryFile]);
        assert.ok(!existsSync(installed.entryFile));
        assert.ok(removed.notes.some((note) => note.includes('不会删除数据目录')));
    });
});
