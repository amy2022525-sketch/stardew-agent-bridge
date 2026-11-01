# Stardew Agent Bridge v0.35：AI 游玩 Skill 与持续日志

发行标签 **v0.35**，程序、Mod 和附件版本 **0.3.5**；本版保留预览标记。

## 本次更新

- 新增可携带的 `stardew-player` 技能，供 DSH、Codex、Claude Code 等主 Agent 加载。
- 包含有来源的四季、种植、采矿、钓鱼、动物照料与资源规划攻略。
- 要求维护短期检查点：当前目标、已核验进展、未决动作、下一步，支持中断续玩。
- 要求维护长期日志：玩家方向、长期目标、里程碑、失败经验及效率复盘；按世界、角色和 owner 隔离。
- 提供空白模板、MCP 记忆保存方案与导入说明；无持久存储时明确标记，不冒充已保存。
- 原生包与 Docker bundle 按固定白名单携带完整技能；私有 playlogs 不入仓库或发行包。
- 保留 v0.30 的可选任务助手与既有直接 MCP 操作。加载 Skill 后由主 Agent 实际写日志，后台执行模型不会自动读取整个 Skill。

## 下载选择

附件中的 0.3.5 与发行标签 v0.35 是同一版本。

| 附件 | 用途 |
| --- | --- |
| `StardewAgentBridge-0.3.5-windows-x64.zip` | Windows 完整包，需系统 Node >=22.13，运行 Start-Bridge.cmd |
| `StardewAgentBridge-0.3.5-linux-x64.tar.gz` | Linux x64 完整包，含已校验的官方 Node 22.13.0 |
| `StardewAgentBridge-0.3.5-mod.zip` | 独立 Mod，需同版 Bridge、合法游戏及 SMAPI 4.5.2+ |
| `StardewAgentBridge-0.3.5-docker-source.zip` | 完整源码、Compose 与管理脚本，含技能目录 |
| `StardewAgentBridge-0.3.5-docker-bridge-runtime-amd64.tar.gz` | 离线 Bridge 镜像 |
| `StardewAgentBridge-0.3.5-docker-game-runtime-amd64.tar.gz` | 图形环境镜像，游戏和 SMAPI 由玩家自备 |
| `StardewAgentBridge-0.3.5-docker-mod-build-amd64.tar.gz` | Mod 构建工具镜像，编译引用由玩家自备 |

另附三份 DockerImage 来源证明、RELEASE_MANIFEST.json 和 SHA256SUMS.txt，共 12 个附件。技能在完整原生包的 skills/stardew-player/；独立 Mod 不承载主 Agent 技能。

## 使用与升级

保存退出游戏并备份配置、存档和数据根，再更新同版 Bridge/Mod。将完整 stardew-player 文件夹交给宿主加载，先按日志核对当前世界，再推进一个小目标。日志存宿主可写目录或实际可用的 MCP 记忆服务，不写入只读安装目录。

最终构建、Windows/Linux 测试、便携包及 Docker 检查以附件 RELEASE_MANIFEST.json 中的同一来源提交与成功 CI 为准。原有 v0.30 附件不覆盖。

## 已知限制

任务助手默认关闭，真实模型和游戏闭环、原生 Linux 游戏、Docker 游戏及 MP1 双客户端仍待验收。Skill 是行为规范，不能保证所有模型遵守；尚未实测其对自主游玩效率的提升。自动化与 Mock 检查不代表实机通过。

[技能使用说明](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/v0.35/docs/AI_SKILL.md) · [任务助手](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/v0.35/docs/DECISION_EXECUTOR.md)

## English

v0.35 (application 0.3.5) adds the portable stardew-player skill: sourced gameplay guidance, short-term recovery checkpoints and long-term goals/lessons. Included in native packages, Docker bundles and source. Runtime logs remain private. Real-model/gameplay acceptance and measured efficiency improvements remain pending; this is a preview. Verify hashes and provenance before upgrading.
