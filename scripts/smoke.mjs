#!/usr/bin/env node
/**
 * 现场自检：连接一个已经运行的 Bridge，走真实 HTTP MCP 通道验证工具面与一次只读调用。
 *
 * 用法：node scripts/smoke.mjs [--url http://127.0.0.1:17655] [--data-dir <路径>] [--client <clientId>]
 * 用途：交接验收、安装后确认、给别人复现问题前的第一道检查。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDir = arg('data-dir', process.env.SAB_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'StardewAgentBridge'));
const clientId = arg('client', 'smoke');
let url = arg('url', null);

const endpointFile = path.join(dataDir, 'endpoint.json');
if (!url) {
    if (existsSync(endpointFile)) {
        const endpoint = JSON.parse(readFileSync(endpointFile, 'utf8'));
        url = `http://127.0.0.1:${endpoint.port}`;
    } else {
        url = 'http://127.0.0.1:17655';
    }
}

const credentialsFile = path.join(dataDir, 'credentials.json');
if (!existsSync(credentialsFile)) {
    console.error(`没有找到凭据文件：${credentialsFile}\n请先启动一次 Bridge（node server/bridge.mjs start）。`);
    process.exit(1);
}
const credentials = JSON.parse(readFileSync(credentialsFile, 'utf8'));
const token = credentials.clients?.[clientId]?.token ?? credentials.clients?.tester?.token;
if (!token) {
    console.error(`凭据里没有客户端 ${clientId} 的令牌。用：node server/bridge.mjs token issue ${clientId}`);
    process.exit(1);
}

const health = await fetch(`${url}/health`).then((response) => response.json()).catch((error) => ({ ok: false, error: String(error) }));
console.log(`[1/4] /health → ok=${health.ok} version=${health.bridgeVersion ?? '?'} modConnected=${health.modConnected}`);

const transport = new StreamableHTTPClientTransport(new URL(`${url.replace(/\/$/, '')}/mcp`), {
    authProvider: { token: async () => token }
});
const client = new Client({ name: 'sab-smoke', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`[2/4] tools/list → ${tools.length} 个工具：${tools.slice(0, 6).map((tool) => tool.name).join(', ')}…`);

const status = await client.callTool({ name: 'stardew_status', arguments: {} });
const statusText = (status.content ?? []).find((item) => item.type === 'text')?.text ?? '';
console.log(`[3/4] stardew_status → isError=${status.isError === true}`);
console.log(statusText.split('\n').slice(0, 12).map((line) => `      ${line}`).join('\n'));

const snapshot = await client.callTool({ name: 'stardew_snapshot', arguments: { radius: 3 } });
const snapshotText = (snapshot.content ?? []).find((item) => item.type === 'text')?.text ?? '';
console.log(`[4/4] stardew_snapshot → isError=${snapshot.isError === true}，前 6 行：`);
console.log(snapshotText.split('\n').slice(0, 6).map((line) => `      ${line}`).join('\n'));

await client.close();
console.log(snapshot.isError === true || status.isError === true ? '自检发现问题：请查看上面的错误文本与 Bridge 日志。' : '自检通过。');
process.exit(status.isError === true || snapshot.isError === true ? 2 : 0);
