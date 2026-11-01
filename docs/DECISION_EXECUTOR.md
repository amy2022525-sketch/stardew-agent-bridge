# AI 任务助手（双模型决策执行器）

面向玩家的使用说明，以及给主模型（DSH、Codex、Claude Code 等 MCP 客户端）的调用约定。

> **当前状态：** 已通过类型检查、构建与自动化测试（含 Mod 隔离测试），并完成部分隔离 Mock 浏览器验收及 Windows 审计包验证；**尚未**做真实模型调用、真实游戏操作、Linux 原生与 Docker 镜像运行验收。逐项覆盖见 [验收矩阵](DECISION_EXECUTOR_ACCEPTANCE.md)。
> 本文描述的是设计行为；实际可用性以 `docs/DECISION_EXECUTOR_ACCEPTANCE.md` 的验收结果为准。

## 1. 它解决什么问题

默认模式下，外部 Agent 自己一步一步调用 `stardew_move`、`stardew_use`……每一步都要经过一次宿主模型往返。
开启“AI 任务助手”后：

1. 主模型只下发一次**目标 + 限制 + 预算**；
2. Bridge 内部按你配置的执行模型循环“观察 → 决策 → 校验 → 调用既有动作服务 → 核对”；
3. 主模型轮询任务状态，拿到结构化汇报（或卡点）。

Bridge 不替主模型做目标拆分，也不替执行模型做动作；两层各自负责擅长的事。

## 2. 安全边界（先读这段）

- **默认关闭。** 关闭时不调用执行模型、不读取密钥内容；原有直接 MCP 玩法完全不变。
- **同时只运行一个自动任务。** 第二个派单返回 `EXECUTOR_BUSY`，不会在后台排队。
- **只支持单人模式。** 联机世界派单返回 `MULTIPLAYER_AUTOMATION_UNSUPPORTED`；原有联机直接控制不变。
- **不跨日、不睡觉、不读写存档。** `allowDayChange` 只能是 `false`；自然跨日进入待复核。
- **所有游戏写动作仍走原 `ActionService`。** 保留控制租约、单动作互斥、幂等键、动作账本与“未知结果不重放”。
- **执行模型拿不到敏感工具。** 控制会话、任务派单、配置/密钥、存档、联机、文件与 shell 永不暴露。
- **人工停止优先。** F9、网页接管、关闭自动执行都会让当前执行 generation 立即失效；迟到的模型回答不会再派发动作。
- **身份是保留的。** 内部执行身份用前缀 `sab-internal-decision:`，`web` 是本地网页管理会话的标识；
  两者都不能签发给外部 Bearer 客户端。Web（本机登录）可以查看、暂停、取消任意 Agent 的任务，但不能冒充执行身份，也改不了任务归属。
  升级前已存在的同名保留身份凭据也不会被接受为 Bearer 登录。

## 3. 配置执行模型

Web 控制台 → “AI 任务助手” → “设置模型”。

| 字段 | 说明 |
| --- | --- |
| 接口协议 | `openai-responses` 或 `openai-chat-compatible`。两者请求路径、正文结构和完成判定不同，不能混用。 |
| 服务地址 | **已经包含 API 前缀**的 URL，例如 `http://127.0.0.1:1234/v1`。程序只追加一次 `/responses` 或 `/chat/completions`。 |
| 模型 ID | 由你的服务提供的模型名；不硬编码任何厂商型号。 |
| 鉴权方式 | `none` 必须显式选择；`bearer` 需要单独写入密钥。 |
| 结构化输出 | `json_schema`（严格）、`json_object`，或兼容服务的 `plain_json`。 |
| 允许私网 / 明文 HTTP | 本地服务通常两项都要开；公网 HTTPS 服务不需要。 |

密钥写入独立文件，不回显、不进入浏览器持久层、不进入日志/事件/问题包。
在 Docker 里，容器内的 `127.0.0.1` 指容器自己；连接宿主本地模型需要部署者改成实际可达地址。

### 本地模型示例（仅示意，不是可用型号）

```json
{
  "id": "local-executor",
  "label": "我的执行模型",
  "protocol": "openai-chat-compatible",
  "baseUrl": "http://127.0.0.1:1234/v1",
  "model": "replace-with-local-model-id",
  "authMode": "none",
  "secretRef": null,
  "decisionFormat": "json_schema",
  "maxOutputParameter": "max_completion_tokens",
  "timeoutMs": 30000,
  "maxOutputTokens": 2048,
  "allowPrivateNetwork": true,
  "allowPlainHttp": true
}
```

### “检测模型”会做什么

点击后发起**一次**受限请求（最多 64 token），只验证“能返回有效 JSON”。可能产生真实费用。
保存设置、打开网页、`doctor` 都不会自动调用模型服务。

## 4. 允许派单与操作范围

