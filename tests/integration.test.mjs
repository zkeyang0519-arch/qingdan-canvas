import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
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
          "APP_ENV:local",
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
      if (proc && proc.exitCode === null) {
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
    async function session(name) {
      const response = await fetch(base + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      assert.equal(response.status, 200);
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
    const created = await request("/api/rooms", a, "POST", {
      name: "协作测试",
    });
    assert.equal(created.status, 201);
    const { room, invite } = await created.json();
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
      blocks: [makeBlock("一起完成")],
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
    assert.equal(Object.hasOwn(ack.rows[0].data, "layoutHeight"), false);
    const remote = await sb.next((m) => m.type === "changes");
    assert.equal(remote.rows[0].data.blocks[0].runs[0].text, "一起完成");
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
  },
);
