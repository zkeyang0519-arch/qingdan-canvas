import type { Env } from "../types";
export async function mcpRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const p = new URL(request.url).pathname;
  if (!(
    p === "/mcp" ||
    p.startsWith("/mcp/") ||
    p.startsWith("/oauth/") ||
    p.startsWith("/.well-known/") ||
    p.startsWith("/api/mcp/") ||
    p.startsWith("/api/profile/mcp-grants") ||
    /^\/api\/rooms\/[^/]+\/mcp-operations/.test(p)
  ))
    return null;
  const { mcpRoute: route } = await import("./auth");
  return route(request, env, ctx);
}
