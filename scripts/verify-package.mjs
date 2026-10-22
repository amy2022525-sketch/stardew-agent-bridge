import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// 必须把程序复制到仓库以外，否则未打包的依赖可能从祖先 node_modules 中被误解析。
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const source = path.resolve(process.argv[2] ?? path.join(root, 'release', `StardewAgentBridge-${version}`));
const area = mkdtempSync(path.join(tmpdir(), 'sab-portable-'));
assert.ok(!area.toLowerCase().startsWith(root.toLowerCase() + path.sep));
const portable = path.join(area, '程序 中文');
const cwd = path.join(area, '任意 工作目录');
const data = path.join(area, '隔离 数据');
mkdirSync(cwd, { recursive: true });
mkdirSync(data, { recursive: true });
// 顺序读取和写入小型发布文件，兼容部分 Windows 文件系统不支持的快速复制路径。
function copyTree(from, to) {
    mkdirSync(to, { recursive: true });
    for (const item of readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, item.name);
        const dest = path.join(to, item.name);
        if (item.isDirectory()) copyTree(src, dest);
        else writeFileSync(dest, readFileSync(src));
    }
}
copyTree(source, portable);
assert.ok(readFileSync(path.join(portable, 'server/bridge.mjs')).length > 0);
const entry = path.join(portable, 'server/bridge.mjs');
const adapter = path.join(portable, 'server/stdio-adapter.mjs');
const env = { ...process.env, SAB_HOME: data, SAB_CLIENT_ID: 'portable', NODE_OPTIONS: '--max-old-space-size=256' };
for (const key of ['SAB_TOKEN', 'SAB_URL', 'SAB_WEB_DIST', 'NODE_PATH']) delete env[key];
const checks = [];
const pass = (name) => checks.push(name);
const freePort = async () => {
    for (let n = 0; n < 32; n++) {
        const port = randomInt(20000, 60000);
        const server = createServer();
        try { await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve)); }
        catch (e) { if (e.code === 'EADDRINUSE') continue; throw e; }
        await new Promise(resolve => server.close(resolve));
        return port;
    }
    throw new Error('No test port available');
};
const port = await freePort();
const modPort = await freePort();
writeFileSync(path.join(data, 'config.json'), JSON.stringify({ bridgePort: port, modPort }));
const cli = (...args) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--data-dir', data], { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, 'portable CLI must exit successfully');
    return result.stdout;
};
assert.equal(cli('version').trim(), version);
pass('portable version from unrelated cwd');
cli('token', 'issue', 'portable'); // Intentionally capture credentials; never print them.
const generated = cli('hosts', '--host', 'codex', '--transport', 'stdio', '--client-id', 'portable');
assert.ok(generated.includes(adapter.replace(/\\/g, '\\\\')));
pass('stdio config resolves portable adapter independently of cwd');
const child = spawn(process.execPath, [entry, 'start', '--data-dir', data, '--port', String(port)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const url = `http://127.0.0.1:${port}`;
let http;
let stdio;
try {
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('Portable Bridge exited before ready');
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
            const health = await response.json();
            if (health.ok) { assert.equal(health.modConnected, false); ready = true; break; }
        } catch { /* wait until listener is ready */ }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(ready, 'portable Bridge must become ready');
    pass('isolated start and no-game health');
    for (const route of ['/', '/app.js', '/styles.css']) {
        const response = await fetch(url + route, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        assert.ok((await response.text()).length > 0);
    }
    pass('bundled Web assets from unrelated cwd');
    const credentials = JSON.parse(readFileSync(path.join(data, 'credentials.json'), 'utf8'));
    http = new Client({ name: 'portable-http-check', version: '1.0.0' });
    await http.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { authProvider: { token: async () => credentials.clients.portable.token } }));
    assert.equal((await http.listTools()).tools.length, 28);
    pass('portable HTTP MCP lists 28 tools');
    const status = await http.callTool({ name: 'stardew_status', arguments: {} });
    assert.notEqual(status.isError, true);
    pass('portable authenticated status');
    const snapshot = await http.callTool({ name: 'stardew_snapshot', arguments: {} });
    assert.equal(snapshot.isError, true);
    assert.ok(JSON.stringify(snapshot).includes('GAME_UNAVAILABLE'));
    pass('no-game snapshot reports GAME_UNAVAILABLE');
    stdio = new Client({ name: 'portable-stdio-check', version: '1.0.0' });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [adapter], cwd, env, stderr: 'ignore' }));
    assert.deepEqual((await stdio.listTools()).tools.map(t => t.name).sort(), (await http.listTools()).tools.map(t => t.name).sort());
    assert.notEqual((await stdio.callTool({ name: 'stardew_status', arguments: {} })).isError, true);
    pass('portable stdio round trip shares HTTP tool set');
    const files = [];
    const walk = dir => { for (const item of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else files.push(file); } };
    walk(source);
    const sums = readFileSync(path.join(source, 'CHECKSUMS.txt'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.equal(sums.length, files.length - 1);
    for (const line of sums) {
        const [, expected, relative] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
        assert.ok(relative);
        const actual = createHash('sha256').update(readFileSync(path.join(source, relative))).digest('hex');
        assert.equal(actual, expected, relative);
    }
    pass('all 24 packaged checksums verified');
    assert.deepEqual(files.filter(f => /(?:credentials\.json|endpoint\.json|\.sqlite|\.pdb|\.save|\.map|Stardew Valley\.dll|StardewModdingAPI\.dll)$/i.test(f)), []);
    assert.deepEqual(files.filter(f => f.endsWith('.dll')).map(f => path.basename(f)), ['StardewAgentBridge.dll']);
    pass('25 files contain only project DLL and no private/game data');
    console.log(JSON.stringify({ outsideRepository: true, passed: checks.length, checks, files: files.length, checksums: sums.length }));
} finally {
    await stdio?.close().catch(() => {});
    await http?.close().catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000); } });
    // 只移除本次 mkdtemp 创建的隔离目录，用户的应用数据不在这里。
    assert.equal(path.dirname(area), path.resolve(tmpdir()));
    assert.ok(path.basename(area).startsWith('sab-portable-'));
    rmSync(area, { recursive: true, force: true });
}
