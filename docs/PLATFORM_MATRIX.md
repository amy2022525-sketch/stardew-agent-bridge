# 平台支持矩阵

本表区分源码实现与实际验收。当前发行版为 0.2.0-preview.1，验证见 [RELEASE_VALIDATION_20261029.md](RELEASE_VALIDATION_20261029.md)。Linux/Docker 无游戏验证不能代替真实游戏，MP1 双客户端仍待验收。

## 1. 总览

| 能力 | Windows | Linux（首版） | 说明 |
| --- | --- | --- | --- |
| 常驻 Bridge（本地 HTTP MCP） | 支持 | WSL2 无游戏验证通过 | 只监听 `127.0.0.1` |
| stdio 适配器 | 支持 | WSL2 真实协议往返通过 | 与 HTTP 共享同一业务核心 |
| Web 控制台 | 支持 | API 检查通过；图形交互待验 | 无框架静态页；可配对/复制配置 |
| 29 个 `stardew_*` 工具 | 支持 | 工具发现/模拟契约通过；实际玩法待验 | 新增只读 stardew_multiplayer |
| Mod（SMAPI） | 支持 | 已实现；原生游戏加载待验 | `net6.0`，同一份源码 |
| 数据根解析 | `%LOCALAPPDATA%` | XDG | 见 [LINUX_DEVELOPMENT.md](LINUX_DEVELOPMENT.md) §2 |
| 单实例锁 | 支持 | WSL2 八进程竞争检查通过 | Linux 用 `/proc` 校验启动身份，防 PID 复用 |
| `launch` 复用实例 | 支持 | WSL2 诊断/复用回归通过 | 只读探测，不构造第二个实例 |
| `doctor` 只读诊断 | 支持 | WSL2 实际子进程回归通过 | 不创建目录、不打开账本 |
| Mod 安装事务 + journal | 支持（`.ps1`） | 临时目录安装/恢复 20 项通过 | Linux 侧可按阶段恢复 |
| 回退 / 只停用 | 支持（`.ps1`） | 临时目录恢复/幂等通过 | 幂等 |
| 桌面入口 | 快捷方式 | 文件生成/保护通过；实际点击待验 | Linux 带 `X-SAB-Managed` 标记 |
| 发布包 | `pack.ps1` | 完整包与 bridge-only-ci 分别验证 | 两个独立包，详见当前验证报告 |
| 包内自带运行时 | 无（用系统 Node） | **必须**（`runtime/node`） | 不依赖系统 npm/node |

## 2. Linux 上的明确不在本版范围

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| Flatpak / Snap / Steam Linux Runtime（沙箱） | 不支持 | 路径被重定向、无法稳定定位 `Mods/`；只给出诊断提示 |
| ARM64 / macOS | 不支持 | 发布包只做 `linux-x64` |
| 无图形界面 / 纯 SSH | 不支持 | 游戏本身需要窗口；`launch` 会跳过打开浏览器并说明 |
| 自动写入 sudo 或改系统目录 | 不支持 | 权限不足时报错并给出说明，不静默提权 |
| 结束游戏进程 | 不支持 | 检测到游戏运行时只拒绝操作 |
| 多人 MP1 | 实验性源码实现 | 真人主机 + 独立 farmhand；同 Windows，实机未验收 |
| 自动迁移旧数据根 | 不支持 | 发现旧目录只提示，绝不合并凭据或账本 |

## 3. 文件位置对照

| 内容 | Windows | Linux |
| --- | --- | --- |
| 数据根 | `%LOCALAPPDATA%\StardewAgentBridge` | `$XDG_DATA_HOME/StardewAgentBridge` 或 `~/.local/share/StardewAgentBridge` |
| 凭据 | `<数据根>\credentials.json`（0600 等价） | `<数据根>/credentials.json`（0600） |
| 实例锁 | `<数据根>\bridge.lock` | `<数据根>/bridge.lock`（0600） |
| 端口信息 | `<数据根>\endpoint.json` | `<数据根>/endpoint.json`（0600） |
| 账本 | `<数据根>\ledger.sqlite` | `<数据根>/ledger.sqlite` |
| 日志 | `<数据根>\logs\bridge.log` | `<数据根>/logs/bridge.log` |
| Mod 安装位置 | `<游戏目录>\Mods\StardewAgentBridge` | `<游戏目录>/Mods/StardewAgentBridge` |
| 安装快照 | 同（`.stardew-agent-bridge-backups`） | `<游戏目录>/.stardew-agent-bridge-backups/` |
| 菜单入口 | `.lnk` | `$XDG_DATA_HOME/applications/stardew-agent-bridge.desktop` |

## 4. 环境变量

| 变量 | 作用 | 平台 |
| --- | --- | --- |
| `SAB_HOME` | 指定数据根（Linux 必须绝对） | 两者 |
| `XDG_DATA_HOME` | Linux 默认数据根与菜单入口基目录 | Linux |
| `LOCALAPPDATA` | Windows 默认数据根 | Windows |
| `DISPLAY` / `WAYLAND_DISPLAY` | 决定 `launch` 是否尝试打开浏览器 | Linux |
| `STARDEW_GAME_PATH` | 脚本查找游戏目录的提示 | 两者 |
| `SAB_FAIL_AT` | 仅测试用：在安装事务某阶段注入失败 | Linux 测试 |
| `SAB_TOKEN` / `SAB_URL` / `SAB_CLIENT_ID` | stdio 适配器覆盖令牌/地址/客户端名 | 两者 |

## 5. 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 校验失败或已安全回退 |
| `2` | 端口/实例冲突，或游戏正在运行/状态不明 |
| `3` | Mod 安装事务需要人工恢复 |

## 6. Docker 预览

发布 `linux/amd64` 的 bridge-runtime、game-runtime、mod-build 三个离线镜像及源码/Compose 工具包。Bridge 模式的真实容器、HTTP/stdio MCP 可以独立验证；game-runtime 带 X11/noVNC 图形栈，运行游戏前必须自行提供合法 Linux 游戏与 SMAPI。mod-build 是编译工具，不是游戏服务。容器版当前仅支持单人；MP1 只在原生客户端路径实验。Windows 可经 WSL2/Linux Docker 使用，Windows 容器、ARM64、macOS 游戏与 Steam 登录自动化不在范围。各项实际结果见当前验证报告，安装见 [DOCKER_INSTALL.md](DOCKER_INSTALL.md)。
