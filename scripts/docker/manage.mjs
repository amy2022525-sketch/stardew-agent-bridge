#!/usr/bin/env node
/**
 * 宿主侧 Docker 管理工具（DKR-018）。运行在你的机器上，不在容器里。
 *
 * 设计约束：
 * - 所有 Compose 调用都带同一个 project 名、同一个 project-directory、同一份私有
 *   env 文件与绝对 -f 路径（见 compose-command.mjs）；
 * - 宿主侧自身读取 SAB_HTTP_PORT 等配置时，统一经过 resolveEnvSettings：显式
 *   process.env 优先，其次私有 env 文件，绝不各处各猜一个默认值；
 * - 一律使用结构化 argv（shell:false），中文/空格目录不需要任何转义；
 * - 维护操作全部经由 compose.tools.yaml 的受控 lease-entrypoint 入口，不在
 *   command 里重复拼 maintenance.mjs 的执行路径；
 * - 不替用户启动游戏、不读改真实存档、不删除卷（down 永不带 --volumes）；
 * - 令牌与密码只写入 private-output.mjs 生成的私有文件（Windows ACL / 0600），
 *   stdout 只出现文件路径与摘要，JSON 模式只输出一个文档；
 * - 环境不满足时用命名空间退出码（19 DOCKER_UNAVAILABLE 等）明确失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT, buildComposeArgs, checkComposeVersion, composeCommands, parseComposeVersion, toAbsPath, validateProjectName } from './compose-command.mjs';
import { HOST_IDS, generateMcpConfig, readTokenFromStdin } from './mcp-config.mjs';
import { writePrivateOutput } from './private-output.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EXIT = {
    OK: 0,
    CONFIG_INVALID: 10,
    INPUT_MISSING: 11,
    PERMISSION_DENIED: 12,
    OWNERSHIP_CONFLICT: 13,
    RECOVERY_REQUIRED: 14,
    START_TIMEOUT: 15,
    CHILD_EXITED: 16,
    BACKUP_INVALID: 17,
    UNSAVED_PROGRESS_POSSIBLE: 18,
    DOCKER_UNAVAILABLE: 19
};

const HELP = `用法：node scripts/docker/manage.mjs <命令> [选项]

只读/编排：
  doctor                      只读诊断：docker/compose 版本、env、端口、卷归属、合并配置
  plan [--game] [--novnc]     显示本次会用的 compose 文件、镜像、端口映射与卷（不启动）
  config                      运行 docker compose config 校验合并结果
  status                      以 JSON 读取容器对外 /container/ready
  ps / logs [--tail N] [-f]   容器列表 / runtime 日志
  open                        打印公共入口 URL（--launch 同时打开浏览器）

镜像/生命周期：
  build [--target bridge-runtime|game-runtime|mod-build]   构建镜像（走 scripts/docker/build.mjs）
  up [--game] [--novnc]       启动（game 模式需 --game；noVNC 需同时 --game --novnc）
  down                        停止。game 模式有已加载存档时拒绝执行，
                              需 --accept-unsaved-progress 显式确认。永不删除卷。

容器内 CLI：
  exec <命令…>                在运行中的 runtime 容器里执行命令（结构化 argv）
  token list                  列出客户端与令牌摘要
  token issue|rotate <id>     发放/轮换令牌：令牌只写入私有文件，stdout 只给路径
  token revoke <id>           吊销令牌

维护（经 compose tools 的 lease-entrypoint；runtime 必须已停止）：
  check-input                 在 maintenance-game 中执行输入预检（含只读游戏输入）
  prepare-update              离线重建/升级工作副本（maintenance-game）
  backup create|list          创建/列出备份
  backup verify|restore --backup-id <ID>   校验/恢复指定备份（恢复需人工确认 ID）
  recover-restore             完成或回滚未完成的跨卷恢复事务

配置/密钥：
  mcp-config [--host dsh|codex|claude-code|generic] [--transport http|stdio]
             [--client-id X] [--issue-token|--token-stdin] [--token <值>]
             生成宿主 MCP 配置；含令牌时整份配置只写入私有文件并输出路径
  generate-secret vnc-password --output <绝对路径>   生成 8 位字母数字桌面密码文件

公共选项：
  --project <名称>            覆盖 Compose project 名（默认 ${DEFAULT_PROJECT}）
  --env-file <路径>           私有 env 文件（默认 docker/.env）
  --json                      机器可读输出

退出码：0 成功；10 配置无效；11 输入缺失；12 权限；13 卷被占用；
        14 需要人工恢复；15 启动超时；16 子进程退出；17 备份无效；
        18 可能有未保存进度；19 Docker 不可用。
`;

function parseFlags(argv) {
    const out = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) continue;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[index + 1];
            if (next && !next.startsWith('-')) {
                out[key] = next;
                index += 1;
            } else out[key] = true;
            continue;
        }
        if (token === '-f') {
            out.follow = true;
            continue;
        }
        out._.push(token);
    }
    return out;
}

/** 解析私有 env 文件（KEY=VALUE，忽略注释/空行）。文件不存在时返回空对象。 */
export function parseEnvFile(file) {
    const values = {};
    if (!existsSync(file)) return values;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) values[match[1]] = match[2];
    }
    return values;
}

