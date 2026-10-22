# 接口协议与状态机（实现版 0.1.0）

本文描述**已经实现**的协议，不是目标草案。2026-10-22 修订：原 1.1 草案由本文替换，草案与实现的差异集中列在 §9。

- Bridge 版本：`0.1.0`；契约 schema：`1`（`/health` 与 `doctor` 都会打印）。
- 游戏内部协议标识：`stardew-agent-bridge/1`（与旧 Mod 的数字版本 1 **不兼容**，握手必须核对协议名）。
- MCP 协议本身由官方 SDK（`@modelcontextprotocol/server` 2.3.1）负责，本文不重复。

## 1. 四条接口边界

| 接口 | 用途 | 唯一业务入口 |
| --- | --- | --- |
| `POST /mcp` | MCP Streamable HTTP | `control-core` 的 `executeTool` |
| stdio 适配器 | 由 Agent 宿主作为子进程启动 | 转成 HTTP 调用同一个 Bridge（不复制业务逻辑） |
| `GET/POST /api/v1/*` | Web 控制台的读取与人工操作 | 同一个 `control-core` |
| Mod WebSocket | Bridge ↔ 游戏内执行器 | 游戏主线程校验后执行 |

任何一条边界的写操作最终都进入同一个 `ActionService.executeTool`：控制权检查、账本去重、Mod 调用、终态记录只有一份实现。

## 2. Mod 协议（Bridge ↔ 游戏）

传输：WebSocket，`ws://127.0.0.1:17654/`（Mod 侧仅监听回环）。

握手与鉴权：

- 连接必须带 `Authorization: Bearer <modToken>`，令牌来自数据目录的 `credentials.json`（Mod 每次连接重新读取，支持轮换而不重启游戏）。
- 带 `Origin` 头的连接一律 `403`（浏览器不能借本机端口操作游戏）。
- 连接建立后第一帧必须是 `hello`，否则其它命令返回 `PROTOCOL_MISMATCH`。

### 2.1 帧格式

请求：

```json
{
  "op": "request",
  "protocol": "stardew-agent-bridge/1",
  "requestId": "1f0c…",
  "command": "move",
  "args": { "near": "@s7:e12" },
  "timeoutMs": 15000,
  "actionId": "act-20261022-0007",
  "epoch": 4
}
```

响应：

```json
{
  "op": "response",
  "requestId": "1f0c…",
  "status": "succeeded",
  "result": {
    "kind": "action",
    "summary": "已到达目标附近。",
    "effects": { "position": { "x": 12, "y": 9 } },
    "pause": { "state": "paused", "menuType": "GameMenu", "selfOpened": true }
  },
  "error": null,
  "actionId": "act-20261022-0007",
  "epoch": 4,
  "elapsedMs": 812
}
```

`status` 取值：`succeeded` | `partial` | `failed` | `cancelled` | `unknown`。`error` 仅失败时非空：

```json
{ "code": "OUT_OF_REACH", "message": "目标不在可交互范围内。", "effectKnown": true, "nextAction": "observe" }
```

`result.pause` 由 Mod 统一附加：按 `Game1.shouldTimePass()` 判断 `running` / `paused`，无菜单且剧情或过渡中可标 `blocked`。`selfOpened` 只对 Mod 自己创建且仍是当前对象的正常暂停菜单为真；有菜单不一定时间停止。

### 2.2 命令表

