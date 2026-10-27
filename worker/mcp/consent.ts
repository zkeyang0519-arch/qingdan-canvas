import { cleanupProviderGrants } from "./provider-cleanup";
import { supportedScopes } from "./config";
import {
  AuthorizationError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Env } from "../types";
import { requireSession, token } from "../auth";
import { body, check, json, sameOrigin, HttpError } from "../http";
import { oauthApi, mcpEnabled } from "./auth";
import {
  bindMcpConsent,
  submitMcpConsentSelection,
  createPendingMcpGrant,
  activateMcpGrant,
  revokeMcpGrant,
  listMcpGrants,
  mcpResource,
} from "./grants";
import { callCanvasOperations } from "./canvas-rpc";
import { McpBusinessError } from "./errors";
interface DisplayContext {
  client: ConsentDescription;
  csrf: string;
  browser: string;
  expiresAt: number;
}
const key = (h: string) => "qingdan:consent:" + h;
const cookieName = (h: string) => "__Host-qd-mcp-" + h;
export function protectConsentDocument(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
const responseJson = (data: unknown, headers?: Headers) => {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  return protectConsentDocument(
    new Response(JSON.stringify(data), { headers: h }),
  );
};
export async function authorizationPage(request: Request, env: Env) {
  check(request.method === "GET", "Method not allowed.", 405);
  try {
    const api = oauthApi(env),
      auth = await api.parseAuthRequest(request);
    check(
      auth.codeChallengeMethod === "S256" && !!auth.codeChallenge,
      "PKCE S256 is required.",
    );
    check(auth.resource === mcpResource(env), "Invalid resource.");
    check(
      auth.scope.every((s) =>
        supportedScopes.includes(s as (typeof supportedScopes)[number]),
      ),
      "Invalid scope.",
    );
    const display = await api.describeConsent(auth),
      transaction = await api.beginConsent(auth);
    const context: DisplayContext = {
      client: display,
      csrf: token(),
      browser: token(),
      expiresAt: Date.now() + 600000,
    };
    await env.OAUTH_KV!.put(key(transaction.handle), JSON.stringify(context), {
      expirationTtl: 600,
    });
    const headers = new Headers(transaction.headers);
    headers.append(
      "Set-Cookie",
      `${cookieName(transaction.handle)}=${context.browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    headers.set(
      "Location",
      "/mcp/consent?handle=" + encodeURIComponent(transaction.handle),
    );
    return protectConsentDocument(new Response(null, { status: 302, headers }));
  } catch (error) {
    if (error instanceof AuthorizationError)
      return json({ error: error.code, error_description: error.message }, 400);
    throw error;
  }
}
const selection = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  scopes: z.array(z.enum(supportedScopes)).max(3),
  canvas_ids: z.array(z.string().min(1).max(100)).max(2000),
  csrf: z.string().min(1).max(256),
});
export async function consentApi(request: Request, env: Env) {
  sameOrigin(request);
  const session = await requireSession(request, env);
  check(
    !request.headers.get("X-QD-Account") ||
      request.headers.get("X-QD-Account") === session.id,
    "Account switched.",
    401,
  );
  const handle = decodeURIComponent(
    new URL(request.url).pathname.slice("/api/mcp/consent/".length),
  );
  check(/^[A-Za-z0-9_-]{1,256}$/.test(handle), "Invalid consent.", 403);
  const context = await env.OAUTH_KV!.get<DisplayContext>(key(handle), "json");
  check(
    context && context.expiresAt > Date.now(),
    "Consent expired. Restart authorization.",
    403,
  );
  const cookie = request.headers.get("Cookie") || "";
  check(
    cookie
      .split(";")
      .map((s) => s.trim())
      .includes(cookieName(handle) + "=" + context.browser),
    "Consent browser does not match.",
    403,
  );
  await bindMcpConsent(env, session, {
    handle,
    clientId: context.client.clientId,
    resource: mcpResource(env),
    scopes: [...supportedScopes],
  });
  if (request.method === "GET") {
    const rooms = await env.DB.prepare(
      "SELECT r.id AS canvas_id,r.name,m.role FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=? AND m.role IN ('owner','editor') ORDER BY r.name,r.id LIMIT 2001",
    )
      .bind(session.id)
      .all<{ canvas_id: string; name: string; role: string }>();
    check(rooms.results.length <= 2000, "Too many canvases for consent.", 409);
    return responseJson({
      handle,
      csrf: context.csrf,
      expires_at: context.expiresAt,
      account: {
        id: session.id,
        name: session.name,
        username: session.username,
      },
      client: {
        id: context.client.clientId,
        name: context.client.clientName,
        domain: context.client.clientDomain ?? null,
        redirect_host: context.client.redirectHost,
        redirect_is_loopback: context.client.redirectIsLoopback,
        name_verified: !!context.client.clientDomain,
      },
      requested_scopes: context.client.scope,
      supported_scopes: supportedScopes,
      resource: mcpResource(env),
      canvases: rooms.results,
    });
  }
  check(request.method === "POST", "Method not allowed.", 405);
  const parsed = selection.safeParse(await body(request));
  check(parsed.success, "Invalid consent input.");
  const input = parsed.data;
  check(input.csrf === context.csrf, "Invalid CSRF.", 403);
  const api = oauthApi(env);
  try {
    if (input.decision === "deny") {
      const claimed = await env.DB.prepare(
        "UPDATE mcp_consent_selections SET state='revoked' WHERE handle=? AND account_id=? AND session_hash=? AND state='open' AND expires_at>? AND EXISTS(SELECT 1 FROM account_sessions s WHERE s.token_hash=mcp_consent_selections.session_hash AND s.account_id=mcp_consent_selections.account_id AND s.expires_at>?)",
      )
        .bind(handle, session.id, session.token_hash, Date.now(), Date.now())
        .run();
      check(claimed.meta.changes === 1, "Consent is already consumed.", 403);
      const denied = await api.denyConsent(request, handle);
      await env.OAUTH_KV!.delete(key(handle)).catch(() => {});
      return responseJson({ redirect_to: denied.redirectTo }, denied.headers);
    }
    await submitMcpConsentSelection(env, session, handle, {
      scopes: input.scopes,
      canvasIds: input.canvas_ids,
    });
    const pending = await createPendingMcpGrant(env, session, handle);
    let providerId: string | undefined;
    const approved = await api.approveConsent(request, handle, {
      scope: input.scopes,
    });
    try {
      const completed = await api.completeAuthorization({
        request: approved.request,
        userId: session.id,
        scope: input.scopes,
        props: { appGrantId: pending.grantId },
        metadata: {
          appGrantId: pending.grantId,
          clientName: context.client.clientName,
          clientDomain: context.client.clientDomain ?? null,
          redirectHost: context.client.redirectHost,
        },
        revokeExistingGrants: false,
      });
      // Official metadata correlation only. Bounded by provider page size and a fixed page budget.
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const grants = await api.listUserGrants(session.id, {
          cursor,
          limit: 100,
        });
        const own = grants.items.find(
          (g) =>
            g.metadata?.appGrantId === pending.grantId &&
            g.clientId === context.client.clientId,
        );
        if (own) {
          providerId = own.id;
          break;
        }
        if (!grants.cursor) break;
        cursor = grants.cursor;
      }
      check(
        providerId,
        "Provider association could not be verified. Restart authorization.",
        503,
      );
      const activated = await activateMcpGrant(
        env,
        session,
        pending.grantId,
        providerId,
        true,
      );
      await cleanupProviderGrants(env, session.id, activated.replaced);
      await env.OAUTH_KV!.delete(key(handle)).catch(() => {});
      return responseJson(
        { redirect_to: completed.redirectTo },
        approved.headers,
      );
    } catch (error) {
      if (providerId)
        await cleanupProviderGrants(env, session.id, [
          { provider_grant_id: providerId },
        ]);
      // Leave a failed issuance pending/unusable. If correlation itself failed, clean up by app metadata.
      if (!providerId) {
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const grants = await api.listUserGrants(session.id, {
            cursor,
            limit: 100,
          });
          for (const g of grants.items)
            if (g.metadata?.appGrantId === pending.grantId)
              await api.revokeGrant(g.id, session.id);
          if (!grants.cursor) break;
          cursor = grants.cursor;
        }
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new HttpError(403, "Consent expired or already consumed.");
    throw error;
  }
}
export async function managementApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  sameOrigin(request);
  const session = await requireSession(request, env);
  check(
    !request.headers.get("X-QD-Account") ||
      request.headers.get("X-QD-Account") === session.id,
    "Account switched.",
    401,
  );
  const u = new URL(request.url),
    p = u.pathname;
  if (p === "/api/profile/mcp-grants") {
    check(request.method === "GET", "Method not allowed.", 405);
    const listed = await listMcpGrants(env, session.id, {
      limit: u.searchParams.has("limit")
        ? Number(u.searchParams.get("limit"))
        : 20,
      cursor: u.searchParams.get("cursor") || undefined,
    });
    const api = mcpEnabled(env) ? oauthApi(env) : null;
    const items = await Promise.all(
      listed.items.map(async (grant) => {
        const rooms = await env.DB.prepare(
          "SELECT r.id AS canvas_id,r.name,m.role FROM mcp_grant_rooms gr JOIN rooms r ON r.id=gr.room_id JOIN members m ON m.room_id=r.id WHERE gr.grant_id=? AND m.user_id=? AND m.role IN ('owner','editor') ORDER BY r.id LIMIT 2000",
        )
          .bind(grant.id, session.id)
          .all();
        let clientName = grant.client_id,
          domain: string | null = null;
        if (api)
          try {
            const client = await api.lookupClient(grant.client_id);
            clientName = client?.clientName || grant.client_id;
            if (/^https:\/\//.test(grant.client_id))
              domain = new URL(grant.client_id).hostname;
          } catch {}
        const { provider_grant_id, ...safe } = grant;
        return {
          ...safe,
          client: {
            id: grant.client_id,
            name: clientName,
            domain,
            name_verified: !!domain,
          },
          canvases: rooms.results,
        };
      }),
    );
    return json({
      enabled: mcpEnabled(env),
      resource: env.PUBLIC_ORIGIN ? mcpResource(env) : null,
      items,
      next_cursor: listed.next_cursor,
    });
  }
  const revoke = p.match(
    /^\/api\/profile\/mcp-grants\/([A-Za-z0-9_-]{1,256})$/,
  );
  if (revoke) {
    check(request.method === "DELETE", "Method not allowed.", 405);
    const g = await revokeMcpGrant(env, session.id, revoke[1]);
    await cleanupProviderGrants(env, session.id, [
      { provider_grant_id: g.providerGrantId },
    ]);
    return json({ ok: true });
  }
  const audit = p.match(
    /^\/api\/rooms\/([A-Za-z0-9_-]{1,100})\/mcp-operations(?:\/([A-Za-z0-9_-]{1,100})\/restore)?$/,
  );
  check(audit, "Not found.", 404);
  try {
    if (audit[2]) {
      check(request.method === "POST", "Method not allowed.", 405);
      const input = z
        .strictObject({ request_id: z.string().min(1).max(256) })
        .safeParse(await body(request));
      check(input.success, "Invalid restore input.");
      return await callCanvasOperations(env, request, audit[1], {
        action: "restore",
        operation_id: audit[2],
      });
    }
    check(request.method === "GET", "Method not allowed.", 405);
    return await callCanvasOperations(env, request, audit[1], {
      action: "list",
      ...(u.searchParams.has("limit")
        ? { limit: Number(u.searchParams.get("limit")) }
        : {}),
      ...(u.searchParams.has("cursor")
        ? { cursor: u.searchParams.get("cursor") }
        : {}),
    });
  } catch (error) {
    if (error instanceof McpBusinessError)
      return json(
        {
          error: error.message,
          code: error.code,
          retryable: error.retryable,
          details: error.details,
        },
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "ACCESS_DENIED"
            ? 403
            : 409,
      );
    throw error;
  }
}