/**
 * 宿主侧配置统一入口：显式 process.env 优先于私有 env 文件。
 * 18055 端口映射场景（example.env）与容器内 17656 的换算都从这里取值。
 */
export function resolveEnvSettings(envFile) {
    const fromFile = parseEnvFile(envFile);
    const pick = (key, fallback) => {
        const explicit = process.env[key];
        if (explicit !== undefined && explicit !== '') return explicit;
        if (fromFile[key] !== undefined && fromFile[key] !== '') return fromFile[key];
        return fallback;
    };
    const httpPort = Number(pick('SAB_HTTP_PORT', 17655));
    const publicBaseUrl = pick('SAB_PUBLIC_BASE_URL', `http://127.0.0.1:${httpPort}`);
    return {
        httpPort,
        publicBaseUrl,
        uid: pick('SAB_UID', '1000'),
        gid: pick('SAB_GID', '1000'),
        imagePrefix: pick('SAB_IMAGE_PREFIX', 'local/stardew-agent-bridge'),
        gameSource: pick('SAB_GAME_SOURCE', '')
    };
}

/** 解析运行上下文：项目名、compose 文件集合、项目目录、env 文件（全部绝对路径）。 */
export function resolveContext(flags) {
    const projectName = validateProjectName(typeof flags.project === 'string' ? flags.project : DEFAULT_PROJECT);
    const projectDirectory = REPO_ROOT;
    const envFile = toAbsPath(typeof flags['env-file'] === 'string' ? flags['env-file'] : path.join(REPO_ROOT, 'docker', '.env'), 'env 文件');
    const files = [path.join(REPO_ROOT, 'docker', 'compose.yaml')];
    if (flags.game === true) files.push(path.join(REPO_ROOT, 'docker', 'compose.game.yaml'));
    if (flags.novnc === true) {
        if (flags.game !== true) {
            const error = new Error('CONFIG_INVALID：noVNC 覆盖文件必须与 --game 同时使用（bridge 模式没有桌面）。');
            error.code = 'CONFIG_INVALID';
            throw error;
        }
        files.push(path.join(REPO_ROOT, 'docker', 'compose.novnc.yaml'));
    }
    if (flags.tools === true) files.push(path.join(REPO_ROOT, 'docker', 'compose.tools.yaml'));
    return { projectName, projectDirectory, envFile, files: files.map((file) => toAbsPath(file, 'compose 文件')) };
}

function runInherit(command, args, { env = process.env } = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false, env });
    return result.status ?? 1;
}

function runCapture(command, args) {
    const result = spawnSync(command, args, { shell: false, encoding: 'utf8' });
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null };
}

