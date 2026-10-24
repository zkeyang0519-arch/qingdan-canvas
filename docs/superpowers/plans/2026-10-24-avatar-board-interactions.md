# Avatar and Board Interactions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. Track completion with checkboxes.

**Goal:** Expand avatar selection to the editor edges and make board entry immediate while requiring a one-second canvas pause to exit.

**Architecture:** Keep the current crop model and export pipeline. Reuse the canvas drag hover timer for entry/exit intent, commit ownership on release, and show scoped visual feedback.

**Tech Stack:** React, canvas, Node test runner, JSDOM, existing geometry/model helpers.

**Spec:** `docs/superpowers/specs/2026-10-24-avatar-board-interactions-design.md`

## Constraints and review focus

- Crop reaches 320 px diameter without distorted images; output remains 256×256 WebP quality 0.85 and source limit 20 MB.
- Test landscape/portrait, off-center selection, zoom changes and actual export coordinates.
- Board entry has no delay; exit requires 1000 ms outside frames with 6 screen px motion tolerance. Movement, re-entry and release clear the timer.
- Test notes, checklists, images, multiple selected members, different zooms, locked targets and full boards.
- Keep grouping, collection, Alt, cancellation, source snapshot merging and existing board geometry unchanged.

## Task 1: Board entry/exit

Files: `src/canvas/Canvas.jsx`, `src/canvas/canvas.css`, `tests/canvas-board-drag.test.mjs`.

- [x] Add behavioral drag tests for immediate entry, successful/early exit, motion reset, re-entry, board transfer, cancellation and existing grouping rules; run them and observe expected failures.
- [x] Reuse `groupTimer` with explicit enter/exit hover state; determine exit eligibility outside visible frames; only reparent on pointer release after the delay.
- [x] Add receiving-board feedback and exit progress copy, including reduced-motion styling; run focused tests.

## Task 2: Avatar circle bounds and export

Files: `src/auth/avatar-crop.js`, `src/auth/avatar-image.js`, `src/auth/AvatarCropper.jsx`, `src/auth/avatar-crop.css`, `tests/avatar-crop.test.mjs`.

- [x] Resolve the optional whitespace preference and record it; write failing geometry/export/UI tests for expansion to all four stage edges.
- [x] Change selection bounds and recenter on enlargement; preserve zoom controls and exact preview/export agreement.
- [x] Run focused avatar tests, full `npm test`, `npm run check`, `npm run deploy:check`, formatting/diff checks, browser verification and independent final review.

## Execution record

- Start: clean `develop` at `1537622`; continue in the existing user workspace. No new dependencies or production writes.
- The user's two concrete interaction requirements authorize implementation; routine implementation choices are recorded above, without an additional design approval gate.
- User confirmed preserving the original aspect ratio with transparent margins inside the circle.
- Observed the new behavior fail before implementation: nine board cases and four crop cases. After implementation, the focused suites passed; additional boundary cases cover early release, oversized entries and portrait export.
- Final `npm test`: 281 passed, zero failed. The initial run had a collaboration WebSocket timeout while build and browser checks were active; the isolated integration suite then passed 13/13 and the subsequent full run passed. No backend or timeout changes were made.
- `npm run check` and `npm run deploy:check` passed. The build retained the existing large-chunk warning.
- Browser verification used the real components with disposable in-memory data: the crop circle reached all four editor edges with transparent margins; confirmation produced a local avatar preview; immediate board entry and early-release retention were visible. The one-second deadline and movement resets are covered by controlled-clock gesture tests.
- Local screenshots: `.tmp/avatar-full-circle-preview.png` and `.tmp/board-interactions-preview.png`. The temporary preview tab and server were closed after verification.
- Independent final review found no actionable defects. Formatting and diff checks completed before handoff. Changes remain local; no database migrations were added, and nothing was pushed or deployed.
