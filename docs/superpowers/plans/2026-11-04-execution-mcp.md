# Step 4 — MCP dispatch and usable local experience

Approved basis: `../specs/2026-11-03-qingdan-router-design.md`, roadmap Task 4, and the user's instruction to continue the present architecture, validate it, and expose it in Qingdan. Work on existing feature branch `feat/qingdan-mcp`; baseline `99047a6`. No production deployment.

## Global constraints and decisions

- Reuse Step 2 CodexAdapter and Step 3 device identity, authorized WorkspaceRegistry, RunnerTransport leases, current account guards and durable RunnerHub. Never run arbitrary model-selected cwd, shell, policy, actor or credentials.
- `/executor-mcp` is a separate authenticated stateless Streamable HTTP endpoint using pinned `agents/mcp/server` and Zod. Existing `/mcp` OAuth grants confer no execution authority.
- Browser calls require same origin, account session and matching X-QD-Account. Only an explicit manual submission can authorize a trial intent. MCP `create_run` only references its pre-existing immutable snapshot. Formal TODO writeback and sequential queue orchestration remain Steps 5/8.
- Execution tokens bind owner, runner, binding revision, auth epoch, audience `/executor-mcp`, purpose `manual-trial`, and short expiry. They remain server-side in the browser bridge. Every call checks live authorization. Production `EXECUTION_ENABLED` defaults false; local dev-agent explicitly enables it.
- Put the execution coordinator in `worker/execution/dispatch.ts` using the existing RunnerHub's storage and serialized access. Hub delegates internal `/execution/*` requests to it; native endpoints authenticate existing device token AND current connectionEpoch. This avoids adding a redundant DO and preserves lease CAS.
- Native execution uses authenticated HTTP polling over the same paired transport, while WS retains heartbeat/leases. Poll returns offers; Runner first takes the global canonical project lock and remote lease. Only then may the server durably materialize and return a command envelope and snapshot. Retries replay durable envelopes; uncertain launches never retry automatically.
- All protocol types live in `shared/agent/execution.ts`. Both sides validate strict inputs. Root must publish this contract before native implementation starts.
- Registered-project context (actual Git baseline and bounded chat metadata with capturedAt) is sent by the authenticated native Runner and cached. Intent snapshots use this cache. Offline submissions queue against cached context; adapter verifies the baseline again before launch.
- Every new task/summary has a new chat; reply/steer remains in the same chat and requires expectedTurnId. Receipt is immediate, not a wait for Codex. Execution end is `verifying`/待验收, never automatic TODO success.
- One active run per device and canonical project; persist outbox before delivery, local command journal before execution. Lease expiry/revocation/disable interrupts, blocks new launches and preserves uncertain records. Confirm stop before releasing locks/lease. Startup reconciliation must never blindly re-launch.
- Tests use isolated temporary D1/workerd and fake Codex. Stop local launcher before suite/build. Required final commands: `npm test`, `npm run check`, `npm run runner:check`, `npm run deploy:check` sequentially. Then restart actual-user launcher and smoke real Codex through the UI.

## Task 1 — Server dispatch, MCP and HTTP bridge

Owned files: `worker/execution/{dispatch,outbox,mcp-server,execution-router,execution-auth}.ts`, shared `execution.ts`, `worker/execution/hub.ts` small delegation, `worker/index.ts`, `worker/types.ts`, `migrations/0008_execution_tokens.sql`, `wrangler.jsonc`, `tests/execution-mcp.test.mjs`. Do not edit runner, frontend or launcher.

Implement five tools exactly: `codex_list_projects`, `codex_create_run`, `codex_get_run`, `codex_continue_run`, `codex_cancel_run`, reusing strict existing CreateRunInput/ContinueRunInput/CancelRunInput parsers. MCP create cannot create its own authorization/snapshot. Bind every lookup to principal; requestId reuse with different content fails. Same-content retries return original receipt. Pagination is bounded; get_run accepts afterSeq. No credentials in errors/output. UI bridge uses a real SDK Streamable HTTP transport against the same handler via bounded internal fetch, not direct tool functions; test with MCPClientManager in actual workerd transport.

Browser routes under `/api/agent/execution/`, BEFORE the older catch-all runner route:
- POST `intents`: strict `{requestId,bindingId,bindingRevision,kind:'task'|'summary',instruction?,acceptance?}` authorizes one immutable manual trial snapshot from binding and native cached baseline; returns `{input:CreateRunInput}`. Reject a stale visible binding revision before minting. Idempotent by owner/requestId. Build a ready TaskSpec with human acceptance for manual trials; no formal canvas mutations.
- POST `tools`: strict `{bindingId,name,arguments}`; mint short-lived internal execution credential, invoke real MCP transport, return `{result,tool,transport:'streamable-http'}`; surface tool errors as HTTP errors. Credential never returned.
- GET `runs?bindingId=...`: bounded authorized recent run views for page reload recovery.