/** 只读诊断。任一致命项失败返回对应退出码；不修改任何文件。 */
export function doctor(ctx, { dockerPath = 'docker' } = {}) {
    const settings = resolveEnvSettings(ctx.envFile);
    const checks = [];
    const dockerVersion = runCapture(dockerPath, ['--version']);
    if (dockerVersion.status !== 0) {
        checks.push({ name: 'docker', ok: false, detail: dockerVersion.error?.message ?? 'docker 不可用（本机可设 SAB_DOCKER_BIN 指向 wsl 包装脚本）' });
        return { ok: false, code: 'DOCKER_UNAVAILABLE', exitCode: EXIT.DOCKER_UNAVAILABLE, checks };
    }
    checks.push({ name: 'docker', ok: true, detail: dockerVersion.stdout.trim() });

    const composeVersion = runCapture(dockerPath, ['compose', 'version', '--short']);
    const parsed = parseComposeVersion(composeVersion.stdout);
    const versionCheck = checkComposeVersion(parsed || '0.0.0');
    checks.push({ name: 'compose', ok: versionCheck.ok, detail: versionCheck.ok ? `Compose ${parsed}` : versionCheck.message });
    if (!versionCheck.ok) return { ok: false, code: 'DOCKER_UNAVAILABLE', exitCode: EXIT.DOCKER_UNAVAILABLE, checks };

    const envExists = existsSync(ctx.envFile);
    checks.push({ name: 'envFile', ok: envExists, detail: envExists ? ctx.envFile : `缺少私有 env 文件：${ctx.envFile}（可从 docker/example.env 复制）` });
    if (envExists) {
        try {
            const mode = statSync(ctx.envFile).mode & 0o777;
            const tooOpen = (mode & 0o077) !== 0;
            checks.push({ name: 'envMode', ok: !tooOpen, detail: tooOpen ? `env 文件权限过宽（${mode.toString(8)}），建议 0600` : `env 权限 ${mode.toString(8)}` });
        } catch (error) {
            checks.push({ name: 'envMode', ok: false, detail: error.message });
        }
        const filePort = Number(parseEnvFile(ctx.envFile).SAB_HTTP_PORT);
        if (parseEnvFile(ctx.envFile).SAB_HTTP_PORT !== undefined && (!Number.isInteger(filePort) || filePort < 1024 || filePort > 65535)) {
            checks.push({ name: 'envPort', ok: false, detail: `env 文件里的 SAB_HTTP_PORT 非法：${parseEnvFile(ctx.envFile).SAB_HTTP_PORT}` });
        }
    }

    for (const file of ctx.files) {
        checks.push({ name: `compose:${path.basename(file)}`, ok: existsSync(file), detail: existsSync(file) ? file : `缺少文件：${file}` });
    }

    // 端口以统一 env 解析为准（example.env 是 18055 映射，不是 17655）。
    checks.push({ name: 'port', ok: true, detail: `将发布 127.0.0.1:${settings.httpPort} → 容器 17656；公共地址 ${settings.publicBaseUrl}` });

    // 卷归属：本 project 名下的 compose 卷必须真实存在且带 compose project 标签。
    const volumeList = runCapture(dockerPath, ['volume', 'ls', '--filter', `label=com.docker.compose.project=${ctx.projectName}`, '--format', '{{.Name}}']);
    if (volumeList.status === 0) {
        const volumes = volumeList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        checks.push({
            name: 'volumes',
            ok: true,
            detail: volumes.length > 0 ? `project 卷：${volumes.join(', ')}` : '尚无 project 卷（首次 up 时创建）'
        });
    } else {
        checks.push({ name: 'volumes', ok: false, detail: '无法查询卷标签归属（docker volume ls 失败）' });
    }

    const composeConfig = runCapture(dockerPath, buildComposeArgs(ctx, ['config', '--quiet']));
    checks.push({
        name: 'composeConfig',
        ok: composeConfig.status === 0,
        detail: composeConfig.status === 0 ? 'compose 文件合并校验通过' : (composeConfig.stderr || 'compose config 失败').trim().slice(0, 800)
    });

    const ok = checks.every((check) => check.ok || check.name === 'port');
    return { ok, code: ok ? 'OK' : 'CONFIG_INVALID', exitCode: ok ? 0 : EXIT.CONFIG_INVALID, checks };
}

