# 星露谷联机开发：进度与代码交接档案

> 交接日期：2026-10-24（Asia/Shanghai）  
> 当前状态：**联机 MP1 已有可构建、通过现有自动测试的实现，但尚未完成全部开发与实机验收。**  
> 用户本次要求交接后，停止继续修改功能源码，仅生成本文和源码快照。  
> 不得将本文中的“已编译”“模拟通过”写成“联机已经实机可用”或“已发布”。

## 0. 给接手 AI 的第一条任务

你接手的是 Stardew Agent Bridge 的联机 MP1 实现，不是从零写计划。用户目标是让任意支持 MCP 的本地 Agent（DSH、Codex、Claude Code 等）通过正常游戏动作，控制自己独立客户端中的农场工，与真人主机联机。

**先阅读本文，进入 F:\星露谷\work\multiplayer-mp1-20261024 核对现有代码，再逐项处理 §8 的问题。不要直接把该目录覆盖到 D:\星露谷\stardew-agent-bridge。后者有另一条 Docker 开发线的未提交改动。**

继续时的要求：

1. 保留已经实现的身份隔离、双层许可、动作去重、单人兼容和未知结果语义。
2. 先完成代码审查和缺口修复，再补测试、操作文档、验收脚本。
3. 自动测试和两台真实客户端联机验收分别记录；没有做过的项目保留 not_run。
4. 不将游戏程序集、存档、Steam 凭据、Agent 令牌或个人政策文件加入 Git。
5. 联机与 Docker 目前独立开发；先完成原生客户端 MP1，之后再设计集成。
6. GitHub 上传继续由原协作者负责；本次交接不构成推送、发布 Release 或镜像的指令。

## 1. 权威路径与仓库状态

| 内容 | 位置 / 状态 |
| --- | --- |
| 本次联机实现工作区 | F:\星露谷\work\multiplayer-mp1-20261024 |
| 原项目主目录 | D:\星露谷\stardew-agent-bridge |
| 聊天初始工作目录 | F:\星露谷；这里并非本次项目源码根目录 |
| 公共仓库 | https://github.com/amy2022525-sketch/stardew-agent-bridge |
| 联机工作区 Git 基线 | 63a4f369feadacf9476660c7af6b1cb9b6ac9a00 |
| 联机工作区 Git 状态 | detached HEAD；修改未提交、未推送 |
| 基线说明 | 63a4f36 记录 GitHub 双平台 CI 通过结果 |
| 原始完整开发要求 | docs/MULTIPLAYER_DEVELOPMENT_HANDOFF.md，约 92 KB |
| 桌面原始任务书 | C:\Users\am202\Desktop\星露谷_联机功能开发详细交接书_20261024.md |
| 本次进度交接书 | docs/MULTIPLAYER_IMPLEMENTATION_HANDOVER_20261024.md |
| 真实游戏目录（本次仅用于引用 DLL 编译） | F:\SteamLibrary\steamapps\common\Stardew Valley |
| 本机 Node | C:\Users\am202\AppData\Local\hermes\node\node.exe，22.23.1 |
| npm 命令 | C:\Users\am202\AppData\Local\hermes\node\npm.cmd |
| dotnet 命令 | C:\Program Files\dotnet\dotnet.exe，已可构建本项目 |

交接前源码盘点：**29 个已跟踪文件修改、9 个未跟踪文件**。9 个未跟踪文件中包含原始详细任务书，其余为新模块、测试及 fixture。新写的本交接书不计入上述盘点。

注意：

- 工作区的 .git 是 Git worktree 指针，依赖主仓库；不要把整个 worktree 当独立仓库移动或删除主仓库。
- node_modules 已在联机工作区单独执行 npm ci 安装，不能与主目录的 workspace 链接互换。
- 主目录当前也位于同一基线，但包含 Docker 改动；其工作树不是干净的。
- 基线曾经有双平台 CI 记录，**本次联机未提交代码没有新的远端 CI 结果**。

## 2. 当前架构

~~~mermaid
flowchart LR
    Human[真人主机原生游戏] --- HostMod[host-coordinator Mod]
    AI[任意本地 MCP Agent] --> Bridge[本机 Bridge / Web / MCP]
    Bridge --> Participant[farmhand participant Mod]
    Participant --- Farmhand[AI 独立原生游戏客户端]
    Farmhand --- Human
    Participant <-->|SMAPI 定向消息：身份、政策、短许可、有限观察| HostMod
~~~

