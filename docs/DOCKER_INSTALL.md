# Docker 单人预览版安装

本版支持 Linux amd64 容器。`bridge-runtime` 不包含游戏；`game-runtime` 提供图形运行环境，但仍需你自己的合法 Linux 游戏和 SMAPI 输入。Docker 联机不在本版支持范围内。所有模式均不捆绑游戏文件、存档或凭据。

## 1. 选择下载

GitHub Release 提供三个镜像归档（bridge-runtime / game-runtime / mod-build）、Docker 源码工具包，以及独立 Mod 包。先核对同一 Release 的 `SHA256SUMS.txt`。

```bash
gzip -dc StardewAgentBridge-<version>-docker-bridge-runtime-amd64.tar.gz | docker load
# 需要图形游戏时再加载另外两份镜像；镜像标签见 Release 清单。
```

也可以解压源码工具包后本地构建。需要 Docker Engine、Compose V2 >=2.24、Node >=22.13。Docker Desktop 使用 Linux containers；Windows 路径涉及游戏输入时，建议全部在 WSL2 内操作，使用 Linux 绝对路径。

```bash
npm ci
npm run build
node scripts/docker/build.mjs --target bridge-runtime
```

管理工具使用宿主 Node，但容器内不需要 npm、node_modules 或宿主 Node。默认镜像名为 `local/stardew-agent-bridge:bridge-runtime`（另外两个标签相应为 game-runtime、mod-build）。Release 归档保留这些标签。

## 2. 无游戏 Bridge 模式

在解压后的工具包/源码根目录运行，所有生命周期命令固定使用同一 project、env 文件：

```bash
mkdir -p "$HOME/.config/sab"
cp docker/example.env "$HOME/.config/sab/docker.env"
chmod 600 "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs doctor --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs plan --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs up --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs status --project sab-local --env-file "$HOME/.config/sab/docker.env" --json
```

`example.env` 默认外部端口为 18055，浏览器打开 `http://127.0.0.1:18055/`。只对宿主回环暴露网关 17656，Bridge 自身的 17655 和 Mod 的 17654 均在容器内部。修改端口时同时修改 `SAB_HTTP_PORT` 与 `SAB_PUBLIC_BASE_URL`，后者不带末尾 `/`。

`bridge_ready` 表示 Web/MCP 服务可用，不表示游戏已连接。没有游戏时仍能发现 29 个工具、生成连接配置、查询状态；游戏工具会返回未连接。

## 3. 接入 DSH、Codex 或 Claude Code

HTTP：从 Web「MCP 连接」选择客户端与 HTTP，生成并复制配置。每个 Agent 使用不同连接名称。

stdio：宿主 Agent 通过 `docker compose exec -T` 调用容器内适配器。不能把容器路径 `/opt/sab/...` 当成宿主可执行路径。Web 会提示用宿主管理工具生成（容器不知道宿主源码/env 的真实路径）：

```bash
node -- scripts/docker/manage.mjs mcp-config --host dsh --transport stdio --client-id dsh \
  --issue-token --project sab-local --env-file "$HOME/.config/sab/docker.env"
```

配置含令牌时只写入私有文件，命令输出其路径。可用 `--host codex|claude-code|generic` 与 `--transport http`。不要将配置或私有 env 文件上传仓库。

## 4. 完整游戏模式

前提：合法、完整的 **Linux x64** 游戏目录，安装与游戏匹配的 Linux SMAPI；Windows 游戏目录不可代替。

在私有 env 中设置：

```dotenv
SAB_GAME_SOURCE=/absolute/private/linux-game-with-smapi
```

检查 UID/GID 与目录可读性。游戏源只读挂载到 `/input/game`；首次运行复制为命名卷内的受管工作副本；后续只有 `prepare-update` 能更新副本，不会因源变化静默覆盖。不要在输入目录里放任何凭据或私人存档。

