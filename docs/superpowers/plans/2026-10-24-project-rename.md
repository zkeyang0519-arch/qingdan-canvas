# Project Rename Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Track completion below.

**Goal:** Let project owners change a saved project name from the home page and workspace.

**Architecture:** Add an authenticated owner-only PATCH route for the existing D1 name column. A shared dialog saves through the API; App reconciles metadata within the current account epoch, and the workspace updates local board metadata without editing objects.

**Tech Stack:** React, Cloudflare Workers / D1, existing modal, Node test runner and JSDOM.

**Spec:** `docs/superpowers/specs/2026-10-24-project-rename-design.md`

## Constraints and review focus

- Preserve prior uncommitted avatar/drag work on `develop`; no push, deployment, migration or dependencies.
- Owner-only mutation, same-origin/account protections, trimmed 1–80 character names; retain project ID, members, invite and object rows.
- Cover unauthorized writes and malformed names in the real Worker integration test.
- Cover empty input, save failure/retry, pending double submission and cancel in UI tests.
- Cover late responses after navigation and account expiration; keep backup/search metadata aligned without restarting the room connection.
- Keep both entry points keyboard accessible and usable in narrow layouts; no nested buttons in cards.

## Task 1: Persist project names

Files: `worker/index.ts`, `tests/integration.test.mjs`.

- [x] Add failing integration cases for owner rename, list/detail persistence, 80-character boundary, invalid input, editor/outsider/anonymous/cross-origin/stale-account rejection, and preservation of invite and snapshot.
- [x] Run `node --test tests/integration.test.mjs` and observe the missing PATCH behavior fail.
- [x] Implement `PATCH /api/rooms/:id` accepting `{name}` and returning `{room}` after owner validation and a parameterized D1 update; rerun integration tests.

## Task 2: Expose and reconcile rename UI

Files: new `src/RoomNameDialog.jsx`; modify `src/App.jsx`, `src/CanvasWorkspace.jsx`, `src/sync/useRoomWorkspace.js`, `src/app.css`; new `tests/project-rename-ui.test.mjs`.

- [x] Add failing UI tests using the real App/dialog with HTTP and workspace-hook boundaries controlled for deterministic behavior.
- [x] Reuse the existing Modal; add home card and workspace pencil buttons. Trim/validate, prevent duplicate saves, keep errors local, reconcile successful names through an account-epoch-guarded App callback.
- [x] Sync `room.name` into local board metadata with a separate effect so the existing connection, content and history are retained. Run UI and account-navigation tests.
- [x] Update README; run `npm test`, `npm run check`, `npm run deploy:check`, targeted formatting and diff checks. Verify the UI in a disposable local browser preview and perform one independent final review.

## Execution record

- Start: existing `develop` at `1537622` plus the completed, uncommitted avatar/board interaction changes.
- The user requested implementation; routine UI/permission choices above are handled directly under the session's autonomy instructions, without an additional design-approval interruption.
- Pre-flight: Task 2 consumes Task 1's `{room}` response and updates only matching project metadata; no shared-object changes or migration are needed.
- Task 1 complete: the two new integration cases initially failed on HTTP 405; after implementation the real Worker integration suite passed 15/15.
- Task 2 complete: five UI cases first failed on missing controls/metadata propagation, then passed. UI coverage runs the real App, CanvasWorkspace, dialog and workspace hook with HTTP, draft storage and sockets controlled.
- Final review found two important races: older list/detail reads could replace a successful rename, and delayed draft initialization could capture an old name. Three regression cases reproduced the failures before fixes. Per-room write markers now protect in-flight reads while allowing future reads to adopt another device's updates; initialization reads the latest name. Focused UI plus account-navigation tests passed 10/10.
- Final validation after those fixes: `npm test` passed 291/291; `npm run check` and `npm run deploy:check` passed. The existing large-bundle warning remains.
- Browser checks covered both entry points, Enter save, Escape cancel and 390 px layout using disposable preview data. Screenshots: `.tmp/project-rename-dialog-preview.png` and `.tmp/project-rename-mobile-preview.png`. An observer error appeared while inspecting the nested iframe preview; a fresh standalone preview repeated the save with no console errors. Temporary tabs and the preview server were closed.
- Formatting and diff checks passed. No remaining review findings; changes are local and uncommitted, alongside the earlier avatar/board improvements. Nothing was pushed or deployed; no migration was added.