- 真人主机由原生游戏负责托管和保存。
- 主机侧仅启用协调 Mod，首版不启动自动控制端口，也不需要 Agent 凭据。
- AI 使用自己的客户端和农场工，Game1.player 始终表示本地角色；没有切换到远程玩家执行动作的入口。
- Bridge 连接仍限制本机回环地址。
- 主机通过本地 SMAPI 控制台批准或撤销角色政策；MCP 没有审批/绑定/任意代码执行工具。
- 本地角色绑定和主机许可是独立步骤。
- 原生联机、Steam 登录、真人客户端、显示环境不会被 Bridge 自动替代。

## 3. 已落地的主要实现

### 3.1 Mod 与纯状态机

| 文件 | 已实现职责 |
| --- | --- |
| mods/StardewAgentBridge/Multiplayer/Contracts.cs | MultiplayerConfig、ActorContext、ActorPolicy、HostPolicy、MpEnvelope、HostObservation、PermissionLease、Int64 ID 解析 |
| mods/StardewAgentBridge/Multiplayer/SessionMachine.cs | host/participant 握手、原生身份校验后的消息处理、角色绑定状态、短许可、撤权、阶段屏障、重连与连续控制预算、有限主机位置观察 |
| mods/StardewAgentBridge/Multiplayer/MultiplayerRuntime.cs | SMAPI/game 适配、游戏线程收件队列、主机本地命令、动作中央 guard、政策文件加载/保存、世界事件接入 |
| mods/StardewAgentBridge/Multiplayer/PrivatePolicyFile.cs | .NET 6 兼容的原子政策写入、Unix chmod、路径与重解析点检查 |
| mods/StardewAgentBridge/ModEntry.cs | 主机角色启动分离、运行时接入、绑定命令、hello 元信息、动作/控制守卫、F9/watchdog 接入 |
| mods/StardewAgentBridge/ActionCoordinator.cs | actor/world/actionId 命名空间、完整上下文签名、每 tick 检查、MP 墓碑保留 |
| mods/StardewAgentBridge/Observations.cs | MP 随机目标引用、作用域失效、引用缓存清理 |
| mods/StardewAgentBridge/ControlAuthority.cs | MP 不制造全局暂停；保持本地控制 epoch |
| mods/StardewAgentBridge/BackgroundUpdates.cs | MP 跳过原单人背景更新补偿 |
| mods/StardewAgentBridge/GameActions.cs | 自有背包菜单分支、MP 寻路避开中途 TouchAction |
| mods/StardewAgentBridge/Protocol.cs / BridgeServer.cs | 本地 v2 协议、ActorContext、MP 目标引用、新只读/本地绑定命令 |

具体行为：

- Farmer ID 使用规范 Int64 十进制字符串，包括超过 JS 安全整数范围的值。
- worldId 来自原生世界，hostSession、actorSession、connection、lease 使用随机 nonce 隔离。
- SMAPI 网络消息使用 sab-mp/1；本地 WebSocket 使用 stardew-agent-bridge/2。
- SMAPI 实际传输的是 JSON 字符串，避免 Newtonsoft 与 System.Text.Json.JsonElement 混用。
- 入站队列、消息大小、每秒消息数和 JSON 深度均有限制；非本 Mod 和非原生预期 peer 的消息不产生许可。
- 许可期限按本地单调时间从请求发出时刻计算，迟到授予不会从到达时刻重新延长完整 TTL。
- 主机的连续控制预算按角色保存，断开并重连不会直接重置预算。
- Saving、DayEnding、Saved、DayStarted 接入屏障；旧许可和控制不自动跨日恢复。
- 主机观察目前只提供本角色公开位置，标记 host_observed / actionAttribution=unproven；不是游戏提交 ACK，也不是浇水已被主机确认的证明。

### 3.2 Bridge、共享契约和账本

