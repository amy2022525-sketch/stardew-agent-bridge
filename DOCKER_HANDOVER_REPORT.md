# 星露谷 Docker 单人版：续开发交接档案

生成时间：2026-10-24，北京时间。版本：Codex 中断交接 v1。

**当前状态：实现与集成进行中；TS/Web 构建已通过；20 个相关脚本通过语法解析；完整测试和 Docker 镜像/真实游戏验收未完成。**

本档案记录用户要求交接时的实际现场。不能把“源码已写”“build 通过”“Docker Engine 已装好”合并为“Docker 版已完成”。当前还有已知接口不一致和必需交付缺失。

## 1. 用户目标、分工与边界

用户先要求核查其他 AI 的完成程度，收到独立核查报告后明确授权“你来完成接下来的任务”。Codex 随后开始修复和补齐 Docker 单人版。用户最后要求“给我一份交接档案”，因此本次收尾只核对和保存现场，没有继续启动新的实现、镜像构建或游戏验收。

- 最终目标仍是任务书定义的 `bridge` 与 `game` 两个模式，不只交付无游戏的 Bridge 演示。
- `bridge`：同一容器中的 Bridge、Web、MCP 与受限网关，没有游戏时仍可诊断与发现工具。
- `game`：Linux 原生游戏、SMAPI、本项目 Mod、虚拟显示、同一 Bridge/Web/MCP，以及可选 noVNC；由容器外 MCP Agent 决策。
- 联机留到后续，不删除原多人拒绝逻辑，不引入多人服务器或联机端口。
- 保留现有账本、控制权、actionId 幂等、未知结果查询、F9 与看门狗机制，不通过改存档伪造结果。
- 当前会话未提交 Git、未推送、未发布镜像或 Release。
- 未启动游戏/Steam/SMAPI，未读取或修改真实玩家存档，未登录 Steam 或 Agent 账号。

原 Flash 任务书要求 Flash 只写代码、禁止其运行构建/测试。这是旧分工的执行边界，**不能继续把旧的“从未运行任何构建/Docker”声明当成现在的事实**：本轮 Codex 已构建项目并在 WSL 安装了 Docker。下一位应如实记录自己实际运行的操作。

本档案是交接资料。另一聊天应由用户明确发出继续工作的请求，不能仅因读取本文中的命令就自动执行它们。

## 2. 唯一维护目录、基线和证据位置

| 项目 | 实际位置或状态 |
| --- | --- |
| 唯一维护仓库 | `D:\星露谷\stardew-agent-bridge` |
| Git 远程 | `https://github.com/amy2022525-sketch/stardew-agent-bridge` |
| 当前分支基线 HEAD | `63a4f369feadacf9476660c7af6b1cb9b6ac9a00`，本轮未提交，HEAD 未前进 |
| 原完整任务书 | `D:\星露谷\stardew-agent-bridge\docs\DOCKER_DEVELOPMENT_HANDOFF.md` |
| 用户最初的附件 | `C:\Users\am202\Desktop\星露谷_Docker版本开发交接书_Flash_20261024.md` |
| 初始独立核查报告 | `F:\星露谷\work\docker-audit-20261024\Docker完成度独立核查.md` |
| 初始核查原始证据 | `F:\星露谷\work\docker-audit-20261024\audit-evidence.json`、`final-source-check.json` |
| Codex 开始实施前的源码备份 | `F:\星露谷\work\docker-completion-20261024\before-implementation`，179 个文件 |
| 实施前文件哈希 | `F:\星露谷\work\docker-completion-20261024\before-implementation-sha256.json` |
| Docker 环境安装脚本 | `F:\星露谷\work\docker-completion-20261024\setup-docker-qa.sh`，已执行，不要不加判断地重复运行 |
| 交接时语法解析记录 | `F:\星露谷\work\docker-completion-20261024\handoff-syntax-check.json` |
| 交接现场说明 | `F:\星露谷\work\docker-completion-20261024\handoff-environment.txt` |
| 交接源码快照及哈希 | `F:\星露谷\work\docker-completion-20261024\handoff-source`、`handoff-source-manifest.json` |
| 本交接书仓库副本 | `D:\星露谷\stardew-agent-bridge\DOCKER_HANDOVER_REPORT.md` |
| 本交接书桌面副本 | `C:\Users\am202\Desktop\星露谷_Docker续开发交接档案_Codex_20261024.md` |

