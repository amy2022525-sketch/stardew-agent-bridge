# Linux 首轮验证报告

日期：2026-10-24（北京时间）。执行者：原协作者 Codex。

**结论：跨平台源码构建与首轮自动化已有真实通过结果；原生 Linux 游戏支持尚未完成验收；本次按用户要求同步源码预览，暂不发布已验收的 Linux 完整安装包。** 本报告更新编写交付后的实际状态，原 `LINUX_HANDOVER_REPORT.md` 保留为交付历史。

## 1. 环境与保护

- 源仓库：本地工作副本；基线 `e43691f858f3372eb1c16d55f54b21056b552904`。
- Windows：Node 22.23.1、.NET SDK 10.0.302；真实游戏程序集为 Stardew Valley 1.6.15.24356，仅用于编译项目 Mod。
- Linux：Ubuntu 24.04.1 / WSL2 / x64，测试以普通用户（非 root）执行；源码、HOME、凭据及运行时位于专用隔离目录。WSL 结果不记为原生 Linux 游戏结果。
- Linux Node：22.13.0。官方归档 `node-v22.13.0-linux-x64.tar.xz` 已与官方 SHASUMS256 校对；SHA-256 为 `3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6`。
- 测试前已保存全部源码快照、原始差异和变更文件哈希：维护者私有验证目录的 `source-snapshot/`。
- 没有安装本轮 Mod 到真实游戏，没有启动游戏或操作玩家存档，没有改动已安装 DSH/Bridge 配置，验证阶段未推送；本次源码同步单独按用户授权进行。

## 2. 已执行结果

| 检查 | 实际结果 | 证据文件 |
| --- | --- | --- |
| Windows npm ci | 通过 | windows-npm-ci.log |
| Windows build / Web 类型检查（发布前最终源码） | 通过 | windows-build.log |
| Windows Node 回归（发布前最终源码） | 136 项：131 通过，5 项 Linux 专属跳过，0 失败 | windows-node-tests.log |
| Ubuntu npm ci | 通过 | linux-npm-ci.log / .json |
| Ubuntu build / Web 类型检查 | 修复入口后通过 | linux-build.log / .json |
| Ubuntu Node 测试 | 136 项全部通过，0 跳过；含后来新增的菜单文件保护用例 | linux-node-tests.log / .json |
| Windows 安装/回退 | 17 项通过，仅临时目录 | windows-installer-tests.log |
| Ubuntu 安装/恢复 | 修复后 20 项通过；含故障、进程中断、路径逃逸与重复回退 | linux-installer-tests.log / .json |
| Windows C# 隔离检查 | 77 条断言通过，包含 19 条 Mod 路径契约向量 | windows-mod-tests-first.log |
| Windows 真实 Mod 编译 | 通过，0 警告、0 错误；仅生成本项目 DLL 与 manifest | windows-build-mod.log |
| Windows 完整包验证 | 25 文件、24 校验项，仓库外 14 项检查通过 | windows-pack.log |
| Linux bridge-only-ci 目录包 | 成功生成，内含经过执行验证的 Node 22.13.0，不含 Mod | linux-pack.log / .json |
| Linux 包仓库外验证 | 19 项通过；包内 Node、空 PATH、中文路径、HTTP/stdio、28 工具与 SIGTERM 清理 | linux-package-verification.log / .json |
| package-lock 规范化 | 已用 npm 官方命令重生成/确认，未手写 integrity | windows-lockfile-canonicalization.log |
| git diff --check | 通过 | 本轮命令退出码 0 |
| GitHub Actions Windows（提交 b6d682a） | 构建通过；Node 131 通过 / 5 跳过；C# 77、安装 17 通过 | [Windows job](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions/runs/40061667447/job/120776305070) |
| GitHub Actions Ubuntu 24.04（提交 b6d682a） | 构建通过；Node 136、C# 77、安装 20 通过 | [Linux job](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions/runs/40061667447/job/120776305214) |
| GitHub Actions Linux bridge-only（提交 b6d682a） | 最新源码重打包，19 项仓库外验证通过；未上传二进制 | 同上 Linux job |

原始日志和源码快照保存在维护者私有验证目录，不上传凭据、游戏数据或本机配置。本次提交的远端运行结果可在 [GitHub Actions](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions) 查看。Windows 在发布前已对最终源码重新构建并运行全部 136 项 Node 测试；跳过的 5 项为 Linux 专属用例，Ubuntu 的完整运行包含这些用例。

Linux 包的 19 项验证包含：真实 SDK 握手、工具发现、认证状态读取、无游戏 snapshot 返回 GAME_UNAVAILABLE、Web 两种 MCP 自检；关闭 stdio 适配器后共享 Bridge 仍可用；SIGTERM 后删除本实例的锁、owner 目录和 endpoint，保留账本。它不证明真实游戏动作或外部 Agent 已接入。

## 3. 本轮修复

