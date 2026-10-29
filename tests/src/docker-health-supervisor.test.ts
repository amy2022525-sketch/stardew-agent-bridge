/**
 * Docker 健康检查与监督器合成测试（P0-3）。
 *
 * healthcheck：状态缺失/代次不符/过期/未就绪/桌面降级，全部注入文件与时间。
 * supervisor：假子进程矩阵——关键进程退出触发停机、辅助（桌面）进程退出只降级、
 * 游戏退出且已加载存档给 UNSAVED_PROGRESS_POSSIBLE、bridge 模式正常生命周期。
 * 不启动真实 Xvfb/游戏/Docker。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../..');
const load = async (relative: string): Promise<any> => await import(pathToFileURL(path.join(REPO, relative)).href);

const healthcheck = await load('scripts/docker/runtime/healthcheck.mjs');
const supervisorMod = await load('scripts/docker/runtime/supervisor.mjs');

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { schemaVersion: 1, generation: 'g1', startNonce: 'n1', state: 'bridge_ready', mode: 'bridge', live: true,
        modConnected: false, saveLoaded: false, desktopEnabled: false, desktopAvailable: false, updatedAt: new Date().toISOString(), ...overrides };
}
const identityBody = { generation: 'g1', startNonce: 'n1', pid: 4242, processStart: 'tok' };

describe('healthcheck.evaluate', () => {
    const baseDeps = { readJson: () => statusBody(), readIdentity: () => identityBody, isSupervisorAlive: () => true, now: () => Date.now(),
        probeLive: async () => ({ status: 200, payload: { live: true, mode: 'bridge', state: 'bridge_ready' } }) };
    const env = { SAB_RUN_MODE: 'bridge', SAB_HTTP_PORT: '18055', SAB_GATEWAY_STATUS_FILE: 'X:/no.json' };

    it('状态或身份文件缺失 → STATUS_MISSING；代次不符 → GENERATION_MISMATCH', async () => {
        assert.equal((await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => null } })).reason, 'STATUS_MISSING');
        const mismatch = await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => statusBody({ generation: 'g0' }) } });
        assert.equal(mismatch.reason, 'GENERATION_MISMATCH');
    });

    it('监督器 PID 不再存活 → SUPERVISOR_NOT_ALIVE', async () => {
        const dead = await healthcheck.evaluate({ env, deps: { ...baseDeps, isSupervisorAlive: () => false } });
        assert.equal(dead.reason, 'SUPERVISOR_NOT_ALIVE');
    });

    it('状态过期（>30s）→ STATUS_STALE；未来时间戳同样拒绝', async () => {
        const stale = await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => statusBody({ updatedAt: new Date(Date.now() - 31_000).toISOString() }) } });
        assert.equal(stale.reason, 'STATUS_STALE');
        const future = await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => statusBody({ updatedAt: new Date(Date.now() + 60_000).toISOString() }) } });
        assert.equal(future.reason, 'STATUS_STALE');
    });

    it('game 模式 Mod 未连接 → MOD_NOT_CONNECTED；live=false → NOT_LIVE', async () => {
        const gameEnv = { ...env, SAB_RUN_MODE: 'game' };
        const noMod = await healthcheck.evaluate({ env: gameEnv, deps: { ...baseDeps, readJson: () => statusBody({ mode: 'game', state: 'ready', modConnected: false }) } });
        assert.equal(noMod.reason, 'MOD_NOT_CONNECTED');
        const notLive = await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => statusBody({ live: false }) } });
        assert.equal(notLive.reason, 'NOT_LIVE');
    });

    it('网关未就绪 → GATEWAY_NOT_READY；健康时桌面降级单独给 DESKTOP_DEGRADED', async () => {
        const gwDown = await healthcheck.evaluate({ env, deps: { ...baseDeps, probeLive: async () => ({ status: 503, payload: null }) } });
        assert.equal(gwDown.reason, 'GATEWAY_NOT_READY');
        const degraded = await healthcheck.evaluate({ env, deps: { ...baseDeps, readJson: () => statusBody({ desktopEnabled: true, desktopAvailable: false }) } });
        assert.equal(degraded.healthy, true);
        assert.equal(degraded.reason, 'DESKTOP_DEGRADED');
    });
});

/** 假子进程：记录信号，可按名字远程杀掉。 */
class FakeChild extends EventEmitter {
    readonly pid: number;
    readonly name: string;
    private readonly killer: (name: string) => void;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killedSignal: string | null = null;
    constructor(name: string, killer: (name: string) => void) {
        super();
        this.name = name;
        this.pid = 10_000 + FakeChild.nextPid++;
        this.killer = killer;
    }
    private static nextPid = 1;
    kill(signal = 'SIGTERM'): boolean {
        this.killedSignal = signal;
        // 真实进程收到致命信号后会退出；异步触发让 shutdown 的等待循环观察到。
        setImmediate(() => this.emit('exit', null, signal));
        return true;
    }
}