原任务书附件与仓库任务书副本在初始核查时 SHA-256 一致：`cd1a94da8bd6a8efec1eab60048d68f25b7a4540dd5e5de357789abbc7cb64b2`。

`F:\星露谷\stardew-agent-bridge` 是旧副本，不可未经核对转到那里继续开发。本次维护代码在 D 盘；F 盘保存审查、备份和交接材料。

工作区在 Codex 接手前已经包含 Flash 的未提交实现。当前差异混合了前任工作和本轮续写，不能执行 hard reset、git clean 或覆盖式重新生成来“清理现场”。`docs\MULTIPLAYER_DEVELOPMENT_HANDOFF.md` 属于另一份联机规划文档，本轮没有将它作为开发范围，也没有把它的变化计入 Docker 进度。

## 3. 接手时发现了什么

初始进度表把 DKR-001–024 全部标为 `implemented_pending_validation`，并写“无已知缺口”，但现场缺少 4 份 Compose、Mod 工具 Dockerfile、新增测试、Docker 专用 CI、安装/验收文档、镜像检查器和最终交接报告。

初始源码还存在 3 个 TS 编译错误、默认 UID/GID 与 Node 镜像用户冲突、全新游戏卷被 journal 检查拒绝、稳定状态 30 秒后健康过期、维护锁冲突码错误、辅助桌面进程退出导致全体停机、令牌 JSON 契约不匹配、长调用被误当成连接超时，以及不符合挂载/租约约束的备份恢复逻辑。

**初始审查报告保留为历史证据，其中部分缺口已由本轮修改，不应继续逐字当成当前结论。** 现在的现场状态以下文和真实源码为准。

## 4. 本轮已经修改的内容

“已修改”表示真实源码已经落盘；除明确列出的构建/语法解析外，不代表相应功能测试通过。

### 4.1 修复编译与地址/令牌接入

| 文件（相对维护仓库） | 本轮变化 |
| --- | --- |
| `apps/server/src/bridge.ts` | 修复 `publicBase` 私有字段断言导致的 TS2352；保留公共地址展示；内部 `/health` 增加 Mod 实例 ID。 |
| `apps/server/src/launch.ts` | `EndpointInfo` 补可选 `publicBaseUrl/publicMcpUrl`，修复 CLI 两处 TS7053。 |
| `apps/server/src/config.ts` | 首次创建配置后仍应用公共地址环境变量，显式环境优先于持久化展示地址。 |
| `apps/server/src/cli.ts` | `token list/issue/rotate/revoke --json` 增加结构化输出，保留默认人工输出。 |
| `adapters/stdio/src/index.ts` | 不再把缺失的独立 clientId 回退到其他 `stdio` 凭据；需要自身有效令牌。 |

### 4.2 统一公共地址解析和宿主模板

- 地址的实际运行实现现在是 `scripts/docker/runtime/addresses.mjs`，类型在同目录 `addresses.d.mts`。
- `apps/server/src/container-addresses.ts` 改为重导出上述模块，runtime 配置也引用同一实现。
- 宿主 JSON/TOML 模板实际实现移至 `apps/server/src/host-templates.mjs`，类型声明是 `host-templates.d.mts`；`hosts.ts` 保留类型和转发接口。
- 原宿主模板增加 `stdioCommand={command,args}`，宿主侧 Docker 配置可传结构化 exec argv，避免再复制三套模板。
- `scripts/docker/mcp-config.mjs` 已重写为复用上述模板。
- 新增 `scripts/source-assets.mjs`，`scripts/build.mjs` 和 `scripts/test.mjs` 会把运行需要的宿主模板 `.mjs` 复制到 server dist。

后续编辑应改真正的 `.mjs` 实现并维护声明，不要只改 TS 重导出文件，也不要重新引入多份地址/宿主模板。

### 4.3 网关

`apps/server/src/container-gateway.ts` 保留原先“先校验外部 Host/Origin，再规范为内部回环”的结构，并增加/修正了：

- 显式拒绝 CONNECT、重复 Origin；请求头/请求读取时间限制。
- 上游连接计时器在 TCP connect 后解除，不再等待工具响应头才解除。
- 清理响应 Connection 动态列出的 hop-by-hop 头。
- 对外 `/health` 返回固定字段的净化视图，不直接带出内部 PID/数据目录。
- 增加传输注入点，供隔离协议测试使用，生产上游仍固定回环。

