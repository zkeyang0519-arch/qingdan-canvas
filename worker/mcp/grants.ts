import { z } from "zod";
import type { Env, Session } from "../types";
import type { McpPrincipal } from "./contracts";
import { check } from "../http";
import { McpBusinessError } from "./errors";
import { parseToolInput } from "./schemas";

export const grantLifetime = 30 * 86400000;
export const consentLifetime = 10 * 60000;
const scopeSchema = z
  .array(z.enum(["qingdan:read", "qingdan:write", "offline_access"]))
  .min(1)
  .max(3)
  .refine((s) => s.includes("qingdan:read") && new Set(s).size === s.length);
const id = z.string().min(1).max(256);
const selectionSchema = z.strictObject({
  handle: id,
  clientId: id,
  resource: id,
  scopes: scopeSchema,
  canvasIds: z
    .array(id)
    .min(1)
    .max(2000)
    .refine((a) => new Set(a).size === a.length),
});
const principalSchema = z.strictObject({
  accountId: id,
  clientId: id,
  grantId: id,
  resource: id,
  scopes: z.array(z.string().max(256)).max(20),
});
export function mcpResource(env: Env) {
  check(env.PUBLIC_ORIGIN, "MCP origin is not configured.", 503);
  const origin = new URL(env.PUBLIC_ORIGIN);
  check(
    origin.origin === env.PUBLIC_ORIGIN &&
      ["https:", "http:"].includes(origin.protocol),
    "Invalid MCP origin configuration.",
    503,
  );
  return `${origin.origin}/mcp`;
}
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new McpBusinessError("VALIDATION_ERROR", "Invalid grant input.");
  return result.data;
}
interface GrantRow {
  id: string;
  provider_grant_id: string | null;
  account_id: string;
  client_id: string;
  resource: string;
  scopes: string;
  state: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  account_name?: string;
}
export async function requireMcpGrant(
  env: Env,
  supplied: McpPrincipal,
  canvasId?: string,
  write = false,
) {
  const principal = valid(principalSchema, supplied);
  const row = await env.DB.prepare(
    `SELECT g.*,a.name AS account_name FROM mcp_grants g JOIN accounts a ON a.id=g.account_id WHERE g.id=? AND g.account_id=? AND g.client_id=? AND g.resource=? AND g.state='active' AND g.provider_grant_id IS NOT NULL AND g.expires_at>?`,
  )
    .bind(
      principal.grantId,
      principal.accountId,
      principal.clientId,
      principal.resource,
      Date.now(),
    )
    .first<GrantRow>();
  check(
    principal.resource === mcpResource(env) && row,
    "MCP authorization is no longer valid.",
    401,
  );
  const granted = valid(scopeSchema, JSON.parse(row.scopes));
  for (const scope of write
    ? ["qingdan:read", "qingdan:write"]
    : ["qingdan:read"])
    check(
      principal.scopes.includes(scope) &&
        granted.includes(scope as "qingdan:read" | "qingdan:write"),
      "Insufficient MCP scope.",
      403,
    );
  if (canvasId !== undefined) {
    const selected = await env.DB.prepare(
      `SELECT r.id,r.name,m.role FROM mcp_grant_rooms gr JOIN rooms r ON r.id=gr.room_id JOIN members m ON m.room_id=r.id AND m.user_id=? WHERE gr.grant_id=? AND r.id=? AND m.role IN ('owner','editor')`,
    )
      .bind(row.account_id, row.id, canvasId)
      .first<{ id: string; name: string; role: string }>();
    check(selected, "Canvas access denied.", 403);
    return {
      accountId: row.account_id,
      accountName: row.account_name!,
      grantId: row.id,
      clientId: row.client_id,
      resource: row.resource,
      scopes: granted,
      canvasName: selected.name,
      role: selected.role,
    };
  }
  return {
    accountId: row.account_id,
    accountName: row.account_name!,
    grantId: row.id,
    clientId: row.client_id,
    resource: row.resource,
    scopes: granted,
  };
}
const bindingSchema = selectionSchema.omit({ canvasIds: true });
const submittedSchema = selectionSchema.pick({ scopes: true, canvasIds: true });
// Bind at authenticated consent GET, before presenting selectable rooms. Safe
// GET retries reuse an open binding without extending its original expiry.
export async function bindMcpConsent(
  env: Env,
  session: Session,
  input: unknown,
) {
  const data = valid(bindingSchema, input);
  check(data.resource === mcpResource(env), "Invalid MCP resource.", 403);
  const now = Date.now(),
    expires = now + consentLifetime;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO mcp_consent_selections(handle,account_id,session_hash,client_id,resource,scopes,canvas_ids,state,created_at,expires_at) SELECT ?,?,?,?,?,?,'[]','open',?,? WHERE EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=? AND account_id=? AND expires_at>?)`,
  )
    .bind(
      data.handle,
      session.id,
      session.token_hash,
      data.clientId,
      data.resource,
      JSON.stringify([...data.scopes].sort()),
      now,
      expires,
      session.token_hash,
      session.id,
      now,
    )
    .run();
  if (result.meta.changes === 1)
    return { handle: data.handle, expiresAt: expires };
  const existing = await env.DB.prepare(
    `SELECT c.expires_at FROM mcp_consent_selections c JOIN account_sessions s ON s.token_hash=c.session_hash AND s.account_id=c.account_id
     WHERE c.handle=? AND c.account_id=? AND c.session_hash=? AND c.client_id=? AND c.resource=? AND c.scopes=? AND c.state='open' AND c.expires_at>? AND s.expires_at>?`,
  )
    .bind(
      data.handle,
      session.id,
      session.token_hash,
      data.clientId,
      data.resource,
      JSON.stringify([...data.scopes].sort()),
      now,
      now,
    )
    .first<{ expires_at: number }>();
  check(existing, "Consent handle is already bound or session expired.", 403);
  return { handle: data.handle, expiresAt: existing.expires_at };
}
// One conditional transition consumes the submitted selection. Scope can be
// narrowed, and selected rooms are checked again when pending is created.
export async function submitMcpConsentSelection(
  env: Env,
  session: Session,
  handle: string,
  input: unknown,
) {
  valid(id, handle);
  const data = valid(submittedSchema, input),
    now = Date.now();
  const scopes = JSON.stringify([...data.scopes].sort()),
    canvases = JSON.stringify([...data.canvasIds].sort());
  const result = await env.DB.prepare(
    `UPDATE mcp_consent_selections SET scopes=?,canvas_ids=?,state='selected'
 WHERE handle=? AND account_id=? AND session_hash=? AND state='open' AND expires_at>? AND resource=?
 AND EXISTS(SELECT 1 FROM account_sessions s WHERE s.token_hash=mcp_consent_selections.session_hash AND s.account_id=mcp_consent_selections.account_id AND s.expires_at>?)
 AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value NOT IN (SELECT value FROM json_each(mcp_consent_selections.scopes)))
 AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=j.value AND m.user_id=mcp_consent_selections.account_id AND m.role IN ('owner','editor')))`,
  )
    .bind(
      scopes,
      canvases,
      handle,
      session.id,
      session.token_hash,
      now,
      mcpResource(env),
      now,
      scopes,
      canvases,
    )
    .run();
  check(
    result.meta.changes === 1,
    "Consent selection denied, expired or already submitted.",
    403,
  );
  return { handle };
}
// Convenience for trusted server flows already holding the intended selection.
// Browser consent must use bindMcpConsent at GET and submit at POST separately.
export async function createConsentSelection(
  env: Env,
  session: Session,
  input: unknown,
) {
  const data = valid(selectionSchema, input);
  const binding = await bindMcpConsent(env, session, {
    handle: data.handle,
    clientId: data.clientId,
    resource: data.resource,
    scopes: data.scopes,
  });
  await submitMcpConsentSelection(env, session, data.handle, {
    scopes: data.scopes,
    canvasIds: data.canvasIds,
  });
  return binding;
}
export async function createPendingMcpGrant(
  env: Env,
  session: Session,
  handle: string,
) {
  valid(id, handle);
  const grantId = crypto.randomUUID(),
    now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mcp_grants(id,account_id,client_id,resource,scopes,state,consent_handle,created_at,expires_at)
 SELECT ?,c.account_id,c.client_id,c.resource,c.scopes,'pending',c.handle,?,? FROM mcp_consent_selections c JOIN account_sessions s ON s.token_hash=c.session_hash AND s.account_id=c.account_id
 WHERE c.handle=? AND c.account_id=? AND c.session_hash=? AND c.state='selected' AND c.expires_at>? AND s.expires_at>?
 AND NOT EXISTS(SELECT 1 FROM json_each(c.canvas_ids) j WHERE NOT EXISTS(SELECT 1 FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=j.value AND m.user_id=c.account_id AND m.role IN ('owner','editor')))`,
    ).bind(
      grantId,
      now,
      now + grantLifetime,
      handle,
      session.id,
      session.token_hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO mcp_grant_rooms(grant_id,room_id) SELECT g.id,j.value FROM mcp_grants g JOIN mcp_consent_selections c ON c.handle=g.consent_handle,json_each(c.canvas_ids) j WHERE g.id=?`,
    ).bind(grantId),
    env.DB.prepare(
      `UPDATE mcp_consent_selections SET state='pending',grant_id=? WHERE handle=? AND state='selected' AND EXISTS(SELECT 1 FROM mcp_grants WHERE id=?)`,
    ).bind(grantId, handle, grantId),
  ]);
  check(
    results[0].meta.changes === 1,
    "Consent is expired, consumed or belongs to another session.",
    403,
  );
  return { grantId, handle };
}
export async function activateMcpGrant(
  env: Env,
  session: Session,
  grantId: string,
  providerGrantId: string,
) {
  valid(id, grantId);
  valid(id, providerGrantId);
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE mcp_grants SET state='active',provider_grant_id=? WHERE id=? AND account_id=? AND state='pending' AND expires_at>? AND resource=?
 AND EXISTS(SELECT 1 FROM mcp_consent_selections c JOIN account_sessions s ON s.token_hash=c.session_hash AND s.account_id=c.account_id WHERE c.handle=mcp_grants.consent_handle AND c.grant_id=mcp_grants.id AND c.state='pending' AND c.account_id=? AND c.session_hash=? AND c.expires_at>? AND s.expires_at>?)`,
    ).bind(
      providerGrantId,
      grantId,
      session.id,
      now,
      mcpResource(env),
      session.id,
      session.token_hash,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE mcp_consent_selections SET state='active' WHERE grant_id=? AND state='pending' AND EXISTS(SELECT 1 FROM mcp_grants WHERE id=? AND state='active' AND provider_grant_id=?)`,
    ).bind(grantId, grantId, providerGrantId),
  ]);
  check(result[0].meta.changes === 1, "Grant activation denied.", 403);
  return { grantId, providerGrantId };
}
export function revokeAllMcpGrantsStatement(env: Env, accountId: string) {
  return env.DB.prepare(
    `UPDATE mcp_grants SET state='revoked',revoked_at=? WHERE account_id=? AND state IN ('pending','active')`,
  ).bind(Date.now(), accountId);
}
export async function listMcpGrants(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id,provider_grant_id,client_id,resource,scopes,state,created_at,expires_at,revoked_at,last_used_at FROM mcp_grants WHERE account_id=? ORDER BY created_at DESC,id DESC`,
  )
    .bind(accountId)
    .all<GrantRow>();
  return {
    items: results.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) })),
  };
}
export async function revokeMcpGrant(
  env: Env,
  accountId: string,
  grantId: string,
) {
  valid(id, grantId);
  const row = await env.DB.prepare(
    "SELECT provider_grant_id FROM mcp_grants WHERE id=? AND account_id=?",
  )
    .bind(grantId, accountId)
    .first<{ provider_grant_id: string | null }>();
  check(row, "Grant not found.", 404);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE mcp_grants SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=? AND account_id=?`,
    ).bind(Date.now(), grantId, accountId),
    env.DB.prepare(
      `UPDATE mcp_consent_selections SET state='revoked' WHERE grant_id=? AND account_id=?`,
    ).bind(grantId, accountId),
  ]);
  return { grantId, providerGrantId: row.provider_grant_id };
}
export async function revokeAllMcpGrants(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id,provider_grant_id FROM mcp_grants WHERE account_id=? AND state IN ('pending','active')`,
  )
    .bind(accountId)
    .all<{ id: string; provider_grant_id: string | null }>();
  await env.DB.batch([
    revokeAllMcpGrantsStatement(env, accountId),
    env.DB.prepare(
      `UPDATE mcp_consent_selections SET state='revoked' WHERE account_id=? AND state IN ('open','selected','pending','active')`,
    ).bind(accountId),
  ]);
  return {
    items: results.map((r) => ({
      grantId: r.id,
      providerGrantId: r.provider_grant_id,
    })),
  };
}
// Keyset pagination is deliberately not a directory snapshot. Every page joins
// current membership and selection again; cursors confer no authorization.
export async function listMcpCanvases(
  env: Env,
  principal: McpPrincipal,
  input: unknown,
) {
  await requireMcpGrant(env, principal);
  const query = parseToolInput("list_canvases", input);
  let after = "";
  if (query.cursor) {
    try {
      const parsed = JSON.parse(atob(query.cursor));
      if (
        parsed.v !== 1 ||
        parsed.grant !== principal.grantId ||
        parsed.account !== principal.accountId ||
        parsed.client !== principal.clientId ||
        typeof parsed.after !== "string" ||
        parsed.after.length > 256 ||
        btoa(JSON.stringify(parsed)) !== query.cursor
      )
        throw Error();
      after = parsed.after;
    } catch {
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Invalid directory cursor.",
      );
    }
  }
  const { results } = await env.DB.prepare(
    `SELECT r.id AS canvas_id,r.name,m.role FROM mcp_grant_rooms gr JOIN rooms r ON r.id=gr.room_id JOIN members m ON m.room_id=r.id AND m.user_id=? WHERE gr.grant_id=? AND r.id>? AND m.role IN ('owner','editor') ORDER BY r.id LIMIT ?`,
  )
    .bind(principal.accountId, principal.grantId, after, query.limit + 1)
    .all<{ canvas_id: string; name: string; role: string }>();
  const items = results.slice(0, query.limit);
  return {
    items,
    next_cursor:
      results.length > query.limit
        ? btoa(
            JSON.stringify({
              v: 1,
              grant: principal.grantId,
              account: principal.accountId,
              client: principal.clientId,
              after: items.at(-1)!.canvas_id,
            }),
          )
        : null,
  };
}
