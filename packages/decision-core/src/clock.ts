/**
 * 可注入时钟：所有状态机计时经此获取，测试可推进虚拟时间。
 * sleep 与 AbortSignal 绑定；取消时以 AbortError 拒绝，调用方不得把取消当作用户停止锁之外的自动恢复信号。
 */
export interface Clock {
    now(): Date;
    /** 毫秒时间戳；预算/租约/超时计算统一用它，避免各处重复 Date.now()。 */
    nowMs(): number;
    nowIso(): string;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
    now(): Date {
        return new Date();
    },
    nowMs(): number {
        return Date.now();
    },
    nowIso(): string {
        return new Date().toISOString();
    },
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signalReason(signal));
                return;
            }
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, Math.max(0, Math.floor(ms)));
            const onAbort = () => {
                clearTimeout(timer);
                reject(signalReason(signal as AbortSignal));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
};

function signalReason(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    return new Error("aborted");
}
