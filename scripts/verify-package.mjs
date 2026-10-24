import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/**
 * 发布包验证（Windows 与 Linux 共用同一份脚本）。
 *
 * 目标：在不依赖安装目录、不依赖祖先 node_modules 的前提下，把发布包复制到
 * 仓库之外的中文路径里，跑通「版本 → 令牌 → 配置生成 → 常驻启动 → Web →
 * HTTP MCP → stdio 适配器」全链路，并校验清单与禁止文件。
 *
 * 用法：
 *   node scripts/verify-package.mjs [包目录] [--bridge-only] [--skip-runtime-exec]
 *
 *   --bridge-only        允许包里没有 mod/（CI 的 bridge-only 包）
 *   --skip-runtime-exec  不执行包内 Node（交叉验证时使用；本机验收不要加）
 *
 * 注意：本脚本会启动真实进程并占用随机空闲端口，必须由验证者在本机执行。
 */

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((item) => item.startsWith('--')));
const positional = argv.filter((item) => !item.startsWith('--'));
const bridgeOnly = flags.has('--bridge-only');
const skipRuntimeExec = flags.has('--skip-runtime-exec');

function defaultPackageDir() {
    const candidates = [
        path.join(root, 'release', `StardewAgentBridge-${version}-linux-x64`),
        path.join(root, 'release', `StardewAgentBridge-${version}`)
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const source = path.resolve(positional[0] ?? defaultPackageDir());
assert.ok(existsSync(source), `发布包目录不存在：${source}`);

// 必须把程序复制到仓库以外，否则未打包的依赖可能从祖先 node_modules 中被误解析。
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
        assert.ok(!lstatSync(src).isSymbolicLink(), `发布包不应包含符号链接：${src}`);
        if (item.isDirectory()) copyTree(src, dest);
        else {
            writeFileSync(dest, readFileSync(src));
            if (process.platform !== 'win32') chmodSync(dest, statSync(src).mode & 0o777);
        }
    }
}
copyTree(source, portable);
assert.ok(readFileSync(path.join(portable, 'server/bridge.mjs')).length > 0);
const entry = path.join(portable, 'server/bridge.mjs');
const adapter = path.join(portable, 'server/stdio-adapter.mjs');
const binEntry = path.join(portable, 'bin/stardew-agent-bridge');
const env = { ...process.env, SAB_HOME: data, SAB_CLIENT_ID: 'portable', NODE_OPTIONS: '--max-old-space-size=256' };
for (const key of ['SAB_TOKEN', 'SAB_URL', 'SAB_WEB_DIST', 'NODE_PATH']) delete env[key];

const checks = [];
const pass = (name) => checks.push(name);

const freePort = async () => {
    for (let n = 0; n < 32; n++) {
        const port = randomInt(20000, 60000);
        const server = createServer();
        try {
            await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
        } catch (e) {
            if (e.code === 'EADDRINUSE' || e.code === 'EACCES') continue;
            throw e;
        }
        await new Promise((resolve) => server.close(resolve));
        return port;
    }
    throw new Error('No test port available');
};

// ── 发布清单（仅 Linux 包有；Windows 包按原流程继续） ────────────────────────
const manifestFile = path.join(portable, 'manifest.release.json');
let releaseManifest = null;
if (existsSync(manifestFile)) {
    releaseManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(releaseManifest.version, version, 'manifest.release.json 版本必须与 package.json 一致');
    assert.equal(releaseManifest.target, 'linux-x64');
    assert.equal(releaseManifest.packageKind, bridgeOnly ? 'bridge-only-ci' : 'full');
    assert.ok(typeof releaseManifest.runtime?.node === 'string' && releaseManifest.runtime.node.length > 0, '必须记录包内 Node 版本');
    assert.equal(releaseManifest.runtime.bundled, true);
    assert.equal(releaseManifest.hasMod, !bridgeOnly);
    for (const item of releaseManifest.files) {
        assert.ok(!path.isAbsolute(item.path) && !item.path.split(/[\\/]/).includes('..'), '清单路径必须在包内');
        const file = path.join(portable, ...item.path.split('/'));
        assert.ok(existsSync(file), `清单中的文件不存在：${item.path}`);
        assert.equal(statSync(file).size, item.bytes, `大小不一致：${item.path}`);
        const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
        assert.equal(digest, item.sha256, `哈希不一致：${item.path}`);
        if (process.platform === 'linux') assert.equal((statSync(file).mode & 0o777).toString(8).padStart(4, '0'), item.mode, `权限不一致：${item.path}`);
    }
    pass(`manifest.release.json 覆盖 ${releaseManifest.files.length} 个文件且逐一校验通过`);

    // 启动入口与包内运行时
    assert.ok(existsSync(binEntry), '缺少 bin/stardew-agent-bridge');
    assert.ok((statSync(binEntry).mode & 0o111) !== 0, 'bin 入口必须可执行');
    const binText = readFileSync(binEntry, 'utf8');
    assert.ok(binText.includes('runtime/node'), 'bin 入口必须使用包内运行时');
    const runtimeNode = path.join(portable, 'runtime/node');
    if (releaseManifest.packageKind === 'full' || existsSync(runtimeNode)) {
        assert.ok(existsSync(runtimeNode), '缺少 runtime/node');
        assert.ok((statSync(runtimeNode).mode & 0o111) !== 0, 'runtime/node 必须可执行');
        const header = readFileSync(runtimeNode).subarray(0, 20);
        assert.equal(header.subarray(0, 4).toString('binary'), '\x7fELF', 'runtime/node 必须是 ELF 可执行文件');
        assert.equal(header.readUInt16LE(18), 62, 'runtime/node 必须是 x86-64');
    }
    for (const name of ['install-mod.mjs', 'rollback-mod.mjs', 'desktop-entry.mjs']) {
        const file = path.join(portable, 'scripts', name);
        assert.ok(existsSync(file), `缺少 scripts/${name}`);
        const text = readFileSync(file, 'utf8');
        assert.ok(!/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"](?:@sab\/|[^'"]*(?:\/packages\/|packages\/platform\/dist))/.test(text), `scripts/${name} 不得导入源码树`);
    }
    pass('启动入口、包内运行时与自包含脚本检查通过');
}