| 文件 | 已实现职责 |
| --- | --- |
| packages/contracts/src/multiplayer.ts | v2 常量、ActorContext 类型/校验、无损 Farmer ID、稳定 MP 去重键、会话比较 |
| packages/contracts/src/protocol.ts | 可选联机状态、控制会话与回执扩展；单人 schemaVersion 仍兼容原值 |
| packages/contracts/src/receipt.ts | 写动作签名纳入完整 actorContext；保留原 SP 签名 |
| packages/contracts/src/tools.ts | 新 stardew_multiplayer 只读工具、open_inventory 菜单分支、作用域收据查询字段 |
| packages/contracts/src/errors.ts | 联机错误码、effectKnown 和 nextAction |
| packages/contracts/src/snapshot.ts | 快照联机观察范围归一化 |
| packages/game-client/src/mod-client.ts | v2 握手、对旧 SP v1 的协议降级、请求携带角色上下文 |
| packages/control-core/src/control-manager.ts | MP 显式 realtime、控制会话绑定角色、主机许可失效关闭本地控制 |
| packages/control-core/src/action-service.ts | 稳定 actor 去重、完整意图签名、schema 2 MP 回执、收据按调用者/作用域查询 |
| packages/control-core/src/ledger.ts | SQLite schema v2 增量迁移、迁移前备份、历史墓碑保留、主体字段、作用域查询 |

关键约束：

- MP 写动作去重键按 worldId + actorFarmerId + actionId 构造，**不使用 connectionId 或游戏进程实例作为 MP 墓碑命名空间**。
- 完整上下文放入意图签名；新连接重用旧 actionId 会冲突，不会重新执行消费动作。
- 在途断线保持 RESULT_UNKNOWN，不自动重放。
- 新 MP 回执 schemaVersion=2，含 confirmationScope、durability、resourceScope、worldContinues；现阶段最多声明本地效果观察，通常 durability=not_saved。
- 旧 SP 收据和签名不重写。
- SQLite v1→v2 使用 VACUUM INTO 先生成一致备份，再事务添加字段与索引。备份命名：ledger.sqlite.pre-mp-v2.<时间戳>-<UUID>.sqlite。
- 发现未来 schema 会拒绝打开写入，不会静默降级。
- 旧版本程序未必有 schema 保护；回退时不能直接让旧程序打开升级后的账本，见 §12。

### 3.3 Web 与 MCP

- 新只读 MCP 工具：stardew_multiplayer，operation=status / players / policy / connection。
- 工具总数从 28 增至 29；现有协议测试断言已同步。
- 未新增 MCP 主机审批工具、远程角色控制工具或模型服务。
- Web 新面板显示角色、世界、主机、连接、政策、许可和世界阶段。
- Web 本地绑定端点：POST /api/v1/multiplayer/bind，需要网页会话、CSRF 和同源；单独的 Bearer 不允许绑定。
- 新只读 Web 端点：GET /api/v1/multiplayer（网页会话路径）。
- 开始控制可选择分步/实时；MP 明确要求 realtime。
- MP 下“暂停”按钮禁用，界面说明本地菜单不代表世界停止。
- Web 的 DOM data-testid 已加入，但**尚未进行真实浏览器交互、窄屏与控制台错误验收**。

## 4. MP1 当前动作边界

| 动作 | 当前代码行为 | 尚待确认 |
| --- | --- | --- |
| 只读状态、快照、截图、配方/商店观察 | 有只读路径 | 真实多人场景的视角和隐私 |
| 移动/选择/有界等待 | 主机许可、地点与动作时限守卫 | 实机寻路、跨图效果回执 |
| 浇水 | 只接受当前 WateringCan、HoeDirt、主机批准区域 | 水壶实际使用、双方地块同步及归因 |
| 门与出口 | 仅放行当前识别的真实 Warp / Building door，目的地需在政策内 | 地图门、特殊出口覆盖；见 §8 |
| 自有背包 | open_inventory 新分支；仅关闭自己创建的菜单 | 真人菜单竞争与中止恢复 |
| 自己的食物、装备 | 政策开关后走原生自身物品操作 | 真实联机动画与同步 |
| 自有材料制作 | 现有 CraftingPage 使用空外部材料参数 | 各配方、中止和 MP 行为 |
| 商店购买、出货、箱子写入、放置、钓鱼、战斗 | MP1 默认拒绝 | 属于后续能力，不可靠通用 menu/use 绕过 |
| 存档列举/加载、睡觉确认、剧情推进 | MP1 不开放相关写路径 | 真人主机负责世界推进 |

当前移动 guard 对目标 TouchAction 采取全部拒绝，中途也避免触发；这是一项明确的首版限制，不是完整出口覆盖。不要把“所有门和出口已支持”写入宣传。

## 5. 已执行验证：只认实际结果

以下结果来自本轮实际执行的终端工具输出；**完整终端日志未单独落盘**。交接包中的 validation-summary.json 仅记录观察到的结果摘要，不冒充完整原始日志。

