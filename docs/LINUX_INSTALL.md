# Linux 安装与首次运行

本文件说明 Linux 首版的目标安装流程。当前是**源码预览**：已完成 WSL2 无游戏构建、测试和桥接包验证，尚无通过原生 Linux 游戏验收的完整玩家安装包。完整包解压步骤适用于后续完成验收的构建；目前的 `bridge-only-ci` 包不含 Mod，不应作为完整安装包使用。当前范围是原生 Linux 桌面（Steam 或自带安装器安装的星露谷）。
沙箱打包（Flatpak / Snap / Steam Linux Runtime 容器）不在本版验收范围内，见
[PLATFORM_MATRIX.md](PLATFORM_MATRIX.md)。

> 实际验证范围见 [LINUX_VALIDATION_REPORT.md](../LINUX_VALIDATION_REPORT.md)；后续原生游戏与完整包验收仍按 [LINUX_ACCEPTANCE.md](LINUX_ACCEPTANCE.md) 记录。

## 1. 前置条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 图形界面 | X11 或 Wayland 会话 | 无图形界面时不支持（游戏本身需要窗口） |
| Node.js | **不需要** | 发布包自带 `runtime/node` |
| .NET SDK | **不需要**（仅从源码构建 Mod 时需要 8.x 以上，推荐 10.x） | 发布包已带编译好的 Mod |
| 星露谷 | 1.6.x | 目录中必须有 `Stardew Valley.dll` |
| SMAPI | 4.5.2 或更高 | 必须先用 SMAPI 启动成功一次，生成 `Mods/` 目录 |
| 磁盘 | ≥ 200 MB | 含包内运行时 |

检查游戏与 SMAPI 是否就绪：

```bash
# 把路径换成你的实际安装位置
ls "/home/$USER/.local/share/Steam/steamapps/common/Stardew Valley/Stardew Valley.dll"
ls "/home/$USER/.local/share/Steam/steamapps/common/Stardew Valley/StardewModdingAPI.dll"
```

## 2. 解压发布包

发布包是 `tar.gz`，解压后目录结构固定（不要只复制其中一部分）：

```
StardewAgentBridge-<版本>-linux-x64/
├── bin/stardew-agent-bridge      # 启动入口（使用包内 Node）
├── runtime/node                  # 包内 Node（不要替换成系统 node）
├── server/bridge.mjs             # 常驻 Bridge（单文件，含依赖）
├── server/stdio-adapter.mjs      # 只支持子进程的宿主的 stdio 适配器
├── web/                          # 控制台静态文件
├── mod/StardewAgentBridge.dll    # 游戏 Mod
├── mod/manifest.json
├── scripts/install-mod.mjs       # 安装/升级 Mod（事务化）
├── scripts/rollback-mod.mjs      # 回退/停用 Mod
├── scripts/desktop-entry.mjs     # 菜单入口 / 桌面快捷方式
├── assets/stardew-agent-bridge.svg
├── docs/                         # 本目录的文档
├── manifest.release.json         # 版本、包内 Node、逐文件哈希
└── CHECKSUMS.txt                 # sha256 清单
```

建议解压到用户目录，例如：

```bash
mkdir -p "$HOME/Applications"
tar -xzf StardewAgentBridge-<版本>-linux-x64.tar.gz -C "$HOME/Applications"
```

## 3. 安装 Mod

```bash
"$HOME/Applications/StardewAgentBridge-<版本>-linux-x64/scripts/install-mod.mjs" \
  --game-path "/home/$USER/.local/share/Steam/steamapps/common/Stardew Valley"
```

安装器会：

1. 只读检查游戏目录、SMAPI、`Mods/` 可写性与游戏进程状态（**游戏必须已退出**）；
2. 把新 Mod 暂存到 `<游戏目录>/.stardew-agent-bridge-backups/<事务ID>/` 并校验哈希；
3. 备份现有桥接目录，保留你手改过的未知配置键；
4. 写入绝对路径的 `DataDirectory`（关键：Steam 启动游戏不会继承终端的 `SAB_HOME`）；
5. 原子切换，随后校验；失败则按真实阶段自动放回旧版，并保留现场。

常用参数：

| 参数 | 用途 |
| --- | --- |
| `--game-path <目录>` | 指定游戏目录（Steam 库可自动发现，多份安装时必须显式指定） |
| `--data-dir <绝对路径>` | 指定要写进 Mod 配置的数据根 |
| `--port <端口>` | 写入 Mod 配置的 WebSocket 端口（默认沿用已有值或 17654） |
| `--dry-run` | 只做只读预演，不写任何文件 |
| `--json` | 输出机器可读结果 |

退出码：`0` 成功；`1` 校验失败或已安全回退；`2` 游戏在运行或状态不明；`3` 需要人工恢复。

## 4. 启动 Bridge

```bash
"$HOME/Applications/StardewAgentBridge-<版本>-linux-x64/bin/stardew-agent-bridge" start
```

