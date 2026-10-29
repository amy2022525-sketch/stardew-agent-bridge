# 变更记录

## 0.2.0-preview.1 — 2026-10-29

- 合并独立 MP1 与 Docker 工作区，保留原生单人能力、Web MCP 连接与 Linux 平台层；统一应用/Mod/镜像版本。
- 联机原生门与明确 Warp TouchAction 增加目的地政策检查。切图时立即释放输入和旧控制权，仅对匹配目标做只读落点确认；不重放动作、不宣称主机保存。未知触发器继续拒绝。
- 许可失效清理在途授予代次；首次申请提示等待短许可再 start，修正绑定即时生效和账本回退说明，记录升级备份路径。
- Docker 提供 bridge-runtime/game-runtime/mod-build、受限网关、supervisor、私有配置、离线备份与恢复、noVNC 辅助通道及 Web 状态。修复默认 bundle 输出解析和 CI 的 Compose 上下文/预期 401/退出码检查。
- 补齐 Docker 安装、架构、验收、跨平台支持矩阵与各发行包。真实 Linux 游戏、完整 Agent 玩法和双客户端联机仍标记待验收；本版按预览发布。
- 修复多进程接管死亡实例锁时的空目录竞争，改为原子发布带 owner 的非空目录。补齐手动 Docker 发行附件 CI，在实际上传镜像上运行 noVNC 密码登录/跨来源拒绝的浏览器检查，并附包哈希与镜像来源证明。
- 补齐 Windows 目录句柄短暂占用的有界重试和 5 轮并发回归；成功者在整个采样期保持持锁。Windows 打包可复用匹配版本的 Mod；Linux 发布 CI 从校验过的独立 Mod 和官方 Node 制作完整包，验证后直接上传预发布草稿。

## 2026-10-25：联机 MP1 源码实现与缺口修复（未发布，未实机验收）

> 在 `work/multiplayer-mp1-20261024` 联机工作区（基线 63a4f36）实现：构建通过、Node 149 项（144 过/0 败/5 跳）、C# 149 checks、真实游戏程序集编译 0 警告 0 错误、安装器 17 项、打包与包校验通过。**双客户端实机联机验收未开始**；详见 docs/MULTIPLAYER_IMPLEMENTATION_HANDOVER_20261024.md 与 docs/MULTIPLAYER_TAKEOVER_UPDATE_20261024.md。

- Mod 联机纯状态机 `SessionMachine`：host/participant 握手、角色绑定与主机政策双层许可、短许可（按请求发出时间计 TTL、按实际期限提前续期）、acquire 代次防旧授予借用、撤权/换图/保存跨日屏障、连续控制预算跨重连、有界主机位置观察（actionAttribution=unproven）。
- Mod 联机运行时 `MultiplayerRuntime`：政策文件原子写入（.NET 6 libc chmod）、主机本地 `sab_mp` 控制台、MP1 写动作中央 guard（政策×能力矩阵交集，商店/箱子/钓鱼/战斗默认拒绝）、hello 能力声明按真实可执行口径（writeCommands + writeCommandsReason）。
- Bridge/契约：本地协议 v2（联机身份上下文）、schema 2 回执（confirmationScope/durability=not_saved/不宣称主机已确认）、actor 作用域去重键与墓碑、账本 v1→v2 增量迁移（VACUUM INTO 先备份）、角色不匹配回执统一归一 unknown、诊断导出脱敏联机身份、Web 多作用域 actionId 查询返回结构化 409。
- 工具面 28→29：新增只读 `stardew_multiplayer`；Web 新增联机面板与本地绑定端点（网页会话 + CSRF + 同源）；MP 控制必须显式 `mode=realtime`。
- 新增文档：docs/MULTIPLAYER_INSTALL.md、docs/MULTIPLAYER_ACCEPTANCE.md（A–G 验收脚本）；pack 白名单（Windows/Linux）与 verify-package 工具数断言同步为 29。

## 2026-10-24：Linux 源码预览与首轮验证

> Ubuntu 24.04 / WSL2：构建通过，136 项 Node 测试、20 项安装/恢复测试与19项无游戏便携包检查通过。Windows 构建、Mod 编译和基础回归已有通过记录。当前只同步源码预览；原生 Linux 游戏、图形浏览器、真实 Agent 与完整安装包仍待验收，见 [LINUX_VALIDATION_REPORT.md](LINUX_VALIDATION_REPORT.md)。

