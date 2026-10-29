# 0.2.0-preview.1 集成与发布验证

日期：2026-10-29。此文件记录当前版本；旧 `FINAL_TEST_REPORT.md`、`LINUX_VALIDATION_REPORT.md` 与交接报告保留原日期证据。自动化、临时目录与 Mock Mod 检查不等同于真实游戏验收。

## 1. 接手与实现

基线为 `63a4f369feadacf9476660c7af6b1cb9b6ac9a00`。先对 Docker 工作区与 MP1 工作区的全部修改作独立哈希快照，再合并三处重叠文件；保留原多人工作区。版本统一为 0.2.0-preview.1。

补齐 MP1 原生门交互与切图收尾：仅接受普通 Warp/LockedDoorWarp/TouchAction Warp 的严格格式和主机允许的目标；停止输入、释放租约后只观察实际落点，不自动恢复控制。补齐过期主机授权、权限声明、私有政策文件和账本备份日志。

Docker 补齐桌面网关连接关闭、MCP 管理命令的纯 JSON 输出、密码安全随机源、mod-build 的非 root 临时目录、依赖许可证、三镜像检查、Compose 使用说明及自动 CI。Linux/Windows 打包均包含依赖许可与当前安装文档。最终回归发现并修复原实例锁的空目录竞争：先写完 owner 的候选目录，再原子发布整个非空目录；另对 Windows 目录句柄短暂占用作有界重试。并发测试的成功者持续持锁到父进程采样结束，避免定时释放改变竞争窗口，Windows CI 额外连续执行 5 轮锁竞争。

## 2. 本机验证

