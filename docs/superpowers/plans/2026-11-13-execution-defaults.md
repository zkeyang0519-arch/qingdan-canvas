# 执行默认设置 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation.

**Goal:** 落实已批准预览，右栏为 1.2 倍，并使用完整实时模型目录。
**Architecture:** 在 BoundChecklist 维护一次默认偏好和模型目录，弹窗与提交复用它；完成恢复走现有画布 update 与来源历史。
**Tech Stack:** React、Lucide、现有 Codex Runner、Node test、JSDOM。
**Spec:** ../specs/2026-11-13-execution-defaults-design.md

## Global Constraints

保持当前 feat/qingdan-mcp 已有未提交工作，不创建脱离当前修改的新 checkout，不提交混合变更。无真实部署或额外计费执行。沿用既有请求恢复与同步协议。

## Review Focus

1. 完整模型数组（含列表末尾项），无硬编码白名单。
2. 保存的模型失效、目录失败、快速模式不支持时不会静默回退。
3. 账号或绑定切换隔离偏好，取消编辑不保存。
4. 提交回执丢失重试保留原设置。
5. 完成点击不触发删除/选择，锁定与恢复失败保留原状态。

### Task 1: 默认执行设置
- [x] 先补 Checklist UI 回归：完整模型目录/保存取消/失败重试/账号隔离/实际 intent 与恢复参数。
- [x] 创建 ExecutionSettings.jsx、execution-settings.js/css。复用 WorkspaceDrawer、useWorkspaceDraft、/codex/models；接入 ChecklistPanel 提交。
- [x] 移除 ChatPanel 旧控件，保留已有恢复，更新相关交互回归。
- [x] 跑定向测试通过。

### Task 2: 已完成恢复与布局
- [x] 先补完成行点击回归、锁定/失败、未绑定页面恢复，纯画布恢复函数确保仅解除 done。
- [x] 经 AgentWorkspace 传递 CanvasWorkspace 的 onReopenTodo，恢复复用版本化 update。完成项按钮承载正文，删除独立。
- [x] workbench.css 360/408/336px，输入区移除快捷键提示，预览同步 1.2。
- [x] 跑定向测试通过。

### Task 3: 验证
- [x] npm test、npm run check、npm run deploy:check，构建与 dry-run 不发布。
- [x] 真实组件隔离浏览器预览核对桌面/手机、模型与完成恢复；独立最终审查。
- [x] 记录验证与实现边界。

## Ledger

用户本轮确认即实施授权；保持既有脏工作区增量修改，避免丢失前序已接受内容。前置接口核对：模型设置 schema 已被 intent、快照、thread/start 和 turn/start 支持，无需重写协议。

审查发现并修复：读取模型目录前核对 `/status.runnerId` 与绑定电脑，避免显示另一台电脑的目录。状态失败或模型失效时明确提示，不静默换模型。目录分页回归覆盖三页全部返回；UI 回归使用 37 个模型验证最后一项。

真实组件预览：`output/execution-defaults-live`，本地 4797，当前运行服务来自同内容的 `.tmp/execution-defaults-browser`。1440px 视口右栏实测 408px；390px 手机设置可用。3 项模拟执行后已完成总数变成 4 且自动收起，点击完成正文恢复为可勾选待办。Codex 原生目录只读查询返回全部 8 项，未创建真实执行。

最终验证：`node --test --test-concurrency=4 tests/*.test.mjs` 全量 1400/1400；`npm run check`、`npm run runner:check`、`npm run deploy:check` 与 `git diff --check` 通过。首次默认并发 `npm test` 的两处失败为 Windows 临时文件 EPERM/EBUSY，相关文件单独重跑 26/26，通过降低并发的最终全量运行也全部通过。未部署或重启用户绑定服务。