/** 维护命令 argv：统一经 tools overlay 的受控 lease-entrypoint（entrypoint 已在 compose 中固定，不重复拼执行路径）。 */
export function maintenanceArgs(toolsCtx, service, forwarded) {
    return buildComposeArgs(toolsCtx, ['run', '--rm', '--no-deps', service, ...forwarded]);
}

function runMaintenance(toolsCtx, dockerPath, service, forwarded) {
    const status = runInherit(dockerPath, maintenanceArgs(toolsCtx, service, forwarded));
    if (status === EXIT.OWNERSHIP_CONFLICT) {
        process.stderr.write('提示：runtime 仍在运行（数据卷租约被持有）。先 `manage.mjs down` 再执行维护命令。\n');
    }
    return status;
}

function toolsContext(ctx) {
    return { ...ctx, files: [...ctx.files, path.join(REPO_ROOT, 'docker', 'compose.tools.yaml')] };
}

/** game 模式且有已加载存档时拒绝 down；--accept-unsaved-progress 显式放行。fetchReady 可注入以便测试。 */
export async function guardUnsavedProgress(settings, flags, { fetchState = fetchReady } = {}) {
    if (flags['accept-unsaved-progress'] === true) return { proceed: true };
    const state = await fetchState(settings.httpPort);
    const payload = state.reachable ? state.detail : null;
    if (payload && payload.mode === 'game' && payload.saveLoaded === true) {
        return {
            proceed: false,
            reason: 'UNSAVED_PROGRESS_POSSIBLE',
            detail: '容器内游戏可能持有当日未保存进度。停止不等于保存；如确认要停，加 --accept-unsaved-progress。'
        };
    }
    return { proceed: true };
}

