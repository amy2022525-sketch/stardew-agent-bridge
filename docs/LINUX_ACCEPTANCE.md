# Linux 验收清单（人工执行）

> 2026-10-24 已有套件级验证结果，见 [首轮验证报告](../LINUX_VALIDATION_REPORT.md)。下表保留逐项待核验状态；套件通过不自动证明每条完整场景或原生游戏通过。

> **本文档不记录任何"已通过"结论。** 所有条目的初始状态都是 `not_run`，
> 执行者为原协作者（Codex），不是负责编写代码的 AI。填写结论时必须附命令、退出码、
> 日志路径或截图路径；没有证据的条目保持 `not_run`。

- 状态取值：`not_run` / `pass` / `fail` / `blocked`
- 执行归属：`original-collaborator-codex`
- 相关文档：[LINUX_INSTALL.md](LINUX_INSTALL.md)、[LINUX_DEVELOPMENT.md](LINUX_DEVELOPMENT.md)、
  [PLATFORM_MATRIX.md](PLATFORM_MATRIX.md)、[TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## 0. 验收前置

```bash
node -v                       # 期望 v22.13.0 或更高
dotnet --version              # 期望 10.x（仅源码构建与 tests/mod 需要）
echo "$XDG_DATA_HOME"         # 可为空；非空时必须是绝对路径
ls "$HOME/.local/share/Steam/steamapps/common/Stardew Valley/StardewModdingAPI.dll"
```

一次完整验收需要的环境：

1. 有图形界面的 Linux 桌面（X11 或 Wayland）；
2. Steam + 星露谷 1.6.x + SMAPI ≥ 4.5.2，且**已用 SMAPI 正常启动过一次**；
3. 至少一个有存档的单人角色（建议另存一份测试用存档，验收会消耗游戏内时间）；
4. 发布包 `StardewAgentBridge-<版本>-linux-x64.tar.gz` 与 `CHECKSUMS.txt`。

验收顺序建议：`P → S → I → K → R → G`。前四组不需要游戏；G 组需要真实游戏与存档。

## 1. 数据根与文件系统（P01–P12）

| ID | 场景 | 期望结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| P01 | Windows 默认 / `LOCALAPPDATA` / 原数据 | 原默认不变，既有凭据与账本继续可用 | not_run | |
| P02 | Linux 不设 `XDG_DATA_HOME` | Node / C# / 适配器都选择 `~/.local/share/StardewAgentBridge` | not_run | |
| P03 | Linux 绝对 `XDG_DATA_HOME` | 全部组件一致使用该根下应用目录 | not_run | |
| P04 | `XDG_DATA_HOME` 为空或相对值 | 回退默认，`doctor` 来源诊断明确 | not_run | |
| P05 | `SAB_HOME` 覆盖 | 全部进程同一绝对根；相对值明确拒绝（`PATH_INVALID`） | not_run | |
| P06 | `--data-dir` / Mod `DataDirectory` | 优先级符合规格；写入配置后两侧一致 | not_run | |
| P07 | Steam 启动不继承 `SAB_HOME` | Mod 依据安装器写入的绝对 `DataDirectory` 正常读凭据 | not_run | |
| P08 | 空格、中文、引号、`$`、`;`、`%`、大小写 | 路径往返正确；无 shell 执行、无错误拆参、无大小写折叠 | not_run | |
| P09 | 旧 Linux 根、新旧根并存 | 只诊断/显式选择，不静默合并不抹掉记录 | not_run | |
| P10 | 凭据/目录权限、原子替换 | `0700`/`0600` 合规；中断不暴露半截 JSON；不递归改祖先权限 | not_run | |
| P11 | 令牌轮换与热读 | 旧令牌被拒、新令牌可用、Mod 读到新 `modToken` | not_run | |
| P12 | 只读程序目录、任意 cwd、未设置 HOME | 私有数据独立；缺可用用户根时明确失败，不误写程序目录 | not_run | |

关键命令：

```bash
X="$(mktemp -d)"
node apps/server/dist/cli.js doctor --data-dir "$X" --json
SAB_HOME=relative/path node apps/server/dist/cli.js doctor --json   # 期望 PATH_INVALID
umask; ls -ld "$X"; stat -c '%a %n' "$X/credentials.json" "$X/endpoint.json" "$X/bridge.lock"
```

## 2. 单实例与生命周期（S01–S08）

| ID | 场景 | 期望结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| S01 | 两个进程同时 `launch` 同一数据根 | 只有一个持锁实例，另一个复用或明确等待/失败 | not_run | |
| S02 | 控制期间重复 `launch` / `doctor` | 会话、epoch、未决动作与收据不被探测改写 | not_run | |
| S03 | 端口被其他程序占用 | 不误判、不新建恢复账本、不改端口、不结束他进程 | not_run | |
| S04 | 陈旧 endpoint/锁、PID 复用 | 按启动身份判定；不按裸 PID 误杀；不删他实例新锁 | not_run | |
| S05 | SIGINT/SIGTERM 退出 Bridge | 自己的请求停止、锁与句柄清理、数据保留 | not_run | |
| S06 | 适配器 stdin 关闭 / SIGTERM | 仅适配器与自身请求结束，常驻 Bridge 仍服务别人 | not_run | |
| S07 | Bridge 在途动作中被终止、重启 | 回执 `unknown` 待核对，旧动作不自动重放 | not_run | |
| S08 | `launch` 浏览器打开失败 / 无 GUI | 服务结果与网页结果分开报告；`--no-open` 可诊断；给出真实地址 | not_run | |

关键命令：

```bash
B=bin/stardew-agent-bridge
"$B" start & "$B" start; echo "exit=$?"        # 期望第二次非 0（2 = 冲突）或复用
"$B" doctor --json
"$B" launch --no-open                          # 期望不尝试打开浏览器并给出地址
kill -TERM %1; ls "$DATA/bridge.lock"          # 期望锁被清理
```

## 3. Mod 安装与回退（I01–I12）

| ID | 场景 | 期望结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| I01 | 临时原生游戏目录首次安装 | 目标正确、只装本项目 Mod、写入正确配置 | not_run | |
| I02 | 旧 `AgentStardew.Bridge` 与新桥接共存 | 按 `UniqueID` 备份停用，其他 Mod 不动 | not_run | |
| I03 | 已有配置含未知键、UTF-8/BOM、中文 | 正确解析、保留未知键与原快照；回退恢复原文件 | not_run | |
| I04 | 运行中游戏 / 权限不足 | 修改前失败；不强杀游戏、不自动 sudo | not_run | |
| I05 | 符号链接逃逸、邻近前缀、大小写不同 | 只允许规范化后的授权目标；攻击性路径拒绝 | not_run | |
| I06 | manifest 错误 / 目标属于其他 Mod | 不覆盖、不移动无关目录 | not_run | |
| I07 | stage/backup 前后注入失败 | 旧安装与备份完整，journal 阶段明确 | not_run | |
| I08 | 移走旧目录后、提交新目录后失败 | 按真实阶段恢复，不因 finally 清理丢失旧版 | not_run | |
| I09 | latest 写失败、跨设备 rename、空间不足 | 变更前拒绝，或留下完整可恢复状态，不伪成功 | not_run | |
| I10 | 完整回退、重复回退 | 文件与配置恢复；重复操作幂等 | not_run | |
| I11 | `RemoveOnly` 后再恢复旧版 | 事务仍具恢复能力，不被错误状态跳过 | not_run | |
| I12 | journal 损坏 / 路径被篡改 / 恢复目标已存在 | 重新验证并拒绝危险覆盖，保留现场与快照 | not_run | |

关键命令（全部可离线进行）：

```bash
S=scripts/install-mod.mjs; R=scripts/rollback-mod.mjs
"$S" --game-path "<临时游戏目录>" --dry-run --json
SAB_FAIL_AT=committed "$S" --game-path "<临时游戏目录>" --json; echo "exit=$?"
"$R" --game-path "<临时游戏目录>" --remove-only --json
"$R" --game-path "<临时游戏目录>" --json
"$R" --game-path "<临时游戏目录>" --json            # 期望幂等成功
npm run test:installer                              # 覆盖 I01/I04/I05/I06/I07/I08/I10/I11/I12 的自动化部分
```

## 4. 发布包（K01–K08）

| ID | 场景 | 期望结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| K01 | 正式 tar 解压后执行 | `node`/入口执行位、架构、许可与清单正确 | not_run | |
| K02 | 源码树外、任意 cwd、中文空格目录 | 无祖先 `node_modules` 仍能启动 | not_run | |
| K03 | 受控 PATH、无全局 node/npm | 包内运行时执行所有 CLI 与 stdio，不偷偷用系统 node | not_run | |
| K04 | 真实 HTTP 与 stdio、无游戏 | 28 工具/`status` 可用；`snapshot` 给正确未连接错误 | not_run | |
| K05 | Web 资源、自检、配置下载 | 本包资源真实可用；两种通道实际往返 | not_run | |
| K06 | manifest/哈希/模式/禁止文件 | 篡改可检测；包内无游戏/私人数据 | not_run | |
| K07 | bridge-only 与 full 分型 | 无 Mod 包明确标注，不伪装完整发行物 | not_run | |
| K08 | Node 版本过低 / ELF 不匹配 / noexec 挂载 | 明确失败与原因，不误报已启动 | not_run | |

关键命令：

```bash
tar -xzf StardewAgentBridge-<版本>-linux-x64.tar.gz -C /tmp/pkg
cd /tmp/pkg/StardewAgentBridge-<版本>-linux-x64
./bin/stardew-agent-bridge version
env -i PATH=/usr/bin:/bin ./bin/stardew-agent-bridge doctor --json
npm run verify:package -- /tmp/pkg/StardewAgentBridge-<版本>-linux-x64   # 期望全部断言通过
```

## 5. Windows 回归（R01–R04）

| ID | 场景 | 期望结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| R01 | 现有 Windows Node 与 C# 隔离套件 | 原控制、去重、取消、故障语义保持 | not_run | |
| R02 | Windows 安装/回退及旧 `.ps1` 直接入口 | 原功能保留；`npm run install:mod` 新分发器正确传参 | not_run | |
| R03 | Windows 数据根与宿主路径 | 不把已有安装迁移到 Linux 式目录；不轮换既有令牌 | not_run | |
| R04 | Windows 便携验证 / 双入口共用服务 | 包仍独立；Linux 清单变更不破坏 Windows 包验证 | not_run | |

关键命令：

```powershell
npm test; npm run test:mod; npm run test:installer
npm run pack; npm run verify:package
```

## 6. 真实游戏验收（G01–G10）

每组都要求"画面 / 回执 / 日志"三者可对照。验收前请另存一份测试存档。

### G01 标题页、无存档、正常加载 — not_run

1. 只启动 Bridge（不启动游戏），`doctor` 应报 `MOD_NOT_CONNECTED`；
2. 用 SMAPI 启动到标题页：`doctor` 报 Mod 已连接、存档未加载；`stardew_snapshot` 应给 `NO_SAVE_LOADED` 之类的明确错误；
3. `stardew_load` 返回 `accepted` 后**继续观察**：只有 `doctor`/`status` 显示 `saveLoaded=true` 才算完成，不得把 `accepted` 当终态。

### G02 snapshot/inspect/screenshot — not_run

对照画面检查时间、体力、金钱、背包与地图目标引用；`stardew_screenshot` 返回 PNG 非空、尺寸与窗口一致。

### G03 session/select/move — not_run

取得控制、选槽、寻路到目标格；位置变化与收据一致，**不得瞬移**；控制权被第二轮对话抢占时旧会话失效。

### G04 use/interact/menu/closemenu/pause/wait — not_run

工具作用于正确地块；菜单选项来自当前快照；不关闭玩家自己打开的菜单；不跳过剧情。

### G05 container/craft/place — not_run

转移数量、材料消耗、放置位置正确；相同 `actionId` 不重复消费；部分成功如实返回数量。

### G06 shop/buy/ship/eat/equip/recipes — not_run

购买/出售前后金钱与背包可核对；出货收入次日结算，未结算不得计为已获得；装备槽位与体力变化一致。

### G07 fish/combat — not_run

完整钓鱼流程（抛竿→咬钩→小游戏→收获或失败原因）；战斗停手阈值与真实伤害数值。未完成时保持 `not_run`。

### G08 Web 人工接管、F9、第二写者 — not_run

Web 端接管后旧 `epoch` 失效、输入被释放、后续旧请求被拒；F9 停止输入与"实际暂停"分别核对。

### G09 失联/强杀 Bridge/重连 — not_run

强杀 Bridge 后，Mod 在设定看门狗窗口内释放输入并尝试暂停；重启 Bridge 后不重放旧消费动作，旧 `actionId` 回执为不确定。

### G10 睡眠、跨日、保存、退回标题与重载 — not_run

跨日后的日期与变化真实；退回标题后旧引用失效；重新加载前先观察；源存档保持保护（不覆盖非目标存档）。

## 7. 记录方式

每条记录至少包含：

```
ID: I08
结论: pass | fail | blocked
命令: SAB_FAIL_AT=committed scripts/install-mod.mjs --game-path /tmp/game --json
退出码: 1
证据: /tmp/i08-1.json（manifest 版本恢复为 0.0.1）、/tmp/i08-2.log
备注: 失败后 journal 阶段 = committed，retired 目录已放回 Mods/
```

`blocked` 必须写明阻塞原因（缺环境、缺存档、缺权限），不允许用"看起来没问题"替代。