- **允许派单的 Agent**：填写已注册的 `clientId`（例如 `dsh`、`codex`）。不在名单内的客户端调用派单会得到 `DECISION_NOT_AUTHORIZED`。
- **操作范围**：
  - `observe-move`：状态、快照、检查、正常移动、关闭普通菜单；无经济与物品消费。
    刻意不含 `wait`（写类动作，可能被用来维持租约）、`doctor` 与 `screenshot`。
  - `farm-care`：在上一档基础上开放“选择水壶”和“对已观察且需要浇水的作物使用”。其它写工具仍被拒绝。
  - `custom`（配置文件手写）：必须给已实现的参数保护（见 §8），未知保护字段会拒绝保存。

## 5. 主模型调用流程（MCP）

```text
1. stardew_context(current)          → 拿 contextToken（60 秒）与可用 provider/policy
2. stardew_task(submit)              → 拿 taskId；accepted 不代表完成
3. stardew_task_status(wait)         → 有变化立刻返回；超时只结束等待，不取消任务
4. completed                         → 检查 evidenceLevel / unresolvedActionIds / remainingWork
5. waiting_main                      → 读 blocker，reply 或调整任务
6. needs_review                      → 先核对原动作收据，不能换 actionId 重做
7. 用户要求停下                      → stardew_task(cancel/pause)，不要只在聊天里说“已停止”
```

### submit 示例

```json
{
  "operation": "submit",
  "requestId": "water-east-20261029-01",
  "contextToken": "从 stardew_context 拿到的短期 token",
  "title": "浇好农舍旁的指定作物",
  "goal": "给指定区域内当前已种植且需要浇水的作物浇水。缺水时在许可范围内补水；体力低则停下汇报。",
  "providerId": "local-executor",
  "policyId": "farm-care",
  "scopeMode": "persistent",
  "constraints": {
    "locations": ["Farm"],
    "stopEnergyAtOrBelow": 20,
    "stopHealthAtOrBelow": 30,
    "latestStartGameTime": 2300,
    "allowDayChange": false,
    "maxGoldSpend": 0
  },
  "budget": { "maxModelCalls": 60, "maxWriteActions": 80, "maxActiveMs": 600000, "maxAccountedTokens": 120000 },
  "successCriteria": [
    { "kind": "crop_tiles_watered", "location": "Farm", "tiles": [{ "x": 64, "y": 18 }, { "x": 65, "y": 18 }] }
  ]
}
```

### 幂等

`requestId` 是调用者作用域内的幂等键：

- 同键 + 同内容 → 返回原结果，不产生第二次副作用；
- 同键 + 不同内容 → `TASK_IDEMPOTENCY_CONFLICT`；
- 提交后网络断开：用**同一个** `requestId` 重试取回原结果，不要新建任务。

`pause` / `cancel` 不要求 `expectedRevision`：紧急停止不会被过期版本挡住。

## 6. 状态与证据

| 状态 | 含义 |
| --- | --- |
| `queued` | 已接单，正在做启动检查（不是排队系统） |
| `running` | 执行循环运行中 |
| `pausing` | 已请求暂停，正在停止己方动作 |
| `paused` | 已停下，可显式 resume |
| `waiting_main` | 需要主模型处理，或达到本次限制 |
| `needs_review` | 有未知结果动作或世界变化，必须先核对 |
| `completed` / `failed` / `cancelled` | 终态 |

完成证据分三级：

- `verified_observation`：最新观察下所有机器条件都满足，且没有未决动作；
- `main_reviewed`：只有人工/主模型审核（`manual_review` 条件或审核候选）；
- `none`：没有可核验证据。

`worldSaved` 永远是 `unknown` 或明确来自存档事件；**任务完成不等于存档已写盘**。

机器可验证条件只有四种：

| kind | 判断 |
| --- | --- |
| `at_tile` | 最新位置在指定地图，曼哈顿距离 ≤ `tolerance`（0–1） |
| `inventory_at_least` | 当前背包含计 ≥ count（可选品质精确匹配） |
| `crop_tiles_watered` | 指定地块在同一游戏日被完整观察，有作物且 watered=true |
| `manual_review` | 只生成候选，必须人工/主模型审核 |

缺格、快照截断、世界不符、观察过期一律 `unverifiable`，不会默认为成功。

## 7. 预算与停止条件

默认值（服务端硬上限，任何一侧只能更严）：

| 限制 | 默认 |
| --- | --- |
| 每任务模型 HTTP 尝试 | 60 |
| 每任务写动作 | 80 |
| 累计运行时间（含模型等待，不含人工暂停） | 10 分钟 |
| 核算 token | 120000 |
| 单次模型请求 | 30 秒（5–90 秒） |
| 单次输出 | 2048 token |
| 响应纠错 | 每个决策 1 次 |
| 传输重试 | 每次决策最多额外 2 次 |
| 重规划 | 每 run 最多 2 次 |

- 未回报 usage 时保留保守预留额度并标 `usageUnknown`；这不是服务商账单。
- 体力/生命/游戏时间是**开始下一动作之前及动作之后**的停止条件；执行中的一次动作仍可能让数值跨过阈值。
- 同一目标连续 3 次同样失败且无可观察进展 → `TASK_STALLED`，停止汇报。