async function main(argv = process.argv.slice(2)) {
    const flags = parseFlags(argv);
    const [command = 'help'] = flags._;
    const json = flags.json === true;
    if (command === 'help' || flags.help === true) {
        process.stdout.write(HELP);
        return 0;
    }
    const dockerPath = process.env.SAB_DOCKER_BIN ?? 'docker';
    let ctx;
    try {
        ctx = resolveContext(flags);
    } catch (error) {
        process.stderr.write(`${error.code ?? 'CONFIG_INVALID'}：${error.message}\n`);
        return EXIT.CONFIG_INVALID;
    }
    const settings = resolveEnvSettings(ctx.envFile);

    if (command === 'doctor') {
        const result = doctor(ctx, { dockerPath });
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
            for (const check of result.checks) process.stdout.write(`${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}\n`);
        }
        return result.exitCode;
    }

    if (command === 'plan') {
        const plan = {
            mode: flags.game === true ? 'game' : 'bridge',
            composeFiles: ctx.files,
            image: `${settings.imagePrefix}:${flags.game === true ? 'game-runtime' : 'bridge-runtime'}`,
            publish: `127.0.0.1:${settings.httpPort} -> 17656`,
            publicBaseUrl: settings.publicBaseUrl,
            uidGid: `${settings.uid}:${settings.gid}`,
            gameSource: flags.game === true ? (settings.gameSource || '未设置（compose.game.yaml 将拒绝启动）') : null,
            novnc: flags.novnc === true
        };
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return 0;
    }

    if (command === 'config') {
        return runInherit(dockerPath, composeCommands.config(ctx));
    }
    if (command === 'up') {
        return runInherit(dockerPath, composeCommands.up(ctx));
    }
    if (command === 'down') {
        const guard = await guardUnsavedProgress(settings, flags);
        if (!guard.proceed) {
            process.stderr.write(`${guard.reason}：${guard.detail}\n`);
            return EXIT.UNSAVED_PROGRESS_POSSIBLE;
        }
        return runInherit(dockerPath, composeCommands.down(ctx));
    }
    if (command === 'logs') {
        const tail = Number(typeof flags.tail === 'string' ? flags.tail : 200);
        return runInherit(dockerPath, composeCommands.logs(ctx, { tail: Number.isFinite(tail) ? tail : 200, follow: flags.follow === true }));
    }
    if (command === 'ps') {
        return runInherit(dockerPath, composeCommands.ps(ctx));
    }
    if (command === 'status') {
        const result = await fetchReady(settings.httpPort);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.reachable ? 0 : EXIT.CHILD_EXITED;
    }
    if (command === 'open') {
        const url = `${settings.publicBaseUrl}/`;
        process.stdout.write(`${url}\n`);
        if (flags.launch === true) {
            const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
            runInherit(opener[0], opener[1]);
        }
        return 0;
    }
    if (command === 'build') {
        const target = typeof flags.target === 'string' ? flags.target : flags.game === true ? 'game-runtime' : 'bridge-runtime';
        return runInherit(process.execPath, [path.join(REPO_ROOT, 'scripts/docker/build.mjs'), '--target', target]);
    }
    if (command === 'exec') {
        const rest = flags._.slice(1);
        if (rest.length === 0) {
            process.stderr.write('exec 需要命令，例如：manage.mjs exec token list --json\n');
            return EXIT.CONFIG_INVALID;
        }
        return runInherit(dockerPath, buildComposeArgs(ctx, ['exec', '-T', 'runtime', ...rest]));
    }
    if (command === 'token') {
        return tokenCommand(flags, ctx, { dockerPath, json });
    }
    if (command === 'mcp-config') {
        return await mcpConfigCommand(flags, ctx, { dockerPath, json, settings });
    }
    if (command === 'generate-secret') {
        return generateSecretCommand(flags, ctx, { json });
    }
    if (command === 'check-input') {
        return runMaintenance(toolsContext(ctx), dockerPath, 'maintenance-game', ['check-input', '--json']);
    }
    if (command === 'prepare-update') {
        // 工作副本重建需要只读游戏输入，因此选择挂载 /input/game 的 maintenance-game。
        return runMaintenance(toolsContext(ctx), dockerPath, 'maintenance-game', ['prepare-update', '--json']);
    }
    if (command === 'recover-restore') {
        return runMaintenance(toolsContext(ctx), dockerPath, 'maintenance', ['recover-restore', '--json']);
    }
    if (command === 'backup') {
        const sub = flags._[1] ?? 'list';
        const toolsCtx = toolsContext(ctx);
        if (sub === 'create') return runMaintenance(toolsCtx, dockerPath, 'maintenance', ['backup-create', '--json']);
        if (sub === 'list') return runMaintenance(toolsCtx, dockerPath, 'maintenance', ['backup-list', '--json']);
        if (sub === 'verify' || sub === 'restore') {
            const id = typeof flags['backup-id'] === 'string' ? flags['backup-id'] : '';
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
                process.stderr.write('CONFIG_INVALID：backup verify/restore 需要有效的 --backup-id（备份 ID，不是宿主路径）。\n');
                return EXIT.CONFIG_INVALID;
            }
            if (sub === 'restore') {
                process.stderr.write(`即将把备份 ${id} 恢复到数据/存档卷（现有内容进入恢复事务保护）。继续执行…\n`);
            }
            return runMaintenance(toolsCtx, dockerPath, 'maintenance', [`backup-${sub}`, '--backup-id', id, '--json']);
        }
        process.stderr.write('backup 子命令：create | list | verify --backup-id ID | restore --backup-id ID\n');
        return EXIT.CONFIG_INVALID;
    }

    process.stderr.write(`未知命令：${command}\n\n${HELP}`);
    return EXIT.CONFIG_INVALID;
}

