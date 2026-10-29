/**
 * Docker 模式 Web 展示逻辑（纯函数，无 DOM/无网络），实现见本文件。
 *
 * 数据源是网关的净化状态 GET /container/live（同源）。原生（非 Docker）部署
 * 没有该端点（404）——功能整体隐藏，不影响原有页面。
 * 约束（任务书 §10.2/§12.2）：提示来自净化状态；桌面按钮只允许规范回环 URL、
 * 新标签页 + noopener，不带密码；noVNC 可用 ≠ 游戏已载入或 Agent 已接入。
 */

/** 解析后的 Docker 状态（只接收白名单字段）。 */
export function parseDockerStatus(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw;
    if (record.schemaVersion !== 1) return null;
    if (record.mode !== 'bridge' && record.mode !== 'game') return null;
    if (typeof record.state !== 'string') return null;
    const bool = value => value === true;
    return {
        schemaVersion: 1,
        mode: record.mode,
        state: record.state,
        live: bool(record.live),
        modConnected: bool(record.modConnected),
        saveLoaded: bool(record.saveLoaded),
        desktopEnabled: bool(record.desktopEnabled),
        desktopAvailable: bool(record.desktopAvailable),
        reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode : '',
        desktopBaseUrl: typeof record.desktopBaseUrl === 'string' ? record.desktopBaseUrl : null
    };
}

/** 拉取 Docker 状态：404（原生部署）返回 null；503（启动中）仍解析状态体。 */
export async function fetchDockerStatus(fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl('/container/live', { headers: { accept: 'application/json' } });
    } catch {
        return null;
    }
    if (response.status === 404) return null;
    let body = null;
    try {
        body = await response.json();
    } catch {
        return null;
    }
    return parseDockerStatus(body);
}

/**
 * 桌面按钮地址：仅接受规范回环 URL（http + 127.0.0.1/localhost + 显式端口），
 * 且要求状态声明桌面可用。任何其他形态一律不显示按钮。
 */
export function desktopLinkUrl(status) {
    if (!status || status.desktopAvailable !== true) return null;
    const url = status.desktopBaseUrl;
    if (typeof url !== 'string') return null;
    if (!/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{3,4}$/.test(url)) return null;
    if (Number(url.slice(url.lastIndexOf(':') + 1)) > 65535) return null;
    return url;
}

const STATE_LABELS = {
    created: '已创建',
    preflight: '预检中',
    preparing_workdir: '准备工作副本',
    starting_bridge: '启动 Bridge',
    starting_gateway: '启动网关',
    starting_display: '启动虚拟显示',
    starting_game: '启动游戏',
    awaiting_mod: '等待 Mod 握手',
    awaiting_save: '等待载入存档',
    ready: '游戏就绪',
    bridge_ready: 'Bridge 就绪',
    stopping: '停止中',
    stopped: '已停止',
    failed: '启动失败'
};

/** 按模式/状态生成用户提示（标题 + 一句话说明）。 */
export function dockerStatusHint(status) {
    if (!status) return null;
    const stateLabel = STATE_LABELS[status.state] ?? status.state;
    if (status.state === 'failed') {
        return { title: `容器启动失败（${status.reasonCode || '未知原因'}）`, detail: '查看容器日志定位原因；本页面显示的是网关净化状态，不含敏感信息。' };
    }
    if (['stopping', 'stopped'].includes(status.state)) {
        return { title: `容器${stateLabel}`, detail: '容器不在运行；如需继续请通过宿主管理工具再次启动。' };
    }
    if (status.mode === 'bridge') {
        return {
            title: 'Docker bridge 模式（无游戏）',
            detail: '容器内没有游戏：可正常使用工具发现、配置生成与诊断；游戏类工具调用会如实报告未连接。'
        };
    }
    if (status.state === 'awaiting_save') {
        return {
            title: '游戏在标题页：等待载入存档',
            detail: '容器已健康（标题页可正常等待）。让 Agent 载入单人存档后即可观察和游玩；存档加载不是自动动作。'
        };
    }
    if (!status.saveLoaded) {
        return { title: `Docker game 模式 · ${stateLabel}`, detail: '游戏组件仍在启动或等待握手；就绪后此处会更新。' };
    }
    return {
        title: `Docker game 模式 · ${stateLabel}`,
        detail: status.desktopEnabled && !status.desktopAvailable
            ? '游戏运行中；桌面辅助通道降级，不影响 Agent 控制与截图。'
            : '游戏运行中；截图与观察走游戏 Mod，不依赖桌面通道。'
    };
}
