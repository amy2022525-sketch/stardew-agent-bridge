/**
 * Mod 配置只读检查测试（doctor 的 Linux 关键分支）。
 *
 * 重点：Steam 启动游戏不会继承终端的 SAB_HOME，因此必须能只读比对
 * 「Bridge 数据根」与「Mod config.DataDirectory」，并在不一致时明确报错，
 * 而不是悄悄复制凭据掩盖问题。
 *
 * 用临时目录伪造游戏目录，不接触真实游戏与 Steam。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { compareModDataDirectory as compareDirectory, listBridgeModDirs, locateModConfigs, type ModConfigReport } from '@sab/server';

const compareModDataDirectory = (report: ModConfigReport, root: string) => compareDirectory(report, root, 'linux');

const areas: string[] = [];

function tempDir(label: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sab-modcfg-${label}-`));
    areas.push(dir);
    return dir;
}

after(() => {
    for (const dir of areas) rmSync(dir, { recursive: true, force: true });
});

function fakeGame(label: string, options: { config?: Record<string, unknown> | null; manifest?: Record<string, unknown> } = {}): string {
    const root = path.join(tempDir(label), 'Stardew Valley');
    mkdirSync(path.join(root, 'Mods', 'StardewAgentBridge'), { recursive: true });
    writeFileSync(path.join(root, 'Stardew Valley.dll'), 'fake');
    writeFileSync(path.join(root, 'StardewModdingAPI.dll'), 'fake');
    writeFileSync(
        path.join(root, 'Mods', 'StardewAgentBridge', 'manifest.json'),
        JSON.stringify(options.manifest ?? { UniqueID: 'StardewAgentBridge.Bridge', Version: '0.1.0' })
    );
    if (options.config !== null) {
        writeFileSync(
            path.join(root, 'Mods', 'StardewAgentBridge', 'config.json'),
            JSON.stringify(options.config ?? { Port: 17654, PauseAfterEachStep: true })
        );
    }
    return root;
}

describe('Mod 配置定位', () => {
    it('显式游戏目录优先，且能读出 DataDirectory 与端口', () => {
        const game = fakeGame('explicit', { config: { DataDirectory: '/home/player/.local/share/StardewAgentBridge', Port: 17654, PauseAfterEachStep: true } });
        const reports = locateModConfigs({ env: {}, homeDir: '/home/player', gamePath: game });
        assert.equal(reports.length, 1);
        const report = reports[0]!;
        assert.equal(report.source, 'explicit');
        assert.equal(report.exists, true);
        assert.equal(report.dataDirectory, '/home/player/.local/share/StardewAgentBridge');
        assert.equal(report.port, 17654);
        assert.equal(report.pauseAfterEachStep, true);
        assert.ok(report.path.endsWith(path.join('Mods', 'StardewAgentBridge', 'config.json')));
        assert.ok(report.gameRoot.endsWith('Stardew Valley'));
    });

    it('缺少 config.json 时报告 exists=false 而不是编造默认值', () => {
        const game = fakeGame('missing-config', { config: null });
        const reports = locateModConfigs({ env: {}, homeDir: '/home/player', gamePath: game });
        assert.equal(reports[0]!.exists, false);
        assert.equal(reports[0]!.dataDirectory, null);
        assert.equal(reports[0]!.port, null);
    });

    it('没有显式目录时使用安装记录里的游戏目录', () => {
        const game = fakeGame('record', { config: { DataDirectory: '/data/sab' } });
        const reports = locateModConfigs({ env: {}, homeDir: '/home/player', recordedGameRoot: game });
        assert.equal(reports.length, 1);
        assert.equal(reports[0]!.source, 'record');
        assert.equal(reports[0]!.dataDirectory, '/data/sab');
    });

    it('既没有显式目录也没有记录时不做危险猜测（返回空或 Steam 候选）', () => {
        const emptyHome = tempDir('empty-home');
        const reports = locateModConfigs({ env: {}, homeDir: emptyHome, platform: 'linux' });
        assert.deepEqual(reports, []);
    });
});

describe('DataDirectory 比对', () => {
    const base: ModConfigReport = {
        path: '/game/Mods/StardewAgentBridge/config.json',
        gameRoot: '/game',
        exists: true,
        dataDirectory: '/home/player/.local/share/StardewAgentBridge',
        port: 17654,
        pauseAfterEachStep: true,
        matchesBridgeRoot: false,
        source: 'explicit'
    };

    it('完全一致时匹配', () => {
        const result = compareModDataDirectory(base, '/home/player/.local/share/StardewAgentBridge');
        assert.equal(result.matchesBridgeRoot, true);
    });

    it('末尾斜杠不影响判定', () => {
        const result = compareModDataDirectory({ ...base, dataDirectory: '/home/player/.local/share/StardewAgentBridge/' }, '/home/player/.local/share/StardewAgentBridge');
        assert.equal(result.matchesBridgeRoot, true);
    });

    it('Linux 上大小写不同即不匹配', () => {
        const result = compareModDataDirectory({ ...base, dataDirectory: '/home/player/.local/share/stardewagentbridge' }, '/home/player/.local/share/StardewAgentBridge');
        assert.equal(result.matchesBridgeRoot, false);
    });

    it('不同目录不匹配（典型：Steam 启动没继承 SAB_HOME）', () => {
        const result = compareModDataDirectory({ ...base, dataDirectory: '/home/player/AppData/Local/StardewAgentBridge' }, '/home/player/.local/share/StardewAgentBridge');
        assert.equal(result.matchesBridgeRoot, false);
    });

    it('空值绝不算匹配', () => {
        assert.equal(compareModDataDirectory({ ...base, dataDirectory: null }, '/data/sab').matchesBridgeRoot, false);
        assert.equal(compareModDataDirectory({ ...base, dataDirectory: '   ' }, '/data/sab').matchesBridgeRoot, false);
    });

    it('相对路径不算匹配', () => {
        assert.equal(compareModDataDirectory({ ...base, dataDirectory: 'relative/dir' }, '/data/sab').matchesBridgeRoot, false);
    });

    it('Windows 路径比较使用盘符、反斜杠与不区分大小写的规则', () => {
        assert.equal(compareDirectory({ ...base, dataDirectory: 'c:/Users/Player/SAB/' }, 'C:\\Users\\player\\sab', 'win32').matchesBridgeRoot, true);
        assert.equal(compareDirectory({ ...base, dataDirectory: 'C:relative' }, 'C:\\data', 'win32').matchesBridgeRoot, false);
    });
});

describe('桥接 Mod 目录识别', () => {
    it('只按 manifest UniqueID 认本项目（含旧 ID），不按目录名猜', () => {
        const root = path.join(tempDir('bridge-dirs'), 'Stardew Valley');
        const mods = path.join(root, 'Mods');
        mkdirSync(path.join(mods, 'StardewAgentBridge'), { recursive: true });
        mkdirSync(path.join(mods, 'OldBridgeName'), { recursive: true });
        mkdirSync(path.join(mods, 'SomeOtherMod'), { recursive: true });
        mkdirSync(path.join(mods, 'BrokenMod'), { recursive: true });
        writeFileSync(path.join(mods, 'StardewAgentBridge', 'manifest.json'), JSON.stringify({ UniqueID: 'StardewAgentBridge.Bridge' }));
        writeFileSync(path.join(mods, 'OldBridgeName', 'manifest.json'), JSON.stringify({ UniqueID: 'AgentStardew.Bridge' }));
        writeFileSync(path.join(mods, 'SomeOtherMod', 'manifest.json'), JSON.stringify({ UniqueID: 'Pathoschild.ContentPatcher' }));
        writeFileSync(path.join(mods, 'BrokenMod', 'manifest.json'), '{ broken');

        const found = listBridgeModDirs(root).map((dir) => path.basename(dir)).sort();
        assert.deepEqual(found, ['OldBridgeName', 'StardewAgentBridge']);
    });

    it('Mods 目录不存在时返回空数组而不是抛错', () => {
        const root = path.join(tempDir('no-mods'), 'Stardew Valley');
        assert.deepEqual(listBridgeModDirs(root), []);
    });
});
