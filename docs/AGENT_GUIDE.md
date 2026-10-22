# Agent 操作指南（给模型的实用流程）

这份文档写给**要玩这个游戏的下一个模型**。它不讲协议细节（见 [PROTOCOL.md](PROTOCOL.md)），只讲怎么少踩坑。

## 1. 基本循环

```
stardew_doctor            # 环境对不对（一次就够，不用每步都调）
stardew_session           # {operation:"start"} 拿到控制权
stardew_snapshot          # 看世界：位置、背包、作物、出口、菜单、control
   ↓ 选一个动作
stardew_move / use / interact / menu / buy …（带自己的 actionId）
   ↓
stardew_snapshot（或 inspect）核对真实结果 → 再下一步
stardew_session           # {operation:"end"} 结束时显式释放控制权
```

要点：

- **先观察再行动**：`targetRef`（`@s12:e7`）有保存数量与世界/场景代次限制；优先使用最新观察的引用，失效后重新观察。
- **动作后必核对**：`status`、`verified` 与 `effects` 必须一起看；`accepted` 仅受理、`partial` 可能未达目标，最终还要用快照核对。
- **每个新动作使用新 `actionId`**：例如 `act-<日期>-<序号>`。查询或重复提交原请求时保留原 ID 和原参数；结果不明时不得换新 ID 自动重做。

## 2. 遇到这些就停下来观察

| 回执 | 该做什么 |
| --- | --- |
| `effectKnown=false`（`RESULT_UNKNOWN`/`TIMEOUT`/`INTERNAL_ERROR`） | `stardew_status {actionId:"原ID"}` → `stardew_snapshot`；先停止并核对。缺少变化不能证明从未生效；禁止自动换新 ID 重试消费动作 |
| `CONTROL_EXPIRED` / `CONTROL_REQUIRED` | 重新 `stardew_session start`，再 `snapshot` 重建引用 |
| `BUSY` / `ACTION_BUSY` / `PAUSE_BLOCKED` | `stardew_wait` 或看 `snapshot.control.blockedBy`；剧情/结算/信件请用 `menu` 处理，别硬来 |
| `STALE_REF` / `MENU_MISMATCH` | 世界变了：重新 `snapshot`，别复用旧引用 |
| `OUT_OF_REACH` / `PATH_BLOCKED` | 先 `move` 到目标附近（`near` 引用），再 `use`/`interact` |
| `INSUFFICIENT_RESOURCE` | 这是真实状态（钱/物品/背包不够），换目标，别重复尝试 |

**绝不**：编造 `targetRef`、复用旧 `actionId` 换参数、猜 `itemId`/`recipe`（必须先 `shop`/`recipes`）、用"再试一次"赌消费动作。

## 3. 界面与事件

- `snapshot.menu` 出现时，只能用 `stardew_menu {target}` 选它给出的**真实选项**；`closemenu` 只对可关闭菜单有效。
- 剧情、信件、结算期间 `control.pause.state = blocked`：先处理它们（`menu`），再恢复动作。
- step 模式每步之后 Mod 会**尝试**正常暂停；`pause.selfOpened=true` 说明是它自己开的，后续动作会自动关闭它并继续；`selfOpened=false` 是玩家开的菜单，别关。

## 4. 效率建议

- 一次 `snapshot(radius: 8)` 通常够用；只在找远处出口/动物时加大半径。
- `inspect` 比 `snapshot` 便宜：只想知道一个目标的状态时用它。
- 连续同类动作（如收一片作物）：`snapshot` 一次 → 逐个 `use` → 最后 `snapshot` 核对；不要每个动作都全量快照。
- 走路用 `move {near: "@s12:e7"}` 让 Mod 自己寻路；不要一点点挪格子。

## 5. 消费动作（钱、物品、时间不可回滚）

1. `stardew_shop` / `stardew_recipes` 拿真实 `itemId` / `recipe`。
2. 记下动作前的 `money` / 背包数量。
3. 用**新** `actionId` 执行一次。
4. `snapshot` 核对：钱减少了多少、物品增加了多少。
5. 结果不明时**只查询、不重放**。

## 6. 结束与交还

- 干完活：`stardew_session {operation:"end"}`；Mod 会尝试正常暂停；检查返回的 pause，blocked/unknown 不等于已暂停。
- 玩家想接管：任何时刻按 `F9`，或在网页点「接管」——你的 `epoch` 立刻失效，后续写请求会被拒（这是设计，不是你出 bug）。
- 出问题别硬撑：调用 `stardew_stop` 停自己的动作，然后汇报现象与回执。

## 7. 汇报格式建议

```
做了什么：<动作序列 + actionId>
结果：<effects 关键差分：位置/背包/金钱>
当前状态：<位置、时间、体力、在途动作、控制权>
下一步建议：<一个具体动作>
异常：<错误码 + 现象，如果有>
```
