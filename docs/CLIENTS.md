# 把 Bridge 接进 Agent 宿主

提供 **DSH**、**Codex CLI**、**Claude Code** 的配置模板，均通过标准 MCP 连接。HTTP/stdio 已用 SDK 测试；DSH Desktop 0.2.0-rc.2 + MCP连接器 0.2.70 已验证 stdio 连接及真实模型只读调用。三种宿主各自完成游戏短任务仍待验收；模板不代表所有宿主版本已经实测。当前结果见 [复核报告](../FINAL_TEST_REPORT.md)。

生成片段（推荐，令牌自动签发并写好本机路径）：

```powershell
node apps/server/dist/cli.js hosts --host <dsh|codex|claude-code> --transport <http|stdio> [--client-id <id>]
node apps/server/dist/cli.js matrix        # 支持矩阵
```

网页顶部 **MCP 连接** 入口提供本机服务地址、配置生成、复制、下载与通道检测。选好 Agent、HTTP/stdio 和连接名称后生成配置；不同 Agent 使用不同名称。DSH、Codex 和 Claude Code 默认采用本机 stdio；「其他 MCP 客户端」提供常见的 mcpServers JSON 格式，也可按其内容填写 URL/Bearer 或本地进程设置。

**检测本机 MCP 通道** 使用独立的网页检测身份完成真实 MCP 握手、工具发现及 `stardew_status` 只读查询。检测成功说明本机通道可用；把配置导入 Agent 后，还应由 Agent 自己调用一次工具。页面下方的「客户端最近调用」显示实际请求的客户端名称、传输和时间；网页检测记录不会混入其中，空闲客户端也不能据此断言持续在线。配置生成会复用同名连接的令牌，不会在重复点击时将其轮换。

## 0. 选择传输方式

| 宿主 | HTTP（推荐） | stdio |
| --- | --- | --- |
| DSH | 模板；导入入口需按安装版本核对 | 上述桌面版本已验证 28 工具发现与只读调用 |
| Codex CLI | 模板：`url`；需按安装版本核对 | 模板：`~/.codex/config.toml` |
| Claude Code | 模板：`.mcp.json`（`type: "http"`）或 `claude mcp add` | 模板：`.mcp.json`（`type: "stdio"`） |

HTTP 与 stdio **指向同一个常驻 Bridge、同一份业务核心**；stdio 适配器只做转发，不复制业务逻辑。因此：

- 同一个游戏实例、同一份动作账本、同一个控制权；
- 无论用哪种传输，写操作都受"单一写者 + lease + epoch"约束；
- 宿主先启动或后启动都行，Bridge 没起来时宿主会报连接失败，起来后重连即可。

## 1. DSH

1. 启动 Bridge：`npm start`（保持运行）。
2. 生成片段：`node apps/server/dist/cli.js hosts --host dsh --transport http`。
3. DSH 里打开 **设置 → MCP 连接器 → 导入 JSON**，粘贴输出（`mcpServers` 段），或使用连接器界面的「自定义 HTTP」逐项填写：名称 `stardew`、URL `http://127.0.0.1:17655/mcp`、鉴权 `Bearer` + 令牌。
4. 在会话里确认工具出现：`stardew_status`、`stardew_snapshot`…
5. 第一次让 Agent 动手前，让 Agent 调用 `stardew_session {operation:"start"}`。网页获取控制权属于网页自身身份；它与 Agent 会竞争同一个写入权。

stdio 变体：`--transport stdio`，把 JSON 导入 DSH 的「自定义 stdio」。片段里的 `command`/`args`/`env` 已填好本机绝对路径与 `SAB_HOME`；令牌不进命令行，适配器从 `SAB_HOME` 下的凭据文件读取。

已验收版本也可从侧栏 **MCP连接器 → 添加连接 → 导入 JSON** 导入 stdio 片段，选择全局或指定 Workspace 范围；随后在「已安装」确认 `stardew` 已连接，并在标准模式调用 `mcp__stardew__stardew_status`。只复制输出的 JSON 段，不包含 `#` 开头的提示文字。游戏处于标题页时，`stardew_snapshot` 返回 `NO_SAVE_LOADED` 是明确的业务结果。

## 2. Codex CLI

HTTP（版本支持时）：

```toml
# ~/.codex/config.toml
[mcp_servers.stardew]
url = "http://127.0.0.1:17655/mcp"
bearer_token_env_var = "SAB_TOKEN"
```

```powershell
$env:SAB_TOKEN = "<token issue 输出或网页显示>"   # 每次启动会话前设置
codex
```

stdio（老版本也能用）：

```toml
[mcp_servers.stardew]
command = "<node.exe 绝对路径>"
args = ["<仓库或发布目录>\\adapters\\stdio\\dist\\index.js"]   # 发布包里是 server\\stdio-adapter.mjs
env = { SAB_CLIENT_ID = "codex", SAB_HOME = "C:\\Users\\<你>\\AppData\\Local\\StardewAgentBridge" }
```

片段里的 `command` / `args` / `SAB_HOME` 由 `hosts --host codex --transport stdio` 自动填好，直接复制即可。

## 3. Claude Code

```powershell
# 项目级文件 .mcp.json
node apps/server/dist/cli.js hosts --host claude-code --transport http
# 仅将输出的 JSON 配置段合并到 .mcp.json，保留已有服务器；或使用下面的 CLI 命令。
claude mcp add --transport http stardew http://127.0.0.1:17655/mcp --header "Authorization: Bearer <token>"
```

`.mcp.json`（HTTP）：

