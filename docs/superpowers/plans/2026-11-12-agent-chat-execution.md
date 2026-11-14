# Agent Chat Execution Implementation Plan

> Use superpowers:executing-plans for integration and superpowers:dispatching-parallel-agents for the isolated backend and renderer modules.

**Goal:** 一次提交项目待办，并在项目聊天中流式展示与控制执行。

**Architecture:** 新 executionMode: project 复用现有运行协议，将全部来源任务和项目摘要保存在一次运行快照。ChatPanel 合并讨论消息和运行记录；BatchPanel 控制器复用恢复及停止能力，移除工作区右侧进度卡。

**Tech Stack:** React、CSS、TypeScript、Cloudflare Durable Objects、Codex app-server、node:test/jsdom。

**Spec:** `docs/superpowers/specs/2026-11-12-agent-chat-execution-design.md`

## Constraints and review focus

- 保留已有未提交修改；不提交、不部署、不操作真实待办和绑定。
- 重复提交、刷新、切换项目必须保持运行身份和原请求回执。
- 停止确认之前不显示已停止；完成结果不能误勾选未验收待办。
- 流式文本保留分段、命令和最终输出；禁用任意 HTML 与危险 URL。
- 窄屏、长代码与表格不挤出输入区；阅读历史时不强制滚到底。

## Task 1: 项目整组执行与可见事件

- [x] 在后端测试中验证全部来源任务只产生一次 turn/start、项目摘要进入同一快照、旧执行模式仍可用。
- [x] 实现 `executionMode: 'project'` 和 `run.submission`；保留来源锁定及停止验证。
- [x] 扩充 output.delta 的 channel/itemId/title/phase，输出命令与文件变更。

## Task 2: 聊天渲染与普通回复流

- [x] 实现 `ChatMarkdown({text})`，验证安全链接、代码转义、复制和未完成代码围栏。
- [x] 普通回复持久化 `job.partialText`，增加带作用域和幂等校验的 cancel 操作。

## Task 3: 工作区整合

- [x] 验证提交进入聊天、开始切换停止、停止只针对当前运行、断线后仍可核对。
- [x] 移除右侧执行区和上方当前事项框，双气泡合并时间线，Markdown 与执行事件流式展示。
- [x] 运行相关交互回归、全量 npm test、npm run check、runner:check 和 npm run deploy:check。
- [x] 浏览器检查桌面与窄屏，记录结果与限制。

验证记录：`docs/agent-chat-execution-verification-2026-11-12.md`。
