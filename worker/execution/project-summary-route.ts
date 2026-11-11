import type { Env } from "../types";
import { body, check, json, sameOrigin } from "../http";
import { requireSession } from "../auth";
import { bindingPrincipal } from "./execution-auth";
import { callExecutionHub } from "./mcp-server";
import { projectActionSchemas } from "./project-summary";
export async function projectSummaryRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/agent/project/")) return null;
  check(
    env.PROJECT_SUMMARY_ENABLED === "true" &&
      env.EXECUTION_ENABLED === "true" &&
      env.RUNNER_ENABLED === "true",
    "项目总结尚未启用。",
    404,
  );
  sameOrigin(request);
  const user = await requireSession(request, env);
  check(
    request.headers.get("X-QD-Account") === user.id,
    "账号已切换，请重新打开。",
    401,
  );
  const action = url.pathname.slice(
    "/api/agent/project/".length,
  ) as keyof typeof projectActionSchemas;
  check(
    Object.hasOwn(projectActionSchemas, action),
    "项目总结接口不存在。",
    404,
  );
  check(
    request.method === (action === "state" ? "GET" : "POST"),
    "方法不支持。",
    405,
  );
  if (action === "state" && url.searchParams.has("inspectOnly"))
    check(
      ["true", "false"].includes(url.searchParams.get("inspectOnly")!),
      "项目总结请求格式无效。",
      400,
    );
  const input =
    action === "state"
      ? {
          bindingId: url.searchParams.get("bindingId") ?? "",
          ...(url.searchParams.has("inspectOnly")
            ? { inspectOnly: url.searchParams.get("inspectOnly") === "true" }
            : {}),
          ...(url.searchParams.has("bindingRevision")
            ? {
                bindingRevision: Number(
                  url.searchParams.get("bindingRevision"),
                ),
              }
            : {}),
        }
      : await body(request, 16000);
  const parsed = projectActionSchemas[action].safeParse(input);
  check(parsed.success, "项目总结请求格式无效。", 400);
  check(parsed.data.bindingId, "请选择已绑定项目。", 400);
  const p = await bindingPrincipal(env, user.id, parsed.data.bindingId);
  return json(await callExecutionHub(env, p, "project-" + action, parsed.data));
}
