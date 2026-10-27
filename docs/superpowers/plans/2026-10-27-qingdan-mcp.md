# Qingdan MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking. The user approved construction on 2026-10-27; execute the tasks continuously in the current feature branch.

**Goal:** Let independently authorized users operate their Qingdan canvases from Codex, Claude Code, VS Code Copilot, and Cursor using nine remote MCP tools.

**Architecture:** A stateless Streamable HTTP handler and the Cloudflare OAuth provider share the existing Worker. D1 grants restrict account membership; the canvas Durable Object remains the authority for atomic changes, revisions, idempotency, recovery, and WebSocket broadcasts.

**Tech Stack:** Existing React/Vite/Workers/D1/SQLite DO; compatible pinned MCP SDK, Agents handler, OAuth provider, and Zod; Node test runner and isolated workerd integration tests.

**Spec:** `docs/superpowers/specs/2026-10-27-qingdan-mcp-design.md` (approved for implementation by the user's “开始构建”).

## Global Constraints

- Work only in `D:/TODO/qingdan-canvas`, on `feat/qingdan-mcp`. No production deployment, remote migrations, shared-branch pushes, or committed credentials.
- Read/search, tasks, and note editing only. Exactly nine MCP tools: `list_canvases`, `get_canvas`, `search_content`, `get_content`, `create_tasks`, `update_task`, `delete_task`, `create_note`, `update_note`.
- Effective access is token scope ∩ active D1 grant scope ∩ explicitly selected canvases ∩ current membership. Writes need both `qingdan:read` and `qingdan:write`. Do not trust tool-supplied actor IDs or external identity headers.
- All note blocks are tasks, including text notes. `ungrouped` means `parentId=null`. Archived means any collection ancestor; reads exclude archived by default and writes reject archived/locked targets or ancestors.
- Preserve old WebSocket protocol/receipts, author provenance, object versions and shared validation. MCP mutations, sequence, receipts and deletion snapshots commit atomically. No-op patches do not increment revision or sequence.
- Idempotency is `(grant_id, request_id)` plus actor/client/command/canonical input; replay original success, reject changed payload. Recovery is by original user within 30 days, independent of continued grant validity, and preserves other edits.
- Access tokens last 15 minutes, grants at most 30 days. Native OAuth clients use PKCE S256. Fixed configured resource/issuer; browser consent once, account/session bound, expires after 10 minutes. D1 pending grants are never usable.
- OAuth/MCP routing precedes Cookie API origin checks; Cookie cannot authenticate MCP. Existing Cookie APIs retain same-origin validation. Disable switch leaves the normal web app working.
- Use meaningful behavioral tests. Every task records RED/GREEN evidence, focused test results, and a full regression run before its implementation commit. Tests use isolated `.tmp` storage, never development or production data.
- Frontend requests must reject stale results after account/session changes. Actual four-client acceptance must be reported honestly; automated protocol tests are not equivalent to running those applications.

## Review Focus

Authorization and consent lifecycle; atomicity and concurrent updates; recovery without replacing newer content; bounded query results; existing realtime synchronization compatibility; exact SDK/provider APIs; isolated migrations/configuration; accessible consent and connection management UI.

## Task 1: Typed semantic commands and bounded canvas queries

**Files:** Create `worker/mcp/contracts.ts`, `worker/mcp/errors.ts`, `worker/mcp/schemas.ts`, `worker/canvas-commands.ts`, `worker/canvas-queries.ts`, `tests/mcp-domain.test.mjs`; add a focused shared helper only if needed. Modify package files only for the schema dependency. Read `shared/canvas-contract.js`, `src/canvas/model.js`, `src/canvas/layout.js`, `src/canvas/todoPages.js` and spec sections 3, 6–8.

**Consumes:** Existing `Row`, `Change`, `CanvasData` from `worker/types.ts`; current shared object and author contracts.

**Produces:**

- Export strict `toolSchemas` keyed by all nine tool names and `parseToolInput(name, unknown)` for the same schema authority used by tool registration later.
- `planCanvasCommand(rows, command, context): CommandPlan`, where command is `{name, input}`; context is `{canvasId, accountId, accountName, now, makeId}`. Plan exposes `changes: Change[]`, deletion snapshots with original neighbors, and structured result. It performs no storage/network work.
- `queryCanvas(rows, query, context): Record<string, unknown>` for `get_canvas`, `search_content`, `get_content`; context carries canvas ID/name and `sequence`.
- `planRestoreBlocks(rows, snapshots, context): CommandPlan` for browser recovery; existing note required, no block-ID collision, current locks/archives checked, original author data preserved.
- Shared error class with `code`, `message`, `retryable`, optional safe details, and serializable business-error helper. Shared principal type `{accountId, clientId, grantId, resource, scopes}`.
- Document exact exported signatures in the report for Task 2/3. Keep command/query code focused; helper files may split normalization, cursor, and projection concerns.

- [ ] Write failing domain tests for task/text-note parity; author-safe targeted edits; UTC date normalization and invalid calendar dates; done timestamps/no-op; explicit target placement; batched create atomic planning; lock/archive ancestry; same-canvas references; delete/restore neighbors and conflicts; search filters and stale cursors.
- [ ] Implement strict schemas (reject unknown/protected fields), using Zod compatible with the selected SDK. Five writes require `request_id`; existing note mutations require whole-note `expected_revision`; `create_tasks` accepts target `{note_id}` or `{section_id}` (`ungrouped` allowed); `create_note` accepts section target. `update_note` uses edits `{task_id, patch}[]`, append blocks, remove task IDs, plus style. Resolve absent/clear semantics exactly as spec 6.2.
- [ ] Implement commands without DOM or hook dependencies, preserving untouched block metadata/order; create 1–50 tasks, colors limited to existing six, no arbitrary object writes. Keep empty notes on last deletion. Existing-reference validation uses only the current canvas. Server generates IDs/times. Reuse or match existing persisted-size placement behavior and expand unlocked frame parents only as needed.
- [ ] Implement deterministic search ordered by creation/object/block; default 20/cap 50, details default 50/cap 100. Bind cursors to canvas/filter/sequence (detail to note revision), validate them strictly, and bound serialized output. Task filters in note mode fail. Expand references one level, preserve unavailable labels, no network fetch.
- [ ] Run `node --test tests/mcp-domain.test.mjs`, then `npm test` and `npm run check`; record evidence and commit `feat: add MCP canvas command and query domain`.

## Task 2: Grants and durable atomic execution

**Files:** Create `migrations/0006_mcp_grants.sql` (confirm next unused number), `worker/mcp/grants.ts`, `worker/mcp/canvas-rpc.ts`, `worker/mcp/room-storage.ts` if needed, focused grant/DO tests. Modify `worker/room.ts`, `worker/types.ts`, isolated integration test helpers as appropriate. Read spec sections 5.3, 7–9.

**Consumes:** Task 1 typed domain functions; existing DO SQL/author handling and WebSocket validation.

**Produces:**

- Grant store functions including `requireMcpGrant(env, principal, canvasId?, write?): Promise<{accountId, accountName, ...}>`, selected-canvas listing, pending→active grant lifecycle, list/revoke and revoke-all. No cached authorization decision. Grant checks include client/resource/expiry/state and current membership; listing must not leak removed rooms.
- `callCanvasMcp(env, canvasId, principal, name, input)` for private DO fetch, with freshly built trusted envelope; frontend never sends this envelope to the Worker.
- DO private `/internal/mcp` dispatcher for read/write commands and `/internal/mcp-operations` for authenticated browser audit/restore. Browser operation identity is freshly constructed from `requireSession`, and DO rechecks membership and operation ownership. No arbitrary commit passthrough.
- Shared synchronous commit method called by existing WebSocket commits and MCP command execution, preserving original WebSocket receipt format.
- `list_canvases` pagination implemented in grant store with stable D1 keyset/current membership recheck.

- [ ] Write failing isolated behavior tests for grant scope/selected-room/member intersection and revoked/expired grants; duplicate request replay and changed-payload rejection; web-versus-MCP conflict; durable deleted-block restoration and stale cursors after web changes.
- [ ] Add additive D1 grant, grant-room and consent-selection tables/indexes. Existing duplicate `0005_*` files remain unchanged. Store pending/active/revoked state, provider grant association, scopes and fixed resource; account/password revocation API returns fail-closed behavior.
- [ ] Initialize DO sequence, MCP receipts and recovery tables idempotently. Refactor only the transaction core; keep existing session validation, image metadata validation, author history and old immutable receipts intact. Increment sequence only on successful content changes, including WebSocket writes.
- [ ] Recheck D1 grant/membership immediately before each MCP transaction; inside it replay receipts first, plan against latest rows, atomically validate/save rows, author registry, sequence, result and recovery snapshots. Bind canonical input to identity, command and request ID. Use an additive D1 request binding to arbitrate the grant/request key across canvases before DO execution; this reservation is not a success receipt and identical retries recover after interruption. Recheck authorization after asynchronous reservation. Store results before broadcasting; broadcast failure cannot turn committed success into a false failure. Cached replay may rebroadcast saved rows.
- [ ] Implement own-operation paginated audit and idempotent 30-day recovery. Grant revocation does not prevent browser recovery; current membership/locks/archive still apply. Alarm cleanup removes expired snapshots, not immutable receipts. Retain existing note style and others' changes.
- [ ] Run focused tests plus `npm test` and `npm run check`; record exact DO/grant interfaces for later tasks and commit `feat: persist authorized MCP operations and recovery`.

## Task 3: OAuth provider, MCP transport and Worker routing

**Files:** Create `worker/mcp/auth.ts`, `worker/mcp/consent.ts`, `worker/mcp/server.ts`, `worker/mcp/tools.ts`, focused OAuth/transport tests. Modify `worker/index.ts`, `worker/accounts.ts`, `worker/email-recovery.ts`, `worker/types.ts`, `wrangler.jsonc`, package files, `.dev.vars.example` if applicable. Browser-facing consent and grant APIs are implemented here for Task 4.

**Consumes:** Grant store/private canvas bridge and strict tool schemas. Pin compatible installed versions after verifying official package APIs (registry at plan time: server 2.4.0, SDK 1.32.2, agents 0.30.1, provider 1.2.4); do not invent exports or handwrite a JSON-RPC/OAuth state machine.

**Produces:**

- Configured `OAuthProvider` + `createMcpHandler`, new per-request MCP server/tool registrations, canonical `PUBLIC_ORIGIN + /mcp`, controlled origins, feature switch.
- `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register`, discovery/resource metadata, and authenticated `/mcp` Streamable HTTP with nine tools, annotations, structured results and stable errors.
- `GET /api/mcp/consent/:handle` returns safe client/account/scope/room display plus CSRF value. `POST` body `{decision, scopes, canvas_ids, csrf}` consumes once; response `{redirect_to}` only after durable success or a verified denial callback. Provider/browser CSRF headers are preserved. Original redirect URI never comes from form data.
- `GET /api/profile/mcp-grants`; `DELETE /api/profile/mcp-grants/:id`; `GET /api/rooms/:id/mcp-operations`; `POST /api/rooms/:id/mcp-operations/:operationId/restore` body `{request_id}`. Document response shapes for Task 4.

- [ ] Add failing OAuth/route tests for Cookie-only MCP rejection, discovery, PKCE/resource validation, read-only denial, consent reuse/CSRF/account switch, selected-room restriction and native no-Origin versus unapproved browser Origin.
- [ ] Install/pin compatible libraries; implement library-based OAuth handles with 10-minute expiry and account/session-bound selection. Support CIMD and DCR, PKCE S256 only, token 15 minutes, refresh/grant max 30 days. Rate-limit DCR using a durable existing or suitable provider mechanism, and enable `global_fetch_strictly_public` for metadata fetches.
- [ ] Wire pending D1 grant → provider issuance/correlation → active grant. Do not send successful redirect on partial failure; revoke orphan provider grants if activation fails. Replace prior same account/client/resource grants after successful new activation. Revoke D1 first for explicit disconnect and password change/reset; provider cleanup follows. No ordinary logout revocation.
- [ ] Register the nine schema-backed tools and safe titles/descriptions. Enforce token/grant scopes, member intersection, and tool boundaries, returning standard auth challenges and structured business failures. All transport uses private DO bridge, never caller identity headers.
- [ ] Dispatch MCP/OAuth before existing Cookie routes and static assets. Browser API same-origin validation remains. Add `MCP_ENABLED`, fixed origin and allowed origins config plus separate local/production/preview KV binding documentation/placeholders; default off until configured. Worker-first paths cover `/api/*`, `/mcp`, `/mcp/*`, `/oauth/*`, `/.well-known/*` in both environments.
- [ ] Run focused isolated tests, `npm test`, `npm run check`, and a build/dry run if dependency compatibility warrants it. Record actual APIs and frontend response shapes; commit `feat: expose authenticated remote MCP service`.

## Task 4: Consent, Agent connections and deletion recovery UI

**Files:** Create `src/auth/McpConsent.jsx`, `src/auth/McpConnections.jsx`, focused UI tests; modify `src/App.jsx`, `src/auth/ProfileSettings.jsx` and relevant existing CSS/API helpers. Read Task 3 response report and spec sections 5.1, 5.4, 8.

**Consumes:** Cookie-authenticated consent, grant and per-canvas operation APIs. Existing login/session epoch and profile dialog patterns.

**Produces:** A login-resumable consent route and account-settings Agent connections screen with revoke, own-operation listing and deletion restore.

- [ ] Write failing UI behavior tests for login→resume consent, current account/client/scope display, explicit room selection, deny/approve, empty membership, stale account/session requests, grant revocation, audit loading and restore errors/success.
- [ ] Handle the exact `/mcp/consent?handle=...` page before normal room/invite navigation; keep it while login completes, clean it at finish. This dedicated Worker-first page replaces the draft root `oauth_request` route so frame/referrer/no-store protection applies to the final SPA document. Consent shows real client ID alongside untrusted display name, defaults to requested least scope, allows read versus read/write, selects explicit current rooms only, and explains both notes/tasks share write access.
- [ ] Use normal authenticated JSON requests and verified server redirect only, with CSRF. Reject duplicate submit and stale responses; allow error/retry without silently approving. UI is accessible, keyboard usable, and follows current Chinese visual style.
- [ ] Add Agent connections to profile settings: scopes, selected/current canvases, expiry, last used, explicit revoke; explain same-client grant replacement across devices. Provide per-canvas own-operation history and a recoverable deletion action with deadline. Restore does not require an active connection.
- [ ] Run focused UI tests plus `npm test` and `npm run check`; commit `feat: add MCP consent and connection management`.

## Task 5: End-to-end verification and client/deployment documentation

**Files:** Extend `tests/mcp-integration.test.mjs` or equivalent isolated fixtures; create `docs/mcp-setup.md`, `docs/mcp-acceptance.md`; update `docs/cloudflare-setup.md`, README as appropriate and spec implementation-status note. Fix integration defects in owned modules with behavior regressions.

**Consumes:** All previous tasks; official docs for current four-client configuration and local CLI help where available.

**Produces:** Reproducible automated OAuth→MCP→DO→WebSocket→recovery tests, four connection instructions, manual release checklist and honest acceptance results.

- [ ] Run a real isolated workerd OAuth flow using two test accounts/canvases and a public PKCE client: discover/register/authorize/token, initialize/list/call, refresh, read-only and unauthorized rooms, wrong resource, expire/revoke/password reset, failure/duplicate consent. Capture protocol versions accepted without logging tokens.
- [ ] Verify all nine tools, realtime WebSocket observation, note-wide concurrency conflict, same-ID retries, author/date/remark/ref preservation, archived/locked ancestors, output caps, cursor invalidation, and deletion recovery after intervening edits/grant revocation. Use behavioral tests rather than source-string assertions.
- [ ] Document exact setup for Codex, Claude Code, VS Code Copilot and Cursor, URL placeholders and authorization/reconnect steps. Prefer existing local client help for OpenAI; primary official docs for current external details. Do not invent actual app test results. Record versions/actual outcomes or explicitly “not run: requires deployed preview and user sign-in”.
- [ ] Document separate KV creation/bindings/origins, local isolated start, additive D1-before-code deployment, preview-only verification, feature disable/rollback, and manual production deployment. No live infrastructure changes.
- [ ] Run final `npm test`, `npm run check`, `npm run deploy:check`, inspect the full diff, record exact counts and material limitations. Commit `test: verify MCP integration and document client setup`.

After all tasks: perform one independent whole-branch review; fix verified issues with targeted tests, rerun affected required checks, and deliver branch/commits, local instructions, verification evidence and remaining real-client/deployment work. Do not merge or publish without a subsequent user request.
