# D1 交付报告：双模型决策执行器（AI 任务助手）

```text
完成状态：部分编写完成。
验证状态：已通过 Windows 类型检查、构建、自动化测试、Mod 纯函数与真实游戏 DLL 编译、安装器、隔离源树 npm ci、Windows 便携包和部分真实浏览器验收；未调用真实模型、未操作真实游戏，Linux/容器运行验收仍未完成。
开发基线：04a939cce6af1ed98b15634d4e223d2e8745ab1c（main）
交付时 HEAD 与工作区：同一提交；工作区有未提交改动（见 §2），未提交、未推送。
运行时默认：新功能关闭（decision/config.json 不存在或 enabled=false），原直接 MCP 模式保留。
```

> 保留“部分编写完成”的原因是：部分规格用例仍只有手工步骤，尚无真实模型/实机和完整 Linux/容器运行证据。
> 类型检查、构建、lockfile 实际安装、Windows 打包与私密文件排除已经复核，不再作为未完成事项。
> 原协作者于 2026-11-01 另行独立复核并修复问题，详见 §12；不能把自动化或 Mock 浏览器验收扩大为实机验收。

---

## 1. DEC-001～022 状态

| 编号 | 状态 | 主要文件 | 遗漏 / 原因 |
| --- | --- | --- | --- |
| DEC-001 | implemented_pending_validation | `docs/adr/DECISION_EXECUTOR.md`、`PLAN.md` | 无 |
| DEC-002 | implemented_pending_validation | `packages/contracts/src/decision.ts`、`tools.ts`、`validate.ts`、`errors.ts` | 无 |
| DEC-003 | implemented_verified | `mods/.../WorldIdentity.cs`、`ModEntry.cs`、`Observations.cs`、`protocol.ts`、`snapshot.ts`、`tests/mod/WorldIdentityTests.cs` | C# 已编译并通过 `test:mod`（189 checks）；Mod 仍未在真实游戏中加载 |
| DEC-004 | implemented_pending_validation | `packages/decision-core/src/store.ts`、`migrations.ts` | 迁移只有 v1 + 备份/拒未来版本；没有历史版本升级路径（本来就是首版） |
| DEC-005 | implemented_verified | `apps/server/src/decision-config.ts`、`decision-secrets.ts`、`config.ts` | Docker `secretFile` 只按 `/run/secrets/` 白名单读取；未做镜像层扫描 |
| DEC-006 | implemented_pending_validation | `packages/decision-core/src/budget.ts` | 无货币估算（本版不做价格表） |
| DEC-007 | implemented_pending_validation | `providers/responses.ts`、`chat-compatible.ts`、`http-client.ts` | 未对真实厂商做兼容验证；只按协议实现 |
| DEC-008 | implemented_pending_validation | `memory-store.ts`、`memory-search.ts`、`apps/server/src/decision-memory.ts` | 无 embeddings/FTS（设计如此） |
| DEC-009 | implemented_pending_validation | `context-builder.ts` | 观察裁剪按实体/背包/记忆/收据顺序；未做目标区域优先排序 |
| DEC-010 | implemented_verified | `tool-policy.ts`、`decision-config.ts` | 4 种 guard + 表驱动准入：无保护的高影响工具在保存配置时即拒绝；购买/交互/菜单/wait 明确不可开启 |
| DEC-011 | implemented_pending_validation | `apps/server/src/decision-game-port.ts` | 只读工具仍走 ActionService；未做独立读缓存 |
| DEC-012 | implemented_pending_validation | `completion.ts` | 四种条件；`crop_tiles_watered` 依赖 Mod 覆盖范围 |
| DEC-013 | implemented_pending_validation | `runner.ts` | 未处理“模型纠错后用最新观察重建上下文”（纠错复用同一轮上下文） |
| DEC-014 | implemented_pending_validation | `task-service.ts`、`task-query.ts` | 单槽/幂等/CAS 已写；未做跨实例恢复编排 |
| DEC-015 | implemented_verified | `bridge-tool-router.ts`、`bridge.ts` | 三个入口统一路由，`decision-api`/`decision-runner` 自动化已通过；真实 MCP 宿主未联调 |
| DEC-016 | implemented_verified | `decision-api.ts`、`bridge.ts`、`decision-panel.ts`、`main.ts` | SSE 采用规范允许的替代：状态带 `bootId`，重连 `onopen` 强制全量刷新；未做逐 seq gap 比对 |
| DEC-017 | implemented_pending_validation | `apps/web/src/decision-*.ts`、`index.html`、`main.ts`、`styles.css` | 已做真实浏览器 + Mock 的首次配置、暂停/接管/取消、390px、标题 XSS 与完成结果检查；多标签页、同源重启和浏览器密钥持久化仍待验 |
| DEC-018 | implemented_pending_validation | `bridge.ts`、`runner.ts`、`config.ts` | F9 依赖 Mod 的 `mod_control_changed` 事件；未实机验证 |
| DEC-019 | implemented_pending_validation | `paths.ts`、`package.json`、`tsconfig*.json`、`scripts/pack.ps1`、`scripts/linux/pack.mjs`、`verify-package.mjs`、`package-lock.json` | 独立源树 npm ci、Windows 完整包/便携自检和 Docker bundle 已通过；Linux 包与容器镜像/运行验收未执行 |
| DEC-020 | **partial** | `tests/src/decision-*.test.ts`、`tests/mod/WorldIdentityTests.cs`、`docs/DECISION_EXECUTOR_ACCEPTANCE.md` | 自动化已全部通过；并发双客户端、Bridge 级 F9/接管、任务库写失败注入仍只有手工步骤 |
| DEC-021 | implemented_pending_validation | `docs/DECISION_EXECUTOR.md`、`ACCEPTANCE`、`adr/`、README/PLAN/AGENT_GUIDE/CLIENTS/PROTOCOL/TROUBLESHOOTING/PLATFORM_MATRIX/CHANGELOG | 英文 README 只加了两行；没有完整英文长文 |
| DEC-022 | implemented | 本文件 | 无 |

