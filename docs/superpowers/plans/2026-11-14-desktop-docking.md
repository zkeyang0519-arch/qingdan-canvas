# Desktop Docking Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved design inline. Track progress below.

**Goal:** Implement the approved draggable desktop capsule with top/left/right docking and position restoration.
**Architecture:** Pure docking geometry owns anchors and hit shapes. The Electron host owns cursor movement and persisted placement; a narrow preload bridge reports state to the existing React island, preserving its workspace and drafts.
**Tech Stack:** Electron 45.3.2, React 19, Node.js 24, node:test, jsdom, esbuild.
**Spec:** `docs/superpowers/specs/2026-11-14-desktop-docking-design.md`

## Global Constraints

- Work in D:/TODO/qingdan-canvas on feat/qingdan-mcp, as requested; preserve existing changes. No branch, commit, push or deployment needed.
- Use isolated profiles and test services for native verification; preserve the user's real account and Runner state.
- Keep task edits on the existing workspace sync path and preserve unsent drafts.

## Review Focus

- Repeated expand/collapse must not move the saved anchor (geometry tests).
- Negative display coordinates and changed work areas keep the visible surfaces reachable (geometry tests).
- Pointer release/cancel, rapid moves and unmount stop dragging; task/compose controls never start it (UI/host tests).
- Stale renderer layout requests must not undo a newly selected dock (host tests).
- Transparent space between side tab and panel must remain click-through (shape tests and native QA).

## Task 1: Geometry and window movement

Files: `desktop/docking.cjs`, `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/window-policy.cjs`, `tests/desktop-docking.test.mjs`, `tests/desktop-window-policy.test.mjs`.
Interfaces: docking exports `dockAtPoint(point, work, threshold=36)`, `placementAtPoint(point, offset, work)`, `fitDockBounds(anchor, layout, work)`, `dockShape(bounds, layout, anchor, work)`, `placementState(anchor, bounds, work, dragging)`; preload adds `getPlacement`, `onPlacement`, `drag(action, origin?)` with start/move/end/cancel only. Optional validated origin contains the initial local grab point, never a destination; the host reads the system cursor.

- [x] Add failing tests for snapping, anchoring, side shapes and guarded drag lifecycle.
- [x] Implement pure geometry and validated layout metadata, then wire host movement and persistence.
- [x] Run focused desktop policy and host tests; retain compatibility with capsule-only clients.

## Task 2: Desktop presentation and pointer handling

Files: `src/desktop/useDesktopPlacement.js`, `src/desktop/DesktopIslandWorkspace.jsx`, `src/island/DynamicIsland.jsx`, `src/desktop/desktop.css`, `tests/desktop-island-ui.test.mjs`.
Interfaces: hook returns placement state and root pointer handlers; DynamicIsland accepts optional desktop controls while ordinary web markup keeps existing behavior. Layout requests include dock and expanded metadata.

- [x] Add failing UI tests for side states, title dragging, controls excluded, draft preservation and drag cleanup.
- [x] Implement desktop header, side tabs, inward panels, measured layout and pointer capture with a 5px threshold.
- [x] Run desktop and web island UI regressions.

## Task 3: Integrated verification and usage

Files: `docs/desktop-island.md`, `docs/desktop-island-verification.md`, task-specific isolated QA scripts under `.tmp`.

- [x] Run an isolated Electron instance and exercise actual movement, docking, opening, draft retention and screen bounds.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check` and review relevant changes with fresh context.
- [x] Document verification and serve the updated desktop renderer through the existing local service.
- [ ] Activate the new main process after the user safely exits the old tray instance; preserve their input and account.

## Ledger

- Ruling: approved preview is the design review; execute directly without asking for another approval or execution choice.
- Ruling: use the requested existing Agent branch and keep changes uncommitted; copying unrelated dirty files into a new worktree would lose the user's active implementation context.
- Pre-flight: geometry → host → preload → React share dock/dragging/railOffset fields; no parallel implementers.
- Task 1: initial RED confirmed missing docking functions/handler; geometry, host policy and handoff regressions 29/29 passed.
- Task 2: initial RED confirmed absent dock state/drag handling; desktop and existing web UI regressions 32/32 passed.
- Final review: fresh read-only reviewer identified cross-display drop and successive-gesture IPC race. Both reproduced in tests before fixes. Selected work area now survives drop/cancel; one coalesced queue spans gestures.
- Native QA found pointer capture can be released by native window movement. Added RED→GREEN regression: end at current placement instead of rolling back; pointer capture begins only past threshold so ordinary tab clicks retain their target.
- Final targeted regressions: 50/50 passed. Isolated Electron checks cover all positions, pin/draft retention, tab clicks, sync ACK, eight expand/collapse cycles; separate process restart restores right dock x/y/size exactly.
- Native follow-up: preserve the initial grab offset so delayed first IPC cannot swallow the first part of a drag. Added failing host regression, then verified GREEN. Final Computer Use drag moved native bounds from (1024,375) to (1134,391), matching the requested (110,16) movement exactly; real system cursor, no synthetic override for this check.
- Final full suite: `node --test --test-concurrency=8 tests/*.test.mjs` 1553/1553 passed, 0 failures/skips. `npm run check` and final `npm run deploy:check` passed. No deployment occurred.
- Activation: user desktop PID3648 still runs the prior main process; CUA returned its window but no tray target, and the webpage is minimized. Requested safe tray exit via asynchronous user input; no force termination, reload or account change performed. Built renderer assets already match the live 8790 entry. Source service remains PID35364, same instance, ready=true.
