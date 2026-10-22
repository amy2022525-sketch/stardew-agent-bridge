# 交付报告：Stardew Agent Bridge 0.1.0

日期：2026-10-22（Asia/Shanghai）
来源：`C:\Users\am202\Desktop\星露谷AI项目_开发交接书.md`（v1.0 / 规划文件 1.1）
仓库：`F:\星露谷\stardew-agent-bridge`（**本地仓库，未创建远端、未 push、未发布 Release**）

---

## 0. 一句话结论

**可以运行、可以交接**：SMAPI Mod + 常驻 Bridge + Web 控制台 + 标准 MCP 接口都已实现并通过编译、34 项自动化测试、实进程与真实 MCP 往返自检；发布包脚本可一键产出。

**唯一未完成的是"真实游戏内的实机验收"（A1–A8）**：按你的要求本次未改动正在运行的游戏，`docs/ACCEPTANCE.md` §5 给出逐步命令与判定标准，跑完回填 §6 即可。

---

## 1. 交付物

| 交付物 | 位置 | 状态 |
| --- | --- | --- |
| SMAPI Mod 源码（C#，20 文件 ≈ 2.9k 行） | `mods/StardewAgentBridge/` | 编译通过（0 警告 0 错误） |
| Mod 构建产物 | `artifacts/mod/StardewAgentBridge/`（`StardewAgentBridge.dll` + `manifest.json`） | 已生成 |
| Bridge 服务 + MCP + `/api/v1`（TS，34 文件 ≈ 6.5k 行） | `packages/`、`apps/server/` | 通过 |
| Web 控制台（无框架 TS + esbuild） | `apps/web/` | 通过（实进程 200） |
| stdio 适配器 | `adapters/stdio/` | 通过（与 HTTP 一致性测试） |
| 测试（10 套件 34 项，模拟 Mod） | `tests/` | 34/34 通过 |
| 脚本（构建/安装/回滚/打包/自检） | `scripts/*.mjs`、`scripts/*.ps1` | 全部实跑通过 |
| 发布目录 | `release/StardewAgentBridge-0.1.0/`（20 文件，2.3 MB，含 `CHECKSUMS.txt`） | 已生成，可独立运行 |
| 文档 | `README.md`、`README.en.md`、`docs/{PROTOCOL,CLIENTS,TROUBLESHOOTING,EVIDENCE,ACCEPTANCE,MIGRATION}.md`、`CHANGELOG.md` | 已按实现重写 |
| 本报告 + 发布检查清单 | `HANDOVER_REPORT.md`、`RELEASE_CHECKLIST.md` | 本文件 |

---

## 2. 任务完成情况（按交接书任务号）

| 任务 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| BASE-01 | 迁移清单 + 原有未提交差异 | 完成 | `docs/MIGRATION.md`（含上游 commit 与文件哈希） |
| BASE-02 | 契约（协议/错误码/工具 schema/回执/快照） | 完成 | `packages/contracts`，34 项测试中的契约套件 |
| BASE-03 | 工程骨架（workspace、tsconfig 引用、构建与测试脚本） | 完成 | `node scripts/build.mjs`、`node scripts/test.mjs` |
| MOD-01 | 新 Mod（新协议、控制权、幂等、自保、热键、暂停策略、截图/存档） | 完成（编译级） | `mods/StardewAgentBridge/*.cs`；E3 |
| CORE-01 | 账本、控制权、动作服务（唯一写入口） | 完成 | `packages/control-core`，控制权/结果不明/账本套件 |
| MCP-01 | MCP 工具面（HTTP + stdio，同一核心） | 完成 | 28 工具；`mcp-http.test.ts`、`stdio 适配器一致性` |
| OBS-01 | 观察与协议文档对齐 | 完成 | `docs/PROTOCOL.md`（实现版）+ §9 差异表 |
| CLIENT-01 | 宿主接入（DSH/Codex/Claude Code × http/stdio 配置生成） | 代码与文档完成，**真实短任务待执行** | `docs/CLIENTS.md`；E7/A7 |
| CLIENT-02 | 宿主诊断与支持矩阵 | 完成 | `cli matrix`、`docs/TROUBLESHOOTING.md` |
| REL-01 | 发布包与校验 | 完成 | `scripts/pack.ps1`；E6 |
| REL-02 | 验收与证据 | 自动化完成，**实机待执行** | `docs/EVIDENCE.md`、`docs/ACCEPTANCE.md` §4/§5 |

---

## 3. 架构与关键设计（交接时需要知道的部分）

### 3.1 三层，一个业务核心

```
Agent 宿主 ──(MCP: HTTP / stdio 适配器)──► Bridge ──(本机 WS + Bearer + 协议名)──► SMAPI Mod
                                          └─ Web 控制台走 /api/v1，与 MCP 同一个 control-core
```

