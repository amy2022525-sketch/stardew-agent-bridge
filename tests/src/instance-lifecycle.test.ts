/**
 * 单实例与启动复用测试。
 *
 * 覆盖交接书里最容易错的几件事：
 * - 同一数据根只允许一个业务实例（原子锁），第二个实例明确失败而不是静默并存；
 * - 陈旧锁（进程已退出 / PID 被复用）可以被接管，不需要手动删文件；
 * - 复用判定只靠 endpoint + `/health` 只读探测，绝不构造第二个 Bridge；
 * - 启动超时、端口冲突、活锁未就绪这三种失败原因必须可区分。
 *
 * 全程不启动真实 Bridge、不占用固定端口、不写用户数据目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
    acquireInstanceLock,
    dataPaths,
    findExistingInstance,
    isInstanceLockStale,
    launchBridge,
    probeHealth,
    readEndpoint,
    readInstanceLock,
    type LaunchDeps
} from '@sab/server';

const areas: string[] = [];

function tempRoot(label: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sab-lock-${label}-`));
    areas.push(dir);
    return dir;
}

after(() => {
    for (const dir of areas) rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
    return {
        platform: 'linux',
        env: { DISPLAY: '' },
        homeDir: '/home/player',
        cwd: '/opt/app',
        execPath: '/usr/bin/node',
        cliEntry: '/opt/app/server/bridge.mjs',
        now: () => Date.now(),
        sleep: async () => {},
        log: () => {},
        ...overrides
    };
}

function writeLock(root: string, record: Record<string, unknown>): string {
    const paths = dataPaths(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(paths.lock, `${JSON.stringify(record, null, 2)}\n`);
    return paths.lock;
}

/**
 * 伪造一个 `/proc`：`<root>/<pid>/stat` 的第 22 个字段就是 starttime。
 * 这样「PID 复用」判定在 Windows 上也能复现，而不依赖真实 /proc。
 */
function fakeProc(label: string, entries: Array<{ pid: number; startTime: string }>): string {
    const root = path.join(tempRoot(label), 'proc');
    mkdirSync(root, { recursive: true });
    for (const entry of entries) {
        mkdirSync(path.join(root, String(entry.pid)), { recursive: true });
        const fields = [
            'S', '1', '1', '1', '0', '-1', '4194304', '0', '0', '0', '0', '0',
            '0', '0', '0', '20', '0', '1', '0', entry.startTime, '0', '0'
        ];
        writeFileSync(path.join(root, String(entry.pid), 'stat'), `${entry.pid} (node) ${fields.join(' ')}\n`);
    }
    return root;
}