Native routes under `/api/runner/execution/`, device bearer + current `connectionEpoch`, no browser origin/fetch-site:
- POST `context`: `{connectionEpoch,contexts:[{workspaceId,capturedAt,gitBaseline,threads:[]}]}`. Only currently authorized projects, strict bounded data. Cached context used by list_projects and intent.
- POST `poll`: `{connectionEpoch}` -> `{offers:[{runId,workspaceId}],deliveries:[{envelope:CommandEnvelope,snapshot:ExecutionSnapshot}]}`. At most one active run; order accepted commands per run. Offers include pending create or reply needing lease. Verify binding/auth live before offering/delivery and reject stale intents. Materialize envelope only once proper D1 lease exists (positive fresh leaseEpoch). Persist before responding.
- POST `ack`: `{connectionEpoch,commandId,status:'stored'|'rejected'|'applied'|'uncertain',reason?}`. Durable idempotent receipt; don't conflate receipt with execution success. Preserve command history after ACK. An uncertain command cannot be resent as a fresh launch.
- POST `events`: `{connectionEpoch,events:RunnerEvent[]}` -> `{eventIds:string[]}`. Deduplicate exact eventId/seq; reject conflicting payload; bound pages/output. Keep events as queryable ordered history; command-scoped monotonic reports alone establish current run state. Authorize runner, run and current binding.
- POST `report`: `{connectionEpoch,runId,revision,status,threadId,turnId,terminal,stopConfirmed,error?}`. Define strict shared report schema. Monotonic durable per-run revision, old reports ignored, conflicting same revision rejected. Allowed native status includes preparing/running/waiting_input/waiting_approval/verifying/failed/cancelled/reconciliation_required. Do not claim stopped from receipt or merely requested cancel.

Cancellation: undispatched queued run may cancel directly; any possibly delivered create must receive cancellation and stay cancel_requested until confirmed. Reply after terminal reacquires the lease and resumes the old chat. Steer requires active matching turn. Reports/events cannot regress state across a new command; document revision rules. Bound storage reads/results, maximum output size with explicit truncation and cursors.

Write red tests first covering real transport/tool discovery, missing/wrong audience/owner/binding/authEpoch auth, no arbitrary snapshot/extra fields, offline queue, idempotency/conflicts, receipt before completion, command persistence, event replay, stop confirmation and existing /mcp isolation. Publish final shared types and route examples for Task 2/3. No subagents, no broad suite while others work, no commits (root integrates).

## Task 2 — Native executor

Owned files: `runner/executor.ts`, `runner/execution-store.ts`, transport/controller integration, `tests/runner-execution.test.mjs`. Consume Task 1's shared contract. Reuse CodexAdapter + RunnerStore, no new Codex protocol implementation. `DeviceControllerOptions.executionEnabled?:boolean` defaults false; launcher opts in. Expose `executionContext(ownerId,workspaceId)` to validate owner/project, read actual Git baseline, publish bounded history/context through current transport, and return safe metadata.

Transport exposes authenticated `executionRequest(action, body)` with current connectionEpoch added internally and private bearer, plus safe envelope journal acceptance method. Never expose token to browser. Executor polls, acquires WorkspaceRegistry lock and remote lease, validates snapshot ownership/workspace/run/binding/hash, journals command and snapshot, then executes. Recover from its persisted states; never repeat uncertain non-idempotent adapter calls. Persist report revision/cursor/ACK states. Replay events until acknowledged. Handle reply/steer/cancel, terminal stop and lease release, lease expiry, disabled/revoked connection, shutdown and already-running recovery. Local device cap one; never release a possibly-running lock.

Tests via injectable fake Codex/transport and real temp SQLite: duplicate create opens once, altered duplicates rejected, continue same chat, stop waits for interrupt, journal survives restart, lease expiry prevents launch/interrupts active run, foreign snapshot denied, realpath lock and workspace changes retained. Controller existing tests stay compatible with default execution disabled. No subagents, no edits outside owned files, no commits.

## Task 3 — Root integration and usable entry point

Owned files: `src/agent/ExecutionPanel.jsx`, AgentExperience integration, CSS, browser tests; local helper endpoints and launcher; docs and acceptance record.

Add `4 · MCP 派单` with signed-in bound project selector, context refresh, explicit manual task and summary submit, run status/output/chat identity, editable follow-up with reply/steer, stop and refresh. Persist/recover history by authorized server state, not insecure browser tokens. Use MCP for actual operations. Show offline queued, errors, waiting approval/input and pending stop truthfully. Avoid secret fields, internal hashes and policy jargon in product flow.

Provide a fixed local isolated demo-project preparation action (under `.tmp/execution-trial/`), register it via the existing authorized controller, and bind a dedicated clearly labelled trial section in the current room without changing the user's normal section binding. No arbitrary browser-provided filesystem destination or shell. Prepare only on explicit click. Keep normal current-list execution selectable. Each requested test task is scoped to this isolated project.

Wire dev-agent execution flag; run required checks after implementations. Review all changed code with one whole-change reviewer, address evidenced findings, rerun affected checks. Restart actual-user local service hidden. Real smoke: demo task creates an expected file, follow-up changes it in same chat, separate task gives another chat, cancel controlled test confirms stopped; inspect filesystem evidence and UI. Include auth/offline/replay coverage from isolated tests. Document current limitations (manual approvals shown but not auto-granted; formal list writeback later). Keep local app running for user experience, local commit when checks/review complete.

## Progress

- [x] Task 1 server + MCP
- [x] Task 2 native executor
- [x] Task 3 UI, integration and real acceptance

Final acceptance: 583/583 tests, Worker and Runner type checks, deploy dry run, independent re-reviews, and actual-user Codex UI smoke all passed. File creation, same-chat continuation, new-chat cancellation with confirmed stop, read-only summary, launcher restart and page reload were verified. Details: [Step 4 acceptance record](../../agent-execution-verification-2026-11-04.md). No production deployment; local service retained for user experience.
