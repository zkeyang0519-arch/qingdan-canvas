import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const origin = "https://app.test",
  raw = "a".repeat(64),
  sha = (s) => createHash("sha256").update(s).digest("hex");
let mf, db, out;
const req = (p, options = {}) =>
  mf.dispatchFetch(origin + p, { redirect: "manual", ...options });
const cookies = (r) =>
  r.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
async function protocolJson(r) {
  const text = await r.text();
  return JSON.parse(
    text.startsWith("event:")
      ? text
          .split("\n")
          .find((l) => l.startsWith("data: "))
          .slice(6)
      : text,
  );
}
const verifier = "v".repeat(64),
  challenge = createHash("sha256").update(verifier).digest("base64url");
async function register() {
  const r = await req("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Local test",
      redirect_uris: ["http://127.0.0.1:54321/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
async function start(client, extra = {}) {
  const q = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:54321/callback",
    scope: "qingdan:read offline_access",
    resource: origin + "/mcp",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  return req("/oauth/authorize?" + q);
}
async function approve(client, scopes = ["qingdan:read", "offline_access"]) {
  const a = await start(client);
  assert.equal(a.status, 302, await a.clone().text());
  const h = new URL(a.headers.get("location"), origin).searchParams.get(
    "handle",
  );
  const cookie = cookies(a) + "; qd_session=" + raw;
  const g = await req("/api/mcp/consent/" + h, { headers: { Cookie: cookie } });
  assert.equal(g.status, 200, await g.clone().text());
  const display = await g.json();
  const p = await req("/api/mcp/consent/" + h, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      decision: "approve",
      scopes,
      canvas_ids: ["canvas"],
      csrf: display.csrf,
    }),
  });
  return { p, h, cookie, display };
}
const exchange = (client, code, v = verifier) =>
  req("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:54321/callback",
      code,
      code_verifier: v,
      resource: origin + "/mcp",
    }),
  });
const rpc = (
  token,
  method,
  params = {},
  version = "2025-03-26",
  headers = {},
) =>
  req("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      Host: "app.test",
      ...(version === "2026-07-28"
        ? {
            "Mcp-Method": method,
            ...(params.name ? { "Mcp-Name": params.name } : {}),
          }
        : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params:
        version === "2026-07-28"
          ? {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": version,
                "io.modelcontextprotocol/clientInfo": {
                  name: "test",
                  version: "1",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : params,
    }),
  });
