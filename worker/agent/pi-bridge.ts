import type { Env } from "../types";
import { check } from "../http";

export function piEnabled(env: Env, accountId: string | undefined) {
  return (
    ["local", "test"].includes(env.APP_ENV) &&
    !!env.LOCAL_PI_URL &&
    !!env.LOCAL_PI_SECRET &&
    !!accountId &&
    env.LOCAL_PI_OWNER === accountId
  );
}
export function requirePiHost(request: Request, env: Env) {
  check(
    piEnabled(env, env.LOCAL_PI_OWNER) &&
      request.headers.get("authorization") === `Bearer ${env.LOCAL_PI_SECRET}`,
    "本机 Pi 控制身份无效。",
    403,
  );
}
export async function piFetch(
  env: Env,
  action: string,
  payload: unknown,
  signal?: AbortSignal,
) {
  check(piEnabled(env, env.LOCAL_PI_OWNER), "本机 Pi 尚未启用。", 503);
  const url = new URL(env.LOCAL_PI_URL!);
  check(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Pi 入口必须是本机受信任服务。",
    503,
  );
  return fetch(new URL("/" + action, url), {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LOCAL_PI_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
}
export async function piCall(
  env: Env,
  action: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<any> {
  let response: Response;
  try {
    response = await piFetch(env, action, payload, signal);
  } catch {
    throw Object.assign(Error("本机 Pi 连接暂时不可用，请检查主聊天服务。"), {
      status: 503,
    });
  }
  check(
    response.status < 300 || response.status >= 400,
    "Pi 控制接口不能重定向。",
    502,
  );
  const value = (await response.json()) as any;
  check(response.ok, value.error || "Pi 未完成本次请求。", response.status);
  return value;
}
export function piModel(
  configuration: Pick<
    Env,
    "ROUTER_MODEL" | "ROUTER_BASE_URL" | "ROUTER_API_KEY" | "ROUTER_API_FORMAT"
  >,
) {
  return {
    model: configuration.ROUTER_MODEL,
    baseUrl: (configuration.ROUTER_BASE_URL || "https://api.openai.com/v1")
      .replace(/\/+$/, "")
      .replace(/\/(responses|chat\/completions)$/, ""),
    apiKey: configuration.ROUTER_API_KEY,
    apiFormat: configuration.ROUTER_API_FORMAT || "responses",
  };
}
