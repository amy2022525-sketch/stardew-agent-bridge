/**
 * 退出清理：只释放本次进程持有的资源。
 *
 * - Bridge：SIGINT/SIGTERM 停止自己的活动动作、释放输入与连接、关闭 SQLite、
 *   只移除本次所有权的锁与 endpoint；
 * - stdio adapter：SIGINT/SIGTERM 或宿主关闭 stdin 时只关闭适配器自己与在途请求，
 *   不结束共享 Bridge；
 * - 重复信号只执行一次清理，异常不阻止进程退出。
 */
export interface ShutdownHookOptions {
    name: string;
    /** 清理函数，需幂等。 */
    cleanup: () => Promise<void> | void;
    /** 是否在 stdin 关闭时也触发（stdio 适配器用 true）。 */
    watchStdin?: boolean;
    /** 超时后强制退出码；0 表示正常退出。 */
    exitCode?: number;
    /** 日志（写 stderr 或 Bridge 日志），默认静默。 */
    log?: (message: string) => void;
    /** 注入退出函数便于测试。 */
    exit?: (code: number) => void;
    /** 注入信号注册便于测试。 */
    onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
}

export interface ShutdownHandle {
    /** 主动触发一次清理（幂等）。 */
    trigger: (reason: string) => Promise<void>;
    /** 是否已完成清理。 */
    readonly done: boolean;
    /** 移除已注册的监听（测试用）。 */
    dispose: () => void;
}

export function installShutdownHooks(options: ShutdownHookOptions): ShutdownHandle {
    const log = options.log ?? (() => {});
    const exit = options.exit ?? ((code: number) => process.exit(code));
    const onSignal =
        options.onSignal ??
        ((signal: NodeJS.Signals, handler: () => void) => {
            process.on(signal, handler);
        });
    const listeners: { signal: NodeJS.Signals; handler: () => void }[] = [];
    let done = false;
    let running: Promise<void> | null = null;

    const trigger = async (reason: string): Promise<void> => {
        if (done) return;
        if (running) {
            await running;
            return;
        }
        log(`收到 ${reason}：正在清理 ${options.name} 自己的资源…`);
        running = (async () => {
            try {
                await options.cleanup();
            } catch (error) {
                log(`清理失败：${error instanceof Error ? error.message : String(error)}`);
            } finally {
                done = true;
                exit(options.exitCode ?? 0);
            }
        })();
        await running;
    };

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
        const handler = () => {
            void trigger(signal);
        };
        try {
            onSignal(signal, handler);
            listeners.push({ signal, handler });
        } catch {
            /* 某些信号在 Windows 上不可注册；忽略即可。 */
        }
    }

    const stdin = options.stdin ?? process.stdin;
    const stdinHandler = () => {
        void trigger('stdin closed');
    };
    if (options.watchStdin) {
        try {
            stdin.on('end', stdinHandler);
            stdin.on('close', stdinHandler);
        } catch {
            /* 无 stdin 时忽略 */
        }
    }

    return {
        trigger,
        get done() {
            return done;
        },
        dispose: () => {
            for (const { signal, handler } of listeners) {
                try {
                    process.removeListener(signal, handler);
                } catch {
                    /* 忽略 */
                }
            }
            if (options.watchStdin) {
                try {
                    stdin.removeListener('end', stdinHandler);
                    stdin.removeListener('close', stdinHandler);
                } catch {
                    /* 忽略 */
                }
            }
        }
    };
}