- **所有**写入（MCP、`/api/v1/tool`、stdio 适配器、网页按钮）都进 `ActionService.executeTool`：控制权检查 → 账本去重 → Mod 调用 → 终态记录。没有第二条实现路径。
- Mod 是唯一执行者；Bridge 不模拟游戏状态，不缓存"以为的世界"。

### 3.2 控制权：Bridge 会话 + Mod epoch（双保险）

- Bridge 侧：控制会话 + 租约（默认 180 s）+ 写者独占；
- Mod 侧：`epoch` 单调递增，写请求必须携带当前值；
- 接管、断线、换存档、Mod 失联都会轮换 epoch ⇒ **迟到的请求在游戏侧就被拒**，不是靠 Bridge 记得清理。

### 3.3 消费动作安全

- `actionId` 幂等：同 ID 同参数回放终态；同 ID 不同参数 `IDEMPOTENCY_CONFLICT`；无终态回 `RESULT_UNKNOWN`（禁止重放）。
- 效果不明（断线/超时/异常）一律 `effectKnown=false` + `nextAction=query_action`，指引"查询/观察后再决定"。
- 账本去重键 = `gameInstanceId + actionId`（**不含** `worldGeneration`，这一点在实现期发现是真缺陷，见 CHANGELOG"修复"）。

### 3.4 不打扰玩家

- 每步动作后**尝试**打开正常暂停菜单（`config.json` → Mod `PauseAfterEachStep`，默认 true）；
- 只关自己开的菜单，不关玩家开的；不跳过任何剧情/结算；
- `F9` 玩家急停：停动作、释放输入、撤销控制权、尝试暂停，完全不依赖 Bridge。

### 3.5 安全边界

- 两条通道都只监听 `127.0.0.1`；都拒绝 `Origin`（浏览器不能借本机端口操作游戏）；Bridge 还校验 `Host` 防 DNS rebinding。
- 令牌只在 `%LOCALAPPDATA%\StardewAgentBridge\credentials.json`；不进 argv、日志、仓库、问题包；轮换后 **Bridge 与 Mod 都热加载**，无需重启。
- Agent 工具面没有传送/改钱/改物品/跳剧情；Mod 协议里这些命令**已删除**（不是禁用开关）。

---

## 4. 验证结果（摘要，细节见 `docs/EVIDENCE.md`）

| 编号 | 内容 | 结果 |
| --- | --- | --- |
| E1 | `node scripts/build.mjs` | 通过 |
| E2 | `node scripts/test.mjs` | **34/34 通过**，10 套件，≈5.9 s |
| E3 | `dotnet build`（真实游戏 DLL） | 通过，**0 警告 0 错误** |
| E4 | Bridge 实进程 + Web 静态 | `/health` `/` `/app.js` `/styles.css` 全 200 |
| E5 | 真实 HTTP MCP 往返（`scripts/smoke.mjs`） | 28 工具；`status` 正常；无游戏时 `snapshot` 正确返回 `GAME_UNAVAILABLE` |
| E6 | `scripts/pack.ps1` | 发布目录 20 文件 2.3 MB，禁止文件审计通过，包内 server 可独立运行 |
| E7 | 实机 A1–A8 | **待执行**（原因见 §5） |

实现期通过上述流程发现并修掉 4 个真实缺陷（去重键、令牌热加载、`unknown` 状态映射、打包脚本三处 Windows PowerShell 兼容问题），均已记录在 `CHANGELOG.md`。

---

## 5. 未完成 / 需要你执行的事项

### 5.1 实机验收（唯一阻塞项）

本次交付**没有**改动正在运行的游戏（你的选择）。要完成验收：

```powershell
# 1) 备份测试存档：%APPDATA%\StardewValley\Saves\<存档名> 复制到仓库外
# 2) 构建并安装（游戏需先退出）
cd F:\星露谷\stardew-agent-bridge
npm run build
powershell -ExecutionPolicy Bypass -File scripts/build-mod.ps1 -GamePath "F:\SteamLibrary\steamapps\common\Stardew Valley"
npm start                       # 保持运行（生成凭据）
npm run install:mod             # 需要游戏已退出；旧目录会自动备份
# 3) 通过 SMAPI 启动游戏并加载测试存档
npm run doctor                  # 期望 Mod 连接=是
node scripts/smoke.mjs          # 真实 MCP 往返
# 4) 按 docs/ACCEPTANCE.md §5 逐项执行 A1–A8，结果回填 §6
```

失败/回滚：游戏内 `F9` 停手 → `npm run rollback:mod` → 用备份恢复存档。

### 5.2 交回原 Codex 会话之前的建议检查顺序

