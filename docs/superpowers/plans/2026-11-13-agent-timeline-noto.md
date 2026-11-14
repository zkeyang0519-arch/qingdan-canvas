# Agent Timeline and Noto Sans Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; the user has explicitly selected the preview and requested direct implementation.

**Goal:** Apply the approved timeline layout and emphasis with locally hosted Noto Sans SC, keeping 14px body text.

**Architecture:** Keep the safe Markdown parser and execution controls. Add opt-in presentation grouping to assistant Markdown and styles for the existing execution records. Import locally hosted variable-font subsets rather than a remote runtime dependency.

**Tech Stack:** Existing React, CSS, esbuild, node:test, jsdom, Vite, Cloudflare.

**Spec:** `docs/superpowers/specs/2026-11-13-agent-timeline-noto-design.md`

## Global Constraints

- Body 14px / 350 / 1.85; emphasis 650; main heading 18px / 650; section heading 15px / 600.
- 80% message/composer width; user bubble only; centered dialogs retained.
- Preserve Markdown text and actual execution state. Never infer a completed status from a heading.
- Continue existing `feat/qingdan-mcp` workspace; snapshot touched files because prior changes are uncommitted.
- No real deployment, shared-state reset, login change, or commit.

## Review Focus

- A leading overall heading must remain outside the timeline; equal-level section headings retain their content order.
- Plain paragraphs, task lists, ordered/nested lists, code and tables retain their meaning.
- Partial streaming content and the terminal result use the same layout without losing text or replaying history.
- Font weights 350/600/650 must use the real variable font, with no missing local URLs.
- Narrow screens retain 14px body, 80% width and readable headings without horizontal overflow.

## Task 1: Local font and type hierarchy

Files: create `src/agent/noto-sans-sc.css`, `public/fonts/noto-sans-sc/*`; modify `src/agent/AgentWorkspace.jsx`, `src/agent/workbench.css`.

- [x] Download the exact preview distribution `@fontsource-variable/noto-sans-sc@5.3.1`; keep original subsets and OFL license, change CSS URLs to same-origin paths.
- [x] Replace the Agent font import, stack and visible license credit. Retain legacy MiSans files rather than deleting prior work.
- [x] Apply approved type weights, sizes and colors while keeping existing dialog/width rules.
- [x] Verify every CSS font URL resolves locally and font file signatures are WOFF2.

## Task 2: Assistant timeline presentation

Files: modify `ChatMarkdown.jsx`, `ChatPanel.jsx`, `StreamingText.jsx`, `ProjectConversation.jsx`, `ExecutionOutput.jsx`, `workbench.css`; test `tests/agent-chat-markdown.test.mjs`.

Interface: `ChatMarkdown({ text, timeline = false })`; `StreamingMarkdown` forwards the optional `timeline` prop.

- [x] Add and run meaningful failing tests for heading grouping and titled-list presentation; include opt-out, plain text, nested/task/ordered lists, tables/code, streaming update, and safe links.
- [x] Group sibling section headings without changing text; retain an overall heading as introduction. If there are no multiple sections, decorate only top-level unordered lists whose items all begin with a bold title. Ordinary lists keep their normal markers.
- [x] Opt in only assistant messages (normal, streaming, current and historical execution output).
- [x] Add neutral timeline nodes/lines and style the existing collapsible execution history. No new status inference or data protocol.
- [x] Run relevant Markdown/chat/streaming/conversation tests.

## Task 3: Verify the real application

- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, each with logs in `output/agent-timeline-noto-2026-11-13`.
- [x] Inspect the real app and an isolated rendering of the actual components for typography and responsive behavior without creating real chat jobs or altering device binding.
- [x] Review the task-only diff; obtain one independent review as required by the execution skill. Resolve important issues and verify their affected checks.
- [x] Record results and screenshots. Report local completion and relevant limitations only.
