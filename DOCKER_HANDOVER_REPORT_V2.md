# 星露谷 Docker 单人版：续开发交接档案 V2（ZCode 轮）

生成时间：2026-10-24 深夜，北京时间。交接基线：Codex 轮交接档案 V1（同日）。
当前状态：**P0 问题全部关闭；三个 Docker 镜像实机构建成功；bridge 无游戏容器验收完整通过；180 个测试 0 失败。真实游戏验收仍未开始（无 Linux 游戏输入）。**

本档案接替 V1（`星露谷_Docker续开发交接档案_Codex_20261024.md` / 仓库 `DOCKER_HANDOVER_REPORT.md`）。V1 中"P0-1/P0-2/P0-3 待处理"的条目**已全部完成**，不要按 V1 的"下一步"重做。真实状态以下文与仓库 `docs/DOCKER_PROGRESS.md` 为准。

## 1. 唯一维护现场（不变）

| 项目 | 位置 |
| --- | --- |
| 唯一维护仓库 | `D:\星露谷\stardew-agent-bridge`（HEAD 仍为 `63a4f369`，两轮修改均未提交，diff 为两轮叠加） |
| 本轮证据目录 | `F:\星露谷\work\docker-continue-20261024\`（测试日志、bundle 产物核对、QA 脚本） |
| V1 交接包 | `C:\Users\am202\Desktop\星露谷_Docker续开发源码交接包_20261024.zip`（196 文件已与 D 盘仓库逐文件 SHA-256 核对一致） |
| V1 的备份/审查材料 | `F:\星露谷\work\docker-completion-20261024\`（保留，勿动） |
| WSL Ubuntu 新位置 | **`D:\wsl\ubuntu`（本轮整体迁移，见 §4）**；导出备份 `D:\wsl\ubuntu-20261024.tar`（4.06GB） |

## 2. 本轮完成的修复（V1 P0 清单）

### P0-1 网关产物路径不一致 —— 已关闭
- 方向：按任务书 §6.3 统一到 `server/container-gateway.mjs`；改的是 `supervisor.mjs:59`（`layout.container` → `layout.server`），build.mjs 不动。
- `scripts/docker/build.mjs` 新增 `BUNDLE_LAYOUT` 契约 + `verifyBundleLayout()` 出包自检（入口/runtime 相对导入/固定资产缺一即抛 `BUNDLE_LAYOUT_INVALID`）。
- 锁死测试 `tests/src/docker-bundle.test.ts`（5 项）：supervisor 引用 ↔ BUNDLE_LAYOUT ↔ Dockerfile ENTRYPOINT/HEALTHCHECK 三方一致。
- **附带发现（重要）**：本机 Windows Node 22.23.1 的 `fs.cpSync(recursive)` 会进程级静默死亡（退出码 127，无异常；拷到 C:/F: 均复现，同参数 esbuild 正常）。bundle 改用 `copyFileSync` 手写 `copyTree()`。后续任何人在这台机器写递归拷贝都要避开 cpSync。

### P0-2 宿主管理工具未跟上新 runtime API —— 已关闭
`scripts/docker/manage.mjs` 重写 + `compose-command.mjs` 微调：
- 端口/地址统一走 `resolveEnvSettings(env文件)`：显式 process.env > 私有 env 文件 > 默认；18055 映射场景不再误用 17655。
- 维护命令全部经 compose.tools 的**受控 lease-entrypoint**（`compose run --rm --no-deps <service> <args>`），不再拼 `node maintenance.mjs`；新接口 `--backup-id`；`migrate-from-native` 已删除。
- `prepare-update` / `check-input` 选挂载游戏输入的 `maintenance-game` 服务。
- `down` 永不带 `--volumes`（composeCommands.down 已结构化移除该选项）；game+已加载存档时拒绝停止，需 `--accept-unsaved-progress`。
- 新增：`plan`（只读预览）、`build`（走 build.mjs）、`open`、`token list|issue|rotate|revoke`、`generate-secret vnc-password`、`check-input`、`recover-restore`、`backup create|list|verify|restore --backup-id`。
- 令牌/MCP 配置/桌面密码一律经 `private-output.mjs` 写私有文件（Windows ACL/0600），stdout 只给路径；JSON 模式单文档。
- doctor 增加卷归属核对（`com.docker.compose.project` 标签）。
- 契约测试 `tests/src/docker-manage.test.ts`（6 项）锁死以上行为。

### P0-3 事务/监督缺行为测试 —— 已关闭（合成层）
新增 39 个 Docker 测试（`npm test` 总数 141→180，0 失败）：
- `docker-runtime.test.ts`（14）：game-seed 空卷初始化/复用/INPUT_CHANGED/5 个崩溃注入点（copied/validated/new_installed/committed/old_retired-重建场景）全部可恢复且无 staging 残留；journal 损坏与路径越界拒绝；backup 篡改四类拒绝（载荷/COMPLETE/未列文件/清单）、租约拒绝、恢复幂等、崩溃→recover-restore→重试全链、workdir 版本不匹配拒绝。
- `docker-health-supervisor.test.ts`（9）：healthcheck 六类失败（缺文件/代次/PID/过期含未来时间/game 未连 Mod/网关未就绪）+ 桌面降级单独 DESKTOP_DEGRADED；supervisor 假进程矩阵（正常 SIGTERM 停机 stopped/0、bridge 关键退出 failed/16、启动超时 15、游戏辅助进程退出只降级且停机记录 unsavedProgressPossible→退出码 18）。
- `docker-gateway.test.ts`（10）：见 §3。

## 3. Docker 实机验收（本轮真实发生的）

环境：WSL Ubuntu Docker 29.9.2 / Compose 5.6.1（已迁 D: 盘，见 §4）。

| 验证 | 结果 |
| --- | --- |
| 基础镜像 pull | node:22.13.0-bookworm-slim、debian:bookworm-slim、（mod-build 内含 SDK 8.0.415） |
| bridge-runtime 构建 | 成功 300MB；`/usr/local/LICENSE` 确认存在后 COPY |
| bridge 镜像内容 | `server/{bridge,container-gateway,stdio-adapter}.mjs` + `container/` 13 脚本齐；UID/GID 1000(sab)；`/opt/sab` root:555 只读；build-info 带真实 commit/dirty/时间戳 |
| bridge 容器（compose, 18055→17656） | healthy；`/container/live`、`/container/ready` 返回 bridge_ready；容器内 `token issue --json` ✓ |
| MCP HTTP | 经网关真实 initialize（SSE 响应，serverInfo stardew-agent-bridge 0.1.0）✓；无令牌 401 ✓ |
| MCP stdio | `compose exec -T` 进容器跑 stdio-adapter，initialize ✓（同一 Bridge 核心） |
| Compose 合并 | base / +game / +game+novnc / +tools 四组 `config --quiet` 全过 |
| game-runtime 构建 | 成功 1.32GB；Xvfb/openbox/x11vnc/websockify/xdpyinfo/noVNC web/30 个 Noto CJK 字体/UID 1000 全部确认 |
| mod-build 构建 | 成功 1.41GB；dotnet 8.0.415、NuGet 还原缓存、modsrc 只读；无游戏输入时优雅拒绝 INPUT_MISSING（**真实容器退出码 11**，base64 管道法验证） |
| 网关协议测试 | 10/10：Host 缺失/后缀欺骗/端口不符 400/403、绝对 URL 400、CONNECT 405、Origin 跨站/重复/null 403、Sec-Fetch-Site cross-site 403、`/container/*` 与 `/health` 净化、转发头规范化（Host→回环、Origin 同源、forwarded 与 Connection 动态 hop-by-hop 剥离、白名单头保留）、64KiB 声明+流式 413 且不达上游、上游断 502 且提示查 actionId 收据、SSE 首段不缓冲直通+多 Set-Cookie 保留、连接超时只管 TCP 建立不误杀慢工具响应 |

## 4. 本轮环境事件（下一位必须知道）

1. **WSL 两次崩溃**：game 构建中 VM 死亡（apt 报 Read-only file system → I/O error）。排查链：先疑内存（宿主仅 7GB，WSL 默认 3GB），加 `.wslconfig` 4GB+swap 后仍崩；真根因是 **C: 盘只剩 0.9GB**，WSL VHDX+swap 都在 C: 耗尽空间。
2. **处置**：`wsl --export`（备份 `D:\wsl\ubuntu-20261024.tar`）→ unregister → `wsl --import Ubuntu D:\wsl\ubuntu`；`C:\Users\am202\.wslconfig`（memory=4GB, swap=4GB, swapFile=D:\wsl\swap.vhdx）。Docker 服务与全部镜像完好，迁移后两镜像一次构建成功。原 C: VHDX 已释放；**C: 盘空间紧张仍在，建议用户清理**（与本仓库无关）。
3. **Git Bash → wsl.exe 多层引号会伪造退出码**（`echo $?` 可能拿到假 0）：跨 wsl 验证退出码用 base64 脚本管道；直接 `wsl -- docker ...` 的输出可信。
4. QA 留存：`sab-qa_sab-data` 卷（含 qa-agent 测试令牌）按不删卷契约保留；QA 脚本 `artifacts/qa-mcp-smoke.sh`（仓库内，artifacts/ 已 gitignore）+ F 盘 evidence 副本。

## 5. 版本/文档同步

- `docker/versions.json`：已补 modBuildSdk（8.0.415 + amd64 digest）、websockifyInternal 6081、buildVerification 实测记录。
- `docs/DOCKER_PROGRESS.md`：已重写为本轮真实状态（DKR 矩阵已更新：003/005 完成，009/012 镜像层完成等）。
- **未做**：Docker 使用/开发/故障/验收文档、README/CHANGELOG/CLIENTS/平台矩阵同步、Docker Web UI（DKR-016 not_started）、专用 CI（DKR-021）。

## 6. 剩余工作（按优先级）

1. DKR-016 Docker Web UI（四种状态/桌面入口/标题页提示/stdio 说明；390px 窄屏验收）。
2. Docker 文档套件 + README/CHANGELOG/CLIENTS/平台矩阵 + 显式手动 CI（DKR-021/022/023）。
3. noVNC 真实桌面验收（密码文件、Host/Origin、DKR-015）。
4. 取得合法 Linux 游戏 + SMAPI 输入（用户此前答复“不知道”）：mod-build 真实编译 → game 容器真实图形 → QA HOME/测试存档 → 任务书 G/A/H 真实游戏与 Agent 短任务验收。
5. Git 提交/推送/发布：**未获授权，未执行**；两轮 diff 都未提交，注意保留。

## 7. 快速上手命令（已在本机验证过的形态）

```powershell
Set-Location 'D:\星露谷\stardew-agent-bridge'
npm test                                   # 180 测试
node scripts/docker/build.mjs --bundle --output <目录>   # 出包+布局自检
```

WSL 内（真实 Linux 路径；退出码验证走 base64 管道）：

```bash
cd /mnt/d/星露谷/stardew-agent-bridge
docker image ls    # 应见 local/stardew-agent-bridge:{bridge,game}-runtime 与 :mod-build
```

bridge 无游戏容器（QA 形态，env 文件自建 SAB_HTTP_PORT=18055）：

```bash
cd docker && docker compose -p sab-qa -f compose.yaml --env-file <env> up -d
curl -s http://127.0.0.1:18055/container/live
```

---

边界重申：不开发联机；不碰真实玩家存档；不重放未知动作；未授权不提交/推送/发布。写完源码 ≠ 验收通过；本档案只把**实际发生过**的操作记为通过。
