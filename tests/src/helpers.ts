/**
 * 测试脚手架：真实启动 Bridge（随机端口）+ 模拟 Mod。
 * 注意：这些测试验证 Bridge 契约与状态机，不代表真实游戏验收。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '@sab/server';
import { Logger } from '@sab/server';
import { dataPaths } from '@sab/server';
import { MockMod } from './mock-mod.js';
import type { MultiplayerStatus } from '@sab/contracts';

/** 取一个空闲端口：先占用再释放，交给模拟 Mod 监听。 */
async function freePort(): Promise<number> {
    // Some Windows hosts allocate only low ephemeral ports. Explicitly request a
    // fetch-safe port instead of repeatedly asking for port 0 without a bound.
    for (let attempt = 0; attempt < 32; attempt += 1) {
        try {
            return await new Promise<number>((resolve, reject) => {
                const server = createServer();
                server.once('error', reject);
                server.listen(randomInt(20000, 60000), '127.0.0.1', () => {
                    const address = server.address();
                    const port = typeof address === 'object' && address ? address.port : 0;
                    server.close(error => error ? reject(error) : resolve(port));
                });
            });
        } catch (error) {
            // Windows may reserve a port range and reject it with EACCES.
            // Skip that candidate too; all other errors still fail immediately.
            if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
    }
    throw new Error('Unable to reserve a test port after 32 attempts.');
}

export interface Stack {
    bridge: Bridge;
    mod: MockMod;
    dataDir: string;
    modPort: number;
    bridgePort: number;
    token: string;
    clientId: string;
    stop: () => Promise<void>;
}

export async function startStack(options: {
    saveLoaded?: boolean;
    leaseTtlMs?: number;
    clientId?: string;
    modPort?: number;
    /** 制造“账本不可写”：把 ledger.sqlite 建成目录。 */
    breakLedger?: boolean;
    multiplayer?: MultiplayerStatus;
} = {}): Promise<Stack> {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sab-test-'));
    const paths = dataPaths(dataDir);
    const logger = new Logger({ level: 'error', paths, console: false });
    if (options.breakLedger) {
        mkdirSync(paths.ledger, { recursive: true });
    }

    // 先建 Bridge（此刻还没连接），拿到它生成的 Mod 令牌，再让模拟 Mod 用同一令牌监听。
    const reservedPort = options.modPort ?? (await freePort());
    const bridge = new Bridge({
        dataDir,
        logger,
        configOverride: {
            bridgePort: await freePort(),
            modPort: reservedPort,
            leaseTtlMs: options.leaseTtlMs ?? 180_000,
            logLevel: 'error'
        }
    });
    const mod = new MockMod({
        token: bridge.auth.modToken,
        port: reservedPort,
        saveLoaded: options.saveLoaded ?? true
    });
    mod.multiplayer = options.multiplayer ?? null;
    const modPort = await mod.start();

    const bridgePort = await bridge.start();
    const clientId = options.clientId ?? 'tester';
    const credential = bridge.auth.issue(clientId, 'Tester');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !bridge.mod.connected) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!bridge.mod.connected) {
        await bridge.stop();
        await mod.stop();
        throw new Error('模拟 Mod 未完成握手');
    }

    return {
        bridge,
        mod,
        dataDir,
        modPort,
        bridgePort,
        token: credential.token,
        clientId,
        stop: async () => {
            await bridge.stop();
            await mod.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    };
}

export function ctxOf(stack: Stack, clientId?: string) {
    const id = clientId ?? stack.clientId;
    return { clientId: id, clientName: id === 'tester' ? 'Tester' : id, transport: 'http' as const };
}

export function textOf(result: { text: string }): string {
    return result.text;
}