test(
  "remote MCP OAuth real worker lifecycle",
  { timeout: 90000 },
  async (t) => {
    out = await mkdtemp(new URL("../.tmp/mcp-oauth-", import.meta.url));
    const scriptPath = path.join(out, "worker.mjs");
    await build({
      entryPoints: ["tests/fixtures/oauth-worker.ts"],
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd"],
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: scriptPath,
      logLevel: "silent",
    });
    const options = convertV4MiniflareOptions({
      name: "oauth-test",
      scriptPath,
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      isolatedResourcePersistencePath: path.join(out, "isolated"),
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
      bindings: { APP_ENV: "test", PUBLIC_ORIGIN: origin, MCP_ENABLED: "true" },
    });
    options.resourcePersistencePath = path.join(out, "state");
    options.unsafeEnableSharedStorage = true;
    options.unsafeDevRegistryPath = path.join(out, "registry");
    mf = new Miniflare(options);
    t.after(async () => {
      await mf.dispose();
      await rm(out, { recursive: true, force: true });
    });
    db = await mf.getD1Database("DB");
    for (const f of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = (await readFile("migrations/" + f, "utf8")).replace(
        /^--.*$/gm,
        "",
      );
      await db.batch(
        sql
          .split(";")
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
      );
    }
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026-01-01'),('bob','bob','Bob','hash','2026-01-01')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?),(?,?,?)")
        .bind(
          sha(raw),
          "alice",
          Date.now() + 86400000,
          sha("b".repeat(64)),
          "bob",
          Date.now() + 86400000,
        ),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026-01-01'),('other','Other','alice','invite2','2026-01-01')",
      ),
      db.prepare(
        "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01'),('other','alice','owner','2026-01-01')",
      ),
    ]);
    await t.test(
      "discovery is canonical and Cookie alone cannot authenticate MCP",
      async () => {
        const r = await req("/.well-known/oauth-authorization-server");
        assert.equal(r.status, 200);
        const m = await r.json();
        assert.equal(m.issuer, origin);
        assert.equal(m.token_endpoint, origin + "/oauth/token");
        assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
        const resource = await (
          await req("/.well-known/oauth-protected-resource/mcp")
        ).json();
        assert.equal(resource.resource, origin + "/mcp");
        assert.equal(
          (await req("/mcp", { headers: { Cookie: "qd_session=" + raw } }))
            .status,
          401,
        );
        assert.equal(
          (
            await mf.dispatchFetch(
              "https://evil.test/.well-known/oauth-authorization-server",
            )
          ).status,
          403,
        );
      },
    );
    const client = await register();
    await t.test(
      "S256 and fixed resource validation happen before consent",
      async () => {
        assert.equal(
          (await start(client, { code_challenge_method: "plain" })).status,
          400,
        );
        assert.equal(
          (await start(client, { resource: "https://evil.test/mcp" })).status,
          400,
        );
      },
    );
    let token;
    await t.test(
      "browser consent produces code only after active durable grant, code verifies PKCE",
      async () => {
        const { p, h, cookie, display } = await approve(client);
        assert.equal(display.client.redirect_host, "127.0.0.1");
        assert.equal(p.status, 200, await p.clone().text());
        const redirect = new URL((await p.json()).redirect_to);
        assert.equal(redirect.searchParams.get("state"), "client-state");
        assert.equal(
          (
            await req("/api/mcp/consent/" + h, {
              method: "POST",
              headers: { Cookie: cookie, "Content-Type": "application/json" },
              body: JSON.stringify({
                decision: "approve",
                csrf: display.csrf,
                scopes: ["qingdan:read"],
                canvas_ids: ["canvas"],
              }),
            })
          ).status,
          403,
        );
        assert.equal(
          (await exchange(client, redirect.searchParams.get("code"), "wrong"))
            .status,
          400,
        );
        const r = await exchange(client, redirect.searchParams.get("code"));
        assert.equal(r.status, 200, await r.clone().text());
        token = await r.json();
        assert.equal(token.expires_in, 900);
        assert.ok(token.refresh_token);
      },
    );
    await t.test(
      "nine native tools list, read-only HTTP challenge and selected canvas intersection",
      async () => {
        const r = await rpc(token.access_token, "tools/list");
        assert.equal(r.status, 200, await r.clone().text());
        const result = await protocolJson(r);
        assert.equal(result.result.tools.length, 9);
        assert.equal(
          result.result.tools.find((t) => t.name === "create_note").annotations
            .readOnlyHint,
          false,
        );
        const list = await protocolJson(
          await rpc(token.access_token, "tools/call", {
            name: "list_canvases",
            arguments: {},
          }),
        );
        assert.deepEqual(
          list.result.structuredContent.items.map((x) => x.canvas_id),
          ["canvas"],
        );
        const browserAllowed = await rpc(
          token.access_token,
          "tools/list",
          {},
          "2025-03-26",
          { Origin: origin },
        );
        assert.equal(browserAllowed.status, 200);
        assert.equal(
          browserAllowed.headers.get("access-control-allow-origin"),
          origin,
        );
        const modernWrite = await rpc(
          token.access_token,
          "tools/call",
          {
            name: "create_note",
            arguments: {
              canvas_id: "canvas",
              request_id: "modern-denied",
              target: { section_id: "ungrouped" },
              blocks: [{ text: "x" }],
            },
          },
          "2026-07-28",
        );
        assert.equal(modernWrite.status, 403);
        assert.match(
          modernWrite.headers.get("www-authenticate"),
          /qingdan:write/,
        );
        const w = await rpc(token.access_token, "tools/call", {
          name: "create_note",
          arguments: {
            canvas_id: "canvas",
            request_id: "x",
            target: { section_id: "ungrouped" },
            blocks: [{ text: "x" }],
          },
        });
        assert.equal(w.status, 403);
        assert.match(w.headers.get("www-authenticate"), /qingdan:write/);
        const denied = await rpc(token.access_token, "tools/call", {
          name: "get_canvas",
          arguments: { canvas_id: "other" },
        });
        const deniedResult = await protocolJson(denied);
        assert.equal(deniedResult.result.isError, true);
        assert.equal(
          deniedResult.result.structuredContent.code,
          "ACCESS_DENIED",
        );
        assert.equal(
          (
            await rpc(token.access_token, "tools/list", {}, "2025-03-26", {
              Origin: "https://evil.test",
            })
          ).status,
          403,
        );
        assert.equal(
          (await rpc(token.access_token, "tools/list", {}, "2026-07-28"))
            .status,
          200,
        );
      },
    );
    await t.test(
      "refresh and browser revoke invalidate both token and refresh",
      async () => {
        const r = await req("/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: client.client_id,
            refresh_token: token.refresh_token,
            resource: origin + "/mcp",
          }),
        });
        assert.equal(r.status, 200, await r.clone().text());
        const management = await (
          await req("/api/profile/mcp-grants", {
            headers: { Cookie: "qd_session=" + raw },
          })
        ).json();
        assert.equal(management.enabled, true);
        assert.equal(management.resource, origin + "/mcp");
        assert.equal(management.items[0].canvases[0].name, "Canvas");
        const revoked = await req(
          "/api/profile/mcp-grants/" + management.items[0].id,
          { method: "DELETE", headers: { Cookie: "qd_session=" + raw } },
        );
        assert.equal(revoked.status, 200);
        assert.equal(
          (await rpc((await r.json()).access_token, "tools/list")).status,
          401,
        );
        assert.equal(
          (
            await req("/oauth/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: client.client_id,
                refresh_token: token.refresh_token,
                resource: origin + "/mcp",
              }),
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "consent CSRF, account and renewed-session binding reject stale submissions; GET retries preserve expiry",
      async () => {
        const a = await start(client),
          h = new URL(a.headers.get("location"), origin).searchParams.get(
            "handle",
          ),
          cookie = cookies(a) + "; qd_session=" + raw;
        const get = () =>
          req("/api/mcp/consent/" + h, { headers: { Cookie: cookie } });
        const first = await (await get()).json();
        assert.equal((await (await get()).json()).expires_at, first.expires_at);
        const post = (c, csrf) =>
          req("/api/mcp/consent/" + h, {
            method: "POST",
            headers: { Cookie: c, "Content-Type": "application/json" },
            body: JSON.stringify({
              decision: "approve",
              scopes: ["qingdan:read"],
              canvas_ids: ["canvas"],
              csrf,
            }),
          });
        assert.equal((await post(cookie, "bad")).status, 403);
        assert.equal(
          (
            await post(
              cookies(a) + "; qd_session=" + "b".repeat(64),
              first.csrf,
            )
          ).status,
          403,
        );
        const renewed = "c".repeat(64);
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(renewed), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (await post(cookies(a) + "; qd_session=" + renewed, first.csrf))
            .status,
          403,
        );
        assert.equal((await post("qd_session=" + raw, first.csrf)).status, 403);
        const deny = await req("/api/mcp/consent/" + h, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: "deny",
            scopes: [],
            canvas_ids: [],
            csrf: first.csrf,
          }),
        });
        assert.equal(deny.status, 200);
        const location = new URL((await deny.json()).redirect_to);
        assert.equal(location.searchParams.get("error"), "access_denied");
        assert.equal(location.searchParams.get("state"), "client-state");
        assert.equal((await get()).status, 403);
      },
    );
    await t.test(
      "final consent SPA document prevents framing and referrer disclosure",
      async () => {
        const r = await req("/mcp/consent?handle=test");
        assert.equal(r.status, 200);
        assert.match(await r.text(), /Consent fixture/);
        assert.equal(r.headers.get("x-frame-options"), "DENY");
        assert.equal(
          r.headers.get("content-security-policy"),
          "frame-ancestors 'none'",
        );
        assert.equal(r.headers.get("referrer-policy"), "no-referrer");
        assert.equal(r.headers.get("cache-control"), "no-store");
      },
    );
    await t.test(
      "explicit write selection can exceed requested read, native modern challenge and private mutations/audit/restore work",
      async () => {
        const { p } = await approve(client, [
          "qingdan:read",
          "qingdan:write",
          "offline_access",
        ]);
        assert.equal(p.status, 200, await p.clone().text());
        const code = new URL((await p.json()).redirect_to).searchParams.get(
          "code",
        );
        const tkn = await (await exchange(client, code)).json();
        const created = await protocolJson(
          await rpc(tkn.access_token, "tools/call", {
            name: "create_note",
            arguments: {
              canvas_id: "canvas",
              request_id: "write-note",
              target: { section_id: "ungrouped" },
              blocks: [{ text: "Restore me" }],
            },
          }),
        );
        assert.equal(
          created.result.isError,
          undefined,
          JSON.stringify(created),
        );
        const note = created.result.structuredContent;
        assert.ok(note.operation_id);
        assert.ok(note.note_id);
        const content = await protocolJson(
          await rpc(tkn.access_token, "tools/call", {
            name: "get_content",
            arguments: { canvas_id: "canvas", note_id: note.note_id },
          }),
        );
        const taskId = content.result.structuredContent.items[0].task_id;
        const deleted = await protocolJson(
          await rpc(tkn.access_token, "tools/call", {
            name: "delete_task",
            arguments: {
              canvas_id: "canvas",
              request_id: "delete-one",
              note_id: note.note_id,
              expected_revision: note.revision,
              task_id: taskId,
            },
          }),
        );
        assert.ok(
          deleted.result.structuredContent?.operation_id,
          JSON.stringify(deleted),
        );
        const op = deleted.result.structuredContent.operation_id;
        const audit = await req("/api/rooms/canvas/mcp-operations", {
          headers: { Cookie: "qd_session=" + raw },
        });
        assert.equal(audit.status, 200, await audit.clone().text());
        assert.ok(
          (await audit.json()).items.find((i) => i.operation_id === op),
        );
        const restore = await req(
          "/api/rooms/canvas/mcp-operations/" + op + "/restore",
          {
            method: "POST",
            headers: {
              Cookie: "qd_session=" + raw,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ request_id: "restore-one" }),
          },
        );
        assert.equal(restore.status, 200, await restore.clone().text());
        const management = await (
          await req("/api/profile/mcp-grants", {
            headers: { Cookie: "qd_session=" + raw },
          })
        ).json();
        assert.ok(
          management.items.find((g) => g.state === "active").last_used_at,
        );
        await db
          .prepare("DELETE FROM members WHERE room_id=? AND user_id=?")
          .bind("canvas", "alice")
          .run();
        const denied = await protocolJson(
          await rpc(tkn.access_token, "tools/call", {
            name: "get_canvas",
            arguments: { canvas_id: "canvas" },
          }),
        );
        assert.equal(denied.result.structuredContent.code, "ACCESS_DENIED");
        await db
          .prepare(
            "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01')",
          )
          .run();
        const active = management.items.find((g) => g.state === "active");
        await db
          .prepare("UPDATE mcp_grants SET expires_at=? WHERE id=?")
          .bind(Date.now() - 1, active.id)
          .run();
        assert.equal((await rpc(tkn.access_token, "tools/list")).status, 401);
        const refreshed = await req("/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: client.client_id,
            refresh_token: tkn.refresh_token,
            resource: origin + "/mcp",
          }),
        });
        assert.equal(refreshed.status, 400);
      },
    );
    await t.test(
      "management pages are bounded, account-bound and current-membership safe",
      async () => {
        const first = await (
          await req("/api/profile/mcp-grants?limit=1", {
            headers: { Cookie: "qd_session=" + raw },
          })
        ).json();
        assert.equal(first.items.length, 1);
        assert.ok(first.next_cursor);
        const second = await (
          await req(
            "/api/profile/mcp-grants?limit=1&cursor=" +
              encodeURIComponent(first.next_cursor),
            { headers: { Cookie: "qd_session=" + raw } },
          )
        ).json();
        assert.equal(second.items.length, 1);
        assert.notEqual(first.items[0].id, second.items[0].id);
        assert.equal(
          (
            await req("/api/profile/mcp-grants?limit=1000", {
              headers: { Cookie: "qd_session=" + raw },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await req(
              "/api/profile/mcp-grants?cursor=" +
                encodeURIComponent(first.next_cursor),
              { headers: { Cookie: "qd_session=" + "b".repeat(64) } },
            )
          ).status,
          400,
        );
        await db
          .prepare(
            "DELETE FROM members WHERE room_id='canvas' AND user_id='alice'",
          )
          .run();
        const gone = await (
          await req("/api/profile/mcp-grants", {
            headers: { Cookie: "qd_session=" + raw },
          })
        ).json();
        assert.ok(
          gone.items.every((g) =>
            g.canvases.every((c) => c.canvas_id !== "canvas"),
          ),
        );
        await db
          .prepare(
            "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01')",
          )
          .run();
      },
    );

    await t.test(
      "activation failure leaves pending unusable and revokes orphan provider association",
      async () => {
        const before = await (
          await mf.getKVNamespace("OAUTH_KV")
        ).list({ prefix: "grant:alice:" });
        await req("/fixture/activation-failure");
        const failed = await approve(client);
        assert.equal(failed.p.status, 403, await failed.p.clone().text());
        assert.equal(
          (
            await db
              .prepare("SELECT state FROM mcp_grants WHERE consent_handle=?")
              .bind(failed.h)
              .first()
          ).state,
          "pending",
        );
        const after = await (
          await mf.getKVNamespace("OAUTH_KV")
        ).list({ prefix: "grant:alice:" });
        assert.deepEqual(
          after.keys.map((k) => k.name),
          before.keys.map((k) => k.name),
        );
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
      },
    );
    await t.test(
      "overlapping same-client authorizations retain one active grant",
      async () => {
        await req("/fixture/overlap");
        const pair = await Promise.all([approve(client), approve(client)]);
        for (const item of pair)
          assert.equal(item.p.status, 200, await item.p.clone().text());
        const codes = await Promise.all(
          pair.map(async (i) =>
            new URL((await i.p.json()).redirect_to).searchParams.get("code"),
          ),
        );
        const exchanges = await Promise.all(
          codes.map((c) => exchange(client, c)),
        );
        assert.equal(exchanges.filter((r) => r.status === 200).length, 1);
        const active = await db
          .prepare(
            "SELECT COUNT(*) AS n FROM mcp_grants WHERE account_id='alice' AND client_id=? AND state='active'",
          )
          .bind(client.client_id)
          .first();
        assert.equal(active.n, 1);
      },
    );
    await t.test(
      "disabled mode has explicit 404 and DCR rate limit is durable",
      async () => {
        const disabled = await req("/fixture/disabled");
        assert.equal(disabled.status, 404);
        assert.match((await disabled.json()).error, /not configured|disabled/i);
        let limited;
        for (let n = 0; n < 21; n++) {
          limited = await req("/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "Rate test",
              redirect_uris: ["http://127.0.0.1:54321/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code"],
              response_types: ["code"],
            }),
          });
          if (limited.status === 429) break;
        }
        assert.equal(limited.status, 429);
      },
    );
    await t.test(
      "post-activation display cleanup cannot invalidate durable success",
      async () => {
        await req("/fixture/display-cleanup-failure");
        const { p } = await approve(client);
        assert.equal(p.status, 200, await p.clone().text());
        const code = new URL((await p.json()).redirect_to).searchParams.get(
          "code",
        );
        const exchanged = await exchange(client, code);
        assert.equal(exchanged.status, 200, await exchanged.clone().text());
      },
    );

    await t.test(
      "transient D1 failures preserve code and refresh provider grants for retry",
      async () => {
        const approval = await approve(client);
        assert.equal(approval.p.status, 200);
        const code = new URL(
          (await approval.p.json()).redirect_to,
        ).searchParams.get("code");
        const kv = await mf.getKVNamespace("OAUTH_KV");
        const before = (await kv.list({ prefix: "grant:alice:" })).keys.map(
          (k) => k.name,
        );
        await req("/fixture/token-query-failure?query=grant");
        const failedCode = await exchange(client, code);
        assert.equal(failedCode.status, 503, await failedCode.clone().text());
        assert.equal(
          (await failedCode.json()).error,
          "temporarily_unavailable",
        );
        assert.equal(failedCode.headers.get("retry-after"), "5");
        assert.deepEqual(
          (await kv.list({ prefix: "grant:alice:" })).keys.map((k) => k.name),
          before,
        );
        const success = await exchange(client, code);
        assert.equal(success.status, 200, await success.clone().text());
        const tokens = await success.json();
        const refresh = () =>
          req("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: client.client_id,
              refresh_token: tokens.refresh_token,
              resource: origin + "/mcp",
            }),
          });
        await req("/fixture/token-query-failure?query=association");
        const failedRefresh = await refresh();
        assert.equal(
          failedRefresh.status,
          503,
          await failedRefresh.clone().text(),
        );
        assert.equal(
          (await failedRefresh.json()).error,
          "temporarily_unavailable",
        );
        assert.deepEqual(
          (await kv.list({ prefix: "grant:alice:" })).keys.map((k) => k.name),
          before,
        );
        assert.equal(
          (await rpc(tokens.access_token, "tools/list")).status,
          200,
        );
        assert.equal((await refresh()).status, 200);
      },
    );
    await t.test(
      "approval validation returns400 without consuming a valid form; denial accepts empty arrays",
      async () => {
        const a = await start(client),
          handle = new URL(a.headers.get("location"), origin).searchParams.get(
            "handle",
          ),
          cookie = cookies(a) + "; qd_session=" + raw;
        const display = await (
          await req("/api/mcp/consent/" + handle, {
            headers: { Cookie: cookie },
          })
        ).json();
        const post = (input) =>
          req("/api/mcp/consent/" + handle, {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
              decision: "approve",
              scopes: ["qingdan:read"],
              canvas_ids: ["canvas"],
              csrf: display.csrf,
              ...input,
            }),
          });
        const invalid = [
          { scopes: [] },
          { scopes: ["qingdan:write"] },
          { scopes: ["qingdan:read", "qingdan:read"] },
          { canvas_ids: [] },
          { canvas_ids: ["canvas", "canvas"] },
        ];
        for (const input of invalid) {
          const r = await post(input);
          assert.equal(
            r.status,
            400,
            JSON.stringify(input) + ": " + (await r.clone().text()),
          );
          assert.equal(
            (
              await db
                .prepare(
                  "SELECT state FROM mcp_consent_selections WHERE handle=?",
                )
                .bind(handle)
                .first()
            ).state,
            "open",
          );
        }
        const oversized = await post({ csrf: "x".repeat(2 * 1048576) });
        assert.equal(oversized.status, 413);
        const deny = await post({
          decision: "deny",
          scopes: [],
          canvas_ids: [],
        });
        assert.equal(deny.status, 200, await deny.clone().text());
        assert.equal(
          new URL((await deny.json()).redirect_to).searchParams.get("error"),
          "access_denied",
        );
        const normal = await req("/api/rooms", {
          method: "POST",
          headers: {
            Cookie: "qd_session=" + raw,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "x".repeat(17000) }),
        });
        assert.equal(normal.status, 413);
      },
    );
    await t.test(
      "all2000 selected valid-length room IDs can be submitted within a bounded consent payload",
      async () => {
        const ids = Array.from(
          { length: 1998 },
          (_, n) => "selected-" + String(n).padStart(91, "0"),
        );
        assert.ok(ids.every((id) => id.length === 100));
        try {
          for (let i = 0; i < ids.length; i += 50)
            await db.batch(
              ids
                .slice(i, i + 50)
                .flatMap((id) => [
                  db
                    .prepare(
                      "INSERT INTO rooms VALUES(?,?,'alice','invite','2026-01-01')",
                    )
                    .bind(id, "Selected"),
                  db
                    .prepare(
                      "INSERT INTO members VALUES(?,'alice','owner','2026-01-01')",
                    )
                    .bind(id),
                ]),
            );
          const a = await start(client),
            handle = new URL(
              a.headers.get("location"),
              origin,
            ).searchParams.get("handle"),
            cookie = cookies(a) + "; qd_session=" + raw;
          const displayResponse = await req("/api/mcp/consent/" + handle, {
            headers: { Cookie: cookie },
          });
          assert.equal(
            displayResponse.status,
            200,
            await displayResponse.clone().text(),
          );
          const display = await displayResponse.json();
          assert.equal(display.canvases.length, 2000);
          const payload = JSON.stringify({
            decision: "approve",
            scopes: ["qingdan:read", "qingdan:write", "offline_access"],
            canvas_ids: ["canvas", "other", ...ids],
            csrf: display.csrf,
          });
          assert.ok(Buffer.byteLength(payload) > 200000);
          const response = await req("/api/mcp/consent/" + handle, {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: payload,
          });
          assert.equal(response.status, 200, await response.clone().text());
          const code = new URL(
            (await response.json()).redirect_to,
          ).searchParams.get("code");
          assert.equal((await exchange(client, code)).status, 200);
          const row = await db
            .prepare(
              "SELECT g.state,COUNT(gr.room_id) AS n FROM mcp_grants g JOIN mcp_grant_rooms gr ON gr.grant_id=g.id WHERE g.consent_handle=? GROUP BY g.id",
            )
            .bind(handle)
            .first();
          assert.equal(row.state, "active");
          assert.equal(row.n, 2000);
        } finally {
          for (let i = 0; i < ids.length; i += 50)
            await db.batch(
              ids
                .slice(i, i + 50)
                .flatMap((id) => [
                  db
                    .prepare("DELETE FROM mcp_grant_rooms WHERE room_id=?")
                    .bind(id),
                  db.prepare("DELETE FROM members WHERE room_id=?").bind(id),
                  db.prepare("DELETE FROM rooms WHERE id=?").bind(id),
                ]),
            );
        }
      },
    );
    await t.test(
      "ordinary logout preserves grant, password change revokes provider and read-only consent omits refresh",
      async () => {
        const { hashPassword } = await import("../worker/passwords.js");
        await db
          .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
          .bind(await hashPassword("Original-password-123"), "alice")
          .run();
        const read = await approve(client, ["qingdan:read"]);
        assert.equal(read.p.status, 200);
        const readCode = new URL(
          (await read.p.json()).redirect_to,
        ).searchParams.get("code");
        const readToken = await (await exchange(client, readCode)).json();
        assert.equal(readToken.refresh_token, undefined);
        assert.equal(
          (
            await req("/api/auth/logout", {
              method: "POST",
              headers: { Cookie: "qd_session=" + raw },
            })
          ).status,
          200,
        );
        assert.equal(
          (await rpc(readToken.access_token, "tools/list")).status,
          200,
        );
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
        const changed = await req("/api/auth/password", {
          method: "POST",
          headers: {
            Cookie: "qd_session=" + raw,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            currentPassword: "Original-password-123",
            password: "Changed-password-456",
          }),
        });
        assert.equal(changed.status, 200, await changed.clone().text());
        assert.equal(
          (await rpc(readToken.access_token, "tools/list")).status,
          401,
        );
        assert.equal(
          (
            await (
              await mf.getKVNamespace("OAUTH_KV")
            ).list({ prefix: "grant:alice:" })
          ).keys.length,
          0,
        );
      },
    );
  },
);
