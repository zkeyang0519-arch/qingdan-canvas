import type { Env } from "../types";
import { body, check, json } from "../http";
import { requireSession } from "../auth";
import { sameOrigin } from "../http";
import { bindingPrincipal } from "../execution/execution-auth";

export async function chatRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/agent/chat/")) return null;
  check(env.CHAT_ENABLED === "true", "聊天与记忆功能尚未启用。", 404);
  sameOrigin(request);
  const user = await requireSession(request, env);
  check(
    request.headers.get("X-QD-Account") === user.id,
    "账号已切换，请重新打开。",
    401,
  );
  const action = url.pathname.slice("/api/agent/chat/".length);
  check(
    [
      "state",
      "request",
      "new",
      "send",
      "memory",
      "remember",
      "save-tasks",
    ].includes(action),
    "聊天接口不存在。",
    404,
  );
  const readOnly = action === "state" || action === "request";
  check(
    (readOnly && request.method === "GET") ||
      (!readOnly && request.method === "POST"),
    "方法不支持。",
    405,
  );
  const input: Record<string, unknown> = readOnly
    ? {
        ...(url.searchParams.get("requestId")
          ? { requestId: url.searchParams.get("requestId") }
          : {}),
        ...(url.searchParams.get("bindingId")
          ? { bindingId: url.searchParams.get("bindingId") }
          : {}),
        ...(url.searchParams.get("chatId")
          ? { chatId: url.searchParams.get("chatId") }
          : {}),
        ...(url.searchParams.get("bindingRevision")
          ? {
              bindingRevision: Number(url.searchParams.get("bindingRevision")),
            }
          : {}),
        ...(url.searchParams.get("beforeSequence")
          ? { beforeSequence: Number(url.searchParams.get("beforeSequence")) }
          : {}),
      }
    : await body(request, 200000);
  const principal =
    typeof input.bindingId === "string"
      ? await bindingPrincipal(env, user.id, input.bindingId)
      : undefined;
  check(
    !input.bindingId ||
      (action === "state" && input.bindingRevision === undefined) ||
      input.bindingRevision === principal?.bindingRevision,
    "项目绑定已变化，请刷新后重试。",
    409,
  );
  const response = await env.AGENT_CHATS.get(
    env.AGENT_CHATS.idFromName(user.id),
  ).fetch("https://agent.internal/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      input,
      identity: { accountId: user.id, sessionHash: user.token_hash },
      principal,
    }),
  });
  const result = await response.json();
  return json(result, response.status);
}