| 命令 / 检查 | 实际结果 | 证明范围 |
| --- | --- | --- |
| npm ci | 成功；added 35 / audited 45；0 vulnerabilities | 联机工作区依赖安装 |
| npm run build | 成功，TypeScript 项目引用 + Web 类型检查/打包完成 | 当前源码可构建 |
| npm test | 总 147；pass 142；fail 0；skip 5；约 48.9 秒 | 契约、真实 Bridge + 模拟 Mod、控制/传输/账本等；不等于游戏联机 |
| dotnet run --project tests/mod/ControlTests.csproj | 132 assertions/checks passed | 原控制测试 + 纯 C# MP 状态机 |
| dotnet build 实际 Mod，引用本机游戏 DLL | 成功；0 warnings / 0 errors | 实际 SMAPI/game API 编译兼容性 |
| git status / 文件核对 | 已读取工作区与主目录状态 | 路径与并行修改隔离 |

真实 Mod 编译命令：

~~~powershell
Set-Location -LiteralPath 'F:\星露谷\work\multiplayer-mp1-20261024'
dotnet build mods/StardewAgentBridge/StardewAgentBridge.csproj -c Release '-p:GamePath=F:\SteamLibrary\steamapps\common\Stardew Valley' -p:UseSharedCompilation=false
~~~

补充：

- 5 项跳过来自 Windows 上仅 Linux 执行的桌面入口安装/移除用例，不是 5 项联机用例通过。
- C# 隔离测试项目目标为 net10.0；实际游戏 Mod 目标仍为 net6.0。
- 早期真实 Mod 编译曾因 net6.0 没有 File.SetUnixFileMode 失败；已用 PrivatePolicyFile 的 libc chmod 方案修复，随后编译成功。不要把这条旧失败当作当前构建状态。
- 新测试标题中的“MP2 wire”表示本地协议 v2，**不代表后续 MP2 功能阶段已经完成**。

## 6. 新增测试覆盖

1. tests/fixtures/multiplayer-identities.json：C# 与 Node 共用的 Int64 ID 契约向量。
2. tests/mod/MultiplayerTests.cs：
   - ID 无损与非法格式；
   - 请求发出时间计 TTL、迟到/重复授予；
   - 原生角色/host/mod 身份隔离；
   - 绑定与审批分离；
   - 保存/跨日/换图屏障；
   - 断线后的预算保留与 nonce 轮换；
   - 主机撤权、分屏与主机角色拒绝；
   - 旧 MP 墓碑与另一个角色的动作命名空间；
   - 联机暂停的不确定性。
3. tests/src/multiplayer.test.ts：
   - v2 身份、稳定去重与完整签名；
   - 显式 realtime；
   - schema 2 回执与本地观察语义；
   - 重连后旧 actionId 不重放；
   - 客户端收据隔离；
   - 主机撤权关闭控制；
   - Web 绑定鉴权/CSRF/同源；
   - v1 账本含 WAL 数据的备份迁移；
   - 未来 schema 拒绝；
   - 同一 actionId 多作用域查询拒绝歧义。
4. tests/src/mock-mod.ts、helpers.ts 增加 MP 测试配置；原 SP v1 模拟和测试仍保留。
5. contracts / mcp-http / web-mcp 工具数断言更新为 29。

这些覆盖尚不等于原详细任务书所有验收项都已执行；不得将原矩阵整体改为 passed。

## 7. 明确没有做过的事情

- 没有把本次 MP 源码合并到 D:\星露谷\stardew-agent-bridge。
- 没有 git commit、git push、创建 PR、发布 GitHub Release 或镜像。
- 没有安装此版 Mod 到真实游戏目录。
- 没有启动双客户端、登录 Steam、进入真人主机农场或操作真实存档。
- 没有完成实际联机的移动、浇水、制作、换图、撤权、F9、watchdog、保存跨日验收。
- 没有对新版 Web 做真实浏览器、pageerror、窄屏和截图验收。
- 没有为本次 MP 运行 test:installer、pack、verify:package。
- 没有在 Linux 上运行本次新 Mod/MP 测试，也没有新的 Windows/Linux 远端 CI。
- 没有完成 MP 安装/运行指南、中英文 README、CHANGELOG、打包文档清单与最终验收脚本更新。
- 没有验证 Docker 开发线；它的报告状态不能套用到当前 MP 工作区。

## 8. 接手优先排查项：不要跳过

以下分为“静态代码已发现的缺口”与“需要进一步验证的风险”。大多数现有自动测试未覆盖这些边界，因此当前测试通过不能关闭本节。

