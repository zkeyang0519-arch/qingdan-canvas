import type { Env } from "../types";
import { body, check, json, sameOrigin } from "../http";
import { requireSession } from "../auth";
import { piCall, piEnabled, piFetch, requirePiHost } from "./pi-bridge";
import {
  isMcpOAuthNavigation,
  mcpCallbackPage,
} from "../../shared/agent/oauth-callback.mjs";

export async function piRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url),
    pathname = url.pathname;
  if (pathname === "/api/internal/pi/retention") {
    requirePiHost(request, env);
    check(request.method === "POST", "方法不支持。", 405);
    const value = await body(request, 200000);
    const result = await env.AGENT_CHATS.get(
      env.AGENT_CHATS.idFromName(env.LOCAL_PI_OWNER!),
    ).piRetentionResult(value);
    return json(result, "status" in result ? result.status : 200);
  }
  if (pathname === "/api/internal/pi/context") {
    requirePiHost(request, env);
    check(request.method === "POST", "方法不支持。", 405);
    const input = await body(request, 4096);
    check(typeof input.jobId === "string", "缺少原任务编号。", 400);
    const data = await env.AGENT_CHATS.get(
      env.AGENT_CHATS.idFromName(env.LOCAL_PI_OWNER!),
    ).piContextResult(input.jobId);
    return "error" in data
      ? json({ error: data.error }, data.status)
      : json(data.context);
  }
  const media = pathname.match(
    /^\/api\/agent\/chat\/(media|video)\/([a-zA-Z0-9_-]+)$/,
  );
  const callback = pathname.match(/^\/local\/mcp\/callback\/([a-zA-Z0-9_-]+)$/);
  const task = pathname.match(/^\/local\/waao\/tasks\/([a-zA-Z0-9_-]+)$/);
  const simple = new Map([
    ["/local/mcp", "mcp"],
    ["/local/connector-questions", "questions"],
    ["/local/task/stop", "task-stop"],
    ["/local/task/reply", "task-reply"],
    ["/local/waao/callback", "waao-callback"],
    ["/local/waao/capabilities", "waao-capabilities"],
  ]);
  if (!media && !callback && !task && !simple.has(pathname)) return null;
  check(["local", "test"].includes(env.APP_ENV), "本机 Pi 入口不可用。", 404);
  const oauthReturn = !!callback || pathname === "/local/waao/callback";
  if (oauthReturn) {
    check(request.method === "GET", "授权回调只接受页面跳转。", 405);
    check(
      isMcpOAuthNavigation(request),
      "授权回调参数或导航方式无效，请从轻单重新连接。",
      403,
    );
  } else sameOrigin(request);
  const user = await requireSession(request, env);
  check(
    !request.headers.get("X-QD-Account") ||
      request.headers.get("X-QD-Account") === user.id,
    "登录账号已变化。",
    401,
  );
  check(piEnabled(env, user.id), "当前账号未连接本机 Pi。", 503);
  check(["GET", "POST"].includes(request.method), "方法不支持。", 405);
  const input = request.method === "POST" ? await body(request, 200000) : {};
  const bindingId = url.searchParams.get("bindingId") || input.bindingId;
  const chatId = url.searchParams.get("chat") || input.chatId;
  const action = media
    ? media[1] === "media"
      ? "image"
      : "video"
    : callback
      ? "mcp-callback"
      : task
        ? "waao-task"
        : simple.get(pathname)!;
  if (["mcp", "questions", "task-stop", "task-reply"].includes(action))
    check(typeof bindingId === "string", "请先选择项目。", 400);
  if (["task-stop", "task-reply"].includes(action)) {
    check(request.method === "POST", "方法不支持。", 405);
    check(typeof chatId === "string", "请先选择对话。", 400);
  }
  const resolved = await env.AGENT_CHATS.get(
    env.AGENT_CHATS.idFromName(user.id),
  ).piScopeResult(
    { accountId: user.id, sessionHash: user.token_hash },
    typeof bindingId === "string" ? bindingId : undefined,
    typeof chatId === "string" ? chatId : undefined,
  );
  if ("error" in resolved)
    return json({ error: resolved.error }, resolved.status);
  const scope = resolved.scope;
  const payload = {
    accountId: user.id,
    scope,
    input,
    method: request.method,
    query: Object.fromEntries(url.searchParams),
    id: media?.[2] || callback?.[1] || task?.[1],
  };
  if (media) {
    const response = await piFetch(env, action, payload, request.signal);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (response.headers.has("content-type"))
      headers.set("Content-Type", response.headers.get("content-type")!);
    if (response.headers.has("location"))
      headers.set("Location", response.headers.get("location")!);
    return new Response(response.body, { status: response.status, headers });
  }
  const result = await piCall(env, action, payload, request.signal);
  return action.endsWith("callback")
    ? mcpCallbackPage(
        result.returnTo,
        result.status === "ready",
        action === "waao-callback" || payload.id === "builtin-waao",
      )
    : json(result);
}
