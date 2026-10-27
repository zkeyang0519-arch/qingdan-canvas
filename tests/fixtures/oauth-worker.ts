import app from "../../worker/index";
import type { Env } from "../../worker/types";
export { CanvasRoom } from "../../worker/room";
let displayCleanupFailure = false;
let invalidateActivation = false,
  overlap = false,
  arrived = 0;
const sqlByStatement = new WeakMap<object, string>();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/display-cleanup-failure") {
      displayCleanupFailure = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/activation-failure") {
      invalidateActivation = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/overlap") {
      overlap = true;
      arrived = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/disabled")
      return app.fetch(
        new Request("https://app.test/mcp"),
        { ...env, MCP_ENABLED: "false" },
        ctx,
      );
    const headers = new Headers(request.headers);
    headers.set("Host", url.host);
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const prepared = target.prepare(sql);
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement => {
              const proxy = new Proxy(statement, {
                get(s, p) {
                  if (p === "bind")
                    return (...args: unknown[]) => wrap(s.bind(...args));
                  const v = Reflect.get(s, p);
                  return typeof v === "function" ? v.bind(s) : v;
                },
              });
              sqlByStatement.set(proxy, sql);
              return proxy;
            };
            return wrap(prepared);
          };
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const activation = statements.some((s) =>
              sqlByStatement
                .get(s)
                ?.includes("SET state='active',provider_grant_id"),
            );
            if (activation && invalidateActivation) {
              invalidateActivation = false;
              await target
                .prepare(
                  "DELETE FROM account_sessions WHERE account_id='alice'",
                )
                .run();
            }
            const result = await target.batch(statements);
            if (activation && overlap) {
              arrived++;
              while (arrived < 2) await new Promise((r) => setTimeout(r, 5));
            }
            return result;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return app.fetch(
      new Request(request, { headers }),
      {
        ...env,
        DB,
        OAUTH_KV: new Proxy(env.OAUTH_KV!, {
          get(target, prop) {
            if (prop === "delete")
              return async (key: string) => {
                if (
                  displayCleanupFailure &&
                  key.startsWith("qingdan:consent:")
                ) {
                  displayCleanupFailure = false;
                  throw new Error("Injected display cleanup failure");
                }
                return target.delete(key);
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        ASSETS: {
          fetch: async () =>
            new Response("<!doctype html><title>Consent fixture</title>", {
              headers: { "Content-Type": "text/html" },
            }),
        } as Fetcher,
      },
      ctx,
    );
  },
};