1. 修复首轮构建的 5 处 TypeScript 错误：锁句柄释放、两种时钟依赖类型混用及测试辅助函数名。
2. Mod 配置比较按目标平台规范化，处理末尾分隔符和 Windows 大小写/盘符；Steam 发现支持显式平台，测试不再误读本机真实 Steam 安装；修正缺失字段的夹具。
3. CLI 在持锁后先绑定目标端口，再构造 Bridge 和打开账本。新增实际子进程测试，确认诊断、复用和端口冲突不关闭活动会话、不改写收据或凭据。
4. 健康复用核对数据根、PID 与可用的启动身份，拒绝把其他服务的 ok=true 当作当前实例。
5. 锁以原子 owner 目录串行化首次发布和陈旧接管，诊断记录原子写入；未写完的锁保留宽限。两个八进程竞争用例通过。
6. `launch --json` 的提示改写 stderr，stdout 保持可解析 JSON。
7. 构建及 Linux 打包改用 esbuild API，避免在 Linux 上把 ELF 二进制当 JavaScript 运行。
8. 包验证器保留执行位、核对 manifest 文件模式、使用包内 Node，并用不含系统 node 的 PATH 验证独立运行；源码引用检查不再误把打包器内部模块名称当成未打包依赖。
9. Linux 打包拒绝清理不属于本项目的非空输出目录；最低 Node 版本检查使用完整版本号，禁止完整包使用 allow-unverified-runtime。
10. 安装器检查 Mods、备份根及路径中间组件的符号链接；回退检查事务 ID 和 journal 归属，阻止越界路径。
11. 修复 prepared 阶段失败误移走旧 Mod；区分旧目标与新提交目标。补充 prepared / retired_old / committed 进程中断恢复，未完成事务阻止下一次安装。
12. 重复回退直接保持现状，不再重新移动已恢复的旧版本；安装记录使用原子写入。
13. 桌面入口保留不属于本项目的同名菜单/桌面文件。
14. Windows 打包的 SHA-256 计算改用 .NET，在本机缺少 Get-FileHash 的子 PowerShell 环境仍可工作，随后完整包验证通过。

测试中的游戏目录和 DLL 均明确为临时 fixture；真实 Mod 编译的 DLL 不等于 Linux 游戏加载通过。

## 4. 未完成项与产物限制

- **Linux C# 隔离检查已由 Ubuntu CI 补齐。** 本机 WSL 获取 .NET SDK 10.0.302 失败、未完成安装；随后 GitHub Actions 使用 Linux .NET SDK 10.0.402 执行 77 项检查全部通过。这些检查不加载真实游戏程序集，不代表 Mod 的 Linux 游戏加载验收。
- **Linux 图形浏览器、菜单实际点击、剪贴板与下载交互尚未验收。** 当前通过的是协议/API 和自动化目录行为；未将 HTTP 200 当作 UI 验收。
- **G01–G10 全部未进行原生 Linux 游戏验收。** 未宣称截图、正常玩法、看门狗、跨日保存或持续游玩已通过。
- **真实 Linux Agent 客户端短任务未执行。** 本次源码推送已触发 GitHub Actions，Windows/Ubuntu 两个 job 均通过；该结果覆盖自动化检查。真实 MCP SDK 与具体 DSH/Codex/Claude Code 宿主分别记录。
- **归档与最终包需要继续处理。** Linux bridge-only-ci 目录包不是面向玩家的完整发行版，没有生成和复验最终 tar.gz。本机此前目录包早于最后一轮安装恢复修复，不可分发；CI 已依据最新源码重打包并通过 19 项检查，但发行前仍须对包内安装器执行完整隔离场景、生成最终归档并复验。
- Windows 最终源码的 build 与 136 项 Node 回归已在本次上传前重跑通过；当前 Windows 完整包的验证结果对应此前记录的构建时间点，发布新二进制包前仍须重新打包验证。
- 全部测试编号仍须按完整预期逐条核对；本报告的套件通过不自动把所有 60 个验收编号改为 pass。未覆盖的权限不足、跨设备/空间不足、真实令牌轮换等分支仍保留待验收。

## 5. 接手顺序

1. Windows 最新源码的 build/test 已完成：136 项、131 通过、5 项 Linux 专属跳过；后续若修改代码，重跑受影响的检查。
2. 在 Ubuntu 隔离目录重新打 Linux bridge-only-ci 包，对包内安装器运行同样的 20 项场景，再生成 tar.gz、解压到仓库外并复验。
3. Linux test:mod 已由 Ubuntu CI 补齐；后续更改 C# 时重跑该检查，不为适配升级 Mod 的 net6.0 目标。
4. 验证真实浏览器和桌面入口；当前源码的浏览器失败处理仍需覆盖子进程非零退出场景。
5. 在具备原生 Linux Steam/SMAPI 的图形桌面和 QA 存档上，执行 G01–G10 及真实 Agent 短任务。
6. 本次源码预览可按用户授权先行上传；完整 Linux 安装包和稳定版发布仍须补齐平台矩阵、最终交付报告与原生游戏验收。

本报告没有将后续工作标记为完成，也没有发布 Linux 支持公告。
