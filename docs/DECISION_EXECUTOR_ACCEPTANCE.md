# AI 任务助手验收矩阵（DECISION EXECUTOR D1）

> **状态口径：** `auto_pass` = 自动化已覆盖并运行通过；`browser_mock_pass` = 真实浏览器连接隔离 Bridge/Mock/Fake 后验证通过；`partial_pass` = 只覆盖该行注明的部分；`not_run` = 尚未验证。
> 本轮（2026-11-01）已运行 `npm run typecheck`、`npm run build`、`npm test`、`npm run test:mod`，全部通过；
> 未调用真实模型、未操作真实游戏；已补部分真实浏览器验收。DXG/DXE 全部保留 `not_run`，DXW 按实际覆盖范围分别标记，不能把 Mock 的通过扩大为实机通过。
>
> 执行者请先读 `scripts/*`，确认命令与本文一致；证据目录建议 `artifacts/decision-<日期>/`。

## 0.1 本轮自动化结果（Mock/Fake，仅证明代码契约）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 全部 TS 项目引用 + Web `--noEmit` |
| `npm run build` | 通过 | 含 Web 打包 |
| `npm test` | 297 用例：292 通过 / 0 失败 / 5 跳过 | 包括新增的原生 soil/补水、权限/引用/慢响应回归 |
| `npm run test:mod` | 通过（189 checks） | 含 `WorldIdentityTests` |
| `npm run test:installer` | 17 checks 通过 | 仅临时 fake-game fixtures |
| Mod 真实游戏 DLL 编译 | 0 警告 / 0 错误 | 不代表已加载游戏 |
| 独立源树 `npm ci` + build | 通过 | 真实安装 36 packages，无原 node_modules |
| Windows 完整包 + portable verifier | 15 项通过，33 工具与 53 个文件 | 在仓库外验证；不含 Linux 运行结论 |
| `docker:bundle` | 通过 | bundle 入口/文件验证；镜像构建和运行仍 not_run |
| 其中 `decision-e2e.test.js` | 通过 | 真实 Bridge + Mock Mod + 本地假模型 HTTP：派单→规划→选壶→浇两格→`verified_observation` 完成；任务工具未被转发给 Mod |

这些结果**不能**替代真实模型连通性、真实游戏动作与界面验收；`decision-e2e` 用的仍是 Mock Mod 与固定决策脚本。

## 0. 前置

```powershell
npm ci
npm run build
npm test          # 含 tests/dist/decision-*.test.js
npm run test:mod  # 含 WorldIdentityTests
npm run test:installer
```

本轮新增的自动化源码：`decision-contracts`、`decision-store`、`decision-policy`、`decision-provider`、`decision-runner`、`decision-memory`、`decision-config`、`decision-api`。
环境变量（示例）：`SAB_HOME=<隔离测试目录>`、`STARDEW_GAME_PATH=<测试游戏目录>`。
测试数据根必须是临时目录，绝不指向玩家真实存档或 `%LOCALAPPDATA%\StardewAgentBridge`。

## 1. 契约与权限（源码：`tests/src/decision-contracts.test.ts`）

| ID | 场景 | 断言 | 源码 | 状态 |
| --- | --- | --- | --- | --- |
| DXC-01 | 合法 submit 经 HTTP MCP / stdio 路由 | accepted 不 completed；新工具不出现在 Mod 请求记录 | `decision-contracts`、`mcp-http`（待扩展） | not_run |
| DXC-02 | 同 requestId 同输入重试 | 同 taskId；只占一个槽、一个 run | `decision-store` 幂等用例 | auto_pass |
| DXC-03 | 同 requestId 不同内容 | `TASK_IDEMPOTENCY_CONFLICT`，无第二次动作 | `decision-store` | auto_pass |
| DXC-04 | 同时两次 submit | 恰好一个 accepted，另一个 `EXECUTOR_BUSY` | 待补（需并发脚手架） | not_run |
| DXC-05 | 超长/多余字段/非法数值 | 校验拒绝；模型与 Mod 调用数为 0 | `decision-contracts` | auto_pass |
| DXC-06 | 注入 ownerClientId/transport/actionId | 不能冒名或建立内部身份 | `decision-contracts`、`decision-policy` | auto_pass |
| DXC-07 | 其他客户端 get/update/cancel | 不泄漏内容、不改变原任务 | 待补（需双客户端） | not_run |
| DXC-08 | 无 CSRF/错误 Origin/Bearer 调 secret API | 拒绝；凭据文件不变 | `web-mcp` 扩展 | not_run |
| DXC-09 | revision 冲突与纯进度更新 | 定义 CAS 冲突；stateVersion 变化不误报 | `decision-store`、`decision-api`（配置 CAS） | auto_pass |
| DXC-10 | 禁用/未授权/未配置模型 | 明确拒绝；原工具仍可用 | `decision-api`（默认关闭）、`mcp-http` 扩展 | not_run |