| 命令 | 类型 | 参数 | 说明 |
| --- | --- | --- | --- |
| `hello` | 读 | — | 版本、能力、实例 ID、控制权、存档状态、watchdog 状态 |
| `status` | 读 | — | 在途动作、已记录 actionId 数、控制权代次 |
| `snapshot` | 读 | `radius` 1–16 | 结构化世界快照 |
| `inspect` | 读 | `target` | 单个目标详情 |
| `shop` | 读 | — | 已打开商店的货架、价格、库存、`itemId` |
| `recipes` | 读 | — | 已知配方与当前可制作数量 |
| `saves` | 读 | — | 本机可加载存档 |
| `screenshot` | 读 | — | PNG（在渲染事件中抓取，含 UI 合成） |
| `move` | 写 | `near` \| `tile{x,y}` | 正常寻路；`-1` 只允许真实地图出口 |
| `select` | 写 | `slot` 0–35 | 选择背包槽位 |
| `use` | 写 | `target` | 对相邻目标使用当前工具/种子 |
| `interact` | 写 | `target` | 正常交互（门、NPC、信箱…） |
| `menu` | 写 | `target` | 选择对话/邮件/结算菜单项 |
| `closemenu` | 写 | — | 只从正常入口关闭可关闭菜单 |
| `pause` | 写 | — | 打开正常暂停菜单（不替代 `closemenu`） |
| `wait` | 写 | `milliseconds` 100–10000 | 有界等待，不跳剧情 |
| `buy` | 写 | `itemId`、`count` 1–999 | 正常购买 |
| `ship` | 写 | `target`、`slot`、`count` | 投放出货箱 |
| `container` | 读/写 | `target`、`operation`、`slot`、`count` | `list` 只读且不需 actionId；`deposit`/`withdraw` 为写 |
| `craft` | 写 | `recipe`、`count` | 正常制作 |
| `place` | 写 | `target`、`slot` | 放置物品 |
| `eat` | 写 | `slot` | 食用 |
| `equip` | 写 | `slot`、`kind`、`operation` | 穿脱装备 |
| `fish` | 写 | `target?`、`milliseconds` ≤55000 | 有界钓鱼（逐帧输入由 Mod 控制） |
| `combat` | 写 | `target`、`milliseconds` ≤10000、`minHealth` | 有界战斗，达到生命阈值即停 |
| `load` | 写 | `saveId` | 仅在标题加载来自 `saves` 的存档；Bridge 回执 accepted 后另查就绪 |
| `stop` | 控制 | `actionId?` | **只**停止该 actionId（缺省=当前在途动作） |
| `control` | 控制 | `operation`、`holder?`、`leaseExpiresAt?`、`epoch?`、`pause?`、`mode?` | 控制权；mode 为 step/realtime |

**不存在的命令**（代码中没有，不是禁用）：`warp`（传送）、`resource`/`give`（改资源）、`skipevent`（跳剧情）、`diag`。

### 2.3 控制权（epoch）

`control` 的四个操作：

| 操作 | 语义 | 结果 |
| --- | --- | --- |
| `acquire {holder, leaseExpiresAt, mode?}` | 有有效租约则拒绝；空闲时建立持有者 | `epoch + 1` |
| `renew {epoch, leaseExpiresAt}` | 仅对有效持有者和有效租约续租；不能复活过期/释放控制权 | epoch 不变 |
| `release {epoch, pause}` | 撤销持有者；可选尝试正常暂停 | `epoch + 1`，持有者清空 |
| `takeover` | 人工接管：停动作、撤销持有者、尝试暂停 | `epoch + 1` |

写请求必须携带当前 `epoch`，否则：

- 缺省 `0` → `CONTROL_REQUIRED`
- 与当前不一致 → `CONTROL_EXPIRED`（`effectKnown=true`，`nextAction=restart_control`）

因此**断线、接管、换存档之后，任何旧请求都不能重新取得控制**。

### 2.4 失联自保（游戏侧）

Mod 每帧检查最近一次收到合法帧的时间：

- 超过 `LinkTimeoutSeconds`（默认 5 秒）且当前有在途动作或持有控制权 → 停止动作、`player.Halt()`、撤销控制权（`epoch + 1`）、**尝试**打开正常暂停菜单。同一秒内最多触发一次。
- 动作在途时若发起连接断开 → 停止并释放输入（含合成的鼠标左键）。因效果可能已发生，回执保留 `unknown` / `effectKnown=false`，不假设未执行。
- `F9`（可配置）紧急停止：停动作、释放输入、撤销控制权、尝试暂停，不依赖 Bridge 是否活着。

### 2.5 Mod 侧幂等

Mod 在自己的内存里记录已见 `actionId` 与参数指纹：

- 相同 ID + 相同参数 + 已有终态 → 直接回放终态（不重新执行）。
- 相同 ID + 不同参数 → `IDEMPOTENCY_CONFLICT`。
- 相同 ID 但还没有终态 → 回放 `unknown`（`RESULT_UNKNOWN`），**不重放**。
- 记录上限 65536 条，达上限后拒绝新的写动作（`OUTPUT_LIMIT`），提示正常保存并重载。

## 3. MCP 工具面

- 传输：`POST /mcp`（Streamable HTTP）。工具用 JSON Schema 注册（`fromJsonSchema`）。
- Bearer 身份绑定调用与会话。旧 `2025-11-25` 协议使用有状态 HTTP 传输，现代 `2026-07-28` 使用 SDK 新传输；取消信号沿 MCP → control-core 定向停止该调用已经派发的动作。HTTP 请求断开和 stdio 取消也转发停止；不能保证宿主断开前未发生消费。
- 返回：文本摘要（给人/无视觉能力模型读）+ `structuredContent`（机器读）+ 截图工具额外返回 `image`。失败时 `isError=true`，文本首行固定为 `错误 <CODE>: <message>（effectKnown=… 下一步=…）`，并同时给出 `structuredContent.error`。
- 28 个工具与分类见 [README](../README.md) §3。

