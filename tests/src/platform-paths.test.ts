/**
 * 数据根规则测试：直接跑 tests/fixtures/platform-paths.json 的共享契约向量。
 *
 * 这些向量同时被 Mod 侧 C#（tests/mod/Program.cs）读取，因此任何一侧改规则都会
 * 让另一侧红；不需要真实游戏、不需要 Steam、不需要网络。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
    APP_DIRECTORY_NAME,
    DataRootError,
    finalizePathFor,
    inspectLegacyDataRoot,
    isAbsolutePathFor,
    joinPathFor,
    resolveDataRoot,
    type PlatformId
} from '@sab/platform';

interface Case {
    name: string;
    parties: string[];
    platform: PlatformId;
    explicit: string | null;
    env: Record<string, string>;
    homeDir: string;
    cwd: string;
    requireAbsoluteExplicit: boolean;
    expect: { ok: boolean; path?: string; source?: string; errorCode?: string };
}

const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', '..', 'fixtures', 'platform-paths.json'), 'utf8')
) as { schemaVersion: number; cases: Case[] };

describe('数据根规则（共享契约向量）', () => {
    it('契约文件版本受支持', () => {
        assert.equal(fixture.schemaVersion, 1);
        assert.ok(fixture.cases.length >= 15);
    });

    for (const testCase of fixture.cases) {
        it(`${testCase.platform} · ${testCase.name}`, () => {
            if (!testCase.expect.ok) {
                assert.throws(
                    () =>
                        resolveDataRoot({
                            explicit: testCase.explicit ?? undefined,
                            env: testCase.env,
                            platform: testCase.platform,
                            homeDir: testCase.homeDir,
                            cwd: testCase.cwd,
                            requireAbsoluteExplicit: testCase.requireAbsoluteExplicit
                        }),
                    (error: unknown) => {
                        assert.ok(error instanceof DataRootError, '必须是 DataRootError');
                        assert.equal(error.code, testCase.expect.errorCode);
                        return true;
                    }
                );
                return;
            }
            const resolved = resolveDataRoot({
                explicit: testCase.explicit ?? undefined,
                env: testCase.env,
                platform: testCase.platform,
                homeDir: testCase.homeDir,
                cwd: testCase.cwd,
                requireAbsoluteExplicit: testCase.requireAbsoluteExplicit
            });
            assert.equal(resolved.path, testCase.expect.path);
            assert.equal(resolved.source, testCase.expect.source);
            assert.equal(resolved.platform, testCase.platform);
        });
    }

    it('应用目录名大小写准确', () => {
        assert.equal(APP_DIRECTORY_NAME, 'StardewAgentBridge');
        assert.ok(!APP_DIRECTORY_NAME.includes('-'));
    });

    it('绝不把 Linux 上的 LOCALAPPDATA 当作默认根', () => {
        const resolved = resolveDataRoot({
            env: { LOCALAPPDATA: '/tmp/legacy' },
            platform: 'linux',
            homeDir: '/home/player',
            cwd: '/tmp'
        });
        assert.ok(resolved.path.startsWith('/home/player/'), resolved.path);
        assert.ok(!resolved.path.includes('AppData'), resolved.path);
    });

    it('目标平台语义与宿主平台无关：win32 规则不使用 posix 分隔符', () => {
        const resolved = resolveDataRoot({
            env: {},
            platform: 'win32',
            homeDir: 'C:\\Users\\player',
            cwd: 'C:\\'
        });
        assert.ok(resolved.path.includes('\\'), resolved.path);
        assert.ok(!resolved.path.includes('/'), resolved.path);
    });
});

describe('路径工具', () => {
    it('isAbsolutePathFor 按目标平台判断', () => {
        assert.equal(isAbsolutePathFor('linux', '/opt/x'), true);
        assert.equal(isAbsolutePathFor('linux', 'opt/x'), false);
        assert.equal(isAbsolutePathFor('linux', 'C:\\x'), false);
        assert.equal(isAbsolutePathFor('win32', 'C:\\x'), true);
        assert.equal(isAbsolutePathFor('win32', '\\\\server\\share'), true);
        assert.equal(isAbsolutePathFor('win32', 'x'), false);
    });

    it('finalizePathFor 去末尾分隔符但保留根', () => {
        assert.equal(finalizePathFor('linux', '/opt/x/'), '/opt/x');
        assert.equal(finalizePathFor('linux', '/'), '/');
        assert.equal(finalizePathFor('win32', 'C:\\x\\'), 'C:\\x');
        assert.equal(finalizePathFor('win32', 'C:\\'), 'C:\\');
    });

    it('joinPathFor 不做磁盘访问、不做符号链接解析', () => {
        assert.equal(joinPathFor('linux', '/a', 'b', 'c'), '/a/b/c');
        assert.equal(joinPathFor('win32', 'C:\\a', 'b'), 'C:\\a\\b');
    });
});

describe('旧 Linux 数据根诊断', () => {
    it('只有旧目录时给出迁移提示且不合并', () => {
        const report = inspectLegacyDataRoot({
            homeDir: '/home/player',
            currentPath: '/home/player/.local/share/StardewAgentBridge',
            env: {},
            exists: (candidate) => candidate === '/home/player/AppData/Local/StardewAgentBridge'
        });
        assert.equal(report.kind, 'legacy-only');
        assert.equal(report.legacyPath, '/home/player/AppData/Local/StardewAgentBridge');
        assert.equal(report.notes.length, 1);
        assert.ok(report.notes[0]!.includes('不会自动合并'));
    });

    it('新旧目录同时存在时要求显式选择', () => {
        const report = inspectLegacyDataRoot({
            homeDir: '/home/player',
            currentPath: '/home/player/.local/share/StardewAgentBridge',
            env: {},
            exists: () => true
        });
        assert.equal(report.kind, 'both');
        assert.ok(report.notes[0]!.includes('不会自动覆盖或合并'));
    });

    it('没有旧目录时不产生提示', () => {
        const report = inspectLegacyDataRoot({
            homeDir: '/home/player',
            currentPath: '/home/player/.local/share/StardewAgentBridge',
            env: {},
            exists: () => false
        });
        assert.equal(report.kind, 'none');
        assert.deepEqual(report.notes, []);
    });
});
