import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ctxOf, startStack } from './helpers.js';

const entry = path.resolve(import.meta.dirname, '../../../apps/server/dist/cli.js');
function cli(root: string, args: string[]) {
    return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [entry, ...args, '--data-dir', root], {
            env: { ...process.env, SAB_HOME: root }, timeout: 15_000, windowsHide: true
        }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }));
    });
}

describe('CLI 实际进程与账本隔离', () => {
    it('离线 doctor 不创建数据目录或凭据', async () => {
        const area = mkdtempSync(path.join(os.tmpdir(), 'sab-cli-readonly-'));
        const root = path.join(area, '尚未初始化');
        try {
            const result = await cli(root, ['doctor', '--json', '--game-path', path.join(area, 'no-game')]);
            assert.equal(result.code, 1);
            assert.equal(JSON.parse(result.stdout).command, 'doctor');
            assert.equal(existsSync(root), false);
        } finally { rmSync(area, { recursive: true, force: true }); }
    });

    it('控制期间 doctor、launch 和端口冲突均不关闭持久化会话或改变收据', async () => {
        const s = await startStack();
        const db = new DatabaseSync(path.join(s.dataDir, 'ledger.sqlite'), { readOnly: true });
        try {
            const session = await s.bridge.actions.executeTool('stardew_session', { operation: 'start', mode: 'step' }, ctxOf(s));
            assert.equal(session.isError, false, session.text);
            await s.bridge.actions.executeTool('stardew_select', { slot: 1, actionId: 'cli-readonly-action' }, ctxOf(s));
            const sessionRows = () => JSON.stringify(db.prepare('SELECT control_session_id, state, lease_epoch, closed_at, close_reason, world_generation FROM sessions').all());
            const before = sessionRows();
            const receipt = JSON.stringify(s.bridge.ledger.findById('cli-readonly-action'));
            const credentials = readFileSync(path.join(s.dataDir, 'credentials.json'), 'utf8');
            const doctor = await cli(s.dataDir, ['doctor', '--json', '--game-path', path.join(s.dataDir, 'no-game')]);
            assert.equal(JSON.parse(doctor.stdout).instance.healthOk, true);
            const launch = await cli(s.dataDir, ['launch', '--no-open', '--json']);
            assert.equal(launch.code, 0, launch.stderr);
            assert.equal(JSON.parse(launch.stdout).reused, true);
            const conflict = await cli(s.dataDir, ['start', '--port', String(s.bridgePort)]);
            assert.equal(conflict.code, 2, conflict.stderr);
            assert.equal(sessionRows(), before);
            assert.equal(JSON.stringify(s.bridge.ledger.findById('cli-readonly-action')), receipt);
            assert.equal(readFileSync(path.join(s.dataDir, 'credentials.json'), 'utf8'), credentials);
            assert.equal(s.mod.commandCount('select'), 1);
        } finally { db.close(); await s.stop(); }
    });
});
