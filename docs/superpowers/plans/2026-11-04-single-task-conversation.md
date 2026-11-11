# 单条任务会话修复计划

> **For agentic workers:** 使用 superpowers:executing-plans，在当前会话逐项实现和验证。

**Goal:** Codex 用户消息只显示当前任务或补充原文，最终自然语言回复；轻单继续收到可信关联的结构化结果。

**Architecture:** 用户文本、后台任务上下文和结果回执分开。新会话注册 `qingdan_report_result` 动态工具；Runner 校验并持久化回执，直到对应轮次结束才进入验收。旧会话继续兼容原 JSON 结果。

**Tech Stack:** 现有 TypeScript Runner、Codex app-server 0.166.0-alpha.6、Node test/SQLite，不新增依赖。

**Spec:** 本次用户截图与要求：第四步派单应发送单个自然语言任务，而非整份请求/模板。

## Global Constraints

- 工作目录 `D:/TODO/qingdan-canvas`，保留已有未提交的 UI 和文档改动。
- 保留权限、只读总结、任务身份、去重和恢复逻辑；只处理当前任务。
- 任何报告缺失、无效、跨轮次或执行失败都不得判为成功。
- 在当前检出修复并本机验收，不部署生产、不改写旧聊天记录。

## Review Focus

- 自然语言输入中不得丢失原始指令，也不得混入元数据或执行模板。
- 项目上下文和验收标准仍可供模型使用，但不拼成用户聊天正文。
- 回执在轮次结束前不能触发完成；取消/失败不得采用先前成功报告。
- 断线恢复能读取持久化报告；补充新轮次不能复用上一轮报告。
- 旧 JSON 回执身份必须继续严格校验；没有有效回执时等待处理。

## Task 1: 分离会话输入和回执

Files: `runner/prompt.ts`, `runner/codex-adapter.ts`, `runner/types.ts`, `tests/runner-codex.test.mjs`, `tests/fixtures/fake-codex.mjs`。

- [x] 更新边界测试，验证单条原文、背景单独传递、自然语言最终答复和结构化报告，先观察失败。
- [x] 实现 `runContext`、回执工具及静态执行规则；输入只用原文。
- [x] 校验动态回执，按轮次保存；完成与恢复时读取，兼容旧 JSON。
- [x] 覆盖无报告/无效报告、回执后失败、重启恢复及补充轮次。
- [x] 运行针对性测试、完整测试、Worker/Runner 类型检查和部署 dry run。
- [x] 本机新建独立验收任务，读取真实消息和结果；记录实测边界。

## Execution notes

- 根因已确认：`runPrompt` 添加用户可见模板；`turn/start.outputSchema` 强制最终回复 JSON。
- 当前检出已有三处其他改动，修复集中在 Runner 与其测试，避免触及既有 UI 工作。
- 复核发现并修复：新会话不得用最终 JSON 替代回执；补充要求之前的回执不得完成之后的工作；恢复会话时重传执行规则。
- 完成通知只含摘要，改为读取完整顺序历史核对回执，不依赖同轮缓存判断完成。保留核实期间完成通知到达的竞争保护。
- 真实协议要求独立上下文名称匹配 `[a-z][a-z0-9_]{0,63}`，已采用 `qingdan_task` 并添加协议边界回归。
- 完整测试 599/599 通过，Worker/Runner 类型检查与打包 dry run 通过；真实新任务和重启后的同会话补充说明均通过。详见 `docs/agent-single-task-verification-2026-11-04.md`。
