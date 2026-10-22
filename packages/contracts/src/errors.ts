/**
 * 稳定错误码表。所有面向 Agent 的错误必须使用这里的 code，
 * 并同时给出 `effectKnown`（副作用是否可判定）与 `nextAction`（恢复动作）。
 */
import type { BridgeFault, NextAction } from './protocol.js';

export interface ErrorCodeSpec {
    /** 中文默认说明（可被具体上下文覆盖）。 */
    message: string;
    /** 默认副作用可判定性：拒绝类错误为 true（确认没有发生效果）。 */
    effectKnown: boolean;
    nextAction: NextAction;
}

export const ERROR_CODES = {
    GAME_UNAVAILABLE: {
        message: '游戏或 SMAPI Mod 未连接：请确认星露谷已通过 SMAPI 启动，并已加载桥接 Mod。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    NO_SAVE_LOADED: {
        message: '当前没有已加载的存档（位于标题页或正在加载）。',
        effectKnown: true,
        nextAction: 'observe'
    },
    PROTOCOL_MISMATCH: {
        message: 'Mod 内部协议与 Bridge 不兼容，已停止派发写动作。',
        effectKnown: true,
        nextAction: 'upgrade'
    },
    AUTH_FAILED: {
        message: '认证失败：凭据缺失、错误或已吊销。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    ORIGIN_REJECTED: {
        message: '请求来源不被允许（Origin/Host 校验失败）。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    CONTROL_REQUIRED: {
        message: '写动作需要显式控制会话：请先调用 stardew_session(operation=start)。',
        effectKnown: true,
        nextAction: 'restart_control'
    },
    CONTROL_BUSY: {
        message: '当前已有其他控制者持有控制权，不能抢占。',
        effectKnown: true,
        nextAction: 'restart_control'
    },
    CONTROL_EXPIRED: {
        message: '控制会话已结束或租约到期，旧请求不能继续写入。',
        effectKnown: true,
        nextAction: 'restart_control'
    },
    ACTION_BUSY: {
        message: '已有游戏动作正在执行；只允许一个活动写动作，不提供隐式排队。',
        effectKnown: true,
        nextAction: 'stop'
    },
    INVALID_ARGUMENT: {
        message: '参数不合法。',
        effectKnown: true,
        nextAction: 'none'
    },
    UNSUPPORTED: {
        message: '当前版本不支持该操作或该游戏模式。',
        effectKnown: true,
        nextAction: 'none'
    },
    STALE_REF: {
        message: '目标引用已过期（换图、重开菜单或对象改变），请重新 snapshot。',
        effectKnown: true,
        nextAction: 'observe'
    },
    WORLD_CHANGED: {
        message: '存档世界已改变（加载/卸载/跨日），旧会话与引用失效。',
        effectKnown: true,
        nextAction: 'restart_control'
    },
    MENU_MISMATCH: {
        message: '菜单已改变，旧菜单选项不再有效，请重新 snapshot。',
        effectKnown: true,
        nextAction: 'observe'
    },
    IDEMPOTENCY_CONFLICT: {
        message: '同一 actionId 已用于不同参数；原收据不会被覆盖。',
        effectKnown: true,
        nextAction: 'query_action'
    },
    RESULT_UNKNOWN: {
        message: '动作结果不明：请 stop、查询原收据并重新观察，不要用新 ID 重做消费动作。',
        effectKnown: false,
        nextAction: 'query_action'
    },
    INSUFFICIENT_RESOURCE: {
        message: '资源不足（金钱、物品、材料、体力或背包空间）。',
        effectKnown: true,
        nextAction: 'observe'
    },
    OUTPUT_LIMIT: {
        message: '输出超过限制：请缩小观察半径或读取范围。',
        effectKnown: true,
        nextAction: 'observe'
    },
    JOURNAL_UNAVAILABLE: {
        message: '动作账本不可写（磁盘或权限问题），已拒绝派发写动作。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    PATH_BLOCKED: {
        message: '寻路失败：目标不可达或被动态障碍阻挡。',
        effectKnown: true,
        nextAction: 'observe'
    },
    OUT_OF_REACH: {
        message: '目标不在交互距离内，请先 move 到相邻格。',
        effectKnown: true,
        nextAction: 'observe'
    },
    NOT_FOUND: {
        message: '目标不存在（地图、存档或对象）。',
        effectKnown: true,
        nextAction: 'observe'
    },
    SAVE_NOT_FOUND: {
        message: '存档标识不存在：请用 stardew_saves 获取精确 saveId。',
        effectKnown: true,
        nextAction: 'observe'
    },
    MULTIPLAYER_UNSUPPORTED: {
        message: '首版只支持单人存档。',
        effectKnown: true,
        nextAction: 'none'
    },
    PAUSE_BLOCKED: {
        message: '当前无法正常暂停（剧情、过渡或用户菜单）。输入已释放，暂停状态以实际回执为准。',
        effectKnown: true,
        nextAction: 'observe'
    },
    CANCELLED: {
        message: '动作已按要求停止。',
        effectKnown: true,
        nextAction: 'observe'
    },
    TIMEOUT: {
        message: '动作或请求超时，已停止后续输入。',
        effectKnown: false,
        nextAction: 'query_action'
    },
    BRIDGE_NOT_RUNNING: {
        message: '本地 Bridge 服务未运行：请先启动 Stardew Agent Bridge（scripts/start-bridge 或 npm start）。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    RATE_LIMITED: {
        message: '请求过于频繁，已被本地限流。',
        effectKnown: true,
        nextAction: 'wait'
    },
    CONFIG_INVALID: {
        message: '本地配置不合法，请检查配置文件。',
        effectKnown: true,
        nextAction: 'fix_environment'
    },
    INTERNAL_ERROR: {
        message: '桥接内部异常，请查看本地日志。',
        effectKnown: false,
        nextAction: 'query_action'
    }
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: string): value is ErrorCode {
    return Object.hasOwn(ERROR_CODES, value);
}