- 验证修复：先锁定实例并绑定端口再打开账本，诊断和重复启动保留活动控制会话；实例锁使用原子 owner 目录并覆盖八进程竞争，`launch --json` 保持纯 JSON 输出。
- 修复 Linux esbuild 入口执行方式、包内 Node 与权限验证，以及安装准备阶段失败的旧 Mod 恢复、进程中断恢复、重复回退、符号链接和事务路径检查。Windows 打包兼容缺少 Get-FileHash 的 PowerShell 环境。

- 新增 `packages/platform`：数据根解析（Windows `%LOCALAPPDATA%` / Linux XDG，`SAB_HOME` 相对值明确拒绝）、原子写与 `0700`/`0600` 权限、Steam 库 VDF 解析、进程身份（`/proc/<pid>/stat` starttime）、桌面入口（Exec 转义、`X-SAB-Managed` 标记）、Node 版本与 `:memory:` SQLite 探测、信号/关闭钩子。
- `apps/server` 接入平台层：实例锁（原子 owner 目录、原子诊断记录、陈旧锁与 PID 复用判定、只删自己的锁）、`launch` 只读探测复用（`endpoint.json` + `GET /health`）、只读 `doctor`（稳定问题码，不创建目录/不打开账本）、Mod 配置比对（`DataDirectory` 不一致报 `DATA_ROOT_MISMATCH`，绝不复制凭据掩盖）、`desktop install|remove`、退出码 0/1/2/3 明确化；`/health` 增加 `saveLoaded`/版本字段。
- stdio 适配器改用共享数据根解析与关闭钩子：只结束自身，不影响常驻 Bridge。
- 新增 Linux 脚本：`scripts/linux/{build-mod,install-mod,rollback-mod,pack,desktop-entry}.mjs` 与 `scripts/lib/{game-paths,install-journal}.mjs`；安装事务状态机 `preflight→staged→backuped→prepared→retired_old→committed→verified`，支持 `remove_only`/`rolled_back`/`failed`，可在任意失败点按真实阶段恢复，`SAB_FAIL_AT` 可注入故障。
- 新增跨平台分派器 `scripts/{build-mod,install-mod,rollback-mod,pack,test-installer}.mjs`：Windows 转发既有 `.ps1`，保留安装/回退入口与断言；打包哈希计算增加 .NET 兼容实现。
- `scripts/verify-package.mjs` 扩展为 Windows/Linux 共用：额外校验 `manifest.release.json` 逐文件哈希、包内 Node ELF 与版本、自包含脚本、禁止文件（游戏 DLL/存档/凭据/账本/`.map`/`node_modules`）。
- Mod 侧新增 `PlatformPaths.cs` 与 `config.DataDirectory`，与 Node 共享 `tests/fixtures/platform-paths.json` 契约向量；`tests/mod` 增加对应检查。
- 新增测试源码：`tests/src/{platform-paths,instance-lifecycle,linux-host-config,desktop-entry}.test.ts`、`tests/scripts/install-rollback-linux.mjs`（含故障注入与篡改拒绝）。
- CI 拆为 `windows` 与 `linux`（ubuntu-24.04，Node 22.13.0）两个 job；Linux 只做编译、契约测试、安装事务测试与 bridge-only 打包验证，不登录 Steam、不接触存档、不发布。
- 文档：新增 [docs/LINUX_INSTALL.md](docs/LINUX_INSTALL.md)、[docs/LINUX_DEVELOPMENT.md](docs/LINUX_DEVELOPMENT.md)、[docs/PLATFORM_MATRIX.md](docs/PLATFORM_MATRIX.md)、[docs/LINUX_ACCEPTANCE.md](docs/LINUX_ACCEPTANCE.md)；`engines.node` 提升到 `>=22.13.0`；Web 增加 `data-testid` 观察点与 390px 窄屏样式。
## 0.1.0 — 2026-10-22（源码预览，Windows / 本机 / 单人）

### 2026-10-23：Web MCP 连接

- Web 增加独立 MCP 连接区：地址复制、DSH/Codex/Claude Code/通用客户端配置生成与下载、自定义连接名称、HTTP/stdio 真实通道检测和客户端最近调用。检测身份与 Agent 分开，重复生成配置复用令牌；配置与检测 API 校验网页会话、同源及 CSRF。
- 修复旧协议工具调用未累计次数的问题；仅列出实际执行过工具的客户端，并显示具体参数错误，避免复制已失效的配置。
- Windows 测试与便携验收申请随机端口时跳过 `EACCES` 和 `EADDRINUSE`，保留最多 32 次尝试，其他错误仍立即报告，避免被系统拒绝的测试端口中断 CI。
- Node 51/51、隔离浏览器 11 项、仓库外便携检查 13 项及本机安装后网页检查 6 项通过；当前 Mod 和游戏动作协议没有改动。配置模板或本机通道检测不代替真实宿主游玩验收。

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