### H01：最短许可 TTL 与固定续期间隔冲突（优先修复）

位置：SessionMachine.Tick，nextRenew = now() + 1000；MultiplayerConfig 允许 PermissionLeaseMs=1000。

- 1000 ms 的许可可能在下一次续期前已经过期。
- 主机政策连续预算临近耗尽也会缩短授予 TTL，不能只用客户端配置估算。
- 建议从实际 LeaseGrant.ttlMs 调整续期节奏，以请求发出时间为基准提前续期。
- 补测 1000/1001 ms、消息延迟和临近连续预算上限，不得从授予到达时间延长权限。

### H02：本地释放后需要清理旧在途许可请求

位置：SessionMachine.ReleaseControl / Invalidate / RequestControl 与 pending 字典。

- 释放会把 wantsControl=false 并撤销本地 lease，但没有清掉已发出的 LeaseRequest correlation。
- 若用户立刻再次 start，旧响应可能在新请求前到达；需要明确“本次 acquire”代次，避免旧响应被借用。
- 建议清理该类型 pending 并增加 acquire generation；不应把网络 ACK 当作新授权流程完成。
- 补测 release→start→旧 grant 到达、revoke→start、乱序和重复消息。

### H03：角色回执不匹配时，summary/durability 可能保留旧成功文案

位置：packages/control-core/src/action-service.ts，buildWriteReceipt 后附加 MP 字段的代码。

- 当前在已构建收据后，将不匹配角色的 succeeded 改为 unknown，但 summary 已按原状态生成。
- durability 也在修改 effectKnown 前赋值。
- 应统一重新构造/归一化回执，确保 summary、status、verified、effectKnown、error、nextAction、confirmationScope、durability 一致。
- 补测响应缺少 actorContext、错误 actorContext、成功/partial/未知的各组合。

### H04：hello 的能力声明尚未与实际政策求交集

位置：ModEntry.Hello。

- 当前许可有效时返回固定 MP 写命令列表，未逐项反映 AllowMovement、AllowWatering 等。
- features 中部分 SP 功能布尔值仍保持 true。
- 实际 Guard 会拒绝未批准分支，但对 Agent 的能力声明仍可能误导。
- 应按 MP1 支持矩阵、当前角色、主机政策、地点和协议生成有效能力列表及拒绝原因。
- MP profile 在非联机世界也不应宣称可写。

### H05：控制取得回执应使用实际已确认的角色作用域

位置：MultiplayerRuntime.CheckControl、ModEntry.HandleControl、Response.Ok、ControlManager.acquire。

- CheckControl 当前对 Machine.Scope 自校验，而未直接校验 acquire 请求携带的旧上下文。
- Response 的 actorContext 从原请求回显。
- 需要审计 hello→acquire 之间许可/连接改变的竞态，确保绑定的上下文与实际确认对象一致。
- 保持第一轮请求触发主机许可、尚未批准就明确返回等待的语义；不能阻塞游戏线程等待远程授予。

### H06：换图立即失效与动作回执需要协调

位置：SessionMachine.Tick 的 SCENE_CHANGED、ModEntry 的 Invalidated 回调。

- 换图会撤销许可并 Stop 当前动作，move/interact 可能以 RESULT_UNKNOWN 结束，即便角色已进入许可地点。
- 不能仅凭“请求已发送”报告成功，也不宜把所有正常跨图都永久标为不可用。
- 需要记录期望目的地，在本地真实观察成立且输入已释放后给出保守的 partial/已观察效果；随后仍要求新观察/控制，不能自动跨图延续整段任务。
- 补真实门、边界 Warp、过场中撤权、过场中断线测试。

### H07：门、出口与 TouchAction 覆盖不足

位置：MultiplayerRuntime.Guard 的 move / interact。

- 仅识别 Warp 与 Building 的 door，普通地图 Action 门、特殊入口可能未覆盖。
- 当前所有目标 TouchAction 被拒绝，包含可能正常的触发式出口。
- 要审计实际原生动作分支并逐种开放安全目的地；禁止通过 Sleep、剧情、交易等 TouchAction 绕过政策。
- 原任务书 MPL-016 要求真正实现首版必要动作；不能用永久 UNSUPPORTED 冒充完成。

### H08：主机观察当前仅为公开位置摘要

位置：SessionMachine.ObservationRequest/Report、MultiplayerRuntime.ObserveActor。