describe('实例锁', () => {
    it('首次获取成功并写出可诊断的记录', () => {
        const root = tempRoot('acquire');
        const paths = dataPaths(root);
        const result = acquireInstanceLock({ lockPath: paths.lock, dataRoot: root, programVersion: '0.1.0' });
        assert.equal(result.acquired, true);
        if (!result.acquired) return;
        const record = readInstanceLock(paths.lock);
        assert.ok(record);
        assert.equal(record.pid, process.pid);
        assert.equal(record.dataRoot, root);
        assert.equal(record.programVersion, '0.1.0');
        assert.equal(record.schemaVersion, 1);
        assert.ok(record.nonce.length > 0);
        assert.equal(result.handle.stillOwned(), true);
        result.handle.release();
        assert.equal(readInstanceLock(paths.lock), null);
    });

    it('同一数据根第二次获取被拒绝（held），不会删掉别人的锁', () => {
        const root = tempRoot('held');
        const paths = dataPaths(root);
        const first = acquireInstanceLock({ lockPath: paths.lock, dataRoot: root, programVersion: '0.1.0' });
        assert.equal(first.acquired, true);
        const second = acquireInstanceLock({ lockPath: paths.lock, dataRoot: root, programVersion: '0.1.0' });
        assert.equal(second.acquired, false);
        if (second.acquired) return;
        assert.equal(second.reason, 'held');
        assert.equal(second.record?.pid, process.pid);
        assert.ok(second.message.includes('只允许一个实例'));
        if (first.acquired) first.handle.release();
    });

    it('启动时刻一致时不算陈旧（不能只凭 PID 判活或判死）', () => {
        const root = tempRoot('same-start');
        const procRoot = fakeProc('same-start', [{ pid: process.pid, startTime: '424242' }]);
        const lockPath = writeLock(root, {
            schemaVersion: 1,
            pid: process.pid,
            nonce: 'live-owner',
            dataRoot: root,
            programVersion: '0.1.0',
            entry: '',
            startedAt: new Date().toISOString(),
            processStart: '424242'
        });
        const record = readInstanceLock(lockPath);
        assert.ok(record);
        assert.equal(isInstanceLockStale(record, { platform: 'linux', procRoot }), false);
        const second = acquireInstanceLock({ lockPath, dataRoot: root, programVersion: '0.1.0', deps: { platform: 'linux', procRoot } });
        assert.equal(second.acquired, false);
        if (!second.acquired) assert.equal(second.reason, 'held');
    });

    it('PID 被复用（启动时刻不同）时视为陈旧锁并接管', () => {
        const root = tempRoot('reuse');
        const procRoot = fakeProc('reuse', [{ pid: process.pid, startTime: '424242' }]);
        const lockPath = writeLock(root, {
            schemaVersion: 1,
            pid: process.pid,
            nonce: 'from-dead-process',
            dataRoot: root,
            programVersion: '0.0.9',
            entry: '/old/entry.js',
            startedAt: new Date(0).toISOString(),
            processStart: '111111'
        });
        const stale = readInstanceLock(lockPath);
        assert.ok(stale);
        assert.equal(isInstanceLockStale(stale, { platform: 'linux', procRoot }), true);
        const acquired = acquireInstanceLock({
            lockPath,
            dataRoot: root,
            programVersion: '0.1.0',
            deps: { platform: 'linux', procRoot }
        });
        assert.equal(acquired.acquired, true, '陈旧锁必须能被接管');
        if (acquired.acquired) {
            assert.notEqual(acquired.handle.record.nonce, 'from-dead-process');
            assert.equal(acquired.handle.record.processStart, '424242');
            acquired.handle.release();
        }
    });

    it('持有者进程不存在时视为陈旧锁', () => {
        const root = tempRoot('dead');
        const procRoot = fakeProc('dead', []);
        const lockPath = writeLock(root, {
            schemaVersion: 1,
            pid: 987654,
            nonce: 'dead',
            dataRoot: root,
            programVersion: '0.0.9',
            entry: '',
            startedAt: new Date(0).toISOString(),
            processStart: '123'
        });
        const record = readInstanceLock(lockPath);
        assert.ok(record);
        assert.equal(isInstanceLockStale(record, { platform: 'linux', procRoot }), true);
        const acquired = acquireInstanceLock({
            lockPath,
            dataRoot: root,
            programVersion: '0.1.0',
            deps: { platform: 'linux', procRoot }
        });
        assert.equal(acquired.acquired, true);
        if (acquired.acquired) acquired.handle.release();
    });

    it('释放只删除属于自己的锁：别人写入新锁后本句柄不再自称持有', () => {
        const root = tempRoot('release');
        const paths = dataPaths(root);
        const first = acquireInstanceLock({ lockPath: paths.lock, dataRoot: root, programVersion: '0.1.0' });
        assert.equal(first.acquired, true);
        if (!first.acquired) return;
        writeFileSync(
            paths.lock,
            `${JSON.stringify({ schemaVersion: 1, pid: 4242, nonce: 'other', dataRoot: root, programVersion: '0.2.0' })}\n`
        );
        assert.equal(first.handle.stillOwned(), false);
        first.handle.release();
        const still = readInstanceLock(paths.lock);
        assert.ok(still, '不得删除其他实例刚写入的锁');
        assert.equal(still.nonce, 'other');
    });

    it('损坏的锁文件不会永久阻塞启动', () => {
        const root = tempRoot('broken');
        const paths = dataPaths(root);
        writeFileSync(paths.lock, '{ not json');
        const old = new Date(Date.now() - 20_000);
        utimesSync(paths.lock, old, old);
        assert.equal(readInstanceLock(paths.lock), null);
        const acquired = acquireInstanceLock({ lockPath: paths.lock, dataRoot: root, programVersion: '0.1.0' });
        assert.equal(acquired.acquired, true);
        if (acquired.acquired) acquired.handle.release();
    });
});

