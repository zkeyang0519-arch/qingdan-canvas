import app from "../../worker/index";
import { oauthApi } from "../../worker/mcp/auth";
import { captureDiagnostics } from "./diagnostics";
const diagnostics = captureDiagnostics([
  /^OAuth error response: /,
  /^Request failed Injected display cleanup failure$/,
  /^responseMode: 'json' drops mid-call notifications\./,
  /^CIMD fetch failed for https:\/\/cimd\.example\.test\/(mismatch|oversized)\.json: /,
]);
import type { Env } from "../../worker/types";
export { CanvasRoom } from "../../worker/room";
let displayCleanupFailure = false;
let failedTokenQuery: string | null = null;
let invalidateActivation = false,
  overlap = false,
  arrived = 0;
const sqlByStatement = new WeakMap<object, string>();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/diagnostics")
      return Response.json(diagnostics());
    if (url.pathname === "/fixture/oversized-consent") {
      // Construct the real oversized request in workerd. Sending it through
      // Miniflare's Node HTTP proxy races early 413/cancel against undici upload
      // and can reset the socket before Node receives the application response.
      const bytes = new TextEncoder().encode(
        JSON.stringify({ csrf: "x".repeat(2 * 1048576) }),
      );
      const headers = new Headers({
        Cookie: request.headers.get("Cookie") || "",
        Origin: "https://app.test",
        "Content-Type": "application/json",
      });
      const known = url.searchParams.get("mode") === "known";
      if (known) headers.set("Content-Length", String(bytes.byteLength));
      let delivered = 0,
        cancelled = false;
      const body = known
        ? bytes
        : new ReadableStream({
            pull(controller) {
              if (delivered === bytes.byteLength) {
                controller.close();
                return;
              }
              const end = Math.min(delivered + 65536, bytes.byteLength);
              controller.enqueue(bytes.slice(delivered, end));
              delivered = end;
            },
            cancel() {
              cancelled = true;
            },
          });
      const response = await app.fetch(
        new Request(
          "https://app.test/api/mcp/consent/" + url.searchParams.get("handle"),
          { method: "POST", headers, body },
        ),
        env,
        ctx,
      );
      response.headers.set("X-Fixture-Body-Bytes", String(bytes.byteLength));
      response.headers.set(
        "X-Fixture-Declared-Length",
        headers.get("Content-Length") || "absent",
      );
      response.headers.set("X-Fixture-Stream-Cancelled", String(cancelled));
      response.headers.set("X-Fixture-Delivered-Bytes", String(delivered));
      return response;
    }
    if (url.pathname === "/fixture/client") {
      try {
        return Response.json(
          await oauthApi(env).lookupClient(url.searchParams.get("id")!),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if (url.pathname === "/fixture/token-query-failure") {
      failedTokenQuery = url.searchParams.get("query");
      return Response.json({ ok: true });
    }
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
                  if (p === "first")
                    return (...args: unknown[]) => {
                      const grantQuery = sql.includes(
                        "SELECT g.*,a.name AS account_name",
                      );
                      const associationQuery = sql.includes(
                        "SELECT provider_grant_id,expires_at",
                      );
                      if (
                        (failedTokenQuery === "grant" && grantQuery) ||
                        (failedTokenQuery === "association" && associationQuery)
                      ) {
                        failedTokenQuery = null;
                        throw new Error("Injected transient D1 query failure");
                      }
                      return (s.first as (...args: unknown[]) => unknown)(
                        ...args,
                      );
                    };
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
