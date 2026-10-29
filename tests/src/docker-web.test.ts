/**
 * Docker Web 展示逻辑测试（DKR-016）。
 *
 * 直接导入 apps/web/src/docker-status.mjs 的纯函数：解析净化状态、404/503 行为、
 * 桌面按钮 URL 的严格白名单（只允许规范回环地址且桌面可用）、各模式/状态的用户提示。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../..');
const mod = await import(pathToFileURL(path.join(REPO, 'apps/web/src/docker-status.mjs')).href) as {
    parseDockerStatus: (raw: unknown) => Record<string, unknown> | null;
    fetchDockerStatus: (fetchImpl?: unknown) => Promise<Record<string, unknown> | null>;
    desktopLinkUrl: (status: Record<string, unknown> | null) => string | null;
    dockerStatusHint: (status: Record<string, unknown> | null) => { title: string; detail: string } | null;
};

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { schemaVersion: 1, mode: 'game', state: 'ready', live: true, modConnected: true, saveLoaded: true,
        desktopEnabled: false, desktopAvailable: false, reasonCode: 'READY', desktopBaseUrl: null, ...overrides };
}

describe('docker-status（Web 纯逻辑）', () => {
    it('parseDockerStatus：拒绝非对象/错误 schema/错误 mode；白名单布尔化', () => {
        assert.equal(mod.parseDockerStatus(null), null);
        assert.equal(mod.parseDockerStatus({ schemaVersion: 2 }), null);
        assert.equal(mod.parseDockerStatus({ schemaVersion: 1, mode: 'other', state: 'x' }), null);
        const parsed = mod.parseDockerStatus(statusBody({ live: 'yes' }));
        assert.equal(parsed!.live, false, '非 true 一律按 false');
        assert.equal(parsed!.mode, 'game');
    });

    it('fetchDockerStatus：404（原生部署）→ null；503（启动中）仍解析；网络错误 → null', async () => {
        const notFound = await mod.fetchDockerStatus(async () => new Response('{}', { status: 404 }));
        assert.equal(notFound, null);
        const starting = await mod.fetchDockerStatus(async () => new Response(JSON.stringify(statusBody({ live: false, state: 'starting_bridge', reasonCode: 'STARTING_BRIDGE' })), { status: 503, headers: { 'content-type': 'application/json' } }));
        assert.equal(starting!.state, 'starting_bridge');
        const crashed = await mod.fetchDockerStatus(async () => { throw new Error('network down'); });
        assert.equal(crashed, null);
    });

    it('desktopLinkUrl：仅桌面可用 + 规范回环 URL 才给链接；其余一律 null', () => {
        assert.equal(mod.desktopLinkUrl(null), null);
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: false, desktopBaseUrl: 'http://127.0.0.1:6080' })), null, '桌面不可用不给链接');
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: null })), null);
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'http://127.0.0.1:6080' })), 'http://127.0.0.1:6080');
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'http://127.0.0.1:6080/' })), null, '带尾斜杠拒绝');
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'http://evil.example:6080' })), null);
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'http://127.0.0.1:6080/p?x=1' })), null, '带路径/query 拒绝');
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'https://127.0.0.1:6080' })), null, '仅 http');
        assert.equal(mod.desktopLinkUrl(statusBody({ desktopAvailable: true, desktopBaseUrl: 'http://127.0.0.1:99999' })), null, '超出端口范围拒绝');
    });

    it('dockerStatusHint：bridge 无游戏 / game 标题页 / 就绪 / 失败 / 桌面降级 各有正确提示', () => {
        assert.equal(mod.dockerStatusHint(null), null);
        const bridge = mod.dockerStatusHint(statusBody({ mode: 'bridge', state: 'bridge_ready', reasonCode: 'BRIDGE_READY' }));
        assert.ok(bridge!.title.includes('bridge') && bridge!.detail.includes('没有游戏'));
        const titlePage = mod.dockerStatusHint(statusBody({ state: 'awaiting_save', saveLoaded: false, reasonCode: 'AWAITING_SAVE' }));
        assert.ok(titlePage!.title.includes('标题页'));
        const ready = mod.dockerStatusHint(statusBody());
        assert.ok(ready!.title.includes('就绪') && ready!.detail.includes('游戏 Mod'));
        const degraded = mod.dockerStatusHint(statusBody({ desktopEnabled: true, desktopAvailable: false }));
        assert.ok(degraded!.detail.includes('降级'));
        const failed = mod.dockerStatusHint(statusBody({ state: 'failed', reasonCode: 'GAME_EXITED' }));
        assert.ok(failed!.title.includes('GAME_EXITED'));
        const stopped = mod.dockerStatusHint(statusBody({ state: 'stopped', reasonCode: 'STOPPED' }));
        assert.ok(stopped!.title.includes('停止'));
    });
});
