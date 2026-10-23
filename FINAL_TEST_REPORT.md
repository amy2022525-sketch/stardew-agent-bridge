# 项目复核与测试报告（更新至 2026-10-23）

本报告区分模拟测试、实际源码隔离检查、真实游戏和真实浏览器。原 `HANDOVER_REPORT.md` / `docs/EVIDENCE.md` 的 34 项测试记录属于较早交付；当前以本报告为准。

## 2026-10-23 Web MCP 连接面板补充

Web 增加靠前的「MCP 连接」入口，支持复制服务地址，按 DSH、Codex、Claude Code 或通用客户端生成、复制与下载配置，自定义连接名称，以及实际 HTTP/stdio 通道检测。检测会完成 MCP 握手、28 个工具发现和只读 `stardew_status` 调用；使用独立检测身份，不将自检冒充 Agent 接入。网页仅列出真正执行过工具的客户端，新旧 MCP 协议均记录工具调用次数。

- TypeScript / Web 构建通过；Node **51/51、12 套件**通过，新增 5 项覆盖会话/同源/CSRF、配置可用性与令牌复用、非法参数拒绝、HTTP 与 stdio 真实检测。
- Edge 无头浏览器连接隔离 Bridge，**11 项通过，pageerror=0**：地址复制、配置生成与复制下载、HTTP/stdio 实际调用、自检身份隔离、客户端记录、失败提示保留、非法名称、Codex/Claude 配置以及 390px 无横向溢出。复制检查使用浏览器内 Clipboard API 测试替身，下载文件已实际核对。
- 自动测试底层仍为模拟 Mod；本次只读检测未取得游戏控制权。生成模板和本机通道检测不能证明其他宿主已经导入配置、完成游玩任务。
- C# Mod 和工具协议本次没有改动；保留下文真实游戏历史证据及其适用范围，不将它们写为本次全部复测。
- 更新后的便携包复制到仓库之外并清除 `NODE_PATH`，**13 项通过**。在原有 10 项上增加 Web MCP 元信息、HTTP 通道检测和 stdio 通道检测，验证新增 MCP 客户端依赖已被打包。25 个文件、24 项 SHA-256 校验一致；沿用已安装的 Mod 构建。
- 已备份并更新本机独立程序；真实浏览器连接安装目录运行的 Bridge，另有 **6 项检查通过，pageerror=0**。生成的 DSH 配置指向已安装适配器，HTTP/stdio 实际往返均返回 28 个工具；既有 DSH 令牌保留，动作账本仍为 12 条。部署时游戏未运行，未启动或加载存档。

本机私有证据：`work/web-mcp-20261023/` 下的浏览器结果、便携包验证、部署记录、桌面及窄屏截图。原安装程序备份也保留于该目录。其余项目复核记录如下，表中的 46 项测试与 9 项浏览器检查为 2026-10-22 历史结果。

GitHub 复核补充：提交 `1f786c7` 的首轮 Windows CI 构建通过，Node 测试 50/51；失败来自随机端口 `49855` 的 `listen EACCES`，新增 5 项 Web MCP 测试均通过。测试脚手架与仓库外便携验收现会跳过 `EACCES` / `EADDRINUSE` 候选端口，保留 32 次上限，其他错误仍直接抛出。修正后本地 Node **51/51** 与仓库外便携 **13 项**均再次通过，证据在 `work/sync-web-mcp-20261023/`；远端结果以相应提交的 GitHub Actions 实际状态为准。

## 结论与发布范围

当前适合公开为 **0.1.0 源码预览**。本次修复并验证了核心控制、取消、去重、安装与部分实机路径，但没有完成全部游戏动作、三宿主以及长期自主游玩验收，不发布稳定版 Release。

