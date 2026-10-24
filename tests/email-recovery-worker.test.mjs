import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { hashPassword } from "../worker/passwords.js";

// Use Wrangler's own runtime so its version matches the deployed compatibility.
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test(
  "真实 Worker / D1 的注册邮箱验证、旧账号补绑、找回和会话撤销",
  { timeout: 45000 },
  async (t) => {
    await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
    const output = await mkdtemp(
      new URL("../.tmp/recovery-worker-", import.meta.url),
    );
    const scriptPath = path.join(output, "worker.mjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("../worker/index.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "neutral",
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: scriptPath,
    });
    const mails = [];
    const waiting = [];
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "email-recovery-test",
        scriptPath,
        modules: true,
        compatibilityDate: "2026-10-19",
        cf: false,
        log: new Log(LogLevel.ERROR),
        d1Databases: ["DB"],
        r2Buckets: ["FILES"],
        durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
        bindings: {
          APP_ENV: "test",
          RESEND_API_KEY: "test-key",
          EMAIL_FROM: "test@example.test",
          EMAIL_CODE_SECRET:
            "test-only-email-signing-secret-over-32-characters",
        },
        outboundService: async (request) => {
          assert.equal(
            request.url,
            "https://api.resend.com/emails",
            "测试不得发出真实网络请求",
          );
          const payload = await request.json();
          mails.push(payload);
          waiting.splice(0).forEach((resolve) => resolve());
          return Response.json({ id: "mock-email" });
        },
      }),
    );
    t.after(async () => {
      await mf.dispose();
      await rm(output, { recursive: true, force: true });
    });
    const db = await mf.getD1Database("DB");
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = (await readFile(new URL(name, migrations), "utf8")).replace(
        /^--.*$/gm,
        "",
      );
      await db.batch(
        sql
          .split(";")
          .filter((s) => s.trim())
          .map((statement) => db.prepare(statement)),
      );
    }
    async function request(route, body, cookie = "", extraHeaders = {}) {
      return mf.dispatchFetch(`https://app.test${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Cookie: cookie,
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }
    async function mailCode(index, email) {
      if (mails.length <= index)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Mock email did not arrive")),
            5000,
          );
          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      assert.deepEqual(mails[index].to, [email]);
      const match = mails[index].text.match(/验证码：\s*(\d{6})/);
      assert.ok(match, "邮件中包含可用于真实确认接口的六位验证码");
      return match[1];
    }
    const credentials = {
      username: "mail_alice",
      password: "original-password-2026",
    };
    const email = "alice@example.test";
    await t.test("未验证邮箱时不创建账号或会话", async () => {
      for (const input of [credentials, { ...credentials, email }]) {
        const rejected = await request("/api/auth/register", input);
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.equal(rejected.headers.get("set-cookie"), null);
      }
      assert.equal(
        await db.prepare("SELECT COUNT(*) FROM accounts").first("COUNT(*)"),
        0,
      );
      assert.equal(
        await db
          .prepare("SELECT COUNT(*) FROM account_sessions")
          .first("COUNT(*)"),
        0,
      );
    });
    const registrationRequest = await request("/api/auth/register/request", {
      username: credentials.username,
      email,
    });
    assert.equal(
      registrationRequest.status,
      202,
      await registrationRequest.clone().text(),
    );
    assert.equal(registrationRequest.headers.get("set-cookie"), null);
    const registration = await registrationRequest.json();
    assert.equal(registration.retryAfter, 60);
    assert.match(registration.challengeId, /^[a-f0-9]{64}$/);
    assert.equal(typeof registration.message, "string");
    assert.equal("code" in registration, false);
    const registrationCode = await mailCode(0, email);
    assert.equal(
      await db.prepare("SELECT COUNT(*) FROM accounts").first("COUNT(*)"),
      0,
      "发送注册邮件不能预先创建账号",
    );
    const registered = await request("/api/auth/register", {
      ...credentials,
      email,
      challengeId: registration.challengeId,
      code: registrationCode,
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const cookie = registered.headers.get("set-cookie").split(";")[0];
    const user = (await registered.json()).user;
    assert.equal("email" in user, false, "邮箱不得混入协作者公开用户信息");
    assert.deepEqual(
      await (await request("/api/profile/email", undefined, cookie)).json(),
      { email, available: true },
      "注册成功时邮箱已经验证，无需再进入设置绑定",
    );
    assert.equal(
      (await (await request("/api/session", undefined, cookie)).json()).user.id,
      user.id,
    );

    let currentCookie;
    const nextPassword = "new-password-2026";
    await t.test("注册邮箱可直接找回密码，并撤销全部旧会话", async () => {
      const resetIdentity = { username: credentials.username, email };
      assert.equal(
        (await request("/api/auth/password-reset/request", resetIdentity))
          .status,
        429,
        "注册和找回邮件共享发送冷却时间",
      );
      // Advance the shared send limits instead of waiting a real minute.
      await db.prepare("UPDATE auth_limits SET reset_at=0").run();
      const sent = await request(
        "/api/auth/password-reset/request",
        resetIdentity,
      );
      assert.equal(sent.status, 202, await sent.clone().text());
      const reset = await sent.json();
      const resetInput = {
        ...resetIdentity,
        challengeId: reset.challengeId,
        code: await mailCode(1, email),
        password: nextPassword,
      };
      const responses = await Promise.all([
        request("/api/auth/password-reset/confirm", resetInput),
        request("/api/auth/password-reset/confirm", resetInput),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
      assert.equal(
        (await (await request("/api/session", undefined, cookie)).json()).user,
        null,
      );
      assert.equal((await request("/api/auth/login", credentials)).status, 401);
      const loggedIn = await request("/api/auth/login", {
        ...credentials,
        password: nextPassword,
      });
      assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
      assert.equal((await loggedIn.json()).user.id, user.id);
      currentCookie = loggedIn.headers.get("set-cookie").split(";")[0];
    });

    const changedEmail = "alice-updated@example.test";
    assert.equal((await request("/api/profile/email")).status, 401);
    assert.equal(
      (
        await request("/api/profile/email", undefined, currentCookie, {
          "X-QD-Account": "another-account",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/profile/email/request",
          {
            email: changedEmail,
            currentPassword: nextPassword,
          },
          currentCookie,
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/profile/email/request",
          { email: changedEmail, currentPassword: "wrong" },
          currentCookie,
        )
      ).status,
      400,
    );
    await db.prepare("UPDATE auth_limits SET reset_at=0").run();
    const bind = await request(
      "/api/profile/email/request",
      { email: changedEmail, currentPassword: nextPassword },
      currentCookie,
    );
    assert.equal(bind.status, 200, await bind.clone().text());
    const challengeId = (await bind.json()).challengeId;
    const code = await mailCode(2, changedEmail);
    const confirmed = await request(
      "/api/profile/email/confirm",
      { email: changedEmail, challengeId, code },
      currentCookie,
    );
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    assert.deepEqual(
      await (
        await request("/api/profile/email", undefined, currentCookie)
      ).json(),
      { email: changedEmail, available: true },
    );

    await t.test("没有邮箱的旧账号仍可登录、补绑并找回密码", async () => {
      const legacy = {
        username: "legacy_mail_user",
        password: "legacy-password-2026",
      };
      await db
        .prepare(
          "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(
          "legacy-mail-account",
          legacy.username,
          "原有账号",
          await hashPassword(legacy.password),
          new Date().toISOString(),
        )
        .run();
      const login = await request("/api/auth/login", legacy);
      assert.equal(login.status, 200, await login.clone().text());
      const legacyCookie = login.headers.get("set-cookie").split(";")[0];
      assert.deepEqual(
        await (
          await request("/api/profile/email", undefined, legacyCookie)
        ).json(),
        { email: null, available: true },
      );
      const legacyEmail = "legacy@example.test";
      const sent = await request(
        "/api/profile/email/request",
        { email: legacyEmail, currentPassword: legacy.password },
        legacyCookie,
      );
      assert.equal(sent.status, 200, await sent.clone().text());
      const challenge = await sent.json();
      const bound = await request(
        "/api/profile/email/confirm",
        {
          email: legacyEmail,
          challengeId: challenge.challengeId,
          code: await mailCode(3, legacyEmail),
        },
        legacyCookie,
      );
      assert.equal(bound.status, 200, await bound.clone().text());
      await db.prepare("UPDATE auth_limits SET reset_at=0").run();
      const recovery = await request("/api/auth/password-reset/request", {
        username: legacy.username,
        email: legacyEmail,
      });
      assert.equal(recovery.status, 202, await recovery.clone().text());
      const resetChallenge = await recovery.json();
      const password = "legacy-recovered-password-2026";
      const reset = await request("/api/auth/password-reset/confirm", {
        username: legacy.username,
        email: legacyEmail,
        challengeId: resetChallenge.challengeId,
        code: await mailCode(4, legacyEmail),
        password,
      });
      assert.equal(reset.status, 200, await reset.clone().text());
      assert.equal(
        (await (await request("/api/session", undefined, legacyCookie)).json())
          .user,
        null,
      );
      assert.equal((await request("/api/auth/login", legacy)).status, 401);
      const recovered = await request("/api/auth/login", {
        ...legacy,
        password,
      });
      assert.equal(recovered.status, 200, await recovered.clone().text());
      assert.equal((await recovered.json()).user.id, "legacy-mail-account");
    });
  },
);
