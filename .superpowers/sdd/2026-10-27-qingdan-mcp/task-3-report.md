# Task 3 report — OAuth provider, remote MCP and browser APIs

Status: DONE_WITH_CONCERNS (deferred Task 5 cleanup and real-client acceptance listed below). Implementation base `981df4f54dca9c9f1dcd65a5ab5eb6ef9208ebe2`; branch `feat/qingdan-mcp`; controller routing refinement `0993d9e` is included in history. No subagents, new worktree, remote migration, deployment, global MCP-client edits, or real external data access.

## Delivered behavior

Pinned compatible runtime packages: `agents@0.30.1`, `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, and `@cloudflare/workers-oauth-provider@1.2.4`; existing `zod@4.6.7` remains. npm installed the Agents dependency tree and compatible peer graph into the lockfile. OAuth protocol operations use `OAuthProvider`/official helpers. Streamable HTTP, modern per-request MCP, legacy stateless compatibility, native schema listing and per-tool HTTP scope challenges use `createMcpHandler` and fresh SDK `McpServer` instances. There is no application JSON-RPC or OAuth-code/token implementation, token parsing, custom provider KV state, or forged SDK authInfo.

`worker/mcp/router.ts` routes protocol and MCP browser APIs ahead of old Cookie routes/static assets. It leaves ordinary routes alone. `/mcp` is Bearer-only, with resource/audience fixed to `${PUBLIC_ORIGIN}/mcp`; Cookie alone returns401. Protocol request origin must equal `PUBLIC_ORIGIN`, preventing request-host issuer substitution. Present browser Origin must match the exact application origin or explicit comma-separated `MCP_ALLOWED_ORIGINS`; no-Origin native requests work. The provider carries its verified context symbol into the Agents handler automatically: we pass the original provider context. Token identity/client/scope come from verified `ctx.auth`, while app grant ID comes from encrypted provider props. Authorization is then intersected again with active/unexpired D1 scope, explicit selected rooms and current membership, including at the DO commit boundary.

Discovery, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, and RFC7009 revocation are provider-owned. `/oauth/revoke` is a pure URL alias to the provider's revocation-capable token endpoint; metadata correctly advertises the provider's `/oauth/token` revocation endpoint. DCR is throttled with the existing durable D1 auth limit mechanism:20 registrations/hour per CF-Connecting-IP (local fallback for the isolated fixture). CIMD support is enabled with `global_fetch_strictly_public`; native private-use callback URIs are enabled. Browser authorization requires S256, including confidential clients. Access tokens last at most900 seconds. The callback checks active D1 authorization and exact provider association before code exchange or refresh, caps access/refresh TTL to remaining absolute D1 lifetime, omits refresh without `offline_access`, and never uses sliding refresh expiry. Invalid/expired/revoked app grants throw the provider's official `OAuthError('invalid_grant')`, which also tears down the provider grant.

Exactly nine schema-backed tools are registered: `list_canvases`, `get_canvas`, `search_content`, `get_content`, `create_tasks`, `update_task`, `delete_task`, `create_note`, `update_note`. SDK input-mode JSON Schema conversion handles Task1 Zod transforms without replacement schemas. Reads require read scope; every write challenges for both read+write, using SDK `requireScopes` and a D1 scope check. Tools use the existing private bridge/directory functions. Business failures return stable `{code,message,retryable,details?}` structured error content. Canvas/member denials are tool errors (`ACCESS_DENIED`); invalid/revoked credentials return HTTP401, and insufficient scopes use HTTP403 Bearer challenges. Annotations mark read tools, destructive existing-content mutations and request-ID-backed idempotency. Successful tool execution best-effort updates `last_used_at` through `ctx.waitUntil`.

## Consent and activation boundary

Authorization uses official `parseAuthRequest`, `describeConsent`, `beginConsent`, `approveConsent`/`denyConsent`, and `completeAuthorization`. The provider's actual Set-Cookie/CSRF binding headers are preserved as Headers (not flattened object spreading). Application KV stores only a separate ten-minute safe display context, app CSRF secret and browser binding; it does not store or reconstruct the provider transaction. A second Secure HttpOnly host-only ten-minute browser cookie binds the app GET/data API to the browser that started authorization. GET requires a live existing account session and binds Task2's D1 consent with empty room selection and the SERVICE scope ceiling (read/write/offline), separate from requested scopes. Retrying the same open GET preserves expiry. Account changes, renewed sessions, expired/consumed handles, bad CSRF and missing binding cookies are rejected. POST is strict `{decision,scopes,canvas_ids,csrf}` and never accepts a redirect URI.

Approve conditionally submits rooms/scopes once, creates pending D1 grant, consumes official consent, asks provider to issue, and correlates only official `GrantSummary.metadata.appGrantId` plus client identity. Correlation and compensating orphan scan are bounded to10 pages of100 summaries. Provider IDs are never extracted from code/redirect/token strings. Durable D1 activation must succeed before returning `{redirect_to}`. Failed activation (including password/session invalidation during the callback) leaves the app grant pending/unusable and revokes the discoverable provider orphan. Existing valid grants remain usable on failed activation. Denial claims D1 open→revoked before official deny, so concurrent approval/denial cannot both win app selection; the returned callback is library-verified.

`activateMcpGrant(env,session,grantId,providerGrantId,replacePrevious=false)` adds one backward-compatible optional boolean. Default false keeps Task2's ability to construct multiple grants for its storage tests; return adds `replaced:[]`. Browser consent passes true. In the SAME D1 batch as the existing guarded pending→active update and consent→active update, it conditionally revokes OTHER active grants with the same account/client/resource only when the newly associated grant is active. The SQL predicate binds its ID/provider ID, so a failed activation cannot revoke existing valid grants. It marks the corresponding revoked selections, and returns the replaced provider cleanup IDs from `UPDATE ... RETURNING`. Provider cleanup runs afterwards. This avoids the experimentally reproduced two-approval race in which two non-atomic cleanup queries revoked one another and left zero valid grants. Concurrent successful approvals now leave exactly one active grant/code; the later successful activation intentionally replaces the previous one.

Display-context deletion after successful activation/verified denial is best-effort: D1 state and the consumed official transaction already prevent reuse. A fixture-injected delete failure cannot turn a durable successful authorization into an error or revoke its newly valid provider grant. All provider cleanup failures, including configuration/helper creation, are best-effort and cannot overwrite a successful password change/revoke response. D1 remains the immediate authority.

Password change/reset retain Task2's guarded atomic credential+session+D1 revocation batches unchanged. Cleanup uses exactly the affected provider IDs returned by those batches, after their successful credential predicate is verified. Ordinary logout does not revoke active grants. Explicit browser disconnect first revokes D1 and its selection, then calls official provider revoke. Management/recovery remain available while MCP is disabled; provider cleanup is skipped if no enabled configured provider exists, but D1 revoked grants remain unusable upon later enabling.

## Approved SPA routing refinement

Controller explicitly approved `/mcp/consent?handle=...` instead of the earlier `/?oauth_request=...` detail, recorded in controller docs commit `0993d9e`. This is an exact reserved browser-page route before provider `/mcp` prefix handling. It returns ASSETS SPA HTML with `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. Protection covers the FINAL SPA document, not only initial302/JSON. The page exception conveys no account/tool identity and has no Bearer/CSRF bypass: its data API authenticates independently. Disabled/unconfigured protocol/consent routes return404 with `{"error":"MCP is not configured."}`. Ordinary web routes still function. Task4 must detect this exact path and `handle` query; it must escape client-controlled display strings (React text), prominently show redirect_host/domain and local-app warnings, and discard stale responses on account/session changes.

