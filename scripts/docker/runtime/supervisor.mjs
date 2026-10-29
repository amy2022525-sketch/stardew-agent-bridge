#!/usr/bin/env node
/** Bounded, idempotent supervision of one application unit. Never auto-load or auto-save a game. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXIT, LAYOUT, parseContainerConfig } from './config.mjs';
import { atomicWriteFile, atomicWriteJson, componentLogger, isoNow, newNonce, ownedPath, writeStatusFile, processStartToken, readJsonIfExists } from './lib.mjs';
import { prepareWorkdir } from './game-seed.mjs';
import { runPreflight } from './preflight.mjs';
import { claimVolume } from './volume-owner.mjs';

export const SUPERVISOR_STATES = ['created', 'preflight', 'preparing_workdir', 'starting_bridge', 'starting_gateway', 'starting_display', 'starting_game', 'awaiting_mod', 'awaiting_save', 'ready', 'bridge_ready', 'stopping', 'stopped', 'failed'];
export const READY_STATES = new Set(['ready', 'bridge_ready']);
export function interpretHealth(raw) {
    return { bridgeUp: raw?.ok === true, modConnected: raw?.modConnected === true, saveLoaded: raw?.saveLoaded === true,
        modVersion: raw?.modVersion ?? null, instanceId: raw?.modInstanceId ?? null, gameVersion: raw?.gameVersion ?? null };
}
function getJson({ port, route, host, timeoutMs = 1500 }) {
    return new Promise(resolve => {
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        const req = http.get({ host: '127.0.0.1', port, path: route, ...(host ? { headers: { host } } : {}), timeout: timeoutMs }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; if (body.length > 32 * 1024) req.destroy(); });
            res.on('end', () => { try { finish({ status: res.statusCode, body: JSON.parse(body) }); } catch { finish(null); } });
            res.on('error', () => finish(null));
            res.on('aborted', () => finish(null));
        });
        req.on('timeout', () => req.destroy()); req.on('error', () => finish(null));
    });
}
export async function probeHealth({ port = 17655 } = {}) { return interpretHealth((await getJson({ port, route: '/health' }))?.body); }
export async function probeGateway({ port = 17656, host = '127.0.0.1:17655' } = {}) {
    const result = await getJson({ port, route: '/container/live', host });
    return Boolean(result && [200, 503].includes(result.status) && result.body?.schemaVersion === 1 && ['bridge', 'game'].includes(result.body?.mode));
}
export function validateGameDescriptor(raw, { workRoot = `${LAYOUT.gameWork}/current`, exists = existsSync, realpath = realpathSync } = {}) {
    try {
        if (!raw || raw.shell === true || raw.executable !== path.join(workRoot, 'StardewModdingAPI') || raw.cwd !== workRoot || !Array.isArray(raw.argv) || raw.argv.length) throw new Error('不接受自定义命令或参数。');
        if (!exists(raw.executable)) throw new Error('缺少 Linux SMAPI 可执行入口。');
        ownedPath(realpath(workRoot), realpath(raw.executable));
        return { ok: true, problems: [] };
    } catch (error) { return { ok: false, problems: [error.message] }; }
}
export function defaultGameDescriptor(workRoot = `${LAYOUT.gameWork}/current`) { return { schemaVersion: 1, executable: path.join(workRoot, 'StardewModdingAPI'), argv: [], cwd: workRoot, shell: false }; }

/** Xauthority is private binary data; its cookie never appears in a process argument. */
export function makeXauthority(host = os.hostname(), cookie = randomBytes(16)) {
    const field = value => { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); const len = Buffer.alloc(2); len.writeUInt16BE(data.length); return Buffer.concat([len, data]); };
    return Buffer.concat([Buffer.from([1, 0]), field(host), field('99'), field('MIT-MAGIC-COOKIE-1'), field(cookie)]);
}
export function createSupervisor({ config, paths = {}, deps = {}, log = componentLogger('supervisor') }) {
    const layout = deps.layout ?? LAYOUT;
    const files = { status: path.join(layout.run, 'status.json'), stop: path.join(layout.run, 'runtime-stop.json'),
        bridgeEntry: path.join(layout.server, 'bridge.mjs'), gatewayEntry: path.join(layout.server, 'container-gateway.mjs'), ...paths };
    const generation = deps.generation ?? newNonce(12), startNonce = deps.startNonce ?? newNonce(12);
    const children = [];
    const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const probe = deps.probeHealth ?? probeHealth;
    let state = 'created', reasonCode = 'CREATED', stopping = false, stopRequested = false, shutdownPromise = null, exitCode = 0;
    let health = interpretHealth(null), desktopDegraded = false, ticker = null;
    const alive = name => children.some(child => child.name === name && !child.exited);
    const desktopAvailable = () => config.desktopEnabled && !desktopDegraded && ['vnc', 'websockify', 'desktop-gateway'].every(alive);
    const publish = (next = state, reason = reasonCode) => {
        if (stopping && !['stopping', 'stopped', 'failed'].includes(next)) return;
        const changed = next !== state; state = next; reasonCode = reason;
        const live = !stopping && alive('bridge') && alive('gateway') && health.bridgeUp && (config.mode === 'bridge' || alive('game') && alive('display') && alive('window-manager') && health.modConnected);
        const status = { schemaVersion: 1, generation, startNonce, supervisorPid: process.pid, mode: config.mode, state, live,
            modConnected: health.modConnected, saveLoaded: health.saveLoaded, desktopEnabled: config.desktopEnabled,
            desktopAvailable: desktopAvailable(), desktopBaseUrl: config.desktopBase?.baseUrl ?? null,
            reasonCode: desktopDegraded && READY_STATES.has(state) ? 'DESKTOP_DEGRADED' : reasonCode,
            updatedAt: isoNow() };
        (deps.writeStatus ?? writeStatusFile)(files.status, status);
        if (changed) log('info', `状态 → ${state}`);
        return status;
    };
    const signalChild = (entry, signal) => {
        if (!entry || entry.exited) return;
        try {
            if (entry.group && typeof entry.child.pid === 'number') process.kill(-entry.child.pid, signal);
            else entry.child.kill(signal);
        } catch (error) { if (error.code !== 'ESRCH') log('warn', `无法发送 ${signal} 到本次子进程 ${entry.name}。`); }
    };
    const start = (name, command, args, { critical = true, env = process.env, cwd } = {}) => {
        if (stopRequested || stopping) throw new Error('STOP_REQUESTED');
        const group = !deps.spawn && process.platform === 'linux';
        const child = (deps.spawn ?? spawn)(command, args, { shell: false, detached: group, stdio: ['pipe', 'pipe', 'pipe'], env, ...(cwd ? { cwd } : {}) });
        const entry = { name, child, critical, group, exited: false };
        children.push(entry);
        child.stdout?.on('data', chunk => process.stdout.write(`[${name}] ${chunk}`));
        child.stderr?.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
        const exited = () => {
            entry.exited = true;
            if (stopping) return;
            if (!critical) { desktopDegraded = true; publish(); log('warn', `${name} 已退出，游戏继续运行。`); return; }
            exitCode ||= name === 'game' && health.saveLoaded ? EXIT.UNSAVED_PROGRESS_POSSIBLE : EXIT.CHILD_EXITED;
            reasonCode = `${name.toUpperCase().replaceAll('-', '_')}_EXITED`; stopRequested = true;
            void shutdown(reasonCode);
        };
        child.once('exit', exited); child.once('error', exited);
        return entry;
    };
    const waitUntil = async (predicate, deadline, label) => {
        while (now() < deadline) {
            if (stopRequested || stopping) throw new Error('STOP_REQUESTED');
            if (await predicate()) return;
            await sleep(100);
        }
        const error = new Error(`${label}_TIMEOUT`); error.code = EXIT.START_TIMEOUT; throw error;
    };
    const shutdown = reason => {
        if (shutdownPromise) return shutdownPromise;
        stopping = true; stopRequested = true;
        shutdownPromise = (async () => {
            publish('stopping', reason);
            const deadline = now() + config.shutdownTimeoutMs;
            let forced = false;
            for (const name of ['gateway', 'bridge', 'game', 'desktop-gateway', 'websockify', 'vnc', 'window-manager', 'display']) {
                const entry = children.find(child => child.name === name);
                if (!entry || entry.exited) continue;
                signalChild(entry, 'SIGTERM');
                const grace = Math.min(name === 'bridge' ? 12_000 : name === 'game' ? 15_000 : 1_000, Math.max(0, deadline - now() - 500));
                const stageEnd = now() + grace;
                while (!entry.exited && now() < stageEnd) await sleep(50);
                if (!entry.exited) { forced = true; signalChild(entry, 'SIGKILL'); }
            }
            const startedGame = children.some(child => child.name === 'game');
            const unsavedProgressPossible = config.mode === 'game' && startedGame && (health.saveLoaded || !health.modConnected);
            const record = { schemaVersion: 1, generation, startNonce, reason, stoppedAt: isoNow(), gamePhase: health.saveLoaded ? 'in_world' : health.modConnected ? 'title_or_menu' : 'unknown',
                forcedKill: forced, unsavedProgressPossible, note: '停机不等于游戏保存；没有执行强制存档。' };
            (deps.writeStopRecord ?? atomicWriteJson)(files.stop, record);
            if (unsavedProgressPossible && !exitCode) exitCode = EXIT.UNSAVED_PROGRESS_POSSIBLE;
            publish(exitCode ? 'failed' : 'stopped', exitCode ? reasonCode : 'STOPPED');
            return record;
        })();
        return shutdownPromise;
    };
    const requestStop = (reason = 'SIGTERM') => { stopRequested = true; return shutdown(reason); };
    const run = async () => {
        try {
            (deps.mkdir ?? mkdirSync)(path.dirname(files.status), { recursive: true, mode: 0o700 });
            (deps.claimVolume ?? claimVolume)(config.home);
            (deps.writeIdentity ?? atomicWriteJson)(path.join(path.dirname(files.status), 'identity.json'), { generation, startNonce, pid: process.pid, processStart: processStartToken() });
            publish('preflight', 'PREFLIGHT');
            ticker = setInterval(() => { try { publish(); } catch { exitCode = 16; void requestStop('STATUS_WRITE_FAILED'); } }, 5000);
            ticker.unref();
            const pre = (deps.preflight ?? runPreflight)(config);
            if (!pre.ok) { const error = new Error(pre.code); error.code = pre.exitCode; throw error; }
            let seed;
            if (config.mode === 'game') {
                publish('preparing_workdir', 'PREPARING_WORKDIR');
                seed = (deps.seed ?? prepareWorkdir)(config);
                if (!seed.ok) { const error = new Error(seed.reasonCode); error.code = seed.exitCode; throw error; }
            }
            const deadline = now() + config.startupTimeoutMs;
            publish('starting_bridge', 'STARTING_BRIDGE');
            start('bridge', layout.node, [files.bridgeEntry, 'start', '--port', String(config.ports.bridgeInternal), '--data-dir', config.home], { env: { ...process.env, SAB_HOME: config.home, SAB_WEB_DIST: config.webDist, SAB_PUBLIC_BASE_URL: config.publicBase.baseUrl, SAB_LOG_LEVEL: config.logLevel } });
            await waitUntil(async () => { health = await probe({ port: config.ports.bridgeInternal }); return health.bridgeUp; }, deadline, 'BRIDGE_START');
            publish('starting_gateway', 'STARTING_GATEWAY');
            start('gateway', layout.node, [files.gatewayEntry], { env: { ...process.env, SAB_PUBLIC_BASE_URL: config.publicBase.baseUrl, SAB_HTTP_PORT: String(config.httpPort), SAB_RUN_MODE: config.mode,
                SAB_GATEWAY_STATUS_FILE: files.status, SAB_GATEWAY_GENERATION: generation, SAB_GATEWAY_START_NONCE: startNonce } });
            await waitUntil(() => (deps.probeGateway ?? probeGateway)({ port: config.ports.gatewayInternal, host: `127.0.0.1:${config.httpPort}` }), deadline, 'GATEWAY_START');
            if (config.mode === 'game') {
                publish('starting_display', 'STARTING_DISPLAY');
                const authority = path.join(layout.run, 'Xauthority');
                (deps.writeAuthority ?? atomicWriteFile)(authority, makeXauthority());
                const displayEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: layout.gameHome, DISPLAY: ':99', XAUTHORITY: authority, LANG: 'C.UTF-8',
                    LIBGL_ALWAYS_SOFTWARE: '1', ALSOFT_DRIVERS: 'null', SDL_AUDIODRIVER: 'dummy', XDG_DATA_HOME: `${layout.gameHome}/.local/share`, XDG_CONFIG_HOME: `${layout.gameHome}/.config` };
                start('display', '/usr/bin/Xvfb', [':99', '-screen', '0', `${config.displaySize}x24`, '-nolisten', 'tcp', '-auth', authority], { env: displayEnv });
                await waitUntil(() => deps.displayReady ? deps.displayReady() : spawnSync('/usr/bin/xdpyinfo', ['-display', ':99'], { env: displayEnv, stdio: 'ignore', timeout: 1000 }).status === 0, deadline, 'DISPLAY_START');
                start('window-manager', '/usr/bin/openbox', ['--sm-disable'], { env: displayEnv });
                const descriptor = defaultGameDescriptor(seed.current);
                const checked = (deps.validateDescriptor ?? validateGameDescriptor)(descriptor, { workRoot: seed.current });
                if (!checked.ok) { const error = new Error('GAME_DESCRIPTOR_INVALID'); error.code = 10; throw error; }
                publish('starting_game', 'STARTING_GAME');
                start('game', descriptor.executable, descriptor.argv, { cwd: descriptor.cwd, env: { ...displayEnv, SAB_HOME: config.home, SMAPI_USE_CURRENT_SHELL: 'true', SMAPI_MODS_PATH: path.join(seed.current, 'Mods') } });
                publish('awaiting_mod', 'AWAITING_MOD');
                await waitUntil(async () => { health = await probe({ port: config.ports.bridgeInternal }); return health.bridgeUp && health.modConnected; }, deadline, 'MOD_HELLO');
                const expectedMod = (deps.readModManifest ?? readJsonIfExists)(path.join(config.modArtifacts, 'manifest.json'));
                if (!health.instanceId || expectedMod?.Version !== health.modVersion) { const error = new Error('MOD_IDENTITY_MISMATCH'); error.code = 10; throw error; }
                if (config.desktopEnabled) {
                    start('vnc', '/usr/bin/x11vnc', ['-display', ':99', '-auth', authority, '-localhost', '-rfbport', '5900', '-passwdfile', config.vncPasswordFile, '-forever', '-shared', '-nosel'], { critical: false, env: displayEnv });
                    start('websockify', '/usr/bin/websockify', ['--web', '/usr/share/novnc', '127.0.0.1:6081', '127.0.0.1:5900'], { critical: false, env: displayEnv });
                    start('desktop-gateway', layout.node, [path.join(layout.container, 'desktop-gateway.mjs')], { critical: false, env: { ...displayEnv, SAB_NOVNC_PORT: String(config.novncPort) } });
                }
            }
            publish(config.mode === 'bridge' ? 'bridge_ready' : health.saveLoaded ? 'ready' : 'awaiting_save', config.mode === 'bridge' ? 'BRIDGE_READY' : health.saveLoaded ? 'READY' : 'AWAITING_SAVE');
            while (!stopRequested) {
                await sleep(2000);
                if (stopRequested) break;
                health = await probe({ port: config.ports.bridgeInternal });
                if (!health.bridgeUp || config.mode === 'game' && !health.modConnected) { exitCode = EXIT.CHILD_EXITED; reasonCode = 'HEALTH_LOST'; stopRequested = true; break; }
                publish(config.mode === 'bridge' ? 'bridge_ready' : health.saveLoaded ? 'ready' : 'awaiting_save', config.mode === 'bridge' ? 'BRIDGE_READY' : health.saveLoaded ? 'READY' : 'AWAITING_SAVE');
            }
        } catch (error) {
            if (error.message !== 'STOP_REQUESTED') { exitCode ||= error.code ?? EXIT.CHILD_EXITED; reasonCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'START_FAILED'; log('error', reasonCode); }
        } finally { clearInterval(ticker); await shutdown(reasonCode); }
        return { ok: exitCode === 0, exitCode, reasonCode, state };
    };
    return { run, shutdown, requestStop, get state() { return state; }, generation, startNonce, _children: children };
}
export async function main(argv = process.argv.slice(2)) {
    const index = argv.indexOf('--mode');
    const parsed = parseContainerConfig(process.env, { mode: index >= 0 ? argv[index + 1] : undefined });
    if (!parsed.ok) return parsed.exitCode;
    process.umask(0o077);
    const supervisor = createSupervisor({ config: parsed.config });
    const term = () => void supervisor.requestStop('SIGTERM'), int = () => void supervisor.requestStop('SIGINT');
    process.on('SIGTERM', term); process.on('SIGINT', int);
    try { return (await supervisor.run()).exitCode; }
    finally { process.off('SIGTERM', term); process.off('SIGINT', int); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 16; });