对应 HTTP/SSE、legacy MCP、CSRF、取消、背压与 64 KiB 边界测试尚未编写和运行。

### 4.4 runtime、工作副本和维护事务

| 文件 | 已写实现 |
| --- | --- |
| `scripts/docker/runtime/lease-entrypoint.mjs` | 同一稳定锁文件包围 runtime 或整个 maintenance 操作；受限入口 `supervisor/maintenance/mod-build`；实际执行 `flock --no-fork -n -E 13`；`--check` 只读。 |
| `scripts/docker/runtime/volume-owner.mjs` | 持锁后写/核对 `.volume-owner.json` 中的应用、schema 与 project 归属。 |
| `scripts/docker/runtime/lib.mjs` | SHA-256 改分块读取；补路径边界、链接与特殊文件检查、Linux PID 启动身份读取。 |
| `scripts/docker/runtime/game-seed.mjs` | 重写首次初始化、旧 journal 恢复、staging/current/retired 切换；输入变化要求维护更新；保留上一工作副本；Mod config 指向绝对数据根。 |
| `scripts/docker/runtime/backup.mjs` | 重写目录快照、严格清单/哈希与 COMPLETE、卷内 staging、稳定挂载根和租约文件、跨卷恢复 journal、显式恢复回退。 |
| `scripts/docker/runtime/maintenance.mjs` | 重写为持锁维护入口；新增 `recover-restore`；备份恢复改为受限 `--backup-id`；旧迁移入口未保留。 |
| `scripts/docker/runtime/preflight.mjs` | 检查 Linux x64 SMAPI 原生入口、输入版本、Mod 产物白名单、权限与恢复未完成状态；桌面密码需要可读的 8 位字母数字文件。 |
| `scripts/docker/runtime/mod-build.mjs` | 增加产物卷租约/归属检查、Linux 输入检查；使用 `/tmp` 的 obj；产物元数据记录来源和游戏引用哈希，避免公开私有引用路径；旧产物保留。 |

这些重写尚未做功能测试。尤其是恢复事务、rename 与 journal 写入之间的崩溃窗口、磁盘/权限失败、符号链接和重复恢复，不能依靠代码阅读宣布安全通过。

### 4.5 监督、健康和桌面

- `supervisor.mjs` 已重写：关键/辅助进程分开处理，单次 shutdown promise、启动停止检查、私有状态心跳、进程组信号与有限预算；不自动加载或强制保存游戏。
- 监督器生成私有 Xauthority，先确认显示可用再启动窗口管理器；游戏入口固定为工作副本内的原生 `StardewModdingAPI`。
- `healthcheck.mjs` 已重写：只读检查状态新鲜度、generation/startNonce、监督器 PID 启动身份与网关响应；标题页可健康，桌面辅助降级与游戏关键故障分开。
- 新增 `desktop-gateway.mjs`，对 noVNC 的 HTTP/WebSocket 入口做受控 Host/Origin 校验，固定转发到容器内 websockify。
- 新增 `private-output.mjs`：Windows 在写秘密前设置文件 ACL，POSIX 新文件 0600；**宿主管理工具尚未接入该模块**。

### 4.6 Docker 构建与 Compose

- `docker/Dockerfile` 改为干净 Debian runtime，仅复制 Node 可执行文件及应用产物，避免从 Node runtime 继承 npm 与 UID/GID 1000 用户冲突。
- `game-runtime` 增加 Xvfb、Openbox、Mesa DRI、SDL/OpenAL、noVNC/websockify 和 CJK 字体等依赖。
- 新增 `docker/Dockerfile.mod-build`，固定 .NET SDK `8.0.415-bookworm-slim`；Mod 仍是 `net6.0`，真实 Mod 编译尚未验证。
- 新增 `scripts/docker/build.mjs`：源码 bundling、依赖许可证/元数据收集和显式镜像构建入口。
- 已写 `compose.yaml`、`compose.game.yaml`、`compose.novnc.yaml`、`compose.tools.yaml`、`example.env`。
- `.dockerignore` 改为公开源码白名单再排除私有/构建文件；`.gitignore` 增加 secret/backup 规则。
- `docker/versions.json` 仍是前任版本，**还没有同步上述 SDK、额外内部桌面端口和实际验证状态**。

