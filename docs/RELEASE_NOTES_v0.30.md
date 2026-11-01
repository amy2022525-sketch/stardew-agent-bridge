# Stardew Agent Bridge v0.30：AI 任务助手

日期：2026-11-01。发行标签 **v0.30**，程序与附件版本 **0.3.0**，本版保留预览标记。

让 DSH、Codex、Claude Code 等支持 MCP 的 Agent 一起接入你的星露谷。你可以继续让主 Agent 直接操作，也可以使用本版新增的“AI 任务助手”：主 Agent 交代任务，项目再持续调用你配置的执行模型，观察游戏、执行动作并核对结果。

## 本次更新

- **可选 AI 任务助手。** 在网页配置模型 API 或本地模型，交给执行模型处理具体步骤；主 Agent 可查询进度和结果。默认关闭，不会因打开网页或保存配置自动发起模型请求；显式“检测模型”会发起测试请求。
- **任务与记忆。** 新增任务状态、动作依据、预算与记忆管理，支持暂停、取消、人工复核。需要 API 服务时，由玩家自行配置并承担该服务的用量。
- **随时接管。** 网页或 F9 可中断自动执行；停止后需要明确重新允许。网页可管理其他 Agent 的任务，任务归属保持原样。
- **更可靠的执行。** 修复真实 Mod 作物识别、空水壶补水、模型等待期间状态变化、授权撤销、工具/物品限制和政策交集等问题；未知动作结果不会自动重放。
- **更清楚的网页。** 修复首次保存模型配置丢值、完成进度和剩余工作显示；补充手机窄屏布局及隔离浏览器检查。
- **连接与分发。** 修复模型长响应在复用连接时提前超时的问题；工具从 29 个增至 33 个。统一各平台版本与发行来源，Windows/Linux 包附本版说明。

本版没有新增联机玩法。已有 MP1 联机功能继续按预览范围提供；AI 任务助手暂不支持在联机模式自动执行任务。

## 选择下载

发行包名中的 `0.3.0` 与本页 `v0.30` 是同一个版本。

| 附件 | 用途与要求 |
| --- | --- |
| `StardewAgentBridge-0.3.0-windows-x64.zip` | Windows 完整包，含 Bridge、Web、Mod；需系统 Node >=22.13。解压后运行 `Start-Bridge.cmd`。 |
| `StardewAgentBridge-0.3.0-linux-x64.tar.gz` | Linux x64 完整包，含 Mod 和已校验的官方 Node 22.13.0。入口 `bin/stardew-agent-bridge`。 |
| `StardewAgentBridge-0.3.0-mod.zip` | 独立 SMAPI Mod；需同版 Bridge、合法游戏及 SMAPI 4.5.2+。Windows/Linux 共用 net6.0 x64 程序集。 |
| `StardewAgentBridge-0.3.0-docker-source.zip` | 完整公开源码、Docker Compose 与管理脚本，可本地重建。宿主管理工具需 Node >=22.13，Compose >=2.24。 |
| `StardewAgentBridge-0.3.0-docker-bridge-runtime-amd64.tar.gz` | Linux amd64 离线 Bridge 镜像，可运行 Web/MCP。 |
| `StardewAgentBridge-0.3.0-docker-game-runtime-amd64.tar.gz` | Linux amd64 图形运行环境，含可选 noVNC；需自行提供合法 Linux 游戏及 SMAPI。 |
| `StardewAgentBridge-0.3.0-docker-mod-build-amd64.tar.gz` | Linux amd64 Mod 构建工具；需自己的游戏编译引用。 |

另附 3 份 `DockerImage-*.json`、`RELEASE_MANIFEST.json` 和 `SHA256SUMS.txt`，共 **12 个附件**。这些附件不包含游戏本体、SMAPI 安装文件、存档或真实凭据；GitHub 自动提供的源码归档是额外下载项。

Docker 导入示例：

```bash
gzip -dc StardewAgentBridge-0.3.0-docker-bridge-runtime-amd64.tar.gz | docker load
```

镜像保留 `local/stardew-agent-bridge:bridge-runtime` 和 `local/stardew-agent-bridge:0.3.0-bridge-runtime` 标签；另外两种镜像相应使用 `game-runtime`、`mod-build`。无需登录镜像仓库。

## 升级与使用

1. 保留现有存档、配置和数据根备份，停止旧 Bridge 并保存退出游戏后再替换 Mod。
2. 下载同版完整包，或搭配同版 Bridge 与独立 Mod；不要只替换网页文件。MCP 地址与既有直控工具保持兼容。
3. 启动 Bridge，打开网页的“AI 任务助手”，按需配置并显式检测模型。只有你决定开启和允许后，才开始自动任务。
4. 建议先用独立测试存档和有限模型预算尝试短任务。需要停止时，在网页接管或按 F9。

旧 `0.2.0-preview.1` 没有任务助手。新版本默认关闭任务助手；既有 DSH/Codex 直接控制方式仍可使用。首次启用后会在现有数据根的 `decision/` 保存独立配置、凭据、任务和记忆；不要把该目录上传到公开仓库。

## 验证范围与已知限制

本轮独立复核已通过 Windows 类型检查、构建、297 项 Node 测试（292 通过、5 项平台跳过、0 失败）、189 项 Mod 隔离检查、17 项安装/回退 fixture、实际 Mod DLL 编译与 15 项 Windows 包检查，并完成部分真实浏览器连接 Mock/Fake 的验收。

正式发行资产的最终来源、跨平台 CI、Linux 完整包、Docker 构建与桌面检查，以附件 `RELEASE_MANIFEST.json` 和 `DockerImage-*.json` 的记录为准。自动化与 Mock 成功不表示真实模型、真实游戏或所有验收项目已通过。

仍未验收：任务助手真实 API/本地模型与游戏闭环、完整 F9/断线故障矩阵、原生 Linux 游戏、Docker 游戏/SMAPI/存档操作、MP1 双客户端、长期连续游玩及效率对比。任务助手首版主要围绕受限的作物照料与自定义政策；不能按通用全自动通关功能理解。

安装与接入：[项目说明](https://github.com/amy2022525-sketch/stardew-agent-bridge/tree/v0.30) · [任务助手](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/v0.30/docs/DECISION_EXECUTOR.md) · [Linux](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/v0.30/docs/LINUX_INSTALL.md) · [Docker](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/v0.30/docs/DOCKER_INSTALL.md)。

## English

v0.30 (application version 0.3.0) introduces an optional task assistant. DSH, Codex, Claude Code or another MCP-capable primary agent delegates tasks, while the bridge calls a model configured in the web console. It is disabled by default. Task history, memory, budgets, evidence and manual takeover are included, alongside fixes to crop/refill handling, authorization, policies, connection reuse and web configuration.

Windows/Linux packages, a standalone Mod, the Docker source toolkit and three offline amd64 images are provided with hashes and provenance. Existing direct MCP control remains available. Real-model/gameplay acceptance, native Linux gameplay, Docker gameplay and two-client MP1 remain pending; this release is a preview.
