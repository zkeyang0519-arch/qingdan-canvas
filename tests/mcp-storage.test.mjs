import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import WebSocket from "ws";
import { hashPassword } from "../worker/passwords.js";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const raw = "a".repeat(64),
  bobRaw = "b".repeat(64);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const resource = "https://app.test/mcp";
let mf, db, out, options;
const fixture = async (input) => {
  const ns = await mf.getDurableObjectNamespace("ROOMS");
  return ns
    .get(ns.idFromName("canvas"))
    .fetch("https://room/fixture", {
      method: "POST",
      body: JSON.stringify(input),
    })
    .then((r) => r.json());
};
const request = async (route, input, who = raw) => {
  const response = await mf.dispatchFetch("https://app.test" + route, {
    method: "POST",
    headers: {
      Cookie: "qd_session=" + who,
      "Content-Type": "application/json",
      ...(route === "/socket" ? { Upgrade: "websocket" } : {}),
    },
    body: JSON.stringify(input),
  });
  if (response.webSocket) return response;
  return { status: response.status, ...(await response.json()) };
};
const consent = async (options = {}) => {
  const selection = await request("/consent", {
    handle: crypto.randomUUID(),
    clientId: "client",
    resource,
    scopes: ["qingdan:read", "qingdan:write"],
    canvasIds: ["canvas"],
    ...options,
  });
  assert.equal(selection.status, 200, JSON.stringify(selection));
  const pending = await request("/pending", { handle: selection.handle });
  assert.equal(pending.status, 200, JSON.stringify(pending));
  return pending;
};
const grant = async (options) => {
  const g = await consent(options);
  const active = await request("/activate", {
    grantId: g.grantId,
    providerGrantId: "provider-" + g.grantId,
  });
  assert.equal(active.status, 200, JSON.stringify(active));
  return {
    accountId: "alice",
    clientId: "client",
    grantId: g.grantId,
    resource,
    scopes: ["qingdan:read", "qingdan:write"],
  };
};
const mcp = (principal, name, input) =>
  request("/mcp", {
    canvasId: "canvas",
    principal,
    name,
    input: { canvas_id: "canvas", ...input },
  });
const create = (p, id = crypto.randomUUID(), text = "first") =>
  mcp(p, "create_note", {
    request_id: id,
    target: { section_id: "ungrouped" },
    blocks: [{ text }],
  });
const operations = (input, who) =>
  request("/operations", { canvasId: "canvas", input }, who);
async function ws(who = raw) {
  const socket = new WebSocket(
    new URL("/socket", await mf.ready).href.replace(/^http/, "ws"),
    { headers: { Cookie: "qd_session=" + who } },
  );
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    async send(data) {
      socket.send(JSON.stringify(data));
      for (let i = 0; i < 100; i++) {
        const at = messages.findIndex((m) => m.opId === data.opId);
        if (at >= 0) return messages.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("no ack");
    },
  };
}

