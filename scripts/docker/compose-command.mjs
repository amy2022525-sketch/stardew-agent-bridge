#!/usr/bin/env node
/**
 * Host 侧 Compose 命令构造（纯函数，DKR-018）。
 *
 * 所有 build/run/exec/maintenance 命令都必须显式带同一个 project 名、同一个
 * project-directory、同一个私有 env 文件与绝对 --file 路径；不允许依赖 cwd
 * 或 shell 拼接，也不允许不同命令落到不同 project 的卷上。
 */
import path from 'node:path';

export const MIN_COMPOSE_VERSION = '2.24.0';
export const DEFAULT_PROJECT = 'stardew-agent-bridge';

export class ComposeArgvError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ComposeArgvError';
        this.code = 'CONFIG_INVALID';
    }
}

/** project 名必须符合 Compose 的约束（小写字母/数字/下划线/横线，字母数字开头）。 */
export function validateProjectName(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
        throw new ComposeArgvError(`非法 Compose project 名：${name}（需小写字母/数字/下划线/横线，63 字符内）。`);
    }
    return name;
}

export function toAbsPath(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new ComposeArgvError(`缺少${label}路径。`);
    const resolved = path.resolve(value);
    // 中文/空格目录：只做结构化 argv，绝不拼接 shell 字符串。
    return resolved;
}

/**
 * 构造 `docker compose …` 的结构化 argv（不含 docker 可执行文件本身）。
 * files 顺序有意义：后一个 -f 覆盖前一个（base → game → novnc → tools）。
 */
export function buildComposeArgs({ files, projectName = DEFAULT_PROJECT, projectDirectory, envFile }, rest = []) {
    if (!Array.isArray(files) || files.length === 0) throw new ComposeArgvError('至少需要一个 compose 文件。');
    const args = ['compose', '--project-name', validateProjectName(projectName), '--project-directory', toAbsPath(projectDirectory, '项目')];
    if (envFile) args.push('--env-file', toAbsPath(envFile, 'env 文件'));
    for (const file of files) args.push('-f', toAbsPath(file, 'compose 文件'));
    args.push(...rest);
    return args;
}

/** 常用命令包装：只构造 argv，不执行。 */
export const composeCommands = {
    config: (ctx) => buildComposeArgs(ctx, ['config']),
    up: (ctx, { detach = true } = {}) => buildComposeArgs(ctx, ['up', ...(detach ? ['-d'] : []), '--no-build']),
    /** 管理契约：helper 永远不删卷。需要销毁卷时由用户手动执行 docker volume rm。 */
    down: (ctx) => buildComposeArgs(ctx, ['down']),
    logs: (ctx, { service = 'runtime', tail = 200, follow = false } = {}) => buildComposeArgs(ctx, ['logs', '--tail', String(tail), ...(follow ? ['-f'] : []), service]),
    ps: (ctx) => buildComposeArgs(ctx, ['ps', '--format', 'json']),
    run: (ctx, { service, command, remove = true, noDeps = true }) => {
        if (!service) throw new ComposeArgvError('run 需要 service 名。');
        const args = ['run', ...(remove ? ['--rm'] : []), ...(noDeps ? ['--no-deps'] : []), service];
        if (Array.isArray(command) && command.length > 0) args.push(...command);
        return buildComposeArgs(ctx, args);
    },
    /** stdio MCP：exec -T 进入已运行容器，不分配伪终端、不加 shell、不把 token 放 argv。 */
    execStdio: (ctx, { clientId, containerPath = '/opt/sab/server/stdio-adapter.mjs', nodePath = '/usr/local/bin/node', service = 'runtime' }) => {
        if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(clientId)) {
            throw new ComposeArgvError(`非法 SAB_CLIENT_ID：${clientId}`);
        }
        return buildComposeArgs(ctx, ['exec', '-T', '-e', `SAB_CLIENT_ID=${clientId}`, service, nodePath, containerPath]);
    },
    build: (ctx, { target, service = 'runtime' } = {}) => buildComposeArgs(ctx, ['build', ...(target ? ['--target', target] : []), service])
};

/** 版本比较（只支持 x.y.z 形式；无法解析时返回 0 表示"未知"，由调用方保守处理）。 */
export function compareVersions(left, right) {
    const parse = (value) => {
        const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
        const diff = a[index] - b[index];
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

export function checkComposeVersion(actual, minimum = MIN_COMPOSE_VERSION) {
    const compared = compareVersions(actual, minimum);
    if (compared === 0 && !/^\d/.test(String(actual ?? '').replace(/^v/, ''))) {
        return { ok: false, code: 'DOCKER_UNAVAILABLE', message: `无法识别 Docker Compose 版本：${actual}` };
    }
    if (compared < 0) {
        return { ok: false, code: 'DOCKER_UNAVAILABLE', message: `Docker Compose 版本过低（${actual} < ${minimum}）。请升级到 Compose V2。` };
    }
    return { ok: true, code: 'OK', message: `Docker Compose ${actual} 满足最低版本 ${minimum}。` };
}

/** 解析 `docker compose version --short` 的输出（例如 "2.29.7"）。 */
export function parseComposeVersion(stdout) {
    const text = String(stdout ?? '');
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}
