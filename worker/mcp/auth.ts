import {
  OAuthProvider,
  OAuthError,
  getOAuthApi,
  insufficientScope,
  type OAuthProviderOptions,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../types";
import { check, failure, json, HttpError } from "../http";
import { limit } from "../auth-limits";
import { requireMcpGrant, mcpResource } from "./grants";
import type { McpPrincipal } from "./contracts";
import {
  authorizationPage,
  consentApi,
  managementApi,
  protectConsentDocument,
} from "./consent";
import { supportedScopes } from "./config";
export function mcpEnabled(env: Env) {
  return env.MCP_ENABLED === "true" && !!env.PUBLIC_ORIGIN && !!env.OAUTH_KV;
}
export function principalFrom(
  auth: OAuthResourceAuth,
  props: unknown,
  env: Env,
): McpPrincipal {
  const p = props as { appGrantId?: unknown };
  check(
    typeof p?.appGrantId === "string" && auth.userId && auth.clientId,
    "Invalid token.",
    401,
  );
  const audience = Array.isArray(auth.audience)
    ? auth.audience
    : [auth.audience];
  check(audience.includes(mcpResource(env)), "Invalid audience.", 401);
  return {
    accountId: auth.userId,
    clientId: auth.clientId,
    grantId: p.appGrantId,
    resource: mcpResource(env),
    scopes: auth.scope.filter((s): s is (typeof supportedScopes)[number] =>
      supportedScopes.includes(s as (typeof supportedScopes)[number]),
    ),
  };
}
export function providerOptions(env: Env): OAuthProviderOptions<Env> {
  const origin = new URL(mcpResource(env)).origin;
  return {
    apiRoute: origin + "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const verified = ctx as ExecutionContext & {
          auth: OAuthResourceAuth;
          props: unknown;
        };
        try {
          const principal = principalFrom(verified.auth, verified.props, env);
          await requireMcpGrant(env, principal);
          const { serveMcp } = await import("./server");
          return await serveMcp(request, env, ctx, principal);
        } catch (error) {
          if (error instanceof HttpError) {
            if (error.status === 401)
              return json({ error: "invalid_token" }, 401, {
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
              });
            if (error.status === 403)
              return insufficientScope(verified.auth, ["qingdan:read"]);
          }
          throw error;
        }
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        if (new URL(request.url).pathname === "/oauth/authorize")
          return authorizationPage(request, env);
        return json({ error: "Not found." }, 404);
      },
    },
    authorizeEndpoint: origin + "/oauth/authorize",
    tokenEndpoint: origin + "/oauth/token",
    clientRegistrationEndpoint: origin + "/oauth/register",
    accessTokenTTL: 900,
    refreshTokenTTL: 2592000,
    clientRegistrationTTL: 2592000,
    scopesSupported: [...supportedScopes],
    requiredScopes: ["qingdan:read"],
    clientIdMetadataDocumentEnabled: true,
    allowPrivateUseRedirectUris: true,
    resourceMetadata: {
      resource: origin + "/mcp",
      authorization_servers: [origin],
      resource_name: "轻单协作画布",
    },
    async tokenExchangeCallback(options) {
      try {
        const principal = {
          accountId: options.userId,
          clientId: options.clientId,
          grantId: options.props?.appGrantId,
          resource: options.resource,
          scopes: options.requestedScope,
        } as McpPrincipal;
        await requireMcpGrant(env, principal);
        const row = await env.DB.prepare(
          "SELECT provider_grant_id,expires_at FROM mcp_grants WHERE id=?",
        )
          .bind(principal.grantId)
          .first<{ provider_grant_id: string; expires_at: number }>();
        if (!row || row.provider_grant_id !== options.grantId)
          throw new Error("Association mismatch");
        const remaining = Math.floor((row.expires_at - Date.now()) / 1000);
        if (remaining < 60) throw new Error("Expired");
        return {
          accessTokenTTL: Math.min(900, remaining),
          refreshTokenTTL: options.scope.includes("offline_access")
            ? remaining
            : 0,
        };
      } catch {
        throw new OAuthError("invalid_grant", {
          description: "Authorization is no longer active.",
        });
      }
    },
  };
}
export const oauthApi = (env: Env) => getOAuthApi(providerOptions(env), env);
export async function mcpRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const u = new URL(request.url),
    p = u.pathname;
  const protocol =
    p === "/mcp" ||
    p.startsWith("/mcp/") ||
    p.startsWith("/oauth/") ||
    p.startsWith("/.well-known/");
  const browser =
    p.startsWith("/api/mcp/") ||
    p.startsWith("/api/profile/mcp-grants") ||
    /^\/api\/rooms\/[^/]+\/mcp-operations/.test(p);
  if (!protocol && !browser && p !== "/mcp/consent") return null;
  try {
    if (browser && !p.startsWith("/api/mcp/"))
      return await managementApi(request, env, ctx);
    check(mcpEnabled(env), "MCP is not configured.", 404);
    check(
      u.origin === new URL(mcpResource(env)).origin,
      "Unapproved origin.",
      403,
    );
    if (browser)
      return p.startsWith("/api/mcp/consent/")
        ? consentApi(request, env)
        : managementApi(request, env, ctx);
    if (p === "/mcp/consent")
      return protectConsentDocument(await env.ASSETS.fetch(request));
    const origin = request.headers.get("Origin");
    const allowed = [
      u.origin,
      ...(env.MCP_ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    check(
      !origin || allowed.includes(origin),
      "Unapproved browser origin.",
      403,
    );
    if (p === "/oauth/register" && request.method === "POST")
      await limit(
        env,
        "mcp:dcr:" + (request.headers.get("CF-Connecting-IP") || "local"),
        20,
        3600000,
      );
    let forwarded = request;
    // The provider implements RFC 7009 at its token endpoint. This is only a URL alias.
    if (p === "/oauth/revoke") {
      const target = new URL(request.url);
      target.pathname = "/oauth/token";
      forwarded = new Request(target, request);
    }
    return await new OAuthProvider(providerOptions(env)).fetch(
      forwarded,
      env,
      ctx,
    );
  } catch (error) {
    return failure(error);
  }
}
