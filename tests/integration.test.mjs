import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createObject, makeBlock } from "../src/canvas/model.js";
import { sharedObject } from "../shared/canvas-contract.js";

const cli = new URL(
  "../node_modules/wrangler/bin/wrangler.js",
  import.meta.url,
);
const root = new URL("..", import.meta.url);
function command(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [cli.pathname.replace(/^\/([A-Z]:)/, "$1"), ...args],
      {
        cwd: root,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        windowsHide: true,
      },
    );
    let output = "";
    proc.stdout.on("data", (d) => (output += d));
    proc.stderr.on("data", (d) => (output += d));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function socket(url, cookie, authors = true) {
  if (authors) {
    const capable = new URL(url);
    capable.searchParams.set("authors", "1");
    url = capable.href;
  }
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: { Cookie: cookie, Origin: new URL(url).origin },
  });
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    messages,
    send: (data) => ws.send(JSON.stringify(data)),
    async next(predicate) {
      for (let i = 0; i < 100; i++) {
        const at = messages.findIndex(predicate);
        if (at !== -1) return messages.splice(at, 1)[0];
        await delay(40);
      }
      throw Error(
        "Timed out awaiting socket message: " + JSON.stringify(messages),
      );
    },
  };
}
test(
  "真实 Worker / D1 / R2 / DO 协作和权限",
  { timeout: 120000 },
  async (t) => {
    await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
    const state = await mkdtemp(
      new URL("../.tmp/integration-", import.meta.url).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
    );
    await mkdir(new URL("../dist", import.meta.url), { recursive: true });
    try {
      await readFile(new URL("../dist/index.html", import.meta.url));
    } catch {
      await writeFile(
        new URL("../dist/index.html", import.meta.url),
        "<h1>Test</h1>",
      );
    }
    await command([
      "d1",
      "migrations",
      "apply",
      "qingdan-canvas",
      "--local",
      "--persist-to",
      state,
    ]);
    const legacyRaw = randomBytes(32).toString("hex");
    const legacyLoginRaw = randomBytes(32).toString("hex");
    const expiredRaw = randomBytes(32).toString("hex");
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    const emailSecret =
      "integration-test-email-signing-secret-over-32-characters";
    const registrations = new Map(
      ["甲", "乙", "路人", "原访客", "验证"].map((name) => {
        const username =
          name === "原访客"
            ? "legacy_owner"
            : `user_${crypto.randomUUID().slice(0, 16)}`;
        return [
          name,
          {
            name,
            username,
            password: "Qd-test-9",
            email: `${username}@example.test`,
            challengeId: randomBytes(32).toString("hex"),
            code: "123456",
          },
        ];
      }),
    );
    // This suite confirms signed fixtures through the real registration route.
    // Email delivery itself is covered by email-recovery-worker.test.mjs.
    const registrationFixtures = [...registrations.values()]
      .map(({ username, email, challengeId, code }) => {
        const hash = createHmac("sha256", emailSecret)
          .update(
            JSON.stringify([challengeId, username, "register", email, code]),
          )
          .digest("hex");
        return `INSERT INTO registration_challenges(id,username,email,code_hash,expires_at) VALUES('${challengeId}','${username}','${email}','${hash}',${Date.now() + 10 * 60 * 1000});`;
      })
      .join("\n");
    const fixture = `${state}/legacy.sql`;
    await writeFile(
      fixture,
      `
      INSERT INTO sessions VALUES('${sha(legacyRaw)}','legacy-owner','原访客',${Date.now() + 86400000});
      INSERT INTO sessions VALUES('${sha(legacyLoginRaw)}','legacy-login','另一访客',${Date.now() + 86400000});
      INSERT INTO sessions VALUES('${sha(expiredRaw)}','expired-visitor','过期访客',${Date.now() - 1000});
      INSERT INTO rooms VALUES('legacy-room','原有画布','legacy-owner','${sha("legacy-invite")}',datetime('now'));
      INSERT INTO members VALUES('legacy-room','legacy-owner','owner',datetime('now'));
      INSERT INTO rooms VALUES('legacy-login-room','待迁移画布','legacy-login','${sha("legacy-login-invite")}',datetime('now'));
      INSERT INTO members VALUES('legacy-login-room','legacy-login','owner',datetime('now'));
      ${registrationFixtures}
    `,
    );
    await command([
      "d1",
      "execute",
      "qingdan-canvas",
      "--local",
      "--persist-to",
      state,
      "--file",
      fixture,
    ]);
    const testEnv = path.join(state, "registration.env");
    await writeFile(
      testEnv,
      [
        "APP_ENV=production",
        "RESEND_API_KEY=integration-test-no-delivery",
        "EMAIL_FROM=integration@example.test",
        `EMAIL_CODE_SECRET=${emailSecret}`,
      ].join("\n"),
    );
    const port = await freePort(),
      base = `http://127.0.0.1:${port}`;
    let proc,
      log = "";
    const start = async () => {
      proc = spawn(
        process.execPath,
        [
          cli.pathname.replace(/^\/([A-Z]:)/, "$1"),
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--persist-to",
          state,
          "--var",
          "APP_ENV:production",
          "--env-file",
          testEnv,
          "--inspector-port",
          "0",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: "false",
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
          },
          windowsHide: true,
        },
      );
      proc.stdout.on("data", (d) => (log += d));
      proc.stderr.on("data", (d) => (log += d));
      for (let i = 0; i < 180; i++) {
        try {
          await fetch(base + "/api/health");
          return;
        } catch {}
        if (proc.exitCode !== null) throw Error(log);
        await delay(100);
      }
      throw Error(log);
    };
    const stop = async () => {
      if (
        proc &&
        proc.exitCode === null &&
        proc.signalCode === null &&
        !proc.killed
      ) {
        const exiting = new Promise((resolve) => proc.once("exit", resolve));
        proc.kill();
        await exiting;
        await delay(300);
      }
    };
    t.after(async () => {
      await stop();
      await writeFile(state + "/test-runtime.log", log);
    });
    await start();
    const credentials = new Map();
    async function session(name) {
      const input = registrations.get(name);
      const response = await fetch(base + "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 201, await response.clone().text());
      credentials.set(name, { ...input, user: (await response.json()).user });
      assert.match(
        response.headers.get("set-cookie"),
        /HttpOnly; SameSite=Lax/,
      );
      return response.headers.get("set-cookie").split(";")[0];
    }
    const a = await session("甲"),
      b = await session("乙"),
      outsider = await session("路人");
    const request = (path, cookie, method = "GET", body) =>
      fetch(base + path, {
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    await t.test("常用清单保存在个人账号，可跨登录会话读取且不会泄露给其他账号", async () => {
      const path = "/api/profile/quick-tasks";
      assert.equal((await request(path, "")).status, 401);
      const created = await request(path, a, "POST", { id: "lunch", text: "中午12点吃饭" });
      assert.equal(created.status, 200, await created.clone().text());
      const stored = (await created.json()).items;
      assert.equal(stored[0].text, "中午12点吃饭");
      assert.ok(Number.isFinite(Date.parse(stored[0].createdAt)));
      assert.deepEqual((await (await request(path, b)).json()).items, []);
      const secondLogin = await request("/api/auth/login", "", "POST", credentials.get("甲"));
      assert.equal(secondLogin.status, 200);
      const otherDevice = secondLogin.headers.get("set-cookie").split(";")[0];
      assert.deepEqual((await (await request(path, otherDevice)).json()).items, stored);
      assert.equal((await fetch(base + path, { headers: { Cookie: b, "X-QD-Account": credentials.get("甲").user.id } })).status, 401);
      await request(path + "/lunch", b, "DELETE");
      assert.deepEqual((await (await request(path, a)).json()).items, stored);
      const repeated = await request(path, a, "POST", { id: "lunch", text: "中午12点吃饭" });
      assert.deepEqual((await repeated.json()).items, stored);
      assert.equal((await request(path, a, "POST", { text: "  " })).status, 400);
      assert.equal((await request(path, a, "POST", { text: "x".repeat(2001) })).status, 400);
      assert.deepEqual((await (await request(path + "/lunch", otherDevice, "DELETE")).json()).items, []);
      assert.deepEqual((await (await request(path, a)).json()).items, []);
      const parallel = await Promise.all([
        request(path, a, "POST", { id: "breakfast", text: "吃早餐" }),
        request(path, otherDevice, "POST", { id: "dinner", text: "吃晚饭" }),
      ]);
      assert.ok(parallel.every(response => response.status === 200));
      assert.deepEqual((await (await request(path, a)).json()).items.map(item => item.id).sort(), ["breakfast", "dinner"]);
    });
    await t.test(
      "未登录不能读取或创建画布，旧匿名接口不再创建身份",
      async () => {
        assert.deepEqual(await (await request("/api/session", "")).json(), {
          user: null,
          legacyRoomCount: 0,
        });
        assert.equal(
          (await request("/api/session", "", "POST", {})).status,
          401,
        );
        assert.equal((await request("/api/rooms", "")).status, 401);
        assert.equal(
          (await request("/api/rooms", "", "POST", { name: "未授权" })).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/api/rooms/legacy-room/snapshot",
              `qd_session=${legacyRaw}`,
            )
          ).status,
          401,
        );
      },
    );
    await t.test("注册验证密码和用户名，用户名不区分大小写", async () => {
      const invalidPassword = await request("/api/auth/register", "", "POST", {
        ...registrations.get("验证"),
        password: "12345678",
      });
      assert.equal(invalidPassword.status, 400);
      assert.match((await invalidPassword.json()).error, /密码/);
      const invalidUsername = await request("/api/auth/register", "", "POST", {
        ...registrations.get("验证"),
        username: "<script>",
      });
      assert.equal(invalidUsername.status, 400);
      assert.match((await invalidUsername.json()).error, /用户名/);
      assert.equal(
        (
          await request("/api/auth/register", "", "POST", {
            ...credentials.get("甲"),
            username: credentials.get("甲").username.toUpperCase(),
          })
        ).status,
        409,
      );
      const csrf = await fetch(base + "/api/auth/register", {
        method: "POST",
        headers: {
          Origin: "https://evil.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "csrf",
          password: "long-password-1234",
        }),
      });
      assert.equal(csrf.status, 403);
    });
    await t.test(
      "有效旧访客注册后保留原画布与创建者身份，认领不可重放",
      async () => {
        const oldCookie = `qd_session=${legacyRaw}`;
        assert.equal(
          (await (await request("/api/session", oldCookie)).json())
            .legacyRoomCount,
          1,
        );
        const input = registrations.get("原访客");
        const unclaimed = await request(
          "/api/auth/register",
          oldCookie,
          "POST",
          input,
        );
        assert.equal(unclaimed.status, 400);
        assert.match((await unclaimed.json()).error, /勾选/);
        const response = await request(
          "/api/auth/register",
          oldCookie,
          "POST",
          { ...input, claimLegacy: true },
        );
        assert.equal(response.status, 201, await response.clone().text());
        const result = await response.json();
        assert.equal(result.user.id, "legacy-owner");
        const cookie = response.headers.get("set-cookie").split(";")[0];
        const rooms = (await (await request("/api/rooms", cookie)).json())
          .rooms;
        assert.deepEqual(
          rooms.map((r) => [r.id, r.role]),
          [["legacy-room", "owner"]],
        );
        assert.equal(
          (await (await request("/api/session", oldCookie)).json())
            .legacyRoomCount,
          0,
        );
        assert.equal(
          (await request("/api/rooms/legacy-room", oldCookie)).status,
          401,
        );
        assert.equal(
          (
            await (
              await request("/api/session", `qd_session=${expiredRaw}`)
            ).json()
          ).legacyRoomCount,
          0,
        );
      },
    );
    await t.test(
      "登录已有账号可合并有效旧访客画布，密码错误不能迁移",
      async () => {
        const oldCookie = `qd_session=${legacyLoginRaw}`;
        assert.equal(
          (
            await request("/api/auth/login", oldCookie, "POST", {
              ...credentials.get("乙"),
              password: "wrong-password-1234",
              claimLegacy: true,
            })
          ).status,
          401,
        );
        const response = await request("/api/auth/login", oldCookie, "POST", {
          ...credentials.get("乙"),
          claimLegacy: true,
        });
        assert.equal(response.status, 200);
        assert.equal(
          (await response.json()).user.id,
          credentials.get("乙").user.id,
        );
        const oldRoom = await (
          await request("/api/rooms/legacy-login-room", b)
        ).json();
        assert.equal(oldRoom.room.role, "owner");
        assert.equal(
          (await request("/api/rooms/legacy-login-room/invite", b, "POST", {}))
            .status,
          200,
        );
      },
    );
    const created = await request("/api/rooms", a, "POST", {
      name: "协作测试",
    });
    assert.equal(created.status, 201);
    const { room, invite } = await created.json();
    await t.test(
      "另一设备登录同一账号取回个人画布，其他账号无法直接读取",
      async () => {
        const response = await request("/api/auth/login", "", "POST", {
          ...credentials.get("甲"),
          username: credentials.get("甲").username.toUpperCase(),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.user.id, credentials.get("甲").user.id);
        assert.deepEqual(Object.keys(result.user).sort(), [
          "avatarVersion",
          "id",
          "name",
          "username",
        ]);
        const otherDevice = response.headers.get("set-cookie").split(";")[0];
        assert.notEqual(otherDevice, a);
        const rooms = (await (await request("/api/rooms", otherDevice)).json())
          .rooms;
        assert.equal(rooms[0].id, room.id);
        assert.deepEqual(
          (await (await request("/api/rooms", outsider)).json()).rooms,
          [],
        );
        assert.equal(
          (await request(`/api/rooms/${room.id}/snapshot`, outsider)).status,
          403,
        );
        const wrongIdentity = await fetch(
          base + `/api/rooms/${room.id}/snapshot`,
          {
            headers: {
              Cookie: a,
              "X-QD-Account": credentials.get("乙").user.id,
            },
          },
        );
        assert.equal(wrongIdentity.status, 401);
        assert.equal(
          (
            await request(
              `/api/rooms/${room.id}/socket?account=${credentials.get("乙").user.id}`,
              a,
            )
          ).status,
          401,
        );
        await request("/api/auth/logout", otherDevice, "POST", {});
        assert.equal((await request("/api/rooms", otherDevice)).status, 401);
        assert.equal((await request("/api/rooms", a)).status, 200);
      },
    );
    assert.equal(
      (await request(`/api/rooms/${room.id}`, outsider)).status,
      403,
    );
    assert.equal(
      (
        await request(`/api/rooms/${room.id}/join`, b, "POST", {
          invite: "invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(`/api/rooms/${room.id}/join`, b, "POST", { invite }))
        .status,
      200,
    );
    const sa = await socket(`${base}/api/rooms/${room.id}/socket`, a);
    const sb = await socket(`${base}/api/rooms/${room.id}/socket`, b);
    t.after(() => {
      sa.ws.terminate();
      sb.ws.terminate();
    });
    const initial = await sa.next((m) => m.type === "snapshot");
    await sb.next((m) => m.type === "snapshot");
    assert.equal(initial.rows.length, 1, "room has persistent collection");
    await t.test(
      "创建者修改项目名称后列表和详情持久更新，邀请及内容不变",
      async () => {
        const endpoint = `/api/rooms/${room.id}`;
        const renamed = await request(endpoint, a, "PATCH", {
          name: "  修改后的项目  ",
          id: "cannot-replace-project",
          owner_id: credentials.get("乙").user.id,
        });
        assert.equal(renamed.status, 200, await renamed.clone().text());
        assert.deepEqual((await renamed.json()).room, {
          ...room,
          name: "修改后的项目",
        });
        const memberDetail = (await (await request(endpoint, b)).json()).room;
        assert.equal(memberDetail.name, "修改后的项目");
        assert.equal(memberDetail.role, "editor");
        const listed = (await (await request("/api/rooms", a)).json()).rooms;
        assert.equal(
          listed.find((item) => item.id === room.id).name,
          "修改后的项目",
        );
        assert.equal(
          (await request(`${endpoint}/join`, b, "POST", { invite })).status,
          200,
        );
        assert.deepEqual(
          (await (await request(`${endpoint}/snapshot`, a)).json()).rows,
          initial.rows,
        );
        for (const name of ["短", "名".repeat(80), "项目 ' 测试"])
          assert.equal(
            (await request(endpoint, a, "PATCH", { name })).status,
            200,
          );
        assert.equal(
          (await (await request(endpoint, a)).json()).room.name,
          "项目 ' 测试",
        );
      },
    );
    await t.test(
      "项目改名拒绝非法名称和非创建者请求，原名称保持不变",
      async () => {
        const endpoint = `/api/rooms/${room.id}`;
        const before = (await (await request(endpoint, a)).json()).room;
        for (const name of ["", " \n ", "名".repeat(81), 42, null, {}])
          assert.equal(
            (await request(endpoint, a, "PATCH", { name })).status,
            400,
          );
        for (const [cookie, expected] of [
          [b, 403],
          [outsider, 403],
          ["", 401],
        ])
          assert.equal(
            (await request(endpoint, cookie, "PATCH", { name: "越权改名" }))
              .status,
            expected,
          );
        for (const [headers, expected] of [
          [{ Origin: "https://evil.invalid" }, 403],
          [{ "X-QD-Account": credentials.get("乙").user.id }, 401],
        ]) {
          const result = await fetch(base + endpoint, {
            method: "PATCH",
            headers: {
              Cookie: a,
              "Content-Type": "application/json",
              ...headers,
            },
            body: JSON.stringify({ name: "越权改名" }),
          });
          assert.equal(result.status, expected);
        }
        assert.deepEqual(
          (await (await request(endpoint, a)).json()).room,
          before,
        );
      },
    );
    await t.test(
      "头像只允许本人上传，共享成员可读取，替换和移除实时更新成员资料",
      async () => {
        const aId = credentials.get("甲").user.id;
        const bId = credentials.get("乙").user.id;
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=",
          "base64",
        );
        const upload = (
          cookie,
          bytes = png,
          mime = "image/png",
          account = aId,
        ) =>
          fetch(`${base}/api/profile/avatar`, {
            method: "PUT",
            headers: {
              Cookie: cookie,
              "Content-Type": mime,
              "X-QD-Account": account,
            },
            body: bytes,
          });
        assert.equal((await upload(" ")).status, 401);
        assert.equal(
          (await upload(b)).status,
          401,
          "切换账号的旧页面不能更新另一人头像",
        );
        assert.equal(
          (await upload(a, Buffer.from("<svg/>"), "image/svg+xml")).status,
          415,
        );
        assert.equal(
          (await upload(a, Buffer.from("not an image"))).status,
          415,
        );
        assert.equal(
          (await upload(a, Buffer.alloc(2 * 1024 * 1024 + 1))).status,
          413,
        );
        const firstResponse = await upload(a);
        assert.equal(firstResponse.status, 200);
        const first = (await firstResponse.json()).user;
        assert.ok(first.avatarVersion);
        const presence = await sb.next(
          (m) =>
            m.type === "presence" &&
            m.profiles?.some(
              (p) =>
                p.userId === aId && p.avatarVersion === first.avatarVersion,
            ),
        );
        assert.equal(
          presence.profiles.find((p) => p.userId === aId).name,
          credentials.get("甲").user.name,
        );
        assert.equal(
          (await (await request("/api/session", a)).json()).user.avatarVersion,
          first.avatarVersion,
        );
        const imagePath = `/api/avatars/${aId}?v=${first.avatarVersion}`;
        const image = await request(imagePath, b);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("Content-Type"), "image/png");
        assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
        assert.equal((await request(imagePath, outsider)).status, 403);
        assert.equal((await request(imagePath, "")).status, 401);
        assert.equal(
          (await request(`/api/avatars/${bId}`, a, "PUT", {})).status,
          405,
        );
        const second = (await (await upload(a)).json()).user;
        assert.notEqual(second.avatarVersion, first.avatarVersion);
        assert.equal((await upload(a, Buffer.from("bad"))).status, 415);
        assert.equal(
          (await (await request("/api/session", a)).json()).user.avatarVersion,
          second.avatarVersion,
          "失败上传保留已有头像",
        );
        const removed = await request("/api/profile/avatar", a, "DELETE");
        assert.equal(removed.status, 200);
        assert.equal((await removed.json()).user.avatarVersion, null);
        await sb.next(
          (m) =>
            m.type === "presence" &&
            m.profiles?.some(
              (p) => p.userId === aId && p.avatarVersion === null,
            ),
        );
        assert.equal((await request(imagePath, b)).status, 404);
        // Keep an avatar on an offline member to check the complete author directory.
        const bobUpload = await upload(b, png, "image/png", bId);
        assert.equal(bobUpload.status, 200);
      },
    );
    const note = {
      ...createObject(room.id, "note", { x: 200, y: 180 }),
      noteKind: "checklist",
      blocks: [{ ...makeBlock("一起完成"), dueAt: "2026-10-22T02:00:00.000Z", dueStartAt: "2026-10-19T16:00:00.000Z" }],
      height: 165.5,
      fixedHeight: true,
      layoutHeight: 200,
    };
    const op = {
      type: "commit",
      opId: crypto.randomUUID(),
      changes: [{ id: note.id, expectedRevision: 0, data: note }],
    };
    sa.send(op);
    const ack = await sa.next((m) => m.type === "ack" && m.opId === op.opId);
    assert.equal(ack.rows[0].revision, 1);
    assert.equal(ack.rows[0].data.fixedHeight, true);
    assert.equal(ack.rows[0].data.height, 165.5);
    assert.equal(ack.rows[0].data.blocks[0].dueAt, "2026-10-22T02:00:00.000Z");
    assert.equal(ack.rows[0].data.blocks[0].dueStartAt, "2026-10-19T16:00:00.000Z");
    assert.equal(
      ack.rows[0].data.blocks[0].createdByUserId,
      credentials.get("甲").user.id,
    );
    assert.equal(
      ack.rows[0].data.blocks[0].createdByName,
      credentials.get("甲").user.name,
    );
    assert.equal(Object.hasOwn(ack.rows[0].data, "layoutHeight"), false);
    const remote = await sb.next((m) => m.type === "changes");
    assert.equal(remote.rows[0].data.blocks[0].runs[0].text, "一起完成");
    assert.equal(
      remote.rows[0].data.blocks[0].dueAt,
      "2026-10-22T02:00:00.000Z",
    );
    assert.equal(remote.rows[0].data.fixedHeight, true);
    sa.send(op);
    assert.equal(
      (await sa.next((m) => m.type === "ack" && m.opId === op.opId)).rows[0]
        .revision,
      1,
    );
    const conflictId = crypto.randomUUID();
    sb.send({
      type: "commit",
      opId: conflictId,
      changes: [
        { id: note.id, expectedRevision: 0, data: { ...note, x: 300 } },
      ],
    });
    assert.equal(
      (
        await sb.next((m) => m.opId === conflictId && m.type === "conflict")
      ).rows.find((r) => r.id === note.id).revision,
      1,
    );
    // An invalid second change must not partially commit the first.
    const invalidId = crypto.randomUUID();
    sa.send({
      type: "commit",
      opId: invalidId,
      changes: [
        { id: note.id, expectedRevision: 1, data: { ...note, x: 400 } },
        {
          id: "bad",
          expectedRevision: 0,
          data: { ...note, id: "bad", boardId: "other-room" },
        },
      ],
    });
    await sa.next((m) => m.opId === invalidId && m.type === "error");
    const snapshot = await (
      await request(`/api/rooms/${room.id}/snapshot`, a)
    ).json();
    assert.equal(snapshot.rows.find((r) => r.id === note.id).data.x, 200);
    let archivedAuthors;
    const commitAuthors = async (client, data, revision, id = data?.id) => {
      const opId = crypto.randomUUID();
      client.send({
        type: "commit",
        opId,
        changes: [{ id, expectedRevision: revision, data }],
      });
      const reply = await client.next((m) => m.opId === opId);
      assert.equal(reply.type, "ack", reply.message);
      return reply.rows[0];
    };
    await t.test(
      "逐条作者由登录身份核定，协作者编辑、删除和恢复不改作者",
      async () => {
        const aId = credentials.get("甲").user.id;
        const bId = credentials.get("乙").user.id;
        const forged = {
          ...createObject(room.id, "note", { x: 650, y: 180 }),
          noteKind: "checklist",
          blocks: [
            {
              ...makeBlock("甲写的"),
              createdByUserId: bId,
              createdByName: "伪造",
            },
          ],
        };
        const first = await commitAuthors(sa, forged, 0);
        assert.equal(first.data.blocks[0].createdByUserId, aId);
        assert.notEqual(first.data.blocks[0].createdByName, "伪造");
        const edited = {
          ...first.data,
          blocks: [
            {
              ...first.data.blocks[0],
              done: true,
              completedAt: new Date().toISOString(),
              createdByUserId: bId,
            },
            {
              ...makeBlock("乙写的"),
              createdByUserId: aId,
              createdByName: "伪造",
            },
          ],
        };
        const second = await commitAuthors(sb, edited, first.revision);
        assert.deepEqual(
          second.data.blocks.map((b) => b.createdByUserId),
          [aId, bId],
        );
        const removed = await commitAuthors(
          sb,
          { ...second.data, blocks: second.data.blocks.slice(1) },
          second.revision,
        );
        const strip = (block) => {
          const { createdByUserId, createdByName, ...old } = block;
          return old;
        };
        const restored = await commitAuthors(
          sb,
          { ...second.data, blocks: second.data.blocks.map(strip) },
          removed.revision,
        );
        assert.deepEqual(
          restored.data.blocks.map((b) => b.createdByUserId),
          [aId, bId],
        );
        const deleted = await commitAuthors(
          sb,
          null,
          restored.revision,
          restored.id,
        );
        archivedAuthors = {
          data: { ...restored.data, blocks: restored.data.blocks.map(strip) },
          revision: deleted.revision,
        };
      },
    );
    await t.test(
      "更新前已打开的页面继续正常协作，服务端仍为其新增待办记录作者",
      async (subtest) => {
        const legacy = await socket(
          `${base}/api/rooms/${room.id}/socket`,
          a,
          false,
        );
        subtest.after(() => legacy.ws.terminate());
        const oldSnapshot = await legacy.next((m) => m.type === "snapshot");
        assert.equal(
          oldSnapshot.rows.find((r) => r.id === note.id).data.blocks[0]
            .createdByUserId,
          undefined,
        );
        const oldNote = {
          ...createObject(room.id, "note", { x: 600, y: 400 }),
          blocks: [makeBlock("旧页面新增")],
        };
        const oldAck = await commitAuthors(legacy, oldNote, 0);
        assert.equal(oldAck.data.blocks[0].createdByUserId, undefined);
        const modern = await sb.next(
          (m) =>
            m.type === "changes" && m.rows.some((r) => r.id === oldNote.id),
        );
        assert.equal(
          modern.rows.find((r) => r.id === oldNote.id).data.blocks[0]
            .createdByUserId,
          credentials.get("甲").user.id,
        );
        await commitAuthors(
          sb,
          { ...modern.rows.find((r) => r.id === oldNote.id).data, x: 650 },
          1,
        );
        const legacyUpdate = await legacy.next(
          (m) =>
            m.type === "changes" && m.rows.some((r) => r.id === oldNote.id),
        );
        assert.equal(
          legacyUpdate.rows[0].data.blocks[0].createdByUserId,
          undefined,
        );
        assert.equal(legacyUpdate.rows[0].data.x, 650);
      },
    );
    // Upload and retrieve real R2 bytes; isolate by room membership.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGQAAAABJRU5ErkJggg==",
      "base64",
    );
    const asset = "asset-test";
    const uploaded = await fetch(
      `${base}/api/rooms/${room.id}/assets/${asset}`,
      {
        method: "PUT",
        headers: {
          Cookie: a,
          "Content-Type": "image/png",
          "X-File-Name": encodeURIComponent("测试.png"),
        },
        body: png,
      },
    );
    assert.equal(uploaded.status, 201);
    const downloaded = await request(
      `/api/rooms/${room.id}/assets/${asset}`,
      b,
    );
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    assert.equal(
      (await request(`/api/rooms/${room.id}/assets/${asset}`, outsider)).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/rooms/${room.id}/assets/svg`, {
          method: "PUT",
          headers: { Cookie: a, "Content-Type": "image/svg+xml" },
          body: "<svg/>",
        })
      ).status,
      415,
    );
    assert.equal(
      (await request(`/api/rooms/${room.id}/invite`, b, "POST", {})).status,
      403,
    );
    const newInvite = await (
      await request(`/api/rooms/${room.id}/invite`, a, "POST", {})
    ).json();
    assert.notEqual(newInvite.invite, invite);
    assert.equal(
      (
        await request(`/api/rooms/${room.id}/join`, outsider, "POST", {
          invite,
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(`/api/rooms/${room.id}`, b)).status,
      200,
      "rotation preserves existing members",
    );
    assert.equal(
      (
        await fetch(`${base}/api/rooms`, {
          method: "POST",
          headers: {
            Cookie: a,
            Origin: "https://evil.invalid",
            "Content-Type": "application/json",
          },
          body: '{"name":"csrf"}',
        })
      ).status,
      403,
    );
    sa.ws.close();
    sb.ws.close();
    await stop();
    // Model an upgrade with a pre-feature task deleted before authors existed.
    // Only this test's stopped, isolated workerd database is touched.
    const legacyDeleted = {
      ...createObject(room.id, "note", { x: 900, y: 200 }),
      blocks: [makeBlock("旧版已删除待办")],
    };
    const legacyFirst = {
      ...createObject(room.id, "note", { x: 900, y: 450 }),
      noteKind: "checklist",
      blocks: [makeBlock("甲最初写的待办")],
    };
    const legacySecond = {
      ...legacyFirst,
      blocks: [...legacyFirst.blocks, makeBlock("乙后来添加的待办")],
    };
    const legacyEdited = {
      ...legacySecond,
      blocks: legacySecond.blocks.map((block, index) =>
        index
          ? block
          : { ...block, runs: [{ type: "text", text: "甲重写后的旧待办" }] },
      ),
    };
    const legacyUnknown = {
      ...createObject(room.id, "note", { x: 900, y: 650 }),
      blocks: [makeBlock("缺少创建记录")],
    };
    const legacyLarge = sharedObject({
      ...createObject(room.id, "note", { x: 900, y: 900 }),
      blocks: [makeBlock("")],
    });
    legacyLarge.blocks[0].runs[0].text = "x".repeat(
      255990 - JSON.stringify(legacyLarge).length,
    );
    assert.doesNotThrow(() => sharedObject(legacyLarge), "升级前合法的大对象");
    const legacyCreateOp = {
      type: "commit",
      opId: "old-create-note",
      changes: [{ id: legacyFirst.id, expectedRevision: 0, data: legacyFirst }],
    };
    const doDirectory = path.join(
      state,
      "v3",
      "do",
      "qingdan-canvas-CanvasRoom",
    );
    let seededLegacy = false;
    for (const filename of await readdir(doDirectory)) {
      if (!filename.endsWith(".sqlite") || filename === "metadata.sqlite")
        continue;
      const database = new DatabaseSync(path.join(doDirectory, filename));
      try {
        if (
          !database
            .prepare("SELECT name FROM sqlite_master WHERE name='objects'")
            .get()
        )
          continue;
        if (!database.prepare("SELECT id FROM objects WHERE id=?").get(note.id))
          continue;
        database.exec("DROP TABLE task_authors");
        database.exec("DROP TABLE IF EXISTS room_migrations");
        const legacyRow = {
          id: legacyDeleted.id,
          revision: 2,
          deleted: true,
          data: null,
        };
        database
          .prepare("INSERT INTO objects(id,value) VALUES(?,?)")
          .run(legacyRow.id, JSON.stringify(legacyRow));
        const legacyReceipt = {
          type: "ack",
          opId: "legacy-authors",
          rows: [
            { ...legacyRow, revision: 1, deleted: false, data: legacyDeleted },
          ],
        };
        database
          .prepare(
            "INSERT INTO receipts(id,user_id,payload,value) VALUES(?,?,?,?)",
          )
          .run(
            legacyReceipt.opId,
            credentials.get("乙").user.id,
            "[]",
            JSON.stringify(legacyReceipt),
          );
        for (const [data, revision] of [
          [legacyEdited, 3],
          [legacyUnknown, 4],
          [legacyLarge, 1],
        ]) {
          database
            .prepare("INSERT INTO objects(id,value) VALUES(?,?)")
            .run(
              data.id,
              JSON.stringify({ id: data.id, revision, deleted: false, data }),
            );
        }
        for (const [data, revision, person, opId] of [
          [legacyFirst, 1, "甲", legacyCreateOp.opId],
          [legacySecond, 2, "乙", "old-add-task"],
          [legacyEdited, 3, "甲", "old-rewrite-task"],
          [legacyUnknown, 4, "甲", "old-incomplete-history"],
          [legacyLarge, 1, "甲", "old-large-note"],
        ]) {
          database
            .prepare(
              "INSERT INTO receipts(id,user_id,payload,value) VALUES(?,?,?,?)",
            )
            .run(
              opId,
              credentials.get(person).user.id,
              JSON.stringify([
                { id: data.id, expectedRevision: revision - 1, data },
              ]),
              JSON.stringify({
                type: "ack",
                opId,
                rows: [{ id: data.id, revision, deleted: false, data }],
              }),
            );
        }
        seededLegacy = true;
      } finally {
        database.close();
      }
    }
    assert.ok(seededLegacy);
    await start();
    const restoredResponse = await request(`/api/rooms/${room.id}/snapshot`, a);
    const restored = await restoredResponse.json();
    assert.equal(restoredResponse.status, 200, JSON.stringify(restored));
    assert.equal(restored.rows.find((r) => r.id === note.id).revision, 1);
    assert.equal(
      restored.rows.find((r) => r.id === note.id).data.blocks[0].dueAt,
      "2026-10-22T02:00:00.000Z",
    );
    assert.equal(
      (await request(`/api/rooms/${room.id}/assets/${asset}`, b)).status,
      200,
    );
    const reconnected = await socket(`${base}/api/rooms/${room.id}/socket`, a);
    t.after(() => reconnected.ws.terminate());
    const recoveredSnapshot = await reconnected.next(
      (m) => m.type === "snapshot",
    );
    const directory = await reconnected.next((m) => m.type === "presence");
    const offlineAuthor = directory.profiles.find(
      (p) => p.userId === credentials.get("乙").user.id,
    );
    assert.ok(
      offlineAuthor.avatarVersion,
      "作者离线且服务重启后仍返回上传的头像",
    );
    assert.equal(
      directory.members.some((m) => m.userId === offlineAuthor.userId),
      false,
    );
    await t.test(
      "升级后旧待办按创建回执关联上传头像，重写不改作者或丢失内容",
      async () => {
        const expected = [
          credentials.get("甲").user.id,
          credentials.get("乙").user.id,
        ];
        const recovered = recoveredSnapshot.rows.find(
          (row) => row.id === legacyEdited.id,
        );
        assert.deepEqual(
          recovered.data.blocks.map((block) => block.createdByUserId),
          expected,
        );
        assert.deepEqual(
          restored.rows.find((row) => row.id === legacyEdited.id),
          recovered,
          "HTTP 和实时快照一致",
        );
        assert.equal(recovered.revision, 3, "作者元信息恢复不改变内容版本");
        assert.equal(recovered.data.blocks[0].runs[0].text, "甲重写后的旧待办");
        const recoveredLarge = recoveredSnapshot.rows.find(
          (row) => row.id === legacyLarge.id,
        );
        assert.equal(recoveredLarge.revision, 1);
        assert.equal(
          recoveredLarge.data.blocks[0].createdByUserId,
          expected[0],
        );
        assert.equal(
          recoveredLarge.data.blocks[0].runs[0].text,
          legacyLarge.blocks[0].runs[0].text,
          "作者元信息不能使已经存储的合法内容无法读取或被截断",
        );
        assert.deepEqual(
          Object.keys(recoveredLarge.data.blocks[0]),
          Object.keys(recovered.data.blocks[0]),
          "恢复的作者字段与普通待办保持相同顺序",
        );
        const imageAuthor = directory.profiles.find(
          (profile) =>
            profile.userId === recovered.data.blocks[1].createdByUserId,
        );
        assert.ok(imageAuthor.avatarVersion);
        assert.equal(
          (
            await request(
              `/api/avatars/${imageAuthor.userId}?v=${imageAuthor.avatarVersion}`,
              a,
            )
          ).status,
          200,
        );
        reconnected.send(legacyCreateOp);
        const replay = await reconnected.next(
          (message) =>
            message.type === "ack" && message.opId === legacyCreateOp.opId,
        );
        assert.equal(replay.rows[0].revision, 1);
        assert.equal(
          replay.rows[0].data.blocks[0].createdByUserId,
          expected[0],
          "旧回执重放也保留恢复的作者",
        );
        const edited = await commitAuthors(reconnected, legacyEdited, 3);
        assert.deepEqual(
          edited.data.blocks.map((block) => block.createdByUserId),
          expected,
        );
        const unknown = await commitAuthors(reconnected, legacyUnknown, 4);
        assert.equal(
          unknown.data.blocks[0].createdByUserId,
          undefined,
          "无法证明的作者不归给重写者",
        );
      },
    );
    const legacyRecovered = await commitAuthors(reconnected, legacyDeleted, 2);
    assert.equal(
      legacyRecovered.data.blocks[0].createdByUserId,
      credentials.get("乙").user.id,
      "升级前已删除的待办恢复后保留创建回执的作者",
    );
    const recoveredAuthors = await commitAuthors(
      reconnected,
      archivedAuthors.data,
      archivedAuthors.revision,
    );
    assert.deepEqual(
      recoveredAuthors.data.blocks.map((b) => b.createdByUserId),
      [credentials.get("甲").user.id, credentials.get("乙").user.id],
      "重启后恢复整张清单仍保留逐条作者",
    );
    reconnected.send(op);
    assert.equal(
      (await reconnected.next((m) => m.type === "ack")).rows[0].revision,
      1,
    );
    await t.test(
      "退出会吊销当前会话，已打开的连接不能继续收到广播",
      async (subtest) => {
        const watcher = await socket(`${base}/api/rooms/${room.id}/socket`, b);
        subtest.after(() => watcher.ws.terminate());
        await watcher.next((m) => m.type === "snapshot");
        const loggedOut = await request("/api/auth/logout", b, "POST", {});
        assert.equal(loggedOut.status, 200);
        assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
        assert.equal(
          (await request(`/api/rooms/${room.id}/snapshot`, b)).status,
          401,
        );
        assert.equal(
          (await request(`/api/rooms/${room.id}/assets/${asset}`, b)).status,
          401,
        );
        const added = createObject(room.id, "note", { x: 500, y: 500 });
        const commit = {
          type: "commit",
          opId: crypto.randomUUID(),
          changes: [{ id: added.id, expectedRevision: 0, data: added }],
        };
        reconnected.send(commit);
        await reconnected.next(
          (m) => m.type === "ack" && m.opId === commit.opId,
        );
        for (let i = 0; i < 50 && watcher.ws.readyState === WebSocket.OPEN; i++)
          await delay(20);
        assert.equal(
          watcher.messages.some((m) => m.type === "changes"),
          false,
        );
        assert.ok(
          [WebSocket.CLOSING, WebSocket.CLOSED].includes(watcher.ws.readyState),
          `revoked socket state ${watcher.ws.readyState}`,
        );
      },
    );
    await t.test(
      "修改密码需验证旧密码，撤销旧设备会话与旧连接的写入权限",
      async () => {
        const second = await request(
          "/api/auth/login",
          "",
          "POST",
          credentials.get("甲"),
        );
        assert.equal(second.status, 200);
        const cookie = second.headers.get("set-cookie").split(";")[0];
        const newPassword = "Next-pw-9";
        assert.equal(
          (
            await request("/api/auth/password", cookie, "POST", {
              currentPassword: "wrong-password-1234",
              password: newPassword,
            })
          ).status,
          401,
        );
        const changed = await request("/api/auth/password", cookie, "POST", {
          currentPassword: credentials.get("甲").password,
          password: newPassword,
        });
        assert.equal(changed.status, 200, await changed.clone().text());
        const renewed = changed.headers.get("set-cookie").split(";")[0];
        assert.notEqual(renewed, cookie);
        assert.equal((await request("/api/rooms", a)).status, 401);
        assert.equal((await request("/api/rooms", cookie)).status, 401);
        assert.equal((await request("/api/rooms", renewed)).status, 200);
        reconnected.send({ ...op, opId: crypto.randomUUID() });
        assert.equal(
          (await reconnected.next((m) => m.type === "error")).status,
          401,
        );
        assert.equal(
          (await request("/api/auth/login", "", "POST", credentials.get("甲")))
            .status,
          401,
        );
        const login = await request("/api/auth/login", "", "POST", {
          ...credentials.get("甲"),
          password: newPassword,
        });
        assert.equal(login.status, 200);
        assert.equal(
          (await login.json()).user.id,
          credentials.get("甲").user.id,
        );
      },
    );
    await t.test("错误登录不泄露账号是否存在，连续猜测受到限流", async () => {
      const response = await request("/api/auth/login", "", "POST", {
        username: "missing_user",
        password: "Wrong-test-password-2026",
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "用户名或密码不正确。");
      for (let i = 0; i < 9; i++)
        assert.equal(
          (
            await request("/api/auth/login", "", "POST", {
              username: "missing_user",
              password: "Wrong-test-password-2026",
            })
          ).status,
          401,
        );
      assert.equal(
        (
          await request("/api/auth/login", "", "POST", {
            username: "missing_user",
            password: "Wrong-test-password-2026",
          })
        ).status,
        429,
      );
    });
    await stop();
    const stored = JSON.parse(
      await command([
        "d1",
        "execute",
        "qingdan-canvas",
        "--local",
        "--persist-to",
        state,
        "--command",
        "SELECT password_hash FROM accounts ORDER BY id",
        "--json",
      ]),
    );
    const hashes = stored[0].results.map((row) => row.password_hash);
    assert.ok(
      hashes.every((hash) =>
        /^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(hash),
      ),
    );
    assert.equal(
      new Set(hashes).size,
      hashes.length,
      "同样的密码使用独立随机盐",
    );
  },
);