async function withHealthServer(
    handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
    run: (port: number) => Promise<void>
): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        await run(port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe('健康探测（只读）', () => {
    it('返回 ok 与存档状态字段', async () => {
        await withHealthServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ok: true,
                        bridgeVersion: '0.1.0',
                        modConnected: true,
                        saveLoaded: true,
                        gameVersion: '1.6.15'
                    })
                );
            },
            async (port) => {
                const health = await probeHealth(port, deps());
                assert.ok(health);
                assert.equal(health.bridgeVersion, '0.1.0');
                assert.equal(health.modConnected, true);
                assert.equal(health.saveLoaded, true);
                assert.equal(health.gameVersion, '1.6.15');
            }
        );
    });

    it('没有 Mod 连接时 saveLoaded 为 null（不假装知道存档状态）', async () => {
        await withHealthServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: true, bridgeVersion: '0.1.0', modConnected: false, saveLoaded: null }));
            },
            async (port) => {
                const health = await probeHealth(port, deps());
                assert.ok(health);
                assert.equal(health.saveLoaded, null);
                assert.equal(health.gameVersion, null);
            }
        );
    });

    it('返回 ok=false 或连接失败时判定为不可用', async () => {
        await withHealthServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: false }));
            },
            async (port) => {
                assert.equal(await probeHealth(port, deps()), null);
            }
        );
    });
});

