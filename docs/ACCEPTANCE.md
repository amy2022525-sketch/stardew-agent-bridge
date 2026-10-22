# 验收方案

修订 2026-10-22：自动化部分**已执行**（证据见 [EVIDENCE.md](EVIDENCE.md)）；实机部分（§5）**待执行**，本文给出可直接照做的步骤与判定标准，执行结果请回填到 §6 表格。

## 1. 分层与边界

| 层级 | 能证明什么 | 不能替代什么 | 当前状态 |
| --- | --- | --- | --- |
| 契约/单元 | 参数、错误映射、签名、去重语义符合定义 | 真实游戏行为 | 已执行，通过 |
| 端到端（真实 MCP SDK + 模拟 Mod） | SDK 兼容、控制权/账本/故障路径正确 | 真实游戏资源变化 | 已执行，34 项通过 |
| Mod 编译 | 代码能在真实游戏程序集下编译 | 运行期行为 | 已执行，0 警告 0 错误 |
| 实机 | 真实存档、真实动作、真实断线/换日 | —— | **待执行** |

**原则**：模拟层再绿也不能写成"游戏内验收通过"；实机未做的项目一律标「待执行」。

## 2. 环境与安全前置

1. Windows 10/11；星露谷 1.6.15；SMAPI 4.5.2；Node ≥ 22.5；.NET SDK（仅编译）。
2. **专门准备一个测试存档**（不要用你的主存档）：
   - 备份：复制 `%APPDATA%\StardewValley\Saves\<存档名>` 到仓库外的安全位置；
   - 或新建一个测试角色，进入游戏后正常保存一次。
3. 游戏处于**单人**模式（多人不支持，会返回 `MULTIPLAYER_UNSUPPORTED`）。
4. 关闭会干扰输入的程序；把游戏窗口保持在前台（SMAPI 的输入注入要求窗口激活）。
5. 记录基线：`git rev-parse HEAD`、`node apps/server/dist/cli.js version`、SMAPI 日志开头 20 行。

## 3. 已执行的自动化验收（摘要）

| 编号 | 项 | 结果 |
| --- | --- | --- |
| T1 | `node scripts/build.mjs` | 通过 |
| T2 | `node scripts/test.mjs`（10 套件 / 34 项） | 通过 |
| T3 | `dotnet build`（真实游戏 DLL） | 通过，0 警告 0 错误 |
| T4 | 实进程 `/health` `/` `/app.js` `/styles.css` | 通过（含无游戏降级） |
| T5 | `scripts/smoke.mjs`（真实 HTTP MCP：28 工具 + status + snapshot） | 通过 |
| T6 | `scripts/pack.ps1`（含禁止文件审计 + 发布包独立运行） | 通过 |

细节与限制见 [EVIDENCE.md](EVIDENCE.md)。

## 4. 实机验收矩阵

| 编号 | 验收项 | 判定标准 | 状态 |
| --- | --- | --- | --- |
| A1 | 只读链路 | 7 个只读工具全部返回真实数据；同一时刻两个客户端拿到同一 `snapshotId` | 待执行 |
| A2 | 基础动作与资源操作 | 每个动作的真实结果与结构化 `effects` 一致（位置/背包/金钱/数量前后变化可核对） | 待执行 |
| A3 | 实时动作 | 钓鱼能完成至少一次完整小游戏；战斗能在 `minHealth` 处停手，不打死角色 | 待执行 |
| A4 | 控制权 | 第二写者被拒；租约到期后写被拒；人工接管后旧 `actionId` 无法再写；`F9` 立即停手 | 待执行 |
| A5 | 故障 | 断开/强杀 Bridge 后游戏 5 秒内停手并尝试暂停；重连后旧请求不生效 | 待执行 |
| A6 | 存档流程 | 跨日不丢控制权语义、换存档后 `epoch` 变化且旧快照引用失效、返回标题后写被拒 | 待执行 |
| A7 | 三宿主短任务 | DSH / Codex / Claude Code 各完成一次"观察→移动→交互→汇报" | 待执行 |
| A8 | Web 控制台 | 状态/时间线/接管/宿主配置向导在真实连接下可用 | 待执行 |

## 5. 逐步执行脚本

准备（每条一次）：Bridge 已 `npm start`；游戏已加载**测试存档**；`npm run doctor` 显示 `Mod 连接=是`。

### 5.1 A1 只读链路

```
stardew_doctor
stardew_status
stardew_snapshot {radius: 8}
stardew_inspect {target: "<snapshot 里任一 entity 的 targetRef>"}
stardew_saves
stardew_recipes
stardew_screenshot
```

然后打开商店（走到杂货店柜台交互）再 `stardew_shop`。
判定：全部 `isError=false`；`snapshot.locations/entities` 与画面一致；`screenshot` 返回 PNG 且与画面对应；`saves` 列出真实存档。
双客户端一致性：第二个宿主/`smoke.mjs` 同时 `snapshot`，`snapshotId` 相同。

### 5.2 A2 基础动作与资源操作

每个动作**前后各一次 `stardew_snapshot`**，核对变化：