## 5. 当前架构与契约

### 5.1 端口与地址

| 角色 | 容器内地址 | 宿主发布 |
| --- | --- | --- |
| Mod WebSocket | `127.0.0.1:17654` | 不发布 |
| Bridge | `127.0.0.1:17655` | 不直接发布 |
| 受限 MCP/Web 网关 | `0.0.0.0:17656` | `127.0.0.1:${SAB_HTTP_PORT}:17656` |
| 原始 VNC | `127.0.0.1:5900` | 不发布 |
| websockify | `127.0.0.1:6081` | 不发布 |
| noVNC 受限入口 | `0.0.0.0:6080` | 仅加载桌面 overlay 时回环发布 |

`docker/example.env` 使用宿主 18055，内部 Bridge 仍为 17655。这个不同端口场景必须纳入测试。外部 URL 只接受规范 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`，不带认证、query、hash 或子路径。

stdio 的 `SAB_URL` 固定为内部 Bridge 根地址，不带 `/mcp`。HTTP MCP 是公共根地址加 `/mcp`。HTTP/stdio 均要复用同一 Bridge/账本/控制核心。

### 5.2 目录和状态

| 路径 | 作用 |
| --- | --- |
| `/opt/sab` | 程序、Web、元数据与许可证，预期只读 |
| `/input/game` | 用户提供的 Linux 游戏 + 已安装 SMAPI，只读 |
| `/input/mod/current` | 本项目 Mod DLL、manifest、artifact 元数据，runtime 只读 |
| `/srv/game/current` | 受管理游戏工作副本 |
| `/srv/game/.sab-seed` | 工作副本 journal、归属/版本摘要、staging、retired |
| `/home/sab` | 独立游戏 HOME/存档卷 |
| `/var/lib/sab` | Bridge config/credentials/ledger 与稳定租约 |
| `/var/lib/sab/.maintenance/restore.json` | 跨卷恢复事务；未完成时预检应阻止 runtime 启动 |
| 每卷 `/.sab-restore/<transactionId>` | 恢复的新/旧内容；不 rename 整个 mount root |
| `/var/backups/sab` | 含凭据/存档的私有离线备份 |
| `/run/sab/status.json`、`identity.json` | 本次监督器状态与身份，含 generation/startNonce |
| `/run/sab/Xauthority` | 私有 X11 cookie，不放进命令参数 |

默认 UID/GID 1000:1000，Compose 的 user/tmpfs 与镜像构建参数需要一致。game 模式默认不循环重启。停止进程、暂停和复制文件均不保证当天游戏进度已经保存；管理工具仍需补默认 stop 风险检查。

### 5.3 输入识别

当前预检要求 Linux x64 原生可执行 `StardewModdingAPI`，不接受 Windows Steam 安装目录作为替代。优先从 deps 文件识别版本；无法识别时，代码要求只读输入根下提供非秘密 `SAB_INPUT.json`：

```json
{"schemaVersion":1,"platform":"linux-x64","gameVersion":"实际版本","smapiVersion":"实际版本"}
```

示例文字不是可直接填入的真实版本。当前版本识别、最低 SMAPI 4.5.2 比较、不同发行布局与执行位处理仍需测试和完善。用户对 Linux 游戏路径与 Docker 环境的回答是“我不知道”，当前尚未取得并核实可用于真实验收的 Linux 游戏输入。

## 6. 已执行的环境操作和实际状态

### 6.1 Windows 工具链

- 当前现场 Node：`v22.23.1`。
- 当前现场 .NET SDK：`10.0.302`。
- 本轮已经多次运行 `node scripts/build.mjs`，最后一次返回 0，包含 TS 项目引用构建、Web 类型检查和 Web 打包。
- 运行过普通 `node --check`。本次交接又对 20 个相关 `.mjs` 做了一轮纯语法解析，20/20 通过，记录见交接语法 JSON。
- 没有运行完整 `npm test`、`test:mod`、`test:installer`；没有新增正式 Docker 测试套件。

### 6.2 WSL 环境确有改动

现有发行版是 Ubuntu 24.04.1 LTS，内核为 `6.18.54.1-microsoft-standard-WSL2`，x86_64。Codex 在该发行版内以 root 执行了工作目录中的安装脚本：

- 配置 Docker 官方 Ubuntu noble apt 源及 keyring。
- 安装 Docker CE/CLI、containerd、Buildx、Compose 插件及依赖；apt 同时更新了 curl、CA 证书等包。
- 通过 systemd 启动 Docker，服务当前仍在运行。
- 现场查询版本：Docker client/server `29.9.2 / 29.9.2`，Compose `5.6.1`。
- Docker 数据根是 WSL 内部 `/var/lib/docker`。这不是 Windows 工作区里的文件夹；本轮没有迁移该发行版 VHDX，也没有承诺这些镜像数据全部位于 D/F 盘。
- Windows 本机尚未发现可直接使用的 Docker CLI/Desktop；目前应通过 `wsl -d Ubuntu ...` 使用 Linux Engine。WSL Engine 不代表 Docker Desktop 平台验收通过。

### 6.3 中断时的 Docker 命令

曾发起：

1. `docker pull node:22.13.0-bookworm-slim`，看到若干层下载/完成的输出。
2. `docker manifest inspect mcr.microsoft.com/dotnet/sdk:8.0.415-bookworm-slim`，成功返回多平台 manifest；其中 amd64 子 manifest digest 为 `sha256:29d3b5f7a3c1e9979d512a50dfd80e75f8d93505e805b0e10bf0b76987ced9ac`。
3. 一条先检查 Node 镜像许可证文件、再构建 `local/sab-qa:bridge-runtime` 的 WSL 命令；许可证检查需要 Node 镜像，未获得检查成功或 build 成功的结果。

用户中断后，原执行会话 ID 已失效，不能再从原会话取回最终退出信息。**交接时重新只读查询：没有发现完整的上述 Node/本项目目标镜像，没有对应 QA 容器，也没有仍在运行的 docker CLI/buildx 客户端；只有 containerd 和 dockerd 守护进程。** 因此相关镜像拉取/构建不记为通过。守护进程可能保留了部分下载缓存。

下一位不要等待旧会话；应先查当前 engine、镜像和容器状态，再决定重试。不要为了清理这次尝试执行系统级 prune 或删除用户卷。

## 7. 已知问题：接手后先处理

### P0-1：网关构建输出路径与监督器不一致

`scripts/docker/build.mjs` 将 `container-gateway.mjs` 打到 `out/server/`，最终是 `/opt/sab/server/container-gateway.mjs`；`supervisor.mjs` 的默认入口却是 `/opt/sab/container/container-gateway.mjs`。

**这是已确认的静态契约不一致。** 下一位先统一这两处，再用 bundle 文件清单测试证明 supervisor 引用的每个入口真实存在。当前不能认为 bridge 镜像只需网络拉取即可启动成功。

### P0-2：宿主管理工具尚未跟上新的 runtime API

`scripts/docker/manage.mjs`、`compose-command.mjs` 仍主要是 Flash 版本：

- 部分状态/配置导出仍只读 `process.env.SAB_HTTP_PORT`，没有与指定私有 env 文件统一解析，18055 映射场景可能错用 17655。
- 维护调用还转发旧 `--from/--kind`；新 maintenance 改为 `--backup-id`。
- 新 Compose 已自带受控 maintenance entrypoint，旧 helper 又在 command 中塞入 `node /opt/sab/container/maintenance.mjs`，需要统一真实 argv，不能重复执行入口。
- `prepare-update` 需要选择有只读游戏输入的 `maintenance-game`，旧 helper 仍固定选择 `maintenance`。
- 新 runtime 不再有旧的 `migrate-from-native`，旧 helper 仍会调用它；应补齐受限迁移或明确处理原范围偏差，不能留下假命令。
- 缺完整的 plan/preflight/build/start/open/受保存风险保护的 stop、token 管理和 generate-secret 等闭环。
- 仍有直接 `down --volumes` 分支，不符合本轮不扩大到删卷的管理契约，应移除或按原任务书重新设计。
- `private-output.mjs` 尚未接入，令牌/配置仍可能直接输出；默认文件化、Windows ACL、JSON 只输出一个文档等要求尚未兑现。
- 尚未通过容器/卷标签核对整个 project 的归属和实际路径。

### P0-3：事务和生命周期重写缺行为测试

必须先写合成目录/假子进程测试，不要第一次验证就用真实存档：

- 空卷首次初始化、普通重启、输入变化、旧副本保留和 journal 损坏/越界。
- 在旧目录退休后、新目录就位后、journal 持久化前后中断。
- backup 未有 COMPLETE、hash/manifest 篡改、未列出载荷、重复路径、链接和特殊文件。
- 双卷恢复过程中断，`recover-restore` 回到一致的旧组合，重复恢复与版本不匹配。
- 两个 runtime 以及 runtime/maintenance 的 flock 竞争，原锁 inode/父目录始终稳定。
- Bridge/网关/Xvfb/窗口管理器/游戏意外退出；noVNC 辅助故障只降级桌面。
- 启动中收到 SIGTERM、重复信号、未结束 SSE 与关闭总预算。
- 健康超过 30 秒、旧 generation/nonce、PID 重用、标题页等待、桌面降级。

`game-seed.mjs` 的整树 hash 比较使用 JSON 字符串，跨文件枚举顺序的稳定性应复核。路径保护、空/损坏 managed 记录、未完成恢复时的启动阻止也需要明确的失败测试。

### P1-1：镜像构建尚未验证

- Node 镜像未完整到位；两个 Dockerfile 都引用 `/usr/local/LICENSE`，该文件来源尚未在实际镜像中验证。
- `Dockerfile.mod-build` 使用 SDK 8.0.415，而本机隔离测试基线 SDK 是 10 系列。需要核对原 Mod 所用 C# 语法与 net6 targeting pack，不能从 manifest 存在推断构建成功。
- Mod 工具的只读源码、NuGet cache、obj/tmp 权限和 private input hash 不变均未测。
- `docker/versions.json` 未同步；OCI 元数据、依赖许可证完整性、真实公开镜像内容与层检查器未做。
- 构建入口 `buildImage()` 的镜像标签与 Compose 的 `SAB_IMAGE_PREFIX` 需要统一并测试。

### P1-2：Compose、Web、测试与文档仍缺集成

- 4 份 Compose 已写，但未执行任何合并 config 校验或 up；需验证 project 插值、继承端口、tools profile、非 root 空卷、read_only/tmpfs、secret 文件可读性。
- `apps/web` 尚未改动：没有 Docker 模式/四种状态、桌面入口、标题页提示及 Docker stdio 说明的 UI 接入；需做宽屏和 390px 浏览器验收。
- 尚无 Docker 单元测试、合成夹具、无游戏容器集成脚本、验收脚本和镜像检查器。
- `package.json` 仍没有 Docker 专用命令；`.github/workflows/docker.yml` 不存在，原 CI 未改。
- Docker 安装、开发、故障、验收文档和 README/CHANGELOG/CLIENTS/平台矩阵尚未同步。

### P1-3：真实输入和平台验收

目前没有取得已核实的 Linux 星露谷 + SMAPI 输入，也没有 QA HOME/测试存档与外部 Agent 短任务证据。不要把 Windows 游戏文件、mock DLL、静态截图或协议握手当成真实游戏通过。

Docker Engine in WSL 可继续做 Linux 容器无游戏验证；Windows Docker Desktop Linux containers 的 H02 需要单独环境与记录。Steam 认证、平台启动和游戏下载不能靠自动切账号或不明补丁解决。

## 8. DKR-001–024 当前对照

| ID | 当前真实状态 | 下一步 |
| --- | --- | --- |
| 001 | 基线/差异已核对，实施前源码已备份 | 保留现有未提交修改 |
| 002 | 公共地址单实现与配置修正已写，TS 构建通过 | 补配置/旧 config/18055 单元测试及 helper 接入 |
| 003 | 网关关键问题已修源码，TS 构建通过 | 补 HTTP/SSE/CSRF/断连/背压测试 |
| 004 | 展示地址与 Endpoint 类型已改 | 补旧工作流与真实映射回归 |
| 005 | Dockerfile、bundle 构建器已写 | 先修网关路径，再实际构建镜像 |
| 006 | ignore 白名单与元数据收集已写 | 同步版本/许可证、补镜像检查器 |
| 007 | Compose base/样例已写 | config 合并、非 root、空卷、只读与 tmpfs 实测 |
| 008 | 持锁 runtime/maintenance 入口已重写 | 双实例/信号/崩溃释放竞争测试 |
| 009 | Mod 工具 Dockerfile/脚本已写 | 工具镜像构建、只读引用与白名单验收 |
| 010 | 输入预检与工作副本已重写 | 空卷首次初始化和输入保护测试 |
| 011 | journal/retired/恢复路径已写 | 故障注入与幂等回退测试 |
| 012 | 图形栈/CJK/game overlay 已写 | game 镜像构建与真实图形/游戏验收 |
| 013 | supervisor 已重写 | 假进程退出矩阵及容器信号实测 |
| 014 | nonce/PID 身份/心跳健康已写 | 过期、残留和标题页/桌面降级测试 |
| 015 | 桌面 overlay 与受限网关已写 | 密码/Host/Origin/noVNC 真实验收 |
| 016 | 未实现 Docker Web UI | 补 UI 和浏览器 QA |
| 017 | 模板复用和私有输出模块已写 | 接入 helper，补 HTTP/exec stdio/令牌生命周期测试 |
| 018 | 旧 helper 未完成新契约适配 | 重构管理入口、受保护 stop 和 project 归属验证 |
| 019 | 备份/恢复核心已重写，未做功能测试 | 接口对齐、跨卷故障与哈希/路径测试 |
| 020 | 未编写 Docker 正式单元测试/夹具 | 先补关键安全和失败路径用例 |
| 021 | 未编写 Docker 集成/检查/专用 CI | 仅手动触发、无自动发布 |
| 022 | 本次交接已补，其他 Docker 使用/开发文档未补 | 同步中英文 README 和配套文档 |
| 023 | 有审查与当前静态对照，尚未完成全部自查 | 逐项核对命令/env/路径/产物与矩阵 |
| 024 | 当前中断状态交接已写 | 功能完成后重写为最终交付报告，不能沿用本状态冒充完成 |

## 9. 验证账目：哪些是真发生，哪些没发生

| 验证 | 状态 | 边界 |
| --- | --- | --- |
| 原 3 个 TS 编译错误修复 | 已通过真实 `node scripts/build.mjs` | 不是 Docker 镜像构建 |
| TS/Web build | 本轮多次返回 0，最后一次约 20:26 | 未执行完整回归测试 |
| 本次交接纯语法解析 | 20/20 通过 | 没有 import/执行被解析的脚本 |
| 原审查中的健康/锁判断合成探针 | 当时确实复现旧 bug | 旧代码已重写；不能替代新版本功能测试 |
| SDK 8.0.415 镜像 manifest | 已查询成功 | 未拉取该 SDK 镜像、未编译 Mod |
| Docker/Compose 安装与版本查询 | 已成功 | 不代表应用镜像或平台流程通过 |
| Node 镜像拉取、Bridge 镜像构建 | 未获得完成结果，现场无完成镜像 | 不能填 pass |
| 完整 Node/Mod/installer 回归 | 未执行 | 保留待测 |
| 新增 Docker 单元/集成/CI | 未编写/未运行 | 保留待实现与待测 |
| 浏览器 Docker UI/noVNC | 未执行 | 无页面/console 验收证据 |
| 真实游戏、保存、备份恢复、Agent 短任务 | 未执行 | 未碰真实存档 |
| 多人保护静态检查 | 原 `ModEntry.cs:243` 拒绝分支仍在，Mod 无本轮差异 | 本轮没有开发或运行多人 |
| Git/registry 发布 | 未执行 | 未获本轮发布授权 |

原任务书 C/N/I/L/P/M/B/D/R/G/A/H 验收项继续逐项管理。R01 的“build 子项”有成功结果，但完整 R01 仍未通过；H01 只是环境已准备，不能标完整流程通过。其余不能从语法或旧 CI 推断通过。

## 10. 下一位建议从这里继续

### 10.1 首轮只读核对

Windows PowerShell：

```powershell
Set-Location -LiteralPath 'D:\星露谷\stardew-agent-bridge'
git status --short
git rev-parse HEAD
Get-Content -LiteralPath '.\DOCKER_HANDOVER_REPORT.md' -Raw
Get-Content -LiteralPath '.\docs\DOCKER_DEVELOPMENT_HANDOFF.md' -Raw
wsl -d Ubuntu -u root -- docker version
wsl -d Ubuntu -u root -- docker compose version
wsl -d Ubuntu -u root -- docker image ls
```

读取现有原始完整任务书第 23–28 节，核对 current source manifest 和备份。不要重新复制旧 F 盘副本，不要重置当前差异。

### 10.2 实施和验证顺序

1. 修 P0-1 的 gateway 产物路径，并补“所有 runtime 入口均存在”的 bundle 检查。
2. 对齐 manager 与新 maintenance/Compose/配置/令牌私有输出接口；补 plan、受保护 stop、secret 与 project 验证。
3. 为工作副本、备份恢复、监督和健康写合成失败测试；修复测试暴露的问题，保留真实失败，禁止改期望成假通过。
4. 运行现有项目 build、普通 Node 回归、Mod 隔离测试和安装器回归，再做新增无 Docker 单元测试。测试临时输入必须独立，不能扫描/导入真实存档。
5. 验证 bundle 许可证/元数据；在隔离 project 构建 bridge-runtime，并检查镜像内容、UID、只读运行、18055 映射、真实 MCP SDK、HTTP/stdio 同核心、锁与停机。
6. 构建 game-runtime 和 mod-build 工具镜像，不在公开构建上下文中放游戏。
7. 补 Web、文档、显式手动 CI 与完整验收矩阵。
8. 取得合法 Linux 游戏 + SMAPI 输入，建立独立 QA HOME/存档，按原任务书 G/A/H 做真实游戏及 Agent 验收。
9. 回填真实通过/未测/受阻状态，更新最终报告。GitHub/镜像发布留给用户另行授权。

已有依赖可用于 Windows 首轮构建：

```powershell
node scripts/build.mjs
node scripts/test.mjs
dotnet run --project tests/mod/ControlTests.csproj
node scripts/test-installer.mjs
```

上面后 3 条是**建议下一轮执行的命令，本轮没有运行**。

在修复 bundle 路径后，可先做不启动 Docker 的 bundle 检查：

```powershell
node scripts/docker/build.mjs --bundle --output 'F:\星露谷\work\docker-completion-20261024\next-bundle-check'
```

此命令也尚未在本轮执行，产物必须核对，不能只看退出码。

WSL 内构建时使用真实 Linux 路径，不把 Windows 反斜杠路径直接传给 Linux Docker：

```bash
cd /mnt/d/星露谷/stardew-agent-bridge
docker build --platform linux/amd64 --target bridge-runtime \
  -f docker/Dockerfile -t local/stardew-agent-bridge:bridge-runtime .
