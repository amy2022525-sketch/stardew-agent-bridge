# Stardew Agent Bridge

> 0.1.0 源码预览。2026-10-22 复核：46 项 Node 测试、17 项隔离 C# 检查、17 项安装脚本检查通过；真实游戏中的移动、箱子存取与去重、制作、放置，以及 Web 接管已验证。钓鱼/战斗、完整消费与跨日流程、三个真实宿主仍有待验收项。完整结果见 [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md)，尚未发布稳定版 Release。

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
   ├── MCP 工具面（28 个 stardew_* 工具）
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

前置：Windows 10/11、星露谷 1.6.15 + SMAPI 4.5.2、Node.js ≥ 22.5（用到内置 `node:sqlite`）。源码构建与隔离 C# 测试使用 .NET SDK 10；游戏 Mod 的目标仍为 net6.0，并引用你本机的游戏程序集。

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

6. **接入你的 Agent 宿主**：在网页的「连接其他 Agent 宿主」卡片里选宿主与传输方式，复制配置片段；也可以命令行输出：

   ```powershell
   node apps/server/dist/cli.js hosts --host codex --transport stdio
   node apps/server/dist/cli.js matrix
   ```

   各宿主完整步骤见 [docs/CLIENTS.md](docs/CLIENTS.md)。

7. 想让 Agent 真正动手时，在网页上点「获取控制权」（或让 Agent 调用 `stardew_session`）；结束后点「释放控制权」或按 `F9`。

## 3. 工具面（28 个）

| 类别 | 工具 | 说明 |
| --- | --- | --- |
| 只读 | `stardew_doctor`、`stardew_status` | 连接、版本、能力、控制权、未决动作 |
| 只读 | `stardew_snapshot`、`stardew_inspect` | 结构化世界快照（含作物成熟、地图出口、菜单选项）；单个目标详情 |
| 只读 | `stardew_screenshot` | 真实画面 PNG（同时返回结构化提示，便于无视觉能力模型使用） |
| 只读 | `stardew_shop`、`stardew_recipes`、`stardew_saves` | 货架/价格/`itemId`、已知配方与材料、可加载存档 |
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

`%LOCALAPPDATA%\StardewAgentBridge`（可用 `SAB_HOME` 覆盖）：

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
npm test           # 46 个测试（契约 / 控制权 / MCP HTTP / 故障注入），使用模拟 Mod
npm run test:mod   # 17 项真实 C# 控制源码隔离检查（不是游戏实测）
npm run test:installer # 17 项 Windows 安装与回滚检查
npm run clean
npm run pack       # 生成 release\StardewAgentBridge-0.1.0\（含 CHECKSUMS.txt；不会上传）
```

目录：`packages/contracts`（协议与工具定义）、`packages/game-client`（Mod WS 客户端）、`packages/control-core`（账本/控制权/动作服务）、`packages/mcp`（MCP 工具面）、`apps/server`（Bridge 进程 + `/api/v1` + Web 静态）、`apps/web`（无框架前端）、`adapters/stdio`（stdio 适配器）、`mods/StardewAgentBridge`（C# Mod）、`tests`（模拟 Mod 与端到端测试）。

## 7. 验收状态

诚实说明（证据见 [docs/EVIDENCE.md](docs/EVIDENCE.md)）：

| 范围 | 状态 |
| --- | --- |
| 契约 / 控制权 / 账本去重 / MCP HTTP+stdio / 故障注入（模拟 Mod） | **已通过** 46/46 |
| Mod 编译（`dotnet build`，引用真实游戏 DLL） | **已通过** 0 警告 0 错误 |
| Bridge + Web 实进程自检（`/health`、`/`、`/mcp`、`scripts/smoke.mjs`） | **已通过**（无游戏时的降级行为也已验证） |
| **真实游戏内实机验收** | **部分通过**：正常加载、移动、选槽、箱子存取与去重、制作、放置、等待、失联收手与 Web 接管。完整矩阵见 [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md) |

## 8. 许可证与来源

MIT。迁移来源与逐文件差异见 [NOTICE.md](NOTICE.md) 与 [docs/MIGRATION.md](docs/MIGRATION.md)：上游 `rottenpen/agent-stardew`（MIT，commit `d1f8934`）的 Mod 与客户端代码被改造为独立的 Bridge 协议，不包含任何游戏本体资源、存档或凭据。
