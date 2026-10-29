# 附：接手核查更新（2026-10-24 深夜 · 接手 AI）

> 本附录由接手 AI 于 2026-10-24 深夜追加，只记录接手后新核实的事实。正文（原始交接档案全文）保持原样；两部分如有出入，以本附录为准。诚实规则沿用正文：未实测的项目一律记为未完成，不把模拟通过写成实机可用。

## 更新一：交接快照之后，工作区又有新改动（关键事实）

桌面 zip 快照（2026-10-24 20:36 打包）与 F:\星露谷\work\multiplayer-mp1-20261024 工作区逐文件 SHA-256 比对：54 个快照文件中 51 个完全一致，**3 个文件在快照之后（当晚 21:13–21:17）被继续修改**：

| 文件 | 快照 → 工作区 | 改动内容（对照正文 §8 缺口编号） |
| --- | --- | --- |
| mods/StardewAgentBridge/Multiplayer/SessionMachine.cs | 19,796 → 21,011 字节 | **H01**：续期不再固定 `now()+1000`，而是按实际许可 Deadline 减去提前量（已观察授予往返延迟+50ms，下限 250ms）调度 LeaseRequest；接受授予时记录 lastGrantDelay 并同步下次续期时刻。**H02**：新增 acquireGeneration；ReleaseControl 递增代次、撤销本地许可并清理全部在途 LeaseRequest 关联；Consume 拒绝代次不匹配的旧授予——旧一次 start 的迟到授予不能被下一次 start 借用。 |
| mods/StardewAgentBridge/Multiplayer/MultiplayerRuntime.cs | 17,700 → 19,152 字节 | **H04（部分）**：新增 WriteCommands()——把 MP1 支持矩阵与当前角色的主机政策逐项求交集（AllowMovement / AllowWatering / AllowOwnInventoryCraft / AllowOwnFood / AllowOwnEquipment），未授权、不在许可地点或非联机 profile 时不宣称任何写命令。**H05（部分）**：CheckControl 增加请求携带的 ActorContext 参数，acquire/renew 必须与机器当前真实作用域一致，防止 hello→acquire 之间许可/连接改变后借用旧上下文继续。 |
| mods/StardewAgentBridge/ModEntry.cs | 28,159 → 28,565 字节 | **H04（部分）**：hello 的 writeCommands 改用 multiplayer.WriteCommands()（联机世界或已启用 MP 配置时），features.shipping 在联机世界改为 false；**H05（部分）**：control 回执的 actorContext 从“回显请求携带值”改为携带 Machine.Scope 实际确认的作用域。 |

其余 51 个文件（含全部 Node 侧源码与测试）与快照逐字节一致；**正文 §8-H03（action-service.ts 回执一致性）未被触碰**。

上述 C# 改动的配套测试**尚未编写**：tests/mod/MultiplayerTests.cs 与快照一致（20:10，早于代码改动），H01/H02 要求的 1000/1001ms TTL、临近连续预算、release→start→旧 grant 到达、乱序/重复消息等用例仍缺。

## 更新二：接手后本机复验结果（全部来自本会话实际终端输出）

| 检查 | 实际结果 |
| --- | --- |
| npm test（当前工作区源码） | 147 项：pass 142、fail 0、skip 5（仅 Linux 桌面入口用例）、约 52 秒——与正文 §5 一致，可复现 |
| dotnet run --project tests/mod/ControlTests.csproj | 132 checks passed——与正文 §5 一致；快照后 3 文件改动未破坏现有断言 |
| dotnet build 真实 Mod（引用 F:\SteamLibrary 游戏 DLL，Release） | 成功；0 警告 / 0 错误——快照后改动通过真实游戏程序集编译 |
| 快照 vs 工作区逐文件哈希 | 51/54 一致；仅 ModEntry.cs、MultiplayerRuntime.cs、SessionMachine.cs 不同 |
| 三份交接文档哈希 | 桌面 MD、zip 内 HANDOVER.md、docs/MULTIPLAYER_IMPLEMENTATION_HANDOVER_20261024.md SHA-256 一致（bf3cbe97…） |
| 主目录 D:\星露谷\stardew-agent-bridge | 仍为基线 63a4f36 + Docker 未提交改动；比快照时又多出新文件（如 DOCKER_HANDOVER_REPORT.md、tests/src/docker-bundle.test.ts），本次未触碰 |

## 更新三：正文 §8 缺口状态刷新（含接手 AI 两个会话的修复，以本附录为准）

