# Qingdao Always Docked Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with test-driven-development; perform one independent review at the end.

**Goal:** Every settled Qingdao capsule attaches to the top, left or right edge based on the display center.
**Architecture:** Update pure docking classification and normalize saved anchors. The Electron host enforces settled docking for drag completion, restoration and display changes; React retains the existing temporary drag presentation.
**Tech Stack:** Electron 45.3.2, React 19, Node.js 24, node:test.
**Spec:** `docs/superpowers/specs/2026-11-14-qingdao-edge-snap.md`

## Global Constraints

- D:/TODO/qingdan-canvas, feat/qingdan-mcp, no branch changes, commits or deployment.
- Preserve unrelated edits and the user's running account, profile and Runner.
- No changes to task synchronization, stored credentials, or handoff authorization.

## Review Focus

- Drops near the center, on classification boundaries and below the center must always resolve to an edge.
- Old free/missing dock preferences must not resurrect floating capsules on restart.
- Cross-monitor drops and display removal must stay attached to a reachable edge.
- Cancel, stale renderer layout events and repeated expansion must preserve the settled dock/anchor.
- Pinned panels, drafts and native hit shapes must still work after changing dock.

## Task 1: Enforce settled docking

Files: `desktop/docking.cjs`, `desktop/main.cjs`, `src/desktop/useDesktopPlacement.js`, `tests/desktop-docking.test.mjs`, `tests/desktop-island-ui.test.mjs`.

Interfaces: `dockAtPoint(point, work)` returns top/left/right; `restorePlacement(saved, work)` returns collapsed docked bounds; existing `placementAtPoint`, `fitDockBounds`, `placementState` and IPC contracts stay compatible. `free` remains only a temporary drag state.

- [x] Add failing geometry/host tests for center regions, exhaustive sample points, legacy restoration, cancellation, stale resize requests and multiple displays.
- [x] Run `node --test tests/desktop-docking.test.mjs` and verify failures reflect the previous optional-edge behavior.
- [x] Implement normalized center classification, restored anchors and host normalization; change initial renderer placement to top.
- [x] Run docking, window-policy, handoff-host and desktop UI tests; expect all pass.

## Task 2: Verify and document

Files: `README.md`, `docs/desktop-island.md`, isolated harness/evidence under `.tmp/qingdao-edge-snap-verification`.

- [x] Verify native inside-screen drops onto all three edges, pin/draft retention, legacy startup restoration and another restart.
- [x] Update usage: dragging chooses an edge from the center, with no settled free position.
- [x] Independent review of this change only, with previous versions saved under `.tmp/qingdao-edge-snap-before` for an exact diff.
- [x] Run `npm test -- --test-concurrency=8`, `npm run check`, `npm run deploy:check`; expect zero failures, dry-run only.

## Ledger

- User's latest instruction supersedes the earlier preview's free-floating setting. Work directly in the original Agent branch as already authorized.
- Pre-flight: geometry returns the same dock/position shape consumed by the native host and React; no new IPC or account state.
- The explicit request authorizes implementation; keep the focused plan inline without a further approval round. Preserve source snapshots and verification evidence because this workspace is intentionally uncommitted.
- RED confirmed center drops still returned free, legacy show remained detached, and no restorePlacement existed. After implementation, focused docking/policy/handoff/UI tests passed 49/49.
- One old policy test asserted a freely floating y=200 and reset y=12. Updated it to the newly required top edge y=0; its stable horizontal anchor assertions remain.
- Native verification passed 15 checks with isolated profile/account/HTTP/WS: all direction regions (including lower half), pinned drafts, right-side restart, legacy free-position restart, and a real CUA mouse drag that settles back against the left edge. Automated cross-region cases inject only the host cursor coordinates; the actual renderer gestures, native windows and profile persistence run normally. CUA refuses destinations beyond the small target window, so the physical-pointer case is a short drag within that window.
- Independent fresh review found no actionable Critical/Important findings and independently passed the same 49 tests. Physical multi-monitor removal and mixed DPI remain unverified on this single-screen native run; negative-coordinate and cross-monitor behavior is covered by geometry/host tests. No changes to those Electron coordinate APIs were needed.
- `npm run check` and `npm run deploy:check` passed; deployment was a dry run only. Full regression passed 1556/1556, 0 failures or skips, using `npm test -- --test-concurrency=8` (186.6 seconds).
- Source service remains the same ready PID35364 with no active tasks; the live 8790 entry serves the newly built assets. All isolated native test windows were closed. The user's older desktop process remains untouched; loading the new native snapping rule requires one safe tray exit and reopening via the webpage's 轻岛 button.