interface Harness {
    sup: ReturnType<typeof supervisorMod.createSupervisor>;
    children: Map<string, FakeChild>;
    probeResults: { bridgeUp: boolean; modConnected: boolean; saveLoaded: boolean; modVersion?: string; instanceId?: string | null; gameVersion?: string | null }[];
  statuses: Record<string, unknown>[];
  stopRecords: Record<string, unknown>[];
  files: { status: string; stop: string; bridgeEntry: string; gatewayEntry: string };
  done(): Promise<{ ok: boolean; exitCode: number; reasonCode: string; state: string }>;
}

function makeSupervisor(configOverrides: Record<string, unknown> = {}): Harness {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sab-sup-'));
    const runDir = path.join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    const children = new Map<string, FakeChild>();
    const probeResults: { bridgeUp: boolean; modConnected: boolean; saveLoaded: boolean; modVersion?: string; instanceId?: string | null; gameVersion?: string | null }[] =
        [{ bridgeUp: false, modConnected: false, saveLoaded: false, modVersion: '0.1.0', instanceId: 'inst-1', gameVersion: '1.6.15' }];
    const statuses: Record<string, unknown>[] = [];
    const stopRecords: Record<string, unknown>[] = [];
    const files = { status: path.join(runDir, 'status.json'), stop: path.join(runDir, 'runtime-stop.json'),
        bridgeEntry: path.join(root, 'server/bridge.mjs'), gatewayEntry: path.join(root, 'server/container-gateway.mjs') };
    let clock = 1_000;
    const config = { mode: 'bridge', home: path.join(root, 'var/lib/sab'), webDist: path.join(root, 'web'),
        httpPort: 18055, publicBase: { baseUrl: 'http://127.0.0.1:18055' }, desktopEnabled: false, novncPort: 6080, desktopBase: null,
        startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000, displaySize: '1280x720', logLevel: 'info',
        gameRoot: path.join(root, 'srv/game/current'), modArtifacts: path.join(root, 'input/mod'), vncPasswordFile: '/run/secrets/p',
        clientId: 'stdio', adapterUrl: 'http://127.0.0.1:17655', ports: { modInternal: 17654, bridgeInternal: 17655, gatewayInternal: 17656, vncInternal: 5900, novncInternal: 6080 }, ...configOverrides };
    const sup = supervisorMod.createSupervisor({
        config,
        paths: files,
        deps: {
            generation: 'g-test', startNonce: 'n-test',
            now: () => (clock += 10),
            sleep: async (ms: number) => { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))); },
            spawn: (command: string, args: readonly string[]) => {
                const name = args.includes(files.gatewayEntry) || args[0]?.endsWith('container-gateway.mjs') ? 'gateway'
                    : args[0]?.endsWith('bridge.mjs') ? 'bridge'
                    : command.endsWith('Xvfb') ? 'display'
                    : command.endsWith('openbox') ? 'window-manager'
                    : command.endsWith('x11vnc') ? 'vnc'
                    : command.endsWith('websockify') ? 'websockify'
                    : args[0]?.endsWith('desktop-gateway.mjs') ? 'desktop-gateway'
                    : command.endsWith('StardewModdingAPI') ? 'game' : `unknown:${command}`;
                const child = new FakeChild(name, () => {});
                children.set(name, child);
                return child;
            },
            probeHealth: async () => probeResults[0],
            probeGateway: async () => true,
            preflight: () => ({ ok: true }),
            seed: () => ({ ok: true, current: config.gameRoot }),
            displayReady: () => true,
            validateDescriptor: () => ({ ok: true }),
            readModManifest: () => ({ Version: '0.1.0' }),
            claimVolume: () => undefined,
            writeIdentity: () => undefined,
            mkdir: () => undefined,
            writeStatus: (_file: string, status: Record<string, unknown>) => { statuses.push(status); },
            writeStopRecord: (_file: string, record: Record<string, unknown>) => { stopRecords.push(record); },
            writeAuthority: () => undefined
        }
    });
    return { sup, children, probeResults, statuses, stopRecords, files,
        done: async () => { const result = await sup.run(); rmSync(root, { recursive: true, force: true }); return result; } };
}

