# 故障排查

顺序建议：**先看 `doctor`，再看 `/health`，再看日志，最后导问题包**。

```powershell
node apps/server/dist/cli.js doctor        # 数据目录 / 端口 / Mod 连接 / Web 产物 / 账本可写性
node apps/server/dist/cli.js matrix        # 宿主支持矩阵
```

日志：`%LOCALAPPDATA%\StardewAgentBridge\logs\bridge.log`（已脱敏，不含令牌与用户名路径）。
问题包：网页「导出诊断」或 `POST /api/v1/diagnostics/export`，输出到 `exports/`，**不含令牌**。

## 1. Bridge 起不来

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE 127.0.0.1:17655` | 已经有一个 Bridge 在跑，或端口被占 | 保留一个即可；或 `--port 17656` 并用 `endpoint.json` 里的端口 |
| `SQLite is an experimental feature` 警告 | Node 22 的内置 `node:sqlite` 仍标记为实验性 | 只是警告，可忽略；需 Node ≥ 22.5 |
| 启动后立刻退出并打印 `config.json 无法解析` | 手工编辑坏了 `config.json` | 删除该文件，重启会自动重建默认配置 |
| 端口能开但页面 404 | Web 产物没构建 | `npm run build`；发布包里应存在 `web/index.html` |

## 2. Mod 未连接（`modConnected=false`）

按顺序检查：

1. 游戏是否通过 **SMAPI** 启动（`StardewModdingAPI.exe`），而不是原版 exe。
2. `Mods\StardewAgentBridge\` 是否存在 `StardewAgentBridge.dll` + `manifest.json`（`npm run install:mod`）。
3. SMAPI 日志里是否出现 `Stardew Agent Bridge Mod 已启动：ws://127.0.0.1:17654/`；若出现 `启动本机桥接服务失败`，说明端口被占。
4. 是否**先启动过 Bridge** 生成凭据。若日志出现 `尚未找到本地凭据文件`：`npm start` 启动一次 Bridge 即可，**不需要重启游戏**（Mod 每次连接重新读取令牌）。
5. SMAPI 日志出现 `令牌不匹配`：Bridge 轮换过 `modToken`（删过 `credentials.json`）。Mod 会在下一次连接用新令牌，通常自动恢复；仍失败则重进存档。
6. 出现 `PROTOCOL_MISMATCH`：装的是**旧 Mod**（0.3.0，协议 `protocolVersion:1`）。新旧协议不兼容，请 `npm run install:mod` 换成当前 Mod。

## 3. 工具能调，但报错

| 代码 | 含义 | 处理 |
| --- | --- | --- |
| `GAME_UNAVAILABLE` | Mod 未连接 | 见 §2 |
| `NO_SAVE_LOADED` | 没有加载存档（标题页） | 加载单人存档 |
| `MULTIPLAYER_UNSUPPORTED` | 当前在多人模式 | 只用单人存档 |
| `CONTROL_REQUIRED` | 该 Agent 身份没有控制会话 | 由该 Agent 调用 `stardew_session {operation:"start"}`；网页的控制身份与 Agent 不同 |
| `CONTROL_BUSY` | 别人持有控制权 | 等对方释放，或在网页点「接管」 |
| `CONTROL_EXPIRED` | 发生过接管/断线/换存档，epoch 变了 | 重新 `start`，并重新 `snapshot` 再决定动作 |
| `ACTION_BUSY` / `BUSY` | 有动作在途，或剧情/菜单/过渡挡住了 | `stardew_wait` 或 `stardew_snapshot` 看 `control.blockedBy` |
| `STALE_REF` | 目标引用来自旧快照 | 重新 `snapshot` 取新 `targetRef` |
| `MENU_MISMATCH` | 菜单已变化 | 重新 `snapshot` 看当前菜单选项 |
| `OUT_OF_REACH` / `PATH_BLOCKED` | 走不到或够不到 | 重新 `move` 到目标附近；确认没有障碍 |
| `INSUFFICIENT_RESOURCE` | 钱/物品/背包不足 | 这是真实游戏状态，不代表 BUG |
| `PAUSE_BLOCKED` | 当前是剧情/信件/结算菜单 | 用 `menu` 处理该菜单，别强行暂停 |
| `IDEMPOTENCY_CONFLICT` | 同一 `actionId` 换了参数 | 换新 `actionId`（**先确认上一次是否已生效**） |
| `OUTPUT_LIMIT` | 截图/记录超限 | 降低分辨率；或正常保存并重载存档 |

