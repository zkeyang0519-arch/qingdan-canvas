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

Discovery is available at `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-protected-resource/mcp`. The provider implements `/oauth/register`, `/oauth/token` (including RFC 7009 revocation), and `/oauth/authorize`. `/oauth/revoke` is a URL alias to the provider's RFC 7009 token endpoint. S256 is required; access tokens last at most 15 minutes and grants at most 30 days from application consent. Refresh never extends the D1 grant lifetime. `offline_access` is required to issue a refresh token.

The exact reserved SPA route `/mcp/consent?handle=...` is dispatched before the provider's `/mcp` prefix. The final HTML response sets frame, referrer and no-store protection. The page itself contains no granted identity: its data API independently requires the existing Cookie session, browser binding, and single-use session/account-bound consent. No global MCP client configuration is changed by this project.

Library versions are pinned: `agents@0.30.1`, `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, and `@cloudflare/workers-oauth-provider@1.2.4`. Agents automatically carries the provider's verified OAuth context into SDK authInfo. The SDK handles modern per-request MCP and legacy stateless Streamable HTTP; there is no application JSON-RPC implementation.