```

上述命令是后续模板。实际构建应补 sourceCommit、dirty 状态、时间和对应记录，先解决本档案已列的路径/输入问题。原 Node 镜像拉取可按当前环境重试，不要把网络等待写成镜像已支持。

## 11. 可给下一位协作者的简短上下文

> 在 `D:\星露谷\stardew-agent-bridge` 继续 Docker **单人版**。先读根目录 `DOCKER_HANDOVER_REPORT.md` 和完整 `docs\DOCKER_DEVELOPMENT_HANDOFF.md`，保留现有未提交修改。Codex 已修 TS 编译并通过 TS/Web build，新增/重写了共享地址与宿主模板、runtime 事务/监督/健康、Dockerfile 和 4 份 Compose；20 个相关脚本语法解析通过，但无完整 Node/Mod/installer/Docker/游戏验收。WSL Ubuntu 已装 Docker 29.9.2、Compose 5.6.1，服务还在，当前没有完成的 Node/项目目标镜像和 QA 容器。先修 bundle 网关路径不一致，再对齐仍是旧实现的 manage/Compose/maintenance 参数与私有输出，补故障/竞争测试，然后逐步做无游戏容器和真实 QA 游戏验收。Docker Web UI、测试/CI、镜像检查器及使用文档仍缺。用户不知道 Linux 游戏输入位置，尚未取得有效输入。不要开发联机，不碰真实玩家存档，不重放未知动作，不擅自提交、推送或发布。完成后按实际证据更新矩阵，不能把写完源码或旧 CI 当成 Docker 验收通过。

---

本档案交接的是持续开发现场。项目仍未完成；未发生的动作、保存、容器构建或 Agent 接入均不推算为成功。