// ── 基础 CLI ────────────────────────────────────────────────────────────────
if (releaseManifest && process.platform !== 'linux' && !skipRuntimeExec) {
    throw new Error('Linux 包必须在 Linux 上执行验证；跨平台静态审查需明确使用 --skip-runtime-exec。');
}
const execNode = releaseManifest && process.platform === 'linux' && !skipRuntimeExec
    ? path.join(portable, 'runtime', 'node') : process.execPath;
if (releaseManifest && process.platform === 'linux' && !skipRuntimeExec) {
    const isolatedPath = path.join(area, 'empty-path');
    mkdirSync(isolatedPath);
    env.PATH = isolatedPath;
}
const cli = (...args) => {
    const result = spawnSync(execNode, [entry, ...args, '--data-dir', data], { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `CLI 必须成功退出：${args.join(' ')}\n${result.stderr ?? ''}`);
    return result.stdout;
};
assert.equal(cli('version').trim(), version);
pass('portable version from unrelated cwd');

if (releaseManifest && !skipRuntimeExec && process.platform === 'linux') {
    const viaBin = spawnSync(binEntry, ['version'], { cwd, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(viaBin.status, 0, `包内入口必须能独立运行：${viaBin.stderr ?? ''}`);
    assert.equal(viaBin.stdout.trim(), version);
    pass('包内入口用自带 Node 运行 version 成功');
}

cli('token', 'issue', 'portable'); // Intentionally capture credentials; never print them.
const generated = cli('hosts', '--host', 'codex', '--transport', 'stdio', '--client-id', 'portable');
assert.ok(generated.includes(adapter.replace(/\\/g, '\\\\')));
pass('stdio config resolves portable adapter independently of cwd');

// ── 常驻 Bridge ────────────────────────────────────────────────────────────
const port = await freePort();
const modPort = await freePort();
writeFileSync(path.join(data, 'config.json'), JSON.stringify({ bridgePort: port, modPort }));
const child = spawn(execNode, [entry, 'start', '--data-dir', data, '--port', String(port)], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
});
let log = '';
child.stdout.on('data', (chunk) => {
    log += chunk;
});
child.stderr.on('data', (chunk) => {
    log += chunk;
});
const url = `http://127.0.0.1:${port}`;
let http;
let stdio;
try {
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Portable Bridge exited before ready:\n${log}`);
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
            const health = await response.json();
            if (health.ok) {
                assert.equal(health.modConnected, false);
                assert.equal(health.saveLoaded, null, '没有 Mod 连接时不报告存档状态');
                ready = true;
                break;
            }
        } catch {
            /* wait until listener is ready */
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(ready, `portable Bridge must become ready:\n${log}`);
    pass('isolated start and no-game health');

    // 隔离性：数据根必须落在 SAB_HOME 指定的目录里，不得写用户主目录
    for (const name of ['config.json', 'credentials.json', 'endpoint.json', 'bridge.lock']) {
        assert.ok(existsSync(path.join(data, name)), `数据根缺少 ${name}`);
    }
    assert.ok(!existsSync(path.join(cwd, 'credentials.json')), '不得把凭据写到当前工作目录');
    pass('数据根只落在 SAB_HOME，未写入工作目录');

    for (const route of ['/', '/app.js', '/styles.css']) {
        const response = await fetch(url + route, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        assert.ok((await response.text()).length > 0);
    }
    pass('bundled Web assets from unrelated cwd');

    const sessionResponse = await fetch(url + '/api/v1/session');
    const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await sessionResponse.json();
    const webHeaders = { cookie, origin: url, 'content-type': 'application/json', 'x-sab-csrf': csrfToken };
    const connectionInfo = await (await fetch(url + '/api/v1/mcp', { headers: webHeaders })).json();
    assert.equal(connectionInfo.url, url + '/mcp');
    assert.equal(connectionInfo.toolCount, 28);
    assert.deepEqual(connectionInfo.clients, []);
    pass('portable Web MCP metadata');

    for (const transport of ['http', 'stdio']) {
        const response = await fetch(url + '/api/v1/mcp/check', {
            method: 'POST',
            headers: webHeaders,
            body: JSON.stringify({ transport }),
            signal: AbortSignal.timeout(15000)
        });
        assert.equal(response.status, 200, `portable ${transport} Web check must succeed`);
        const result = await response.json();
        assert.equal(result.ok, true);
        assert.equal(result.transport, transport);
        assert.equal(result.toolCount, 28);
        assert.equal(result.modConnected, false);
        pass(`portable Web MCP ${transport} real channel check`);
    }

    const credentials = JSON.parse(readFileSync(path.join(data, 'credentials.json'), 'utf8'));
    http = new Client({ name: 'portable-http-check', version: '1.0.0' });
    await http.connect(
        new StreamableHTTPClientTransport(new URL(url + '/mcp'), { authProvider: { token: async () => credentials.clients.portable.token } })
    );
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
    await stdio.connect(new StdioClientTransport({ command: execNode, args: [adapter], cwd, env, stderr: 'ignore' }));
    assert.deepEqual(
        (await stdio.listTools()).tools.map((t) => t.name).sort(),
        (await http.listTools()).tools.map((t) => t.name).sort()
    );
    assert.notEqual((await stdio.callTool({ name: 'stardew_status', arguments: {} })).isError, true);
    pass('portable stdio round trip shares HTTP tool set');
    await stdio.close();
    stdio = undefined;
    assert.equal((await (await fetch(url + '/health')).json()).ok, true);
    pass('关闭 stdio 适配器后共享 Bridge 仍可用');

    // ── 包内容与校验和 ────────────────────────────────────────────────────
    const files = [];
    const walk = (dir) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, item.name);
            if (item.isDirectory()) walk(file);
            else files.push(file);
        }
    };
    walk(source);
    const sums = readFileSync(path.join(source, 'CHECKSUMS.txt'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.equal(sums.length, files.length - 1, 'CHECKSUMS.txt 必须覆盖除自身外的所有文件');
    for (const line of sums) {
        const [, expected, relative] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
        assert.ok(relative, `校验和行格式异常：${line}`);
        const actual = createHash('sha256').update(readFileSync(path.join(source, relative))).digest('hex');
        assert.equal(actual, expected, relative);
    }
    pass('所有发布文件校验和一致');

    const forbidden = files.filter((f) =>
        /(?:credentials\.json|endpoint\.json|bridge\.lock|\.sqlite|\.sqlite-wal|\.sqlite-shm|\.pdb|\.save|\.map|Stardew Valley\.dll|StardewModdingAPI\.dll)$/i.test(f)
    );
    assert.deepEqual(forbidden, [], '发布包不得包含凭据、账本、存档、游戏程序集或源码映射');
    const dlls = files.filter((f) => f.endsWith('.dll')).map((f) => path.basename(f));
    if (bridgeOnly) assert.deepEqual(dlls, [], 'bridge-only 包不得包含任何 DLL');
    else assert.deepEqual(dlls, ['StardewAgentBridge.dll'], '只允许分发项目自己的 Mod DLL');
    assert.deepEqual(
        files.filter((f) => f.includes(`${path.sep}node_modules${path.sep}`)),
        [],
        '发布包不得包含 node_modules'
    );
    pass(`发布包不含私有数据/游戏文件（${files.length} 个文件）`);

    if (process.platform === 'linux' && releaseManifest) {
        await http.close(); http = undefined;
        child.kill('SIGTERM');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SIGTERM 后 Bridge 未及时退出')), 5000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        assert.equal(existsSync(path.join(data, 'bridge.lock')), false);
        assert.equal(existsSync(path.join(data, 'bridge.lock.owners')), false);
        assert.equal(existsSync(path.join(data, 'endpoint.json')), false);
        assert.equal(existsSync(path.join(data, 'ledger.sqlite')), true);
        pass('SIGTERM 清理本实例锁和 endpoint，保留账本');
    }

    console.log(
        JSON.stringify({
            outsideRepository: true,
            packageKind: releaseManifest?.packageKind ?? 'windows-legacy',
            bundledRuntimeExecuted: Boolean(releaseManifest && process.platform === 'linux' && !skipRuntimeExec),
            controlledPathWithoutGlobalNode: Boolean(releaseManifest && process.platform === 'linux' && !skipRuntimeExec),
            passed: checks.length,
            checks,
            files: files.length,
            checksums: sums.length
        })
    );
} finally {
    await stdio?.close().catch(() => {});
    await http?.close().catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else {
            child.once('exit', resolve);
            setTimeout(resolve, 3000);
        }
    });
    // 只移除本次 mkdtemp 创建的隔离目录，用户的应用数据不在这里。
    assert.equal(path.dirname(area), path.resolve(tmpdir()));
    assert.ok(path.basename(area).startsWith('sab-portable-'));
    rmSync(area, { recursive: true, force: true });
}
