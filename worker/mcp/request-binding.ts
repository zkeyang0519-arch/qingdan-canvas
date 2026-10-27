import type { Env } from "../types";
import { digest } from "../auth";
import { check } from "../http";
import type { McpPrincipal, CanvasCommand } from "./contracts";
import { requireMcpGrant } from "./grants";
import { McpBusinessError } from "./errors";
import { canonicalJson } from "./room-storage";
import { parseToolInput, type WriteToolName } from "./schemas";

// This D1 record arbitrates a grant-wide request key across independent room
// databases. It is never a success receipt and is never removed on failure.
export async function reserveMcpRequest(
  env: Env,
  canvasId: string,
  principal: McpPrincipal,
  name: WriteToolName,
  input: unknown,
): Promise<{ command: CanvasCommand; payload: string; inputDigest: string }> {
  const parsed = parseToolInput(name, input);
  if (typeof parsed.request_id !== "string")
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Only write commands can reserve request IDs.",
    );
  check(parsed.canvas_id === canvasId, "Canvas mismatch.", 403);
  await requireMcpGrant(env, principal, canvasId, true);
  const command = { name, input: parsed } as CanvasCommand;
  const payload = canonicalJson({
    accountId: principal.accountId,
    clientId: principal.clientId,
    grantId: principal.grantId,
    resource: principal.resource,
    command,
  });
  const inputDigest = await digest(payload);
  const results = await env.DB.batch<{
    account_id: string;
    client_id: string;
    resource: string;
    canvas_id: string;
    command: string;
    input_digest: string;
  }>([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mcp_request_bindings(grant_id,request_id,account_id,client_id,resource,canvas_id,command,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).bind(
      principal.grantId,
      parsed.request_id,
      principal.accountId,
      principal.clientId,
      principal.resource,
      canvasId,
      name,
      inputDigest,
      Date.now(),
    ),
    env.DB.prepare(
      `SELECT account_id,client_id,resource,canvas_id,command,input_digest FROM mcp_request_bindings WHERE grant_id=? AND request_id=?`,
    ).bind(principal.grantId, parsed.request_id),
  ]);
  const bound = results[1].results[0];
  if (
    !bound ||
    bound.account_id !== principal.accountId ||
    bound.client_id !== principal.clientId ||
    bound.resource !== principal.resource ||
    bound.canvas_id !== canvasId ||
    bound.command !== name ||
    bound.input_digest !== inputDigest
  )
    throw new McpBusinessError(
      "IDEMPOTENCY_KEY_REUSED",
      "Request ID was already bound to another command or canvas.",
    );
  return { command, payload, inputDigest };
}
