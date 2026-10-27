import type { Env } from "../types";
export async function cleanupProviderGrants(
  env: Env,
  accountId: string,
  rows: { provider_grant_id: string | null }[],
) {
  if (env.MCP_ENABLED !== "true" || !env.PUBLIC_ORIGIN || !env.OAUTH_KV) return;
  try {
    const { oauthApi } = await import("./auth");
    const api = oauthApi(env);
    for (const row of rows)
      if (row.provider_grant_id)
        try {
          await api.revokeGrant(row.provider_grant_id, accountId);
        } catch {
          console.warn("MCP provider cleanup deferred");
        }
  } catch {
    console.warn("MCP provider cleanup deferred");
  }
}
