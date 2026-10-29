/**
 * Docker bundle 布局契约的静态核对（不启动 Docker、不跑 esbuild）。
 *
 * 背景：交接档案 P0-1 —— build.mjs 把网关 bundle 打到 server/，supervisor 却在
 * container/ 下找，镜像必坏。这里把三方契约锁死：
 *   1. build.mjs 的 BUNDLE_LAYOUT（任务书 §6.3 的产物布局）
 *   2. supervisor.mjs 引用的 bridge/gateway 入口路径
 *   3. Dockerfile 的 HEALTHCHECK/ENTRYPOINT 与 lease-entrypoint 的受控入口
 * 运行时另有 verifyBundleLayout 在出包时实测产物；两者缺一不可。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

interface BundleEntry { name: string; source: string; output: string }
interface BundleLayout { entries: readonly BundleEntry[] }

// 测试只从 tests/dist/src 运行；向上三级即仓库根。
const REPO = path.resolve(import.meta.dirname, '../../..');
const { BUNDLE_LAYOUT } = await import(pathToFileURL(path.join(REPO, 'scripts/docker/build.mjs')).href) as { BUNDLE_LAYOUT: BundleLayout };

const runtimeDir = path.join(REPO, 'scripts/docker/runtime');
const runtimeFiles = readdirSync(runtimeDir).filter(file => file.endsWith('.mjs'));
const read = (relative: string): string => readFileSync(path.join(REPO, relative), 'utf8');

/** 从形如 path.join(layout.<dir>, '<file>') 的表达式中提取产物相对路径。 */
function extractEntry(source: string, field: string): string {
    const match = source.match(new RegExp(`${field}:\\s*path\\.join\\(layout\\.(\\w+),\\s*'([^']+)'\\)`));
    assert.ok(match, `supervisor.mjs 中找不到 ${field} 的路径表达式`);
    return `${match[1]}/${match[2]}`;
}

describe('Docker bundle 布局契约', () => {
    it('BUNDLE_LAYOUT 与任务书 §6.3 的产物布局一致', () => {
        assert.deepEqual(BUNDLE_LAYOUT.entries.map(entry => entry.output), [
            'server/bridge.mjs', 'server/stdio-adapter.mjs', 'server/container-gateway.mjs'
        ]);
    });

    it('supervisor 引用的 bridge/gateway 入口与 BUNDLE_LAYOUT 完全一致', () => {
        const supervisor = read('scripts/docker/runtime/supervisor.mjs');
        for (const field of ['bridgeEntry', 'gatewayEntry'] as const) {
            const referenced = extractEntry(supervisor, field);
            const bundled = BUNDLE_LAYOUT.entries.find(entry => entry.output === referenced);
            assert.ok(bundled, `supervisor 引用的 ${field}=${referenced} 不在 BUNDLE_LAYOUT 中`);
            assert.equal(bundled.name, field === 'bridgeEntry' ? 'bridge' : 'container-gateway');
        }
    });

    it('runtime 脚本的相对导入在源码层全部可解析（出包时 verifyBundleLayout 再实测）', () => {
        const unresolved: string[] = [];
        for (const file of runtimeFiles) {
            for (const match of read(`scripts/docker/runtime/${file}`).matchAll(/(?:\bfrom\s+|\bimport\s*[(\s])'(\.\/[^']+\.mjs)'/g)) {
                const target = match[1]!.replace(/^\.\//, '');
                if (!runtimeFiles.includes(target)) unresolved.push(`${file} → ${match[1]}`);
            }
        }
        assert.deepEqual(unresolved, []);
    });

    it('lease-entrypoint 受控入口与镜像 ENTRYPOINT/HEALTHCHECK 引用的文件真实存在', () => {
        for (const entry of ['supervisor', 'maintenance', 'mod-build', 'lease-entrypoint', 'healthcheck']) {
            assert.ok(runtimeFiles.includes(`${entry}.mjs`), `scripts/docker/runtime/${entry}.mjs 缺失`);
        }
        const dockerfile = read('docker/Dockerfile');
        assert.ok(dockerfile.includes('/opt/sab/container/lease-entrypoint.mjs'), 'ENTRYPOINT 必须指向 container/lease-entrypoint.mjs');
        assert.ok(dockerfile.includes('/opt/sab/container/healthcheck.mjs'), 'HEALTHCHECK 必须指向 container/healthcheck.mjs');
        assert.ok(!dockerfile.includes('container/container-gateway.mjs'), '网关 bundle 属于 server/，不能再次指向 container/');
    });

    it('BUNDLE_LAYOUT 的 esbuild 输入都有对应 TS/JS 源文件', () => {
        const sources: Record<string, string> = {
            'apps/server/dist/cli.js': 'apps/server/src/cli.ts',
            'adapters/stdio/dist/index.js': 'adapters/stdio/src/index.ts',
            'apps/server/dist/container-gateway-entry.js': 'apps/server/src/container-gateway-entry.ts'
        };
        for (const entry of BUNDLE_LAYOUT.entries) {
            const source = sources[entry.source];
            assert.ok(source, `BUNDLE_LAYOUT 新增入口 ${entry.name} 需要登记 dist→src 映射`);
            assert.ok(existsSync(path.join(REPO, source)), `入口源文件缺失：${source}`);
        }
    });
});
