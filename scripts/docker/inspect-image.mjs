#!/usr/bin/env node
/**
 * 镜像内容检查器（DKR-021）。把 bridge-runtime 的验收要点固化成脚本：
 * 布局契约、UID/GID、/opt/sab 只读、元数据与许可证、Web 资产。
 *
 * 用法：node scripts/docker/inspect-image.mjs [--image local/stardew-agent-bridge:bridge-runtime]
 *       [--docker docker] [--json]
 * Windows 宿主可用 SAB_DOCKER_WSL=<发行版> 自动经 wsl 转发（SAB_DOCKER_BIN 可指定 docker 可执行文件）。
 * 探针脚本刻意不含双引号与命令替换——经 wsl.exe 多层转义后仍保持字面语义。只读检查。
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const REQUIRED_SERVER = ['bridge.mjs', 'container-gateway.mjs', 'stdio-adapter.mjs'];
const REQUIRED_CONTAINER = ['addresses.mjs', 'backup.mjs', 'config.mjs', 'desktop-gateway.mjs', 'game-seed.mjs',
    'healthcheck.mjs', 'lease-entrypoint.mjs', 'lib.mjs', 'maintenance.mjs', 'mod-build.mjs', 'preflight.mjs',
    'supervisor.mjs', 'volume-owner.mjs'];

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const dockerBin = value('--docker') ?? process.env.SAB_DOCKER_BIN ?? 'docker';
const image = value('--image') ?? 'local/stardew-agent-bridge:bridge-runtime';
const json = args.includes('--json');

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

function docker(argv) {
    if (process.env.SAB_DOCKER_WSL) {
        return spawnSync('wsl.exe', ['-d', process.env.SAB_DOCKER_WSL, '-u', 'root', '--', dockerBin, ...argv], { encoding: 'utf8', shell: false });
    }
    return spawnSync(dockerBin, argv, { encoding: 'utf8', shell: false });
}

const PROBE = [
    'echo PROBE-IDENTITY',
    'id -u',
    'id -g',
    'echo PROBE-WRITE',
    'touch /opt/sab/.sab-probe 2>/dev/null && echo writable || echo readonly',
    'echo PROBE-SERVER',
    'ls /opt/sab/server',
    'echo PROBE-CONTAINER',
    'ls /opt/sab/container',
    'echo PROBE-FILES',
    'for f in /opt/sab/web/index.html /opt/sab/licenses/LICENSE /opt/sab/metadata/build-info.json /opt/sab/metadata/bundled-dependencies.json; do test -s $f && echo ok $f || echo MISSING $f; done',
    'echo PROBE-BUILDINFO',
    'grep -q sourceCommit /opt/sab/metadata/build-info.json && echo ok || echo bad',
    'echo PROBE-STAT',
    'stat -c %u:%g:%a /opt/sab /var/lib/sab /home/sab',
    'echo PROBE-DONE'
].join('\n');

const result = docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', PROBE]);
if ((result.status ?? 1) !== 0) {
    const error = `容器探针失败：${(result.stderr ?? '').trim().slice(0, 400)}`;
    process.stdout.write(json ? `${JSON.stringify({ ok: false, image, error }, null, 2)}\n` : `${error}\n`);
    process.exitCode = 19;
} else {
    const out = result.stdout ?? '';
    const section = name => { const match = out.split(`PROBE-${name}\n`)[1]; return (match ?? '').split(/\nPROBE-/)[0]; };
    const identity = section('IDENTITY').trim().split(/\s+/);
    check('uid-gid', identity[0] === '1000' && identity[1] === '1000', `uid=${identity[0]} gid=${identity[1]}`);
    check('opt-readonly', section('WRITE').trim() === 'readonly', `写探针=${section('WRITE').trim()}`);
    const serverFiles = section('SERVER').trim().split(/\s+/).filter(Boolean);
    check('server-entries', REQUIRED_SERVER.every(file => serverFiles.includes(file)), serverFiles.join(','));
    const containerFiles = section('CONTAINER').trim().split(/\s+/).filter(Boolean);
    check('container-runtime', REQUIRED_CONTAINER.every(file => containerFiles.includes(file)), `${REQUIRED_CONTAINER.length} 个 runtime 脚本（实得 ${containerFiles.length}）`);
    check('web-meta-licenses', !section('FILES').includes('MISSING'), section('FILES').trim().split('\n').filter(line => line !== 'ok' && !line.startsWith('ok ')).join('; ') || 'index.html/LICENSE/build-info/bundled-dependencies');
    check('build-info', section('BUILDINFO').trim() === 'ok', 'sourceCommit 存在');
    const stat = section('STAT').trim().split(/\s+/);
    check('dir-modes', stat[0] === '0:0:555' && stat[1] === '1000:1000:700' && stat[2] === '1000:1000:700', stat.join(' '));
    const ok = checks.every(item => item.ok);
    if (json) process.stdout.write(`${JSON.stringify({ ok, image, checks }, null, 2)}\n`);
    else for (const item of checks) process.stdout.write(`${item.ok ? '✔' : '✘'} ${item.name}: ${item.detail}\n`);
    process.exitCode = ok ? 0 : 17;
}