## Exact Task 4 browser contracts

All browser routes retain same-origin/Sec-Fetch-Site checks, require current Cookie session and optional `X-QD-Account` equality. Responses are no-store JSON. Timestamps below are Unix milliseconds except audit/restore ISO fields inherited from Task1/2. HTML/consent JSON adds frame/referrer protection. Generic HTTP failures return `{error:string}` with400/401/403/404/405/409/etc; audit business errors add `{code,retryable,details?}`. Never read/carry a callback from client form data.

`GET /api/mcp/consent/:handle`:

```ts
{
  handle: string, csrf: string, expires_at: number,
  account: { id: string, name: string, username: string },
  client: {
    id: string, name: string, domain: string|null,
    redirect_host: string, redirect_is_loopback: boolean, name_verified: boolean
  },
  requested_scopes: string[],
  supported_scopes: ['qingdan:read','qingdan:write','offline_access'],
  resource: string,
  canvases: {canvas_id:string,name:string,role:'owner'|'editor'}[]
}
```

Only currently owned/editable rooms are returned, up to2000; a larger directory fails409 rather than silently truncating consent choices. `domain` is the provider's CIMD domain; DCR names are unverified. `requested_scopes` is display/default information, NOT a restriction against explicit user-approved write step-up. Read must always be selected for approval; room selection must be nonempty and at most2000 unique current rooms.

