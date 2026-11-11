# Ungrouped Label Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the previously unmanageable ungrouped tab editable and deletable, change the opening wordmark to TODO, and merge the arranged branch into main.

**Architecture:** Reuse existing grouping, trash and synchronization operations. Expose them through page-level helpers and the existing tab dialogs; omit only empty virtual tabs from navigation while retaining the blank input surface.

**Tech Stack:** Existing React, JavaScript, CSS, node:test, jsdom and esbuild. No dependencies or schemas added.

**Spec:** `docs/superpowers/specs/2026-11-11-ungrouped-labels-design.md`

## Global Constraints

- Work on `feat/arranged-project-labels` in its existing isolated worktree; merge is explicitly authorized.
- Preserve object/task identity, contents, positions, child hierarchy, lock and read-only protections.
- Do not alter Agent, Worker, database or synchronization protocol.
- Do not perform any deletion against the user's live data during verification.

## Review Focus

- Deleting loose contents must not include other pages, boards or the default collection dock.
- Locked descendants of a loose collection block the entire destructive/grouping operation.
- Remote locking, movement or deletion while a dialog is open must be revalidated at commit.
- Renaming a non-selected ungrouped tab must not steal selection; selecting the renamed tab must retain its tasks.
- An empty workspace must still allow additions, restoration and keyboard navigation.

### Task 1: Manage the virtual tab and update the cover wordmark

**Files:** Modify `src/canvas/arranged-model.js`, `src/canvas/ProjectTabs.jsx`, `src/canvas/ArrangedWorkspace.jsx`, `src/opening/OpeningCover.jsx`, `src/auth/auth.css`, `README.md`; test `tests/arranged.test.mjs` and `tests/arranged-order-ui.test.mjs`.

**Interfaces:** `canDeleteChecklistPage(state, boardId, pageId) -> boolean`, `deleteChecklistPage(state, boardId, pageId) -> state`, `renameChecklistPage(state, boardId, pageId, title) -> state`.

- [x] Add regression tests for ungrouped deletion/restore, last-tab empty/add, rename identity/positions/persistence/selection, read-only and changing locks; exercise real UI and model operations.
- [x] Run `node --test tests/arranged.test.mjs tests/arranged-order-ui.test.mjs`; expect failures for the missing ungrouped operations.
- [x] Implement the helpers, expose both menu actions with guarded dialogs, hide empty virtual tabs, change both visible QINGDAN strings to TODO, and apply `margin: 16px 0` to the account-settings scrollbar track.
- [x] Run the focused tests; expect all pass. Inspect the actual browser menu, empty state and cover text using isolated fixtures.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, `git diff --check`; expect success. Request a fresh read-only whole-change review and fix material findings with regression evidence.
- [ ] Commit and push the arranged branch, create and merge a PR with the verified head, and verify main plus automatic Cloudflare build.

## Verification record

Baseline 467 tests passed; 8 added regression tests reproduced the missing behavior before implementation. Focused suite: 43/43. Final full suite: 475/475. Type checking, deployment dry run, and whitespace check passed. Independent review found no actionable Critical, Important, or Minor issues.

Isolated browser checks verified native menu deletion, confirmation, restoration, rename/selection, blank-workspace additions, a 375px menu layout, both TODO wordmarks, and an actually scrollable profile dialog whose computed track margins are 16px 0 16px 0. No runtime exceptions were observed. No real user records were changed. The final remote merge and build results are recorded in the task ledger.
