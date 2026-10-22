# 验证证据记录

记录**实际执行**的验证：命令、时间、结果。未执行的项明确标为「待执行」，不写成通过。
全部时间：2026-10-22（Asia/Shanghai）。机器：Windows，Node v22.23.1，npm 10.9.8，.NET SDK 10.0.302，TypeScript 5.9.3，esbuild 0.28.2，游戏 1.6.15 build 24356 + SMAPI 4.5.2。

## E1 构建（源码 → 可运行）

| 项 | 内容 |
| --- | --- |
| 命令 | `node scripts/build.mjs` |
| 结果 | **通过**。`tsc -b` 项目引用编译 + Web 类型检查 + esbuild 打包 Web 产物到 `apps/web/dist` |
| 覆盖 | 6 个 workspace 包、apps/server、adapters/stdio、tests |

## E2 自动化测试（真实 MCP SDK + 模拟 Mod）

| 项 | 内容 |
| --- | --- |
| 命令 | `node scripts/test.mjs` |
| 结果 | **通过**：`tests 34`、`suites 10`、`pass 34`、`fail 0`、`duration_ms ≈ 5.87 s` |
| 套件 | 工具目录、参数校验、签名与收据、错误表、控制权、结果不明、账本不可写、断线期间的行为、HTTP MCP、stdio 适配器一致性 |
| 关键断言 | ① 28 个工具名称与契约一致；② 无控制会话的写入被拒、建立会话后成功；③ 错误令牌无法连接 `/mcp`；④ 未带令牌的 `/api/v1/status` 被拒；⑤ 同一 `actionId` 重放不重复执行、不同参数报 `IDEMPOTENCY_CONFLICT`；⑥ 断线期间写请求返回 `RESULT_UNKNOWN` 且 `effectKnown=false`；⑦ 账本不可写时拒绝写动作但仍可读；⑧ stdio 与 HTTP 工具面一致且共享同一个控制权 |
| 不能证明 | 真实游戏资源变化、真实寻路/钓鱼手感、真实存档切换 |

## E3 Mod 编译（引用真实游戏 DLL）

| 项 | 内容 |
| --- | --- |
| 命令 | `dotnet restore -s https://api.nuget.org/v3/index.json` → `dotnet build -c Release -p:GamePath="F:\SteamLibrary\steamapps\common\Stardew Valley"` |
| 结果 | **通过**：`已成功生成`，**0 个警告，0 个错误**；产物 `StardewAgentBridge.dll` 291,840 字节 + `manifest.json` |
| 说明 | 本机 .NET SDK 只装了 10.0 的引用包，`net6.0` 目标包需从 nuget.org 还原（`scripts/build-mod.ps1` 已内置该源）；这不是代码问题 |
| 审计 | 源码中不存在 `warp`/`resource`/`skipevent`/`diag` 命令；产物与安装目录都检查过不含游戏 DLL、存档、`.pdb` |
| 不能证明 | 运行期行为（本次未在运行中的游戏里加载新 Mod，理由见 §待执行） |

## E4 Bridge 实进程自检（无游戏时的降级路径）

| 项 | 内容 |
| --- | --- |
| 命令 | `node apps/server/dist/cli.js start --data-dir <临时目录> --port 17855` + HTTP 探测 |
| 结果 | **通过**：`GET /health` → 200 `{ok:true, bridgeVersion:"0.1.0", contractsSchemaVersion:1, modConnected:false}`；`GET /` → 200（3996 字节，含标题）；`GET /app.js` → 200（11,267 字节）；`GET /styles.css` → 200（3,646 字节） |
| 结论 | Web 控制台与静态资源在**没有游戏**时也能打开，并明确显示"Mod 未连接" |

## E5 真实 MCP 往返（HTTP 通道）

| 项 | 内容 |
| --- | --- |
| 命令 | `node scripts/smoke.mjs --url http://127.0.0.1:17857 --client smoke` |
| 结果 | **通过**：`tools/list` = 28 个工具（`stardew_doctor … stardew_wait`）；`stardew_status` 返回 Bridge 端口、Mod 连接=否、控制者=无、未决动作=0、账本可写=是；`stardew_snapshot` 在无游戏时返回 `isError=true` + `GAME_UNAVAILABLE`（`effectKnown=true 下一步=fix_environment`），符合设计 |
| 附带修复 | 该验证暴露并修复了真实缺陷：CLI 子进程签发的令牌，运行中的 Bridge 不认（内存缓存）。改为按 `credentials.json` 修改时间热加载后复测通过（签发后立即调用成功） |

## E6 发布包自检

| 项 | 内容 |
| --- | --- |
| 命令 | `scripts/pack.ps1 -GamePath <游戏目录>` |
| 结果 | **通过**：`release/StardewAgentBridge-0.1.0/`，20 个文件、2.3 MB，含 `CHECKSUMS.txt`；禁止文件审计通过（无游戏 DLL / 存档 / 凭据 / `node_modules`） |
| 独立运行 | 在发布目录内 `node server\bridge.mjs doctor` → `Web 产物：已构建`；`node server\bridge.mjs start` → `GET /` 200、`GET /app.js` 200，说明单文件 server 能自己找到同级的 `web/` |
| 附带修复 | 打包脚本三处真实缺陷已修：① `.ps1` 需 UTF-8 BOM（否则 Windows PowerShell 5.1 按 ANSI 解析中文字符串报语法错）；② `--outfile=(Join-Path …)` 会被拆成两个参数；③ `@array` splat 会按位置传参把游戏路径喂给 `-Configuration` |

## E7 真实游戏内验收：**待执行**

本次交付**没有**改动正在运行的游戏（用户明确要求"先不动游戏"），因此下列项目一律处于「待执行」，不能算通过：

| 编号 | 验收项 | 执行方式 |
| --- | --- | --- |
| A1 | 只读链路：`doctor` / `snapshot` / `inspect` / `shop` / `recipes` / `saves` / `screenshot` | [ACCEPTANCE.md](ACCEPTANCE.md) §5.1 |
| A2 | 基础动作与资源操作：移动、使用、交互、菜单、买卖、存放、制作、食用、装备 | §5.2 |
| A3 | 实时动作：钓鱼、战斗（含生命阈值停手） | §5.3 |
| A4 | 控制权：写者独占、租约到期、人工接管、`F9` 急停 | §5.4 |
| A5 | 故障：中途断开 Bridge、强杀 Bridge、游戏侧失联自释放与自动暂停 | §5.5 |
| A6 | 存档流程：跨日、`stardew_load` 换存档、返回标题 | §5.6 |
| A7 | 三个宿主真实短任务（DSH / Codex / Claude Code 各一次） | §5.7 |
| A8 | Web 控制台在真实连接下的渲染与交互 | §5.8 |

## 复现这些证据

```powershell
node scripts/build.mjs
node scripts/test.mjs
powershell -ExecutionPolicy Bypass -File scripts/build-mod.ps1 -GamePath "<游戏目录>"
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1 -GamePath "<游戏目录>"
# 需要正在运行的 Bridge：
node scripts/smoke.mjs
```
