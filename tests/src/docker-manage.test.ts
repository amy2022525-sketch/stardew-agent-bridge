/**
 * 宿主管理工具（manage.mjs）契约测试（P0-2 对齐后的锁死验证）。
 *
 * 背景：交接档案 P0-2 —— 旧 helper 转发旧 maintenance API（--from/--kind、
 * migrate-from-native、重复拼 maintenance.mjs 路径）、只读 process.env 端口、
 * 有 down --volumes 分支、私有输出未接入。全部行为在这里锁死。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../..');
const load = async (relative: string): Promise<Record<string, unknown>> =>
    await import(pathToFileURL(path.join(REPO, relative)).href) as Record<string, unknown>;

const manage = await load('scripts/docker/manage.mjs') as {
    parseEnvFile: (file: string) => Record<string, string>;
    resolveEnvSettings: (envFile: string) => { httpPort: number; publicBaseUrl: string };
    resolveContext: (flags: Record<string, unknown>) => { files: string[]; envFile: string; projectName: string };
    maintenanceArgs: (ctx: unknown, service: string, forwarded: string[]) => string[];
    guardUnsavedProgress: (settings: { httpPort: number }, flags: Record<string, unknown>, deps?: { fetchState?: (port: number) => Promise<{ reachable: boolean; detail: unknown }> }) => Promise<{ proceed: boolean; reason?: string }>;
    fetchReady: (port: number) => Promise<{ reachable: boolean }>;
};
const composeCommand = await load('scripts/docker/compose-command.mjs') as {
    composeCommands: { down: (ctx: unknown) => string[]; run: (ctx: unknown, options: { service: string; command?: string[] }) => string[] };
};

const ctx = { files: ['D:/x/compose.yaml'], projectName: 'p', projectDirectory: 'D:/x', envFile: 'D:/x/.env' };

describe('manage.mjs 宿主契约（P0-2）', () => {
    it('mcp-config --json 始终是单个 JSON 文档；令牌只写入私有文件', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'sab-config-json-'));
        try {
            const args = ['--', path.join(REPO, 'scripts/docker/manage.mjs'), 'mcp-config', '--host', 'codex', '--env-file', path.join(dir, '.env'), '--json'];
            const template = spawnSync(process.execPath, args, { encoding: 'utf8' });
            assert.equal(template.status, 0, template.stderr);
            assert.equal(JSON.parse(template.stdout).containsToken, false);
            const token = 'test-token-not-a-real-credential';
            const issued = spawnSync(process.execPath, [...args, '--token-stdin'], { encoding: 'utf8', input: `${token}\n` });
            assert.equal(issued.status, 0, issued.stderr);
            const output = JSON.parse(issued.stdout);
            assert.equal(output.ok, true);
            assert.ok(!issued.stdout.includes(token));
            assert.ok(readFileSync(output.configFile, 'utf8').includes(token));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('parseEnvFile：KEY=VALUE、注释、CRLF、空行', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'sab-env-'));
        const file = path.join(dir, '.env');
        try {
            writeFileSync(file, '# comment\r\nSAB_HTTP_PORT=18055\r\n\r\n  SAB_UID = 1000 \r\nEMPTY=\r\n');
            const values = manage.parseEnvFile(file);
            assert.equal(values.SAB_HTTP_PORT, '18055');
            assert.equal(values.SAB_UID, '1000');
            assert.equal(values.EMPTY, '');
            assert.deepEqual(manage.parseEnvFile(path.join(dir, 'missing.env')), {});
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('resolveEnvSettings：私有 env 文件的 18055 映射生效；显式 process.env 优先', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'sab-env2-'));
        const file = path.join(dir, '.env');
        try {
            writeFileSync(file, 'SAB_HTTP_PORT=18055\nSAB_PUBLIC_BASE_URL=http://127.0.0.1:18055\n');
            const fromFile = manage.resolveEnvSettings(file);
            assert.equal(fromFile.httpPort, 18055);
            assert.equal(fromFile.publicBaseUrl, 'http://127.0.0.1:18055');

            const previous = process.env.SAB_HTTP_PORT;
            process.env.SAB_HTTP_PORT = '19055';
            try {
                const explicit = manage.resolveEnvSettings(file);
                assert.equal(explicit.httpPort, 19055);
            } finally {
                if (previous === undefined) delete process.env.SAB_HTTP_PORT;
                else process.env.SAB_HTTP_PORT = previous;
            }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('maintenanceArgs：新 API、受控入口、绝不拼 node maintenance.mjs', () => {
        const tools = { ...ctx, files: [...ctx.files, 'D:/x/compose.tools.yaml'] };
        const args = manage.maintenanceArgs(tools, 'maintenance', ['backup-restore', '--backup-id', 'b-20261024', '--json']);
        const joined = args.join(' ');
        assert.ok(joined.includes('compose'));
        assert.ok(joined.includes('run') && joined.includes('--rm') && joined.includes('--no-deps'));
        assert.ok(args.includes('maintenance'));
        assert.ok(joined.includes('backup-restore') && joined.includes('--backup-id') && args.includes('b-20261024'));
        // 关键回归：不允许再把执行路径塞进 command（entrypoint 已在 compose 固定）。
        assert.ok(!joined.includes('maintenance.mjs'), '不得在 command 中重复拼 maintenance.mjs');
        assert.ok(!joined.includes('--from') && !joined.includes('--kind'), '旧 --from/--kind 接口已废除');
        assert.ok(!joined.includes('migrate-from-native'), 'migrate-from-native 已删除');
    });

    it('prepare-update / check-input 走挂载游戏输入的 maintenance-game 服务', () => {
        const tools = { ...ctx, files: [...ctx.files, 'D:/x/compose.tools.yaml'] };
        for (const command of ['prepare-update', 'check-input']) {
            const args = manage.maintenanceArgs(tools, 'maintenance-game', [command, '--json']);
            assert.ok(args.includes('maintenance-game'), `${command} 必须选择 maintenance-game`);
            assert.ok(args.includes(command));
        }
    });

    it('composeCommands.down 永不携带 --volumes（管理契约）', () => {
        const args = composeCommand.composeCommands.down(ctx);
        assert.ok(!args.includes('--volumes') && !args.includes('-v'));
        assert.ok(args.includes('down'));
    });

    it('guardUnsavedProgress：game+已加载存档拒绝；bridge/未加载/--accept 放行', async () => {
        const gameLoaded = async () => ({ reachable: true, detail: { mode: 'game', saveLoaded: true } });
        const gameTitle = async () => ({ reachable: true, detail: { mode: 'game', saveLoaded: false } });
        const bridge = async () => ({ reachable: true, detail: { mode: 'bridge', saveLoaded: false } });
        const offline = async () => ({ reachable: false, detail: null });

        const refused = await manage.guardUnsavedProgress({ httpPort: 18055 }, {}, { fetchState: gameLoaded });
        assert.equal(refused.proceed, false);
        assert.equal(refused.reason, 'UNSAVED_PROGRESS_POSSIBLE');

        const accepted = await manage.guardUnsavedProgress({ httpPort: 18055 }, { 'accept-unsaved-progress': true }, { fetchState: gameLoaded });
        assert.equal(accepted.proceed, true);
        for (const fetchState of [gameTitle, bridge, offline]) {
            const pass = await manage.guardUnsavedProgress({ httpPort: 18055 }, {}, { fetchState });
            assert.equal(pass.proceed, true);
        }
    });
});