- 默认只监听 `127.0.0.1:17655`，不对局域网开放；
- 数据根默认 `$XDG_DATA_HOME/StardewAgentBridge`，未设置时 `~/.local/share/StardewAgentBridge`；
- 同一数据根只允许一个实例：重复启动会复用或明确报错（退出码 2），不会并存两个守护进程；
- 想直接打开控制台：`bin/stardew-agent-bridge launch`（会复用已在运行的实例）。

开发/调试时可以用 `--data-dir` 指定隔离的数据根：

```bash
bin/stardew-agent-bridge start --data-dir "$HOME/sab-test"
```

## 5. 创建菜单入口（可选）

```bash
"$HOME/Applications/StardewAgentBridge-<版本>-linux-x64/scripts/desktop-entry.mjs" install
# 需要桌面快捷方式时：
"$HOME/Applications/StardewAgentBridge-<版本>-linux-x64/scripts/desktop-entry.mjs" install --desktop-shortcut
```

入口文件写到 `$XDG_DATA_HOME/applications/stardew-agent-bridge.desktop`，带
`X-SAB-Managed=true` 标记；移除时只会删除带标记的文件：

```bash
scripts/desktop-entry.mjs remove
```

## 6. 把客户端接入

```bash
bin/stardew-agent-bridge hosts --host codex --transport http     # 打印 MCP 配置
bin/stardew-agent-bridge hosts --host claude --transport stdio  # 只支持子进程的宿主
```

HTTP 与 stdio 两个传输共享同一个 Bridge 业务核心（同一控制权、同一账本），
不存在第二套状态。

## 7. 验证安装

```bash
# 只读诊断：不会创建目录、不写凭据、不打开账本
bin/stardew-agent-bridge doctor
```

`doctor` 会报告：Node 版本、`:memory:` SQLite 可用性、数据根与来源、配置与账本状态、
实例锁、Mod 连接与存档状态、`DataDirectory` 是否与 Bridge 数据根一致。

`doctor` 的稳定问题码：`PATH_INVALID`、`NODE_VERSION_UNSUPPORTED`、`SQLITE_UNAVAILABLE`、
`CONFIG_INVALID`、`LEDGER_INVALID`、`DATA_ROOT_MISMATCH`、`INSTANCE_CONFLICT`、
`MOD_NOT_CONNECTED`、`NOT_INITIALIZED`、`LEGACY_DATA_ROOT`。

## 8. 启动游戏

用 **SMAPI** 启动（Steam 里选 SMAPI，或运行游戏目录下的 `StardewModdingAPI`），
加载任意单人存档，然后：

```bash
bin/stardew-agent-bridge doctor   # Mod 连接：已连接；存档：已加载
```

## 9. 升级与回退

```bash
# 升级（重复运行安装器即可；旧版本会进入快照区）
scripts/install-mod.mjs --game-path "<游戏目录>"

# 只停用（旧版本仍保留在快照区，之后可以恢复）
scripts/rollback-mod.mjs --remove-only

# 回退到快照里的旧版本
scripts/rollback-mod.mjs

# 查看历史事务
ls "<游戏目录>/.stardew-agent-bridge-backups/"
```

回退是幂等的：重复执行不会报错，也不会删除已经恢复的目录。如果游戏正在运行、快照被手动改动
或记录被篡改，脚本会拒绝执行并保留现场，退出码为 `2`/`3`。

## 10. 卸载

```bash
# 1) 停用 Mod（不删除快照，便于回退）
scripts/rollback-mod.mjs --remove-only

# 2) 移除菜单入口
scripts/desktop-entry.mjs remove

# 3) 删除程序目录
rm -rf "$HOME/Applications/StardewAgentBridge-<版本>-linux-x64"

# 4) 如确认不再需要本地数据（凭据、账本、截图），自行删除数据根
#    rm -rf "$HOME/.local/share/StardewAgentBridge"
```

本程序从不删除：游戏本体、游戏存档、SMAPI 或其他 Mod。

## 11. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 安装器报 `GAME_RUNNING`（退出码 2） | SMAPI 不支持热加载，先正常退出游戏 |
| 安装器报 `MODS_MISSING` | 从未用 SMAPI 启动过；先启动一次生成 `Mods/` |
| 安装器报 `MODS_NOT_WRITABLE` | 目录权限不足；本程序不会调用 sudo，请自行修正属主 |
| 安装器报 `RECOVERY_REQUIRED`（退出码 3） | 上次事务未完成；先按提示运行回退或查阅 TROUBLESHOOTING |
| `doctor` 报 `DATA_ROOT_MISMATCH` | Mod 配置里的 `DataDirectory` 与当前 Bridge 数据根不一致；用安装器重写或统一 `SAB_HOME` |
| `doctor` 报 `LEGACY_DATA_ROOT` | 发现旧默认目录 `~/AppData/Local/StardewAgentBridge`；本程序不自动合并，需你显式选择 |
| 游戏连不上 Bridge | 确认 Bridge 在运行、Mod 配置端口一致、`DataDirectory` 指向同一目录；日志见数据根下 `logs/bridge.log` |

更多排障步骤见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