describe('supervisor 合成进程矩阵', () => {
    it('bridge 模式：正常启动到 bridge_ready，SIGTERM 停机为 stopped/0，写了停止记录', async () => {
        const h = makeSupervisor();
        const run = h.done();
        await new Promise(resolve => setTimeout(resolve, 80));
        h.probeResults[0] = { bridgeUp: true, modConnected: false, saveLoaded: false };
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(h.sup.state, 'bridge_ready');
        const record = await h.sup.requestStop('SIGTERM');
        assert.equal(record.reason, 'SIGTERM');
        const result = await run;
        assert.equal(result.ok, true);
        assert.equal(result.state, 'stopped');
        assert.equal(h.stopRecords.length, 1);
        // 两个关键进程都收到 SIGTERM。
        assert.equal(h.children.get('bridge')!.killedSignal, 'SIGTERM');
        assert.equal(h.children.get('gateway')!.killedSignal, 'SIGTERM');
    });

    it('bridge 关键进程退出：全体停机，退出码 CHILD_EXITED，状态 failed', async () => {
        const h = makeSupervisor();
        const run = h.done();
        await new Promise(resolve => setTimeout(resolve, 80));
        h.probeResults[0] = { bridgeUp: true, modConnected: false, saveLoaded: false };
        await new Promise(resolve => setTimeout(resolve, 120));
        h.children.get('bridge')!.emit('exit', 1);
        const result = await run;
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 16);
        assert.equal(result.reasonCode, 'BRIDGE_EXITED');
        assert.equal(result.state, 'failed');
    });

    it('启动超时（bridge 一直不健康）：START_TIMEOUT=15，不冒充就绪', async () => {
        const h = makeSupervisor();
        const result = await h.done();
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 15);
        assert.equal(result.reasonCode, 'BRIDGE_START_TIMEOUT');
    });

    it('game 模式：辅助桌面进程退出只降级（DESKTOP_DEGRADED），关键进程仍活', async () => {
        const gameRoot = mkdtempSync(path.join(os.tmpdir(), 'sab-game-'));
        try {
            writeFileSync(path.join(gameRoot, 'StardewModdingAPI'), '#!/bin/sh\n');
            const h = makeSupervisor({ mode: 'game', desktopEnabled: true, gameRoot });
            h.probeResults[0] = { bridgeUp: true, modConnected: true, saveLoaded: true, modVersion: '0.1.0', instanceId: 'inst-1', gameVersion: '1.6.15' };
            const run = h.done();
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.ok(['ready'].includes(h.sup.state), `状态应为 ready，实际 ${h.sup.state}`);
            // 桌面三件套已按非关键启动。
            for (const name of ['vnc', 'websockify', 'desktop-gateway']) assert.ok(h.children.has(name), `${name} 应已启动`);
            h.children.get('vnc')!.emit('exit', 1);
            await new Promise(resolve => setTimeout(resolve, 120));
            const last = h.statuses.at(-1)!;
            assert.equal(last.desktopAvailable, false);
            assert.equal(last.reasonCode, 'DESKTOP_DEGRADED');
            assert.equal(last.live, true, '辅助降级不等于不可用');
            const record = await h.sup.requestStop('SIGTERM');
            assert.equal(record.gamePhase, 'in_world');
            assert.equal(record.unsavedProgressPossible, true, '已加载存档的停机必须标记可能有未保存进度');
            const result = await run;
            assert.equal(result.ok, false);
            assert.equal(result.exitCode, 18, 'UNSAVED_PROGRESS_POSSIBLE');
        } finally { rmSync(gameRoot, { recursive: true, force: true }); }
    });
});