## 2. Runner、控制与取消（`tests/src/decision-runner.test.ts`）

| ID | 场景 | 断言 | 源码 | 状态 |
| --- | --- | --- | --- | --- |
| DXR-01 | 规划+选择+浇水+完成 | 多步串行经 GamePort；机器证据成立 | `decision-runner` 第 1 例 | auto_pass |
| DXR-02 | 控制权被占用 | 不 takeover、不驱逐原会话 | `decision-runner` 控制占用例 | auto_pass |
| DXR-03 | 模型等待时 pause/cancel | 立即 fence；无新动作 | `decision-runner` 第 3 例 | auto_pass |
| DXR-04 | HTTP 不理 abort，迟到回答 | 结果 discarded；写调用不增加 | 待补（GatedProvider 变体） | not_run |
| DXR-05 | 校验后派发前接管 | 旧 run 被拒；新控制者不被 end/stop | 待补 | not_run |
| DXR-06 | F9 提升 epoch | 停止锁生效；主模型不能直接 resume | 待补（Bridge 级） | not_run |
| DXR-07 | Web takeover 时 Mod 离线 | 模型循环已停止 | 待补（Bridge 级） | not_run |
| DXR-08 | 取消时动作效果未知 | 保留 actionId；不换 ID 重做 | `decision-runner` 第 2 例 | auto_pass |
| DXR-09 | RESULT_UNKNOWN 回执 | `needs_review`；后续写动作 0 次 | `decision-runner` 第 2 例 | auto_pass |
| DXR-10 | 暂停恢复 | 新 run/session；累计预算保留 | 待补 | not_run |
| DXR-11 | 退出时模型/动作在途 | 有界退出；关库后无写入 | 待补 | not_run |
| DXR-12 | 世界/角色/日期变化 | 旧上下文失效；不向新存档派发 | `decision-runner` 跨日 + 实例变化例 | auto_pass |
| DXR-13 | 相同失败连续三次 | `TASK_STALLED`；无无限重试 | `decision-runner` 卡点例 | auto_pass |
| DXR-14 | 反复 snapshot / 反复 plan | 模型与重规划预算生效 | `decision-policy`（预算部分）+ 待补 | not_run |
| DXR-15 | 模型思考耗尽租约 | 停止；读请求不续租 | 待补 | not_run |
| DXR-16 | 暂停未确认 | 不以 `requested:true` 当 paused | 待补（Bridge + MockMod） | not_run |

## 3. 策略、预算与完成判定（`tests/src/decision-policy.test.ts`）

| ID | 场景 | 断言 | 源码 | 状态 |
| --- | --- | --- | --- | --- |
| DXP-01 | 提出禁用/不存在工具 | 本地拒绝；不做模糊匹配 | `decision-policy`（工具交集/白名单） | auto_pass |
| DXP-02 | 通用 use/interact 绕过保护 | 参数级拒绝；无副作用 | `decision-policy` water-only + custom 准入例 | auto_pass |
| DXP-03 | 运行中政策收紧 | 下一步与迟到回答都遵守新限制 | 待补 | not_run |
| DXP-04 | 执行模型试图提高预算 | 无可调用接口 | `decision-policy`（交集） | not_run |
| DXP-05 | usage 缺失/超时 | unknown 不是 0；预留不释放 | `decision-policy` 第 2 例 | auto_pass |
| DXP-06 | 重试/纠错/多 run 累计 | 全部计入同一任务 | 待补 | not_run |
| DXP-07 | 体力/生命/时间阈值 | 停止并保留已完成 | 待补 | not_run |
| DXP-08 | 完成目标缺格/截断 | 缺格 `unverifiable` | `decision-contracts` 完成判定 | auto_pass |
| DXP-09 | finish 无事实/引用他人证据 | 不能 verified | 待补 | not_run |
| DXP-10 | manual_review 审核 | 标 `main_reviewed`，不改收据 | 待补 | not_run |
| DXP-11 | 跨日复用昨日 watered | 条件失效 | `decision-contracts`、`decision-runner` 跨日例 | auto_pass |
| DXP-12 | 请求路径围栏 | 明确能力不支持 | 配置校验用例待补 | not_run |

## 4. Provider（`tests/src/decision-provider.test.ts`）

