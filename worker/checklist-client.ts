import type { Env } from "./types";
import { HttpError } from "./http";
import {
  authorizeExecution,
  type ExecutionPrincipal,
} from "./execution/execution-auth";

// Only Worker-constructed principals cross this private Durable Object boundary.
export async function callAgentChecklist(
  env: Env,
  principal: ExecutionPrincipal,
  input: unknown,
): Promise<Record<string, any>> {
  const { binding } = await authorizeExecution(env, principal);
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(binding.canvas_id),
  ).fetch("https://canvas.internal/internal/agent-checklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principal, input }),
    signal: AbortSignal.timeout(5000),
  });
  const value = (await response.json()) as Record<string, any>;
  if (!response.ok)
    throw new HttpError(
      response.status,
      String(value.error ?? value.message ?? "真实清单操作失败。"),
    );
  return value;
}
