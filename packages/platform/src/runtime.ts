/**
 * 运行时能力检查：Node 版本与 `node:sqlite` 可用性。
 *
 * 本版要求 Node 22.x，候选最低版本 22.13.0（22.5 引入 `node:sqlite`，22.13 起不再需要
 * `--experimental-sqlite`）。最低版本必须由最低版本实测确认，见 docs/PLATFORM_MATRIX.md。
 */
export const NODE_MINIMUM_VERSION = '22.13.0';
export const NODE_TARGET_MAJOR = 22;

export function parseVersion(value: string): [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

export interface RuntimeCheck {
    ok: boolean;
    code: 'OK' | 'NODE_VERSION_UNSUPPORTED' | 'SQLITE_UNAVAILABLE';
    message: string;
}

export function checkNodeVersion(version: string, minimum: string = NODE_MINIMUM_VERSION): RuntimeCheck {
    const parsed = parseVersion(version);
    if (!parsed) {
        return { ok: false, code: 'NODE_VERSION_UNSUPPORTED', message: `无法识别 Node 版本：${version}` };
    }
    if (compareVersions(version, minimum) < 0) {
        return {
            ok: false,
            code: 'NODE_VERSION_UNSUPPORTED',
            message:
                `当前 Node ${version} 低于本版要求的最低版本 ${minimum}。` +
                '内置 SQLite 需要更新的 22.x；请使用发布包内自带的 runtime/node，或安装 22.x。'
        };
    }
    return { ok: true, code: 'OK', message: `Node ${version} 满足最低版本 ${minimum}。` };
}

/** 真实导入 `node:sqlite`：只有能创建内存库才算可用。 */
export async function probeSqliteSupport(): Promise<RuntimeCheck> {
    try {
        const module = (await import('node:sqlite')) as { DatabaseSync?: new (path: string) => { close(): void } };
        if (typeof module.DatabaseSync !== 'function') {
            return { ok: false, code: 'SQLITE_UNAVAILABLE', message: '当前 Node 没有 node:sqlite.DatabaseSync。' };
        }
        const db = new module.DatabaseSync(':memory:');
        db.close();
        return { ok: true, code: 'OK', message: '内置 SQLite 可用（未触碰真实账本）。' };
    } catch (error) {
        return {
            ok: false,
            code: 'SQLITE_UNAVAILABLE',
            message:
                `内置 SQLite 不可用：${error instanceof Error ? error.message : String(error)}。` +
                '请升级到 22.13 以上，或使用发布包自带的运行时。'
        };
    }
}