| ID | 场景 | 断言 | 源码 | 状态 |
| --- | --- | --- | --- | --- |
| DXV-01 | Responses 完整正文 | 只取 message/output_text | `decision-provider` | auto_pass |
| DXV-02 | Responses incomplete/failed | 不产生动作 | `decision-provider` | auto_pass |
| DXV-03 | Chat 正常响应 | 字段/URL/JSON 提取正确 | `decision-provider` | auto_pass |
| DXV-04 | length/content_filter/refusal/tool_calls | 拒绝不完整或异协议输出 | `decision-provider` | auto_pass |
| DXV-05 | 有/无 `/v1` 的 baseUrl | 只追加一次路径 | `decision-provider` | auto_pass |
| DXV-06 | max_tokens / max_completion_tokens | 只发选定字段 | `decision-provider` | auto_pass |
| DXV-07 | 401/403/429/5xx | 分类与重试预算正确 | `decision-provider`（401） | not_run |
| DXV-08 | 超时/超 512 KiB | 中断读流；无泄漏动作 | `decision-provider` 传输边界 | auto_pass |
| DXV-09 | 302 到其他 origin | 不跟随 | `decision-provider` | auto_pass |
| DXV-10 | 未授权私网/元数据地址 | 连接层拒绝 | `decision-provider`（地址策略） | auto_pass |
| DXV-11 | 错误体含 Key/提示词 | 日志/SSE/问题包无敏感串 | `decision-provider`（摘要脱敏）+ 待补 | not_run |
| DXV-12 | JSON 外包解释/多 JSON | 严格拒绝；一次纠错 | `decision-contracts` | auto_pass |
| DXV-13 | 换 provider/密钥旧响应迟到 | 旧 generation 不动作 | 待补 | not_run |
| DXV-14 | 保存配置/doctor/打开页面 | 自动模型请求数为 0 | 待补（计数 FakeProvider） | not_run |

## 5. 数据、作用域与记忆（`decision-store` / `decision-memory`）

| ID | 场景 | 断言 | 源码 | 状态 |
| --- | --- | --- | --- | --- |
| DXS-01 | 新旧/未来/损坏库 | 只持锁启动迁移；不删坏库 | `decision-store`（新库/恢复） | not_run |
| DXS-02 | dispatch_prepared 后崩溃 | 不补派发 | 待补 | not_run |
| DXS-03 | intent 后收据前崩溃 | 保持未知，不重放 | 待补 | not_run |
| DXS-04 | 游戏成功但任务库写失败 | ledger 证据可查；派发 1 次 | 待补 | not_run |
| DXS-05 | 清理后重用旧 requestId | tombstone 阻止 | `decision-store`（幂等） | auto_pass |
| DXS-06 | 超 JS 安全整数/负 Int64 | 保真且拒绝非规范串 | `WorldIdentityTests`（C#） | auto_pass |
| DXS-07 | 旧 Mod 无 worldIdentity | 持久模式拒绝；ephemeral 隔离 | 待补 | not_run |
| DXS-08 | 克隆存档同 ID 不同 profile | 记忆不串用 | 待补 | not_run |
| DXS-09 | 过期位置/数量记忆 | 不作当前事实 | `decision-memory` 过期用例 | auto_pass |
| DXS-10 | 记忆含越权指令 | 不改工具/预算/endpoint | `decision-memory` 末例 | auto_pass |
| DXS-11 | 跨 owner/跨 world 检索 | 权限过滤先于排序 | `decision-memory` 私密用例 | auto_pass |
| DXS-12 | 尺寸上限 | 分页/截断明确；不丢未决动作 | 待补 | not_run |

## 6. 接线、平台与包

| ID | 场景 | 断言 | 方式 | 状态 |
| --- | --- | --- | --- | --- |
| DXI-01 | 标准 MCP/legacy/stdio 同输入 | 同一 TaskService、同一幂等结果 | `mcp-http`、`web-mcp` 扩展 | not_run |
| DXI-02 | wait 超时/客户端取消 | 只结束等待 | 待补 | not_run |
| DXI-03 | SSE 断线/重启 | 全量恢复；不重复执行 | 待补 | not_run |
| DXI-04 | 原有 29 工具回归 | 定义与行为未被误改 | `contracts`、`control` | auto_pass |
| DXI-05 | Linux 私密权限 | 本应用目录 0700、文件 0600 | `platform-paths` + 手工 `stat` | not_run |
| DXI-06 | dataRoot 优先级 | 新文件跟随同一根；doctor 不建库 | Windows doctor 关闭/启用两种配置已验文件不变；Linux 未验 | partial_pass |
| DXI-07 | bundle 在源码目录外启动 | 无遗漏资产；无强制 API 依赖 | Windows 完整包 15 项独立启动验证；Linux 未验 | partial_pass |
| DXI-08 | 包内 fake-secret | 验证阻止私密文件进入 | Windows 审计包注入合成 `decision/secrets.json` 并重算有效校验和，验证器因私密文件拒绝；`forbidden-package-verification.json` | auto_pass |
| DXI-09 | Docker 持久目录/本地模型 | 用数据卷；不假设容器 localhost 等于宿主 | `docker-*` + 手工 | not_run |
| DXI-10 | 联机派单 | 明确拒绝；旧联机不变 | `multiplayer` 扩展 | not_run |