## 8. 政策与参数保护（已实现）

| 保护 | 实现方式 |
| --- | --- |
| `waterOnly` | `stardew_select` 只能选水壶槽位；`stardew_use` 的目标必须是本轮快照中 `needsWater`/`watered=false` 的作物引用；其它写工具拒绝。 |
| `maxCountPerAction` | 单次 `count`/`quantity` 上限。 |
| `allowedItemIds` | `itemId`/`item` 白名单。 |
| `maxGoldSpendPerAction` | `price`/`maxPrice`/`gold` 上限。 |

未实现的保护字段（正则、脚本、SQL、任意表达式）**拒绝保存**，不会假装生效。

custom 政策的工具准入是“表驱动”的，不是“配了就生效”：

| 工具 | D1 是否可开启 | 条件 |
| --- | --- | --- |
| `stardew_move`、`stardew_select`、`stardew_closemenu`、只读工具 | 可以 | 无需额外 guard |
| `stardew_use` | 仅浇水/补水闭环 | 必须 `waterOnly: true`，实际手持是水壶，目标为当前待浇作物或游戏确认的可补水地块 |
| `stardew_ship`、`stardew_place`、`stardew_eat` | 可以 | 必须 `allowedItemIds` + `maxCountPerAction`，从实际背包槽位核对物品 |
| `stardew_equip` | 穿戴可开启，卸下暂不开放 | 必须 `allowedItemIds`；没有来源证据时拒绝 |
| `stardew_container`、`stardew_craft` | **不可以** | D1 没有完整箱内来源/配方消耗证据，不能用物品白名单冒充保护 |
| `stardew_fish`、`stardew_combat` | 可以 | 工具自带时间/生命上限，无额外 guard |
| `stardew_buy` | **不可以** | D1 未实现按货架预留金额与对账 |
| `stardew_interact`、`stardew_menu` | **不可以** | 未实现目标种类 × 所选物品的联动保护 |
| `stardew_wait` | **不可以** | 可能被用来维持租约 |
| 会话/任务/存档/截图/联机/诊断 | **不可以** | 永不暴露给执行模型 |

自定义政策目前只能通过 `decision/config.json` 的 `customPolicies` 编写；Web 表单只覆盖两个内置预设。

模型返回动作后，程序会重新观察并复核实际所选工具、物品与目标；已变化的场景重新决策，只为可证明相同的静态地块更新引用。运行中政策只能收紧，撤销客户端注册或使用权限会使旧模型回答失效。任务进度显示有机器证据的目标条件核对数，计划子步骤不会因整任务成功而自动变成“已核验”。

## 9. 故障与恢复

| 情况 | 行为 |
| --- | --- |
| 未配置执行模型 | 派单返回 `PROVIDER_NOT_CONFIGURED`，不展示假进度 |
| 控制权被其他客户端持有 | `waiting_main` + `CONTROL_BUSY`，不抢占 |
| 暂停时模型请求在途 | 立即 abort；该回答被丢弃 |
| 动作结果未知 | `needs_review`，保留 actionId；**不会用新 ID 重做** |
| 世界/角色/日期变化 | 停止并待复核；不迁移旧任务 |
| Bridge 重启 | 运行中任务 → `needs_review`；不自动续跑 |
| F9 / 网页接管 | 用户停止锁生效；主模型不能自行 resume，需玩家在 Web 重新“允许自动执行” |
| 决策库损坏/未来版本 | 自动执行降级为禁用，原文件不删除；旧直接 MCP 尽量保留 |

## 10. 常见问题

**Q：页面显示“待配置”，但我的 DSH 能用旧工具？**
A：这是预期行为。执行模型是可选扩展；不配置不影响原有 MCP 工具。

**Q：`accepted:true` 但游戏没动？**
A：`accepted` 只代表接单成功。用 `stardew_task_status` 看 `blocker`，常见原因是未加载存档、控制权被占、`PAUSE_NOT_CONFIRMED`。

**Q：为什么任务停在 `needs_review`？**
A：有动作结果未知（例如 Mod 回执丢失）。先按 `actionId` 查原收据，再决定是否新开任务；不要重复消费动作。

**Q：能自动跨日/睡觉吗？**
A：不能。这是 D1 的明确边界。

**Q：能给“整个农场”派单吗？**
A：能派，但核验会更困难。精确地块比“整片地”更容易得到 `verified_observation`。

## 11. 相关文档

- `docs/DECISION_EXECUTOR_ACCEPTANCE.md`：自动化与隔离浏览器分开记录；部分覆盖标 `partial_pass`，真实模型/实机项仍 `not_run`
- `docs/adr/DECISION_EXECUTOR.md`：为什么默认关闭、为什么保留旧直接模式
- `docs/AGENT_GUIDE.md`、`docs/CLIENTS.md`：现有工具与身份约定
- `docs/DECISION_EXECUTOR_DEVELOPMENT_HANDOVER_20261030.md`：完整开发规格