```bash
node scripts/docker/build.mjs --target game-runtime
node scripts/docker/build.mjs --target mod-build
# runtime 必须未启动；下面的 Mod 工具先校验游戏输入并构建独立产物卷。
```

首次构建 Mod 使用同一 project 的 tools 编排（路径需按当前目录替换；不要改变 project 名）：

```bash
docker compose -p sab-local --project-directory "$PWD" --env-file "$HOME/.config/sab/docker.env" \
  -f docker/compose.yaml -f docker/compose.game.yaml -f docker/compose.tools.yaml \
  run --rm --no-deps mod-build --json
node -- scripts/docker/manage.mjs check-input --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs up --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
```

预期先到 `awaiting_save`：游戏在标题页，Mod 已握手，等待人工或 Agent 正常载入单人测试存档。程序不会自动选档、自动创建角色、自动保存或代替真人购买/登录 Steam。

首版真实 Linux 游戏闭环仍需按 [DOCKER_ACCEPTANCE.md](DOCKER_ACCEPTANCE.md) 验收；镜像构建通过不代表图形游戏通过。使用独立测试档，不与原生运行实例共享正在写入的数据目录。

## 5. 可选 noVNC 桌面

只在 game 模式启用。生成恰好 8 位字母数字的密码到私有文件（不要放 env 或命令行）：

```bash
node -- scripts/docker/manage.mjs generate-secret vnc-password --output "$HOME/.config/sab/vnc-password"
```

私有 env 填入文件路径和访问地址：

```dotenv
SAB_VNC_PASSWORD_PATH=/absolute/private/vnc-password
SAB_NOVNC_PORT=6080
SAB_DESKTOP_BASE_URL=http://127.0.0.1:6080
```

文件必须可由容器 UID 读取。启动 `up --game --novnc`，Web 出现「打开游戏桌面」后使用单独密码进入。不把密码拼到 URL。桌面链路降级会保留游戏和 MCP；桌面可用不等于存档载入或 Agent 接入。

## 6. 停止、备份、升级、回退

先正常保存并退到标题页，再结束 Agent 控制。然后运行 `down`（如有已载入存档，工具默认拒绝；`--accept-unsaved-progress` 代表明确接受丢失未保存进度的风险）。工具从不附加 `--volumes`。

```bash
node -- scripts/docker/manage.mjs down --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs backup create --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs backup list --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs backup verify --backup-id <ID> --game --project sab-local --env-file "$HOME/.config/sab/docker.env"
```

备份/恢复必须离线、全程持有独占卷租约。备份包含私有凭据和游戏 home，应保密。恢复要显式提供备份 ID 并按工具提示确认；未完成的跨卷恢复用 `recover-restore`，不要删除事务文件或锁文件。备份只覆盖 sab-data 与 game-home；游戏工作副本可从合法只读输入重建，Mod 从同版源码重建。

升级：离线备份 → 加载新镜像 → 构建同版 Mod → `prepare-update --game` → `up --game` → 核对版本/状态。回退旧 Bridge 时使用升级前备份独立恢复；旧版不保证保护 v2 账本。参见 [MULTIPLAYER_INSTALL.md](MULTIPLAYER_INSTALL.md) 的账本升级说明。

## 7. 故障定位

```bash
node -- scripts/docker/manage.mjs logs --tail 100 --project sab-local --env-file "$HOME/.config/sab/docker.env"
node -- scripts/docker/manage.mjs doctor --project sab-local --env-file "$HOME/.config/sab/docker.env" --json
```

退出码：10 配置、11 缺输入、12 权限、13 卷归属/锁冲突、14 恢复事务、15 启动超时、16 子进程退出、17 备份校验、18 未保存进度、19 Docker 不可用。HTTP 403 检查 Host/Origin 是否和私有 env 的规范回环地址一致。WSL 内配置要使用 Linux 路径；跨平台 Agent 连接建议用 HTTP。
