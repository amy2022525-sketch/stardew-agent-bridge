# NOTICE — 来源与第三方组件

## 1. 本项目许可

MIT License，见根目录 `LICENSE`。项目对外名称为 **Stardew Agent Bridge**，首个独立版本 `0.1.0`。

## 2. 迁移来源（游戏侧 Mod 与动作语义）

| 项目 | 内容 |
| --- | --- |
| 仓库 | `https://github.com/rottenpen/agent-stardew` |
| 固定提交 | `d1f8934351a0b50506cfc0c5f1149dd0bbc5d87f` |
| 许可 | MIT，`Copyright (c) 2026 agent-stardew contributors` |
| 迁移范围 | SMAPI Mod 的观察、正常动作、逐帧实时输入、动作串行与后验语义；以及旧 DSH 适配器中的协议与参数约束 |
| 未迁移 | 旧 `.git`、构建产物、游戏 DLL、存档、个人配置、Jev 决策层、用户输出 |

逐文件的迁移处置与源文件 SHA-256 记录见 `docs/MIGRATION.md`。本机 0.3.0 实现包含未提交改动，迁移以本机工作区文件为准并已记录哈希。

## 3. 第三方运行时依赖（Node 侧）

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 | MCP 服务端实现（v2 稳定线） |
| `@modelcontextprotocol/client` | 2.3.1 | Apache-2.0 | 测试与诊断用 MCP 客户端 |
| `zod` | 4.x（随 SDK） | MIT | SDK 内部 schema |
| `ws` | 8.22.0 | MIT | Bridge ↔ Mod 本地 WebSocket |
| `ajv` | 8.20.0 | MIT | 工具参数与业务边界校验 |
| `typescript` | 5.9.3 | Apache-2.0 | 构建（开发依赖） |
| `esbuild` | 0.28.2 | MIT | Web 控制台打包（开发依赖） |
| `node:sqlite` | Node.js 内置 | Node.js 许可 | 动作账本持久化 |

精确版本与完整性哈希由 `package-lock.json` 固定。

## 4. 未包含的游戏内容

本项目**不包含也不分发**任何 Stardew Valley 游戏文件、DLL、图像、音频、字体或存档。游戏引用在构建时由用户本机安装路径提供（`STARDEW_GAME_PATH`），发布包只包含本项目自己的 Mod DLL、服务端、Web 产物与适配器。

Stardew Valley 是 ConcernedApe 的商标与版权作品；SMAPI 由 Pathoschild 维护。本项目与二者均无从属关系。

## 5. 无遥测

本项目默认不收集任何遥测数据。问题包由用户主动导出，导出前可预览，脱敏内容包括凭据、用户名、完整路径与存档标识。
