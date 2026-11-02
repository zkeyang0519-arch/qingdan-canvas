import { McpServer, requireScopes } from "@modelcontextprotocol/server";
import type { Env } from "../types";
import { HttpError } from "../http";
import { toolSchemas, type ToolName } from "./schemas";
import { callCanvasMcp, isWriteTool } from "./canvas-rpc";
import { listMcpCanvases, requireMcpGrant } from "./grants";
import { McpBusinessError, businessErrorResult } from "./errors";
import type { McpPrincipal } from "./contracts";
const descriptions: Record<ToolName, string> = {
  list_canvases: "List selected canvases you currently belong to.",
  get_canvas: "Read sections and notes in one selected canvas.",
  search_content:
    "Search tasks or notes, with bounded results and optional filters.",
  get_content: "Read one note or task with its revision.",
  create_tasks:
    "Append task blocks to an existing note or create a note in a section.",
  update_task: "Update one task block using the current note revision.",
  delete_task:
    "Delete one task block. Recoverable by the original user for 30 days.",
  create_note: "Create a text or checklist note in a section.",
  update_note: "Edit, append or remove note blocks and update note style.",
};
export function registerTools(
  server: McpServer,
  env: Env,
  ctx: ExecutionContext,
  principal: McpPrincipal,
) {
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const write = isWriteTool(name);
    const scopes = write
      ? (["qingdan:read", "qingdan:write"] as const)
      : (["qingdan:read"] as const);
    server.registerTool(
      name,
      {
        title: name.split("_").join(" "),
        description: descriptions[name],
        inputSchema: toolSchemas[name],
        annotations: {
          readOnlyHint: !write,
          destructiveHint: ["update_task", "delete_task", "update_note"].includes(name),
          idempotentHint: true,
          openWorldHint: false,
        },
        scopeChallenge: async (context) => {
          const tokenChallenge = await (
            write
              ? requireScopes("qingdan:read", "qingdan:write")
              : requireScopes("qingdan:read")
          )(context);
          if (tokenChallenge) return tokenChallenge;
          const active = await requireMcpGrant(env, principal);
          return scopes.some((scope) => !active.scopes.includes(scope))
            ? { scopes: [...scopes] as [string, ...string[]] }
            : undefined;
        },
      },
      async (input: unknown) => {
        try {
          const value =
            name === "list_canvases"
              ? await listMcpCanvases(env, principal, input)
              : await callCanvasMcp(
                  env,
                  String((input as { canvas_id: string }).canvas_id),
                  principal,
                  name,
                  input,
                );
          ctx.waitUntil(
            env.DB.prepare(
              "UPDATE mcp_grants SET last_used_at=? WHERE id=? AND state='active'",
            )
              .bind(Date.now(), principal.grantId)
              .run()
              .catch(() => {}),
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          if (error instanceof McpBusinessError)
            return businessErrorResult(error);
          if (error instanceof HttpError)
            return businessErrorResult(
              new McpBusinessError(
                error.status === 403 || error.status === 401
                  ? "ACCESS_DENIED"
                  : error.status === 404
                    ? "NOT_FOUND"
                    : "VALIDATION_ERROR",
                error.message,
              ),
            );
          throw new Error("Canvas operation failed.");
        }
      },
    );
  }
}
