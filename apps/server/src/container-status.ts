/**
 * 容器对外净化状态。
 *
 * supervisor 把内部完整状态写入 /run/sab/status.json（0600、原子替换、含
 * generation/startNonce）；网关对外只暴露这里定义的白名单字段。绝不外泄
 * 凭据、PID、进程路径、宿主用户名、源目录或完整异常栈。
 */

export interface ContainerStatusFile {
    schemaVersion: number;
    generation: string;
    startNonce: string;
    mode: 'bridge' | 'game';
    state: string;
    live: boolean;
    modConnected: boolean;
    saveLoaded: boolean;
    desktopEnabled: boolean;
    desktopAvailable: boolean;
    reasonCode: string;
    updatedAt: string;
}

export interface SanitizedContainerStatus {
    schemaVersion: 1;
    mode: 'bridge' | 'game';
    state: string;
    live: boolean;
    modConnected: boolean;
    saveLoaded: boolean;
    desktopEnabled: boolean;
    desktopAvailable: boolean;
    reasonCode: string;
    /** 桌面入口（仅当启用且经过本机 URL 校验时为规范回环 URL；否则 null）。不含任何凭据。 */
    desktopBaseUrl: string | null;
}

const STATES = new Set([
    'created',
    'preflight',
    'preparing_workdir',
    'starting_bridge',
    'starting_gateway',
    'starting_display',
    'starting_game',
    'awaiting_mod',
    'awaiting_save',
    'ready',
    'bridge_ready',
    'stopping',
    'stopped',
    'failed'
]);

/**
 * 把磁盘上的内部状态净化为对外视图。generation 不匹配（上次启动的旧文件）
 * 或结构非法时返回 null —— 残留状态不能冒充本次健康。
 */
export function sanitizeContainerStatus(
    raw: unknown,
    expected: { generation: string; startNonce: string }
): SanitizedContainerStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (record['schemaVersion'] !== 1) return null;
    if (record['generation'] !== expected.generation || record['startNonce'] !== expected.startNonce) return null;
    if (record['mode'] !== 'bridge' && record['mode'] !== 'game') return null;
    const state = typeof record['state'] === 'string' && STATES.has(record['state']) ? record['state'] : 'failed';
    const bool = (value: unknown): boolean => value === true;
    const reasonCode = typeof record['reasonCode'] === 'string' && /^[A-Z0-9_]{1,64}$/.test(record['reasonCode']) ? record['reasonCode'] : 'UNKNOWN';
    const desktopCandidate = typeof record['desktopBaseUrl'] === 'string' ? record['desktopBaseUrl'] : '';
    const desktopBaseUrl = /^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{3,4}$/.test(desktopCandidate)
        && Number(desktopCandidate.slice(desktopCandidate.lastIndexOf(':') + 1)) <= 65535 ? desktopCandidate : null;
    return {
        schemaVersion: 1,
        mode: record['mode'],
        state,
        live: bool(record['live']) && state !== 'stopped' && state !== 'failed',
        modConnected: bool(record['modConnected']),
        saveLoaded: bool(record['saveLoaded']),
        desktopEnabled: bool(record['desktopEnabled']),
        desktopAvailable: bool(record['desktopAvailable']),
        reasonCode,
        desktopBaseUrl
    };
}