`POST /api/mcp/consent/:handle` strict body `{decision:'approve'|'deny',scopes:('qingdan:read'|'qingdan:write'|'offline_access')[],canvas_ids:string[],csrf:string}`. Denial supplies empty arrays. Success is ONLY `{redirect_to:string}`; browser navigates there after durable approval or verified denial. Expired/reused/stale/bad-binding/CSRF forms return403 and must restart OAuth; they do not return a callback.

`GET /api/profile/mcp-grants?limit=20&cursor=...`:

```ts
{
  enabled: boolean, resource: string|null,
  items: {
    id:string, client_id:string, resource:string,
    scopes:('qingdan:read'|'qingdan:write'|'offline_access')[],
    state:'pending'|'active'|'revoked', created_at:number, expires_at:number,
    revoked_at:number|null, last_used_at:number|null,
    client:{id:string,name:string,domain:string|null,name_verified:boolean},
    canvases:{canvas_id:string,name:string,role:'owner'|'editor'}[]
  }[],
  next_cursor:string|null
}
```

Management query defaults20/max50 and uses descending `(created_at,id)` keyset pagination bound to the account; malformed or another account's cursor returns400. Current membership is rejoined for each grant's selected rooms (max2000), so names of rooms the user left are never exposed. Provider grant IDs are excluded. Safe name/domain come from official client metadata lookup; on provider/client unavailability the client ID is the display fallback. `enabled:false` lets profile show disabled state even with historical connections. Grants expiring by time can still have stored state active; UI should compare `expires_at` against current time.

`DELETE /api/profile/mcp-grants/:id`: no body; own grant only; returns `{ok:true}`. Missing/unowned grant404; repeat own revoke is safe. D1 revocation commits before provider cleanup.

`GET /api/rooms/:canvasId/mcp-operations?limit=20&cursor=...`: Task2 bounded own-only `{items,next_cursor}`. Item exact shape `{operation_id,tool,client_id,created_at,result:{canvas_id,note_id,revision,changed,task_count},restorable_until,restored}`. It never returns deleted text/raw input/saved rows/large block-ID lists. Current session/member and original actor are checked.

`POST /api/rooms/:canvasId/mcp-operations/:operationId/restore`: strict body `{request_id:string}` (nonempty,max256). Returns Task1 restore result plus original `operation_id` and current `sequence`, through Task2's immutable operation-ID restore receipt. The transport request ID is validated but recovery idempotency is stronger: one immutable restore result per original operation, irrespective of retry request ID. Current session/member/original actor and30-day window apply even after grant revocation. Business error JSON maps NOT_FOUND404, ACCESS_DENIED403, other conflicts409; generic HTTP errors preserve their original status.

## Configuration and fixtures

