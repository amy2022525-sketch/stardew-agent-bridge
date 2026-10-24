# Linux 首版适配交接报告

> 2026-10-24 原协作者已执行首轮验证并修复问题，最新结果见 [LINUX_VALIDATION_REPORT.md](LINUX_VALIDATION_REPORT.md)。下文保留原编写交付时的未测试状态，不能作为当前验证结果。

**完成状态：编写完成；未运行构建/测试；待原协作者验证。**

本报告只描述"写了什么、放在哪里、为什么这样设计"。它**不**声称任何构建、类型检查、单元测试、
Mod 测试、安装/回退测试、打包、`doctor`、自检或真实游戏验收已经通过——按交接书的分工，
这些执行全部属于原协作者（Codex）。

- 基线：`main` @ `e43691f858f3372eb1c16d55f54b21056b552904`（只读核对，未改动历史）
- 验收清单：[docs/LINUX_ACCEPTANCE.md](docs/LINUX_ACCEPTANCE.md)（P01–P12 / S01–S08 / I01–I12 / K01–K08 / R01–R04 / G01–G10，全部 `not_run`）
- 平台差异：[docs/PLATFORM_MATRIX.md](docs/PLATFORM_MATRIX.md)
- 安装与开发：[docs/LINUX_INSTALL.md](docs/LINUX_INSTALL.md)、[docs/LINUX_DEVELOPMENT.md](docs/LINUX_DEVELOPMENT.md)

## 1. 任务与文件映射（LNX-001 … LNX-020）

| 任务 | 里程碑 | 交付内容 | 主要文件 | 状态 |
| --- | --- | --- | --- | --- |
| LNX-001 | M0 | 基线、工作区与改动保护规则 | 本报告 §6（只改代码/脚本/配置/测试源码/文档；未运行任何构建或测试） | 编写完成 |
| LNX-002 | M1 | 平台层、共享路径规则、依赖与 fixture | `packages/platform/**`、`tests/fixtures/platform-paths.json`、`tests/src/platform-paths.test.ts`、`apps/server/src/paths.ts`、`adapters/stdio/src/index.ts`、`scripts/smoke.mjs` | 编写完成；未运行 |
| LNX-003 | M1 | Mod 侧路径实现、`DataDirectory` 与 C# fixture 接入 | `mods/StardewAgentBridge/PlatformPaths.cs`、`ModEntry.cs`（`ModConfig.DataDirectory`、数据根日志）、`tests/mod/ControlTests.csproj`、`tests/mod/Program.cs` | 编写完成；未运行 |
| LNX-004 | M1 | 权限、原子凭据写入、轮换读取、旧根诊断 | `packages/platform/src/fs-safe.ts`、`apps/server/src/config.ts`、`apps/server/src/paths.ts`（`legacyDataRootReport`）、`packages/platform/src/data-root.ts`（`inspectLegacyDataRoot`）、`tests/src/platform-paths.test.ts` | 编写完成；未运行 |
| LNX-005 | M1 | 实例锁、延迟账本恢复、只读 doctor、所有权 | `apps/server/src/instance-lock.ts`、`apps/server/src/cli.ts`、`tests/src/instance-lifecycle.test.ts` | 编写完成；未运行 |
| LNX-006 | M2 | 显式路径、VDF、额外库、候选与边界解析 | `packages/platform/src/steam.ts`、`scripts/lib/game-paths.mjs`、`apps/server/src/mod-config.ts` | 编写完成；未运行 |
| LNX-007 | M2 | npm 分派器、Linux 构建与产物筛选 | `scripts/build-mod.mjs`、`scripts/linux/build-mod.mjs`、`package.json` 脚本 | 编写完成；未运行 |
| LNX-008 | M2 | preflight/stage/backup/configure/commit 与 journal | `scripts/linux/install-mod.mjs`、`scripts/lib/install-journal.mjs`、`scripts/install-mod.mjs` | 编写完成；未运行 |
| LNX-009 | M2 | 回退、`RemoveOnly`、重复操作与恢复 | `scripts/linux/rollback-mod.mjs`、`scripts/rollback-mod.mjs`、`tests/scripts/install-rollback-linux.mjs` | 编写完成；未运行 |
| LNX-010 | M1 | Bridge/适配器退出、归属、取消与 `unknown` | `packages/platform/src/shutdown.ts`、`apps/server/src/bridge.ts`（`releaseEndpoint`、`/health`）、`adapters/stdio/src/index.ts` | 编写完成；未运行 |
| LNX-011 | M3 | full/bridge-only、runtime-root 校验、manifest 与许可收集 | `scripts/linux/pack.mjs`、`scripts/pack.mjs`、`assets/stardew-agent-bridge.svg` | 编写完成；未运行 |
| LNX-012 | M3 | 包内 Node、权限、受控 PATH、仓库外验证工具 | `scripts/verify-package.mjs`（扩展为双平台）、`docs/LINUX_ACCEPTANCE.md` §4 | 编写完成；未运行 |
| LNX-013 | M3 | 复用/后台启动/只读就绪探测/打开 Web | `apps/server/src/launch.ts`、`apps/server/src/cli.ts`（`launch`）、`tests/src/instance-lifecycle.test.ts` | 编写完成；未运行 |
| LNX-014 | M3 | 菜单/桌面入口、移除、图标与 Exec 转义 | `packages/platform/src/desktop-entry.ts`、`scripts/linux/desktop-entry.mjs`、`tests/src/desktop-entry.test.ts` | 编写完成；未运行 |
| LNX-015 | M4 | HTTP/stdio 模板、路径、身份与收据兼容 | `apps/server/src/hosts.ts`（复用）、`apps/server/src/paths.ts`（`resolveStdioAdapter`）、`docs/CLIENTS.md` §8 | 编写完成；未运行 |
| LNX-016 | M4 | 页面可观察点、复制/下载/390px 用例与步骤 | `apps/web/index.html`（`data-testid`）、`apps/web/src/styles.css`（≤420px）、`docs/LINUX_ACCEPTANCE.md` §3 | 编写完成；未运行 |
| LNX-017 | M4 | 跨平台工作流与各测试入口 | `.github/workflows/ci.yml`（`windows` + `linux` 两个 job）、`scripts/test-installer.mjs`、`tests/scripts/install-rollback-linux.mjs` | 编写完成；未运行 |
| LNX-018 | M5 | G01–G10 操作说明、证据模板与诊断支持 | `docs/LINUX_ACCEPTANCE.md`、`apps/server/src/cli.ts`（`doctor` 问题码）、`bridge.ts` 的 `/health` 字段 | 编写完成；未运行 |
| LNX-019 | M5 | 宿主短任务步骤、配置模板与兼容矩阵 | `docs/CLIENTS.md` §7–§9 | 编写完成；未运行 |
| LNX-020 | M6 | 双语安装文档、平台矩阵、任务映射与接手说明 | 本报告、`docs/LINUX_INSTALL.md`、`docs/LINUX_DEVELOPMENT.md`、`docs/PLATFORM_MATRIX.md`、`README.md`、`README.en.md`、`CHANGELOG.md` | 编写完成；未运行 |

