import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const origin = "https://app.test",
  raw = "a".repeat(64),
  sha = (s) => createHash("sha256").update(s).digest("hex");
let mf, db, out;
const metadataRequests = [];
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
async function approve(
  client,
  scopes = ["qingdan:read", "offline_access"],
  who = raw,
  canvasIds = ["canvas"],
) {
  const a = await start(client);
  assert.equal(a.status, 302, await a.clone().text());
  const h = new URL(a.headers.get("location"), origin).searchParams.get(
    "handle",
  );
  const cookie = cookies(a) + "; qd_session=" + who;
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
      canvas_ids: canvasIds,
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
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(
          url.origin,
          "https://cimd.example.test",
          "fixture must never reach a real external provider",
        );
        metadataRequests.push(url.pathname);
        assert.equal(request.headers.get("accept"), "application/json");
        const doc = {
          client_id: request.url,
          client_name: "Synthetic CIMD",
          redirect_uris: ["http://127.0.0.1:54321/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        if (url.pathname === "/mismatch.json")
          doc.client_id = "https://cimd.example.test/different.json";
        if (url.pathname === "/oversized.json")
          doc.client_name = "x".repeat(6000);
        return Response.json(doc, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      },
      durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
      bindings: {
        APP_ENV: "test",
        PUBLIC_ORIGIN: origin,
        MCP_ENABLED: "true",
        EMAIL_CODE_SECRET: "test-only-email-signing-secret-over-32-characters",
        RESEND_API_KEY: "synthetic-no-mail",
        EMAIL_FROM: "test@example.test",
      },
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
        "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01'),('other','alice','owner','2026-01-01'),('other','bob','editor','2026-01-01')",
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
    await t.test(
      "official CIMD fetch validates metadata, bounds response size and reuses its local cache",
      async () => {
        const lookup = (id) =>
          req("/fixture/client?id=" + encodeURIComponent(id));
        const id = "https://cimd.example.test/client.json";
        const first = await lookup(id);
        assert.equal(first.status, 200, await first.clone().text());
        assert.equal((await first.json()).clientName, "Synthetic CIMD");
        const before = metadataRequests.length;
        assert.equal((await lookup(id)).status, 200);
        assert.equal(
          metadataRequests.length,
          before,
          "provider cache should avoid the second outbound metadata fetch",
        );
        for (const path of ["mismatch", "oversized"])
          assert.equal(
            (await lookup("https://cimd.example.test/" + path + ".json"))
              .status,
            502,
          );
        const noFetch = metadataRequests.length;
        assert.equal(
          await (await lookup("http://cimd.example.test/client.json")).json(),
          null,
        );
        assert.equal(
          await (await lookup("https://cimd.example.test")).json(),
          null,
        );
        assert.equal(metadataRequests.length, noFetch);
        assert.deepEqual(metadataRequests, [
          "/client.json",
          "/mismatch.json",
          "/oversized.json",
        ]);
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
        for (const mode of ["known", "stream"]) {
          const oversized = await req(
            `/fixture/oversized-consent?handle=${handle}&mode=${mode}`,
            { headers: { Cookie: cookie } },
          );
          assert.equal(oversized.status, 413, mode);
          assert.ok(
            Number(oversized.headers.get("X-Fixture-Body-Bytes")) > 2 * 1048576,
          );
          if (mode === "known")
            assert.equal(
              oversized.headers.get("X-Fixture-Declared-Length"),
              oversized.headers.get("X-Fixture-Body-Bytes"),
            );
          else {
            assert.equal(
              oversized.headers.get("X-Fixture-Declared-Length"),
              "absent",
            );
            assert.equal(
              oversized.headers.get("X-Fixture-Stream-Cancelled"),
              "true",
            );
            assert.ok(
              Number(oversized.headers.get("X-Fixture-Delivered-Bytes")) <
                2 * 1048576,
            );
          }
          assert.match((await oversized.json()).error, /超过大小限制/);
        }
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
      "OAuth to all nine tools, WebSocket observation, concurrent note revisions, replay and recovery after revoke",
      async () => {
        const full = ["qingdan:read", "qingdan:write", "offline_access"];
        const approval = await approve(client, full);
        assert.equal(approval.p.status, 200);
        const access = await (
          await exchange(
            client,
            new URL((await approval.p.json()).redirect_to).searchParams.get(
              "code",
            ),
          )
        ).json();
        const initialized = await protocolJson(
          await rpc(access.access_token, "initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "acceptance-fixture", version: "1" },
          }),
        );
        assert.equal(initialized.result.protocolVersion, "2025-03-26");
        const invoked = new Set();
        const call = async (name, args = {}, version = "2026-07-28") => {
          const response = await rpc(
            access.access_token,
            "tools/call",
            { name, arguments: args },
            version,
          );
          assert.equal(response.status, 200, await response.clone().text());
          const value = (await protocolJson(response)).result;
          invoked.add(name);
          return value;
        };
        assert.deepEqual(
          (await call("list_canvases")).structuredContent.items.map(
            (x) => x.canvas_id,
          ),
          ["canvas"],
        );
        const canvas = (await call("get_canvas", { canvas_id: "canvas" }))
          .structuredContent;
        assert.equal(canvas.canvas_id, "canvas");
        // Authenticated real browser socket observes the same DO as the remote tools.
        const upgraded = await req("/api/rooms/canvas/socket?authors=1", {
          headers: { Cookie: "qd_session=" + raw, Upgrade: "websocket" },
        });
        assert.equal(upgraded.status, 101);
        const socket = upgraded.webSocket,
          messages = [];
        socket.addEventListener("message", (event) =>
          messages.push(JSON.parse(event.data)),
        );
        socket.accept();
        const take = async (predicate) => {
          for (let i = 0; i < 200; i++) {
            const at = messages.findIndex(predicate);
            if (at >= 0) return messages.splice(at, 1)[0];
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail("expected WebSocket event was not observed");
        };
        try {
          await take((m) => m.type === "snapshot");
          const base = {
            canvas_id: "canvas",
            target: { section_id: "ungrouped" },
            blocks: [{ text: "acceptance anchor" }],
            request_id: "accept-note",
          };
          const note = (await call("create_note", base)).structuredContent;
          assert.ok(note.note_id);
          const observed = await take(
            (m) =>
              m.type === "changes" && m.rows.some((r) => r.id === note.note_id),
          );
          assert.equal(
            observed.rows.find((r) => r.id === note.note_id).revision,
            note.revision,
          );
          const append = {
            canvas_id: "canvas",
            request_id: "accept-tasks",
            target: { note_id: note.note_id },
            expected_revision: note.revision,
            items: [
              {
                runs: [
                  { type: "text", text: "acceptance " },
                  { type: "ref", target_id: note.note_id, label: "anchor" },
                ],
                remark: "preserved remark",
                due_start_at: "2026-11-01T08:00:00+08:00",
                due_at: "2026-11-02T08:00:00+08:00",
              },
            ],
          };
          const tasks = (await call("create_tasks", append)).structuredContent;
          assert.deepEqual(
            (await call("create_tasks", append)).structuredContent,
            tasks,
          );
          assert.equal(
            (
              await call("create_tasks", {
                ...append,
                items: [{ text: "different" }],
              })
            ).structuredContent.code,
            "IDEMPOTENCY_KEY_REUSED",
          );
          const detail = (
            await call("get_content", {
              canvas_id: "canvas",
              note_id: note.note_id,
            })
          ).structuredContent;
          const task = detail.items.find(
            (i) => i.task_id === tasks.task_ids[0],
          );
          assert.equal(task.created_by, "alice");
          assert.equal(task.due_start_at, "2026-11-01T00:00:00.000Z");
          assert.equal(task.due_at, "2026-11-02T00:00:00.000Z");
          assert.equal(task.remark.text, "preserved remark");
          assert.ok(
            task.runs.some(
              (r) => r.type === "ref" && r.target_id === note.note_id,
            ),
          );
          const page = (
            await call("search_content", {
              canvas_id: "canvas",
              query: "acceptance",
              limit: 1,
            })
          ).structuredContent;
          assert.equal(page.items.length, 1);
          assert.ok(page.next_cursor);
          // Both clients read the same note revision, then alter different blocks.
          const [one, two] = await Promise.all([
            call("update_task", {
              canvas_id: "canvas",
              note_id: note.note_id,
              task_id: tasks.task_ids[0],
              expected_revision: tasks.revision,
              request_id: "accept-concurrent-a",
              patch: { done: true },
            }),
            call("update_note", {
              canvas_id: "canvas",
              note_id: note.note_id,
              expected_revision: tasks.revision,
              request_id: "accept-concurrent-b",
              edits: [
                {
                  task_id: note.task_ids[0],
                  patch: { text: "acceptance changed" },
                },
              ],
            }),
          ]);
          assert.equal([one, two].filter((v) => v.isError).length, 1);
          assert.equal(
            [one, two].find((v) => v.isError).structuredContent.code,
            "REVISION_CONFLICT",
          );
          assert.equal(
            (
              await call("search_content", {
                canvas_id: "canvas",
                query: "acceptance",
                limit: 1,
                cursor: page.next_cursor,
              })
            ).structuredContent.code,
            "STALE_CURSOR",
          );
          const latest = (
            await call("get_content", {
              canvas_id: "canvas",
              note_id: note.note_id,
            })
          ).structuredContent;
          const taskUpdate = await call("update_task", {
            canvas_id: "canvas",
            note_id: note.note_id,
            task_id: tasks.task_ids[0],
            expected_revision: latest.items[0].revision,
            request_id: "accept-final-task",
            patch: { done: true },
          });
          assert.equal(taskUpdate.isError, undefined);
          const noteUpdate = await call("update_note", {
            canvas_id: "canvas",
            note_id: note.note_id,
            expected_revision: taskUpdate.structuredContent.revision,
            request_id: "accept-final-note",
            color: "sage",
          });
          assert.equal(noteUpdate.isError, undefined);
          const removed = (
            await call("delete_task", {
              canvas_id: "canvas",
              note_id: note.note_id,
              task_id: tasks.task_ids[0],
              expected_revision: noteUpdate.structuredContent.revision,
              request_id: "accept-delete",
            })
          ).structuredContent;
          assert.ok(removed.operation_id);
          const commit = async (opId, changes) => {
            socket.send(JSON.stringify({ type: "commit", opId, changes }));
            const response = await take((m) => m.opId === opId);
            assert.equal(response.type, "ack", JSON.stringify(response));
            return response.rows;
          };
          const now = new Date().toISOString();
          let parent = {
            id: "accept-parent",
            type: "frame",
            boardId: "canvas",
            parentId: null,
            x: 0,
            y: 0,
            width: 500,
            height: 500,
            zIndex: 1,
            locked: false,
            createdAt: now,
            updatedAt: now,
            title: "boundary",
            collapsed: false,
          };
          await commit("accept-parent-create", [
            { id: parent.id, expectedRevision: 0, data: parent },
          ]);
          const nested = (
            await call("create_note", {
              canvas_id: "canvas",
              request_id: "accept-nested",
              target: { section_id: parent.id },
              blocks: [{ text: "boundary" }],
            })
          ).structuredContent;
          parent = { ...parent, locked: true };
          await commit("accept-parent-lock", [
            { id: parent.id, expectedRevision: 1, data: parent },
          ]);
          assert.equal(
            (
              await call("update_task", {
                canvas_id: "canvas",
                request_id: "accept-locked",
                note_id: nested.note_id,
                task_id: nested.task_ids[0],
                expected_revision: 1,
                patch: { done: true },
              })
            ).structuredContent.code,
            "LOCKED",
          );
          parent = { ...parent, locked: false, parentId: "canvas-root" };
          await commit("accept-parent-archive", [
            { id: parent.id, expectedRevision: 2, data: parent },
          ]);
          assert.equal(
            (
              await call("get_content", {
                canvas_id: "canvas",
                note_id: nested.note_id,
              })
            ).structuredContent.code,
            "ARCHIVED",
          );
          assert.equal(
            (
              await call("update_note", {
                canvas_id: "canvas",
                request_id: "accept-archived",
                note_id: nested.note_id,
                expected_revision: 1,
                color: "rose",
              })
            ).structuredContent.code,
            "ARCHIVED",
          );
          const archived = (
            await call("get_content", {
              canvas_id: "canvas",
              note_id: nested.note_id,
              include_archived: true,
            })
          ).structuredContent;
          assert.equal(archived.archived, true);
          const hidden = (
            await call("search_content", {
              canvas_id: "canvas",
              query: "boundary",
            })
          ).structuredContent;
          assert.deepEqual(hidden.items, []);
          const large = (
            await call("create_note", {
              canvas_id: "canvas",
              request_id: "accept-large",
              target: { section_id: "ungrouped" },
              blocks: Array.from({ length: 3 }, () => ({
                text: "界".repeat(30000),
              })),
            })
          ).structuredContent;
          const bounded = (
            await call("get_content", {
              canvas_id: "canvas",
              note_id: large.note_id,
              limit: 100,
            })
          ).structuredContent;
          assert.equal(bounded.items.length, 2);
          assert.ok(bounded.next_cursor);
          assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 256000);
          const remaining = (
            await call("get_content", {
              canvas_id: "canvas",
              note_id: large.note_id,
              limit: 100,
              cursor: bounded.next_cursor,
            })
          ).structuredContent;
          assert.equal(remaining.items.length, 1);
          assert.equal(remaining.items[0].runs[0].text.length, 30000);
          // A later ordinary web edit remains intact after recovering this deletion.
          const snapshot = await (
            await req("/api/rooms/canvas/snapshot?authors=1", {
              headers: { Cookie: "qd_session=" + raw },
            })
          ).json();
          const row = snapshot.rows.find((r) => r.id === note.note_id),
            data = structuredClone(row.data);
          data.color = "blue";
          socket.send(
            JSON.stringify({
              type: "commit",
              opId: "accept-web-edit",
              changes: [{ id: row.id, expectedRevision: row.revision, data }],
            }),
          );
          assert.equal(
            (await take((m) => m.opId === "accept-web-edit")).type,
            "ack",
          );
          const grants = await (
            await req("/api/profile/mcp-grants", {
              headers: { Cookie: "qd_session=" + raw },
            })
          ).json();
          const active = grants.items.find((g) => g.state === "active");
          assert.equal(
            (
              await req("/api/profile/mcp-grants/" + active.id, {
                method: "DELETE",
                headers: { Cookie: "qd_session=" + raw },
              })
            ).status,
            200,
          );
          assert.equal(
            (await rpc(access.access_token, "tools/list")).status,
            401,
          );
          const restore = async (id) =>
            req(
              "/api/rooms/canvas/mcp-operations/" +
                removed.operation_id +
                "/restore",
              {
                method: "POST",
                headers: {
                  Cookie: "qd_session=" + raw,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ request_id: id }),
              },
            );
          const restored = await restore("accept-restore");
          assert.equal(restored.status, 200);
          const value = await restored.json();
          assert.ok(value.task_ids.includes(tasks.task_ids[0]));
          assert.deepEqual(
            await (await restore("accept-retry-other-id")).json(),
            value,
          );
          const after = await (
            await req("/api/rooms/canvas/snapshot?authors=1", {
              headers: { Cookie: "qd_session=" + raw },
            })
          ).json();
          const recovered = after.rows.find((r) => r.id === note.note_id);
          assert.equal(recovered.data.color, "blue");
          const block = recovered.data.blocks.find(
            (b) => b.id === tasks.task_ids[0],
          );
          assert.equal(block.remark.text, "preserved remark");
          assert.equal(block.createdByUserId, "alice");
          assert.deepEqual(
            [...invoked].sort(),
            [
              "list_canvases",
              "get_canvas",
              "search_content",
              "get_content",
              "create_tasks",
              "update_task",
              "delete_task",
              "create_note",
              "update_note",
            ].sort(),
          );
        } finally {
          socket.close();
        }
        const bob = await approve(client, ["qingdan:read"], "b".repeat(64), [
          "other",
        ]);
        assert.equal(bob.p.status, 200);
        const bobToken = await (
          await exchange(
            client,
            new URL((await bob.p.json()).redirect_to).searchParams.get("code"),
          )
        ).json();
        const bobList = (
          await protocolJson(
            await rpc(bobToken.access_token, "tools/call", {
              name: "list_canvases",
              arguments: {},
            }),
          )
        ).result.structuredContent;
        assert.deepEqual(
          bobList.items.map((x) => x.canvas_id),
          ["other"],
        );
        assert.equal(
          (
            await protocolJson(
              await rpc(bobToken.access_token, "tools/call", {
                name: "get_canvas",
                arguments: { canvas_id: "canvas" },
              }),
            )
          ).result.structuredContent.code,
          "ACCESS_DENIED",
        );
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
    await t.test(
      "password reset revokes a real provider token and refresh grant",
      async () => {
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
        const approval = await approve(client);
        assert.equal(approval.p.status, 200);
        const token = await (
          await exchange(
            client,
            new URL((await approval.p.json()).redirect_to).searchParams.get(
              "code",
            ),
          )
        ).json();
        const passwordHash = (
          await db
            .prepare("SELECT password_hash FROM accounts WHERE id='alice'")
            .first()
        ).password_hash;
        await db
          .prepare(
            "UPDATE accounts SET email='alice@example.test',email_verified_at=? WHERE id='alice'",
          )
          .bind(Date.now())
          .run();
        const challengeId = "d".repeat(64),
          codeHash = createHmac(
            "sha256",
            "test-only-email-signing-secret-over-32-characters",
          )
            .update(
              JSON.stringify([
                challengeId,
                "alice",
                "reset",
                "alice@example.test",
                "123456",
              ]),
            )
            .digest("hex");
        await db
          .prepare(
            "INSERT INTO email_challenges(id,account_id,purpose,email,code_hash,credential_hash,prior_email,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            challengeId,
            "alice",
            "reset",
            "alice@example.test",
            codeHash,
            passwordHash,
            "alice@example.test",
            Date.now() + 600000,
          )
          .run();
        const reset = await req("/api/auth/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "alice",
            email: "alice@example.test",
            challengeId,
            code: "123456",
            password: "Reset-password-789",
          }),
        });
        assert.equal(reset.status, 200, await reset.clone().text());
        assert.equal((await rpc(token.access_token, "tools/list")).status, 401);
        const refresh = await req("/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: client.client_id,
            refresh_token: token.refresh_token,
            resource: origin + "/mcp",
          }),
        });
        assert.equal(refresh.status, 400);
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
    const diagnostics = await (await req("/fixture/diagnostics")).json();
    const counts = {};
    for (const message of diagnostics)
      counts[message] = (counts[message] || 0) + 1;
    assert.deepEqual(counts, {
      'CIMD fetch failed for https://cimd.example.test/mismatch.json: client_id "https://cimd.example.test/different.json" does not match metadata URL "https://cimd.example.test/mismatch.json"': 1,
      "CIMD fetch failed for https://cimd.example.test/oversized.json: Response exceeded size limit of 5120 bytes": 1,
      "OAuth error response: 400 invalid_grant - Invalid PKCE code_verifier": 1,
      "responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.": 40,
      "OAuth error response: 401 invalid_token - Invalid access token": 4,
      "OAuth error response: 400 invalid_grant - Grant not found": 2,
      "OAuth error response: 400 invalid_grant - Authorization is no longer active.": 1,
      "OAuth error response: 400 invalid_grant - Grant not found or authorization code expired": 1,
      "OAuth error response: 503 temporarily_unavailable - Authorization could not be checked. Retry later.": 2,
    });
  },
);