| 层级 | 结果 | 实际证明范围 |
| --- | --- | --- |
| TypeScript / Web 构建 | 通过 | 项目引用编译、Web 类型检查与打包 |
| Node 测试 | 46/46，11 套件，通过 | 参数、身份、控制权、账本、并发、去重、故障、HTTP 新旧 MCP 取消、stdio；底层为模拟 Mod |
| C# 控制源码隔离检查 | 17 项通过 | 链接实际 ControlAuthority / ActionCoordinator / Protocol 源码，游戏接口为测试桩；不等于实机 |
| Windows 安装/回滚 | 17 项通过 | 源码和便携目录、中文/空格路径、UTF-8 无 BOM 中文 manifest、旧 Mod 备份、配置保留、恢复及路径边界 |
| 游戏 Mod 编译 | 通过，0 警告、0 错误 | 引用本机真实游戏程序集，目标 net6.0 |
| 真实游戏 | 部分通过 | 见下方 A1–A6 |
| 真实浏览器 | 9 项通过，pageerror=0 | 实际连接、快照、诊断、配置向导、提示保留、接管、开始/结束控制、390px 无横向溢出 |
| 真宿主接入 | 未完整执行 | SDK 客户端不等于 DSH / Codex / Claude Code 真宿主验收 |

本机：Windows 10，Node 22.23.1，.NET SDK 10.0.302，游戏 1.6.15 build 24356，SMAPI 4.5.2。源码构建与隔离测试使用 SDK 10，游戏 Mod 仍使用游戏自带运行环境。

## 接续与修复

继续工作使用用户指定的 D 盘项目，保留了从上轮带来的未提交修复；F 盘旧副本没有作为最新交付覆盖回去。接手时 D 盘的新增检测日志在控制测试启动处停住，没有发现新的正式检测报告。

已修复并有针对性证据的项目：

- 真并发 start 在 Mod 确认前也保持互斥；世界代次变化关闭旧会话；Mod 校验有效租约和 epoch，不能靠 renew 复活已释放/过期控制权。
- HTTP MCP 保留 Bearer 调用者身份；旧 `2025-11-25` 协议使用有状态传输支持取消，现代 `2026-07-28` 的取消同样定向停止原动作。stdio 转发也传递取消，并将写入传输故障保留为未知结果。
- 旧客户端或未知 actionId 不能发出无条件 stop 干扰新动作。
- 只恢复 Mod 自己创建的具体暂停菜单；按照 `shouldTimePass()` 报告实际暂停，不把所有菜单都等同于暂停。
- 游戏运行中的动作异常、停止或断线可能已有副作用，按 unknown / effectKnown=false 处理。核验失败和加载异常也不再暗示确定未消费。
- 异步加载返回 accepted / verified=false；钓鱼/战斗 partial 不伪装成成功；购买数量不足保留 partial，资源和阶段证据不会被统一映射丢掉。
- `stardew_status {actionId}` 可查原收据；崩溃窗口只留下意图时也能查询为 unknown，不隐藏记录，不重放。
- 诊断预览与导出对嵌套事件/收据递归脱敏；测试实际验证了令牌、用户名、存档标识与本机路径不会原样进入导出。
- 安装/回滚将旧桥接备份到 Mods 外；兼容便携布局；游戏运行时拒绝替换；显式用 UTF-8 解析中文 manifest。
- 游戏端 Protocol 将箱子 list 正确归为只读，不要求 actionId；deposit/withdraw 仍要求有效写动作 ID。该问题由真实游戏发现，隔离测试和修复后的实机均已验证。
- 测试端口改为在明确范围内申请、最多重试 32 次，修复 Windows 低端口导致的 fetch bad port，以及之前无界递归申请高端口造成的卡住。
- 修复中文/空格 URL 路径和便携 stdio 入口；构建/测试/打包调用本地工具；Web 操作反馈不会被轮询立即覆盖，窄屏布局不再溢出。

早先的 SMAPI `OutOfMemoryException` 未通过更换 DLL 或修改游戏资源掩盖。本轮串行测试并重新启动后，新 Mod 成功加载，后续正常握手和真实动作均有记录。未修改系统分页文件，也未批量结束用户的 node 进程。

## 真实游戏矩阵

只使用预先备份的专用 QA 存档；其既有物品和进度为测试夹具，不宣称本轮自主挣得。未加载另外两个用户存档。