| 检查 | 结果与边界 |
| --- | --- |
| Windows `npm ci --ignore-scripts` | 通过；锁文件一致，审计 0 漏洞 |
| Windows `npm run build` | 通过；TypeScript、Web 与资源复制 |
| Node 全套最终回归 | Windows 201 项：196 通过、5 项 Linux 桌面入口测试按平台跳过、0 失败；Linux 201/201 通过，无跳过。修复后 Windows CI 另连续 5 轮锁竞争全部通过 |
| Windows `npm run test:mod` | 169 项隔离检查通过；不启动游戏 |
| Linux C# 隔离检查 | 172 项通过，额外覆盖实际 Unix 私有文件权限与符号链接拒绝；使用现有 SDK 8 镜像对临时 net8 测试项目运行相同源码，仓库 net10 测试项目未改。原始 net10 项目另由 GitHub CI 验证 |
| Windows `npm run test:installer` | 17 项通过；仅临时目录 |
| Linux `npm run test:installer` | 20 项通过；仅临时目录与故障注入 |
| 实际 Mod 编译 | 本机合法 1.6.15.24356 游戏程序集 + SMAPI 4.5.2，net6.0，0 警告、0 错误；编译不等同加载验收 |
| 隔离浏览器 | 14 项通过；绑定/API、实时控制、接管、MCP HTTP 配置与 29 工具发现、390px 布局。使用真实 Bridge 与 Mock Mod；Docker 状态按钮部分使用显式合成状态 |
| 原生发布包 | Windows 完整包 15 项、Linux 完整包 19 项独立目录检查通过；真实 HTTP/stdio 往返、29 工具、中文路径、校验和、禁止文件审计；Linux 还验证在无全局 Node 的 PATH 中运行包内 Node |
| Docker Bridge 容器 | 本机先期 29d936a 代码镜像通过 7 项布局/权限检查、13 项实际 Web/HTTP/stdio 接入检查；第二容器共享 QA 数据卷被 flock 拒绝（实际退出码 13）。最终镜像在 e241afa 代码上重新构建；新增修改为 Windows 锁分支与打包/CI，Linux 接入业务未改变 |
| Docker 备份恢复 | 新建 QA 卷上 7 项通过：离线备份、哈希校验、恢复、内容一致、篡改备份 verify/restore 均拒绝（退出码 17）、拒绝后内容未变；QA 卷保留 |
| Docker 图形/工具镜像 | e241afa 的三镜像 [发行构建](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions/runs/40826068042) 通过。mod-build 本机以 UID 1000、只读根、禁用网络、临时输出目录再次编译当前 Mod 成功（0 警告/错误，引用本机 Windows 程序集，仅编译验证）；缺输入实际退出 11。本机 game-runtime 依赖下载过慢，停止该次下载，改由 GitHub 构建发行镜像 |
| 实际 Linux/noVNC 浏览器 | [最终发行附件 CI](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions/runs/40826068042) 在将要上传的 game-runtime 同一个镜像上执行 8 项通过：noVNC HTML、HTTP Origin、WebSocket 跨源及缺 Origin 拒绝、真实 RFB 握手、仅密码认证、Chrome 密码登录并渲染 Xvfb/Openbox、无 JS 错误。没有启动游戏；与 G 组分开 |
| GitHub CI | 最终代码 e241afa 的 [Bridge checks](https://github.com/amy2022525-sketch/stardew-agent-bridge/actions/runs/40826015023) 成功，含双平台原始 net10 C# 测试及 Windows 5 轮并发锁回归；此前 Windows 失败记录保留，修复后才准许发布。三镜像与实际浏览器由上列发行构建验证，来源 SHA 与工具 SHA 分别记录在 `DockerImage-*.json` |

Linux 环境为 Ubuntu 24.04 WSL2，Node 22.13.0；源码在 ext4 中以 UID 1000 运行测试。官方 Node 运行时归档 SHA-256：`3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6`。正式 Linux 包禁止使用 `--allow-unverified-runtime`。

## 3. 发行范围

GitHub 此前没有标签/Release，因此本次建立一个统一预览版，不补造未曾存在的历史版本。下载项包括 Windows 完整包、Linux x64 完整包、独立 Mod、Docker 源码/Compose 工具包和 bridge-runtime / game-runtime / mod-build 三个 linux/amd64 离线镜像；另附 3 份 `DockerImage-*.json` 来源证明、外层 SHA256SUMS 与发布清单，合计 12 个附件。Windows 使用系统 Node >=22.13；Linux 自带 Node。

镜像/包不包含游戏 DLL、Steam/SMAPI 安装文件、玩家存档、真实凭据或现有数据卷。源码归档不包括 node_modules、构建缓存和私人配置。最终镜像代码为 `e241afacf44176827e368cf7af5b6e0d7b4b6cf4`，其后仅更新验证/安装文档；发行源码提交和镜像来源同时记录在清单。Linux 完整包可由手动 CI 从同版、已校验 SHA 的独立 Mod ZIP 复用本项目程序集，并下载/校验官方 Node 后执行完整包的 19 项验证；不上传游戏引用。Windows `SkipMod` 也只跳过重新编译，仍必须带入匹配版本的已编译 Mod。发行页直接附完整镜像，不要求用户从 Actions 下载过期工件，也不要求镜像仓库登录。

## 4. 仍未验收

- 原生 Linux 游戏启动、Mod 实际加载、桌面入口点击和 G01–G10 实际游玩：`not_run`。
- Docker game-runtime 的真实 Linux 游戏、SMAPI、存档加载、动作与安全退出：`not_run`；图形栈检查不能代替游戏验收。
- MP1 两个真实游戏客户端、真人主机授权与 farmhand 完整 H01–H11：`not_run`。
- 钓鱼/战斗完整闭环、跨日/事务故障全矩阵、各宿主完整真实短任务和长期连续游玩：未补测，沿用原报告边界。

以上不妨碍公开可复现的预览包，但不满足稳定版门槛。后续按 [LINUX_ACCEPTANCE.md](LINUX_ACCEPTANCE.md)、[DOCKER_ACCEPTANCE.md](DOCKER_ACCEPTANCE.md)、[MULTIPLAYER_ACCEPTANCE.md](MULTIPLAYER_ACCEPTANCE.md) 追加实机结果，不覆盖历史记录。
