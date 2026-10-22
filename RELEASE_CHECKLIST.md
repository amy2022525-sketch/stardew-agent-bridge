# 发布检查清单

用途：交回原 Codex 会话后，按本清单逐项确认，再决定是否上传/发布。**上传、建远端仓库、发 Release 不在本次交付范围内，由你执行。**

版本：0.1.0　日期：2026-10-22

## 1. 代码与构建

- [ ] 工作区干净：`git status` 无未提交改动
- [ ] `npm ci` 无报错（`package-lock.json` 与 `package.json` 一致）
- [ ] `npm run build` 通过（tsc -b + Web 类型检查 + esbuild）
- [ ] `npm test` 通过：34/34（10 套件）
- [ ] `scripts/build-mod.ps1 -GamePath "<游戏目录>"` 通过：0 警告 0 错误
- [ ] `scripts/pack.ps1 -GamePath "<游戏目录>"` 通过：生成 `release/StardewAgentBridge-0.1.0/` 与 `CHECKSUMS.txt`
- [ ] 发布目录内 `node server\bridge.mjs doctor` 与 `start` 正常，`GET /` 返回 200

## 2. 安全与隐私审计

- [ ] `git ls-files` 不含：`credentials.json`、`endpoint.json`、`ledger.sqlite`、`*.log`、`*.save`、`release/`、`artifacts/`、`node_modules/`
- [ ] 仓库内不含游戏 DLL：`git ls-files | Select-String -Pattern 'Stardew Valley.dll|StardewModdingAPI.dll|\.pdb$'`（应为空）
- [ ] 仓库内不含本机绝对路径（除文档示例中标注的占位）：`git grep -n "C:\\\\Users\\\\am202"`（应为空或仅示例）
- [ ] 仓库内不含真实令牌：`git grep -niE "[0-9a-f]{64}"`（人工确认命中项都不是令牌）
- [ ] Mod 无调试命令：`git grep -niE "warp|skipevent|giveitem|addmoney|resource" mods/`（应为空或无匹配语义）
- [ ] Bridge/Mod 都只绑定回环，且拒绝 `Origin`（`apps/server/src/bridge.ts`、`mods/.../BridgeServer.cs` 各有一处）
- [ ] 日志与问题包脱敏生效：导出的 zip 内不含令牌（人工打开确认）

## 3. 文档一致性

- [ ] `docs/PROTOCOL.md` 与实际代码一致（帧字段、命令表、错误码、限额）
- [ ] `docs/CLIENTS.md` 三宿主片段可直接使用（`cli hosts` 输出与文档一致）
- [ ] `README.md` 的快速开始能在干净机器上走通（顺序：build → Bridge → install-mod → 游戏 → doctor）
- [ ] `CHANGELOG.md` 覆盖本次全部变更与修复
- [ ] `NOTICE.md`、`LICENSE`、`docs/MIGRATION.md` 的上游归属与哈希仍准确
- [ ] `docs/EVIDENCE.md` 与 `docs/ACCEPTANCE.md` 的状态**没有**把未执行项写成通过

## 4. 实机验收（必须真实执行）

- [ ] A1 只读链路（7 个只读工具 + 双客户端同 `snapshotId`）
- [ ] A2 基础动作与资源操作（含重复 `actionId` 不重复扣钱扣物）
- [ ] A3 实时动作（钓鱼完成一次；战斗在 `minHealth` 停手）
- [ ] A4 控制权（第二写者被拒、租约到期、接管后旧请求失效、`F9` 生效）
- [ ] A5 故障（强杀 Bridge 后 5 秒内停手 + 自动暂停；重连后旧请求不生效）
- [ ] A6 存档流程（跨日、`stardew_load` 后旧 `targetRef` 报 `STALE_REF`、返回标题后 `NO_SAVE_LOADED`）
- [ ] A7 DSH / Codex / Claude Code 各完成一次短任务
- [ ] A8 Web 控制台真实连接下的渲染、时间线、接管、向导、诊断导出
- [ ] 结果已回填 `docs/ACCEPTANCE.md` §6，并把新证据追加到 `docs/EVIDENCE.md`

## 5. 发布物内容确认

- [ ] `release/StardewAgentBridge-0.1.0/` 只含：`mod/`（dll + manifest）、`server/`（bridge.mjs、stdio-adapter.mjs）、`web/`、`docs/`、`README(.en).md`、`LICENSE`、`NOTICE.md`、`CHANGELOG.md`、`CHECKSUMS.txt`、`启动说明.txt`、`install-mod.ps1`、`rollback-mod.ps1`
- [ ] 不含 `node_modules/`、`*.map`、`artifacts/`、`release/`、存档、游戏 DLL、凭据
- [ ] `CHECKSUMS.txt` 与实际文件一致（重新生成一次后比对）
- [ ] 版本号一致：`package.json`、`mods/StardewAgentBridge/manifest.json`、`cli version`、`/health.bridgeVersion` 均为 `0.1.0`

## 6. 上传前最后一步（由你执行）

- [ ] 决定仓库可见性与许可证（当前 MIT，`NOTICE.md` 已注明上游）
- [ ] 确认提交信息与 `CHANGELOG.md` 一致
- [ ] 准备好 release notes（可直接取 `CHANGELOG.md` 的 0.1.0 段 + 已知限制）
- [ ] 上传后用另一台机器/干净目录试装一次（走 §3 的快速开始）

## 7. 若某项不通过

1. 记录现象（检查项编号 + 命令 + 输出片段）到 `docs/EVIDENCE.md`「待执行/失败」区。
2. 修代码 → 从 §1 重跑；不要跳过 `npm test`。
3. 实机项失败：先 `F9` 停手 → `rollback:mod` → 恢复存档备份 → 再定位。
4. 任何一项不通过，都**不要**把该项标成通过：本清单的价值就在于它不撒谎。
