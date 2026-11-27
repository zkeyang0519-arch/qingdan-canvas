import type { Env } from "../types";

export function trustedExecutionOrigin(url: URL, env: Env) {
  if (url.protocol === "https:") return true;
  if (!["local", "test"].includes(env.APP_ENV)) return false;
  if (url.origin === "http://127.0.0.1:8788") return true;
  if (!env.RUNTIME_CONTROL_SECRET || !env.LOCAL_RUNTIME_ORIGIN) return false;
  try {
    const configured = new URL(env.LOCAL_RUNTIME_ORIGIN);
    return (
      configured.protocol === "http:" &&
      configured.hostname === "127.0.0.1" &&
      configured.origin === env.LOCAL_RUNTIME_ORIGIN &&
      configured.origin === url.origin
    );
  } catch {
    return false;
  }
}