- 目前没有对浇水等特定效果做主机侧对象核验或动作归因。
- 不能把当前位置观察写成某次共享效果已经主机确认或持久化。
- 决定首版是否补充有界地块观察；若不补，所有对应回执仍保留 local_observed / not_saved 并在文档明确局限。
- 不扩展为任意 Farmer 私有背包/任意地图 dump。

### H09：文件权限、路径与诊断隐私需跨平台复核

位置：PrivatePolicyFile、MultiplayerRuntime 的政策读取、apps/server/src/redact.ts。

- chmod 方案已编译，但未在真实 Linux 上验证 0700/0600。
- 当前检查 root、最终子目录与政策文件，需继续审计父目录 symlink、断链、竞态、写失败后的临时文件清理。
- 现有诊断脱敏规则没有专门覆盖全部新增世界/角色/session/connection 字段。
- Web 和 MCP 正常运行可展示非秘密身份；导出诊断时应另行脱敏，不要破坏内部身份校验。

### H10：账本迁移可用性、回退与查询 UX

位置：ledger.ts、Web receipt 路由、诊断/文档。

- 迁移备份路径已有属性，但尚需清楚提示给用户和恢复流程。
- Web 多作用域 actionId 查询需明确处理 AMBIGUOUS_ACTION_ID，避免只抛通用服务器异常。
- 核对 disconnected / Bridge restart 后的历史主体选择与查询行为。
- 不回滚动作墓碑来“修复”未知状态；旧程序不能盲开 v2 账本。

### H11：文档、验收脚本、打包和真实 UI 尚未收尾

- 尚无正式 MULTIPLAYER_INSTALL / MULTIPLAYER_ACCEPTANCE 等运行文档成品。
- 尚未编写原任务书 MPL-025 所需的完整安全验收脚本。
- README/README.en/PROTOCOL/AGENT_GUIDE/CLIENTS/CHANGELOG/发布清单仍需更新；有些地方仍写仅单人/28 工具。
- Windows pack.ps1 复制 docs 使用固定白名单，新联机文档尚未纳入；Linux 打包也需核对。
- Web 需要真实页面与 390/420 px 布局检查、实际按钮交互、console/pageerror 验证。
- 在上述缺口修复后重新运行受影响测试，再执行安装/回退与打包验证。

## 9. 主目录 Docker 开发线：避免误覆盖

2026-10-24 20:28 左右只读盘点主目录，存在下列未提交改动（不是本次 MP 工作区写入）：

- .gitignore
- adapters/stdio/src/index.ts
- apps/server/src/bridge.ts
- apps/server/src/cli.ts
- apps/server/src/config.ts
- apps/server/src/hosts.ts
- apps/server/src/index.ts
- apps/server/src/launch.ts
- scripts/build.mjs、scripts/test.mjs
- 新 .dockerignore、container-addresses / container-gateway / container-status 等源码
- 新 host-templates.mjs / .d.mts、docker/、scripts/docker/、scripts/source-assets.mjs
- docs/DOCKER_DEVELOPMENT_HANDOFF.md、docs/DOCKER_PROGRESS.md
- docs/MULTIPLAYER_DEVELOPMENT_HANDOFF.md

读取到的 DOCKER_PROGRESS.md 仍标注“implemented_pending_validation”，且说明未构建/测试/运行 Docker。目录和文档可能继续被其他协作者修改；**接手时必须重新检查，不能把本文的快照当作最新 Docker 完成报告**。

尤其 apps/server/src/bridge.ts 是两条开发线的真实交叉文件。之后合并应：

1. 先对两边做快照备份并记录 SHA-256。
2. 以共同基线 63a4f36 为 base，做三方合并。
3. 保留 Docker 网关/地址/宿主模板的改动，也保留 MP Web 与作用域查询端点。
4. 不用 git reset --hard，不用整目录覆盖，不用 git clean 删除对方文件。
5. 在合并结果上重新构建与测试；联机工作区通过不等于合并结果通过。
6. 先更新交接/验证记录，再由原协作者处理 GitHub 同步。

## 10. 建议接手顺序

### 阶段 A：只读确认

~~~powershell
Set-Location -LiteralPath 'F:\星露谷\work\multiplayer-mp1-20261024'
git rev-parse HEAD
git status --short
git diff --stat
Get-Content -LiteralPath 'docs\MULTIPLAYER_IMPLEMENTATION_HANDOVER_20261024.md'
Get-Content -LiteralPath 'docs\MULTIPLAYER_DEVELOPMENT_HANDOFF.md'
~~~

