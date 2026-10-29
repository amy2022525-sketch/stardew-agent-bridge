# 0.2.0-preview.1 集成与发布验证

日期：2026-10-29。此文件记录当前版本；旧 `FINAL_TEST_REPORT.md`、`LINUX_VALIDATION_REPORT.md` 与交接报告保留原日期证据。自动化、临时目录与 Mock Mod 检查不等同于真实游戏验收。

## 1. 接手与实现

基线为 `63a4f369feadacf9476660c7af6b1cb9b6ac9a00`。先对 Docker 工作区与 MP1 工作区的全部修改作独立哈希快照，再合并三处重叠文件；保留原多人工作区。版本统一为 0.2.0-preview.1。

补齐 MP1 原生门交互与切图收尾：仅接受普通 Warp/LockedDoorWarp/TouchAction Warp 的严格格式和主机允许的目标；停止输入、释放租约后只观察实际落点，不自动恢复控制。补齐过期主机授权、权限声明、私有政策文件和账本备份日志。

Docker 补齐桌面网关连接关闭、MCP 管理命令的纯 JSON 输出、密码安全随机源、mod-build 的非 root 临时目录、依赖许可证、三镜像检查、Compose 使用说明及自动 CI。Linux/Windows 打包均包含依赖许可与当前安装文档。最终回归发现并修复原实例锁的空目录竞争：先写完 owner 的候选目录，再原子发布整个非空目录，避免多个进程同时接管死亡 owner。

## 2. 本机验证

| 检查 | 结果与边界 |
| --- | --- |
| Windows `npm ci --ignore-scripts` | 通过；锁文件一致，审计 0 漏洞 |
| Windows `npm run build` | 通过；TypeScript、Web 与资源复制 |
| Node 全套最终回归 | Windows 201 项：196 通过、5 项 Linux 桌面入口测试按平台跳过、0 失败；Linux 201/201 通过，无跳过 |
| Windows `npm run test:mod` | 169 项隔离检查通过；不启动游戏 |
| Linux C# 隔离检查 | 172 项通过，额外覆盖实际 Unix 私有文件权限与符号链接拒绝；使用现有 SDK 8 镜像对临时 net8 测试项目运行相同源码，仓库 net10 测试项目未改。原始 net10 项目另由 GitHub CI 验证 |
| Windows `npm run test:installer` | 17 项通过；仅临时目录 |
| Linux `npm run test:installer` | 20 项通过；仅临时目录与故障注入 |
| 实际 Mod 编译 | 本机合法 1.6.15.24356 游戏程序集 + SMAPI 4.5.2，net6.0，0 警告、0 错误；编译不等同加载验收 |
| 隔离浏览器 | 14 项通过；绑定/API、实时控制、接管、MCP HTTP 配置与 29 工具发现、390px 布局。使用真实 Bridge 与 Mock Mod；Docker 状态按钮部分使用显式合成状态 |
| 原生发布包 | 收尾制作与校验中；发布前更新 |
| Docker 实际镜像/容器 | 收尾重新构建与验证中；发布前更新 |
| GitHub CI | 待推送当前提交后核验，不能沿用旧 SHA 的成功结果 |

Linux 环境为 Ubuntu 24.04 WSL2，Node 22.13.0；源码在 ext4 中以 UID 1000 运行测试。官方 Node 运行时归档 SHA-256：`3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6`。正式 Linux 包禁止使用 `--allow-unverified-runtime`。

## 3. 发行范围

GitHub 此前没有标签/Release，因此本次建立一个统一预览版，不补造未曾存在的历史版本。下载项包括 Windows 完整包、Linux x64 完整包、独立 Mod、Docker 源码/Compose 工具包和 bridge-runtime / game-runtime / mod-build 三个 linux/amd64 离线镜像；另附外层 SHA256SUMS 与发布清单。Windows 使用系统 Node >=22.13；Linux 自带 Node。

镜像/包不包含游戏 DLL、Steam/SMAPI 安装文件、玩家存档、真实凭据或现有数据卷。源码归档不包括 node_modules、构建缓存和私人配置。镜像的构建来源与摘要记录在发行清单中；如其后只有验证文档提交，镜像仍引用实际构建代码提交。

## 4. 仍未验收

- 原生 Linux 游戏启动、Mod 实际加载、桌面入口点击和 G01–G10 实际游玩：`not_run`。
- Docker game-runtime 的真实 Linux 游戏、SMAPI、存档加载、动作与安全退出：`not_run`；图形栈检查不能代替游戏验收。
- MP1 两个真实游戏客户端、真人主机授权与 farmhand 完整 H01–H11：`not_run`。
- 钓鱼/战斗完整闭环、跨日/事务故障全矩阵、各宿主完整真实短任务和长期连续游玩：未补测，沿用原报告边界。

以上不妨碍公开可复现的预览包，但不满足稳定版门槛。后续按 [LINUX_ACCEPTANCE.md](LINUX_ACCEPTANCE.md)、[DOCKER_ACCEPTANCE.md](DOCKER_ACCEPTANCE.md)、[MULTIPLAYER_ACCEPTANCE.md](MULTIPLAYER_ACCEPTANCE.md) 追加实机结果，不覆盖历史记录。
