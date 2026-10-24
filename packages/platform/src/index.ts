/**
 * `@sab/platform`：纯 Node 平台辅助包。
 *
 * 边界：不依赖 server、MCP 或游戏控制核心；只有 server 与 stdio adapter（以及构建脚本）
 * 依赖它。所有规则都是纯函数 + 可注入环境，便于用同一份测试向量核对 Node 与 C# 的一致性。
 */
export * from './data-root.js';
export * from './fs-safe.js';
export * from './steam.js';
export * from './owned-process.js';
export * from './desktop-entry.js';
export * from './runtime.js';
export * from './shutdown.js';