同时核对主目录的 git status；先不要在那里复制覆盖文件。

### 阶段 B：修复并补有意义的测试

推荐顺序：H01/H02 → H03/H05 → H04 → H06/H07 → H08/H09/H10 → H11。

- 对消息乱序/短 TTL/旧 acquire 等直接写纯状态机测试。
- 对作用域与回执一致性写真实 Bridge + 模拟 Mod 测试。
- 对政策、菜单和原生门/工具分支，以实际游戏 API 审计和实机验收为准。
- 修复代码后再运行对应测试，最后完整回归；不要仅增加镜像实现的断言。

### 阶段 C：构建与自动验证

~~~powershell
Set-Location -LiteralPath 'F:\星露谷\work\multiplayer-mp1-20261024'
npm ci
npm run build
npm test
npm run test:mod
dotnet build mods/StardewAgentBridge/StardewAgentBridge.csproj -c Release '-p:GamePath=F:\SteamLibrary\steamapps\common\Stardew Valley' -p:UseSharedCompilation=false
~~~

现有依赖已经安装；确认锁文件没变时无需为了重复验证反复 npm ci。

随后再按最新脚本帮助执行 test:installer、pack、verify:package。先核对发布目录，防止覆盖用户保留的产物；本次尚未执行这些命令。

### 阶段 D：真实游戏验收

只有拥有真人主机与独立 AI 客户端环境时，才可以回填实机结果。使用专门 QA 农场与角色：

1. 人工确认 QA 存档并做独立备份。
2. 主机启用 host-coordinator，AI 客户端启用 farmhand。
3. 原生 Co-op 进入真实农场，读取角色 ID。
4. Web 本地绑定；主机按角色批准地点/区域。
5. 显式 realtime 取得控制，先移动少量格子并停手。
6. 在允许区域浇一格水，核对双方观察，不将 ACK 作为归因证据。
7. 测撤权、F9、Bridge 断开、许可到期、保存切日和旧 actionId 不重放。
8. 核对真人主机能正常继续操作、保存与结束游戏。
9. Windows 与 Linux 分开记录；Docker 集成属于之后的独立验收。

本轮没有替用户选择 QA 存档或启动游戏；接手人不能假定当前运行农场是 QA 环境。

## 11. 现有配置与主机控制台参考

以下是**当前代码的配置结构参考，不表示已安装**。与已有 config.json 合并时保留其他字段。

真人主机：

~~~json
{
  "Multiplayer": {
    "Enabled": true,
    "Role": "host-coordinator",
    "RequireHostCoordinator": true,
    "PermissionLeaseMs": 5000,
    "PolicyFile": "multiplayer/policy.json"
  }
}
~~~

AI 客户端：

~~~json
{
  "Multiplayer": {
    "Enabled": true,
    "Role": "farmhand",
    "RequireHostCoordinator": true,
    "PermissionLeaseMs": 5000,
    "PolicyFile": "multiplayer/policy.json",
    "ExpectedWorldId": null,
    "ExpectedActorFarmerId": null
  }
}
~~~

- Enabled 默认 false，保留原 SP 默认配置。
- DataDirectory 与端口是 Mod 顶层配置；每个独立客户端/数据根需要匹配自己的 Bridge。
- ExpectedWorldId / ExpectedActorFarmerId 应由本机实际绑定填写，不能猜 ID。
- 当前最短 TTL 有 H01 缺口，交接阶段不要用 1000 ms 配置宣称已经可靠。

当前 sab_mp 命令：

~~~text
sab_mp status
sab_mp list
sab_mp bind
sab_mp allow <FarmerID>
sab_mp revoke <FarmerID>
sab_mp area <FarmerID> <x> <y> <width> <height>
sab_mp disable
~~~

命令实际含义：

- bind 用于本地 farmhand 绑定，不是审批主机政策。
- allow/revoke/area/disable 只允许真人主机角色本地执行。
- allow 会启用该角色并允许其当前地点，同时打开自己的材料制作政策。
- area 以该角色当前地点为区域地点，启用浇水范围。
- 政策文件固定为该 Mod 数据根下 multiplayer/policy.json。
- policyRevision 改变时撤销旧许可；继续前需要观察与新控制。
- 默认连续控制预算 120000 ms；预算耗尽后不能靠重连重置，需主机明确重新批准/修改政策。
- 当前撤销命令要求角色在线且安装兼容 Mod；离线政策管理体验需接手人审查，不要认为所有管理场景已覆盖。