构建边界补充：本机部署的最终文件核对发现，前述动作测试及首次 DSH 只读调用使用的已安装 Mod 内嵌提交为 20af3e7；当前源码提交为 b7df4c1，两者之间包含游戏侧控制权等修复。部署时已正常退出标题页、保留旧版备份并安装当前构建（完整 DLL SHA-256 为 ce8af811c22a20333af9564ce8d5702ca877faf91bc8c3d96c9681a1cfa2b6c0）。当前构建的本次验收限于启动、握手与只读接入，不能把下面的历史动作证据视为当前构建全部动作重新通过。

| 编号 | 状态 | 证据和边界 |
| --- | --- | --- |
| A1 观察 | 部分通过 | doctor、saves、snapshot、inspect、recipes、PNG screenshot 已走真实 MCP 和真实 Mod；画面与角色、金钱、日期、背包对应。未实测商店清单 |
| A2 动作/资源 | 部分通过 | select 连续两次、move 寻路、container list/deposit/withdraw、craft、place、wait 通过。尚未覆盖所有 use/interact/menu、buy/ship/eat/equip 路径 |
| A3 实时动作 | 未执行完整实机验收 | 钓鱼完整小游戏、入包核验、战斗生命阈值和伤害尚未实测；模拟/代码通过不代替成功钓鱼或战斗 |
| A4 控制 | 部分通过 | 实际 Web 接管、开始/结束控制生效；模拟层覆盖多客户端竞争、过期与跨世界失效。F9 和真实双宿主并发仍待测 |
| A5 故障 | 部分通过 | 明确确认 wait 在途后只终止本次 Bridge PID；SMAPI 记录失联停止、释放输入、撤权；重启后无控制者、输入 inactive、正常 GameMenu 暂停。未测试正在钓鱼时强杀 |
| A6 存档 | 部分通过 | 正常标题加载 QA，accepted 后另行观察 saveLoaded=true，重新取得控制。未覆盖睡眠、跨日、正常保存与再次切换 |
| A7 三宿主 | 部分通过 | DSH Desktop 0.2.0-rc.2 + MCP连接器 0.2.70 已真实发现 28 工具，kimi-k3-1 调用 status 成功、标题页 snapshot 返回 NO_SAVE_LOADED；尚无三个宿主各自完成游戏短任务的证据。本机未发现 claude CLI |
| A8 Web | 通过本次 9 项检查 | Edge 无头浏览器操作真实 Bridge；检查真实连接与快照、诊断、配置向导、操作提示、人工接管、控制开始/结束及 390px 宽度 |

资源核对示例（真实回执与前后快照，未改存档）：

1. `final-deposit-wood`：背包木材 90 → 89。用完全相同 actionId/参数再次提交，返回原收据，木材仍为 89。
2. `final-withdraw-wood`：箱子取回 1 木材，背包恢复 90。
3. `final-craft-fence`：使用 recipes 实际返回的 Wood Fence 配方制作 1 次，木材 90 → 88，围栏增加。
4. `final-place-chest`：对实际观察到的相邻空地放置，背包箱子 1 → 0。
5. `review-watchdog-wait`：Bridge 在途被结束，客户端没有得到终态；重启后按原 ID 查到 unknown / effectKnown=false / verified=false。没有以新 ID 重放。

故障日志：wait 意图时间约北京时间 22:41:28，SMAPI 在 22:41:33 记录失联收手。日志间隔约 5 秒；这不是严格的实时性上界测量。重连观察确认 controller=null、realtimeInput.active=false、pause=paused/selfOpened=true。

测试后通过窗口正常关闭游戏，没有睡眠或保存。本机存档目录前后各 15 个文件，逐一 SHA-256 对比全部一致，无新增/缺失；游戏进程已退出。实际资源变化仅用于当次 QA 游戏会话，没有写回存档。

## 复现与证据

```powershell
npm ci
npm run build
npm test
npm run test:mod
npm run test:installer
# 下两项需要你本机合法安装的游戏；安装时必须退出游戏。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-mod.ps1 -GamePath '<游戏目录>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack.ps1 -GamePath '<游戏目录>'
```

