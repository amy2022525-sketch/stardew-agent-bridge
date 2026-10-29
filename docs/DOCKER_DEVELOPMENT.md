# Docker 架构与维护

## 进程与网络

`lease-entrypoint` 先检查配置和目录、取得 `/var/lib/sab/container-volume.lock` 的 flock 独占租约，再启动 supervisor。supervisor 按 Bridge → 网关 →（game 模式）Xvfb/Openbox/游戏的顺序启动。Docker init 转发信号；supervisor 有统一关闭预算，只终止本次进程组。持锁期间维护入口返回 OWNERSHIP_CONFLICT。

```text
Agent/browser -> 127.0.0.1:外部端口 -> gateway 0.0.0.0:17656
                                      -> Bridge 127.0.0.1:17655
                                           -> Mod 127.0.0.1:17654
browser -> 127.0.0.1:noVNC端口 -> desktop-gateway:6080
                                 -> websockify 127.0.0.1:6081
                                      -> x11vnc 127.0.0.1:5900 -> Xvfb :99
```

网关严格校验唯一 Host、Origin/Fetch Metadata；不信任客户端 Forwarded/X-Forwarded-*。HTTP/MCP 鉴权、Web 会话和 CSRF 继续由唯一 Bridge 业务核心处理。SSE 走流转发；限制请求头、请求体与等待时间。状态仅暴露净化字段，不能把 status 文件的 PID/nonce/内部路径直接输出。

## 镜像

- source-build：npm ci → TS/Web build → esbuild 单文件服务、stdio、网关 bundle；复制运行脚本、静态 Web、许可证和依赖清单。
- bridge-runtime：Debian glibc + Node + util-linux；非 root、只读根目录、无 npm/SDK/开发 node_modules。
- game-runtime：继承 Bridge，加 Xvfb/Openbox/OpenGL/SDL/音频空驱动/noVNC。仅用户输入目录提供游戏，镜像不复制游戏或存档。
- mod-build：独立 .NET SDK 镜像、net6 目标包、本项目 Mod 源码；游戏程序集只读输入，输出独立卷。只有此工具镜像含编译 SDK。

已支持 linux/amd64。ARM64/macOS native/多人容器均不宣称支持。版本、OCI revision、build-info 和 Mod 版本需一致；首次发行使用 `0.2.0-preview.1`。

## 数据与事务

命名卷：sab-data（凭据、账本、安装元数据）、game-home（单人存档/SMAPI 配置）、game-work（合法输入的工作副本）、mod-output、backups。`.volume-owner.json` 记录 project，防止误接其他项目的卷。

game-seed 从只读源生成清单并核对哈希，stage→commit，保留恢复信息；拒绝路径逃逸与符号链接。更新只通过显式维护命令。备份排除易失 endpoint/锁/运行状态，生成 manifest + COMPLETE 哈希；恢复多卷使用逐步事务、回滚与恢复日志。不能直接删除卷根、锁 inode 或 unknown 动作历史。

## 健康与可用性

`/container/live` 判定必要进程及真实 Bridge/Mod 握手；`/container/ready` 判定 bridge_ready、awaiting_save 或 ready 等对应状态。game 标题页可健康地等待载档。noVNC 是非关键辅助进程；其失败不能伪装成游戏退出，也不能替代 Mod screenshot。

停机不自动保存。Agent 的 stop/takeover 先释放游戏输入；SIGTERM 之后尽力正常关闭，预算耗尽才 SIGKILL；有已加载存档时报告未保存风险，不能把“发出退出信号”说成“已保存”。

## 开发与验证入口

```bash
npm ci
npm run build
npm test
npm run test:mod
npm run test:installer
node scripts/docker/build.mjs --bundle --output /absolute/temp/sab-bundle
node scripts/docker/build.mjs --target bridge-runtime
node scripts/docker/inspect-image.mjs --image local/stardew-agent-bridge:bridge-runtime --json
```

`tests/src/docker-*` 覆盖真实 HTTP 网关、SSE、配置、维护命令、种子/备份事务、supervisor、Web 纯逻辑。纯状态机测试不替代真实进程/浏览器/游戏。`.github/workflows/docker.yml` 对相关 push/PR 构建 Bridge 与 Mod 工具镜像；完整图形镜像可手动勾选。CI 不包含游戏输入、存档或账号，不推送 registry。

发布三个 `docker save` 的 gzip 镜像归档、Docker 源码工具包和 SHA256SUMS。仅从当前提交的白名单源码生成工具包；不得从整个工作目录打包（容易混入凭据或游戏）。镜像内保留 Node/第三方许可证与 OS 包清单。GitHub source zip 与可安装产物含义不同，发布说明应逐一列出平台和验收边界。
