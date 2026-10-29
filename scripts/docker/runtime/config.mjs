#!/usr/bin/env node
/**
 * Docker 运行时**唯一**的配置解析与校验模块。
 *
 * 约束（交接书 §13.2）：supervisor、gateway、preflight、healthcheck、宿主管理工具
 * 都从这里取值，不允许在各自位置使用不同的 fallback。
 *
 * 纯函数优先：只做解析与校验，不建立对象、不打开账本、不写文件。
 * 退出码命名空间见 §12.4；这里只返回 { ok, code, ... }，由调用方决定退出码。
 */
import path from 'node:path';

/** §12.4 supervisor / 宿主管理工具的退出码命名空间（原 CLI 的 0/1/2/3 不变）。 */
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

export const EXIT_BY_CODE = {
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

/** 固定端口分工（§4.1）。内部端口在首版不可配置。 */
export const PORTS = {
    modInternal: 17654,
    bridgeInternal: 17655,
    gatewayInternal: 17656,
    vncInternal: 5900,
    novncInternal: 6080
};

/** 镜像内固定布局（§6.3）。 */
export const LAYOUT = {
    app: '/opt/sab',
    server: '/opt/sab/server',
    container: '/opt/sab/container',
    web: '/opt/sab/web',
    metadata: '/opt/sab/metadata',
    licenses: '/opt/sab/licenses',
    inputGame: '/input/game',
    inputMod: '/input/mod',
    gameWork: '/srv/game',
    gameHome: '/home/sab',
    data: '/var/lib/sab',
    backups: '/var/backups/sab',
    run: '/run/sab',
    secrets: '/run/secrets',
    node: '/usr/local/bin/node',
    leaseLock: '/var/lib/sab/container-volume.lock',
    entry: '/opt/sab/container/lease-entrypoint.mjs'
};

export const ALLOWED_DISPLAY_SIZES = ['1024x768', '1280x720', '1280x800', '1600x900', '1920x1080'];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export {AddressError,parsePublicBaseUrl,defaultPublicBaseUrl,resolvePublicBaseUrl,resolveDesktopBaseUrl} from './addresses.mjs';
import {parsePublicBaseUrl,resolvePublicBaseUrl,resolveDesktopBaseUrl} from './addresses.mjs';
const resolveDesktopBaseUrlCompat = resolveDesktopBaseUrl;

function fail(code, message, details = {}) {
    return { ok: false, code, reasonCode: code, message, details, exitCode: EXIT_BY_CODE[code] ?? 1 };
}

function intInRange(raw, { name, min, max, fallback }) {
    if (raw === undefined || raw === null || raw === '') return { value: fallback };
    if (!/^-?[0-9]+$/.test(String(raw).trim())) return { error: `${name} 必须是整数（收到 ${raw}）。` };
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return { error: `${name} 必须在 ${min}–${max} 之间（收到 ${value}）。` };
    return { value };
}

function boolValue(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return { value: fallback };
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return { value: true };
    if (['false', '0', 'no', 'off'].includes(text)) return { value: false };
    return { error: `必须是 true/false（收到 ${raw}）。` };
}

/**
 * 解析并严格校验容器配置。
 * @param {Record<string,string|undefined>} env
 * @param {{ mode?: 'bridge'|'game' }} [options] 允许由命令行覆盖模式（显式参数优先）。
 */
export function parseContainerConfig(env = {}, options = {}) {
    const mode = (options.mode ?? env.SAB_RUN_MODE ?? 'bridge').trim();
    if (mode !== 'bridge' && mode !== 'game') {
        return fail('CONFIG_INVALID', `SAB_RUN_MODE 只接受 bridge 或 game（收到 ${mode}）。`, { variable: 'SAB_RUN_MODE' });
    }

    const home = (env.SAB_HOME ?? LAYOUT.data).trim();
    if (!home.startsWith('/')) return fail('CONFIG_INVALID', 'SAB_HOME 必须是绝对路径。', { variable: 'SAB_HOME' });
    const normalizedHome = path.posix.normalize(home);
    if (normalizedHome !== path.posix.normalize(LAYOUT.data)) {
        return fail('CONFIG_INVALID', `SAB_HOME 必须位于预期数据挂载 ${LAYOUT.data}（收到 ${home}）。`, {
            variable: 'SAB_HOME'
        });
    }

    const webDist = (env.SAB_WEB_DIST ?? LAYOUT.web).trim();
    if (webDist !== LAYOUT.web) {
        return fail('CONFIG_INVALID', `SAB_WEB_DIST 在镜像中是固定资产目录 ${LAYOUT.web}（收到 ${webDist}）。`, {
            variable: 'SAB_WEB_DIST'
        });
    }

    const httpPortResult = intInRange(env.SAB_HTTP_PORT, { name: 'SAB_HTTP_PORT', min: 1024, max: 65535, fallback: 17655 });
    if (httpPortResult.error) return fail('CONFIG_INVALID', httpPortResult.error, { variable: 'SAB_HTTP_PORT' });
    const httpPort = httpPortResult.value;

    let publicBase;
    try {
        publicBase = resolvePublicBaseUrl({ explicit: env.SAB_PUBLIC_BASE_URL, httpPort });
    } catch (error) {
        return fail('CONFIG_INVALID', error.message, { variable: 'SAB_PUBLIC_BASE_URL' });
    }

    const desktopResult = boolValue(env.SAB_DESKTOP_ENABLED, false);
    if (desktopResult.error) return fail('CONFIG_INVALID', `SAB_DESKTOP_ENABLED ${desktopResult.error}`, { variable: 'SAB_DESKTOP_ENABLED' });
    const desktopEnabled = desktopResult.value;
    if (desktopEnabled && mode !== 'game') {
        return fail('CONFIG_INVALID', '只有 game 模式可以启用桌面（SAB_DESKTOP_ENABLED=true）。', {
            variable: 'SAB_DESKTOP_ENABLED'
        });
    }

    const novncPortResult = intInRange(env.SAB_NOVNC_PORT, { name: 'SAB_NOVNC_PORT', min: 1024, max: 65535, fallback: 6080 });
    if (novncPortResult.error) return fail('CONFIG_INVALID', novncPortResult.error, { variable: 'SAB_NOVNC_PORT' });
    const novncPort = novncPortResult.value;
    if (novncPort === httpPort) {
        return fail('CONFIG_INVALID', 'SAB_NOVNC_PORT 不能与 SAB_HTTP_PORT 相同。', { variable: 'SAB_NOVNC_PORT' });
    }

    let desktopBase = null;
    if (desktopEnabled) {
        try {
            desktopBase = resolveDesktopBaseUrlCompat({ explicit: env.SAB_DESKTOP_BASE_URL, novncPort });
        } catch (error) {
            return fail('CONFIG_INVALID', error.message, { variable: 'SAB_DESKTOP_BASE_URL' });
        }
    }

    const startupResult = intInRange(env.SAB_STARTUP_TIMEOUT_MS, {
        name: 'SAB_STARTUP_TIMEOUT_MS',
        min: 10_000,
        max: 900_000,
        fallback: 180_000
    });
    if (startupResult.error) return fail('CONFIG_INVALID', startupResult.error, { variable: 'SAB_STARTUP_TIMEOUT_MS' });
    // 上限 40 秒：必须小于 Compose stop grace（45 秒），否则容器会被强制杀死。
    const shutdownResult = intInRange(env.SAB_SHUTDOWN_TIMEOUT_MS, {
        name: 'SAB_SHUTDOWN_TIMEOUT_MS',
        min: 5_000,
        max: 40_000,
        fallback: 35_000
    });
    if (shutdownResult.error) return fail('CONFIG_INVALID', shutdownResult.error, { variable: 'SAB_SHUTDOWN_TIMEOUT_MS' });

    const displaySize = (env.SAB_DISPLAY_SIZE ?? '1280x720').trim();
    if (!ALLOWED_DISPLAY_SIZES.includes(displaySize)) {
        return fail('CONFIG_INVALID', `SAB_DISPLAY_SIZE 只接受预设值 ${ALLOWED_DISPLAY_SIZES.join(' / ')}（收到 ${displaySize}）。`, {
            variable: 'SAB_DISPLAY_SIZE'
        });
    }

    const logLevel = (env.SAB_LOG_LEVEL ?? 'info').trim();
    if (!LOG_LEVELS.includes(logLevel)) {
        return fail('CONFIG_INVALID', `SAB_LOG_LEVEL 只接受 ${LOG_LEVELS.join(' / ')}（收到 ${logLevel}）。`, {
            variable: 'SAB_LOG_LEVEL'
        });
    }

    const gameRoot = (env.SAB_GAME_ROOT ?? `${LAYOUT.gameWork}/current`).trim();
    if (!gameRoot.startsWith('/')) return fail('CONFIG_INVALID', 'SAB_GAME_ROOT 必须是绝对路径。', { variable: 'SAB_GAME_ROOT' });
    const normalizedGameRoot = path.posix.normalize(gameRoot);
    if (normalizedGameRoot === path.posix.normalize(LAYOUT.inputGame) || normalizedGameRoot.startsWith(`${LAYOUT.inputGame}/`)) {
        return fail('CONFIG_INVALID', `SAB_GAME_ROOT 不能指向只读输入目录 ${LAYOUT.inputGame}，必须是受管理工作副本。`, {
            variable: 'SAB_GAME_ROOT'
        });
    }
    if (normalizedGameRoot !== `${LAYOUT.gameWork}/current`) {
        return fail('CONFIG_INVALID', `SAB_GAME_ROOT 必须位于工作卷 ${LAYOUT.gameWork} 之内（收到 ${gameRoot}）。`, {
            variable: 'SAB_GAME_ROOT'
        });
    }

    const modArtifacts = (env.SAB_MOD_ARTIFACTS ?? `${LAYOUT.inputMod}/current`).trim();
    if (!modArtifacts.startsWith('/')) return fail('CONFIG_INVALID', 'SAB_MOD_ARTIFACTS 必须是绝对路径。', { variable: 'SAB_MOD_ARTIFACTS' });
    const normalizedMod = path.posix.normalize(modArtifacts);
    if (!normalizedMod.startsWith(`${LAYOUT.inputMod}/`)) {
        return fail('CONFIG_INVALID', `SAB_MOD_ARTIFACTS 必须位于 ${LAYOUT.inputMod} 之内（收到 ${modArtifacts}）。`, {
            variable: 'SAB_MOD_ARTIFACTS'
        });
    }

    const vncPasswordFile = (env.SAB_VNC_PASSWORD_FILE ?? `${LAYOUT.secrets}/sab_vnc_password`).trim();
    if (!vncPasswordFile.startsWith('/')) {
        return fail('CONFIG_INVALID', 'SAB_VNC_PASSWORD_FILE 必须是绝对路径。', { variable: 'SAB_VNC_PASSWORD_FILE' });
    }

    const clientId = (env.SAB_CLIENT_ID ?? 'stdio').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(clientId)) {
        return fail('CONFIG_INVALID', 'SAB_CLIENT_ID 需 2–40 位字母、数字、下划线或横线，并以字母/数字开头。', {
            variable: 'SAB_CLIENT_ID'
        });
    }

    const adapterUrl = (env.SAB_URL ?? `http://127.0.0.1:${PORTS.bridgeInternal}`).trim();
    if (adapterUrl.includes('/mcp')) {
        return fail('CONFIG_INVALID', 'SAB_URL 必须是 Bridge 根 URL，不能包含 /mcp（适配器自己追加 /api/v1/tool/...）。', {
            variable: 'SAB_URL'
        });
    }
    if (adapterUrl !== `http://127.0.0.1:${PORTS.bridgeInternal}`) {
        return fail('CONFIG_INVALID', `SAB_URL 只接受容器内回环根地址（形如 http://127.0.0.1:${PORTS.bridgeInternal}）。`, {
            variable: 'SAB_URL'
        });
    }

    return {
        ok: true,
        code: 'OK',
        exitCode: 0,
        config: {
            mode,
            home: normalizedHome,
            webDist,
            httpPort,
            publicBase,
            publicMcpUrl: `${publicBase.baseUrl}/mcp`,
            desktopEnabled,
            novncPort,
            desktopBase,
            startupTimeoutMs: startupResult.value,
            shutdownTimeoutMs: shutdownResult.value,
            displaySize,
            logLevel,
            gameRoot: normalizedGameRoot,
            modArtifacts: normalizedMod,
            vncPasswordFile,
            clientId,
            adapterUrl,
            ports: { ...PORTS }
        }
    };
}

/** JSON 模式统一输出：{ok, code, message, details}，退出码与 code 一致。 */
export function emitResult(result, { json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    const exitCode = result.ok ? 0 : result.exitCode ?? EXIT_BY_CODE[result.code] ?? 1;
    if (json) {
        stdout.write(
            `${JSON.stringify({ ok: result.ok === true, code: result.code ?? (result.ok ? 'OK' : 'UNKNOWN'), message: result.message ?? '', details: result.details ?? {} }, null, 2)}\n`
        );
        return exitCode;
    }
    if (!result.ok) stderr.write(`${result.code}: ${result.message}\n`);
    else if (result.message) stdout.write(`${result.message}\n`);
    return exitCode;
}
