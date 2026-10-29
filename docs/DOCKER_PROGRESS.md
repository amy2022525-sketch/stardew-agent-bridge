# Docker 单人版开发进度（ZCode 续开发现场）

## 2026-10-29 接手更新

Docker 与 MP1 源码已经合并。已补齐 Host/Origin 桌面网关关闭、私有 MCP JSON 输出、依赖许可证、安装文档和自动 CI；当前发布验证与待验收范围统一见 [RELEASE_VALIDATION_20261029.md](RELEASE_VALIDATION_20261029.md)。下文是 2026-10-24 的历史现场，里面的“未开始/未完成”和测试数量不代表当前版本。真实 Linux 游戏仍待合法 Linux 输入和图形环境验收。

## 2026-10-24 历史记录

最后更新：2026-10-24（第二轮，ZCode），北京时间。
基线 HEAD：`63a4f369feadacf9476660c7af6b1cb9b6ac9a00`，两轮均未提交。
当前阶段：**P0 全部关闭；bridge 镜像实机构建并通过无游戏容器验收；game/mod-build 镜像构建与真实游戏验收仍未完成。**
第一轮（Codex）中断现场见仓库根目录 `DOCKER_HANDOVER_REPORT.md`；本轮证据目录 `F:\星露谷\work\docker-continue-20261024`。

## 本轮（ZCode）已完成并实测