写工具的公共参数：

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `actionId` | 否 | 幂等键；缺省由 Bridge 生成。重试**必须复用**同一 ID |
| `controlSessionId` | 否 | 使用该 clientId 唯一活动会话，零个/多个时 `CONTROL_REQUIRED`；同 clientId 多聊天可能共享会话 |

`stardew_session` 的参数：`{operation: 'start'|'status'|'checkpoint'|'end', mode?: 'step'|'realtime', controlSessionId?, goal?, progress?, next?, constraints?}`。checkpoint 保存续接摘要，end 释放并尝试暂停；写入自动续租，只读不续租。宿主级 renew/release 不是该工具的 operation。
`stardew_stop` 只停止调用方自己的动作；人工急停只能通过网页或 `F9`（避免 Agent 停别人的动作）。

`stardew_status {actionId?}` 返回原动作回执、最近动作与未决项；只有意图、没有终态的崩溃窗口返回 unknown。succeeded 与 verified 分开：只有 verified=true 才称核验通过。load 的 accepted/verified=false 保持原记录，实际就绪另查 doctor/snapshot，目前不会自动改写为完成。

## 4. HTTP API

鉴权：`Authorization: Bearer <clientToken>`，或网页会话 Cookie `sab_session` + 非 GET 请求的 `x-sab-csrf`（值由 `GET /api/v1/session` 返回）。所有响应为 JSON；错误体为 `{ "code": "...", "message": "...", "effectKnown": bool, "nextAction": "..." }`。

| 方法与路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /health` | 无 | `{ok, bridgeVersion, contractsSchemaVersion, modConnected, uptimeMs}` |
| `POST /mcp`（及 `GET`/`DELETE` 会话） | Bearer 或网页会话 | MCP 通道；校验 `Origin`、`Host` |
| `GET /api/v1/session` | 无（只写 Cookie） | 下发网页会话与 `csrfToken` |
| `GET /api/v1/status` | Bearer 或网页会话 | 控制权、在途动作、未决动作、账本可写性 |
| `GET /api/v1/events?since=<seq>` | 网页会话 | SSE：动作、控制权、连接事件 |
| `GET /api/v1/receipts` / `GET /api/v1/receipt?id=` | 网页会话 | 动作回执列表 / 单条 |
| `GET /api/v1/sessions` | 网页会话 | 控制会话列表 |
| `GET /api/v1/screenshot` | 网页会话 | 最近一次截图（PNG） |
| `GET /api/v1/hosts?host=<dsh\|codex\|claude-code>&transport=<http\|stdio>` | 网页会话 | 生成宿主配置片段（会签发/复用客户端令牌） |
| `GET /api/v1/diagnostics` | 网页会话 | 脱敏诊断（版本、端口、Mod 状态、账本统计） |
| `POST /api/v1/diagnostics/export` | 网页会话 | 导出脱敏 JSON 问题包到 `exports/` |
| `POST /api/v1/control/{start\|takeover\|end}` | 网页会话 | 人工获取/接管/释放控制权 |
| `POST /api/v1/stop` | 网页会话 | 人工停止（可带 `actionId`） |
| `POST /api/v1/tool/<name>` | Bearer 或网页会话 | 工具调用（stdio 适配器走这里） |
| `POST /api/v1/clients` | 网页会话 | 签发/轮换客户端令牌 |

防护：只绑定 `127.0.0.1`；`Origin` 必须缺省或为 `http://127.0.0.1:<port>`/`http://localhost:<port>`；`Host` 必须为回环主机名（DNS rebinding 防护）。

## 5. 控制权状态机（Bridge 侧）

```
            start/接管成功
  idle ───────────────────────► active ──renew──► active（延长租约）
   ▲                              │
   │                              ├─ 租约到期 / 连接断开 / 明确 end ─► released
   └──────── released ◄───────────┘
                                  └─ 人工 takeover / 换存档 / Mod 失联 ─► idle（epoch+1）
```

| 事件 | Bridge 动作 | Mod 动作 |
| --- | --- | --- |
| `stardew_session start` | 建控制会话，取本地租约，向 Mod `control acquire` | 签发新 epoch |
| 写工具调用 | 校验写者与租约；未绑定 epoch 则先 acquire | 校验 epoch |
| 心跳超时 / 断线 | 结束会话、标记在途动作为 `unknown` | 自行停动作、撤销控制权、尝试暂停 |
| 网页「接管」 | 撤销所有会话 | `control takeover`（epoch+1） |
| 换存档 / 返回标题 | 失效所有会话与未决动作 | `Reset`：清空动作、`epoch+1` |

## 6. 去重与终态