test(
  "isolated D1 grants and SQLite DO MCP execution",
  { timeout: 60000 },
  async (t) => {
    await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
    out = await mkdtemp(new URL("../.tmp/mcp-storage-", import.meta.url));
    const scriptPath = path.join(out, "worker.mjs");
    try {
      await build({
        entryPoints: [
          fileURLToPath(new URL("./fixtures/mcp-worker.ts", import.meta.url)),
        ],
        bundle: true,
        platform: "neutral",
        mainFields: ["module", "main"],
        conditions: ["workerd", "browser"],
        format: "esm",
        external: ["node:*", "cloudflare:*"],
        outfile: scriptPath,
        logLevel: "silent",
      });
    } catch (e) {
      assert.fail("MCP storage modules must be available: " + e.message);
    }
    options = convertV4MiniflareOptions({
      name: "mcp-storage",
      scriptPath,
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      isolatedResourcePersistencePath: path.join(out, "state"),
      durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
      durableObjectsPersist: path.join(out, "do"),
      bindings: {
        APP_ENV: "test",
        PUBLIC_ORIGIN: "https://app.test",
        EMAIL_CODE_SECRET: "test-only-email-signing-secret-over-32-characters",
        RESEND_API_KEY: "test",
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
    for (const f of (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = (
        await readFile(new URL("../migrations/" + f, import.meta.url), "utf8")
      ).replace(/^--.*$/gm, "");
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
          sha(bobRaw),
          "bob",
          Date.now() + 86400000,
        ),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026-01-01'),('other','Other','alice','invite2','2026-01-01'),('foreign','Foreign','bob','invite3','2026-01-01')",
      ),
      db.prepare(
        "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01'),('canvas','bob','editor','2026-01-01'),('other','alice','owner','2026-01-01'),('foreign','bob','owner','2026-01-01')",
      ),
    ]);

    await t.test(
      "consent GET binds once; selection POST rejects account switching and renewed browser sessions",
      async () => {
        const handle = crypto.randomUUID();
        const binding = {
          handle,
          clientId: "client",
          resource,
          scopes: ["qingdan:read", "qingdan:write"],
        };
        assert.equal((await request("/bind", binding)).status, 200);
        assert.equal((await request("/bind", binding, bobRaw)).status, 403);
        assert.equal((await request("/pending", { handle })).status, 403);
        const selection = { scopes: ["qingdan:read"], canvasIds: ["canvas"] };
        assert.equal(
          (await request("/submit", { handle, selection }, bobRaw)).status,
          403,
        );
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha("e".repeat(64)), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (await request("/submit", { handle, selection }, "e".repeat(64)))
            .status,
          403,
        );
        assert.equal(
          (await request("/submit", { handle, selection })).status,
          200,
        );
        assert.equal(
          (await request("/submit", { handle, selection })).status,
          403,
        );
        assert.equal((await request("/pending", { handle })).status, 200);
        const limited = crypto.randomUUID();
        await request("/bind", {
          ...binding,
          handle: limited,
          scopes: ["qingdan:read"],
        });
        assert.equal(
          (
            await request("/submit", {
              handle: limited,
              selection: {
                ...selection,
                scopes: ["qingdan:read", "qingdan:write"],
              },
            })
          ).status,
          403,
        );
        const expired = crypto.randomUUID();
        await request("/bind", { ...binding, handle: expired });
        await db
          .prepare(
            "UPDATE mcp_consent_selections SET expires_at=? WHERE handle=?",
          )
          .bind(Date.now() - 1, expired)
          .run();
        assert.equal(
          (await request("/submit", { handle: expired, selection })).status,
          403,
        );
      },
    );
    await t.test(
      "repeated consent GET returns original open binding without extending expiry",
      async () => {
        const handle = crypto.randomUUID();
        const binding = {
          handle,
          clientId: "client",
          resource,
          scopes: ["qingdan:read", "qingdan:write", "offline_access"],
        };
        const first = await request("/bind", binding);
        assert.equal(first.status, 200, JSON.stringify(first));
        await db
          .prepare(
            "UPDATE mcp_consent_selections SET expires_at=expires_at-5000 WHERE handle=?",
          )
          .bind(handle)
          .run();
        const repeated = await request("/bind", {
          ...binding,
          scopes: ["offline_access", "qingdan:write", "qingdan:read"],
        });
        assert.equal(repeated.status, 200);
        assert.equal(repeated.expiresAt, first.expiresAt - 5000);
        assert.equal(
          (await request("/bind", { ...binding, clientId: "changed" })).status,
          403,
        );
        assert.equal(
          (await request("/bind", { ...binding, scopes: ["qingdan:read"] }))
            .status,
          403,
        );
        await request("/submit", {
          handle,
          selection: {
            scopes: ["qingdan:read", "offline_access"],
            canvasIds: ["canvas"],
          },
        });
        assert.equal((await request("/bind", binding)).status, 403);
      },
    );
    await t.test(
      "pending cannot authorize; activation is one-shot and session bound",
      async () => {
        const g = await consent();
        const principal = {
          accountId: "alice",
          clientId: "client",
          grantId: g.grantId,
          resource,
          scopes: ["qingdan:read"],
        };
        assert.equal(
          (await request("/require", { principal, canvasId: "canvas" })).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/activate",
              { grantId: g.grantId, providerGrantId: "provider" },
              bobRaw,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/activate", {
              grantId: g.grantId,
              providerGrantId: "provider",
            })
          ).status,
          200,
        );
        assert.notEqual(
          (
            await request("/activate", {
              grantId: g.grantId,
              providerGrantId: "replacement",
            })
          ).status,
          200,
        );
        assert.notEqual(
          (await request("/pending", { handle: g.handle })).status,
          200,
        );
      },
    );
    await t.test(
      "authorization intersects token, grant, selected canvases and current membership",
      async () => {
        const p = await grant();
        assert.equal(
          (
            await request("/require", {
              principal: p,
              canvasId: "canvas",
              write: true,
            })
          ).accountName,
          "Alice",
        );
        for (const principal of [
          { ...p, clientId: "wrong" },
          { ...p, accountId: "bob" },
          { ...p, resource: "https://other/mcp" },
        ])
          assert.equal(
            (await request("/require", { principal, canvasId: "canvas" }))
              .status,
            401,
          );
        assert.equal(
          (
            await request("/require", {
              principal: { ...p, scopes: ["qingdan:read"] },
              canvasId: "canvas",
              write: true,
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/require", { principal: p, canvasId: "other" }))
            .status,
          403,
        );
        const read = await grant({ scopes: ["qingdan:read"] });
        assert.equal(
          (
            await request("/require", {
              principal: read,
              canvasId: "canvas",
              write: true,
            })
          ).status,
          403,
        );
        await db
          .prepare(
            "DELETE FROM members WHERE room_id='canvas' AND user_id='alice'",
          )
          .run();
        assert.equal(
          (await request("/require", { principal: p, canvasId: "canvas" }))
            .status,
          403,
        );
        assert.deepEqual(
          (await request("/list", { principal: p, input: {} })).items,
          [],
        );
        await db
          .prepare(
            "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01')",
          )
          .run();
        assert.equal(
          (await request("/revoke", { grantId: p.grantId })).status,
          200,
        );
        assert.equal(
          (await request("/require", { principal: p, canvasId: "canvas" }))
            .status,
          401,
        );
        await db
          .prepare("UPDATE mcp_grants SET expires_at=? WHERE id=?")
          .bind(Date.now() - 1, read.grantId)
          .run();
        assert.equal(
          (await request("/require", { principal: read, canvasId: "canvas" }))
            .status,
          401,
        );
        assert.equal(
          (
            await request("/consent", {
              handle: crypto.randomUUID(),
              clientId: "client",
              resource,
              scopes: ["qingdan:read"],
              canvasIds: ["foreign"],
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "directory keyset binds principal and excludes lost membership on each page",
      async () => {
        const p = await grant({ canvasIds: ["canvas", "other"] });
        const first = await request("/list", {
          principal: p,
          input: { limit: 1 },
        });
        assert.deepEqual(
          first.items.map((x) => x.canvas_id),
          ["canvas"],
        );
        assert.ok(first.next_cursor);
        await db
          .prepare(
            "DELETE FROM members WHERE room_id='other' AND user_id='alice'",
          )
          .run();
        assert.deepEqual(
          (
            await request("/list", {
              principal: p,
              input: { limit: 1, cursor: first.next_cursor },
            })
          ).items,
          [],
        );
        const other = await grant();
        assert.equal(
          (
            await request("/list", {
              principal: other,
              input: { cursor: first.next_cursor },
            })
          ).code,
          "VALIDATION_ERROR",
        );
        await db
          .prepare(
            "INSERT INTO members VALUES('other','alice','owner','2026-01-01')",
          )
          .run();
      },
    );
    await t.test(
      "session invalidation and revoke-all prevent delayed pending activation",
      async () => {
        const pending = await consent();
        const active = await grant();
        await request("/revoke-all", {});
        assert.equal(
          (
            await request("/activate", {
              grantId: pending.grantId,
              providerGrantId: "later",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/require", { principal: active, canvasId: "canvas" }))
            .status,
          401,
        );
        const delayed = await consent();
        await db
          .prepare("DELETE FROM account_sessions WHERE token_hash=?")
          .bind(sha(raw))
          .run();
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha("c".repeat(64)), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (
            await request(
              "/activate",
              { grantId: delayed.grantId, providerGrantId: "later" },
              "c".repeat(64),
            )
          ).status,
          403,
        );
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
      },
    );
    await t.test(
      "ordinary logout leaves active grants valid and prevents pending consent activation",
      async () => {
        const active = await grant();
        const pending = await consent();
        assert.equal((await request("/logout", {})).status, 200);
        // Log back in under a different browser session: the original pending
        // selection stays bound to the deleted session even for the same account.
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha("d".repeat(64)), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (
            await request(
              "/require",
              { principal: active, canvasId: "canvas" },
              "d".repeat(64),
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "/activate",
              { grantId: pending.grantId, providerGrantId: "late" },
              "d".repeat(64),
            )
          ).status,
          403,
        );
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
      },
    );
    await t.test(
      "real password change atomically revokes pending and active grants",
      async () => {
        const active = await grant();
        const pending = await consent();
        await db
          .prepare("UPDATE accounts SET password_hash=? WHERE id='alice'")
          .bind(await hashPassword("old-password-2026"))
          .run();
        const changed = await request("/password", {
          currentPassword: "old-password-2026",
          password: "new-password-2026",
        });
        assert.equal(changed.status, 200, JSON.stringify(changed));
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (await request("/require", { principal: active, canvasId: "canvas" }))
            .status,
          401,
        );
        assert.equal(
          (
            await db
              .prepare("SELECT state FROM mcp_grants WHERE id=?")
              .bind(pending.grantId)
              .first()
          ).state,
          "revoked",
        );
        assert.equal(
          (
            await request("/activate", {
              grantId: pending.grantId,
              providerGrantId: "late",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "real password reset revokes active and pending grants atomically",
      async () => {
        const active = await grant();
        const pending = await consent();
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
        const challengeId = "f".repeat(64);
        const codeHash = createHmac(
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
        const reset = await request("/api/auth/password-reset/confirm", {
          username: "alice",
          email: "alice@example.test",
          challengeId,
          code: "123456",
          password: "reset-password-2026",
        });
        assert.equal(reset.status, 200, JSON.stringify(reset));
        await db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha(raw), "alice", Date.now() + 86400000)
          .run();
        assert.equal(
          (await request("/require", { principal: active, canvasId: "canvas" }))
            .status,
          401,
        );
        assert.equal(
          (
            await db
              .prepare("SELECT state FROM mcp_grants WHERE id=?")
              .bind(pending.grantId)
              .first()
          ).state,
          "revoked",
        );
      },
    );
    await t.test(
      "same request replays frozen IDs/result; changed input is rejected without writes",
      async () => {
        const p = await grant();
        const id = crypto.randomUUID();
        const a = await create(p, id);
        assert.equal(a.status, 200, JSON.stringify(a));
        assert.equal(a.sequence, 1);
        assert.deepEqual(await create(p, id), a);
        assert.equal(
          (await create(p, id, "changed")).code,
          "IDEMPOTENCY_KEY_REUSED",
        );
        assert.equal((await mcp(p, "get_canvas", {})).sequence, 1);
        const d = await mcp(p, "get_content", { note_id: a.note_id });
        assert.equal(d.items.length, 1);
        assert.equal(d.items[0].created_by, "alice");
      },
    );
    await t.test(
      "web writes share revisions/sequence and invalidate MCP cursors; no-op keeps sequence",
      async () => {
        const p = await grant();
        const a = await create(p);
        const b = await create(p);
        const page = await mcp(p, "search_content", { limit: 1 });
        assert.ok(page.next_cursor);
        const connection = await ws();
        t.after(() => connection.socket.close());
        const room = await mf.getDurableObjectNamespace("ROOMS");
        const snapshot = await room
          .get(room.idFromName("canvas"))
          .fetch("https://room/snapshot", {
            headers: { "X-QD-Room": "canvas", "X-QD-User": "alice" },
          })
          .then((r) => r.json());
        const row = snapshot.rows.find((r) => r.id === a.note_id);
        const data = structuredClone(row.data);
        data.color = "blue";
        const ack = await connection.send({
          type: "commit",
          opId: "web-change",
          changes: [{ id: row.id, expectedRevision: row.revision, data }],
        });
        assert.equal(ack.type, "ack", JSON.stringify(ack));
        assert.equal(
          (
            await mcp(p, "search_content", {
              limit: 1,
              cursor: page.next_cursor,
            })
          ).code,
          "STALE_CURSOR",
        );
        assert.equal(
          (
            await mcp(p, "update_task", {
              request_id: "stale",
              note_id: a.note_id,
              task_id: a.task_ids[0],
              expected_revision: 1,
              patch: { done: true },
            })
          ).code,
          "REVISION_CONFLICT",
        );
        const before = (await mcp(p, "get_canvas", {})).sequence;
        const no = await mcp(p, "update_task", {
          request_id: "noop",
          note_id: b.note_id,
          task_id: b.task_ids[0],
          expected_revision: 1,
          patch: { done: false },
        });
        assert.equal(no.changed, false);
        assert.equal(no.sequence, before);
        assert.deepEqual(
          await connection.send({
            type: "commit",
            opId: "web-change",
            changes: [{ id: row.id, expectedRevision: row.revision, data }],
          }),
          ack,
        );
      },
    );
    await t.test(
      "durable own deletion restores after revoke, preserving later web edits/style/authors",
      async () => {
        const p = await grant();
        const a = await create(p);
        const removed = await mcp(p, "delete_task", {
          request_id: "delete",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        assert.ok(removed.operation_id);
        assert.ok(removed.restorable_until);
        assert.equal(
          (await mcp(p, "get_content", { note_id: a.note_id })).items.length,
          0,
        );
        const bobConnection = await ws(bobRaw);
        const current = JSON.parse(
          (
            await fixture({
              sql: "SELECT value FROM objects WHERE id=?",
              bindings: [a.note_id],
            })
          )[0].value,
        );
        current.data.color = "blue";
        current.data.blocks.push({
          id: "bob-later",
          runs: [{ type: "text", text: "later" }],
          done: false,
          createdAt: new Date().toISOString(),
          completedAt: null,
        });
        const appended = await bobConnection.send({
          type: "commit",
          opId: "bob-append",
          changes: [{ id: a.note_id, expectedRevision: 2, data: current.data }],
        });
        assert.equal(appended.type, "ack", JSON.stringify(appended));
        assert.equal(appended.rows[0].revision, 3);
        bobConnection.socket.close();
        const audit = await operations({ action: "list", limit: 50 });
        assert.ok(
          audit.items.some((x) => x.operation_id === removed.operation_id),
        );
        assert.equal(
          (
            await operations(
              { action: "restore", operation_id: removed.operation_id },
              bobRaw,
            )
          ).code,
          "ACCESS_DENIED",
        );
        await request("/revoke", { grantId: p.grantId });
        const restored = await operations({
          action: "restore",
          operation_id: removed.operation_id,
        });
        assert.equal(restored.changed, true, JSON.stringify(restored));
        assert.deepEqual(
          await operations({
            action: "restore",
            operation_id: removed.operation_id,
          }),
          restored,
        );
        const newP = await grant();
        const detail = await mcp(newP, "get_content", { note_id: a.note_id });
        assert.equal(detail.items.length, 2);
        assert.ok(detail.items.some((x) => x.task_id === a.task_ids[0]));
        assert.equal(
          detail.items.find((x) => x.task_id === a.task_ids[0]).created_by,
          "alice",
        );
        assert.equal(
          detail.items.find((x) => x.task_id === "bob-later").created_by,
          "bob",
        );
        const room = await mf.getDurableObjectNamespace("ROOMS");
        const snap = await room
          .get(room.idFromName("canvas"))
          .fetch("https://room/snapshot", {
            headers: { "X-QD-Room": "canvas", "X-QD-User": "alice" },
          })
          .then((r) => r.json());
        assert.equal(
          snap.rows.find((r) => r.id === a.note_id).data.color,
          "blue",
        );
      },
    );
    await t.test(
      "failed transaction rolls back objects, authors, sequence, snapshots and receipts",
      async () => {
        const p = await grant();
        const a = await create(p);
        const before = (await mcp(p, "get_canvas", {})).sequence;
        const counts = await fixture({
          sql: "SELECT (SELECT COUNT(*) FROM objects) AS objects,(SELECT COUNT(*) FROM task_authors) AS authors,(SELECT COUNT(*) FROM mcp_receipts) AS receipts,(SELECT COUNT(*) FROM mcp_deleted_blocks) AS snapshots",
        });
        await fixture({ failValidation: true });
        const failed = await mcp(p, "delete_task", {
          request_id: "rollback-delete",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        assert.equal(failed.status, 500);
        assert.equal((await create(p, "rollback-create")).status, 500);
        await fixture({ failValidation: false });
        // Fail the last snapshot INSERT, after objects, sequence and receipt
        // were written; all of them must roll back together.
        await fixture({
          sql: "CREATE TRIGGER fail_snapshot BEFORE INSERT ON mcp_deleted_blocks BEGIN SELECT RAISE(ABORT, 'Injected snapshot failure'); END",
        });
        assert.equal(
          (
            await mcp(p, "delete_task", {
              request_id: "rollback-delete",
              note_id: a.note_id,
              task_id: a.task_ids[0],
              expected_revision: 1,
            })
          ).status,
          500,
        );
        await fixture({ sql: "DROP TRIGGER fail_snapshot" });
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_request_bindings WHERE grant_id=? AND request_id=?",
              )
              .bind(p.grantId, "rollback-delete")
              .first()
          ).n,
          1,
        );
        assert.equal(
          (
            await mcp(p, "delete_task", {
              request_id: "rollback-delete",
              note_id: a.note_id,
              task_id: a.task_ids[0],
              expected_revision: 2,
            })
          ).code,
          "IDEMPOTENCY_KEY_REUSED",
        );
        assert.equal((await mcp(p, "get_canvas", {})).sequence, before);
        assert.equal(
          (await mcp(p, "get_content", { note_id: a.note_id })).items.length,
          1,
        );
        assert.deepEqual(
          await fixture({
            sql: "SELECT (SELECT COUNT(*) FROM objects) AS objects,(SELECT COUNT(*) FROM task_authors) AS authors,(SELECT COUNT(*) FROM mcp_receipts) AS receipts,(SELECT COUNT(*) FROM mcp_deleted_blocks) AS snapshots",
          }),
          counts,
        );
        const success = await mcp(p, "delete_task", {
          request_id: "rollback-delete",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        assert.equal(success.status, 200);
        assert.deepEqual(await fixture({ diagnostics: true }), [
          "Request failed Injected tree validation failure",
          "Request failed Injected tree validation failure",
          "Request failed Injected snapshot failure: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
        ]);
      },
    );
    await t.test(
      "committed success survives broadcast failure, concurrent duplicate requests and runtime restart",
      async () => {
        const p = await grant();
        await fixture({ failBroadcast: true });
        const id = "broadcast-failed";
        const [a, b] = await Promise.all([create(p, id), create(p, id)]);
        assert.equal(a.status, 200);
        assert.deepEqual(a, b);
        await fixture({ failBroadcast: false });
        const deleted = await mcp(p, "delete_task", {
          request_id: "durable-delete",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        const before = (await mcp(p, "get_canvas", {})).sequence;
        assert.deepEqual(
          await fixture({ diagnostics: true }),
          Array(2).fill(
            "Committed canvas broadcast failed Error: Injected broadcast failure",
          ),
        );
        await mf.dispose();
        mf = new Miniflare(options);
        db = await mf.getD1Database("DB");
        assert.deepEqual(await create(p, id), a);
        assert.equal((await mcp(p, "get_canvas", {})).sequence, before);
        assert.equal(
          (await mcp(p, "get_content", { note_id: a.note_id })).items.length,
          0,
        );
        const recovered = await operations({
          action: "restore",
          operation_id: deleted.operation_id,
        });
        assert.equal(recovered.changed, true);
        assert.equal(
          (await mcp(p, "get_content", { note_id: a.note_id })).items[0]
            .task_id,
          a.task_ids[0],
        );
      },
    );
    await t.test(
      "restore enforces locks, archive, missing notes, task-ID collisions and membership",
      async () => {
        const p = await grant();
        const a = await create(p);
        const deleted = await mcp(p, "delete_task", {
          request_id: "recover-constraints",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        const get = () =>
          fixture({
            sql: "SELECT value FROM objects WHERE id=?",
            bindings: [a.note_id],
          }).then((r) => JSON.parse(r[0].value));
        const save = (row) =>
          fixture({
            sql: "UPDATE objects SET value=? WHERE id=?",
            bindings: [JSON.stringify(row), a.note_id],
          });
        const base = await get();
        let row = structuredClone(base);
        row.data.locked = true;
        await save(row);
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).code,
          "LOCKED",
        );
        row = structuredClone(base);
        row.data.parentId = "canvas-root";
        await save(row);
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).code,
          "ARCHIVED",
        );
        row = structuredClone(base);
        row.deleted = true;
        row.data = null;
        await save(row);
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).code,
          "NOT_FOUND",
        );
        await save(base);
        const original = (
          await fixture({
            sql: "SELECT snapshot FROM mcp_deleted_blocks WHERE operation_id=?",
            bindings: [deleted.operation_id],
          })
        ).map((r) => JSON.parse(r.snapshot))[0];
        row = structuredClone(base);
        row.data.blocks = [original.block];
        await save(row);
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).code,
          "REVISION_CONFLICT",
        );
        await save(base);
        await db
          .prepare(
            "DELETE FROM members WHERE room_id='canvas' AND user_id='alice'",
          )
          .run();
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).status,
          403,
        );
        await db
          .prepare(
            "INSERT INTO members VALUES('canvas','alice','owner','2026-01-01')",
          )
          .run();
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).changed,
          true,
        );
      },
    );
    await t.test(
      "expired recovery is rejected and alarm removes snapshots but retains immutable receipts",
      async () => {
        const p = await grant();
        const a = await create(p);
        const deleted = await mcp(p, "delete_task", {
          request_id: "expired",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        await fixture({
          sql: "UPDATE mcp_receipts SET expires_at=? WHERE operation_id=?",
          bindings: [Date.now() - 1, deleted.operation_id],
        });
        await fixture({
          sql: "UPDATE mcp_deleted_blocks SET expires_at=? WHERE operation_id=?",
          bindings: [Date.now() - 1, deleted.operation_id],
        });
        assert.equal(
          (
            await operations({
              action: "restore",
              operation_id: deleted.operation_id,
            })
          ).code,
          "NOT_FOUND",
        );
        await fixture({ alarm: true });
        assert.deepEqual(
          await fixture({
            sql: "SELECT COUNT(*) AS n FROM mcp_deleted_blocks WHERE operation_id=?",
            bindings: [deleted.operation_id],
          }),
          [{ n: 0 }],
        );
        assert.deepEqual(
          await fixture({
            sql: "SELECT COUNT(*) AS n FROM mcp_receipts WHERE operation_id=?",
            bindings: [deleted.operation_id],
          }),
          [{ n: 1 }],
        );
        assert.deepEqual(
          await mcp(p, "delete_task", {
            request_id: "expired",
            note_id: a.note_id,
            task_id: a.task_ids[0],
            expected_revision: 1,
          }),
          deleted,
        );
      },
    );

    await t.test(
      "DO independently rechecks grant and forbids arbitrary commit commands",
      async () => {
        const p = await grant();
        await request("/revoke", { grantId: p.grantId });
        const ns = await mf.getDurableObjectNamespace("ROOMS"),
          stub = ns.get(ns.idFromName("canvas"));
        const response = await stub.fetch("https://room/internal/mcp", {
          method: "POST",
          body: JSON.stringify({
            canvasId: "canvas",
            principal: p,
            name: "create_note",
            input: {
              canvas_id: "canvas",
              request_id: "bypass",
              target: { section_id: "ungrouped" },
              blocks: [{ text: "no" }],
            },
          }),
        });
        assert.equal(response.status, 401);
        const active = await grant();
        const passthrough = await stub.fetch("https://room/internal/mcp", {
          method: "POST",
          body: JSON.stringify({
            canvasId: "canvas",
            principal: active,
            name: "commit",
            input: { changes: [] },
          }),
        });
        assert.equal((await passthrough.json()).code, "VALIDATION_ERROR");
      },
    );
    await t.test(
      "audit uses own keyset pagination and bounded summaries without deleted text or huge ID lists",
      async () => {
        const p = await grant();
        const a = await create(p, crypto.randomUUID(), "private deleted text");
        const deleted = await mcp(p, "delete_task", {
          request_id: "audit-delete",
          note_id: a.note_id,
          task_id: a.task_ids[0],
          expected_revision: 1,
        });
        // Model a legitimately large immutable command result without inflating the
        // canvas fixture: old notes may contain many existing paragraph IDs.
        await fixture({
          sql: "UPDATE mcp_receipts SET value=? WHERE operation_id=?",
          bindings: [
            JSON.stringify({
              ...deleted,
              task_ids: Array.from(
                { length: 3000 },
                (_, i) => "task-" + i + "x".repeat(90),
              ),
            }),
            deleted.operation_id,
          ],
        });
        let cursor;
        let found;
        const seen = new Set();
        do {
          const page = await operations({
            action: "list",
            limit: 2,
            ...(cursor ? { cursor } : {}),
          });
          assert.ok(JSON.stringify(page).length < 256000);
          assert.ok(!JSON.stringify(page).includes("private deleted text"));
          for (const item of page.items) {
            assert.ok(!seen.has(item.operation_id));
            seen.add(item.operation_id);
            if (item.operation_id === deleted.operation_id) found = item;
          }
          cursor = page.next_cursor;
        } while (cursor);
        assert.ok(found);
        assert.equal(found.result.task_count, 3000);
        assert.equal(found.result.task_ids, undefined);
        const bob = await operations({ action: "list" }, bobRaw);
        assert.deepEqual(bob.items, []);
      },
    );
    await t.test(
      "grant/request binding rejects changed canvases at the private DO boundary",
      async () => {
        const p = await grant({ canvasIds: ["canvas", "other"] });
        const requestId = "global-two-canvas";
        const first = await create(p, requestId);
        assert.equal(first.status, 200);
        const ns = await mf.getDurableObjectNamespace("ROOMS");
        const response = await ns
          .get(ns.idFromName("other"))
          .fetch("https://room/internal/mcp", {
            method: "POST",
            body: JSON.stringify({
              canvasId: "other",
              principal: p,
              name: "create_note",
              input: {
                canvas_id: "other",
                request_id: requestId,
                target: { section_id: "ungrouped" },
                blocks: [{ text: "first" }],
              },
            }),
          });
        assert.equal((await response.json()).code, "IDEMPOTENCY_KEY_REUSED");
        assert.equal(
          (
            await request("/mcp", {
              canvasId: "other",
              principal: p,
              name: "get_canvas",
              input: { canvas_id: "other" },
            })
          ).sequence,
          0,
        );
        assert.deepEqual(await create(p, requestId), first);
        const concurrentId = "global-concurrent-two-canvas";
        const beforeCanvas = (await mcp(p, "get_canvas", {})).sequence;
        const beforeOther = (
          await request("/mcp", {
            canvasId: "other",
            principal: p,
            name: "get_canvas",
            input: { canvas_id: "other" },
          })
        ).sequence;
        const results = await Promise.all(
          ["canvas", "other"].map((canvasId) =>
            request("/mcp", {
              canvasId,
              principal: p,
              name: "create_note",
              input: {
                canvas_id: canvasId,
                request_id: concurrentId,
                target: { section_id: "ungrouped" },
                blocks: [{ text: "race" }],
              },
            }),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === 200).length,
          1,
        );
        assert.equal(
          results.filter((result) => result.code === "IDEMPOTENCY_KEY_REUSED")
            .length,
          1,
        );
        const afterCanvas = (await mcp(p, "get_canvas", {})).sequence;
        const afterOther = (
          await request("/mcp", {
            canvasId: "other",
            principal: p,
            name: "get_canvas",
            input: { canvas_id: "other" },
          })
        ).sequence;
        assert.equal(afterCanvas + afterOther - beforeCanvas - beforeOther, 1);
      },
    );
    await t.test(
      "reservation before delivery recovers with normalized input and cannot be claimed by another account",
      async () => {
        const p = await grant();
        const requestId = "reserved-before-delivery";
        const command = {
          canvasId: "canvas",
          principal: p,
          name: "create_note",
          input: {
            canvas_id: "canvas",
            request_id: requestId,
            target: { section_id: "ungrouped" },
            blocks: [{ text: "reserved", due_at: "2026-11-01T10:00:00+08:00" }],
          },
        };
        assert.equal(
          (
            await request("/reserve", {
              ...command,
              principal: { ...p, accountId: "bob" },
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_request_bindings WHERE grant_id=? AND request_id=?",
              )
              .bind(p.grantId, requestId)
              .first()
          ).n,
          0,
        );
        const reserved = await request("/reserve", command);
        assert.equal(reserved.status, 200);
        assert.match(reserved.inputDigest, /^[a-f0-9]{64}$/);
        assert.deepEqual(
          await fixture({
            sql: "SELECT COUNT(*) AS n FROM mcp_receipts WHERE grant_id=?",
            bindings: [p.grantId],
          }),
          [{ n: 0 }],
        );
        const before = (await mcp(p, "get_canvas", {})).sequence;
        const retry = {
          ...command,
          input: {
            ...command.input,
            blocks: [{ due_at: "2026-11-01T02:00:00.000Z", text: "reserved" }],
          },
        };
        const completed = await request("/mcp", retry);
        assert.equal(completed.status, 200);
        assert.equal(completed.sequence, before + 1);
        assert.deepEqual(await request("/mcp", command), completed);
        assert.deepEqual(
          await fixture({
            sql: "SELECT COUNT(*) AS n FROM mcp_receipts WHERE grant_id=?",
            bindings: [p.grantId],
          }),
          [{ n: 1 }],
        );
        assert.equal(
          (
            await request("/reserve", {
              ...command,
              name: "create_tasks",
              input: {
                canvas_id: "canvas",
                request_id: requestId,
                target: { section_id: "ungrouped" },
                items: [{ text: "reserved" }],
              },
            })
          ).code,
          "IDEMPOTENCY_KEY_REUSED",
        );
      },
    );
    await t.test(
      "DO rechecks authorization after the asynchronous request reservation",
      async () => {
        const p = await grant();
        const before = (await mcp(p, "get_canvas", {})).sequence;
        await fixture({ revokeAfterReservation: p.grantId });
        assert.equal(
          (await create(p, "revoked-after-reservation")).status,
          401,
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_request_bindings WHERE grant_id=?",
              )
              .bind(p.grantId)
              .first()
          ).n,
          1,
        );
        assert.deepEqual(
          await fixture({
            sql: "SELECT COUNT(*) AS n FROM mcp_receipts WHERE grant_id=?",
            bindings: [p.grantId],
          }),
          [{ n: 0 }],
        );
        assert.equal(
          (await mcp(await grant(), "get_canvas", {})).sequence,
          before,
        );
      },
    );
    const entered = async (gate) => {
      for (let i = 0; i < 200; i++) {
        if ((await request("/gate/status?gate=" + gate, {})).entered) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error("D1 gate did not enter: " + gate);
    };
    const reviveSession = () =>
      db
        .prepare("INSERT OR REPLACE INTO account_sessions VALUES(?,?,?)")
        .bind(sha(raw), "alice", Date.now() + 86400000)
        .run();
    await t.test(
      "losing password request cannot revoke a grant authorized after the winning change",
      async () => {
        await db
          .prepare("UPDATE accounts SET password_hash=? WHERE id='alice'")
          .bind(await hashPassword("race-old-password"))
          .run();
        const loser = request("/race/password?gate=password", {
          currentPassword: "race-old-password",
          password: "loser-new-password",
        });
        await entered("password");
        assert.equal(
          (
            await request("/password", {
              currentPassword: "race-old-password",
              password: "winner-new-password",
            })
          ).status,
          200,
        );
        await reviveSession();
        const p = await grant();
        await request("/gate/release?gate=password", {});
        assert.equal((await loser).status, 409);
        assert.equal(
          (await request("/require", { principal: p, canvasId: "canvas" }))
            .status,
          200,
        );
      },
    );
    await t.test(
      "losing reset challenge claimant cannot revoke a later authorized grant",
      async () => {
        const passwordHash = (
          await db
            .prepare("SELECT password_hash FROM accounts WHERE id='alice'")
            .first()
        ).password_hash;
        const challengeId = "9".repeat(64),
          email = "alice@example.test";
        const codeHash = createHmac(
          "sha256",
          "test-only-email-signing-secret-over-32-characters",
        )
          .update(
            JSON.stringify([challengeId, "alice", "reset", email, "123456"]),
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
            email,
            codeHash,
            passwordHash,
            email,
            Date.now() + 600000,
          )
          .run();
        const body = {
          username: "alice",
          email,
          challengeId,
          code: "123456",
          password: "losing-reset-password",
        };
        const loser = request("/race/reset?gate=reset", body);
        await entered("reset");
        assert.equal(
          (
            await request("/api/auth/password-reset/confirm", {
              ...body,
              password: "winner-reset-password",
            })
          ).status,
          200,
        );
        await reviveSession();
        const p = await grant();
        await request("/gate/release?gate=reset", {});
        assert.equal((await loser).status, 400);
        assert.equal(
          (await request("/require", { principal: p, canvasId: "canvas" }))
            .status,
          200,
        );
      },
    );
    await t.test(
      "single revoke returns the provider ID activated before its revocation transaction",
      async () => {
        const pending = await consent();
        const revoked = request("/race/revoke?gate=revoke", {
          grantId: pending.grantId,
        });
        await entered("revoke");
        const providerGrantId = "activated-during-revoke";
        assert.equal(
          (
            await request("/activate", {
              grantId: pending.grantId,
              providerGrantId,
            })
          ).status,
          200,
        );
        await request("/gate/release?gate=revoke", {});
        assert.equal((await revoked).providerGrantId, providerGrantId);
        assert.equal(
          (
            await db
              .prepare("SELECT state FROM mcp_grants WHERE id=?")
              .bind(pending.grantId)
              .first()
          ).state,
          "revoked",
        );
      },
    );
    await t.test(
      "revoke-all returns provider IDs for activation and new grants preceding its transaction",
      async () => {
        const pending = await consent();
        const revoked = request("/race/revoke-all?gate=revoke-all", {});
        await entered("revoke-all");
        const providerGrantId = "activated-during-revoke-all";
        assert.equal(
          (
            await request("/activate", {
              grantId: pending.grantId,
              providerGrantId,
            })
          ).status,
          200,
        );
        const later = await grant();
        await request("/gate/release?gate=revoke-all", {});
        const result = await revoked;
        assert.ok(
          result.items.some(
            (item) =>
              item.grantId === pending.grantId &&
              item.providerGrantId === providerGrantId,
          ),
        );
        assert.ok(
          result.items.some(
            (item) =>
              item.grantId === later.grantId &&
              item.providerGrantId === "provider-" + later.grantId,
          ),
        );
        assert.equal(
          (await request("/require", { principal: later, canvasId: "canvas" }))
            .status,
          401,
        );
      },
    );
    await t.test(
      "consent binding cleans at most 100 expired temporary lifecycles while preserving history and request bindings",
      async () => {
        const preserved = await grant();
        const saved = await create(preserved, "cleanup-success");
        const pending = await consent();
        const held = await consent();
        await db
          .prepare("INSERT INTO mcp_request_bindings VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(
            held.grantId,
            "held",
            "alice",
            "client",
            resource,
            "canvas",
            "create_note",
            "digest",
            Date.now(),
          )
          .run();
        const live = await consent();
        const expired = 1;
        await db
          .prepare(
            "UPDATE mcp_consent_selections SET expires_at=? WHERE grant_id IN (?,?,?)",
          )
          .bind(expired, preserved.grantId, pending.grantId, held.grantId)
          .run();
        await request("/revoke", { grantId: preserved.grantId });
        // More than one pass, interleaved open/selected lifecycles and one pending grant.
        await db.batch(
          Array.from({ length: 104 }, (_, i) =>
            db
              .prepare(
                "INSERT INTO mcp_consent_selections VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .bind(
                "cleanup-" + i,
                "alice",
                sha(raw),
                "client",
                resource,
                '["qingdan:read"]',
                "[]",
                i % 2 ? "open" : "selected",
                null,
                expired - 10000 + i,
                expired,
              ),
          ),
        );
        const trigger = () =>
          request("/bind", {
            handle: crypto.randomUUID(),
            clientId: "client",
            resource,
            scopes: ["qingdan:read"],
          });
        assert.equal((await trigger()).status, 200);
        const count = () =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM mcp_consent_selections WHERE handle LIKE 'cleanup-%' OR grant_id=?",
            )
            .bind(pending.grantId)
            .first();
        assert.equal(
          (await count()).n,
          5,
          "one pass must remove exactly 100 eligible lifecycles",
        );
        assert.equal((await trigger()).status, 200);
        assert.equal((await count()).n, 0);
        assert.equal(
          await db
            .prepare("SELECT id FROM mcp_grants WHERE id=?")
            .bind(pending.grantId)
            .first(),
          null,
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_grant_rooms WHERE grant_id=?",
              )
              .bind(pending.grantId)
              .first()
          ).n,
          0,
        );
        for (const id of [preserved.grantId, held.grantId, live.grantId])
          assert.ok(
            await db
              .prepare("SELECT id FROM mcp_grants WHERE id=?")
              .bind(id)
              .first(),
          );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_request_bindings WHERE grant_id IN (?,?)",
              )
              .bind(preserved.grantId, held.grantId)
              .first()
          ).n,
          2,
        );
        assert.equal(
          (
            await fixture({
              sql: "SELECT operation_id FROM mcp_receipts WHERE operation_id=?",
              bindings: [saved.operation_id],
            })
          ).length,
          1,
        );
        assert.equal(
          (
            await request("/activate", {
              grantId: held.grantId,
              providerGrantId: "expired-held",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "cleanup rechecks pending state inside its transaction after candidate selection",
      async () => {
        const pending = await consent();
        await db
          .prepare(
            "UPDATE mcp_consent_selections SET expires_at=1 WHERE grant_id=?",
          )
          .bind(pending.grantId)
          .run();
        const cleanup = request("/cleanup?gate=cleanup", { now: Date.now() });
        while (
          !(
            await (
              await mf.dispatchFetch(
                "https://app.test/gate/status?gate=cleanup",
              )
            ).json()
          ).entered
        )
          await new Promise((r) => setTimeout(r, 5));
        // A live activation wins between candidate selection and the deletion batch.
        await db
          .prepare(
            "UPDATE mcp_consent_selections SET expires_at=? WHERE grant_id=?",
          )
          .bind(Date.now() + 60000, pending.grantId)
          .run();
        assert.equal(
          (
            await request("/activate", {
              grantId: pending.grantId,
              providerGrantId: "cleanup-race",
            })
          ).status,
          200,
        );
        await request("/gate/release?gate=cleanup", {});
        assert.equal((await cleanup).status, 200);
        assert.equal(
          (
            await db
              .prepare("SELECT state FROM mcp_grants WHERE id=?")
              .bind(pending.grantId)
              .first()
          ).state,
          "active",
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM mcp_grant_rooms WHERE grant_id=?",
              )
              .bind(pending.grantId)
              .first()
          ).n,
          1,
        );
        assert.equal((await fixture({ diagnostics: true })).length, 0);
      },
    );
  },
);
