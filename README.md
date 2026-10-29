# Stardew Agent Bridge

> **0.2.0-preview.1**：Windows / Linux x64 原生包、独立 Mod、Docker amd64 镜像与源码工具包。Docker 与联机 MP1 为预览功能；真实 Linux 游戏与双客户端联机仍待实机验收。当前验证见 [RELEASE_VALIDATION_20261029.md](docs/RELEASE_VALIDATION_20261029.md)，历史单人验收见 [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md)。

下载：[GitHub Releases](https://github.com/amy2022525-sketch/stardew-agent-bridge/releases)。每版提供校验和，按平台选取，不需要下载全部镜像。

| 发行包 | 用途 | 安装说明 |
| --- | --- | --- |
| Windows x64 ZIP | Bridge + Web + Mod；需 Node >=22.13 | 本页快速开始与包内启动说明 |
| Linux x64 tar.gz | 自带 Node，Bridge + Web + Mod | [Linux 安装](docs/LINUX_INSTALL.md) |
| Mod ZIP | 两个平台通用的 net6.0 Mod 程序集；需合法游戏/SMAPI | [原生安装](docs/LINUX_INSTALL.md)、[联机安装](docs/MULTIPLAYER_INSTALL.md) |
| Docker 三个镜像归档 | Bridge / 图形游戏环境 / Mod 编译工具，按需加载 | [Docker 安装](docs/DOCKER_INSTALL.md) |
| Docker source ZIP | Compose、管理脚本、完整公开源码，可本地重建镜像 | [Docker 开发](docs/DOCKER_DEVELOPMENT.md) |
>
> 2026-10-24：Linux 源码预览已完成首轮验证：Ubuntu 24.04 / WSL2 的 136 项 Node 测试、20 项安装/恢复测试、19 项无游戏便携包检查通过。原生 Linux 游戏、图形浏览器、具体 Agent 短任务和完整安装包仍待验收；当前更新不代表稳定版 Linux Release。详见 [LINUX_VALIDATION_REPORT.md](LINUX_VALIDATION_REPORT.md) 与 [平台矩阵](docs/PLATFORM_MATRIX.md)。

让**任意本地 MCP Agent**（DSH、Codex CLI、Claude Code……）观察并操作真实的星露谷游戏：一个 SMAPI Mod + 一个常驻本机 Bridge + 一个 Web 控制台，共用同一套游戏能力与同一份动作账本。

- MCP 接口只是**连接方式**：不依赖任何具体 Agent、不绑定任何模型厂商，也不需要任何专用插件。
- 所有写操作走**游戏正常流程**：没有传送、改钱、改物品、跳过剧情这类调试命令（代码里也不存在，不是隐藏起来）。
- 多客户端可**同时观察**，但同一时刻只有**一个写者**；玩家本人随时可以用热键或在网页上接管。

English: [README.en.md](README.en.md)

## 1. 结构

```
Agent 宿主（DSH / Codex / Claude Code）
   │  标准 MCP（Streamable HTTP，或 stdio 适配器）
   ▼
Bridge 常驻进程（127.0.0.1:17655）           ← 唯一业务核心 control-core
   ├── MCP 工具面（29 个 stardew_* 工具）
   ├── Web 控制台（状态 / 时间线 / 配置向导 / 人工接管）
   ├── 动作账本（SQLite：actionId 去重、终态缓存、未决动作）
   └── 控制权（控制会话 + 租约 + 写者独占）
   │  本机 WebSocket（127.0.0.1:17654，Bearer 令牌，协议 stardew-agent-bridge/1）
   ▼
SMAPI Mod（游戏主线程）                      ← 唯一执行者
   ├── 观察：地图 / 角色 / 背包 / 作物 / 商店 / 菜单
   ├── 动作：移动 / 使用 / 交互 / 菜单 / 买卖 / 制作 / 钓鱼 / 战斗 / 装卸存档
   └── 自保：控制权 epoch、失联即释放输入并尝试正常暂停、F9 紧急停止
```

关键设计：

| 约束 | 实现 |
| --- | --- |
| 多个客户端读同一份世界 | 所有读取都转发到真实 Mod 快照，Bridge 不做假数据 |
| 同一时刻只有一个写者 | 控制会话 + 租约（默认 3 分钟）+ Mod 侧控制权代次 `epoch` |
| 迟到的请求不能重新取得控制 | 每个写请求必须带当前 `epoch`；接管/断线/换存档都会换 epoch |
| 消费动作不重复扣钱扣物品 | `actionId` 去重 + 终态回放 + 结果不明一律 `unknown`（查询/观察，不重放） |
| 游戏侧能独立自救 | 与 Bridge 失联 5 秒即停止动作、撤销控制权、尝试正常暂停；`F9` 手动紧急停止 |
| 不打扰玩家 | 每步动作后默认**尝试**正常暂停；绝不关闭玩家自己打开的菜单，绝不跳剧情 |

## 2. 快速开始（Windows，单人存档）

前置：Windows 10/11、星露谷 1.6.15 + SMAPI 4.5.2、Node.js ≥ 22.13.0（用到内置 `node:sqlite`）。源码构建与隔离 C# 测试使用 .NET SDK 10；游戏 Mod 的目标仍为 net6.0，并引用你本机的游戏程序集。

1. **构建**（同时生成 Mod 与 Web 产物）

   ```powershell
   npm ci
   npm run build
   $env:STARDEW_GAME_PATH = 'F:\SteamLibrary\steamapps\common\Stardew Valley'  # 按实际路径
   npm run build:mod
   ```

2. **先启动一次 Bridge**：它会生成 Mod 与客户端要用的本机凭据。

   ```powershell
   npm start
   ```

   打开 <http://127.0.0.1:17655/> 可以看到控制台。**保持它运行**。

3. **安装 Mod**（游戏必须已退出；脚本会先备份旧目录）

   ```powershell
   npm run install:mod
   ```

4. **启动游戏并加载存档**：用 SMAPI 启动，日志里应出现
   `Stardew Agent Bridge Mod 已启动：ws://127.0.0.1:17654/`。

5. **确认连接**

   ```powershell
   npm run doctor      # 应显示 Mod 连接=是
   node scripts/smoke.mjs
   ```

6. **接入你的 Agent 宿主**：点击网页顶部的「MCP 连接」，选择 DSH、Codex、Claude Code 或其他 MCP 客户端，填写连接名称并生成配置。可复制或下载 JSON/TOML；「检测本机 MCP 通道」会执行真实握手、工具发现和只读状态查询。将配置导入 Agent，再让它调用 `stardew_status`，即可在网页的「客户端最近调用」中看到记录。也可以命令行输出：

   ```powershell
   node apps/server/dist/cli.js hosts --host codex --transport stdio
   node apps/server/dist/cli.js matrix
   ```

   各宿主完整步骤见 [docs/CLIENTS.md](docs/CLIENTS.md)。

7. 想让 Agent 真正动手时，在网页上点「获取控制权」（或让 Agent 调用 `stardew_session`）；结束后点「释放控制权」或按 `F9`。

### Linux 首版（源码预览，已完成无游戏首轮验证）

Linux 走同一套业务核心，差别只在宿主适配：发布包自带 Node 运行时、数据根走 XDG、Mod 安装/回退是事务化 MJS 脚本、菜单入口用 `.desktop`。

```bash
npm ci && npm run build
GAME="/home/$USER/.local/share/Steam/steamapps/common/Stardew Valley"
npm run build:mod -- --game-path "$GAME"
node apps/server/dist/cli.js start &      # 发布包内是 bin/stardew-agent-bridge start
npm run install:mod -- --game-path "$GAME"
npm run doctor
```

完整步骤见 [docs/LINUX_INSTALL.md](docs/LINUX_INSTALL.md)，规则与代码边界见 [docs/LINUX_DEVELOPMENT.md](docs/LINUX_DEVELOPMENT.md)，平台差异见 [docs/PLATFORM_MATRIX.md](docs/PLATFORM_MATRIX.md)。

## 3. 工具面（29 个）

| 类别 | 工具 | 说明 |
| --- | --- | --- |
| 只读 | `stardew_doctor`、`stardew_status` | 连接、版本、能力、控制权、未决动作 |
| 只读 | `stardew_snapshot`、`stardew_inspect` | 结构化世界快照（含作物成熟、地图出口、菜单选项）；单个目标详情 |
| 只读 | `stardew_screenshot` | 真实画面 PNG（同时返回结构化提示，便于无视觉能力模型使用） |
| 只读 | `stardew_shop`、`stardew_recipes`、`stardew_saves` | 货架/价格/`itemId`、已知配方与材料、可加载存档 |
| 只读 | `stardew_multiplayer` | 联机状态/在线玩家/主机政策/连接（operation=status/players/policy/connection）；仅联机世界有意义，不含审批或绑定入口 |
| 写 | `stardew_move`、`stardew_select`、`stardew_use`、`stardew_interact` | 寻路到格子或目标附近；选背包槽；对相邻目标使用工具/种子；正常交互 |
| 写 | `stardew_menu`、`stardew_closemenu`、`stardew_pause`、`stardew_wait` | 选择对话/邮件/结算菜单项；从正常入口关菜单；打开暂停菜单；有界等待 |
| 写 | `stardew_buy`、`stardew_ship`、`stardew_container` | 购买（按 `itemId`+数量）、投放出货箱、箱子存取 |
| 写 | `stardew_craft`、`stardew_place`、`stardew_eat`、`stardew_equip` | 制作、放置、食用、穿脱装备 |
| 写 | `stardew_fish`、`stardew_combat` | 有界钓鱼（≤55 秒）、有界战斗（≤10 秒，含停手生命阈值） |
| 写 | `stardew_load` | 加载指定存档（`saveId` 必须来自 `stardew_saves`） |
| 控制 | `stardew_session`、`stardew_stop` | 获取/续租/释放控制权；**只**停止调用方自己的动作 |

写工具统一接受可选 `actionId`（缺省由 Bridge 生成）与可选 `controlSessionId`（单活跃会话时自动推断，歧义时报 `CONTROL_REQUIRED`）。

错误码、`effectKnown`、`nextAction`（`observe`/`query_action`/`stop`/`wait`/`restart_control`/`fix_environment`/`upgrade`）定义见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 4. 安全边界

- **只监听回环**：Bridge 与 Mod 只绑定 `127.0.0.1`。Mod 拒绝带 `Origin` 的连接；Bridge 校验 Host 和本机 Origin，Web 写操作另需会话与 CSRF。
- **凭据本机化**：令牌写在 `%LOCALAPPDATA%\StardewAgentBridge\credentials.json`（用户目录权限保护），不进仓库、不进日志、不进问题包；Mod 每次连接重新读取，轮换令牌**不需要重启游戏**。
- **写者独占**：没有控制会话的写请求一律拒绝；租约到期、连接断开、换存档、人工接管都会让旧 `epoch` 失效。
- **结果不明就停**：网络断开、超时、异常一律返回 `unknown` + `effectKnown=false`，指引 Agent 先查询/观察，**不允许**换新 ID 重放消费动作（同 `actionId` 不同参数会被 `IDEMPOTENCY_CONFLICT` 拒绝）。
- **没有调试后门**：`warp`、`resource`、`skipevent`、`diag` 等命令在 Mod 协议与工具面都不存在；工具面里也没有任何"直接改存档"的入口。

## 5. 数据目录

Windows 默认 `%LOCALAPPDATA%\StardewAgentBridge`；Linux 默认 `$XDG_DATA_HOME/StardewAgentBridge`（未设置时为 `~/.local/share/StardewAgentBridge`）。两者都可用绝对路径的 `SAB_HOME` 覆盖。

| 文件 | 内容 |
| --- | --- |
| `config.json` | 端口、租约时长、日志级别（非敏感，可复制） |
| `credentials.json` | Mod 令牌、Web 会话密钥、各客户端令牌（**敏感**） |
| `endpoint.json` | 端口与进程号，供适配器与宿主探测 |
| `ledger.sqlite` | 动作账本：actionId、参数指纹、终态、控制会话 |
| `logs/bridge.log` | 运行日志（已脱敏，不含令牌与绝对用户路径） |
| `exports/`、`screenshots/` | 导出的问题包与截图 |

## 6. 开发

```powershell
npm run build      # tsc -b + Web 类型检查 + esbuild
npm test           # 51 个测试（契约 / 控制权 / MCP HTTP / Web MCP / 故障注入），使用模拟 Mod
npm run test:mod   # 17 项真实 C# 控制源码隔离检查（不是游戏实测）
npm run test:installer # 17 项 Windows 安装与回滚检查
npm run clean
npm run pack       # Windows：生成 release\StardewAgentBridge-0.1.0\（含 CHECKSUMS.txt；不会上传）
npm run pack -- --target linux-x64 --runtime-root <含 bin/node 的目录>   # Linux：包内自带运行时
npm run verify:package -- <包目录>                                       # 仓库外隔离验证（HTTP + stdio）
```

Linux 上 `npm run test:installer` 运行 `tests/scripts/install-rollback-linux.mjs`（临时目录伪造游戏目录、含 `SAB_FAIL_AT` 故障注入）；Windows 上仍转发到原有 PowerShell 测试。

目录：`packages/contracts`（协议与工具定义）、`packages/platform`（数据根/权限/进程身份/桌面入口等跨平台能力）、`packages/game-client`（Mod WS 客户端）、`packages/control-core`（账本/控制权/动作服务）、`packages/mcp`（MCP 工具面）、`apps/server`（Bridge 进程 + `/api/v1` + Web 静态）、`apps/web`（无框架前端）、`adapters/stdio`（stdio 适配器）、`mods/StardewAgentBridge`（C# Mod）、`scripts/`（Windows `.ps1` 与 `scripts/linux/*.mjs`，由 `scripts/*.mjs` 按平台分派）、`tests`（模拟 Mod、契约向量与端到端测试）。

## 7. 验收状态

诚实说明（证据见 [docs/EVIDENCE.md](docs/EVIDENCE.md)）：

| 范围 | 状态 |
| --- | --- |
| 契约 / 控制权 / 账本去重 / MCP HTTP+stdio / Web MCP / 故障注入（模拟 Mod） | **已通过** 51/51 |
| Web MCP 连接面板（真实浏览器 + 隔离 Bridge） | **已通过** 11 项；配置、复制下载、HTTP/stdio 检测、调用记录和 390px 布局 |
| Mod 编译（`dotnet build`，引用真实游戏 DLL） | **已通过** 0 警告 0 错误 |
| Bridge + Web 实进程自检（`/health`、`/`、`/mcp`、`scripts/smoke.mjs`） | **已通过**（无游戏时的降级行为也已验证） |
| **Linux 首版（编译/测试/打包/实机）** | **未运行**：源码已编写，验证由原协作者执行，见 [LINUX_HANDOVER_REPORT.md](LINUX_HANDOVER_REPORT.md) |
| **真实游戏内实机验收（Windows）** | **部分通过**：正常加载、移动、选槽、箱子存取与去重、制作、放置、等待、失联收手与 Web 接管。完整矩阵见 [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md) |

## 8. 许可证与来源

MIT。迁移来源与逐文件差异见 [NOTICE.md](NOTICE.md) 与 [docs/MIGRATION.md](docs/MIGRATION.md)：上游 `rottenpen/agent-stardew`（MIT，commit `d1f8934`）的 Mod 与客户端代码被改造为独立的 Bridge 协议，不包含任何游戏本体资源、存档或凭据。
