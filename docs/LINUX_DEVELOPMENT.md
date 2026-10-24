# Linux 开发说明

面向维护者：Linux 适配的代码边界、数据根规则、脚本入口与本地验证方式。
安装与使用请见 [LINUX_INSTALL.md](LINUX_INSTALL.md)。

## 1. 代码边界

Linux 首版**没有**第二套业务核心。改动集中在三处：

| 位置 | 作用 |
| --- | --- |
| `packages/platform/` | 新增平台层：数据根解析、原子写与权限、Steam 库解析、进程身份、桌面入口、运行时探测、关闭钩子 |
| `apps/server/src/*` | 复用平台层：实例锁、启动/复用、只读诊断、Mod 配置比对、CLI 子命令 |
| `mods/StardewAgentBridge/PlatformPaths.cs` | Mod 侧的数据根解析，规则必须与 `packages/platform/src/data-root.ts` 完全一致 |

`packages/contracts`、`packages/control-core`、`packages/mcp`、`packages/game-client`
保持平台无关；工具面（28 个 `stardew_*`）与协议语义在 Linux 上不变。

## 2. 数据根解析规则（Node 与 C# 必须一致）

优先级从高到低：

| 场景 | 规则 |
| --- | --- |
| 显式 `--data-dir` / Mod `config.DataDirectory` | 最高优先；**Mod 与安装器要求绝对路径**，相对值直接报 `PATH_INVALID` |
| 非空 `SAB_HOME` | 其次；**Linux 上必须是绝对路径**，相对值报 `PATH_INVALID` |
| Windows 默认 | `%LOCALAPPDATA%\StardewAgentBridge`，缺失时 `~/AppData/Local/StardewAgentBridge` |
| Linux 默认 | 绝对 `XDG_DATA_HOME` 下的 `StardewAgentBridge`，否则 `~/.local/share/StardewAgentBridge` |
| Linux 上的 `LOCALAPPDATA` | **忽略**（历史上曾被误用为默认目录） |
| Linux 上相对的 `XDG_DATA_HOME` | 视为无效并回退默认（来源仍明确写 `default`） |

为什么不猜：通过 Steam 启动游戏时不会继承终端的 `SAB_HOME`，如果两处各自"猜一个目录"，
就会出现「游戏连不上 Bridge」这种最难排查的状态。因此安装器把解析后的绝对路径写进 Mod 配置，
`doctor` 只读比对两边，不一致时明确报 `DATA_ROOT_MISMATCH`，**不会**复制凭据去掩盖问题。

### 契约向量

规则不是靠注释保证的，而是靠一份共享数据：

```
tests/fixtures/platform-paths.json
```

- Node 侧：`tests/src/platform-paths.test.ts`
- Mod 侧：`tests/mod/Program.cs`（读取同一份 JSON，只跑 `parties` 含 `cs` 的用例）

改规则的唯一正确做法是**同时**改两侧实现与这份 JSON，让两侧测试都红过再绿。

## 3. 文件系统与权限

| 对象 | 权限 | 说明 |
| --- | --- | --- |
| 数据根 | `0700` | 只允许当前用户 |
| `credentials.json` | `0600` | 令牌文件；每次读取按 `mtime`+`size` 热加载 |
| `bridge.lock` | `0600` | 实例锁诊断记录（原子写），伴随 `bridge.lock.owners/` 目录使用原子 mkdir 串行化所有权 |
| `endpoint.json` | `0600` | 端口/MCP 地址/pid/启动身份 |
| 配置文件 `config.json` | `0644` | 不含秘密 |
| 账本 `ledger.sqlite` | 默认 | 由 `node:sqlite` 管理 |

所有写入都走「临时文件 + fsync + rename」：要么是完整的新文件，要么完全没有变化。
重启后不会出现半截 JSON。

## 4. 单实例与启动复用

- `start` 在**构造 Bridge 之前**抢占 `<数据根>/bridge.lock`：没有所有权就绝不打开账本、不做恢复记录；
- 锁记录 `pid` 与 Linux `/proc/<pid>/stat` 的 `starttime`，因此 **PID 复用**不会被误判成活实例；
- 陈旧锁可以被接管（同进程重试上限 3 次），损坏的锁文件不会被永久阻塞；
- `launch` 与 `doctor` **从不构造 Bridge**：只用 `endpoint.json` + `GET /health` 做只读探测；
- 连续双击桌面入口只会复用实例并打开网页。

