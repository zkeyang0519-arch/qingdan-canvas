import type { Env } from "../types";
import { body, check, json, sameOrigin } from "../http";
import { requireSession } from "../auth";
import { executionToolsRequestSchema } from "../../shared/agent/execution";
import { parse } from "./dispatch";
import { bindingPrincipal, nativePrincipal } from "./execution-auth";
import { callAgentChecklist } from "../checklist-client";
import {
  bridgeExecutionTool,
  callExecutionHub,
  serveExecutionMcp,
} from "./mcp-server";
export async function executionRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url),
    p = url.pathname;
  if (
    p !== "/executor-mcp" &&
    !p.startsWith("/api/agent/execution/") &&
    !p.startsWith("/api/runner/execution/")
  )
    return null;
  check(
    env.EXECUTION_ENABLED === "true" && env.RUNNER_ENABLED === "true",
    "执行服务尚未启用。",
    404,
  );
  check(
    url.protocol === "https:" || url.origin === "http://127.0.0.1:8788",
    "执行连接需要安全入口。",
    403,
  );
  if (p === "/executor-mcp") return serveExecutionMcp(request, env, ctx);
  if (p.startsWith("/api/runner/execution/")) {
    check(request.method === "POST", "方法不支持。", 405);
    const d = await nativePrincipal(request, env),
      input = await body(request, 2_000_000);
    return env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName(d.runner_id)).fetch(
      "https://runner/execution/native/" +
        p.slice("/api/runner/execution/".length),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runnerId: d.runner_id,
          authEpoch: d.auth_epoch,
          input,
        }),
      },
    );
  }
  sameOrigin(request);
  const user = await requireSession(request, env);
  check(
    request.headers.get("X-QD-Account") === user.id,
    "账号已切换，请重新打开。",
    401,
  );
  if (p === "/api/agent/execution/runs") {
    check(request.method === "GET", "方法不支持。", 405);
    const principal = await bindingPrincipal(
      env,
      user.id,
      url.searchParams.get("bindingId") || "",
    );
    return json(await callExecutionHub(env, principal, "runs", {}));
  }
  check(request.method === "POST", "方法不支持。", 405);
  const input = await body(request, 100000);
  check(typeof input.bindingId === "string", "绑定无效。");
  const principal = await bindingPrincipal(env, user.id, input.bindingId);
  if (p === "/api/agent/execution/checklist") {
    check(
      [
        "list",
        "create",
        "save",
        "reorder",
        "receipt",
        "abandon_request",
      ].includes(String(input.action)),
      "清单操作无效。",
      400,
    );
    const { bindingId: _, ...action } = input;
    return json(await callAgentChecklist(env, principal, action));
  }
  if (p === "/api/agent/execution/intents")
    return json(await callExecutionHub(env, principal, "intent", input));
  if (p === "/api/agent/execution/queue")
    return json(await callExecutionHub(env, principal, "queue", input));
  if (p === "/api/agent/execution/respond")
    return json(await callExecutionHub(env, principal, "respond", input));
  if (p === "/api/agent/execution/tools") {
    const data = parse(executionToolsRequestSchema, input);
    return json(
      await bridgeExecutionTool(env, ctx, principal, data.name, data.arguments),
    );
  }
  check(false, "接口不存在。", 404);
}
