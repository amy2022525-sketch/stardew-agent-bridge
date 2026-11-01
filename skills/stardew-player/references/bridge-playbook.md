# 工具与执行模式

适配 Stardew Agent Bridge v0.30 / 程序 0.3.0。工具定义、实时能力和实际返回优先于本文；不同 MCP 宿主可能在名称前加服务器前缀。本文调用示例中的 `tool`/`arguments` 是展示包装，不是额外的 MCP 工具。

## 1. 直接控制

先 `stardew_status` 和 `stardew_snapshot`。持有其他 Agent 的会话、未决动作或玩家停止锁时，不抢控制。正常直接操作按工具返回申请 `stardew_session` 的 step 会话；结束时只释放己方会话。

| 场景 | 工具 / 判断 |
| --- | --- |
| 控制与回执 | `stardew_status`；可用 `actionId` 查询原收据，不重新执行 |
| 世界与局部细节 | `stardew_snapshot` 默认半径 5，最大 16；`stardew_inspect` 检查单个当前引用 |
| 移动 | `stardew_move` 的 `near` 来自最新观察；坐标、地图出口也须有观察依据；不用逐像素走路 |
| 工具/物品 | `stardew_select` 选择真实槽位，再 `stardew_use`；浇水前确认水壶及作物仍需水，缺水先找实际可补水处 |
| 交互与菜单 | `stardew_interact` / `stardew_menu` 只用真实选项；不代关玩家菜单 |
| 交易与生产 | 先 `stardew_shop` / `stardew_recipes` / 容器读取，再核对物品、数量、金额和预留；按实际工具 schema 操作 |
| 停止 | `stardew_stop` 处理己方动作；执行模型任务要另用 `stardew_task` pause/cancel；不要停完聊天却留任务在后台 |
| 联机 | 读 `stardew_multiplayer` 的实际主机许可与角色绑定；本 Skill 不授予任何额外联机权利 |

截图只在视觉能解决文本观察缺失时使用。若目标已有返回快照/明确差分，可直接用该证据，不再为了“核验”重复拉取同样数据。连续浇水可按可达小区批量操作，但每个工具请求仍逐个等待返回；失败、覆盖不足或状态变化时终止这批。

重要资源动作前，把新 actionId、意图和动作前资源写到短期日志，状态为 `prepared`；返回后再写实际结果。崩溃后只有 `prepared` 不能推断动作未执行。结果未知时先查询原 ID，保留 `unknown` 直到有足够证据；不能自动重放购买、出货、制作、吃物品等消费操作。

`effectKnown=false`、`RESULT_UNKNOWN`、超时、账本异常：停止新写入，读原收据及当前观察。`STALE_REF`、`MENU_MISMATCH`：重观察。`OUT_OF_REACH`：基于当前目标重新寻路。`PATH_BLOCKED`：确认障碍和替代路线，不盲刷同一坐标。控制失效时先判定是否玩家接管；不能一律重新申请。

## 2. 双模型派单

仅玩家已配置并启用执行模型、允许当前客户端和政策时使用。先 `stardew_context` current；读取实际 provider、policy、世界身份和停止锁，不保存短期 token。释放己方直接会话后再派单。

优先指定已观察到的少量作物格、同日限制、体力/生命阈值和小预算。当前 `farm-care` 允许受保护的选择水壶、浇水与补水；不把“购物后种植再睡觉”包装成这个政策可以完成的任务。自动执行不支持联机、不支持跨日；直接模式的正常睡觉也需玩家授权和当时工具支持。

收到 taskId 立即写短期日志；`accepted` 只是接单。用 `stardew_task_status` wait 等状态变化，保留返回的 stateVersion，避免高频轮询。wait 超时不取消任务，不要因此再 submit。

`completed` 后核对 `completion.evidenceLevel`、成功条件、`unresolvedActionIds` 和 `remainingWork`；`verified_observation` 只是观察证据，`main_reviewed` 是审核结论。`worldSaved=unknown` 不能改为 saved。`waiting_main` 读取阻塞后处理，`needs_review` 先核对旧动作；重启后不自动恢复任务。

主 Agent 负责写日志和整理长期经验；Bridge 不会自动把这些文件注入执行模型。需要用到的资源预留、停止条件、地块和当前目标，要明确放进本次任务的 goal / constraints / successCriteria。

## 3. 使用 Bridge 记忆保存日志

有文件能力时以宿主可写日志为主；仅 MCP 的 Agent 可以在记忆服务可用时使用下列方式。失败或不可用时交付聊天检查点，不自行开启任务助手来建库。不要直接编辑 `decision.sqlite`、凭据或存档。

短期用 `task_working`，每日事实摘要用 `episodic`，长期目标/经验用 `strategy`。模型写入的 sourceType 用 `main_model`，不要伪造 `native_game`、`observed` 或玩家偏好 `preference`。API 会把模型输入记为 `reported`；内容里可以列真实来源 ID，但不因此提升 API 的证据等级。

下面示例是格式演示，不能原样当作真实游戏事实提交。写入时替换日期、内容及所有 ID，只引用实际返回的证据。

```json
{"tool":"stardew_memory","arguments":{"operation":"search","query":"playlog-short","kind":"task_working","limit":3}}
```

没有当前 owner/世界的检查点时才 add；成功后保存真实 memoryId 和 revision。

```json
{"tool":"stardew_memory","arguments":{"operation":"add","kind":"task_working","title":"playlog-short","sourceType":"main_model","content":"示例格式：游戏日期=未知；目标=待读取玩家要求；已核验=无；未决=待读状态；下一步=核对当前存档身份。"}}
```

后续优先更新同一条，`expectedRevision` 必须来自刚读到的真实记录，不要按示例猜 ID / revision。冲突时重读并合并；不可用更高的猜测版本强行覆盖。

```json
{"tool":"stardew_memory","arguments":{"operation":"update","memoryId":"example-memory-id","expectedRevision":1,"content":"示例格式：核对后的当前目标、进度、未决 ID 与下一步。"}}
```

长期目标采用固定标题 `playlog-goals`；经验标题含主题，例如 `playlog-lesson-water-route`。短期记录建议 ≤1600 字，单条长期分片 ≤1800 字（API content 硬上限 2000 字）；goal、lesson、每日摘要分片存，不能把整本日志塞入一次请求。先 search 再 update，避免每个动作 add 一条直到挤满作用域。

MCP 的记忆输入当前**没有** visibility / profileId 字段；新记录默认属于调用者且 private，不保证不同 Agent 彼此可见。跨宿主交接用玩家授权的日志导出或共享工作目录，不能声称“所有 AI 已共享”。直接模式不传 taskId；使用 taskId 时只可写本人所属任务并检查其世界作用域。不要把历史任务的 taskId 用来写当前世界。

游戏日期的有效期写在 content 中并在恢复时比较；`expiresAt` 是现实世界 ISO 时间，不能拿游戏“春28日”冒充。memoryId / revision 可以记录在宿主索引中；token、Bearer、临时对象引用不记录。

进一步协议与政策：[Agent 指南](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/main/docs/AGENT_GUIDE.md)、[执行器说明](https://github.com/amy2022525-sketch/stardew-agent-bridge/blob/main/docs/DECISION_EXECUTOR.md)。这是可选深入阅读，本 Skill 的关键操作不依赖这些链接可用。