## 5. 脚本入口（跨平台分派）

Windows 行为保持不变：MJS 入口在 win32 上把参数原样转发给既有 `.ps1`。

| `npm run` | 入口 | Windows | Linux |
| --- | --- | --- | --- |
| `build:mod` | `scripts/build-mod.mjs` | `build-mod.ps1` | `scripts/linux/build-mod.mjs` |
| `install:mod` | `scripts/install-mod.mjs` | `install-mod.ps1` | `scripts/linux/install-mod.mjs` |
| `rollback:mod` | `scripts/rollback-mod.mjs` | `rollback-mod.ps1` | `scripts/linux/rollback-mod.mjs` |
| `pack` | `scripts/pack.mjs` | `pack.ps1` | `scripts/linux/pack.mjs` |
| `test:installer` | `scripts/test-installer.mjs` | `tests/scripts/install-rollback.ps1` | `tests/scripts/install-rollback-linux.mjs` |

Linux 侧共用库：

- `scripts/lib/game-paths.mjs`：Steam 库 / 游戏目录发现、只读校验、进程状态、安装记录；
- `scripts/lib/install-journal.mjs`：事务 journal、哈希、快照、原子移动。

## 6. 安装事务状态机

```
preflight → staged → backuped → prepared → retired_old → committed → verified
                                                     ↘ failed（可恢复）
remove_only / rolled_back（回退终态）
```

每个阶段都先原子写 journal，再执行不可逆操作；因此崩溃后能按**真实阶段**恢复：

| 失败点 | 恢复行为 |
| --- | --- |
| `staged` / `backuped` / `prepared` | 旧目录从未被移动，直接报错即可 |
| `retired_old` | 旧目录从快照区移动回 `Mods/` |
| `committed` 之后 | 未完成的新安装移到快照区保留，再放回旧版 |

回退时会**重新校验** journal 里记录的每个路径（组件级边界 + 符号链接）：
记录被篡改或指向允许目录之外时拒绝执行并保留现场（`JOURNAL_TAMPERED`）。

故障注入：设置 `SAB_FAIL_AT=<阶段名>` 即可让安装在该阶段抛错，用于验证恢复路径
（`tests/scripts/install-rollback-linux.mjs` 就是这么做的）。

## 7. 打包

```bash
npm run build
npm run build:mod                 # 需要本机游戏程序集 + .NET SDK
npm run pack -- --runtime-root /path/to/node-runtime-root --target linux-x64
npm run verify:package -- release/StardewAgentBridge-<版本>-linux-x64
```

- 包内 Node 必须由你提供（官方 Linux x64 发行包，含 `LICENSE`）；打包脚本会校验 ELF 头、
  可执行位与版本，缺一不可；
- `--skip-mod` 生成 `bridge-only-ci` 包（无 `mod/`，`manifest.release.json` 标
  `packageKind: bridge-only-ci`），只用于 CI；
- `server/*.mjs` 与 `scripts/*.mjs` 都是 esbuild 单文件产物，**不得**残留
  `../../packages/.../dist` 之类的源码树引用；
- `tar.gz` 请在内容校验通过后手动生成；本仓库脚本不上传、不打标签、不生成 Release；
- 包内禁止出现：游戏 DLL、存档、`credentials.json`、`endpoint.json`、`ledger.sqlite`、
  `.pdb`、`.map`、`node_modules`。

## 8. 本地开发流程

```bash
npm ci
npm run build          # tsc -b + Web 打包
npm test               # 契约与单元测试（模拟 Mod）
npm run test:mod       # Mod 侧隔离测试（.NET 10，不加载游戏）
npm run test:installer # 安装/回退事务测试（临时目录 + 故障注入）
node apps/server/dist/cli.js doctor --data-dir "$HOME/sab-dev"
```

`apps/server/dist/cli.js start` 会占用真实端口；调试时用 `--data-dir` 隔离数据根，
避免污染你日常使用的凭据与账本。

## 9. 修改时要守住的约束

1. 工具面不变：28 个 `stardew_*`，无自由文本 `execute`；
2. 写动作必须有 `actionId` 与 `epoch`，结果不确定时返回 `unknown` / `effectKnown=false`；
3. 不新增需要联网或厂商密钥的能力；
4. 不把游戏状态写进数据根以外的地方；不在游戏目录里乱写文件（快照区除外）；
5. Windows 行为不得退化：`.ps1` 入口与其测试断言保持不变。
