#!/usr/bin/env node
/** Lightweight read-only health probe. No credential issuance, database open, or lock acquisition. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './config.mjs';
import { readJsonIfExists, processStartToken } from './lib.mjs';
export const HEALTH_MAX_AGE_MS = 30_000;
function probeLive({ port, host }) {
    return new Promise(resolve => {
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        const req = http.get({ host: '127.0.0.1', port, path: '/container/live', timeout: 1500, headers: { host } }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
            res.on('end', () => { try { finish({ status: res.statusCode, payload: JSON.parse(body) }); } catch { finish({ status: 0 }); } });
            res.on('aborted', () => finish({ status: 0 })); res.on('error', () => finish({ status: 0 }));
        });
        req.on('timeout', () => req.destroy()); req.on('error', () => finish({ status: 0 }));
    });
}
export async function evaluate({ env = process.env, deps = {} } = {}) {
    const file = env.SAB_GATEWAY_STATUS_FILE ?? '/run/sab/status.json';
    const status = (deps.readJson ?? readJsonIfExists)(file);
    const identity = (deps.readIdentity ?? readJsonIfExists)(path.join(path.dirname(file), 'identity.json'));
    const bad = reason => ({ healthy: false, reason, detail: reason });
    if (!status || !identity || status.schemaVersion !== 1) return bad('STATUS_MISSING');
    if (!identity.generation || !identity.startNonce || status.generation !== identity.generation || status.startNonce !== identity.startNonce) return bad('GENERATION_MISMATCH');
    const alive = deps.isSupervisorAlive ?? (value => Number.isInteger(value.pid) && value.pid > 0 && value.processStart && processStartToken(value.pid) === value.processStart);
    if (!alive(identity)) return bad('SUPERVISOR_NOT_ALIVE');
    const age = (deps.now?.() ?? Date.now()) - Date.parse(status.updatedAt);
    if (!Number.isFinite(age) || age < -5000 || age > HEALTH_MAX_AGE_MS) return bad('STATUS_STALE');
    const mode = env.SAB_RUN_MODE ?? 'bridge';
    if (mode !== status.mode || status.live !== true || !['ready', 'awaiting_save', 'bridge_ready'].includes(status.state)) return bad('NOT_LIVE');
    if (mode === 'game' && status.modConnected !== true) return bad('MOD_NOT_CONNECTED');
    const live = await (deps.probeLive ?? probeLive)({ port: PORTS.gatewayInternal, host: `127.0.0.1:${env.SAB_HTTP_PORT ?? 17655}` });
    if (live.status !== 200 || live.payload?.live !== true || live.payload.mode !== mode || live.payload.state !== status.state) return bad('GATEWAY_NOT_READY');
    return { healthy: true, reason: status.desktopEnabled && !status.desktopAvailable ? 'DESKTOP_DEGRADED' : 'OK', detail: `mode=${mode} state=${status.state}` };
}
export async function main(argv = process.argv.slice(2)) {
    const result = await evaluate();
    process.stdout.write(argv.includes('--json') ? JSON.stringify(result) + '\n' : `${result.healthy ? 'healthy' : 'unhealthy'}: ${result.reason}\n`);
    return result.healthy ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
