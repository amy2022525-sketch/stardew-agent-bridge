# 决策执行器 fixture

本目录只存放**合成**测试数据。

- 不含真实 API Key、Cookie、玩家存档、角色 ID 或本机绝对路径；
- `tests/src/decision-fixtures.ts` 提供 FakeProvider / FakeGamePort / 合成快照；
- provider 传输测试使用 `127.0.0.1` 上的临时假 HTTP 服务，不访问真实模型服务；
- 数值、坐标、任务标题均为示例，不代表任何真实存档。
