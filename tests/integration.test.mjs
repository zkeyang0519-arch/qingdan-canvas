import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createHash, randomBytes } from "node:crypto";
import { createObject, makeBlock } from "../src/canvas/model.js";

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
async function socket(url, cookie) {
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
          "--inspector-port",
          "0",
        ],
        {
          cwd: root,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
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
      const input = {
        name,
        username: `user_${crypto.randomUUID().slice(0, 16)}`,
        password: "Qd-test-9",
      };
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
      assert.equal(
        (
          await request("/api/auth/register", "", "POST", {
            username: "bad",
            password: "12345678",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/api/auth/register", "", "POST", {
            username: "<script>",
            password: "long-password-1234",
          })
        ).status,
        400,
      );
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
        const input = {
          username: "legacy_owner",
          password: "legacy-password-1234",
        };
        assert.equal(
          (await request("/api/auth/register", oldCookie, "POST", input))
            .status,
          400,
        );
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
    const note = {
      ...createObject(room.id, "note", { x: 200, y: 180 }),
      noteKind: "checklist",
      blocks: [{ ...makeBlock("一起完成"), dueAt: "2026-10-22T02:00:00.000Z" }],
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
    await start();
    const restored = await (
      await request(`/api/rooms/${room.id}/snapshot`, a)
    ).json();
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
    await reconnected.next((m) => m.type === "snapshot");
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