## 2. 关键设计决定（含取舍理由）

1. **数据根只有一条规则，两个实现。** `packages/platform/src/data-root.ts` 与
   `mods/StardewAgentBridge/PlatformPaths.cs` 必须给出同一结果，靠
   `tests/fixtures/platform-paths.json` 的向量锁定。Linux 上 `SAB_HOME` 相对值直接报
   `PATH_INVALID`，而不是"猜一个 cwd"——猜错的代价是凭据分裂与"游戏连不上 Bridge"。
2. **先拿锁，再碰账本。** `start` 在 `new Bridge(...)` 之前抢占 `<数据根>/bridge.lock`；
   没有所有权就不打开账本、不做 `invalidateOpenSessions`。这样 S01/S02 要求的
   "探测不得改写会话/未决/收据"在结构上成立，而不是靠小心。
3. **探测不构造实例。** `launch`/`doctor` 只读 `endpoint.json` + `GET /health`；
   `doctor` 不创建目录、不写凭据、不打开真实账本（账本损坏时只给"先备份再处理"的建议）。
4. **安装是可恢复事务，不是一堆 `try/finally`。** 每个阶段先原子写 journal 再执行不可逆操作，
   失败时按真实阶段恢复；`committed` 之后失败会把未完成的新安装移入快照保留，再放回旧版。
   记录路径在回退时重新校验（组件级边界 + 符号链接），篡改即拒绝。
5. **Windows 行为一字不改。** 所有 Linux 能力都放在新文件里；`scripts/*.mjs` 在 win32 上
   透明转发给既有 `.ps1`，参数以 argv 数组 `spawn`（不经 shell）。Windows 的
   `%LOCALAPPDATA%` 默认根、既有凭据与账本、既有测试断言全部保留。
6. **发布包自带运行时。** Linux 包内必须带 `runtime/node`（含 LICENSE），
   `bin/stardew-agent-bridge` 用 `exec` 指向它；打包脚本校验 ELF 头（x86-64）、执行位与版本，
   `verify-package.mjs` 在仓库外复制后再次校验清单哈希并跑 HTTP/stdio 真实往返。
7. **不新增能力面。** 工具仍是 28 个、协议与 `epoch`/`actionId` 语义不变；
   没有新增联网依赖、没有厂商密钥、没有自由文本 `execute`。

## 3. 未执行的验证（必须由原协作者完成）

以下命令**一次都没有运行**（编写者按交接书要求不执行构建/测试/打包/CI）：

```bash
npm ci
npm run build
npm test
npm run test:mod
npm run test:installer
npm run pack -- --target linux-x64 --runtime-root <runtime>
npm run verify:package -- <包目录>
node apps/server/dist/cli.js doctor
node scripts/smoke.mjs
```

