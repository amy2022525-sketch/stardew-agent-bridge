# 变更记录

## 0.1.0 — 2026-10-22（首个可用版本，Windows / 本机 / 单人）

### 新增

- **SMAPI Mod `StardewAgentBridge`**（游戏侧唯一执行者）：结构化观察（地图/角色/背包/装备/作物/商店/菜单/出口）、正常流程动作（移动、选格、使用、交互、菜单、开关菜单、暂停、有界等待、购买、出货、箱子、制作、放置、食用、装备、钓鱼、战斗、存档装载、截图）。
- **Mod 侧控制权**：`epoch` 由游戏签发，写请求必须携带；接管/断线/换存档/失联都会轮换，迟到请求无法重新取得控制。
- **Mod 侧自保**：与 Bridge 失联 5 秒即停止动作、`player.Halt()`、撤销控制权、尝试正常暂停；`F9` 紧急停止；每步动作后默认尝试正常暂停（绝不关闭玩家菜单、绝不跳剧情）。
- **Mod 侧幂等**：`actionId` + 参数指纹，终态回放、冲突拒绝、无终态回 `unknown`，记录上限 65536。
- **常驻 Bridge**（`127.0.0.1:17655`）：唯一业务核心 `control-core`；MCP Streamable HTTP 工具面（28 个 `stardew_*`）；`/api/v1` 读取与人工操作；Web 静态；SQLite 动作账本；控制会话 + 租约 + 写者独占；未决动作暴露；脱敏日志与问题包导出。
- **Web 控制台**（无框架 vanilla TS + esbuild）：状态卡、控制权接管/释放、快照摘要、动作时间线（SSE）、宿主配置向导（DSH/Codex/Claude Code × HTTP/stdio）、诊断导出。
- **stdio 适配器**：把宿主子进程的 MCP 调用转发到同一个 Bridge，令牌不进命令行。
- **CLI**：`start` / `doctor` / `token list|issue|rotate|revoke` / `hosts --host … --transport …` / `matrix` / `version`。
- **脚本**：`build` / `test` / `build-mod` / `install-mod` / `rollback-mod` / `pack` / `smoke`。
- **测试**：10 套件 34 项，使用真实 MCP SDK + 模拟 Mod（含断线、延迟、账本不可写、重复请求等故障注入）。

### 安全

- 两条回环通道都拒绝带 `Origin` 的请求；Bridge 校验 `Host`（DNS rebinding）；令牌只存本机凭据文件，热加载轮换，不进命令行/日志/仓库/问题包。
- Agent 工具面不存在传送、改资源、跳剧情等调试命令（代码中亦无残留）。

### 修复（实现期发现的真实缺陷）

- 去重键曾包含 `worldGeneration`，首次写入时代次未知（0），导致重放绕过去重并重复消费（如重复食用）。改为 `gameInstanceId + actionId`，世界代次只作审计。
- CLI 子进程签发的客户端令牌，运行中的 Bridge 因内存缓存而不认；改为按 `credentials.json` 修改时间热加载。
- Mod 返回 `status:"unknown"` 曾映射成 `INTERNAL_ERROR` 并丢失原始错误码；改为 `RESULT_UNKNOWN` 并保留 `detail.originalCode`。
- 打包脚本三处 Windows PowerShell 5.1 兼容问题（`.ps1` 需 UTF-8 BOM、`--outfile=(…)` 参数拆分、`@array` 按位置传参）。

### 已知限制

- 仅 Windows、本机、**单人**存档；多人存档明确拒绝。
- 实机验收（A1–A8）尚未执行，见 `docs/ACCEPTANCE.md` §5、`docs/EVIDENCE.md` §E7。
- 钓鱼/战斗为**有界**控制：达到时限即停止，"超时"不等于"捕获失败"或"击杀"。依赖 SMAPI 输入桥接的钓鱼逐帧控制需要真实设备验证。
- Codex CLI 的 HTTP MCP 支持取决于版本，文档给出 stdio 退路。