/** 构造一个符合契约的 BridgeFault。 */
export function makeFault(
    code: string,
    message?: string,
    overrides?: Partial<Pick<BridgeFault, 'effectKnown' | 'nextAction' | 'detail'>>
): BridgeFault {
    const spec = isErrorCode(code) ? ERROR_CODES[code] : null;
    return {
        code,
        message: message ?? spec?.message ?? '未知错误。',
        effectKnown: overrides?.effectKnown ?? spec?.effectKnown ?? false,
        nextAction: overrides?.nextAction ?? spec?.nextAction ?? 'query_action',
        detail: overrides?.detail ?? null
    };
}

/** 业务错误：可安全跨层抛出，最终映射为 BridgeFault。 */
export class BridgeError extends Error {
    readonly fault: BridgeFault;

    constructor(code: string, message?: string, overrides?: Partial<Pick<BridgeFault, 'effectKnown' | 'nextAction' | 'detail'>>) {
        const fault = makeFault(code, message, overrides);
        super(fault.message);
        this.name = 'BridgeError';
        this.fault = fault;
    }

    static from(error: unknown, fallback: string = 'INTERNAL_ERROR'): BridgeError {
        if (error instanceof BridgeError) return error;
        const message = error instanceof Error ? error.message : String(error);
        return new BridgeError(fallback, message);
    }
}

/** Old Mod 错误码 → 新契约错误码。 */
const MOD_CODE_MAP: Record<string, ErrorCode> = {
    INCOMPATIBLE_PROTOCOL: 'PROTOCOL_MISMATCH',
    BUSY: 'ACTION_BUSY',
    UNSUPPORTED: 'UNSUPPORTED',
    NO_SAVE_LOADED: 'NO_SAVE_LOADED',
    STALE_REF: 'STALE_REF',
    MENU_MISMATCH: 'MENU_MISMATCH',
    INVALID_ARGUMENT: 'INVALID_ARGUMENT',
    INSUFFICIENT_RESOURCE: 'INSUFFICIENT_RESOURCE',
    OUTPUT_LIMIT: 'OUTPUT_LIMIT',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    PATH_BLOCKED: 'PATH_BLOCKED',
    OUT_OF_REACH: 'OUT_OF_REACH',
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    // 常见业务别名：Mod 侧报“钱不够/背包满”时归到统一资源错误码。
    NOT_ENOUGH_MONEY: 'INSUFFICIENT_RESOURCE',
    INSUFFICIENT_GOLD: 'INSUFFICIENT_RESOURCE',
    NOT_ENOUGH_ITEMS: 'INSUFFICIENT_RESOURCE',
    INVENTORY_FULL: 'INSUFFICIENT_RESOURCE'
};

export function normalizeModCode(code: string | undefined): ErrorCode {
    if (!code) return 'INTERNAL_ERROR';
    if (isErrorCode(code)) return code;
    return MOD_CODE_MAP[code] ?? 'INTERNAL_ERROR';
}
