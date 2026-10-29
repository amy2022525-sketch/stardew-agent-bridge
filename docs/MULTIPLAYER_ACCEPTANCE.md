# 联机（MP1）验收脚本

> 用途：接手验收的 AI / 人员按本文逐项执行并**如实记录**。规则沿用项目交接档案：没做过的项目保持 `not_run`；"自动测试通过"不得写成"实机可用"；主机观察不是动作已被确认/持久化的证明。

## 0. 记录规则

每项记录：`项目 / 结果（pass|fail|not_run）/ 证据（日志、截图、收据 actionId）/ 执行人+日期`。Windows 与 Linux 分开记录。任何 fail 不通过修改宣传口径消化，原样上报。

## A. 自动化回归（每轮验收前执行一次）

在联机工作区 `F:\星露谷\work\multiplayer-mp1-20261024`（其他机器按交接档案恢复）：

```powershell
npm ci                # 仅锁文件变化时
npm run build
npm test              # 所有适用项通过；Windows 跳过 Linux 专属用例，精确数量记录在当前报告
npm run test:mod      # 隔离 C# 检查全部通过；不替代真实游戏
dotnet build mods/StardewAgentBridge/StardewAgentBridge.csproj -c Release '-p:GamePath=<游戏目录>' -p:UseSharedCompilation=false
                      # 预期：0 警告 0 错误
```

当前基线（2026-10-24 接手会话）即为上述数字。数字不符时先停止，报告差异。

## B. 实机准备（未做不得开始 C/D）

- [ ] B1 专门 QA 农场与 QA 角色（不使用玩家真实进度存档），独立备份 QA 存档。
- [ ] B2 主机客户端启用 host-coordinator（见 MULTIPLAYER_INSTALL.md §2）；AI 客户端启用 farmhand 并完成 Web 绑定（§4）。
- [ ] B3 双方 SMAPI 日志开启且可导出；记录双方游戏/SMAPI/Mod 版本。

## C. 主机侧与绑定

- [ ] C1 原生 Co-op 进入真实农场；`sab_mp list` 能读到 AI farmhand 的 FarmerID（Int64 十进制字符串）。
- [ ] C2 Web 绑定成功后，config.json 的 ExpectedWorldId/ExpectedActorFarmerId 与实际一致；换角色/换世界后绑定失效（STALE_ACTOR_SESSION / ACTOR_BINDING_REQUIRED）。
- [ ] C3 未 allow 时 `stardew_multiplayer status` 为 bound_readonly / HOST_PERMISSION_REQUIRED；hello 的 writeCommands 为空且 writeCommandsReason 有明确原因。
- [ ] C4 `sab_mp allow` 后 hello 的 writeCommands 只包含政策开放的命令（关闭 AllowWatering 时无 use）。

## D. 控制与动作（每项先小范围）

- [ ] D1 `mode=realtime` 取得控制；非 realtime 被拒（REALTIME_REQUIRED）。第一轮 acquire 在主机批准前返回等待语义，不阻塞游戏线程。
- [ ] D2 移动少量格子并停手：观察许可时限内完成；超时/越界被拒。
- [ ] D3 在 `sab_mp area` 允许区域浇 1 格水：双方观察一致；收据 confirmationScope=local_observed、durability=not_saved；**不得**声称主机已确认或已保存。
- [ ] D4 走允许的 Warp/Building 门换图：旧控制关闭（SCENE_CHANGED），需重新获取；动作跨图收据不谎报成功。
- [ ] D5 open_inventory 打开自己的背包并正常关闭；真人同时打开的菜单不被 AI 关闭。
- [ ] D6 MP1 默认拒绝项实测被拒：商店购买、出货、箱子写、放置、钓鱼、战斗、saves/load、睡觉确认（UNSUPPORTED_IN_MULTIPLAYER）。

## E. 干扰与恢复（逐项）

- [ ] E1 主机 `sab_mp revoke`：AI 本地控制立即关闭，不自动重取；重新 allow 后需显式重新 acquire。
- [ ] E2 许可到期（等待超过 PermissionLeaseMs 且未续期成功）：写入被拒，只读不受影响。
- [ ] E3 F9 紧急停手 / watchdog：停输入、停动作、撤控制；worldContinues 语义正确（不制造全局暂停）。
- [ ] E4 断开 AI 的 Bridge 与 Mod 连接再重连：旧 actionId 不重放（IDEMPOTENCY_CONFLICT 或同一收据）；断线时在途动作收据为 unknown。
- [ ] E5 连续控制预算（默认 120000ms）耗尽：主机拒绝续期；重连不重置预算；修改政策（policyRevision+1）后恢复。
- [ ] E6 保存/切日（Saving→Saved→DayStarted）：许可撤销、阶段屏障生效；跨日后需重新观察+acquire。
- [ ] E7 真人主机全程可正常操作、保存、结束游戏；AI 未影响主机保存。

## F. 账本与回退

- [ ] F1 v1 账本升级：出现 pre-mp-v2 备份文件且可独立打开；v2 墓碑保留。
- [ ] F2 同一 actionId 跨角色/世界：Web 查询不带作用域返回 409 AMBIGUOUS_ACTION_ID；带 worldId+actorFarmerId 返回正确收据。
- [ ] F3 回退演练（QA 数据）：停控制→退 Bridge→整目录备份→旧程序用升级前备份副本可运行；unknown 收据不被重放。

## G. 验收后

- 汇总记录表（含每项证据路径），更新 docs/MULTIPLAYER_TAKEOVER_UPDATE_*.md 的状态表。
- 发现的缺陷按交接档案 §8 格式新增 H 编号条目，不静默修复不记录。