1. `git log --oneline` 与 `git status`（应为干净工作区，提交已包含全部源码与文档）。
2. `npm ci && npm run build && npm test`（预期 34/34）。
3. 阅读 `docs/PROTOCOL.md`（实现版）与 `docs/EVIDENCE.md`（哪些证明过、哪些没有）。
4. 抽查"没有调试后门"：`grep -ri "warp\|skipevent\|resource" mods/`（应只剩注释/无匹配）。
5. 抽查令牌不外泄：`git ls-files | Select-String credentials`（应为空）、`release/` 已被 `.gitignore` 排除。
6. 实机验收（§5.1）通过后再谈上传/发布；**上传动作本身不在本次交付范围内**。

### 5.3 我没有做的事（明确边界）

- 没有创建任何远端仓库、没有 `git push`、没有发布 Release、没有替你上传任何文件。
- 没有改动游戏本体、存档、`Mods/` 目录里的其它 Mod。
- 没有把新 Mod 装进正在运行的游戏（避免打断你的游戏会话）。

---

## 6. 已知限制与风险

| 项 | 说明 | 影响 |
| --- | --- | --- |
| 仅 Windows + 单人 | Linux/macOS 与多人存档不支持（后者返回 `MULTIPLAYER_UNSUPPORTED`） | 明确的设计范围 |
| 钓鱼/战斗为有界控制 | 到时即停；"超时"≠"失败" | 需要真实设备上确认手感与成功率 |
| 界面依赖窗口激活 | 输入注入要求游戏窗口在前台 | 后台挂机可能触发 `BUSY` |
| 截图受分辨率限制 | 8 MiB 像素 + 2.8 MB PNG 上限 | 4K 可能触发 `OUTPUT_LIMIT` |
| Codex CLI 的 HTTP 支持随版本 | 提供 stdio 退路 | 老版本用 stdio |
| `node:sqlite` 仍标实验性 | 只有警告 | 需 Node ≥ 22.5 |
| Mod 编译需要 NuGet 源 | 本机只有 .NET 10 引用包，`net6.0` 目标包需网 | `build-mod.ps1` 已内置源；离线机器需预置包 |

---

## 7. 目录结构（顶层）

```
stardew-agent-bridge/
├── packages/contracts      协议、错误码、28 个工具 schema、回执、快照归一化
├── packages/game-client    Mod WS 客户端（握手、心跳、看门狗、写命令识别）
├── packages/control-core   账本（SQLite）、控制权、动作服务（唯一写入口）
├── packages/mcp            MCP 工具面（fromJsonSchema → 28 工具）
├── apps/server             Bridge 进程：/mcp、/api/v1、静态 Web、CLI
├── apps/web                无框架控制台（TS → esbuild bundle）
├── adapters/stdio          stdio 适配器（转发到同一 Bridge）
├── mods/StardewAgentBridge C# Mod（唯一执行者）
├── scripts/                build / test / build-mod / install-mod / rollback-mod / pack / smoke / clean
├── tests/                  模拟 Mod + 10 套件 34 项测试
├── docs/                   PROTOCOL / CLIENTS / TROUBLESHOOTING / EVIDENCE / ACCEPTANCE / MIGRATION / TASKS / GITHUB_DESKTOP
├── artifacts/              本地产物（被 .gitignore 排除）
├── release/                发布目录（被 .gitignore 排除）
├── HANDOVER_REPORT.md      本文件
└── RELEASE_CHECKLIST.md    发布检查清单
```

---

## 8. 从零复现（五分钟版）

```powershell
git clone <本地仓库路径> stardew-agent-bridge; cd stardew-agent-bridge
npm ci
npm run build
npm test                                  # 34/34
npm start                                  # Bridge + Web：http://127.0.0.1:17655/
# 另开终端
node apps/server/dist/cli.js hosts --host dsh --transport http   # 粘到 DSH 的 MCP 连接器
```

游戏侧另需：`build-mod.ps1` → `install-mod.ps1` → SMAPI 启动 → 加载存档 → `doctor`。

---

## 9. 提交记录

| 提交 | 内容 |
| --- | --- |
| `cf9c704` | 初始化 Stardew Agent Bridge 0.1.0：Mod、契约、核心、MCP 双通道、Web、测试、脚本、文档（101 个文件） |
| 后续提交 | 对齐 `ModHello.watchdog.lastHeartbeatAt` 与 `ModStopResult.command` 两个字段（静态契约核对发现），仅 Mod 侧两行级修改 |

工作区干净：`git status` 无未提交内容；`release/`、`artifacts/`、`node_modules/` 均被 `.gitignore` 排除。

---

## 10. 结论

- **工程与自动化验收已闭环**：协议、控制权、幂等、故障语义、MCP 双通道、Web、打包、文档都有可复现证据。
- **剩下的是实机验证这一件"只能在你机器上做"的事**，步骤与判定标准已写成清单，不需要再做设计决策。
- 交接后如需我继续，最自然的下一步就是按 `docs/ACCEPTANCE.md` §5 跑 A1–A8，并把失败项逐个修掉。
