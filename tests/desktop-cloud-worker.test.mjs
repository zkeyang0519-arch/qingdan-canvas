import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceToken = "a".repeat(64),
  verifier = "b".repeat(64);

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp/desktop-cloud-"));
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "browser"],
    format: "esm",
    external: ["node:*", "cloudflare:*"],
    outfile: path.join(dir, "worker.mjs"),
    logLevel: "silent",
  });
  const options = convertV4MiniflareOptions({
    name: "desktop-cloud",
    port: 0,
    inspectorPort: 0,
    scriptPath: path.join(dir, "worker.mjs"),
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
    bindings: { APP_ENV: "production" },
    outboundService: () => new Response("Network disabled", { status: 503 }),
  });
  Object.assign(options, {
    isolatedResourcePersistencePath: path.join(dir, "isolated"),
    resourcePersistencePath: path.join(dir, "state"),
    unsafeEnableSharedStorage: true,
    unsafeDevRegistryPath: path.join(dir, "registry"),
  });
  const mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = (await readFile(path.join("migrations", name), "utf8")).replace(
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
  const expires = Date.now() + 3600000;
  await db.batch([
    db.prepare(
      "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','fixture','now')",
    ),
    db
      .prepare("INSERT INTO account_sessions VALUES(?, 'alice', ?)")
      .bind(hash(sourceToken), expires),
    db.prepare(
      "INSERT INTO rooms(id,name,owner_id,invite_hash,created_at) VALUES('room-a','A','alice','fixture','now')",
    ),
    db.prepare(
      "INSERT INTO members(room_id,user_id,role,joined_at) VALUES('room-a','alice','owner','now')",
    ),
  ]);
  const request = (route, body, headers = {}) =>
    mf.dispatchFetch("https://online.test" + route, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const issue = (
    body = { roomId: "room-a", challenge: hash(verifier) },
    headers = {},
  ) =>
    request("/api/desktop/handoff", body, {
      Cookie: `qd_session=${sourceToken}`,
      Origin: "https://online.test",
      "X-QD-Account": "alice",
      ...headers,
    });
  const redeem = (ticket, proof = verifier, headers = {}) =>
    request(
      "/api/desktop/handoff/redeem",
      { ticket, verifier: proof },
      { "X-Qingdan-Desktop": "1", ...headers },
    );
  return { db, request, issue, redeem, expires };
}

test("online handoff authorizes the current account and room without revealing a session cookie", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.issue(undefined, { Cookie: "" })).status, 401);
  assert.equal(
    (await f.issue(undefined, { "X-QD-Account": "bob" })).status,
    401,
  );
  assert.equal(
    (await f.issue(undefined, { Origin: "https://foreign.test" })).status,
    403,
  );
  assert.equal(
    (await f.issue({ roomId: "other", challenge: hash(verifier) })).status,
    403,
  );
  const response = await f.issue();
  assert.equal(response.status, 201);
  const grant = await response.json();
  assert.match(grant.ticket, /^[a-f0-9]{64}$/);
  assert.equal(grant.sessionToken, undefined);
  assert.equal(response.headers.get("set-cookie"), null);
  const stored = await f.db
    .prepare("SELECT token_hash FROM desktop_handoffs")
    .first();
  assert.equal(stored.token_hash, hash(grant.ticket));
  const redeemed = await f.redeem(grant.ticket);
  assert.equal(redeemed.status, 200);
  const session = await redeemed.json();
  assert.equal(session.accountId, "alice");
  assert.equal(session.roomId, "room-a");
  assert.notEqual(session.sessionToken, sourceToken);
  assert.ok(session.expiresAt <= f.expires);
  assert.equal(
    (
      await (
        await f.request("/api/session", undefined, {
          Cookie: `qd_session=${session.sessionToken}`,
        })
      ).json()
    ).user.id,
    "alice",
  );
  assert.equal((await f.redeem(grant.ticket)).status, 410);
  assert.equal((await f.request("/api/agent/devices")).status, 503);
});

test("handoff redemption needs the native proof and cannot be called by browser JavaScript", async (t) => {
  const f = await fixture(t);
  const issued = await f.issue();
  assert.equal(issued.status, 201);
  const { ticket } = await issued.json();
  assert.equal((await f.redeem(ticket, "c".repeat(64))).status, 410);
  for (const headers of [
    { Origin: "https://online.test" },
    { "Sec-Fetch-Site": "same-origin" },
    { "X-Qingdan-Desktop": "" },
  ])
    assert.equal((await f.redeem(ticket, verifier, headers)).status, 403);
  const responses = await Promise.all([f.redeem(ticket), f.redeem(ticket)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 410]);
});

test("expired grants, logged-out source sessions and revoked room access cannot create a desktop login", async (t) => {
  const f = await fixture(t);
  for (const mutation of ["expiry", "membership", "logout"]) {
    const response = await f.issue();
    assert.equal(response.status, 201);
    const { ticket } = await response.json();
    if (mutation === "expiry")
      await f.db.prepare("UPDATE desktop_handoffs SET expires_at=0").run();
    if (mutation === "membership")
      await f.db.prepare("DELETE FROM members WHERE user_id='alice'").run();
    if (mutation === "logout")
      await f.db
        .prepare("DELETE FROM account_sessions WHERE token_hash=?")
        .bind(hash(sourceToken))
        .run();
    assert.equal((await f.redeem(ticket)).status, 410);
    if (mutation === "membership")
      await f.db
        .prepare("INSERT INTO members VALUES('room-a','alice','owner','now')")
        .run();
  }
});
