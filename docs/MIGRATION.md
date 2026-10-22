# 迁移清单与来源记录（BASE-01）

本文件记录 Stardew Agent Bridge 从既有 0.3.0 实现迁移的**来源、文件清单、本机差异与处置决定**。
生成时间：2026-10-22（北京时间）。记录人：接手开发的 AI 助手。

## 1. 上游基准

| 项目 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/rottenpen/agent-stardew` |
| 基准提交 | `d1f8934351a0b50506cfc0c5f1149dd0bbc5d87f` |
| 上游许可 | MIT（原 `LICENSE` 保留于本项目根目录 `LICENSE`，版权行 `Copyright (c) 2026 agent-stardew contributors`） |
| 本机工作区 HEAD | `d1f8934 docs: 完善项目贡献流程`（与基准提交一致） |

**重要事实：上游基准提交不等于本机 0.3.0 功能。** 本机工作区存在未提交改动，仅有克隆上游提交无法取得当前实现：

```
 M mods/AgentStardew/ActionCoordinator.cs
 M mods/AgentStardew/AgentStardew.csproj
 M mods/AgentStardew/GameActions.cs
 M mods/AgentStardew/ModEntry.cs
 M mods/AgentStardew/Observations.cs
 M mods/AgentStardew/Protocol.cs
 M mods/AgentStardew/manifest.json