| 缺口 | 状态（2026-10-25 凌晨第二接手会话结束时） |
| --- | --- |
| H01 | **已修复并测试**：续期按实际 TTL 调度；8 项状态机测试（提前续期时刻、1000ms 连续续期无空档、999/1000/1001ms 边界、预算耗尽撤权），反向验证旧实现必败 |
| H02 | **已修复并测试**：acquire 代次 + 释放清理在途请求；9 项测试（release→start→旧授予、双 start 代次、重复重放、撤权→start），反向验证同上 |
| H03 | **已修复并测试**：不匹配/缺失 actorContext 的 succeeded/partial 回执统一归一为 unknown 并按最终值重建 summary/durability；1 项组合测试，反向验证 |
| H04 | **代码完成**：WriteCommands 政策交集（前会话）+ writeCommandsReason 拒绝原因（本会话，与错误码同名：FARMHAND_REQUIRED/WORLD_TRANSITION/ACTOR_BINDING_REQUIRED/HOST_PERMISSION_REQUIRED）；features 审计——shipping/stepPause 已门控，其余键 Bridge 侧无逻辑消费。真实 Mod 编译 0 警告 0 错误；实机行为验证属验收 |
| H05 | **代码完成 + 静态审计结论**：acquire/renew 校验请求携带上下文、回执携带实际确认 Scope（前会话）；本会话审计确认全部处理在游戏线程串行、Bridge 会话绑定以 hello 轮询为准、丢许可即关会话，hello→acquire 竞态 fail-closed，无需进一步改码 |
| H06 | 未动（换图与动作回执协调需实机观察语义，属验收+后续能力） |
| H07 | 未动（门/出口/TouchAction 覆盖需实际游戏 API 逐种审计，属验收） |
| H08 | 未动（首版维持仅位置观察，回执保留 local_observed/not_saved 并在文档明确局限） |
| H09 | **Bridge 侧完成**：redact.ts 键名单纳入 worldId/actorSessionId/hostSessionId/connectionId/permissionLeaseId/actorFarmerId/hostFarmerId（含嵌套 actorContext），诊断预览/导出测试通过（真实 HTTP + 导出文件断言）。PrivatePolicyFile 的 Linux chmod 0700/0600 实机验证仍属验收 |
| H10 | **代码完成**：/api/v1/receipt 多作用域 actionId 返回 409 + AMBIGUOUS_ACTION_ID 结构化错误（不再通用 500）；带 worldId+actorFarmerId 查询正常；测试通过。迁移备份提示已写入 MULTIPLAYER_INSTALL.md §6 |
| H11 | **大部分完成**：新增 docs/MULTIPLAYER_INSTALL.md 与 MULTIPLAYER_ACCEPTANCE.md；pack.ps1、scripts/linux/pack.mjs 白名单与 verify-package.mjs 工具数断言（3 处 28→29）已同步；README/README.en/PROTOCOL 工具数改为 29 并补 stardew_multiplayer 条目；CHANGELOG 新增诚实的 MP1 源码条目（明确"未发布、未实机验收"）。Web 真实浏览器（390/420px、pageerror、按钮交互）验收仍未做 |

## 更新四：接手会话最终回归结果（全部实际执行）

| 检查 | 结果 |
| --- | --- |
| npm test | **149 项：pass 144、fail 0、skip 5**（仅 Linux 桌面入口用例），约 60 秒 |
| dotnet run --project tests/mod/ControlTests.csproj | **149 checks passed**（原 132 + H01/H02 新增 17） |
| dotnet build 真实 Mod（引用 F:\SteamLibrary 游戏 DLL，Release） | 成功；**0 警告 / 0 错误**（含 H04 的 WriteCommandsReason） |
| 反向验证 | H01/H02：旧 SessionMachine 下首个新测试即失败；H03：旧 action-service 下新测试为唯一失败项。H09/H10 测试直接断言真实 HTTP 状态码/导出文件内容，旧代码下结构性必败，未重复执行反向验证 |

## 更新五：完整非实机检验链（2026-10-25，用户要求"检验一遍，不做实机测试"）

按交接正文 §10 阶段 C 顺序全程实际执行，未启动游戏/Steam/双客户端（安装器与打包测试均使用临时 fixture；对游戏 DLL 仅编译引用）：

| 步骤 | 结果 |
| --- | --- |
| npm run build（TS 项目引用 + Web 类型检查/打包） | 通过 |
| npm test | 149 / 144 pass / 0 fail / 5 skip |
| npm run test:mod | 149 checks passed |
| npm run test:installer | 17 installer checks passed（临时 fixture） |
| npm run pack -- --game-path <游戏目录> | 首跑**失败**：verify-package.mjs 三处工具数断言仍为 28（正文 H11 所述遗漏的真实实例）；修复后通过：release/StardewAgentBridge-0.1.0，27 个文件，包内独立验收 15 项全过 |
| npm run verify:package（独立复跑） | 15 项通过（含 "portable HTTP MCP lists 29 tools"、校验和一致、无私有数据/游戏文件） |

检验中修复的遗漏：verify-package.mjs:234/249/259-260 工具数 28→29；scripts/linux/pack.mjs 文档白名单补两份 MP 文档；README.md（架构树 + §3 工具表加 stardew_multiplayer）、README.en.md（两处）、docs/PROTOCOL.md 工具数改 29；CHANGELOG.md 顶部新增 2026-10-25 联机 MP1 条目（如实标注未发布、未实机验收）。

## 更新六：下一步（交给验收）

1. **验收侧**：按 docs/MULTIPLAYER_ACCEPTANCE.md A→G 逐项执行并记录；A 组自动回归的当前预期即更新四/五的数字（149/144/0/5、149 checks、打包 15 项）。
2. **代码侧剩余**：H06/H07 的原生动作覆盖扩展需实机逐种审计后决定是否纳入首版；H11 剩 Web 真实浏览器验收。
3. 实机验收需要真人主机 + 独立 AI 客户端 + QA 存档环境；不具备时相应项保持 not_run。
4. GitHub 提交/推送仍由原协作者负责；主目录 Docker 线合并按正文 §9 流程，未开始。
