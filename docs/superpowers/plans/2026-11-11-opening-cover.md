# Opening Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved inspiration-wall cover from the arranged-mode branch into main without Agent changes.

**Architecture:** Wrap App at the browser entry point with a click-gated cover. Keep the App instance stable throughout entrance, preserve the URL, and bypass the dedicated OAuth consent route. CSS drives the transition, with a timer fallback and reduced-motion handling.

**Tech Stack:** Existing React 19, CSS, lucide-react, Vite, node:test, jsdom and esbuild; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-11-opening-cover.md`

## Global Constraints

- Use `feat/arranged-project-labels` and its existing isolated worktree.
- No Agent, Worker, migration, auth or arranged-mode behavior changes.
- Remove 「私人灵感集」; keep the selected magazine design and click requirement.
- Keep image assets local and preserve upstream attribution.

## Review Focus

- Invitations retain both query and hash until the existing app handles them.
- Consent links bypass the cover and retain the original authorization flow.
- Slow or failed images cannot block entry; animation has a bounded fallback.
- Keyboard focus and inert state transfer correctly into the app.
- Reduced motion still requires user input and a changed preference completes an active transition.

### Task 1: Cover, application gate and integration

**Files:**

- Create: `src/opening/OpeningGate.jsx`, `src/opening/OpeningCover.jsx`, `src/opening/opening.css`
- Create: `public/opening/` images and attribution
- Modify: `src/main.jsx`, `README.md`
- Test: `tests/opening-cover-ui.test.mjs`

**Interfaces:**

- `OpeningGate({ children })` gates the real app without changing its props or URL.
- `OpeningCover({ entering, onEnter })` renders the selected cover and one native entry button.

- [x] Write UI tests for click gating, fallback completion, reduced motion, image errors, route preservation and consent bypass.
- [x] Run `node --test tests/opening-cover-ui.test.mjs`; expect failure because the new gate is absent.
- [x] Implement the gate, cover, local assets and main entry integration.
- [x] Run the focused tests; expect all pass.
- [x] Check the real rendered application at desktop and mobile widths, keyboard entry and animation.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, and `git diff --check`; expect success.
- [ ] Review the entire change, commit on the arranged-mode branch, push, open a PR to main, merge the verified head and confirm the resulting remote commit.

## Verification record

- Baseline: 459 tests passed. Final: 467 tests passed, including 8 cover integration tests.
- Type checking and deployment dry run passed; no production deployment was run.
- Independent review found one issue with global keyboard shortcuts during the transition. A failing regression test reproduced it; the capture-phase guard fixed it and the full suite passed afterward.
- Isolated browser checks passed at 1366, 375, 320 and 667 landscape widths, including native keyboard and pointer entry, focus transfer, invitation URL preservation, reduced motion, and consent-route bypass. No runtime exceptions were observed.
- The final remote integration result is recorded in the task ledger after merging.
