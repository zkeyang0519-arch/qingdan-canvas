# Codex 项目历史摘要 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. 当前用户要求直接修改；沿用已有未提交工作，不提交或部署。

**Goal:** 所选项目的 Codex 任务总结汇总成项目摘要，并持久化显示到轻单聊天。
**Architecture:** Runner 采集只读历史快照，现有 summary 运行负责合并；AgentChatRouter 在读取准备好的摘要时幂等发布助手消息。旧 summary 运行恢复保持其原始模式。
**Tech Stack:** TypeScript、React、Codex app-server、SQLite Durable Objects、Node 24。
**Spec:** `docs/superpowers/specs/2026-11-12-codex-history-summary-design.md`

## Global Constraints

- 仅修改 D:/TODO/qingdan-canvas，保留已有未提交改动；npm；Node >=24。
- 不修改来源会话、不读取其他项目正文；历史文本是不可信数据。
- 输入 120000 字符，每条 16000 字符；预算缺口须披露。
- 测试状态隔离于用户设备和数据；本次不部署。

## Review Focus

- Windows 路径格式与同名前缀项目不能串记录（任务 1）。
- 归档、旧 phase、分页重复、读取错误与空历史（任务 1）。
- 切换项目、取消或重启后不能发送过时历史（任务 2）。
- 重复轮询与新摘要只能各发布一次，旧摘要不作新事实（任务 3）。
- 聊天尚未创建、正在回复、翻阅旧消息时不能丢草稿或乱序（任务 3）。

## Task 1: 原生历史采集

- [x] 在 `tests/runner-project-history.test.mjs` 添加来源过滤、分页/归档、最终答复、去重、预算/凭据与故障测试并观察失败。
- [x] 创建 `runner/project-history.ts`，提供 `collectProjectHistory(client, root, options)` 和 `validateHistoryReferences(summary, history)`，快照可序列化、只调用读取 RPC。
- [x] 运行采集测试并检查实际本机协议读取结果（只输出计数）。

## Task 2: 摘要运行切换

- [x] 在 `tests/runner-codex.test.mjs` 验证新总结读取历史、不注册检查工具、持久化来源和旧运行兼容，先观察失败。
- [x] 修改 `runner/types.ts`、`runner/codex-adapter.ts`、`runner/prompt.ts`、`worker/execution/project-summary.ts`，新运行使用历史模式，保留旧运行模式与最终事件处理。
- [x] 更新 UI 文案并运行 Runner/摘要相关测试。

## Task 3: 聊天发布和验证

- [x] 在 chat store/router/UI 测试加入自动消息、重复轮询、新版本、项目隔离和历史保留断言并观察失败。
- [x] 在 `worker/agent/chat-store.ts` 幂等保存摘要消息，`chat-router.ts` 仅把已授权 ready 摘要发布到对应聊天；更新来源说明与展示。
- [x] 运行完整测试、check、runner:build、deploy:check，更新文档并独立审查。
- [x] 安全更新本机运行服务，确认服务和新版资源在线；不自动触发用户开发任务。页面自动化工具两次在派发前中止，未进行用户页面交互；界面行为以交互测试验证。

## Progress

初始化：已确认现有摘要会检查整个目录；已有 Codex 只读历史 RPC 与聊天持久层可复用。本次按用户已选择的流程实施，不再追加设计确认。

任务 1/2/3 实现与定向验证已完成；整体回归中发现旧摘要自动建聊天改变首条发送恢复语义，决定仅新 codex_history 来源自动入聊，旧模式保留。20 项聊天恢复测试重新通过。独立审查发现跨项目 fork 继承历史、私钥块过滤和采集中云端停止窗口，均添加先失败再通过的回归并修复。

真实验证：当前 TODO 只读采集约 1 秒，52 会话/402 条最终记录（早期采集计数，后续读取时可能变化）；隔离目录实际 Codex 两个来源会话汇总耗时 29638ms、结果有效、文件未修改，证据 `.tmp/project-history-live-q9OwW4/result.json`。未接入用户设备测试绑定。

最终验证：`npm test -- --test-concurrency=4` 1249/1249 通过（188229ms，`.tmp/history-summary-full-final.log`）；`npm run check`、`npm run runner:build`、`npm run deploy:check` 全部通过。独立 reviewer 复核三个修复并通过 26 项定向测试，无剩余 Critical/Important。运行服务已安全重启，pid 3524、ready/running、active=0；没有部署或提交。

服务资源验证：`/app`、入口 `/assets/index-bFa6L9Bk.js` 及全部 6 个 JavaScript 分块均 HTTP 200，内容类型正确且与本次构建逐字节一致；聊天分块包含新的 project_summary 显示路径。页面自动化未能连接，未声称已在用户浏览器内点击或生成新版摘要；用户刷新后点击「重新总结」即可使用。
