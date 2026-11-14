# Agent Interface Refresh Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this focused UI task.

**Goal:** 整理 Agent 工作区并向用户提供可核对的本机预览。

**Architecture:** 在当前工作树上修改展示结构和限定于 Agent 的样式。保留所有请求、状态、权限与执行回调，用既有交互测试与实际浏览器验证布局。

**Tech Stack:** React、CSS、lucide-react、Node 24、现有 node:test/jsdom。

**Spec:** `docs/superpowers/specs/2026-11-12-agent-interface-refresh-design.md`

## Global Constraints

- 只改 D:/TODO/qingdan-canvas 内当前项；保留已有未提交改动。
- 不发布、不接管设备、不执行真实待办、不启动后续项。
- 纯展示调整不增加镜像实现的断言；运行已有交互覆盖。

## Review Focus

- 390px / 320px 窄屏工具可达、没有横向溢出。
- 长摘要可滚动，输入区保持可见；长项目名正常截断。
- 切换项目、记忆/摘要/设置抽屉和键盘焦点保留。
- 当前执行、审批、错误和恢复入口保持可见。
- 空项目、空聊天、已有消息均呈现清楚。

## Task 1: 界面与验证

**Files:** `src/agent/AgentWorkspace.jsx`、`src/agent/ChatPanel.jsx`、`src/agent/agent.css`；验收记录 `docs/agent-interface-refresh-verification-2026-11-12.md`。

- [ ] 保存当前三个文件的基线并运行工作区/聊天/清单/批次已有测试。
- [ ] 调整导航、工具分组、消息与空状态结构，保留 accessible names 和回调。
- [ ] 调整三栏、阅读宽度、列表/进度、输入区与响应式样式。
- [ ] 运行 `npm test`、`npm run check`、`npm run deploy:check`，核对退出码及完整日志。
- [ ] 在浏览器检查真实页面与隔离预览的桌面、窄屏和关键交互，保存证据。
- [ ] 相对基线审查本轮 diff，记录实际结果与局限，提交轻单回执。
