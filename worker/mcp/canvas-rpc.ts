import type { Env } from "../types";
import type { McpPrincipal } from "./contracts";
import type { ToolName } from "./schemas";
import { parseToolInput } from "./schemas";
import { requireMcpGrant } from "./grants";
import { requireSession } from "../auth";
import { check, HttpError, json, sameOrigin } from "../http";
import { parseAuditInput } from "./room-storage";
import { McpBusinessError, type BusinessErrorCode } from "./errors";
export const isWriteTool = (name: string) =>
  [
    "create_tasks",
    "update_task",
    "delete_task",
    "create_note",
    "update_note",
  ].includes(name);
async function result(response: Response) {
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (value.code)
      throw new McpBusinessError(
        value.code as BusinessErrorCode,
        String(value.message),
        Boolean(value.retryable),
        value.details as Record<string, unknown> | undefined,
      );
    throw new HttpError(
      response.status,
      String(value.error || "Canvas request failed."),
    );
  }
  return value;
}
export async function callCanvasMcp(
  env: Env,
  canvasId: string,
  principal: McpPrincipal,
  name: Exclude<ToolName, "list_canvases">,
  input: unknown,
) {
  const parsed = parseToolInput(name, input);
  check(parsed.canvas_id === canvasId, "Canvas mismatch.", 403);
  await requireMcpGrant(env, principal, canvasId, isWriteTool(name));
  // Construct a new request and principal; no external headers or actor fields
  // are copied into the private DO envelope.
  return result(
    await env.ROOMS.get(env.ROOMS.idFromName(canvasId)).fetch(
      "https://canvas.internal/internal/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasId,
          principal: {
            accountId: principal.accountId,
            clientId: principal.clientId,
            grantId: principal.grantId,
            resource: principal.resource,
            scopes: [...principal.scopes],
          },
          name,
          input: parsed,
        }),
      },
    ),
  );
}
export async function callCanvasOperations(
  env: Env,
  request: Request,
  canvasId: string,
  input: unknown,
) {
  sameOrigin(request);
  const session = await requireSession(request, env);
  const action = parseAuditInput(input);
  check(
    request.method === "POST" ||
      (request.method === "GET" && action.action === "list"),
    "Method not allowed.",
    405,
  );
  check(
    !request.headers.get("X-QD-Account") ||
      request.headers.get("X-QD-Account") === session.id,
    "Account changed.",
    401,
  );
  const response = await env.ROOMS.get(env.ROOMS.idFromName(canvasId)).fetch(
    "https://canvas.internal/internal/mcp-operations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvasId,
        identity: { accountId: session.id, sessionHash: session.token_hash },
        input: action,
      }),
    },
  );
  const value = await result(response);
  return json(value);
}
