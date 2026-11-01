# v0.30 发布验证说明

日期：2026-11-01。发行标签 `v0.30`，程序、Mod、镜像与附件版本 `0.3.0`。这是预览发行，不改变各实机项目的验收状态。

## 1. 来源与版本

本版接续 `cee49723eb9bca650ac8f521f86e92c99c9a0913` 的双模型执行器实现。原始交付、独立复核与缺陷修复见 [交付报告](../DECISION_EXECUTOR_HANDOVER_REPORT.md) §12；旧报告中的“不提交/不打包”描述仅反映相应验收结束时的状态。

发布准备统一所有 workspace、协议常量、Mod 清单与程序集、Docker 标签和备份元数据默认版本。`package.json.releaseTag` 显式记录 `v0.30`，避免把两段公开标签当作 npm/SMAPI 的版本格式。发行工作流仍只向指定草稿预览版上传，最终公开由发布者执行；不修改旧 tag 和已发布资产。

## 2. 本机验证记录

本版已重跑以下本机检查，使用 Node v22.23.1。自动化使用临时数据根、Mock Mod 和假模型；实际 Mod 编译仅引用本机合法游戏程序集，不启动游戏。

| 检查 | 本版结果 |
| --- | --- |
| lockfile | `npm ci --dry-run --ignore-scripts --no-audit --no-fund` 通过；真实干净安装另由最终 CI 执行 |
| typecheck / build | 全部 exit 0；Web 同时构建 |
| Node 全量 | 297 项：292 通过、0 失败、5 项平台跳过 |
| C# 隔离测试 | 189 checks 通过 |
| Windows 安装/回退 fixture | 17 checks 通过，使用临时假游戏目录 |
| 实际 net6.0 Mod 编译 | 合法本机游戏 1.6.15.24356 / SMAPI 4.5.2 编译；0 警告、0 错误；只分发本项目 DLL |
| Windows 完整包 | 56 文件、55 条文件校验和、15 项仓库外便携检查；HTTP/stdio 均 33 工具 |
| Docker bundle | 三个服务入口、运行时相对导入、资源与许可布局验证通过；不等同于镜像/游戏验收 |
| 合成私密文件负例 | 前轮有效校验和下，注入 decision/secrets.json 被拒绝；本轮继续要求禁止文件检查 |
| 部分真实浏览器 Mock 验收 | 前轮通过首次模型配置、跨 Agent 管理/归属、停止锁、目标条件进度、390px 无溢出、标题转义、Tab 导航与刷新；未重做真实模型/游戏 |

前轮证据在发布者本机 `F:\星露谷\work\decision-audit-20261101`，本轮日志与哈希在 `F:\星露谷\work\release-v0.30-20261101`；这些路径是发布者复核记录，不是用户安装所需路径，也不会作为运行数据进入发行包。

## 3. 跨平台 CI 与附件门槛

发布前必须检查最终同一来源提交的 `Bridge checks`、`Docker image checks`、`Prepare Linux release asset` 和 `Prepare Docker release assets` 全部成功。运行 ID、链接、提交哈希、每个资产摘要与镜像来源记录在发行附件 `RELEASE_MANIFEST.json`，不能拿前一提交的绿灯代替本版结果。

- Windows 包含 Bridge、Web、同版 Mod、说明和许可证，需要系统 Node >=22.13。
- Linux 完整包复用经过 SHA-256 校验的同版独立 Mod，下载并核验官方 Node 22.13.0；在 Linux runner 实际执行包内运行时与 19 项便携检查。不得使用 `--allow-unverified-runtime` 制作正式 full 包。
- 三个 Docker 镜像均从最终同一提交构建，记录 sourceCommit、版本、镜像 ID、archive 摘要与构建运行链接；实际上传的 game-runtime 需通过无游戏 noVNC 桌面/鉴权/Origin 检查。
- Windows/独立 Mod/Linux 的程序集必须一致；所有包检查禁止文件与校验和。运行数据、真实密钥、游戏程序集、SMAPI 安装文件和存档不得分发。
- 共 12 个附件：Windows、Linux、独立 Mod、Docker 源码、三镜像、三份镜像证明、发布清单和外层 SHA256SUMS。源码归档来自最终 Git 提交，不能从带缓存的工作目录随意压缩。

## 4. 未验收的部分

- 真实执行模型 API/本地模型、DSH/Codex 真实派单与游戏动作闭环。
- 真实游戏作物照料、补水、F9/断线/重启故障、完整长期连续运行及效率评估。
- Linux 桌面游戏与 G01–G10，Docker 游戏/SMAPI/存档及动作，MP1 两个真实客户端 H01–H11。
- [执行器验收矩阵](DECISION_EXECUTOR_ACCEPTANCE.md) 中仍标记 `not_run` 或 `partial_pass` 的其余场景；矩阵保留独立复核时的逐项快照，新的发行构建结果以本版清单另行记录。

以上不因发布而变为通过。预览下载面向愿意在测试存档和有限模型预算下试用的用户；不满足旧稳定版实机门槛。
