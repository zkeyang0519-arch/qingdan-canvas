import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

// Use Wrangler's own runtime so its version matches the deployed compatibility.
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test(
  "真实 Worker / D1 的邮箱绑定、找回路由、身份隔离和旧会话撤销",
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
    const credentials = {
      username: "mail_alice",
      password: "original-password-2026",
    };
    const registered = await request("/api/auth/register", credentials);
    assert.equal(registered.status, 201, await registered.clone().text());
    const cookie = registered.headers.get("set-cookie").split(";")[0];
    const user = (await registered.json()).user;
    assert.equal("email" in user, false, "邮箱不得混入协作者公开用户信息");
    assert.equal((await request("/api/profile/email")).status, 401);
    assert.equal(
      (
        await request("/api/profile/email", undefined, cookie, {
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
            email: "alice@example.test",
            currentPassword: credentials.password,
          },
          cookie,
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/profile/email/request",
          { email: "alice@example.test", currentPassword: "wrong" },
          cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (await (await request("/api/session", undefined, cookie)).json()).user.id,
      user.id,
    );
    const bind = await request(
      "/api/profile/email/request",
      { email: "alice@example.test", currentPassword: credentials.password },
      cookie,
    );
    assert.equal(bind.status, 200, await bind.clone().text());
    const challengeId = (await bind.json()).challengeId;
    assert.equal(mails.length, 1);
    const code = mails[0].text.match(/验证码：\s*(\d{6})/)[1];
    const confirmed = await request(
      "/api/profile/email/confirm",
      { email: "alice@example.test", challengeId, code },
      cookie,
    );
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    assert.deepEqual(
      await (await request("/api/profile/email", undefined, cookie)).json(),
      { email: "alice@example.test", available: true },
    );
    await db.prepare("UPDATE auth_limits SET reset_at=0").run();
    const sent = await request("/api/auth/password-reset/request", {
      username: credentials.username,
      email: "alice@example.test",
    });
    assert.equal(sent.status, 202, await sent.clone().text());
    const reset = await sent.json();
    if (mails.length < 2)
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
    const resetInput = {
      username: credentials.username,
      email: "alice@example.test",
      challengeId: reset.challengeId,
      code: mails[1].text.match(/验证码：\s*(\d{6})/)[1],
      password: "new-password-2026",
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
      password: resetInput.password,
    });
    assert.equal(loggedIn.status, 200);
    assert.equal((await loggedIn.json()).user.id, user.id);
  },
);
