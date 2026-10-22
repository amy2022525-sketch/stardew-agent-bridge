# 变更记录

## 0.1.0 — 2026-10-22（源码预览，Windows / 本机 / 单人）

### 后续复核修复与验证

- 修复 Ajv 动态加载导致便携包在开发目录之外启动失败；改为静态导入，打包后强制复制到系统临时目录，从无仓库依赖的工作目录检查 CLI、Web、HTTP/stdio MCP。
- DSH Desktop 0.2.0-rc.2 + MCP连接器 0.2.70 的 stdio 连接已在本机实际验收：28 个工具、状态读取和标题页快照的 NO_SAVE_LOADED 返回。尚未完成该宿主的游戏写动作短任务。
- 修复并发取得控制权、租约释放/过期后恢复、世界变化失效以及 Mod 自有暂停菜单识别。
- HTTP MCP 绑定真实客户端身份，支持新旧协议取消；stdio 取消定向停止，传输故障保留未知结果，迟到 stop 不干扰新动作。
- 运行中错误/停止/核验失败保留未知副作用；load accepted、实时动作 partial、资源证据与已核验标记分别报告；支持按 actionId 查询崩溃遗留意图。
- 递归脱敏诊断；修复便携入口、中文和空格路径、Windows UTF-8 manifest、备份目录、安装/回滚边界及测试端口无界重试。
- 修复箱子 list 被错误要求 actionId、暂停状态误报、Web 反馈被轮询覆盖及 390px 布局溢出。
- Node 46/46、C# 源码隔离 17 项、安装/回滚 17 项通过；真实浏览器 9 项通过。实机验证移动、选格、箱子转移/去重、制作、放置、等待与 Bridge 失联收手；存档 15 文件 SHA-256 与基线一致。
- 增加 Windows CI。钓鱼、战斗、完整交易/跨日和三宿主真实任务仍待补齐；详细范围见 [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md)。

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
- **测试**：首次实现为 10 套件 34 项，后续复核扩充为 11 套件 46 项；底层为模拟 Mod（含断线、延迟、账本不可写、重复请求等故障注入）。

### 安全

- Mod 回环通道拒绝 `Origin`；Bridge 允许本机同源 Origin 并校验 `Host`（DNS rebinding）；令牌只存本机凭据文件，热加载轮换，不进命令行/日志/仓库/问题包。
- Agent 工具面不存在传送、改资源、跳剧情等调试命令（代码中亦无残留）。

### 修复（实现期发现的真实缺陷）

- 去重键曾包含 `worldGeneration`，首次写入时代次未知（0），导致重放绕过去重并重复消费（如重复食用）。改为 `gameInstanceId + actionId`，世界代次只作审计。
- CLI 子进程签发的客户端令牌，运行中的 Bridge 因内存缓存而不认；改为按 `credentials.json` 修改时间热加载。
- Mod 返回 `status:"unknown"` 曾映射成 `INTERNAL_ERROR` 并丢失原始错误码；改为 `RESULT_UNKNOWN` 并保留 `detail.originalCode`。
- 打包脚本三处 Windows PowerShell 5.1 兼容问题（`.ps1` 需 UTF-8 BOM、`--outfile=(…)` 参数拆分、`@array` 按位置传参）。

### 已知限制

- 仅 Windows、本机、**单人**存档；多人存档明确拒绝。
- 实机验收 A1–A6 部分通过，A8 完成本轮 9 项 Web 检查；完整 A3/A7 等仍待执行，见 `FINAL_TEST_REPORT.md`。
- 钓鱼/战斗为**有界**控制：达到时限即停止，"超时"不等于"捕获失败"或"击杀"。依赖 SMAPI 输入桥接的钓鱼逐帧控制需要真实设备验证。
- Codex CLI 的 HTTP MCP 支持取决于版本，文档给出 stdio 退路。