| 项 | 结果 |
| --- | --- |
| 交接核对 | 桌面 zip、D 盘仓库、manifest 三方 SHA-256 逐文件核对 196/196 一致；D 盘为唯一维护现场 |
| P0-1 网关路径 | 统一为任务书 §6.3 的 `server/container-gateway.mjs`（supervisor 改指向 server/）；`build.mjs` 新增 `BUNDLE_LAYOUT` + `verifyBundleLayout` 出包校验；镜像内已确认落位 |
| P0-1 附带发现 | 本机 Node 22.23.1 的 `fs.cpSync(recursive)` 会进程级静默崩溃（退出码 127，C:/F: 目标均复现）；bundle 改用 `copyFileSync` 手写递归拷贝 |
| P0-2 helper 对齐 | `manage.mjs` 重写：env 文件统一解析（18055 映射）、维护命令走 compose 受控 lease-entrypoint（不再拼 `node maintenance.mjs`）、`--backup-id` 新接口、`prepare-update/check-input` 走 `maintenance-game`、删除 `migrate-from-native`、`down` 永不带 `--volumes` 且受未保存进度保护（`--accept-unsaved-progress`）、新增 `plan/build/open/token/generate-secret/check-input/recover-restore`；令牌/配置/密码经 `private-output.mjs` 落私有文件（Windows ACL/0600），stdout 只给路径 |
| P0-3 合成测试 | 新增 29 个测试：game-seed 事务（空卷初始化、复用、INPUT_CHANGED、5 个崩溃注入点恢复、journal 损坏/越界拒绝）、backup/restore（篡改 4 类拒绝、租约拒绝、幂等重放、崩溃→recover-restore→重试、版本不匹配）、healthcheck 6 类失败、supervisor 假进程矩阵（正常停机、关键退出、启动超时、桌面降级+UNSAVED_PROGRESS_POSSIBLE=18） |
| 回归 | `npm run build` ✓；`npm test` 170 测试 0 失败（原 141 + 新 29）；Mod 隔离 77 项 ✓；安装器 17 项 ✓ |
| bundle 校验 | `--bundle` 产物逐项核对（server 3 入口、container 13 脚本、web、metadata、licenses 18 依赖），`BUNDLE_LAYOUT_INVALID` 会在缺件时阻止出包 |
| bridge 镜像 | WSL Docker 29.9.2 实机构建成功（commit/dirty/时间戳入镜像）；内容检查：`server/container-gateway.mjs` 落位、UID 1000(sab)、`/opt/sab` root:555 只读、`/var/lib/sab`、`/home/sab` 0700 |
| 无游戏容器验收 | Compose 起 bridge（18055→17656）：容器 healthy；`/container/live`、`/container/ready` 正确返回 bridge_ready；容器内 CLI `token issue --json` ✓；经网关真实 MCP HTTP initialize（SSE，serverInfo 0.1.0）✓；stdio 适配器 initialize（exec -T）✓；无令牌 401 ✓ |
| game 镜像 | 构建成功（1.32GB）；Xvfb/openbox/x11vnc/websockify/xdpyinfo、noVNC web、30 个 Noto CJK 字体、UID/GID 1000 全部确认 |
| mod-build 镜像 | 构建成功（1.41GB，SDK 8.0.415）；NuGet 还原缓存、/opt/sab/modsrc 只读、无游戏输入时优雅拒绝（真实退出码 11）。真实 Mod 编译仍需 Linux 游戏输入（预检按任务书拒绝 Windows 文件） |
| 网关协议测试 | 新增 10 个：Host 缺失/后缀欺骗/端口不符、绝对 URL、CONNECT 405、Origin 三类拒绝+Sec-Fetch-Site、/container/* 净化、/health 固定字段、转发头规范化（forwarded/动态 hop-by-hop 剥离）、64KiB 声明+流式 413、上游 502+actionId 提示、SSE 不缓冲直通+多 Set-Cookie、连接超时不误杀慢工具响应 |
| Compose 合并 | base / +game / +game+novnc / +tools 四组 `config --quiet` 全过 |
| 最终回归 | `npm test` 180 测试 0 失败（原 141 + 本轮新增 39） |

## 本轮环境事件（必须知晓）

1. **WSL 虚拟机两次在 game-runtime 构建中崩溃**：根因是宿主 C: 盘仅剩 0.9GB，WSL 的 VHDX（5.3GB 且随构建增长）与 swap 文件都在 C:，空间耗尽触发 I/O 错误 → 内核重挂只读 → VM 死亡。已处置：`C:\Users\am202\.wslconfig`（memory=4GB, swap=4GB, swapFile=D:\wsl\swap.vhdx）+ **发行版整体迁移到 `D:\wsl\ubuntu`**（先 `wsl --export` 到 `D:\wsl\ubuntu-20261024.tar` 备份，再 unregister+import；Docker 与全部镜像完好）。C: 盘空间紧张问题依旧存在，与本仓库无关，建议用户另行清理。
2. Docker 数据根随发行版迁移到 D: 盘 VHDX（`D:\wsl\ubuntu`）；原 C: 盘 VHDX 已随 unregister 释放。
3. QA 冒烟产生的 `sab-qa_sab-data` 卷按契约保留未删（含 qa-agent 测试令牌）。
4. **Git Bash → wsl.exe 的引号转义会伪造退出码**（多层引号下 `echo $?` 可能拿到 0）：跨 wsl 验证退出码必须走 base64 脚本管道；本轮已用该法确认 mod-build 容器真实退出码 11。

## DKR 矩阵当前状态

| ID | 状态 | 说明 |
| --- | --- | --- |
| 001 | completed | 基线与备份保留；本轮差异继续未提交 |
| 002 | completed(合成) | 地址/配置经 170 测试回归；18055 映射在容器实测 |
| 003 | completed | 网关 10 个协议专项测试全过 + 容器实机 MCP/401 验收 |
| 004 | completed(合成) | Endpoint/展示地址随回归覆盖 |
| 005 | completed | 三个镜像（bridge/game/mod-build）全部实机构建成功，内容检查通过 |
| 006 | mostly | ignore/元数据/versions.json 已同步并含实测状态；独立镜像检查器未写（内容检查为手动命令） |
| 007 | mostly | 四组合并 config 过；非 root 空卷/read_only/tmpfs 已随容器验收；secret 文件可读性未测（无桌面） |
| 008 | completed(合成) | lease-entrypoint 经容器 healthy 间接验证 + 退出码链实测（11）；双容器 flock 实测未做 |
| 009 | mostly | 工具镜像构建/内容/优雅拒绝实测；真实 Mod 编译待 Linux 游戏输入 |
| 010 | completed(合成) | 空卷初始化/输入保护/复用/拒绝路径 9 个合成测试 |
| 011 | completed(合成) | 5 个崩溃注入点 + journal 损坏/越界全部可恢复 |
| 012 | image-built | game 镜像+图形组件确认；真实图形/游戏运行未验收 |
| 013 | completed(合成) | 假进程矩阵 4 场景；容器信号实测待 game 镜像 |
| 014 | completed(合成) | 健康 6 类失败场景；容器 healthy 实测（bridge） |
| 015 | pending | noVNC 密码/Host/Origin 真实桌面未验收 |
| 016 | not_started | Docker Web UI 未实现 |
| 017 | mostly | 模板/私有输出已接入 helper 并测试；HTTP/stdio 已实测；令牌生命周期（rotate/revoke 容器内）未全测 |
| 018 | completed(合成) | 新契约 + 受保护 stop + 私有输出 + 卷归属核对（doctor） |
| 019 | completed(合成) | 12 个合成测试含跨卷崩溃恢复 |
| 020 | completed(首轮) | 29 个 Docker 单元/合成测试入 `npm test` |
| 021 | partial | QA 冒烟脚本已有（artifacts/qa-mcp-smoke.sh + F 盘证据）；正式验收脚本/镜像检查器/CI 未写 |
| 022 | in_progress | 本文件已更新；Docker 使用/开发/故障/验收文档与 README 同步未做 |
| 023 | in_progress | 命令/env/路径逐项自查进行中 |
| 024 | in_progress | 以本文件+最终报告为准，不冒充完成 |

## 仍未执行 / 受阻

- 真实 Linux 游戏 + SMAPI 输入未取得（用户答复“不知道”）；真实 Mod 编译、game 图形栈运行、G/A/H 真实游戏与 Agent 短任务验收全部待定。
- Docker Web UI（DKR-016）、noVNC 浏览器验收、专用 CI、Docker 使用/开发/故障/验收文档与 README 同步。
- Git 提交/推送/发布：未获授权，未执行。
- 未读取/修改真实玩家存档；未启动真实游戏。

## 下一步建议

1. Docker Web UI + 文档 + CI（DKR-016/021/022）。
2. 取得合法 Linux 游戏输入后：mod-build 真实编译 → game 容器真实图形/游戏 → 按任务书 G/A/H 做真实验收。
3. noVNC 密码/Host/Origin 真实桌面验收（DKR-015）。
