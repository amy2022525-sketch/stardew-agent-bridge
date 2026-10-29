# 联机（MP1）安装与配置指南

> 适用范围：Stardew Agent Bridge 联机首版（MP1）——真人主机 + 独立 AI farmhand 客户端。
> 状态说明：本文描述的安装流程在**源码构建层面已验证**（构建、自动测试通过）；双客户端实机联机验收尚未完成，见 MULTIPLAYER_ACCEPTANCE.md。

## 1. 前提

- 两份合法安装的《星露谷物语》（真人主机一份、AI 客户端一份，可同一台机器两个安装目录，也可两台机器）。
- 双方安装 SMAPI；双方游戏版本一致（联机本身的要求）。
- AI 客户端一侧安装本 Bridge（Node 22+，`npm ci && npm run build`）。
- 每个客户端的 Mod 使用本仓库构建产物：`dotnet build mods/StardewAgentBridge/StardewAgentBridge.csproj -c Release "-p:GamePath=<游戏目录>"`，把输出的 StardewAgentBridge 复制到各自 `Mods/` 下。**两个客户端的 Mod 数据根必须不同**（见下）。

## 2. 真人主机（host-coordinator）配置

主机 `Mods/StardewAgentBridge/config.json` 增加（与现有字段合并，不要整文件替换）：

```json
{
  "Multiplayer": {
    "Enabled": true,
    "Role": "host-coordinator",
    "RequireHostCoordinator": true,
    "PermissionLeaseMs": 5000,
    "PolicyFile": "multiplayer/policy.json"
  }
}
```

- 主机**不需要**运行 Bridge，也不需要任何 Agent 令牌。
- 启动游戏并以正常 Co-op 托管世界后，在 SMAPI 控制台管理政策：

```text
sab_mp status
sab_mp list
sab_mp allow <FarmersID>        # 启用该角色并允许其当前地点 + 自己材料制作
sab_mp area <FarmersID> <x> <y> <width> <height>   # 以该角色当前地点为区域开放浇水
sab_mp revoke <FarmersID>
sab_mp disable
```

- 政策文件固定为该 Mod 数据根下 `multiplayer/policy.json`（自动生成，Linux 上 0600/0700）。
- `policyRevision` 变化会立即撤销旧许可；AI 需要重新观察与获取控制。

## 3. AI 客户端（farmhand）配置

AI 客户端 `Mods/StardewAgentBridge/config.json`：

```json
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
```

- `ExpectedWorldId` / `ExpectedActorFarmerId` **不要手填猜测值**：进入世界后通过 Web 绑定自动写入（见 §4）。
- `PermissionLeaseMs` 取 1000–10000；首版建议 5000。最短 1000ms 的续期已按实际 TTL 调度并通过状态机测试。
- 该客户端正常启动 Bridge（`sab` 或既有启动方式），确认 Bridge 的 DataDirectory 与该 Mod 数据根一致（安装记录/启动脚本会校验）。

## 4. 首次绑定流程

1. 主机创建/加载 Co-op 世界；AI 客户端用自己的存档角色正常加入该世界（原生 Co-op 流程，Steam 正常登录）。
2. 主机在 SMAPI 控制台 `sab_mp list` 读取 AI farmhand 的 FarmerID。
3. AI 侧打开 Bridge Web（本机回环），用网页会话执行「绑定当前角色」（POST /api/v1/multiplayer/bind，需要会话 + CSRF + 同源；MCP/Bearer 不能绑定）。
4. 绑定后 `ExpectedWorldId` / `ExpectedActorFarmerId` 写入该客户端 config.json，并立即生效。启用/更改 `Multiplayer.Enabled` 或 `Role` 才需要重启游戏。
5. 主机 `sab_mp allow <FarmersID>`（如需浇水再 `sab_mp area …`）。
6. Agent 通过 `stardew_multiplayer`（operation=status）确认绑定和主机政策已就绪。首次 `stardew_session` start、`mode=realtime` 会请求主机短期许可，可能先返回 `HOST_PERMISSION_REQUIRED`；此时没有执行游戏动作。
7. 只读轮询 `stardew_multiplayer`，等 `permissionLeaseHeld=true` 后再次 start realtime。不要在等待期间连续 start（新请求会使旧许可请求过期）。仍未获准时核对主机日志和政策，不自动重放游戏动作。

## 5. 验证安装

- AI 侧 MCP 只读工具 `stardew_multiplayer` operation=status/connection/policy/players 应返回真实世界/角色信息。
- hello 中 `writeCommands` 非空且有主机许可；为空时 `writeCommandsReason` 给出与错误码同名的原因（HOST_PERMISSION_REQUIRED 等）。
- 联机下 Web「暂停」按钮禁用；世界阶段（active/saving/day_transition）可见。

## 6. 升级与回退

- Bridge 升级后首次打开 v1 账本会自动生成一致备份（`ledger.sqlite.pre-mp-v2.<时间戳>-<UUID>.sqlite`，SQLite VACUUM INTO）再迁移到 v2；备份路径会在日志中给出，请保留。
- 回退到旧版本 Bridge/Mod：先停止 Agent 控制、结束控制会话、退出 Bridge；复制保留**全部**数据目录（不要只拷 ledger.sqlite 而丢 WAL）；旧程序使用升级前备份的独立副本，保留 v2 原账本供核对。
- 不得用旧版本程序打开 v2 账本。旧程序未必识别新 schema，也不能保证拒绝写入；回退必须使用升级前备份的独立数据目录。不要删除 unknown 收据来"修复"历史。

## 7. 安全边界（首版约定）

- Bridge 与 Web 仅监听本机回环；不暴露到局域网。
- 主机审批只在主机本地 SMAPI 控制台进行；MCP 没有审批/绑定/任意执行工具。
- 真人主机负责世界保存与推进；AI 不能加载/列举主机存档、不能操作商店/箱子/钓鱼/战斗（MP1 默认拒绝）。
- 诊断导出会对联机身份/会话字段脱敏；正常运行界面仍可查看这些非秘密身份。

## 8. 原生门与场景切换

- 主机政策必须同时允许当前地点和目标地点。`sab_mp allow` 只添加角色当前地点；去新地点前可由真人把角色带到该地后再次 allow，或退出主机游戏后离线编辑政策，再重新启动主机。
- 支持地图 `Warp x y Location`、无附加条件的 `LockedDoorWarp x y Location open close`、`Back.TouchAction` 的 `Warp Location x y`，以及正常建筑门和原生 warps。仍由游戏检查距离、开门时间及通行条件。
- `Sleep`、`MagicWarp`、剧情、未知 Action 或带额外参数的变体默认拒绝。TouchAction 出口请明确 move 到观察到的目标格；不把它当成任意 interact。
- 切图立即撤销旧控制权并停止输入；只对事先识别且地点一致的出口进行只读落点确认，保留原 actionId/actorContext。确认仅表示 `local_observed` / `not_saved`，不代表主机已保存。
- 切图稳定后重新 snapshot、start realtime；未知落点、撤权、保存或超时返回 unknown，不能重放消费动作。
