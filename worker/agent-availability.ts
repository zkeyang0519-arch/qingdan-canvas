import type { Env } from "./types";
import { json } from "./http";

// Public deployments remain closed even if an older per-feature flag is enabled.
// APP_ENV is server configuration, never a client-controlled URL or preference.
export function agentDevelopmentEnabled(env: Pick<Env, "APP_ENV">) {
  return env.APP_ENV === "local" || env.APP_ENV === "test";
}

export function sessionFeatures(env: Pick<Env, "APP_ENV">) {
  return { agent: agentDevelopmentEnabled(env) };
}

export function isAgentRoute(path: string) {
  return (
    /^\/api\/(agent|runner)(\/|$)/.test(path) ||
    /^\/executor-mcp(\/|$)/.test(path)
  );
}

export function agentUnavailable() {
  return json(
    {
      error: "Agent 正在开发中，暂时无法使用。",
      code: "AGENT_UNDER_DEVELOPMENT",
    },
    503,
  );
}