`MCP_ENABLED` defaults false in production+preview; PUBLIC_ORIGIN is existing optional configuration; MCP_ALLOWED_ORIGINS and optional OAUTH_KV types were added. No real KV IDs were inserted. `docs/mcp-configuration.md` documents separate production/preview/local placeholder bindings, required origin, flags, lifecycle, protocol paths and isolated local persistence. `.dev.vars.example` adds only safe disabled placeholders. Worker-first assets paths include `/api/*`, `/mcp`, `/mcp/*`, `/oauth/*`, `/.well-known/*`, inherited by preview. The normal manual deployment workflow remains required.

The new `tests/mcp-oauth.test.mjs` uses real production Worker/CanvasRoom, official provider+SDK+Agents bundled with esbuild workerd conditions, real isolated Miniflare/workerd, local KV and D1/SQLite DOs under a unique `.tmp/mcp-oauth-*` directory. No real external HTTP fetch, development data, .dev.vars, remote KV/D1, accounts or secrets are used. Synthetic S256 public DCR clients use a loopback callback; tests use a complete modern per-request envelope/headers and legacy stateless messages. The fixture normalizes Host to the logical dispatch URL because Miniflare's internal proxy otherwise exposes127.0.0.1 in Host despite `https://app.test`; production canonical Host/origin checks remain active. Test-only DB wrappers schedule REAL D1 activation batches for overlap/session-invalidation, and an isolated KV wrapper injects display cleanup failure. No test hooks were added to production code.

Existing Worker fixtures needed `nodejs_compat`, workerd export conditions and mainFields for exact runtime dependencies. Existing Node-only email/registration tests bundle provider with their Workerd-base fixture, since provider imports WorkerEntrypoint; these routes do not instantiate/use OAuth. Actual provider behavior is tested only in real workerd.

## RED/GREEN and verification evidence