状态口径：`implemented_verified` = 已通过本轮编译与自动化测试，但未做真实模型/实机验收；`implemented_pending_validation` = 代码已写但该子项仍缺自动化或人工证据；`partial` = 有明确缺口；`not_started` 本表没有。

---

## 2. 实际文件改动

接手前按 `git status --porcelain=v1 --untracked-files=all` 展开统计为 **103 个文件：46 个已跟踪修改 + 57 个未跟踪文件**；“74”是折叠目录的状态行数。本次新增一个纯观察辅助源码文件，最终按同一口径为 104 个文件。构建/测试/包与外部验收证据未混入待提交源码清单。

### 2.1 修改（已跟踪文件）

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/src/decision.ts` | **新增**：任务/作用域/DecisionEnvelope/Memory/Fault/DTO 契约与常量 |
| `packages/contracts/src/errors.ts` | 新增 21 个决策错误码（旧码语义不变） |
| `packages/contracts/src/tools.ts` | 新增 4 个工具定义；修正“28 个”过时注释；补充 patch/answer/resolution/note/evidenceIds |
| `packages/contracts/src/validate.ts` | 四工具业务校验（长度、ID、预算、成功条件、幂等字段） |
| `packages/contracts/src/protocol.ts` | `WorldIdentity`、`SnapshotCoverage`、Hello/Snapshot 可选字段、`transport: 'decision'` |
| `packages/contracts/src/snapshot.ts` | 透传并校验 `worldIdentity`、派生 `coverage` |
| `packages/contracts/src/index.ts` | 导出 decision 契约 |
| `packages/control-core/src/action-service.ts` | `ToolContext.transport` 增加 `'decision'`（无行为改动） |
| `apps/server/src/bridge.ts` | 组合根装配；三个 dispatch 入口改走 router；decision API 路由；takeover 先 fence；停机顺序；事件监听 |
| `apps/server/src/config.ts` | 保留前缀 `sab-internal-decision:` 拒绝外部签发/轮换 |
| `apps/server/src/paths.ts` | `decisionRoot/config/secrets/db`；私密目录创建 |
| `apps/server/src/redact.ts` | 新增 prompt/contextJson/apiKey 等敏感键 |
| `apps/server/package.json`、`apps/server/tsconfig.json`、`tests/package.json`、`tests/tsconfig.json`、`tsconfig.json` | workspace 声明与项目引用（**原文件缺逗号的语法错误已修**） |
| `mods/StardewAgentBridge/ModEntry.cs` | Hello 输出可选 `worldIdentity` |
| `mods/StardewAgentBridge/Observations.cs` | Snapshot 输出 `worldIdentity`、`observation.bounds`；修正 `truncated` 越界判断 |
| `tests/mod/ControlTests.csproj`、`Program.cs` | 纳入 `WorldIdentity.cs` 与纯函数测试 |
| `tests/src/contracts.test.ts`、`mcp-http.test.ts`、`web-mcp.test.ts` | 工具数 29→33、工具名校验允许下划线；其它工具数量断言改为 `TOOLS.length` |
| `scripts/verify-package.mjs` | 便携包工具数断言 29→33（脚本已改；`verify:package` 需先打包，本轮未运行） |
| `scripts/pack.ps1`、`scripts/linux/pack.mjs` | 文档白名单加入两份新文档 |
| `README.md`、`README.en.md`、`PLAN.md`、`CHANGELOG.md`、`RELEASE_CHECKLIST.md` | 工具面、数据目录、安全边界、旧模型约定与验收状态修订 |
| `docs/AGENT_GUIDE.md`、`CLIENTS.md`、`PROTOCOL.md`、`TROUBLESHOOTING.md`、`PLATFORM_MATRIX.md`、`DOCKER_INSTALL.md` | 派单流程、四工具、错误码、平台边界 |

### 2.2 新增

- `packages/decision-core/`（原 30 个源码文件，另补 `game-observation.ts` + package/tsconfig）
- `apps/server/src/decision-config.ts`、`decision-secrets.ts`、`decision-game-port.ts`、`decision-memory.ts`、`decision-api.ts`、`bridge-tool-router.ts`
- `apps/web/src/decision-api.ts`、`decision-panel.ts`
- `mods/StardewAgentBridge/WorldIdentity.cs`
- `tests/src/decision-fixtures.ts`、`decision-contracts.test.ts`、`decision-store.test.ts`、`decision-policy.test.ts`、`decision-provider.test.ts`、`decision-runner.test.ts`、`decision-memory.test.ts`、`decision-config.test.ts`、`decision-api.test.ts`、`decision-e2e.test.ts`
- `tests/mod/WorldIdentityTests.cs`、`tests/fixtures/decision/README.md`
- `docs/DECISION_EXECUTOR.md`、`docs/DECISION_EXECUTOR_ACCEPTANCE.md`、`docs/adr/DECISION_EXECUTOR.md`
- `docs/DECISION_EXECUTOR_DEVELOPMENT_HANDOVER_20261030.md`（与桌面副本一致）
- `DECISION_EXECUTOR_HANDOVER_REPORT.md`（本文件）

### 2.3 依赖与 lockfile

- `packages/decision-core` 新增依赖：`@sab/contracts`（workspace）、`ajv@8.20.0`（根依赖已有同版本）。
- `package-lock.json` 已用 `npm install --package-lock-only --ignore-scripts --offline` 补算：
  差异 14 行，仅新增 `@sab/decision-core` 的 workspace 链接、`apps/server` 依赖项与 `packages/decision-core` 条目。
  `npm ci --dry-run --ignore-scripts` 通过；未改动任何已发布依赖的版本或 integrity。

### 2.4 C#/TS 协议字段

| 字段 | 位置 | 兼容性 |
| --- | --- | --- |
| `hello.worldIdentity` | Mod → Bridge | 可选；旧 Bridge 忽略；新 Bridge 缺失按 null |
| `snapshot.worldIdentity` | Mod → Bridge | 同上 |
| `observation.bounds` | Mod → Bridge | 可选；缺失时 `coverage` 不写 |
| `observation.truncated` | Mod → Bridge | 语义修正为“半径越界”；**行为变化见 §9** |
| `transport: 'decision'` | 内部类型 | 只用于 Bridge 内部执行身份，不进入外部请求体 |

---

## 3. 四工具与调用示例

### 3.1 `stardew_context`

```json
{ "operation": "current", "profileId": "default" }
```

返回 `DecisionContextInfo`：世界身份、开关、停止锁、在线状态、60 秒 `contextToken`（离线为 null）、可用 provider/policy。不返回 baseUrl、密钥或 secretRef 可访问路径。

### 3.2 `stardew_task`

```json
{
  "operation": "submit",
  "requestId": "water-east-20261029-01",
  "contextToken": "<from stardew_context>",
  "title": "浇好农舍旁的指定作物",
  "goal": "给指定区域内已种植且需要浇水的作物浇水；体力低则停下汇报。",
  "providerId": "local-executor",
  "policyId": "farm-care",
  "scopeMode": "persistent",
  "constraints": { "locations": ["Farm"], "stopEnergyAtOrBelow": 20, "allowDayChange": false, "maxGoldSpend": 0 },
  "budget": { "maxModelCalls": 60, "maxWriteActions": 80, "maxActiveMs": 600000, "maxAccountedTokens": 120000 },
  "successCriteria": [{ "kind": "crop_tiles_watered", "location": "Farm", "tiles": [{ "x": 64, "y": 18 }] }]
}
```

其它 operation：`update`（patch 白名单）、`pause`、`resume`（新 token + expectedRevision）、`cancel`、`reply`（仅 waiting_main）、`resolve`（accept_completion/reviewed_pause/reject_completion）。

### 3.3 `stardew_task_status`

```json
{ "operation": "wait", "taskId": "ptask_...", "afterStateVersion": 12, "timeoutMs": 8000 }
```

`get` / `list`（cursor、limit 1–50、state）/ `wait`（≤15 秒，每客户端最多 2 个）。断开只结束等待。

### 3.4 `stardew_memory`

```json
{ "operation": "search", "query": "防风草", "limit": 12 }
{ "operation": "add", "kind": "strategy", "title": "东侧地块先补水", "content": "水壶空时先去池塘。", "sourceType": "main_model" }
```

`sourceType` 只接受 `main_model` / `user`；`preference` 只能由 Web 用户写；`archive` 不删除动作账本。

---

## 4. 已实现的 custom 策略保护

| guard | 行为 | 未实现时 |
| --- | --- | --- |
| `waterOnly` | 只允许 move/select/use；选择和实际手持都须确认是水壶；use 仅作用于当前观察的待浇作物（含原生 soil）或游戏确认可补水的地块 | 其它写工具一律拒绝 |
| `maxCountPerAction` | `count`/`quantity` 上限 | 无限制的工具默认不开放 |
| `allowedItemIds` | 根据实际背包槽位或显式 itemId 判断白名单；缺来源信息即拒绝 | 同上 |
| `maxGoldSpendPerAction` | `price`/`maxPrice`/`gold` 上限 | 同上 |

未知 guard 字段（正则/脚本/SQL/表达式）在 `normalizeConfig` 阶段**拒绝保存**；运行期再次拒绝。
购买、出售、吃、制造、放置、钓鱼、战斗等工具在 D1 默认不在任何内置政策的 `allowedTools` 中。

---

## 5. 关键代码路径

### 5.1 取消 / F9 / 接管

1. `TaskService.pause/cancel` → `runner.pause/cancel` → `AbortController.abort()`；
2. `bridge.haltDecisionTasks(reason, latch)`：置停止锁 + `runner.invalidateAll` + 把运行中任务落为 `paused`/`needs_review`；
3. `POST /api/v1/control/takeover`：**先** `haltDecisionTasks`，再 `control.takeover`（Mod 离线也已停模型）；
4. F9：Mod 提升 epoch → ControlManager 关闭会话（`mod_control_changed`）→ 事件监听置停止锁；
5. runner 每个 `await` 后 `assertFence`；迟到回答在解析前就被丢弃。

### 5.2 未知回执 / 库写失败

- `dispatchWrite` 返回 `effectKnown:false` → `markActionState('unknown')` → 任务 `needs_review`，保留 actionId；
- `dispatch_prepared` 后崩溃：重启恢复 → `needs_review`，不补派发；
- 动作成功但任务状态写入失败：`finally` 捕获并记日志，不重放；原收据留在 ActionLedger。

### 5.3 世界/日期变化与重启

- 每轮比较 `worldIdentity`/实例/代次；不一致 → `TASK_SCOPE_CHANGED`；
- 日期变化 → 停止待复核（D1 不跨日）；
- 启动 `recoverOnStartup()`：`queued/running/pausing → needs_review`，活动 run → aborted，清空槽位；不自动续跑。

### 5.4 停机

`stopping → 发布事件 → runner.invalidateAll → 有界等待 1.5s → 持久化状态 → 解除订阅 → control.stop → MCP/Mod 关闭 → ledger.close → decisionStore.close`。
（不会先关账本再让 Runner 写结果。）

---

## 6. 测试源码与第 26 节对应

| 测试文件 | 覆盖 ID（主要） |
| --- | --- |
| `decision-contracts.test.ts` | DXC-05/06、DXP-08、DXV-12（解析边界）、DXP-11（同日证据） |
| `decision-store.test.ts` | DXC-02/03、DXS-01/05、单槽与 CAS |
| `decision-policy.test.ts` | DXP-01/02/04/05、工具交集与预算口径 |
| `decision-provider.test.ts` | DXV-01～09（除 DNS/代理）、DXV-11（摘要脱敏） |
| `decision-runner.test.ts` | DXR-01/02/03/08/09/12、DXP-08、控制占用不抢、实例变化不派发、取消后 0 写入 |
| `decision-memory.test.ts` | DXS-09/10/11、来源伪造、修订 CAS |
| `decision-config.test.ts` | DEC-005：默认关闭、CAS 合并、custom 政策准入、凭据只写、端点校验 |
| `decision-api.test.ts` | DEC-016：默认关闭、配置 CAS、Bearer 不能管理配置、旧 Mod 身份降级、任务工具路由 |
| `decision-e2e.test.ts` | DXR-01/DXC-01（HTTP 工具面）：真实 Bridge + Mock Mod + 假模型跑通“派单→规划→选壶→浇水→机器验证完成”，并断言任务工具不进入 Mod 请求 |
| `tests/mod/WorldIdentityTests.cs` | DXS-06（Int64 保真、规范字符串） |

完整用例状态以 `docs/DECISION_EXECUTOR_ACCEPTANCE.md` 为准。原协作者已补原生 soil/补水/动态引用、撤销真实注册凭据、槽位白名单、政策交集、只读结果上下文、控制申请期间取消、旧证据失效、已知 usage 和慢 keep-alive 响应等回归；DXW 已补部分真实浏览器检查。矩阵的 `not_run` / `partial_pass` 项仍需要继续验证，DXG 和 DXE 全部未执行。

---

## 7. 本轮实际执行与仍未执行的命令

### 7.1 已执行（2026-11-01，Windows；原交付 Node v22.22.2，独立复验 Node v22.23.1）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（全部 TS 项目引用 + Web `--noEmit`） |
| `npm run build` | 通过（含 Web 打包） |
| `npm test` | 原交付 282 用例（277 通过 / 5 跳过）；补缺陷回归后 297 用例（292 通过 / 0 失败 / 5 平台专用跳过），见 §12 的最终日志 |
| `npm run test:mod` | 通过（189 checks，含 `WorldIdentityTests`）；最终复跑日期 2026-11-01 |
| `SAB_HOME=<临时目录> node apps/server/dist/cli.js doctor` | 通过；显示“AI 任务助手：未配置（默认关闭）”，且未创建 `decision/` |
| `npm install --package-lock-only --ignore-scripts --offline` | 通过；lockfile 仅新增 `@sab/decision-core` 链接与工作区条目 |
| `npm ci --dry-run --ignore-scripts` | 通过 |
| 隔离源树 `npm ci` | 真实安装通过，36 packages；不是 dry-run，不复用原 node_modules |
| `dotnet build ... -c Release -p:GamePath=<本机游戏目录> --no-restore` | 真实游戏 DLL 编译通过，0 警告 / 0 错误；未安装 Mod、未运行游戏 |
| `npm run test:installer` | 17 checks 通过，仅临时 fake-game fixtures |
| Windows pack（隔离源树，复用已编译 Mod） | 完整包 53 文件；脚本内 `verify-package.mjs` 已通过仓库外启动、HTTP/stdio 33 工具、校验和和禁止文件检查 |
| `docker:bundle` | bundle 生成与内置文件/入口验证通过；不代表镜像构建或容器游戏验收 |
| 真实浏览器 + Mock/Fake | 完成部分 DXW 项，包括 390 CSS px、首次模型保存、探针、任务暂停/接管/取消、标题 XSS 与完成证据 |

编译期共修正 58 个类型错误（预算形状、`Clock.nowMs`、`writeCommands`、错误码收窄、Web 面板收窄等），
测试期修正 9 个行为/断言问题（卡点计数、配置 revision、首帧世界代次、政策工具交集、Windows 工具解析）。

### 7.2 仍未执行

```text
Linux 原生构建/测试/打包与游戏验收
docker:build / docker:inspect / 容器运行与游戏验收
任何真实模型 HTTP 请求、任何真实游戏操作
尚未覆盖的浏览器密钥持久化、多标签页和同源重启/SSE 故障验收
git add/commit/push；创建发行版
```

也没有：修改本机现用 Mod、DSH 配置或玩家存档；运行全仓库格式化。

**本报告声明代码、Mock/Fake、部分真实浏览器和 Windows 便携包验证结果；不声明真实模型可用、实机验收通过或已发布。**

---

## 8. 最可能需要验收者修正的点

1. **lockfile**：独立源树实际 `npm ci` 已通过。该源树由基线 Git archive 叠加当前全部源码改动构成，不是未经修改的 HEAD，也没有复用原 node_modules。
2. **TypeScript**：全部项目引用、Web 类型检查与构建已经通过；仍以最终执行日志为证据，不再保留“未编译”的旧表述。
3. **C#**：`WorldIdentity` 纯函数 189 checks 与使用本机真实游戏 DLL 的 Mod 编译均已通过；是否能在实际游戏中正确上报仍需实机验收。
4. **Mod 行为变化**：`observation.truncated` 原实现把“内缩窗口”误标为截断。已改为真正的越界判断；这会改变现有快照的 `truncated` 值与完成判定，需要在真实游戏中复核（否则所有浇水任务都会 `unverifiable`）。
5. **SSE 缺口**：已经有 bootId 与重连全量刷新，不采用逐 seq 比对。页面重载后状态恢复已查；同源 Bridge 重启和断流故障场景仍未完整验收。
6. **`crop_tiles_watered` 的证据粒度**：tile key 由归一化快照的作物实体推导；如果 Mod 因 `radius` 未覆盖目标地块，会得到 `unverifiable` 而不是假成功。默认 `radius=6` 可能不足以覆盖大片农田，需要实测调整。
7. **doctor 的 decision 段**：只读打开任务库并读 meta；若库损坏会显示提示。请确认在真实数据根上 doctor 不创建 `decision/`（现有实现只读不建）。
8. **Docker**：decision 子目录随数据卷持久化已由 `paths.ts` 保证；`verify-package` 已加入 `decision/`、`secrets.json` 禁止项，但未在真实镜像上运行。
9. **Web 配置表单**只编辑单个 provider；`customPolicies`、`clientLimits` 仍只能手写配置文件（保存时会保留未提交字段）。profiles 与 sharing 已在面板中可编辑。

### 8.2 编译/测试期发现并修复的问题

以下问题是本轮实际运行类型检查与测试后才暴露的，均已修复并有断言保护：

- **出站地址策略三个绕过（安全）**：6to4 取错组（把 2002 前缀当 IPv4 首字节，`2002:7f00:1::` 被判为公网）；
  `::A.B.C.D` 兼容写法未按内嵌 IPv4 处理；ULA `fc00::/7`/`fec0::/10` 在未开启私网时落到“公网放行”。
  修复后 `isAddressAllowed` 对环回、私网、CGNAT、链路本地、元数据、IPv4-mapped/compatible、6to4、Teredo、ULA 均有断言。
- **卡点检测永不触发**：`StallDetector` 的“进展窗口”计算使计数恒被压回 2；改为任何进展清零、连续 3 次同指纹即停。
- **配置 revision 死循环**：手写配置无 `configRevision` 时 GET 返回 1、PUT 用 1 却被判 0 冲突；加载时把已存在文件视为 revision 1。
- **首帧前无法派单**：`worldGeneration` 只来自快照跟踪，Hello 已带该值却未使用；改为先取 Hello。
- **暂停竞态**：无活动 run 时 `pausing` 永不落地；`start()` 也可能把刚暂停的任务改回 queued。两处均已收紧。
- **恢复绕过授权**：resume/reply 未重新校验 policy/provider 是否仍对该客户端开放；已补。
- **审核枚举**：未知 `resolution` 会被 else 当成 `reject_completion`；已先校验枚举，并禁止把已完成任务退回 paused。
- **证据降级**：人工接受完成会把 `verified_observation` 降为 `main_reviewed`；已保留更强证据级别。
- **Web 派单校验缺口**：预算字段未校验（非法值被静默忽略）；已按四个维度逐项拒绝非法/未知字段。
- **起步必然失败（严重）**：`PAUSE_NOT_CONFIRMED` 检查放在取得控制之前，读到的是 `running` 旧状态；
  真实游戏几乎必然拒绝启动。改为 acquire 之后有界等待 3 秒确认 paused（端到端用例复现并验证）。
- **模拟 Mod 增强**：新增两格作物、喷壶与浇水状态，使完成判定有真实可观察变化；分步 acquire 会进入 paused。
- **Web 无法管理他人任务**：面板能列出所有任务，但 pause/cancel/update 受“只能操作自己的任务”限制；
  现在 `Principal.admin` 仅由本地 Web 会话置位，并保留 `web` 标识禁止签发给 Bearer。

### 8.1 编写期自查发现并已修复的问题（已由编译与测试确认）

以下问题先由静态阅读发现，随后由 `tsc -b`、`npm test` 与 `test:mod` 验证修复有效：

- `DecisionStore` 构造函数在 `migrate()` 前 `writable=false`，`requireDb()` 会直接抛错，导致任何新库都不可用 → 改为连接建立后先置 `writable=true`，失败时再置回 false。
- `POST /api/v1/decision/config` 以默认值为底归一化，会清空未提交的 `clientLimits/profiles/sharing/memory` → 改为以当前配置为底覆盖入参，并让面板不再提交空的 `clientLimits`。
- 全新安装、未配置 provider 时点“停用”会因空 baseUrl 校验失败 → 面板对“无 provider + 停用”提交最小配置。
- 上下文没有下发本轮 `observationId`，模型无法合法回填，导致所有决策都会被拒 → `context-builder` 的 `state.observationId` 已补。
- runner 把超时映射成 `PROVIDER_UNSUPPORTED` 且不重试 → 增加 `timedOut` 标记，按传输重试预算重试后报 `PROVIDER_TIMEOUT`。
- 每次模型调用在 `AbortController` 上遗留监听器 → 改为组合信号并在 `finally` 移除。
- `http-client` 的 `cleanup` 在 `finishError` 之后才定义，signal 已 abort 时会踩 TDZ → 提前定义并在早退路径清理定时器。
- custom 政策只检查 guard 字段名、不检查“工具是否真有保护” → 新增表驱动准入：buy/interact/menu/wait/存档/截图等直接拒绝，use 必须 waterOnly，吃/放/造/装/出货必须 itemId+数量上限。
- 每客户端只限制了 provider，没有限制 policy → `AuthzPort` 新增 `isPolicyAllowed`，submit/update 都校验。
- 任务视图读 `tasks.plan` 冗余字段，而 runner 只写 `task_steps`，导致面板永远显示“无短计划” → `toView` 改为以步骤表为准。
- 暂停时若 runner 尚未启动，任务会永远停在 `pausing` → 无活动 run 时直接落 `paused`。
- 决策包解析用 `}{` 子串快速拒绝，会误杀字符串内容里的同样字符 → 删除该预处理，只依赖平衡扫描。
- 跨日/世界变化被映射成 `waiting_main` → 改为 `needs_review`（与交接书 §09.1 一致）。
- 面板每 5 秒重填表单、重置手选任务 → 只在首次加载填表，并用 `selectedTaskId` 保持选择。
- 面板缺少存档分组、共享只读与完成候选复核 → 已补齐 profiles 新建/切换、sharing 开关、accept/reject resolve。

---

## 9. 与交接书的偏差（有意为之）

| 偏差 | 原因 |
| --- | --- |
| `TaskService` 直接调用 `DecisionStore`，未再拆 `TaskQueryService` 的存储层 | 避免两套事务边界；查询只读同一 store |
| `contextToken` 消费后保留到过期（标记 boundTaskId） | 便于审计“绑定到哪个任务”，不保存明文 |
| `DecisionConfigStore.save` 以当前配置为底合并入参 | 防止 Web 只提交部分字段时把 `clientLimits`/`profiles` 重置 |
| `runner` 在 `finally` 里统一落状态 | 保证取消/暂停/失败只有一条写路径；TaskService 的终态优先 |
| 不把整任务完成推导为每个自然语言步骤 verified_done | 已移除这种推导；单步 `doneWhen` 是解释文本，不能当判定式 |
| 计划步骤没有 `verified_done` 的独立条件 | D1 没有 per-step 机器条件；避免伪造步骤级证据 |
| Web 表单只支持单 provider | D1 的现实用法；多 provider 可手写配置 |
| `apps/web` 新增 2 个文件而非 3 个（无 `decision-memory.ts`） | 记忆列表已在面板内实现，拆文件没有收益 |
| 新增 `@sab/decision-core` 依赖 `ajv` | DecisionEnvelope 本地严格校验需要；根依赖已有同版本 |
| 面板展示目标条件核对数，计划步骤单独显示未核验 | 解决“任务已完成但 0/1 步”的矛盾；不捏造地块级进度，不用整体成功伪造每步证据 |

---

## 10. 一致性自查

- [x] 四个工具同时出现在 `TOOLS` registry，MCP/stdio/Web `/api/v1/tool` 都经同一 `BridgeToolRouter`。
- [x] 任务工具不会被转发给 Mod：router 在进入 `ActionService` 之前分流。
- [x] 旧 29 个工具定义与行为未改（仅 `ToolContext.transport` 类型扩展）。
- [x] 所有游戏写动作仍由 `ActionService` 记录唯一意图；decision-core 不含任何 Mod 请求代码。
- [x] 默认关闭：`enabled=false` 时不调用 provider、不读取密钥内容、不创建任务记录；空任务库仍会在 Bridge 启动时创建（便于原地启用）。Web 打开不调用模型。
- [x] 密钥不回显：API 只返回 `configured`/`hasSecret`/`secretRef`（逻辑名）；日志与问题包新增脱敏键。
- [x] README 工具数 33、`verify-package` 断言 33、测试用 `TOOLS.length`，三处一致。
- [x] 文档如实区分“已通过自动化测试”与“未做真实模型/实机验收”，没有宣称已发布可用。
- [x] `package-lock.json` 已补入新工作区；`npm ci --dry-run` 通过。
- [x] `verify-package` 已禁止 `decision/`、`secrets.json` 进入发布包（脚本已改；需打包后运行）。
- [x] SSE 用 bootId + 重连全量刷新替代逐 seq 比对（规范允许的替代方案）。

---

## 11. 建议的下一步（验收者）

1. 补并发双客户端、真实 F9/断线、任务库写失败注入等仍为 `not_run` 的完整场景。
2. 补浏览器密钥持久化、多标签页与同源重启/SSE 故障；已测项目见 §12，不能把部分覆盖标成全部通过。
3. 单独完成 Linux 与容器镜像/运行验证；Docker bundle 不是镜像或游戏验收。
4. 用明确的单人测试存档、已配置模型与预算完成 DXG；随后再决定提交和发布版本。

---

## 12. 原协作者独立复核（2026-11-01）

### 12.1 基线与保存

- 核对主仓库仍为 `04a939cce6af1ed98b15634d4e223d2e8745ab1c`，所有开发改动尚未 commit/push。
- 接手的 103 个实际改动文件先逐一备份和 SHA-256 留档，再做修复；没有覆盖其他协作者的工作。
- 证据目录在仓库外：`F:\星露谷\work\decision-audit-20261101`。`incoming-source/`、`incoming-manifest.json` 和 `incoming-tracked.patch` 保存接手状态。
- 新建的源码只有 `packages/decision-core/src/game-observation.ts`；其余修复在已有变更文件内。运行数据、依赖缓存和分发验收产物均未加入 Git 改动清单。

### 12.2 独立复核发现并修复

| 问题 | 修复与验证 |
| --- | --- |
| 原生 Mod 用 `kind=soil` 表示种植地块，Runner 只认 `crop`；Mock 恰好写成 crop 掩盖问题 | 统一识别原生 crop/cropState；Mock 改为原生形状，实际 Bridge 闭环验证 |
| waterOnly 未检查实际手持工具，且拒绝合法补水源 | 每次 use 确认所选槽位是水壶；仅放行当前待浇作物或原生 refillable 地块；空水壶补水后两格浇水有独立端到端回归 |
| 模型等待后仍使用旧工具、背包和引用 | 写前重新观察；状态变化则重新决策；只对可证明相同的静态目标重绑定动态 ref |
| custom 物品白名单仅看 itemId 参数，而实际吃/放/出货按 slot 操作 | 从真实背包槽位查 itemId；缺来源即拒绝。配方/箱内来源证据不完整的 craft/container 不再允许配置开启 |
| 政策地点无交集变成空数组后反而表示无限制，移除 guard 也可放宽旧任务 | 交集无地点时拒绝；地点、waterOnly、物品/数量/金额保护只取更严值 |
| 运行中只查配置授权，撤销 AuthStore 中的客户端仍可继续 | 每轮及模型返回/派发前核对真实注册、provider 和 policy；真实 Bridge + 假模型回归确认撤销后 0 游戏写入 |
| 旧凭据文件可能保留 web 或内部执行身份的 Bearer | 登录校验也拒绝保留身份，既有普通客户端仍可登录 |
| 取消发生在 acquire 等待期间时，迟到取得的会话无法释放 | 先保存己方会话 ID，再检查取消 fence；回归确认会话释放且模型/写动作均为 0 |
| 持久化停止锁失败可跳过 invalidateAll | 先使循环失效，再尝试落盘；完整存储故障注入场景仍列待验 |
| 后续观察已无作物，旧浇水证据仍可能拼出完成 | 已观察空/变化地块清除旧证据；回归禁止虚假 verified completion |
| inspect 等只读结果被丢弃，下一轮模型看不到查询结果 | 把有界结果及来源写入事件并送入下一轮上下文；以工具真实返回值断言 |
| 已知 usage 因预算预留更大被错误标 unknown，错误处理还可能二次结算 | 已知/未知分开；每次请求只结算一次；恢复或错误不清零累计 |
| 网页默认关闭时，首次保存模型提示成功但实际丢弃填写值 | 只有表单也为空时才保存最小停用配置；真实浏览器完成首次配置流程 |
| keep-alive 复用连接仍等待 connect 事件，并继承短空闲超时 | 已连接 socket 清除连接定时器，显式使用模型请求 timeout；同一 TCP 连接超过 10 秒的慢响应回归通过 |
| 完成界面显示 0/1 步，整任务完成还可能伪造逐步 verified 或返回剩余计划 | UI 改为目标条件核对数；不把整体完成推导为各自然语言步骤已核验；已完成任务剩余工作为空 |

慢响应回归先真实失败，日志保存在 `test-before-keepalive-fix.log`；修复后专项及最终全量均通过。不能把发现前已有的通过结果当成这些修复的证据。

### 12.3 最终执行证据

| 验证 | 最终结果 / 证据 |
| --- | --- |
| Typecheck / build | exit 0；`typecheck.log`、`build.log` |
| Node 全量 | **297 总计 / 292 通过 / 0 失败 / 5 平台专用跳过**；`test.log` |
| Mod 孤立测试 | **189 checks**；`mod.log` |
| 真实游戏 DLL 编译 | **0 警告 / 0 错误**；`modBuild.log` |
| Windows 安装/回退 fixture | **17 checks**；`installer.log` |
| doctor 关闭/启用配置 | 两次 exit 0，前后文件清单不变，无任务库/凭据创建；`doctor-verification.json` |
| 独立源树安装 | `npm ci` 实际安装 36 packages；`clean-npm-ci.log`；不是 dry-run |
| Windows 分发 | 53 文件，15 portable checks，HTTP/stdio 均 33 工具，校验和与禁止文件检查通过；本机审计包，不是新发行版 |
| 包含私密文件的负例 | 向审计包副本注入合成 `decision/secrets.json`，重算全部有效校验和后仍被明确拒绝（exit 1）；`forbidden-package-verification.json`；此补充检查使用 Node v24.22.1 |
| Docker bundle | esbuild 入口及资源检查 exit 0；`dockerBundle.log`；没有构建/运行镜像 |
| 浏览器 | `browser-verification.json`、`browser-layout.json`、`browser-completion.png`；390 CSS px，scrollWidth=390，标题未生成 img 节点，Tab 可导航 |

浏览器使用随机端口的隔离 Bridge、Mock Mod 和本地假模型，没有使用真实模型 Key、真人存档或现用 DSH 配置。临时浏览器标签页/视口与服务已清理。`browser_mock_pass` 仅表示相应 Mock 场景通过。

### 12.4 仍未证明的事项

真实模型兼容、真实游戏动作、真实 F9/双客户端联机、Linux 原生/容器运行、全部 DXW/DXG/DXE 与自动化缺口仍按矩阵保留。未安装本轮 Mod 到游戏目录，未自动提交或发布；原有已发布 tag/资产没有覆盖。