/** 读取容器对外就绪状态（/container/ready）。 */
export async function fetchReady(port) {
    const url = `http://127.0.0.1:${port}/container/ready`;
    try {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        const payload = await response.json().catch(() => null);
        return { reachable: true, status: response.status, ready: response.status === 200, detail: payload };
    } catch (error) {
        return { reachable: false, status: 0, ready: false, detail: { error: error instanceof Error ? error.message : String(error) } };
    }
}

/** 在 runtime 容器内执行 bridge.mjs token 子命令（结构化 argv，不经过 shell）。 */
function bridgeTokenArgs(ctx, sub, id) {
    return buildComposeArgs(ctx, ['exec', '-T', 'runtime', '/usr/local/bin/node', '/opt/sab/server/bridge.mjs', 'token', sub, ...(id ? [id] : []), '--json']);
}

function privateOutputPath(ctx, kind, name, ext) {
    return path.join(path.dirname(ctx.envFile), kind, `${name}-${Date.now().toString(36)}${ext}`);
}

async function tokenCommand(flags, ctx, { dockerPath, json }) {
    const sub = flags._[1] ?? 'list';
    const id = typeof flags['client-id'] === 'string' ? flags['client-id'] : flags._[2];
    if (sub === 'list') {
        return runInherit(dockerPath, bridgeTokenArgs(ctx, 'list'));
    }
    if (sub === 'revoke') {
        if (!id) { process.stderr.write('token revoke 需要 <client-id>。\n'); return EXIT.CONFIG_INVALID; }
        return runInherit(dockerPath, bridgeTokenArgs(ctx, 'revoke', id));
    }
    if (sub !== 'issue' && sub !== 'rotate') {
        process.stderr.write('token 子命令：list | issue <client-id> | rotate <client-id> | revoke <client-id>\n');
        return EXIT.CONFIG_INVALID;
    }
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(id)) {
        process.stderr.write('CONFIG_INVALID：需要合法 client-id（2–40 位字母/数字/下划线/横线）。\n');
        return EXIT.CONFIG_INVALID;
    }
    // 令牌只在容器内生成；stdout 的 JSON 被捕获后立即落入私有文件，不再回显。
    const result = runCapture(dockerPath, bridgeTokenArgs(ctx, sub, id));
    if (result.status !== 0) {
        process.stderr.write(`token ${sub} 失败：${(result.stderr || result.stdout || '').trim()}\n`);
        return EXIT.CHILD_EXITED;
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
    } catch {
        parsed = null;
    }
    const token = parsed?.token ?? parsed?.credential?.token ?? '';
    if (!token) {
        process.stderr.write('未能从 CLI 输出中解析出令牌（未写任何文件）。\n');
        return EXIT.CHILD_EXITED;
    }
    const file = privateOutputPath(ctx, 'tokens', `${id}-${sub}`, '.json');
    try {
        writePrivateOutput(file, `${JSON.stringify({ clientId: id, action: sub, token, issuedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`写入私有令牌文件失败（${error.message}）；令牌未落盘、未回显，请重试。\n`);
        return EXIT.PERMISSION_DENIED;
    }
    const summary = { ok: true, clientId: id, action: sub, tokenFile: file, note: '令牌只写入该私有文件（0600 / Windows ACL）；不会再次显示。' };
    process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `令牌已写入：${file}\n`);
    return 0;
}

async function mcpConfigCommand(flags, ctx, { dockerPath, json, settings }) {
    const host = typeof flags.host === 'string' && HOST_IDS.includes(flags.host) ? flags.host : 'dsh';
    const transport = flags.transport === 'stdio' ? 'stdio' : 'http';
    const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined;

    let token = typeof flags.token === 'string' ? flags.token : '';
    if (!token && flags['token-stdin'] === true) token = await readTokenFromStdin();
    if (!token && flags['issue-token'] === true) {
        const id = clientId ?? (host === 'generic' ? 'agent' : host);
        const result = runCapture(dockerPath, buildComposeArgs(ctx, ['exec', '-T', 'runtime', '/usr/local/bin/node', '/opt/sab/server/bridge.mjs', 'token', 'issue', id, '--json']));
        if (result.status !== 0) {
            process.stderr.write(`发放令牌失败：${(result.stderr || result.stdout || '').trim()}\n`);
            return EXIT.CHILD_EXITED;
        }
        try {
            const parsed = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
            token = parsed.token ?? parsed.credential?.token ?? '';
        } catch {
            token = '';
        }
        if (!token) {
            process.stderr.write('未能从 CLI 输出中解析出令牌。\n');
            return EXIT.CHILD_EXITED;
        }
    }

    const snippet = generateMcpConfig({
        host,
        transport,
        ...(clientId ? { clientId } : {}),
        token: token || '<TOKEN>',
        publicBaseUrl: settings.publicBaseUrl,
        dockerPath,
        files: ctx.files,
        projectName: ctx.projectName,
        projectDirectory: ctx.projectDirectory,
        envFile: ctx.envFile
    });

    if (token) {
        // 含真实令牌的配置只进私有文件；stdout 只给路径与说明（JSON 模式同样只输出这一个文档）。
        const ext = snippet.language === 'toml' ? '.toml' : '.json';
        const file = privateOutputPath(ctx, 'mcp-configs', `${host}-${transport}`, ext);
        try {
            writePrivateOutput(file, `${snippet.content}\n`);
        } catch (error) {
            process.stderr.write(`写入私有配置文件失败（${error.message}）；含令牌内容未落盘、未回显。\n`);
            return EXIT.PERMISSION_DENIED;
        }
        const summary = { ok: true, host, transport, clientId: snippet.clientId, configFile: file, suggestedTarget: snippet.targetFile };
        process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `配置已写入：${file}\n建议写入位置：${snippet.targetFile}\n`);
        if (!json) for (const note of snippet.notes) process.stdout.write(`· ${note}\n`);
        return 0;
    }

    if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, host, transport, clientId: snippet.clientId, containsToken: false,
            suggestedTarget: snippet.targetFile, content: snippet.content, notes: snippet.notes }, null, 2)}\n`);
        return 0;
    }
    process.stdout.write(`# 宿主：${snippet.host}（${transport}）\n# 建议写入位置：${snippet.targetFile}\n\n${snippet.content}\n\n`);
    for (const note of snippet.notes) process.stdout.write(`· ${note}\n`);
    process.stdout.write('\n注意：未包含令牌。加 --issue-token（容器需在运行）或 --token-stdin 传入；含令牌的完整配置只写入私有文件。\n');
    return 0;
}

function generateSecretCommand(flags, ctx, { json }) {
    const kind = flags._[1];
    const output = typeof flags.output === 'string' ? flags.output : '';
    if (kind !== 'vnc-password') {
        process.stderr.write('generate-secret 目前支持：vnc-password --output <绝对路径>\n');
        return EXIT.CONFIG_INVALID;
    }
    if (!path.isAbsolute(output)) {
        process.stderr.write('CONFIG_INVALID：--output 必须是绝对路径（该文件会成为 SAB_VNC_PASSWORD_PATH）。\n');
        return EXIT.CONFIG_INVALID;
    }
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const value = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    try {
        writePrivateOutput(output, `${value}\n`);
    } catch (error) {
        process.stderr.write(`写入密码文件失败：${error.message}\n`);
        return EXIT.PERMISSION_DENIED;
    }
    const summary = { ok: true, kind, file: output, note: '8 位字母数字；文件 0600 / Windows ACL。把绝对路径填入 SAB_VNC_PASSWORD_PATH。' };
    process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `密码已写入：${output}\n`);
    return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
    main()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            process.stderr.write(`致命错误：${error?.stack ?? error}\n`);
            process.exitCode = EXIT.CONFIG_INVALID;
        });
}