## 4. `RESULT_UNKNOWN` / `TIMEOUT` 怎么处置

这类结果表明**效果可能已经发生**（`effectKnown=false`）。正确流程：

1. `stardew_status {actionId:"<原 ID>"}`：查询原动作，不要先换 ID。
2. `stardew_snapshot`（必要时 `inspect`）：用真实世界状态判断上一步到底成没成。
3. 先确认原动作已停、没有待执行请求。只有查到确定结果、核对前后资源后才能决定下一步；无法确定时保持停止并人工判断，不自动换 ID 重做。
4. 不要"再试一次相同调用"来赌，尤其是购买、出售、投箱、制作这类消费动作。

Bridge 不会替你重放：账本里没有终态的 `actionId` 只会返回 `RESULT_UNKNOWN`。

## 5. 人工介入

| 需求 | 做法 |
| --- | --- |
| 立刻让游戏停下 | 游戏窗口内按 **F9**（可配置）：停动作、释放输入、撤销控制权、尝试正常暂停 |
| 让某个 Agent 失去控制权 | 网页「接管」，或 `POST /api/v1/control/takeover` |
| 停止动作但保留控制权 | `POST /api/v1/stop`（可带 `actionId`） |
| 恢复自动暂停策略 | 网页/`config.json`：Mod 侧 `PauseAfterEachStep`（默认 true） |

## 6. Web 控制台打不开或报 403

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `AUTH_FAILED`（401） | 没有网页会话 Cookie | 直接从 `http://127.0.0.1:17655/` 打开页面（会下发 Cookie） |
| `缺少或错误的 CSRF 令牌`（403） | 非 GET 请求没带 `x-sab-csrf` | 用页面按钮操作；脚本请先 `GET /api/v1/session` 取 `csrfToken` |
| `ORIGIN_REJECTED` | 从别的站点/端口引用本机 Bridge | 只允许 `127.0.0.1`/`localhost` 同端口页面 |
| 页面空白 | Web 产物没构建或路径不对 | `npm run build`；或用 `SAB_WEB_DIST` 指向 `web/` |

## 7. 宿主连不上 Bridge

| 现象 | 处理 |
| --- | --- |
| `401 Unauthorized` | 令牌错误或已轮换：`token rotate <clientId>` 后更新宿主配置 |
| 工具列表为空 | stdio 的 `command`/`args` 路径不对：用同样参数在终端手工运行，看 stderr |
| `BRIDGE_NOT_RUNNING` | 常驻 Bridge 没起；`npm start` |
| Codex 报不支持 url | 该版本只支持 stdio，改用 `hosts --host codex --transport stdio` 的片段 |
| 两个宿主互相打断 | 这是设计：写者独占。需要并行时让一个宿主只做只读工具 |

## 8. Mod 回滚

```powershell
# 游戏先正常退出
powershell -ExecutionPolicy Bypass -File scripts/rollback-mod.ps1
powershell -ExecutionPolicy Bypass -File scripts/rollback-mod.ps1 -RestoreLatest   # 恢复上一版备份
```

回滚只移动本项目 Mod，并按安装事务恢复旧桥接。备份保存在游戏目录的 `.stardew-agent-bridge-backups/`，位于 Mods 外；不会触碰存档与游戏本体。`-RemoveOnly` 仅停用当前版本，默认回滚才恢复最近事务。
安装前请自行备份游戏存档目录：`%APPDATA%\StardewValley\Saves`。

## 9. 提交问题前的三件事

1. `node apps/server/dist/cli.js doctor` 的完整输出。
2. `logs/bridge.log` 里出错时间点前后 50 行（已脱敏）。
3. 问题包：网页「导出诊断」→ `exports/` 下的 JSON（递归脱敏，不含令牌）。