```json
{
  "mcpServers": {
    "stardew": {
      "type": "http",
      "url": "http://127.0.0.1:17655/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

stdio 变体把 `type` 换成 `"stdio"` 并给 `command`/`args`/`env`（同 Codex 的 stdio 片段）。

## 4. 验证接入（三种宿主通用）

1. `node apps/server/dist/cli.js doctor`：应显示 `Mod 连接=是`。
2. `node scripts/smoke.mjs`：走真实 HTTP MCP，打印工具数、`stardew_status`、`stardew_snapshot`。
3. 宿主里调用 `stardew_status`：能看到同一份 Bridge 状态（客户端列表里会出现宿主自己的 `clientId`）。
4. 两个宿主同时连着，分别调用 `stardew_snapshot`：核对游戏实例、世界代次和未变化的资源。每次观察会生成新 `snapshotId`，不要求两个 ID 相同。
5. 让 A 宿主 `stardew_session start`，B 宿主直接调写工具：应得到 `CONTROL_BUSY`/`CONTROL_REQUIRED`，证明写者独占。

## 5. 令牌与身份

- 每个宿主建议一个 `clientId`（`dsh`、`codex`、`claude-code`）；账本与回执按客户端可区分。
- 同一 `clientId` 的多个聊天连接可能自动使用该身份唯一活动会话。需要独立控制者时签发不同 clientId/令牌，并显式传入 `controlSessionId`；没有自动的聊天级隔离。
- 令牌只在 `token issue`/`token rotate` 时显示一次；`credentials.json` 是唯一持久位置。
- 轮换：`node apps/server/dist/cli.js token rotate dsh`，然后更新宿主配置里的令牌。**Mod 无需重启**；Bridge 会热加载凭据文件。
- 吊销：`token revoke dsh`；`GET /api/v1/clients`（网页）可看当前客户端。

## 6. 常见接入问题

| 现象 | 原因与处理 |
| --- | --- |
| 宿主报 `Unauthorized` | 令牌不对/已被轮换；重新 `token issue` 并更新宿主配置 |
| 工具列表为空 | 用了 stdio 但 `command` 路径不对；先用同样参数手工跑一次，确认 stderr 里的错误 |
| `BRIDGE_NOT_RUNNING` | 常驻 Bridge 没启动；`npm start` |
| `GAME_UNAVAILABLE` | Mod 未连接：游戏没走 SMAPI 启动、Mod 未安装、或存档未加载 |
| `CONTROL_REQUIRED` | 该 Agent 身份没有控制会话；先由它调用 `stardew_session start` |
| 写操作总 `CONTROL_EXPIRED` | 刚才发生过接管/断线/换存档；重新 `stardew_session start` 并重新观察 |

## 7. 宿主短任务（接手后按此顺序做）

验收一个宿主是否真的可用，最短路径是"读 → 控 → 写 → 释放"四步，不用等完整游玩流程：

| 步骤 | 让宿主做的事 | 通过标准 |
| --- | --- | --- |
| 1 读 | 调用 `stardew_status` | 返回 Mod 连接状态、版本、控制权，无 `isError` |
| 2 观察 | 调用 `stardew_snapshot` | 有存档时返回真实地图/角色；无存档时返回明确错误码（不是空对象） |
| 3 控 | 调用 `stardew_session`（`operation: start`） | 拿到 `controlSessionId` 与 `epoch` |
| 4 写 | 调用 `stardew_move` 走一格再 `stardew_wait` | 位置变化与回执一致，网页时间线出现记录 |
| 5 释放 | 调用 `stardew_session`（`operation: end`） | 之后旧 `epoch` 的写请求被拒（`CONTROL_EXPIRED`） |

出现 `unknown` / `effectKnown=false` 时：先 `stardew_status` 或原 `actionId` 查询，**不要**换新 ID 重放。

## 8. 配置模板（复制即用）

HTTP（推荐，多客户端共用同一 Bridge）：

```json
{
  "mcpServers": {
    "stardew": {
      "type": "http",
      "url": "http://127.0.0.1:17655/mcp",
      "headers": { "Authorization": "Bearer <客户端令牌>" }
    }
  }
}
```

stdio（宿主只支持子进程；令牌从数据根读取，不写进配置）：

```json
{
  "mcpServers": {
    "stardew": {
      "command": "<包根>/runtime/node",
      "args": ["<包根>/server/stdio-adapter.mjs"],
      "env": { "SAB_CLIENT_ID": "dsh" }
    }
  }
}
```

源码树里开发时，`command` 用 `node`，`args` 用 `apps/server/dist/cli.js` 同目录的 `stdio-adapter`：
`node <仓库>/adapters/stdio/dist/index.js`。用 `node apps/server/dist/cli.js hosts --host <宿主> --transport <http|stdio>`
生成与当前机器路径一致的模板，避免手抄路径出错。

## 9. 宿主兼容矩阵

| 宿主 | 传输 | 状态 | 备注 |
| --- | --- | --- | --- |
| DSH（MCP 连接器） | stdio | 已实测（Windows，0.2.0-rc.2） | 28 工具、`stardew_status`、标题页 `NO_SAVE_LOADED` |
| DSH（MCP 连接器） | HTTP | 待验证 | 令牌 + 地址方式，建议优先验证复用与接管 |
| Codex CLI | stdio / HTTP | 模板已交付，待验证 | 配置片段见 §2 |
| Claude Code | stdio / HTTP | 模板已交付，待验证 | 配置片段见 §3 |
| 其他 MCP 客户端 | HTTP | 通用模板可用，待验证 | 需要支持 Bearer 头或可用 stdio |

Linux 上的宿主接入与 Windows 完全同构（同样的 28 个工具、同样的错误码），差异只是包内路径与数据根：
见 [LINUX_INSTALL.md](LINUX_INSTALL.md) 与 [PLATFORM_MATRIX.md](PLATFORM_MATRIX.md)。
本表"待验证"的行必须由原协作者在真实宿主上执行 §7 的短任务后才能改为通过。