| 动作 | 前置 | 核对点 |
| --- | --- | --- |
| `move` | 选一个明显可走到的格子/目标 | `player.position` 变化，且没有穿墙 |
| `select` | 背包有多格物品 | `player.selectedSlot` |
| `use` | 面前是空地（锄/水壶）或可交互物体 | 地块状态 / 目标状态变化、体力下降 |
| `interact` | 门、NPC、信箱 | 场景变化 / 对话菜单出现 |
| `menu` | 对话或信件菜单打开 | 选项推进，附件不遗漏 |
| `closemenu` | 打开过背包/商店 | 菜单关闭、手持物品不丢 |
| `buy` | 商店打开、钱够 | `money` 减少 = 单价×数量、背包对应增加 |
| `ship` | 附近有出货箱 | 箱子内容增加、背包减少 |
| `container` | 附近有箱子 | `list`/`deposit`/`withdraw` 数量一致 |
| `craft` | 材料足够 | 材料减少、成品增加 |
| `place` | 手持可放置物 | 目标地块出现该物件 |
| `eat` | 背包有食物 | 体力/生命上升、数量-1 |
| `equip` | 背包有装备 | 对应装备槽变化、背包相应变化 |
| `wait` | 任意 | 时间推进、无异常 |

**消费动作重点**（购买/出售/制作/食用/投箱）：每次都用**新的** `actionId`；然后故意重复调用上一次的 `actionId`，期望**不再次扣钱/扣物**，而是回放上次终态。

### 5.3 A3 实时动作

```
stardew_fish {milliseconds: 45000}     # 需站在水边、手持鱼竿
stardew_combat {target: "@s..:e..", milliseconds: 5000, minHealth: 30}
```
判定：钓鱼若捕获到鱼，`effects` 里背包与经验变化可核对；未捕获要能说清是"咬钩超时"还是"小游戏失败"（回执里有 stages）。战斗在 `minHealth` 附近停手，角色生命不低于阈值。

### 5.4 A4 控制权

1. 客户端 A：`stardew_session {operation:"start"}` → 拿到 `controlSessionId`。
2. 客户端 B：直接 `stardew_move` → 期望 `CONTROL_REQUIRED`/`CONTROL_BUSY`。
3. 等租约过期（默认 180 s；可临时把 `config.json` 的 `leaseTtlMs` 调小加速）后再写 → 期望 `CONTROL_EXPIRED` 或 `CONTROL_REQUIRED`。
4. 网页点「接管」→ A 再写 → 期望 `CONTROL_EXPIRED`。
5. 游戏内按 `F9`：正在执行 `stardew_fish` 时应立即停止、`status` 显示无在途动作、控制权被撤销、游戏自动暂停。

### 5.5 A5 故障

| 步骤 | 期望 |
| --- | --- |
| 在 `stardew_fish` 进行中 `taskkill /F /IM node.exe`（或关掉 Bridge 窗口） | 游戏 5 秒内停止输入与动作，撤销控制权，关闭时尝试正常暂停；SMAPI 日志有 `Bridge 失联：…` |
| 重启 Bridge，再发写请求 | 必须先 `stardew_session start`；旧的 `actionId` 不会被执行 |
| 断开网络/GitHub 等外部依赖 | 与本项目无关（全本机），不应受影响 |

### 5.6 A6 存档流程

1. 睡一觉（跨日）后 `snapshot`：日期推进、作物状态正确、控制权语义不变（同一会话可继续写或明确要求重新 start）。
2. `stardew_saves` → 选一个**其他**存档 `stardew_load {saveId}`：加载成功；加载前拿到的 `targetRef` 再用一次 → `STALE_REF`；`epoch` 已变化。
3. 返回标题后再写 → `NO_SAVE_LOADED`。

### 5.7 A7 三宿主短任务

对 DSH / Codex / Claude Code 各做一次：
`doctor → snapshot → session start → move 到某目标 → interact → snapshot → 汇报`。
判定：三者在同一份账本里留下回执；两个宿主同时连接时读一致、写互斥。

### 5.8 A8 Web 控制台

真实连接下检查：状态卡（连接/存档/控制者）、时间线随动作滚动、`接管`/`停止`按钮生效、「连接其他 Agent 宿主」生成片段可直接粘贴、`导出诊断` 生成 zip 且**不含令牌**。

## 6. 结果回填（执行后填写）

| 编号 | 结果（通过/失败） | 证据（日志片段/回执 id/截图） | 执行人 | 日期 |
| --- | --- | --- | --- | --- |
| A1 | 待执行 | | | |
| A2 | 待执行 | | | |
| A3 | 待执行 | | | |
| A4 | 待执行 | | | |
| A5 | 待执行 | | | |
| A6 | 待执行 | | | |
| A7 | 待执行 | | | |
| A8 | 待执行 | | | |

## 7. 失败时

- 任何一项失败都**不修改判定**，先记录现象与回执，再修代码。
- 出问题先 `F9` 停手，再 `rollback-mod.ps1` 回滚 Mod，最后用备份恢复测试存档。
- 修复后从 `T1` 重跑自动化，再重跑对应实机项。
