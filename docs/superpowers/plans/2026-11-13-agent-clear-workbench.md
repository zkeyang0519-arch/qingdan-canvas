# Agent Clear Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Apply the approved centered dialogs, clear workbench and lighter MiSans typography to Qingdan.

**Architecture:** Keep the existing React state and API boundaries. Share the dialog shell, add scoped presentation styles and answer actions, and group execution history without changing persisted events.

**Tech Stack:** React 19, Vite, lucide-react, Node test runner, jsdom.

**Spec:** docs/superpowers/specs/2026-11-13-agent-clear-workbench-design.md

## Global Constraints

- Work only in D:/TODO/qingdan-canvas; preserve all existing user changes.
- MiSans body 16px/350, emphasis 500, supporting UI 12–13px/400; self-host fonts.
- Preserve draft persistence, account/project isolation, approvals, stop and recovery.
- Do not start real Agent tasks, change account/device pairing, or deploy to production for visual verification.
- Validate with npm test, npm run check and npm run deploy:check.

## Review Focus

- Long summaries and project paths must fit compact and mobile dialogs.
- Native approvals above dialogs must retain focus and keyboard ownership.
- Quote must preserve existing drafts and never send automatically.
- Collapsed execution history must remain inspectable without hiding the latest/final answer or breaking follow-scroll.
- Fonts must be served locally and code blocks must remain monospace.

## Task 1: Font assets and shared presentation

Files: public/fonts/misans/*, src/agent/misans.css, src/agent/workbench.css, src/agent/AgentWorkspace.jsx.

- [x] Snapshot touched pre-existing files and run relevant existing UI tests as baseline.
- [x] Bundle pinned MiSans 350/400/500 webfont subsets with license/source notice.
- [x] Apply the selected shell, typography, assistant/user contrast and responsive layout through scoped CSS.
- [x] Verify browser-computed fonts, glyph loads and narrow-screen overflow; no CSS mirror tests.

## Task 2: Centered dialogs

Files: src/agent/WorkspaceDrawer.jsx, AgentWorkspace.jsx, MemoryPanel.jsx, workbench.css.

- [x] Reuse WorkspaceDrawer for settings, preserve accessible labels and native approval handling.
- [x] Add heading descriptions/sizes; format memory tabs, list and editor within the centered surface.
- [x] Run existing modal and workspace tests; inspect all five toolbar entries in the browser.

## Task 3: Conversation readability and actions

Files: src/agent/AnswerActions.jsx, ChatPanel.jsx, ProjectConversation.jsx, ExecutionOutput.jsx, tests/agent-answer-actions.test.mjs, tests/agent-execution-stream-ui.test.mjs.

- [x] Write behavior tests for copy failure/success, quote callbacks, execution history disclosure and live-result continuity; observe missing behavior fail.
- [x] Add reusable copy/quote controls, preserving source text and draft limits.
- [x] Add actual project/summary context chips and lighter composer treatment.
- [x] Group earlier execution steps, show descriptive step labels, preserve logs/current output/receipts.
- [x] Run related chat/stream tests and check keyboard interactions.

## Task 4: Verification and review

- [x] Run npm test, npm run check, npm run deploy:check; keep logs under output/agent-clear-workbench-2026-11-13.
- [x] Inspect local current account without changing binding; verify desktop/mobile and real history plus centered dialogs.
- [x] Request one independent review of only this task's changes, address important findings and verify fixes.
- [x] Refresh local built assets and report final state and any material limitations.

## Execution record

User explicitly requested direct application after selecting the previews, so implementation proceeds without another approval gate. Work in place because the current uncommitted project contains the selected UI's real functionality; do not commit or move unrelated changes. This plan's output directory records the baseline and checks.
