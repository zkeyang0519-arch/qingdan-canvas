import type { Env } from "./types";
import { body, check, json } from "./http";

export async function runtimeAdmissionsPaused(env: Env) {
  if (!env.RUNTIME_CONTROL_SECRET || !["local", "test"].includes(env.APP_ENV))
    return false;
  return !!(
    await env.DB.prepare(
      "SELECT paused FROM runtime_maintenance WHERE id=1",
    ).first<{ paused: number }>()
  )?.paused;
}
export async function runtimeMaintenanceRoute(request: Request, env: Env) {
  if (new URL(request.url).pathname !== "/api/internal/runtime") return null;
  check(
    ["local", "test"].includes(env.APP_ENV) && !!env.RUNTIME_CONTROL_SECRET,
    "本机维护接口不可用。",
    404,
  );
  check(
    request.method === "POST" &&
      request.headers.get("Authorization") ===
        "Bearer " + env.RUNTIME_CONTROL_SECRET,
    "本机维护身份无效。",
    403,
  );
  const input = await body(request, 1024);
  check(
    ["pause", "resume", "activity", "checkpoint"].includes(
      input.action as string,
    ),
    "维护操作无效。",
    400,
  );
  if (input.action === "pause" || input.action === "resume")
    await env.DB.prepare(
      "INSERT INTO runtime_maintenance(id,paused) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused",
    )
      .bind(input.action === "pause" ? 1 : 0)
      .run();
  const { results } = await env.DB.prepare("SELECT id FROM accounts").all<{
    id: string;
  }>();
  const tasks: { id: string; label: string; status: string }[] = [];
  const unknown: string[] = [];
  for (const account of results) {
    const value = await env.AGENT_CHATS.get(
      env.AGENT_CHATS.idFromName(account.id),
    ).runtimeActivityResult(env.RUNTIME_CONTROL_SECRET!);
    tasks.push(...value.tasks);
    unknown.push(...value.unknown);
  }
  const leases = await env.DB.prepare(
    "SELECT run_id FROM agent_workspace_leases WHERE expires_at>?",
  )
    .bind(Date.now())
    .all<{ run_id: string }>();
  tasks.push(
    ...leases.results.map((lease) => ({
      id: lease.run_id,
      label: "本地执行任务",
      status: "running",
    })),
  );
  if (input.action === "checkpoint")
    check(
      !tasks.length && !unknown.length,
      "后台仍有运行中或待核对的任务。",
      409,
    );
  return json({
    tasks,
    unknown,
    paused: input.action !== "resume" && (await runtimeAdmissionsPaused(env)),
    ok: input.action === "checkpoint",
    resumed: input.action === "resume",
  });
}
