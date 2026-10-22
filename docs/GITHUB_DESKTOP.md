# 使用本机 GitHub Desktop 管理项目

核对日期：2026-10-22。本机已经安装 GitHub Desktop 3.6.7 和 Git；这份说明针对已准备的独立本地规划仓库。没有检查 GitHub 登录状态，也尚未创建远程仓库。

## 1. 本地仓库现状

- 目录：`F:\星露谷\stardew-agent-bridge`
- 本地分支：`main`
- 内容：README、主计划、任务清单、接口草案、验收方案、本文及忽略规则。
- 本轮尚未创建提交、添加远程或上传文件。
- 旧 `agent-stardew` 目录保留原有代码和未提交改动；新项目的源码迁移在 BASE-01 后按清单进行。

后续提交、分支或发布完成后，在真实变更记录中更新状态；本文“本轮”状态描述的是规划交付时点。

## 2. 导入现有本地仓库

1. 打开 GitHub Desktop。
2. 选择 **File → Add local repository**。
3. 选择 `F:\星露谷\stardew-agent-bridge`，点击 **Add repository**。

也可以把这个 Git 仓库目录拖入 GitHub Desktop。导入已有目录的操作依据：[GitHub 官方说明](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop?platform=windows)。

应选择上述新目录。父目录还包含测试输出、发布包和旧仓库，不属于本次新项目的提交范围。

## 3. 首次提交

在 Changes 中查看规划文件和 `.gitignore`。本轮交付应只有规划资料；未来 BASE-01 再加入核对过的源码和许可证。

建议提交标题：`docs: 建立 Mod + Web + MCP 项目规划`。

确认文件后使用 **Commit to main** 创建本地提交。若软件要求作者身份，填写实际使用的 Git 提交身份；作者信息不由规划文件预填。

## 4. 发布到 GitHub

准备发布时，在 GitHub Desktop 选择 **Publish repository**，填写仓库名、简介、所属账号/组织及可见性。建议仓库名 `stardew-agent-bridge`，是否可用由实际发布检查确定。

可使用简介：

```text
A local SMAPI bridge, web dashboard, and MCP server for AI agents to observe and play Stardew Valley.
```

`Keep this code private` 控制仓库可见性，按自己的选择设置。发布操作会建立远程仓库并上传已提交内容；正式操作时确认账号与文件清单。流程依据：[GitHub Desktop 发布已有项目](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-an-existing-project-to-github-using-github-desktop?platform=windows)。

若已在网页创建了同名远程仓库，应按实际远程状态连接和同步，避免再次创建或覆盖已有内容。当前本地仓库没有需要删除的旧 remote。

## 5. 后续开发节奏

按 [任务清单](TASKS.md) 创建 Issues，标题保留任务 ID。每次提交说明具体行为变化和验证结果；阶段验收后再更新完成状态。`.gitignore` 是辅助规则，提交前仍要查看实际清单，不能仅凭忽略规则存在就认定所有文件适合公开。

首次开发从 BASE-01、BASE-02、BASE-03 开始；客户端接入和游戏行为通过后再制作预览发布包。
