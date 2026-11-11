# Opening Preparation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan inline.

**Goal:** Prepare the destination behind the cover and reveal it only after readiness and an explicit entry action; merge the arranged branch into main.

**Spec:** `docs/superpowers/specs/2026-11-11-opening-preload-design.md`

**Architecture:** A renderless preparation context reports page and lazy-content readiness to the existing gate. App and workspace report their real bootstrap state. The gate owns retry, rendering delay, timeout and interaction isolation.

## Global Constraints

- Work in the existing `feat/arranged-project-labels` worktree. User has authorized push and merge.
- Preserve consent bypass, invitation/account protections, background draft isolation and sync protocol. Do not alter Agent work.
- Use isolated browser fixtures; never change live records. No direct production deploy command.

## Review Focus

- Cached or empty local state must not masquerade as the first server snapshot.
- Retry/unmount must ignore late async responses and preserve invitation destinations.
- Preparation reports must handle lazy fallback mounting/unmounting and route changes without leaving a stale ready flag.
- Hidden content must retain measurable layout without accepting keyboard, clipboard, pointer or focus input.
- Errors and stalled requests must remain recoverable; reduced motion must not bypass readiness or explicit action.

### Task 1: Prepare and reveal the destination

**Files:** `src/opening/OpeningGate.jsx`, `src/opening/OpeningCover.jsx`, `src/opening/OpeningPreparation.jsx`, `src/opening/opening.css`, `src/App.jsx`, `src/CanvasWorkspace.jsx`, `src/sync/useRoomWorkspace.js`, `src/canvas/ArrangedWorkspace.jsx`, `tests/opening-cover-ui.test.mjs`, `README.md`.

**Interfaces:** `OpeningPreparation({ id = "page", status, error, children })`; context `report(id, state | null)`; workspace `startupReady` after first received snapshot.

- [x] Write and run regression tests before production edits with `node --test tests/opening-cover-ui.test.mjs`.
  Expected: fails because the current gate does not preload and has no real readiness barrier.
- [x] Implement the preparation context, permanent destination mount, readiness/retry/timeout, cover states, real page readiness and snapshot flag.
- [x] Run focused tests and isolated browser checks, including delayed lazy calendar and native keyboard activation.
  Expected: ready content is hidden until activation, no startup loading screen after exit, failures retry, no runtime exceptions.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, and `git diff --check`.
  Expected: all pass. Full-task test command: `npm test`.
- [ ] Commit and obtain one fresh whole-change code review; fix material findings with RED→GREEN evidence.
- [ ] Push, create and merge the PR at the verified head, verify main and the automatic Cloudflare check.
  Expected: feature is contained in main and automatic build succeeds.

## Verification record

Baseline: 475/475. The initial readiness regressions failed 10 cases against the previous gate; the final focused suite passes 19/19, and the full suite passes 486/486. Type checking, deployment dry run and whitespace checking passed.

An isolated Edge profile and local API/WebSocket fixtures exercised delayed session, room list and snapshot; native Tab/Enter activation; background focus, keyboard and clipboard isolation; reduced motion; session retry; consent bypass; and desktop/mobile layouts. The destination remained the same mounted form after entry, with no startup loader observed. No real user data was accessed or changed.

Separate browser RED→GREEN checks verified that a delayed calendar chunk cannot unlock entry, and that a failed chunk requires a fresh page on retry because the module loader retains a rejected import. A focused RED→GREEN regression also covers window focus during bootstrap so it does not duplicate the session request. Normal retries remount only the destination; obsolete responses are ignored. Independent review and merge results are recorded in the task ledger.
