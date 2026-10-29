import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';
import { acquireInstanceLock } from '@sab/server';

describe('跨进程锁竞争', () => {
    for (const stale of [false, true]) {
        it(stale ? '八进程同时接管死亡 owner，仅一个成功' : '八进程同时首次启动，仅一个成功', { timeout: 30_000 }, async () => {
            const root = mkdtempSync(path.join(os.tmpdir(), 'sab-real-lock-'));
            const children: ReturnType<typeof fork>[] = [];
            try {
                if (stale) {
                    const old = { schemaVersion: 1, pid: 987654, nonce: 'dead-owner', processStart: null, dataRoot: root };
                    writeFileSync(path.join(root, 'bridge.lock'), JSON.stringify(old));
                    mkdirSync(path.join(root, 'bridge.lock.owners'));
                    writeFileSync(path.join(root, 'bridge.lock.owners', '987654-dead-owner.json'), JSON.stringify(old));
                }
                const workers = Array.from({ length: 8 }, () => {
                    const child = fork(path.join(import.meta.dirname, 'lock-worker.js'), [root], { silent: true });
                    children.push(child);
                    child.stdout?.resume(); child.stderr?.resume();
                    let ready!: () => void;
                    let done!: (value: { acquired: boolean; reason?: string; message?: string }) => void;
                    const started = new Promise<void>(resolve => { ready = resolve; });
                    const result = new Promise<{ acquired: boolean; reason?: string; message?: string }>((resolve, reject) => {
                        done = resolve;
                        child.on('error', reject);
                        child.on('exit', code => { if (code) reject(new Error('Lock worker exited: ' + code)); });
                    });
                    child.on('message', (value: unknown) => {
                        const message = value as { event: string; acquired: boolean; reason?: string; message?: string };
                        if (message.event === 'ready') ready();
                        if (message.event === 'result') done(message);
                    });
                    return { child, started, result };
                });
                await Promise.all(workers.map(w => w.started));
                for (const w of workers) w.child.send('start');
                const results = await Promise.all(workers.map(w => w.result));
                assert.equal(results.filter(result => result.acquired).length, 1, '竞争结果：' + JSON.stringify(results));
            } finally {
                await Promise.all(children.map(child => new Promise<void>(resolve => {
                    if (child.exitCode !== null) return resolve();
                    child.once('exit', () => resolve()); child.kill();
                })));
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
    it('尚未写完的诊断锁不被当作陈旧记录删除', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'sab-lock-partial-'));
        const file = path.join(root, 'bridge.lock');
        try {
            writeFileSync(file, '{');
            const result = acquireInstanceLock({ lockPath: file, dataRoot: root, programVersion: '0.1.0' });
            assert.equal(result.acquired, false);
            assert.equal(readFileSync(file, 'utf8'), '{');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