## 12. 升级与回退注意事项

- 本轮没有迁移用户真实账本；迁移相关测试使用临时目录，测试结束后已清理。
- 新程序遇到 v1 账本会先生成一致备份，然后升级到 v2。
- 回退应先停 Bridge、释放控制、退出或保守停止自动操作，再复制保留全部数据文件。
- 不要在活跃 SQLite 上只复制 ledger.sqlite 而忽略 WAL；使用一致备份/SQLite backup/VACUUM INTO 或确认关闭全部连接。
- 回退旧程序时使用升级前一致备份的独立副本，保留 v2 原账本供核对，不能覆盖唯一历史。
- 不因为回退而自动重做 unknown 消费动作。
- 不把个人政策、账本或备份作为 Release 内容。

## 13. 联机完整任务书完成度映射

原详细任务书含 MPL-001–MPL-028；下表是本轮真实进展，不是最终验收签字。

| 任务组 | 当前进度 |
| --- | --- |
| MPL-001–004 盘点/边界/身份与契约 | 有文档和实现；仍需版本/能力声明收尾 |
| MPL-005–010 定向消息/主机角色/政策/握手/许可 | 已实现并有隔离测试；H01/H02 等仍待修复 |
| MPL-011–014 控制/世界屏障/观察/目标引用 | 已实现主要路径；真实阶段事件与 UI/观察细节未实测 |
| MPL-015–017 guard/必需动作/禁用分支 | 已实现中央守卫；门/出口覆盖和真实动作效果未完成验收 |
| MPL-018 主机观察与归因 | 只有有界本角色位置观察；没有共享效果的完整主机核验 |
| MPL-019 账本/收据/迁移 | 已实现且相关自动测试通过；H03/H10 待收尾 |
| MPL-020–021 停手/重连 | 代码与隔离测试存在；真实 F9/watchdog/换图仍未验收 |
| MPL-022 MCP | 新只读工具及控制约束已接入；工具数 29 |
| MPL-023 Web | 代码已构建；无真实浏览器验收 |
| MPL-024 自动测试 | 已新增并执行部分；不是完整矩阵覆盖 |
| MPL-025 实机/跨平台验收脚本 | 尚未完成 |
| MPL-026 兼容审查 | SP 自动回归通过；Linux/安装器/打包/Docker 合并未验证 |
| MPL-027 发布文档 | 尚未完成 |
| MPL-028 完整交接 | 本文交接“当前进度与缺口”，不是最终完成声明 |

## 14. 交接包内容与使用方法

桌面同时提供一份 zip 源码改动快照。包内有：

- HANDOVER.md：本文相同内容。
- SOURCE_SNAPSHOT.json：基线、路径、文件清单、每个文件 SHA-256。
- validation-summary.json：本轮已观察到的验证结果摘要。
- tracked-changes.patch：相对共同基线的已跟踪文件补丁。
- source-overlay/：修改和新增文件的完整内容；包含新 MP 模块、测试、原任务书与本交接书。
- SNAPSHOT_README.txt：恢复原则。

这是**增量交接包，不是完整游戏、独立发布包或可直接部署的 Mod**。不包含 node_modules、游戏 DLL、存档、账号凭据与个人政策。

在本机继续：优先直接使用 §1 的联机工作区，源码已经存在。

在其他机器恢复：

1. 克隆项目并检出精确基线 63a4f369feadacf9476660c7af6b1cb9b6ac9a00。
2. 核对包内清单和哈希。
3. 对干净基线应用 tracked-changes.patch，并将 source-overlay 中的新增文件补齐；也可在干净基线上按清单放置完整文件。
4. 不对包含 Docker/他人改动的工作树直接覆盖或盲应用。
5. npm ci 后按 §10 构建验证。
6. 本机游戏 DLL 需要合法安装后自行提供，交接包不会分发它们。
7. 恢复后重新阅读 §8，不能把能构建当作可发布。

## 15. 给用户与最终发布人的简明结论

- 联机首版已经开始实现，并非只有开发计划。
- 已有 Mod、Bridge、Web、MCP、状态机与测试源码。
- 目前 142 项 Node 测试、132 项 C# 断言及真实游戏程序集编译通过。
- 尚有本交接书列明的代码/产品缺口，尚未实机联机、未合并主目录、未安装新版、未提交或上传 GitHub。
- 下一步按 §8 修复并完成文档和真实验收，之后再安全合并 Docker 开发线，由原协作者处理 GitHub。

