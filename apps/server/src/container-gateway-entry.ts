#!/usr/bin/env node
/**
 * 容器网关独立入口（esbuild 打包为 /opt/sab/server/container-gateway.mjs，见任务书 §6.3）。
 *
 * 只装配网关自身：读取外部展示地址、读 supervisor 的状态文件作为 /container/
 * live 与 /container/ready 的唯一来源。这里不 import Bridge 的装配代码，避免
 * 在网关进程里意外创建第二套账本/控制权。
 */
import { readJsonIfExists } from '@sab/platform';
import { parsePublicBaseUrl, CONTAINER_GATEWAY_PORT } from './container-addresses.js';
import { ContainerGateway, type ContainerPublicStatus, type GatewayLogEntry } from './container-gateway.js';
import { sanitizeContainerStatus } from './container-status.js';

function log(entry: GatewayLogEntry): void {
    // 只记录请求 id、方法、路径类别、状态、耗时与故障类别。
    process.stderr.write(`${new Date().toISOString()} [gateway] ${entry.requestId} ${entry.method} ${entry.pathClass} ${entry.status} ${entry.durationMs}ms${entry.fault ? ` ${entry.fault}` : ''}\n`);
}

/** 状态文件缺失/代次不符时返回"未就绪"，绝不用残留文件冒充健康。 */
function readStatus(): ContainerPublicStatus {
    const file = process.env['SAB_GATEWAY_STATUS_FILE'] ?? '/run/sab/status.json';
    const generation = process.env['SAB_GATEWAY_GENERATION'] ?? '';
    const startNonce = process.env['SAB_GATEWAY_START_NONCE'] ?? '';
    const mode = process.env['SAB_RUN_MODE'] === 'game' ? 'game' : 'bridge';
    const sanitized = sanitizeContainerStatus(readJsonIfExists<unknown>(file), { generation, startNonce });
    if (!sanitized) {
        return {
            schemaVersion: 1,
            mode,
            state: 'created',
            live: false,
            modConnected: false,
            saveLoaded: false,
            desktopEnabled: false,
            desktopAvailable: false,
            reasonCode: 'STATUS_UNAVAILABLE'
        };
    }
    return sanitized;
}

async function main(): Promise<void> {
    const explicit = process.env['SAB_PUBLIC_BASE_URL'] ?? '';
    const httpPort = Number(process.env['SAB_HTTP_PORT'] ?? '17655');
    const publicBase = parsePublicBaseUrl(explicit.trim().length > 0 ? explicit : `http://127.0.0.1:${httpPort}`);
    if (publicBase.port !== httpPort) {
        throw new Error(`SAB_PUBLIC_BASE_URL 端口（${publicBase.port}）与 SAB_HTTP_PORT（${httpPort}）不一致。`);
    }
    const gateway = new ContainerGateway({ publicBase, containerStatus: async () => readStatus(), logger: log, listenPort: CONTAINER_GATEWAY_PORT });
    await gateway.start();
    process.stderr.write(`[gateway] 已监听 0.0.0.0:${CONTAINER_GATEWAY_PORT}，外部地址 ${publicBase.baseUrl}/\n`);

    const stop = async (signal: string): Promise<void> => {
        process.stderr.write(`[gateway] 收到 ${signal}：关闭监听\n`);
        await gateway.stop();
        process.exitCode = 0;
    };
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
    process.stderr.write(`[gateway] 致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 10;
});
