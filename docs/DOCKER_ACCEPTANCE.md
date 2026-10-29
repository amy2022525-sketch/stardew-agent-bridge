# Docker 验收记录

当前发布为预览版。按下面条目记录实际日志/截图路径和执行时间；未执行必须标 `not_run`。真实游戏需要合法 Linux 输入，不使用 Windows 游戏目录充数。

| 组 | 检查 | 本次记录 |
| --- | --- | --- |
| B01 | npm ci、build、Node 测试、C# 隔离测试、安装器 | 见 RELEASE_VALIDATION_20261029.md |
| I01 | 三个镜像 build；非 root、只读、布局、metadata、许可证 | 见同报告 |
| C01 | bridge-runtime Compose 启动、live/ready、独占锁 | 见同报告 |
| C02 | HTTP initialize/tools/list/status；无令牌 401 | 见同报告 |
| C03 | exec -T stdio initialize/tools/list；Web 配置和外部端口 | 见同报告 |
| W01 | Web Docker 状态、原生隐藏、390px、MCP 面板 | 见同报告 |
| D01 | 无游戏虚拟桌面、VNC 密码握手、Host/Origin 拒绝 | 见同报告；与游戏验收分开 |
| T01 | 离线备份、verify、恢复、故障注入、篡改拒绝 | 见同报告，临时数据 |
| G01 | Linux 游戏+SMAPI 输入预检、Mod 原生构建 | not_run（缺完整 Linux 游戏输入） |
| G02 | 真游戏标题页 awaiting_save；noVNC 可视游戏画面 | not_run |
| G03 | 独立测试档正常加载、快照/截图、移动/选择/浇水 | not_run |
| G04 | DSH/Codex/Claude Code 中至少一个真实 Agent 完成短任务 | not_run |
| G05 | 真人接管、断线释放输入、退出和备份后正常重启 | not_run |

D01 使用 Xvfb/Openbox 的辅助桌面单独验证，只证明 noVNC 链路；不能将合成桌面/Mock Mod 的成功写进 G 组。多人容器不在本表范围内，真实双客户端见 MULTIPLAYER_ACCEPTANCE.md。