describe('启动与复用', () => {
    it('已有健康实例时复用，不再 spawn 子进程', async () => {
        const root = tempRoot('reuse-launch');
        const paths = dataPaths(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(paths.endpoint, `${JSON.stringify({ port: 43111, mcpUrl: 'http://127.0.0.1:43111/mcp', dataRoot: root })}\n`);
        let spawned = 0;
        const result = await launchBridge(
            { dataDir: root, open: false, programVersion: '0.1.0' },
            deps({
                fetchImpl: async (url) => {
                    assert.ok(url.includes('43111'));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, bridgeVersion: '0.1.0', modConnected: false, dataRoot: root }),
                        text: async () => ''
                    };
                },
                spawnProcess: () => {
                    spawned += 1;
                    throw new Error('不应该 spawn');
                }
            })
        );
        assert.equal(result.code, 0);
        assert.equal(result.reused, true);
        assert.equal(result.started, false);
        assert.equal(result.port, 43111);
        assert.equal(spawned, 0);
    });

    it('活锁但端口未就绪 → code 2 INSTANCE_CONFLICT，不抢锁', async () => {
        const root = tempRoot('conflict');
        mkdirSync(root, { recursive: true });
        const procRoot = fakeProc('conflict', [{ pid: process.pid, startTime: '515151' }]);
        writeLock(root, {
            schemaVersion: 1,
            pid: process.pid,
            nonce: 'live',
            dataRoot: root,
            programVersion: '0.1.0',
            startedAt: new Date().toISOString(),
            processStart: '515151'
        });
        const result = await launchBridge(
            { dataDir: root, open: false, timeoutMs: 50, pollIntervalMs: 1, programVersion: '0.1.0' },
            deps({
                procRoot,
                fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })
            })
        );
        assert.equal(result.code, 2);
        assert.equal(result.problemCode, 'INSTANCE_CONFLICT');
        assert.equal(result.started, false);
        assert.ok(result.problems.some((line) => line.includes('持锁')));
    });

    it('启动成功：子进程写 endpoint 后判定就绪', async () => {
        const root = tempRoot('started');
        const paths = dataPaths(root);
        mkdirSync(root, { recursive: true });
        let spawned = 0;
        const result = await launchBridge(
            { dataDir: root, open: false, timeoutMs: 5_000, pollIntervalMs: 1, programVersion: '0.1.0' },
            deps({
                fetchImpl: async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, bridgeVersion: '0.1.0', modConnected: false, dataRoot: root }),
                    text: async () => ''
                }),
                spawnProcess: (command, args) => {
                    spawned += 1;
                    assert.equal(command, '/usr/bin/node');
                    assert.ok(args.includes('start'));
                    writeFileSync(paths.endpoint, `${JSON.stringify({ port: 43222, dataRoot: root })}\n`);
                    return {
                        pid: 1234,
                        exitCode: null,
                        onExit: () => {},
                        unref: () => {},
                        kill: () => true
                    };
                }
            })
        );
        assert.equal(spawned, 1);
        assert.equal(result.code, 0);
        assert.equal(result.started, true);
        assert.equal(result.reused, false);
        assert.equal(result.port, 43222);
        assert.equal(readEndpoint(paths.endpoint)?.port, 43222);
    });

    it('启动超时 → code 1 START_FAILED，并给出日志路径', async () => {
        const root = tempRoot('timeout');
        mkdirSync(root, { recursive: true });
        let clock = 0;
        const result = await launchBridge(
            { dataDir: root, open: false, timeoutMs: 300, pollIntervalMs: 1, programVersion: '0.1.0' },
            deps({
                now: () => (clock += 100),
                fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
                spawnProcess: () => ({ pid: 1, exitCode: null, onExit: () => {}, unref: () => {}, kill: () => true })
            })
        );
        assert.equal(result.code, 1);
        assert.equal(result.problemCode, 'START_FAILED');
        assert.ok(result.problems.some((line) => line.includes('bridge.log')));
    });

    it('子进程以 2 退出（端口/实例冲突）→ code 2 PORT_CONFLICT', async () => {
        const root = tempRoot('portconflict');
        mkdirSync(root, { recursive: true });
        const result = await launchBridge(
            { dataDir: root, open: false, timeoutMs: 500, pollIntervalMs: 1, programVersion: '0.1.0' },
            deps({
                fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
                spawnProcess: () => ({
                    pid: 1,
                    exitCode: 2,
                    onExit: (callback: (code: number | null) => void) => callback(2),
                    unref: () => {},
                    kill: () => true
                })
            })
        );
        assert.equal(result.code, 2);
        assert.equal(result.problemCode, 'PORT_CONFLICT');
    });
});

describe('endpoint 归属', () => {
    it('旧 endpoint 指向其他实例时，不仅凭 ok=true 就复用', async () => {
        const root = tempRoot('foreign-health');
        const paths = dataPaths(root);
        writeFileSync(paths.endpoint, JSON.stringify({ port: 43999, dataRoot: root, pid: 1234 }));
        const found = await findExistingInstance(paths, root, deps({ fetchImpl: async () => ({
            ok: true, status: 200, text: async () => '',
            json: async () => ({ ok: true, bridgeVersion: '0.1.0', dataRoot: root, pid: 9999 })
        }) }));
        assert.equal(found, null);
    });
    it('endpoint 指向别的数据根时不当作同一实例', async () => {
        const root = tempRoot('other-root');
        const paths = dataPaths(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(paths.endpoint, `${JSON.stringify({ port: 43999, dataRoot: '/somewhere/else' })}\n`);
        const found = await findExistingInstance(
            paths,
            root,
            deps({
                fetchImpl: async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, bridgeVersion: '0.1.0', modConnected: false }),
                    text: async () => ''
                })
            })
        );
        assert.equal(found, null);
    });

    it('endpoint 缺少 port 时被忽略，不会误判', () => {
        const root = tempRoot('bad-endpoint');
        const paths = dataPaths(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(paths.endpoint, JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
        assert.equal(readEndpoint(paths.endpoint), null);
        assert.ok(readFileSync(paths.endpoint, 'utf8').includes('mcpUrl'));
    });
});
