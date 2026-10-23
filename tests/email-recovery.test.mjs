import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { hashPassword, verifyPassword } from "../worker/passwords.js";

await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/email-recovery-", import.meta.url),
);
await build({
  entryPoints: [
    fileURLToPath(new URL("../worker/email-recovery.ts", import.meta.url)),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: path.join(output, "worker.mjs"),
});
const { passwordResetEndpoint, emailProfileEndpoint } = await import(
  pathToFileURL(path.join(output, "worker.mjs"))
);
after(() => rm(output, { recursive: true, force: true }));
const password = "Initial-password-1234";
const nextPassword = "New-password-5678";
const initialHash = await hashPassword(password);

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
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
      const result = sqlite.prepare(this.sql).run(...this.params);
      return {
        success: true,
        meta: { changes: Number(result.changes) },
        results: [],
      };
    }
  }
  const queries = [];
  const env = {
    APP_ENV: "test",
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "轻单 <no-reply@example.test>",
    EMAIL_CODE_SECRET: "local-test-only-secret-with-more-than-32-characters",
    DB: {
      prepare: (sql) => {
        queries.push(sql);
        return new Statement(sql);
      },
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          // D1 batches are atomic: execute all statements before yielding.
          const results = statements.map((statement) => {
            const result = sqlite
              .prepare(statement.sql)
              .run(...statement.params);
            return { success: true, meta: { changes: Number(result.changes) } };
          });
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  for (const id of ["alice", "bob"])
    sqlite
      .prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, id, id, initialHash, new Date().toISOString());
  const deliveries = [];
  let deliveryFails = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    const payload = JSON.parse(options.body);
    deliveries.push(payload);
    return new Response(
      JSON.stringify(
        deliveryFails
          ? { message: "provider detail that must not leak" }
          : { id: "sent" },
      ),
      { status: deliveryFails ? 503 : 200 },
    );
  });
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  async function call(kind, action, input, userId = "alice", method = "POST") {
    const request = new Request(`https://app.test/api/${kind}/${action}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "127.0.0.1",
        "X-QD-Account": userId,
      },
      ...(method !== "GET" ? { body: JSON.stringify(input) } : {}),
    });
    let response;
    try {
      response =
        kind === "reset"
          ? await passwordResetEndpoint(request, env, action, ctx)
          : await emailProfileEndpoint(
              request,
              env,
              { id: userId, username: userId },
              action,
            );
    } catch (error) {
      response = Response.json(
        { error: error.message },
        { status: error.status || 500 },
      );
    }
    await Promise.all(pending.splice(0));
    return { status: response.status, data: await response.json() };
  }
  const clearLimits = () => sqlite.exec("UPDATE auth_limits SET reset_at=0");
  const code = () => deliveries.at(-1).text.match(/验证码：\s*(\d{6})/)[1];
  async function bind(userId = "alice", email = `${userId}@example.test`) {
    clearLimits();
    const sent = await call(
      "email",
      "request",
      { email, currentPassword: password },
      userId,
    );
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const confirmed = await call(
      "email",
      "confirm",
      { email, challengeId: sent.data.challengeId, code: code() },
      userId,
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    clearLimits();
    return email;
  }
  async function reset(email = "alice@example.test") {
    const sent = await call("reset", "request", { username: "alice", email });
    assert.equal(sent.status, 202, JSON.stringify(sent.data));
    return {
      username: "alice",
      email,
      challengeId: sent.data.challengeId,
      code: code(),
      password: nextPassword,
    };
  }
  return {
    queries,
    env,
    sqlite,
    call,
    bind,
    reset,
    deliveries,
    code,
    clearLimits,
    failDelivery: () => {
      deliveryFails = true;
    },
  };
}

test("只有当前密码及邮箱验证码验证成功才绑定邮箱；邮箱只对本人资料接口返回", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call("email", "", null, "alice", "GET")).data, {
    email: null,
    available: true,
  });
  assert.equal(
    (
      await f.call("email", "request", {
        email: "alice@example.test",
        currentPassword: "wrong",
      })
    ).status,
    400,
    "密码输错不能触发客户端退出登录",
  );
  assert.equal(f.deliveries.length, 0);
  const sent = await f.call("email", "request", {
    email: " Alice@Example.Test ",
    currentPassword: password,
  });
  assert.equal(sent.status, 200);
  assert.equal(
    (await f.call("email", "", null, "alice", "GET")).data.email,
    null,
  );
  assert.equal(Object.values(sent.data).includes(f.code()), false);
  const challenge = f.sqlite
    .prepare("SELECT * FROM email_challenges WHERE id=?")
    .get(sent.data.challengeId);
  assert.notEqual(challenge.code_hash, f.code());
  const input = {
    email: "alice@example.test",
    challengeId: sent.data.challengeId,
    code: f.code(),
  };
  assert.equal((await f.call("email", "confirm", input, "bob")).status, 400);
  assert.equal((await f.call("email", "confirm", input)).status, 200);
  assert.equal(
    (await f.call("email", "", null, "alice", "GET")).data.email,
    "alice@example.test",
  );
  assert.equal((await f.call("email", "confirm", input)).status, 400);
});

test("找回密码需要已验证邮箱，重置后旧密码及全部旧会话失效，验证码不可重用", async (t) => {
  const f = await fixture(t);
  await f.bind();
  f.sqlite
    .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
    .run("session-a", "alice", Date.now() + 10000);
  const input = await f.reset();
  assert.equal((await f.call("reset", "confirm", input)).status, 200);
  const account = f.sqlite
    .prepare("SELECT * FROM accounts WHERE id='alice'")
    .get();
  assert.equal(await verifyPassword(nextPassword, account.password_hash), true);
  assert.equal(await verifyPassword(password, account.password_hash), false);
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT count(*) AS n FROM account_sessions WHERE account_id='alice'",
      )
      .get().n,
    0,
  );
  assert.equal((await f.call("reset", "confirm", input)).status, 400);
});

test("不存在账号、未绑定邮箱、邮箱不匹配的请求返回相同结构且不发送邮件", async (t) => {
  const f = await fixture(t);
  const a = await f.call("reset", "request", {
    username: "unknown",
    email: "unknown@example.test",
  });
  const b = await f.call("reset", "request", {
    username: "alice",
    email: "alice@example.test",
  });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(
    { ...a.data, challengeId: "id" },
    { ...b.data, challengeId: "id" },
  );
  assert.equal(f.deliveries.length, 0);
});

test("找回确认对匹配和不匹配身份执行相同的数据库查询，避免提前返回泄露绑定关系", async (t) => {
  const f = await fixture(t);
  await f.bind();
  const input = {
    username: "alice",
    email: "alice@example.test",
    challengeId: "f".repeat(64),
    code: "123456",
    password: nextPassword,
  };
  f.queries.length = 0;
  const matched = await f.call("reset", "confirm", input);
  const matchedQueries = [...f.queries];
  f.queries.length = 0;
  const missing = await f.call("reset", "confirm", {
    ...input,
    email: "other@example.test",
  });
  assert.deepEqual(matched, missing);
  assert.deepEqual(
    f.queries,
    matchedQueries,
    "无论身份是否匹配都应走验证码查询路径",
  );
});

test("错误验证码最多尝试五次，过期验证码及重新发送前的验证码失效", async (t) => {
  const f = await fixture(t);
  await f.bind();
  const input = await f.reset();
  const wrong = input.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.call("reset", "confirm", { ...input, code: wrong })).status,
      400,
    );
  assert.equal((await f.call("reset", "confirm", input)).status, 400);
  f.clearLimits();
  const expired = await f.reset();
  f.sqlite
    .prepare("UPDATE email_challenges SET expires_at=0 WHERE id=?")
    .run(expired.challengeId);
  assert.equal((await f.call("reset", "confirm", expired)).status, 400);
  f.clearLimits();
  const old = await f.reset();
  assert.equal(
    (await f.call("reset", "request", { username: "alice", email: old.email }))
      .status,
    429,
  );
  f.clearLimits();
  const current = await f.reset();
  assert.equal((await f.call("reset", "confirm", old)).status, 400);
  assert.equal((await f.call("reset", "confirm", current)).status, 200);
});

test("同一验证码并发提交只成功一次，已正常修改密码后旧找回码也失效", async (t) => {
  const f = await fixture(t);
  await f.bind();
  const input = await f.reset();
  const results = await Promise.all([
    f.call("reset", "confirm", input),
    f.call("reset", "confirm", input),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  f.clearLimits();
  const previous = await f.reset();
  f.sqlite
    .prepare("UPDATE accounts SET password_hash=? WHERE id='alice'")
    .run(await hashPassword("Another-password-1234"));
  assert.equal((await f.call("reset", "confirm", previous)).status, 400);
});

test("邮箱被他人绑定时保留原邮箱；改绑后发给旧邮箱的找回码不可使用", async (t) => {
  const f = await fixture(t);
  await f.bind();
  await f.bind("bob");
  const oldReset = await f.reset();
  f.clearLimits();
  const sent = await f.call("email", "request", {
    email: "bob@example.test",
    currentPassword: password,
  });
  if (sent.status === 200) {
    const result = await f.call("email", "confirm", {
      email: "bob@example.test",
      code: f.code(),
      challengeId: sent.data.challengeId,
    });
    assert.equal(result.status, 409);
  } else assert.equal(sent.status, 409);
  assert.equal(
    (await f.call("email", "", null, "alice", "GET")).data.email,
    "alice@example.test",
  );
  await f.bind("alice", "new@example.test");
  assert.equal((await f.call("reset", "confirm", oldReset)).status, 400);
});

test("邮件配置缺失时明确失败，供应商错误不泄露详情或留下可用验证码", async (t) => {
  const f = await fixture(t);
  delete f.env.RESEND_API_KEY;
  assert.equal(
    (await f.call("email", "", null, "alice", "GET")).data.available,
    false,
  );
  assert.equal(
    (
      await f.call("reset", "request", {
        username: "alice",
        email: "alice@example.test",
      })
    ).status,
    503,
  );
  f.env.RESEND_API_KEY = "test-resend-key";
  f.failDelivery();
  const sent = await f.call("email", "request", {
    email: "alice@example.test",
    currentPassword: password,
  });
  assert.equal(sent.status, 503);
  assert.equal(JSON.stringify(sent.data).includes("provider detail"), false);
  assert.equal(
    f.sqlite.prepare("SELECT count(*) AS n FROM email_challenges").get().n,
    0,
  );
});

test("找回邮件投递失败仍返回统一结果，并撤销未送达的验证码", async (t) => {
  const f = await fixture(t);
  await f.bind();
  f.failDelivery();
  const messages = [];
  t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
  const input = await f.reset();
  assert.equal((await f.call("reset", "confirm", input)).status, 400);
  assert.deepEqual(messages, ["Password recovery email delivery failed"]);
  assert.equal(
    f.sqlite
      .prepare("SELECT count(*) AS n FROM email_challenges WHERE id=?")
      .get(input.challengeId).n,
    0,
  );
});
