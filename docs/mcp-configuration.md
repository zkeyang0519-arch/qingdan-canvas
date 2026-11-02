# Remote MCP configuration

The feature is disabled by default (`MCP_ENABLED="false"`). Normal application routes work without any MCP configuration. Disabled protocol and consent routes return a clear 404. Authenticated grant management and recovery remain available; the management GET returns `enabled:false` so the profile can explain the state.

To enable an environment, configure all of the following in that environment's Wrangler configuration, then perform the project's normal manual deployment workflow:

- `MCP_ENABLED`: `"true"`.
- `PUBLIC_ORIGIN`: the exact externally reachable HTTPS origin, with no path or trailing slash. The resource is always `${PUBLIC_ORIGIN}/mcp`, and the OAuth issuer is exactly that origin. Protocol requests to another origin are rejected.
- `OAUTH_KV`: a dedicated Cloudflare KV binding. Production, preview, and local fixtures must use separate storage. The application never creates a namespace automatically.
- `MCP_ALLOWED_ORIGINS`: optional comma-separated exact browser origins in addition to `PUBLIC_ORIGIN`. Clients without an Origin header work without being listed. Browser credentials still cannot authenticate `/mcp`; OAuth Bearer tokens are required.

The checked-in compatibility flags `nodejs_compat` and `global_fetch_strictly_public` are required by the Agents handler and safe CIMD metadata fetches. Worker-first paths include `/api/*`, `/mcp`, `/mcp/*`, `/oauth/*`, and `/.well-known/*`; preview inherits this assets configuration. Do not use the development KV namespace for production or preview.

Example placeholder binding to add **after obtaining the correct environment-specific IDs** (these placeholders are documentation, not deployed configuration):

```jsonc
// Production top level
"kv_namespaces": [{"binding":"OAUTH_KV", "id":"<PRODUCTION_OAUTH_KV_ID>"}],
// Preview environment configuration
"previews": {
  "vars": {"APP_ENV":"preview", "MCP_ENABLED":"true", "PUBLIC_ORIGIN":"https://<PREVIEW_HOST>"},
  "kv_namespaces": [{"binding":"OAUTH_KV", "id":"<PREVIEW_OAUTH_KV_ID>"}]
}
```

For local development use a separate local-only Wrangler configuration with `"kv_namespaces": [{"binding":"OAUTH_KV", "id":"<LOCAL_ONLY_OAUTH_KV_ID>"}]` and an isolated `--persist-to` path. A local simulator does not contact that documented placeholder ID. OAuth consent cookies are Secure, host-only cookies; use HTTPS for real browser consent testing. Automated tests use `https://app.test`, a dedicated local Miniflare KV/D1/DO directory under `.tmp/mcp-oauth-*`, synthetic accounts, no development secrets, and no real metadata or mail fetches.

Runnable isolated local commands and the four client configurations are in [接入指南](mcp-setup.md); local fixture evidence and the remaining manual release gates are in [验收记录](mcp-acceptance.md). The local example uses `docs/mcp-local.example.jsonc`, all-zero local IDs, HTTPS and a fresh `.tmp/mcp-local-*` persistence path. Never deploy that example configuration.

Discovery is available at `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-protected-resource/mcp`. The provider implements `/oauth/register`, `/oauth/token` (including RFC 7009 revocation), and `/oauth/authorize`. `/oauth/revoke` is a URL alias to the provider's RFC 7009 token endpoint. S256 is required; access tokens last at most 15 minutes and grants at most 30 days from application consent. Refresh never extends the D1 grant lifetime. `offline_access` is required to issue a refresh token.

The exact reserved SPA route `/mcp/consent?handle=...` is dispatched before the provider's `/mcp` prefix. The final HTML response sets frame, referrer and no-store protection. The page itself contains no granted identity: its data API independently requires the existing Cookie session, browser binding, and single-use session/account-bound consent. No global MCP client configuration is changed by this project.

Library versions are pinned: `agents@0.30.1`, `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, and `@cloudflare/workers-oauth-provider@1.2.4`. Agents automatically carries the provider's verified OAuth context into SDK authInfo. The SDK handles modern per-request MCP and legacy stateless Streamable HTTP; there is no application JSON-RPC implementation.

Expired authorization is rejected on every access. Each authenticated consent binding also opportunistically removes at most 100 expired open/selected/pending D1 consent lifecycles, including eligible pending grant-room/grant rows. Deletion rechecks state inside the atomic D1 batch. Active/revoked grant history, successful DO receipts and every global request binding are retained; a pending grant with a request binding is protected too. Idle environments may retain expired temporary metadata until another consent binding. This is bounded cleanup, not a scheduled infrastructure service.

Provider association/orphan discovery is bounded to 10 pages of 100 grants. Provider revocation/cleanup is best-effort after authoritative D1 revocation; provider unavailability cannot make the D1 grant usable. No retry queue is installed. If provider metadata/correlation cannot be established within the bound, authorization fails closed and the user must reconnect. Investigate repeated cleanup failures operationally without exposing credentials in logs.

The local CIMD fixture uses the actual provider fetch/validation/cache code with synthetic HTTPS responses (matching client ID, 5 KiB metadata size ceiling and cache reuse). Its outbound service never contacts the public Internet. It does not certify DNS/private-IP filtering or any real client's CIMD document/callback compatibility; keep `global_fetch_strictly_public` enabled and verify real providers in preview.