- 参数指纹：`canonicalJson`（键排序）后取 `SHA-256(actionSignature({clientId, controlSessionId, command, args}))`。
- 去重键：`SHA-256(gameInstanceId + ':' + actionId)`（**不含 worldGeneration**：首次写入时世界代次可能还是 0，含进去会导致重放绕过去重）。
- 账本状态：`none`（首次）→ 执行；`same`（同参数、有终态）→ 回放终态；`same` 但无终态 → `RESULT_UNKNOWN`；`conflict`（同 ID 不同参数，或世界代次已变）→ `IDEMPOTENCY_CONFLICT`。
- 未决动作（进程崩溃遗留的 `started` 记录）在启动时与每次状态查询时暴露给 `stardew_status`，需要人/Agent 主动查询并观察，**不会自动重放**。

## 7. 错误码

| 分组 | 代码 | `effectKnown` | `nextAction` |
| --- | --- | --- | --- |
| 环境 | `GAME_UNAVAILABLE`、`NO_SAVE_LOADED`、`BRIDGE_NOT_RUNNING`、`AUTH_FAILED`、`ORIGIN_REJECTED`、`MULTIPLAYER_UNSUPPORTED` | true | `fix_environment` |
| 协议 | `PROTOCOL_MISMATCH`、`INCOMPATIBLE_PROTOCOL`、`UNSUPPORTED` | true | `upgrade` |
| 控制 | `CONTROL_REQUIRED`、`CONTROL_BUSY`、`CONTROL_EXPIRED` | true | `restart_control` |
| 状态漂移 | `STALE_REF`、`WORLD_CHANGED`、`MENU_MISMATCH`、`NOT_FOUND`、`SAVE_NOT_FOUND`、`PAUSE_BLOCKED` | true | `observe` |
| 执行 | `ACTION_BUSY`、`BUSY`、`PATH_BLOCKED`、`OUT_OF_REACH`、`INSUFFICIENT_RESOURCE`（含 `NOT_ENOUGH_MONEY`/`NOT_ENOUGH_ITEMS`/`INVENTORY_FULL` 别名）、`RATE_LIMITED`、`INVALID_ARGUMENT` | true | `wait` / `observe` |
| 不确定 | `RESULT_UNKNOWN`、`TIMEOUT`、`INTERNAL_ERROR` | **false** | `query_action` |
| 幂等/限额 | `IDEMPOTENCY_CONFLICT`、`OUTPUT_LIMIT`、`JOURNAL_UNAVAILABLE` | true | `observe` / 人工处理 |
| 停止/取消 | `CANCELLED` | 取决于派发阶段；运行中停止为 false | `observe` / `query_action` |

规则：`effectKnown=false` 表示**效果可能已发生**，禁止换新 ID 重放；只能查询/观察。

上表中 true 适用于派发前已知拒绝。动作 Tick 期间异常、核验失败、加载异常及停止可能已有副作用，会覆盖为 false 并保留 unknown；不能仅凭原始错误码推定没有消费。

## 8. 限额

| 项 | 值 |
| --- | --- |
| Bridge 端口 / Mod 端口 | 17655 / 17654（均可配置） |
| 租约 TTL | 180000 ms |
| 心跳间隔 / 心跳超时 | 1000 ms / 5000 ms |
| 单动作默认超时 | 15000 ms |
| 钓鱼 / 战斗 / 等待上限 | 55000 / 10000 / 10000 ms |
| 单请求体上限 | 65536 字节 |
| Mod 帧上限 / 队列上限 | 256 KiB / 64 帧 |
| 账本动作上限 | 65536 条 |
| 截图上限 | 8 MiB 像素缓冲 / 2.8 MB PNG |

## 9. 与 1.1 草案的差异

| 草案 | 实现 | 原因 |
| --- | --- | --- |
| 去重键含 `worldGeneration` | 只含 `gameInstanceId + actionId`，世界代次仅作审计 | 首次写入时世界代次未知（0），含进去会让重放绕过去重（实现期发现的真实缺陷） |
| 每个宿主需要各自接入 | 一个 Bridge + 三种生成好的配置片段（DSH/Codex/Claude Code × http/stdio） | 减少重复部署，令牌统一由 Bridge 签发 |
| `stardew_stop` 可停任意动作 | 只停调用方自己的动作，人工急停走网页/热键 | 避免一个 Agent 打断另一个 Agent 的合法动作 |
| 计划中的独立"查询动作"工具 | 由 `stardew_status` 返回未决动作 + 账本回执，不额外增加工具 | 工具面保持 28 个，避免同类入口分叉 |
| Mod 侧 `diag` 诊断命令 | 删除（无引用） | 与"不留内部调试通道"一致；诊断走 `/api/v1/diagnostics` |
