import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { hashPassword, verifyPassword } from "../worker/passwords.js";

await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/registration-email-", import.meta.url),
);
await build({
  entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // Node cannot load the Workerd-only base class. These auth routes never
  // instantiate a room; real Durable Object behavior stays in integration tests.
  plugins: [
    {
      name: "workerd-base",
      setup(build) {
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "base",
          namespace: "workerd-base",
        }));
        build.onLoad({ filter: /.*/, namespace: "workerd-base" }, () => ({
          contents: "export class DurableObject {}",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "worker.mjs"),
});
const { default: worker } = await import(
  pathToFileURL(path.join(output, "worker.mjs"))
);
after(() => rm(output, { recursive: true, force: true }));
const password = "Registration-password-1234";
const oldHash = await hashPassword(password);

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  t.after(() => sqlite.close());
  const migrations = new URL("../migrations/", import.meta.url);
  for (const filename of (await readdir(migrations))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile(new URL(filename, migrations), "utf8"));
  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    async first() {
      return sqlite.prepare(this.sql).get(...this.params) || null;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...this.params) };
    }
    async run() {
      return {
        success: true,
        meta: {
          changes: Number(sqlite.prepare(this.sql).run(...this.params).changes),
        },
      };
    }
  }
  let beforeBatch;
  const env = {
    APP_ENV: "test",
    RESEND_API_KEY: "local-test-only",
    EMAIL_FROM: "轻单 <noreply@example.test>",
    EMAIL_CODE_SECRET: "local-test-only-secret-with-at-least-32-characters",
    DB: {
      prepare: (sql) => new Statement(sql),
      async batch(statements) {
        const hook = beforeBatch;
        beforeBatch = undefined;
        hook?.();
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((s) => ({
            success: true,
            meta: {
              changes: Number(sqlite.prepare(s.sql).run(...s.params).changes),
            },
          }));
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const deliveries = [],
    logs = [];
  let failDelivery = false;
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    deliveries.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "mock-only" }), {
      status: failDelivery ? 503 : 200,
    });
  });
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  async function call(endpoint, input, cookie = "", method = "POST") {
    const response = await worker.fetch(
      new Request(`https://app.test${endpoint}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "127.0.0.1",
          Cookie: cookie,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
      }),
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const clearLimits = () => sqlite.exec("UPDATE auth_limits SET reset_at=0");
  async function proof(username = "alice", email = "alice@example.test") {
    const sent = await call("/api/auth/register/request", { username, email });
    assert.equal(sent.status, 202, JSON.stringify(sent.data));
    return {
      username,
      email,
      challengeId: sent.data.challengeId,
      code: deliveries.at(-1).text.match(/验证码：\s*(\d{6})/)[1],
      password,
    };
  }
  const count = (table) =>
    sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  function seed(username = "old_user", email = null) {
    sqlite
      .prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at,email,email_verified_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        username,
        username,
        username,
        oldHash,
        new Date().toISOString(),
        email,
        email ? Date.now() : null,
      );
  }
  return {
    sqlite,
    env,
    deliveries,
    logs,
    call,
    proof,
    count,
    clearLimits,
    seed,
    beforeBatch: (hook) => {
      beforeBatch = hook;
    },
    failDelivery: () => {
      failDelivery = true;
    },
  };
}

test("注册必须提交邮箱和验证码，不能通过旧接口创建未验证账号", async (t) => {
  const f = await fixture(t);
  const input = { username: "alice", password };
  for (const body of [
    input,
    { ...input, email: "alice@example.test" },
    {
      ...input,
      email: "alice@example.test",
      code: "123456",
      challengeId: "0".repeat(64),
    },
  ]) {
    const result = await f.call("/api/auth/register", body);
    assert.equal(result.status, 400);
    assert.equal(result.cookie, undefined);
  }
  assert.equal(f.count("accounts"), 0);
  assert.equal(f.count("account_sessions"), 0);
});

test("发送不创建账号，验证码验证后一次创建已绑定邮箱的账号和会话", async (t) => {
  const f = await fixture(t);
  const proof = await f.proof("ALICE", " Alice@Example.test ");
  assert.equal(f.count("accounts"), 0);
  assert.equal(f.count("account_sessions"), 0);
  const challenge = f.sqlite
    .prepare("SELECT * FROM registration_challenges WHERE id=?")
    .get(proof.challengeId);
  assert.equal(challenge.username, "alice");
  assert.equal(challenge.email, "alice@example.test");
  assert.equal(
    challenge.code_hash,
    createHmac("sha256", f.env.EMAIL_CODE_SECRET)
      .update(
        JSON.stringify([
          proof.challengeId,
          "alice",
          "register",
          "alice@example.test",
          proof.code,
        ]),
      )
      .digest("hex"),
  );
  assert.ok(!JSON.stringify(challenge).includes(`"${proof.code}"`));
  assert.match(f.deliveries[0].subject, /注册/);
  const result = await f.call("/api/auth/register", {
    ...proof,
    name: "Alice",
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.ok(result.cookie);
  const account = f.sqlite
    .prepare("SELECT * FROM accounts WHERE username='alice'")
    .get();
  assert.equal(account.email, "alice@example.test");
  assert.ok(account.email_verified_at > 0);
  assert.ok(await verifyPassword(password, account.password_hash));
  assert.equal(f.count("account_sessions"), 1);
  const profile = await f.call(
    "/api/profile/email",
    undefined,
    result.cookie,
    "GET",
  );
  assert.equal(profile.data.email, "alice@example.test");
  const replay = await f.call("/api/auth/register", proof);
  assert.notEqual(replay.status, 201);
  assert.equal(f.count("accounts"), 1);
  assert.equal(f.count("account_sessions"), 1);
});

test("验证码绑定用户名与邮箱，错误尝试最多五次，过期与重发旧码失效", async (t) => {
  const f = await fixture(t);
  const proof = await f.proof();
  for (const input of [
    { ...proof, username: "other" },
    { ...proof, email: "other@example.test" },
    { ...proof, code: "123" },
  ])
    assert.equal((await f.call("/api/auth/register", input)).status, 400);
  const wrong = proof.code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.call("/api/auth/register", { ...proof, code: wrong })).status,
      400,
    );
  assert.equal((await f.call("/api/auth/register", proof)).status, 400);
  assert.equal(
    f.sqlite
      .prepare("SELECT attempts FROM registration_challenges WHERE id=?")
      .get(proof.challengeId).attempts,
    5,
  );
  f.clearLimits();
  const fresh = await f.proof();
  assert.equal((await f.call("/api/auth/register", proof)).status, 400);
  f.sqlite
    .prepare("UPDATE registration_challenges SET expires_at=0 WHERE id=?")
    .run(fresh.challengeId);
  assert.equal((await f.call("/api/auth/register", fresh)).status, 400);
  assert.equal(f.count("accounts"), 0);
});

test("发送限流与重复邮箱保持一致响应，不泄露邮箱绑定状态或发送重复注册邮件", async (t) => {
  const f = await fixture(t);
  const request = { username: "alice", email: "alice@example.test" };
  const available = await f.call("/api/auth/register/request", request);
  assert.equal(available.status, 202);
  assert.equal(available.data.retryAfter, 60);
  assert.equal(available.data.code, undefined);
  assert.equal(
    (await f.call("/api/auth/register/request", request)).status,
    429,
  );
  f.seed("old_user", "used@example.test");
  f.clearLimits();
  const used = await f.call("/api/auth/register/request", {
    username: "new_user",
    email: "used@example.test",
  });
  assert.equal(used.status, available.status);
  assert.deepEqual(
    Object.keys(used.data).sort(),
    Object.keys(available.data).sort(),
  );
  assert.equal(used.data.message, available.data.message);
  assert.equal(used.data.retryAfter, available.data.retryAfter);
  assert.match(used.data.challengeId, /^[a-f0-9]{64}$/);
  assert.equal(f.deliveries.length, 1);
});

test("同一注册验证码并发提交只创建一个账号和一个会话", async (t) => {
  const f = await fixture(t);
  const proof = await f.proof();
  const results = await Promise.all([
    f.call("/api/auth/register", proof),
    f.call("/api/auth/register", proof),
  ]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(f.count("accounts"), 1);
  assert.equal(f.count("account_sessions"), 1);
});

test("验证码在事务前失效时不认领或删除旧访客身份，重新验证才可迁移", async (t) => {
  const f = await fixture(t);
  const { createHash } = await import("node:crypto");
  const raw = "a".repeat(64);
  const hash = createHash("sha256").update(raw).digest("hex");
  f.sqlite
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(hash, "legacy-owner", "旧访客", Date.now() + 86400000);
  const proof = await f.proof();
  f.beforeBatch(() =>
    f.sqlite
      .prepare("DELETE FROM registration_challenges WHERE id=?")
      .run(proof.challengeId),
  );
  const failed = await f.call(
    "/api/auth/register",
    { ...proof, claimLegacy: true },
    `qd_session=${raw}`,
  );
  assert.equal(failed.status, 400);
  assert.equal(f.count("accounts"), 0);
  assert.equal(f.count("legacy_claims"), 0);
  assert.equal(f.count("sessions"), 1);
  assert.equal(f.count("account_sessions"), 0);
  f.clearLimits();
  const fresh = await f.proof();
  const result = await f.call(
    "/api/auth/register",
    { ...fresh, claimLegacy: true },
    `qd_session=${raw}`,
  );
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.user.id, "legacy-owner");
  assert.equal(f.count("sessions"), 0);
  assert.equal(f.count("legacy_claims"), 1);
});

test("验证码发出后邮箱被占用时，注册事务回滚且不创建会话", async (t) => {
  const f = await fixture(t);
  const proof = await f.proof();
  f.seed("old_user", proof.email);
  const result = await f.call("/api/auth/register", proof);
  assert.equal(result.status, 409);
  assert.equal(result.cookie, undefined);
  assert.equal(f.count("accounts"), 1);
  assert.equal(f.count("account_sessions"), 0);
  assert.equal(
    f.sqlite
      .prepare("SELECT consumed_by FROM registration_challenges WHERE id=?")
      .get(proof.challengeId).consumed_by,
    null,
  );
});

test("发信失败使验证码失效，未配置邮件不能注册，旧账号仍能登录", async (t) => {
  const f = await fixture(t);
  f.failDelivery();
  const sent = await f.call("/api/auth/register/request", {
    username: "alice",
    email: "alice@example.test",
  });
  assert.equal(sent.status, 202);
  assert.equal(f.count("registration_challenges"), 0);
  assert.equal(f.count("accounts"), 0);
  assert.ok(!JSON.stringify(f.logs).includes("alice@example.test"));
  f.env.RESEND_API_KEY = "";
  assert.equal(
    (
      await f.call("/api/auth/register/request", {
        username: "alice",
        email: "alice@example.test",
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await f.call("/api/auth/register", {
        username: "alice",
        email: "alice@example.test",
        password,
      })
    ).status,
    503,
  );
  f.seed();
  const loggedIn = await f.call("/api/auth/login", {
    username: "old_user",
    password,
  });
  assert.equal(loggedIn.status, 200);
  assert.ok(loggedIn.cookie);
});