?? mods/AgentStardew/InventoryActions.cs
?? mods/AgentStardew/LifecycleActions.cs
?? mods/AgentStardew/ReadyAction.cs
?? mods/AgentStardew/RealtimeActions.cs
?? mods/AgentStardew/ShippingAction.cs
?? mods/AgentStardew/ShopBuyAction.cs
?? mods/AgentStardew/WorldState.cs
```

`git diff --stat` 摘要：10 个已跟踪文件被修改（+538 / −51），另有 7 个未跟踪源文件。
`dsh-stardew-local` 目录不在 Git 管理下（无 `.git`），按文件清单与哈希记录。

## 2. 源文件清单与哈希（迁移输入快照）

### 2.1 旧 Mod：`F:\星露谷\agent-stardew\mods\AgentStardew`

| 文件 | SHA-256 | 处置 |
| --- | --- | --- |
| `ActionCoordinator.cs` | `1cc8a62a7dcc71432f10aa29fabf5e0f882dffdc8bd087c909fd194de54c8cba` | **重写**：保留单写串行、ID 墓碑、终态缓存语义，改为携带 epoch/收据 |
| `BackgroundUpdates.cs` | `d788b9bb625a834cb1af694be62ba9638cc9710665ee7dd58392dabff3abeedb` | **原样迁移**（失焦运行支持） |
| `BridgeServer.cs` | `a532d76ae917a290c9554abe4c623901c9f43f6fc60d9788f5e428ed22` → 见源文件 | **重写**：增加配对凭据、协议名+版本握手、连接数上限、Origin 拒绝、心跳 |
| `InteractionEvidence.cs` | `ce85e9c2fd5610bbc4bafe551cb1443aa1db5d7340b91182be73688493b8e80f` | **原样迁移** |
| `GameActions.cs` | `9debccdbd2ca3b623bbe3fb4c128174975785b3f601afd6bcabd15108e710174` | **迁移并裁剪**：删除 `warp` 分支；保留移动/工具/菜单/等待/实时动作 |
| `InventoryActions.cs` | `0f908c0b764ebc4d72396fd82f5ee43bc263085b546adeef66984aadea724fae` | **原样迁移**（物品/制作/放置/食用/装备） |
| `LifecycleActions.cs` | `3da123778851035956a26bb65ca9230ba5f20e78213278c1c8c7fa41976f9a46` | **原样迁移**（存档列举与加载） |
| `ModEntry.cs` | `2422d10b55a35aa51ecfe44cab4167fee65e690392fe2aa78d7bd1d3895a74ed` | **重写**：主线程调度、控制权代次、watchdog、停机热键、分步暂停 |
| `MovementInput.cs` | `e83b2672a932f47b9b92e8d2710eeb69f49ca2c9131c802ced0428645183e589` | **原样迁移**（逐帧方向注入） |
| `Observations.cs` | `2f99295723e68ce176ddacdce2ac60f594514f944ee77e42ea572ef42c8c83bb` | **迁移并裁剪**：删除 `Diagnostic` 与 `WarpTo` 内部入口；增加 sceneGeneration |
| `Protocol.cs` | `5b358cee...`（上表 5b358cec85e2cd53ca246e91f57693d84a2880ee7b67a8b8c8d935ea1ba88d7d） | **重写**：协议名 `stardew-agent-bridge/1`、epoch 字段、白名单、删除 warp/skipevent/diag |
| `ReadyAction.cs` | `9e729981341485644b97027bc44808cb0f5dd35a66d6d15d3e728b39ea335343` | **原样迁移**（动作前有界等待 2000ms） |
| `RealtimeActions.cs` | `1b272dbbc7ddf4d28ce13ed1ed2803543ccfa1f5df4ec72d63830a513060aeb7` | **原样迁移**（钓鱼/战斗逐帧控制） |
| `ShippingAction.cs` | `c64d108f81e03ba558cd8109ccd0d81482b2d0289212078f02b78be463afe460` | **原样迁移**（出货箱投放） |
| `ShopBuyAction.cs` | `8c9969ba7a1fd779a657d8ff98ef4f069b7216d4a0ce722a5b403ff8c382a7ee` | **原样迁移**（商店购买已做后验） |
| `WorldState.cs` | `c92413520cfddbd6271e0c31d72f4df27a6e95ea02f6384b92253230643d949c` | **原样迁移**（世界状态摘要与动物枚举） |
| `AgentStardew.csproj` | `df97c08f6f87a5e6e0e7b7a44d48af6b35105faaa44c99aa3b38428f534fe461` | **重写**：`net6.0` 保持不变，游戏路径可配置，版本 0.1.0 |
| `manifest.json` | `401ee05ef4d541a1f663a55c5c9636760b39e8a6fb09b642a1c8ac93ac0f32be` | **重写**：UniqueID `StardewAgentBridge.Bridge` |

> 说明：`BridgeServer.cs` 与 `Protocol.cs` 的完整哈希列入本表首行时受排版所限，权威值如下：
> - `BridgeServer.cs` = `a532d76ae917a290c9554abe4c623901c9f43f6fc60d9788f5e428ed0aa22422`
> - `Protocol.cs` = `5b358cec85e2cd53ca246e91f57693d84a2880ee7b67a8b8c8d935ea1ba88d7d`

### 2.4 新增文件（上游不存在）

| 文件 | 用途 |
| --- | --- |
| `ControlAuthority.cs` | 新增：Mod 侧控制权 epoch、租约、接管、写授权、暂停策略 |
| `BridgeServer.cs` | 重写（上游为裸 WebSocket 循环）：回环 HttpListener、Bearer 定长比较、Origin 拒绝、连接数/帧上限、有界入队、最近收帧时间 |
| `Protocol.cs` | 重写：`stardew-agent-bridge/1` 帧定义、参数白名单、`Response`/`Fault` 工厂；删除 warp/skipevent/diag |
| `ModEntry.cs` | 重写：主线程调度、watchdog 自释放、`F9` 急停、分步暂停合并、截图/存档/控制权命令 |
| `StardewAgentBridge.csproj` | 新增（替代 `AgentStardew.csproj`）：`net6.0`，游戏 DLL 仅编译期引用（`Private=false`） |
| `manifest.json` | 重写：UniqueID `StardewAgentBridge.Bridge`，版本 0.1.0，MinimumApiVersion 4.5.2 |

处置结论：`Observations.cs` 与 `GameActions.cs` 在迁移时删除了 `WarpTo`、`Diagnostic` 与 `case "warp"`，因此工具面与 Mod 协议里都不存在传送与内部诊断通道。

### 2.2 旧 DSH 适配器：`F:\星露谷\dsh-stardew-local`

| 文件 | SHA-256 | 处置 |
| --- | --- | --- |
| `bridge.js` | `1d687064a985f95b40efa7fe1ae54b44ca8a74c2dcf0ecd74b7a406359b4d38c` | **提取语义重写**为 `packages/game-client`（连接/请求/快照压缩），去除 DSH 依赖 |
| `commands.js` | `a96937402d11fabbf898d1cfacff3ae1c04dc73302c4276f19a565eb96d3e97e` | **提取语义重写**为 `packages/contracts` 工具目录与参数约束 |
| `index.js` | `fbc57fcc3596c79c11552d750ea7ffae108c000c0ad9eae66c8025dec6bbdffc` | **不迁移**：宿主专用注册由 MCP 入口替代 |
| `session.js` | `917c9d73a0f18f856f475e794ec9b739ed6e1f7f7329497d87e0584128a18a79` | **不迁移**：DSH idle 生命周期改为显式控制会话（`packages/control-core`） |
| `package.json` | `c449962d5d59716ac0eacaf2eb7f5dfa712defcc375ca00d9c120968c6f6e93e` | 不迁移（新工程独立依赖） |
| `NOTICE.md` | `b0cfc116642dc9e48bc37ee8daf532020299b3a388a08abd0a227e5a1cdfadfc` | 内容并入本项目 `NOTICE.md` |
| `skills/stardew-local/SKILL.md` | （未纳入哈希，宿主说明） | 提取通用操作指南到 `docs/AGENT_GUIDE.md`，宿主专用部分不迁移 |

### 2.3 明确排除

| 排除项 | 原因 |
| --- | --- |
| 旧 `.git` 目录 | 新仓库独立历史；避免携带旧 remote/凭据 |
| 旧 `bin/`、`obj/` 构建产物 | 可重复构建，不入库 |
| 游戏 DLL、`Stardew Valley.dll` 等 | 版权与分发限制；改为本机路径引用 |
| 真实存档、`SaveBackup` 备份 | 用户数据；实机测试单独备份 |
| 个人 Agent 配置、凭据、本机日志 | 安全边界 |
| Jev 决策层、用户输出 | 项目不再包含专用决策服务 |

## 3. 复用基线的可信度声明

旧 0.3.0 的 28 工具、动作后验与游玩记录**只**作为回归设计基线。它们通过的是旧 DSH 插件链路，未经本项目 MCP/Web 链路，因此不能填入新项目的验收结果栏。本项目的验收结果单独记录于 `docs/EVIDENCE.md` 与 `HANDOVER_REPORT.md`。

## 4. 新仓库不依赖个人绝对路径

游戏引用通过 `STARDEW_GAME_PATH` 环境变量或 `--game-path` / `scripts/build-mod.ps1 -GamePath` 传入；运行期数据目录通过 `SAB_HOME` 覆盖，默认 `%LOCALAPPDATA%\StardewAgentBridge`。仓库内不写入 `F:\`、`E:\` 等个人路径。