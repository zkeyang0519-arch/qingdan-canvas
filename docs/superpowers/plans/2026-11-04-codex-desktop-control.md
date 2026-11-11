# Codex Desktop Control Implementation Plan

> Superseded scope: the user subsequently chose Qingdan-only execution with desktop project/chat visibility. Do not execute the shared-control/SSH tasks below. Desktop registration and existing-chat association have been verified; automatic grouping from the independent Runner remains unimplemented because the tested public backend project IDs do not drive desktop membership. See `../../agent-desktop-visibility-verification-2026-11-04.md` for the actual results. No product implementation has been claimed complete.

> **For agentic workers:** Use superpowers:executing-plans inline, with a fresh whole-change review at the end. Steps use checkbox syntax for tracking. The user has approved the design and execution; do not repeat the approval flow.

**Goal:** Share real Codex projects, chats and task control between Qingdan and the desktop app.

**Architecture:** Verify a supported shared app-server connection first. Preserve the existing MCP/device/outbox boundary, add native project identity and actual-server compatibility checks, then reconcile desktop-originated lifecycle events into the same run.

**Tech Stack:** Existing React, Worker/D1/RunnerHub, Node 24, Codex app-server alpha.6 generated types; no dependency upgrade.

**Spec:** `../specs/2026-11-04-codex-desktop-control-design.md`.

## Global Constraints

- Existing branch/workspace is already isolated feature work; baseline `8808879`.
- Never edit Codex private DBs, copy credentials, intercept stdio owned by another process, expose public listeners, kill the desktop backend, or resend uncertain launches.
- Preserve native authorized-directory/owner checks, MCP immutable intents, current connection epochs, command/report durability and confirmed-stop semantics.
- Shared-server shutdown is independent of client shutdown. Desktop continuation remains the same chat; it must not silently satisfy old task acceptance.
- Stop only the verified owned Qingdan launcher before broad tests/build; retain the app for final experience. Production deployment remains disabled.
- If the supported shared runtime cannot attach to the actual desktop, record the concrete boundary and complete independently useful authorized work without claiming bidirectional control works.

## Review Focus

- Desktop-originated turn races with queued MCP follow-up: one current turn, no repeated launch (Task 3).
- Client shutdown or dropped connection must not stop unrelated desktop work (Task 1/3).
- Project root alias, replacement and same-name projects cannot change authorized cwd (Task 2).
- Installed CLI version differs from the running server or server changes during reconnect (Task 1/4).
- Unstructured desktop follow-up output or changed instructions cannot auto-complete the original TODO (Task 3).

### Task 1: Prove and isolate the shared transport

Files: investigation under `.tmp/codex-desktop-control/`; then `runner/codex-client.ts`, `runner/supervisor.ts`, a focused shared-connection module and transport tests only after the real connection is proven.

Interface: a client-owned transport supplies ordered JSON-RPC packets, write/close and actual server identity; closing it never owns the shared server process. Existing standalone mode remains explicit and supported.

- [ ] Read supported daemon/proxy options; start the documented local daemon only if absent, without restarting existing app servers.
- [ ] Verify initialize, project/list and thread/read through the shared connection, then verify the desktop sees and controls the same test run. Record identity and exact supported connection method.
- [ ] If the desktop cannot join this runtime, investigate supported connection configuration before any product transport change; do not guess that a new daemon is the desktop backend.
- [ ] Add RED tests for request/event routing, disconnect, actual-version mismatch and close-without-server-stop; implement the proven transport, GREEN tests and `npm run runner:check`.

### Task 2: Native project identity and readable chats

Files: `runner/codex-client.ts`, `runner/codex-adapter.ts`, generated project protocol closure via `scripts/generate-codex-protocol.mjs`, local project mapping persistence and focused runner tests.

Interface: `ensureProject(workspaceId)` resolves only an authorized canonical root, returns a real Codex project ID and reuses a matching project. `thread/start` receives that trusted ID; existing runs may attach without starting a new turn.

- [ ] RED tests: project reuse, idempotent creation, same-name/different-root rejection, canonical alias handling, late binding change rejection and old-thread attachment without turn/start.
- [ ] Implement genuine project/list/create and thread metadata assignment with deterministic request identity, short user-facing task titles and stable local mapping.
- [ ] Run project/native tests, type checks and full regression; save task commit.

### Task 3: Reconcile desktop control into the existing run

Files: `runner/codex-adapter.ts`, `runner/store.ts`, `runner/executor.ts`, `runner/execution-store.ts`, shared execution schemas and worker dispatch only where the observed protocol requires it; focused native/dispatch tests.

Interface: desktop lifecycle events carry the same thread/turn identity, distinguish user interruption and external continuation, persist adoption before reporting, and never claim automated acceptance from a desktop-only result.

- [ ] RED tests for desktop steer, interrupt confirmation, next turn adoption, stale completion after continuation, simultaneous MCP command, changed cwd/permissions, reconnect and unstructured manual results.
- [ ] Implement event ownership/reconciliation, durable sequencing and conservative conflict handling based on the Task 1 verified backend behavior. Preserve MCP receipt semantics.
- [ ] Verify a fake multi-client server and actual shared runtime; run the complete suite and save task commit.

### Task 4: Compatibility diagnostics, usable controls and final acceptance

Files: local runner helper/controller, `src/agent/ExecutionPanel.jsx`, experience docs and acceptance record; appropriate UI/helper tests.

Interface: authenticated same-origin diagnostics report actual server version, tested compatibility, desktop connection, and project association; no credentials or arbitrary shell/connection input in browser API.

- [ ] RED tests for compatible/unknown versions, installed-vs-running version differences, disconnected desktop, foreign-account access and unavailable controls.
- [ ] Add connection/project/status diagnostics and authorized retry actions in the existing Step 4 panel; retain typed task drafts and previous history.
- [ ] `npm test`, `npm run check`, `npm run runner:check`, `npm run deploy:check`; then fresh whole-change review and fix evidenced issues.
- [ ] Restart the owned local launcher; actual UI dispatch, native desktop control and same-chat continuation; compare run/turn/file evidence and reload recovery.
- [ ] Save screenshots, verification record and local commit; retain the working app. Mark complete only for capabilities actually demonstrated.