本机原始证据位于项目的 `work/resume-20261022/`：build.txt、node-tests.txt、mod-tests.txt、mod-build.txt、installer-tests.txt、install-game.txt、game-evidence.json、watchdog.json、game-watchdog-after.txt、SMAPI-real-game.txt、web-qa.json 和 Web 截图；较早 MCP 调用及游戏截图在 `work/review-20261022/`。这些本机证据被 Git 忽略，不上传凭据、存档或完整私有日志。

GitHub Actions 已增加独立于游戏的 Windows 构建、Node 测试、C# 隔离检查和安装脚本检查；它不会上传游戏程序集。远端执行结果以上传后的实际运行状态为准，不能把本地通过写成远端已经通过。

## 便携包与公开源码检查

- 最新打包默认重新构建并执行 Node 测试：46/46；游戏 Mod 重编译 0 警告、0 错误。
- 本地 `release/StardewAgentBridge-0.1.0/` 共 25 文件；CHECKSUMS.txt 覆盖其余 24 个文件，逐一 SHA-256 核对通过。只含本项目 Mod DLL，不含游戏 DLL、存档、凭据、数据库或源映射。
- 初次便携检查的目标仍在仓库 work 下，不能排除从祖先 node_modules 解析依赖；本机独立安装实际发现缺少 Ajv。已改用静态导入，并在 pack 中强制执行 scripts/verify-package.mjs：复制到仓库之外的系统临时目录，从另一中文且含空格的工作目录启动独立数据目录，清除 NODE_PATH 后 10 项检查通过，涵盖版本、stdio 配置路径、Web 资源、HTTP MCP 28 工具、已认证状态、无游戏降级、stdio 真往返及校验清单。
- 已扫描当前 110 个拟公开源码文件及既有 3 个提交历史；未发现禁止目录/二进制、已知本机凭据或常见真实密钥模式。扫描是发布核对，不能推导为所有依赖或代码不存在安全缺陷。
- 本轮测试 Bridge 与游戏进程已结束；本机保留安装的当前 Mod、旧版备份及私有 QA 证据。GitHub 仅上传源码，不上传此本地便携二进制目录。

后续本机部署补充：已将修复后的便携包安装到用户应用数据目录，以单独的 dsh 客户端身份接入桌面版 DSH，连接范围为全局、stdio、始终注入。真实会话轨迹包含 mcp__stardew__stardew_status 与 mcp__stardew__stardew_snapshot；前者确认 Bridge/Mod 连接，后者明确返回标题页未加载存档。DSH 未执行写动作。部署证据另存 work/deploy-dsh-20261022/；旧星露谷插件及不兼容的插件管理器仅停用并保留安装和备份，dsh-context 的既有停用状态保留。本次部署最后保留游戏标题页、Bridge 与正常模式 DSH 供用户使用，不适用上一条测试结束时的进程状态。

## 尚需完成的验收与已知限制

- 补齐矩阵中的全部动作、真实钓鱼/战斗、F9、跨日保存和三个宿主的短任务；长期无人值守稳定性尚无本轮证据。
- 同一 clientId 的多个连接共享该身份的活动会话；独立控制者应使用独立 clientId/令牌，并显式携带 controlSessionId。不是自动实现对话级隔离。
- load 的原回执保持 accepted，真实就绪需另看 doctor/snapshot；目前不会自动改写原收据为加载完成，可能仍列在未决项中。
- 异步加载结束到下一次正常暂停动作之间，游戏可能推进时间；不要把标题页加载 accepted 的暂停状态当作加载后世界已暂停。
- minHealth 是停止发起新攻击的阈值，不保证玩家绝不被敌人打到阈值以下。
- 仅 Windows 单人；配置模板存在不等于所有宿主版本已经实测。游戏更新后必须重新验证。
- 安装事务失败中途、RemoveOnly 后再次恢复等更多异常分支仍可扩充测试。原始 Mod 和 QA 初始备份保留在本机，不进入仓库。

## 发布约束

允许在已授权的公开 GitHub 仓库上传源码和此报告；不将本次部分实机验收描述为全部完成。不上传游戏 DLL、存档、凭据、SQLite 数据库、本机日志或截图。稳定版标签和 Release 等完整实机与宿主验收后再发布。