因此以下结论**尚未成立**：

- 新代码是否零 TypeScript 错误（尤其 `packages/platform` 与新增 CLI 分支的类型边界）；
- `tests/src/*.test.ts` 的断言是否与实现细节完全对齐（例如 `probeHealth` 的字段、
  `launchBridge` 的失败码分支、桌面入口的目录解析）；
- `install-rollback-linux.mjs` 的 15 个步骤是否全部通过（含 3 个故障注入点与篡改拒绝）；
- C# `PlatformPaths` 是否与 JS 在全部 19 条 `cs` 向量上一致（含 UNC 与大小写语义）；
- 发布包是否可执行（本机是 Windows，无法在此执行 Linux ELF）；
- CI 两个 job 是否绿。

## 4. 已知风险与开放问题

1. **`package-lock.json` 是手工补齐的。** 新增 workspace `packages/platform` 的条目按既有
   workspace-link 格式写入（`"node_modules/@sab/platform": {"resolved": "packages/platform", "link": true}`），
   无 integrity 字段。请在 Linux 上跑一次 `npm install` 确认无 diff；若 npm 版本改写格式，
   以 `npm install` 结果为准。
2. **`PlatformPaths` 的词法规范化是自实现的**（不调用 `Path.GetFullPath`，避免借用宿主 cwd 语义）。
   已覆盖 `/`、`..`、`.`、末尾分隔符、盘符与 UNC；极端写法（如 Windows 设备路径 `\\\\?\\`、
   长路径前缀）未纳入向量，若需要请补 fixture 并同步两侧。
3. **`--allow-unverified-runtime` 是给 CI 交叉打包用的逃生门**：它会在无法执行目标平台 node 时
   把缺失版本降级为提示。正式发布包不得使用该开关（`docs/LINUX_DEVELOPMENT.md` §7）。
4. **沙箱环境（Flatpak/Snap/Steam Linux Runtime）不在本版范围。** 发现候选时会给出提示并
   要求 `--game-path` 显式指定；不做挂载点重映射。若目标是沙箱用户，需要另立任务。
5. **`launch` 打开浏览器的判定**依赖 `DISPLAY`/`WAYLAND_DISPLAY` 与 `xdg-open`；
   无 GUI 会话下会跳过并给真实地址，但"浏览器真的打开了"这一步只能在带桌面的机器上人工确认。
6. **`doctor` 的 Steam 库发现**走 `steamRootCandidates`（含 Flatpak/Snap 路径）。
   在 Linux 上如果玩家把库放在非标准位置且未写 `libraryfolders.vdf`，只能靠 `--game-path`/安装记录。
7. **`bridge.lock` 的跨平台身份**：Linux 用 `/proc` starttime 判定 PID 复用；
   Windows 无等价字段（`processStart: null`），只能退回存活判断。这是与 Windows 既有权衡一致的取舍，
   但意味着 Windows 上的 PID 复用仍可能误判为活实例（既有行为，本版未改变）。
8. **Web 的 `data-testid` 只是观察点**，没有附带自动化浏览器用例（原协作者可沿用既有浏览器检查流程）。

## 5. 原协作者接手建议顺序

1. `npm ci && npm run build` —— 先让类型检查暴露实现细节偏差（最可能的失败点）；
2. `npm test` —— 看 4 个新测试文件的断言是否与实现一致；
3. `npm run test:installer` —— 覆盖安装事务与故障注入；
4. `npm run test:mod` —— 校验 C# 与 JS 的路径向量一致性；
5. 在 Linux 机器上 `npm run pack -- --runtime-root <node 发行目录>` + `npm run verify:package`；
6. 按 [docs/LINUX_ACCEPTANCE.md](docs/LINUX_ACCEPTANCE.md) 逐条填写 P/S/I/K/R，最后做 G01–G10 实机验收。

任何一条失败都请直接记录 `fail` + 证据，不要以"静态阅读看起来没问题"替代执行结论。

## 6. 改动保护与边界

- 只新增/修改：`packages/platform/**`、`apps/server/src/**`、`adapters/stdio/src/index.ts`、
  `mods/StardewAgentBridge/{PlatformPaths.cs,ModEntry.cs}`、`scripts/**`、
  `tests/**`、`.github/workflows/ci.yml`、`apps/web/{index.html,src/styles.css}`、
  `docs/**`、`assets/**`、根目录 `package.json`/`package-lock.json`/`tsconfig.json`/`README*`/`CHANGELOG.md`。
- **未修改**：既有 `.ps1` 脚本（`build-mod/install-mod/rollback-mod/pack/mod-install-common`）、
  `tests/scripts/install-rollback.ps1`、`packages/contracts|control-core|mcp|game-client` 的协议与行为、
  工具数量与名称、Windows 默认数据根。
- 未推送、未打标签、未创建 Release、未上传任何产物；仓库内没有新增二进制（`runtime/node` 只在打包时引入）。