1. Wrote lifecycle test BEFORE production implementation. After correcting fixture persistence options, `node --test tests/mcp-oauth.test.mjs` RED: exit1,2 tests/0 passed/2 failed,1398.6336ms (`.tmp/mcp-oauth-red.log`). Real discovery returned500 and DCR returned500 because old Worker sent protocol paths to nonexistent fixture ASSETS; assertions expected canonical discovery200/DCR201. This is the missing-route feature failure, not an import-only test.
2. Initial implementation GREEN:6/6 (`.tmp/mcp-oauth-green.log`), including discovery/resource challenge, S256/resource rejection, DCR→browser consent→code→PKCE token,9 native tools and schema listing, read-only HTTP403 challenge, selected canvas denial, no-Origin versus forbidden Origin, modern+legacy transport, refresh and disconnect. Corrected fixture details during bring-up: neutral esbuild needed package mainFields/workerd condition; actual legacy response is SSE, modern requests require the complete standard envelope/headers; content projection uses items/task_id.
3. Expanded session/CSRF/frame/mutation/audit/recovery/pagination cases GREEN10/10. Added deterministic concurrent-activation regression BEFORE changing activation: RED13 tests/11 passed/2 failed,2704.9021ms (`.tmp/mcp-oauth-race-red.log`). Both valid approval responses produced unusable codes and0 active grants instead of1. Fixed activation+replacement in a single guarded D1 batch; GREEN13/13 (`.tmp/mcp-oauth-race-green.log`). The session-invalidated activation fixture also verifies pending state, no orphan provider grant, and an existing prior active token still usable.
4. Added post-activation display cleanup regression BEFORE best-effort deletion: RED15 tests/13 passed/2 failed,3429.2954ms (`.tmp/mcp-task3-cleanup-red.log`): injected KV display-context deletion returned500 instead of200 and tore down the successful provider association. Made non-authoritative display cleanup best-effort; final focused suite below passes. Other expanded cases verify explicit write selection beyond requested read, HTTP403 native scope challenge in BOTH eras, real create/delete/audit/restore, current membership removal, absolute D1 expiry refresh denial, account-bound management pages, durable DCR throttle, no refresh without offline, ordinary logout retains active token, password change revokes provider token.
5. First full `npm test`:386 tests/384 passed/2 failed; failures were Node-only `email-recovery.test.mjs` and `registration-email.test.mjs` loading provider's Workerd-only WorkerEntrypoint through external-package imports. Adapted those fixtures as described; focused17/17 then full401/401 passed. No failing test was ignored.
6. Final `node --test tests/mcp-oauth.test.mjs tests/mcp-storage.test.mjs`: exit0,41 passed/0 failed,6564.9445ms (`.tmp/mcp-task3-focused-final.log`). This includes15 OAuth tests and26 Task2 storage/race/credential regressions.
7. Final `npm test`: exit0,403 passed/0 failed,26227.385ms (`.tmp/mcp-task3-full-final.log`).
8. `npm run check`: exit0 (`tsc --noEmit`). `git diff --check`: exit0 (Git's existing LF→CRLF advisories only).
9. `npm run deploy:check`: exit0; Vite build then Wrangler deploy --dry-run, no deployment. Worker upload1628.63KiB raw/303.94KiB gzip; expected existing Vite >500KiB chunk advisory; binding display confirms MCP_ENABLED false and no OAUTH_KV configured (`.tmp/mcp-task3-deploy.log`).
10. `npm audit --omit=dev --json`: production dependency vulnerabilities0 (`.tmp/mcp-task3-audit.json`). npm install reported3 total dev-chain advisories (2 moderate,1 high); no broad dependency upgrade/audit fix performed.

## Self-review and concerns for Task 5

Reviewed final route ordering, exact reserved SPA exception, provider Headers handling, fixed resource/issuer, original verified context, native scope gates, DO/private grant enforcement, callback failure compensation, bound GET/POST/deny state transitions, atomic replacement, credential-race predicates and revocation ordering. Reviewed browser display projections and bounded account-bound management cursor. D1 existing credential revocation conditions and WebSocket/receipt/restore semantics are not weakened. Library-supplied JSON-RPC and token flow are preserved.

Deferred explicitly to Task5: expired open/selected/pending D1 selections/grants currently fail closed but are NOT garbage-collected. No claim of full D1 lifecycle cleanup is made. Existing Task2 DO deletion-snapshot alarm cleanup remains implemented. Provider/app display records have provider/KV TTLs; provider purge scheduling is not installed.

Provider correlation/compensation is deliberately bounded to1000 summaries per attempt. If a user's provider KV directory exceeds that budget, or KV visibility/outage hides a freshly issued association, authorization fails closed with pending app state and no successful callback. A discoverable orphan within the bounded scan is revoked. Provider cleanup is best-effort, logs only a generic warning on failure, and has no persisted retry queue; provider credentials left after infrastructure failure still fail immediate D1 authorization/refresh checks. Task5 can add bounded maintenance/retry and retention policy. A race in which a newer completed authorization replaces an earlier code before that client exchanges it intentionally leaves one current grant, following the design policy.

CIMD is configured through the official provider and strictly-public flag; this test suite exercises real DCR, not an outbound CIMD HTTP fixture. No claim is made that Claude Desktop/Claude Code/Cursor/Codex applications were actually opened, configured or accepted end-to-end; automated modern/legacy protocol tests are not four-client acceptance. No frontend consent/connection UI is authored in Task3; Task4 must implement the documented APIs/path and stale-result handling.

Changed production: `worker/mcp/auth.ts`, `config.ts`, `router.ts`, `provider-cleanup.ts`, `consent.ts`, `server.ts`, `tools.ts`, `grants.ts`; `worker/index.ts`, `types.ts`, `accounts.ts`, `email-recovery.ts`; `package.json`, `package-lock.json`, `wrangler.jsonc`, `.dev.vars.example`, `docs/mcp-configuration.md`. Tests: new OAuth test/fixture plus necessary esbuild/runtime adaptations in the existing storage/email/registration fixtures. No migration changes.