## 7. Web 界面（真实浏览器，原协作者执行）

| ID | 操作 | 验收点 | 状态 |
| --- | --- | --- | --- |
| DXW-01 | 全新数据根打开页面 | 默认关闭；假模型调用数为 0；MCP 显示 33 工具 | browser_mock_pass |
| DXW-02 | 配置服务与密钥后重开 | Key 不回显、不在 localStorage/HTML | not_run |
| DXW-03 | FakeProvider 提交浇水任务 | 真实 Bridge/Mock/Fake 完成，显示机器证据与 4 次模型/3 次写动作 | browser_mock_pass |
| DXW-04 | 思考中暂停/取消/接管 | Web 管理其他 Agent 的任务；停止锁生效且恢复受限；归属不变 | browser_mock_pass |
| DXW-05 | 两标签页改配置/任务 | 冲突提示，不覆盖 | not_run |
| DXW-06 | 断 SSE / 重启 Bridge | 自动刷新真实状态 | not_run |
| DXW-07 | 390px 与键盘 | 390 CSS px 无横向溢出；按钮在屏内，Tab 可到复核输入；窄屏全部表单交互未跑 | partial_pass |
| DXW-08 | 目标/记忆/错误含 HTML | 标题中的 img/onerror 按文本显示，未创建 img；记忆/错误插值未逐项实测 | partial_pass |
| DXW-09 | 完成证据与未知用量 | verified 与已知/未知用量已观察；main_reviewed 交互未跑 | partial_pass |
| DXW-10 | 关闭网页保留 Bridge | 已启动任务继续；重开可见结果 | not_run |

## 8. 实机验收（原协作者，全部 not_run）

| ID | 操作 | 必须保留的证据 | 状态 |
| --- | --- | --- | --- |
| DXG-01 | 单人测试存档，DSH 派单浇水 | MCP 提交结果、模型调用/动作收据、前后快照 | not_run |
| DXG-02 | Codex 用同一契约派单 | 客户端身份不同、无专用适配 | not_run |
| DXG-03 | 水壶空、范围内有水源 | 真实补水后再浇水 | not_run |
| DXG-04 | 触发体力阈值 | 已完成/未完成地块与停止原因对应 | not_run |
| DXG-05 | 真实 F9 与 Web 接管 | 动作停止、无后续写入、旧响应失效 | not_run |
| DXG-06 | 游戏断线/退出后重启 Bridge | 任务待复核、不自动操作存档 | not_run |
| DXG-07 | 复制存档分 profile | 记忆隔离、旧上下文不能执行 | not_run |
| DXG-08 | 兼容 API + Responses 各一 | 各自可用记录；使用测试预算 | not_run |
| DXG-09 | Windows/Linux/Docker 各一次 | 分平台记录；不用 Mock 代替 | not_run |
| DXG-10 | 已启用联机时派单 | 明确拒绝；原联机不被破坏 | not_run |

## 9. 效率评估（可选，全部 not_run）

| ID | 方法 | 输出 | 状态 |
| --- | --- | --- | --- |
| DXE-01 | 同存档副本、同地块，直接模式 vs 双模型 | 总耗时、可核验完成率、主模型调用次数 | not_run |
| DXE-02 | 固定任务，全量上下文 vs 有界上下文 | token/延迟/失误 | not_run |
| DXE-03 | 断线/取消/超预算故障实验 | 不重放、不越权、停止延迟 | not_run |

## 10. 证据记录模板

| 字段 | 示例 |
| --- | --- |
| 日期 / 平台 / HEAD | 2026-11-xx / Windows 11 / `<git rev-parse HEAD>` |
| 数据根 | 临时目录路径（不含玩家真实路径） |
| 命令与退出码 | `npm test` → 0 |
| 关键日志 | `artifacts/decision-.../bridge.log`（已脱敏） |
| 截图 | DXW/DXG 对应 PNG |
| 结论 | pass / fail / not_run + 原因 |

> 禁止把 FakeProvider 的调用次数当作真实模型效率；禁止用 C# 纯函数测试代替 Mod 加载或真实游戏行为。
