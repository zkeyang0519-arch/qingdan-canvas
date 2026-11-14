import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebLaunch,
  waitForDesktopDownload,
} from "../desktop/web-launch.cjs";
import { requestOnlineLaunch } from "../src/desktop/online-launch.js";

test("the independent installed-app bridge authenticates the requested canvas before confirming launch", async (t) => {
  let checks = 0,
    applied = 0;
  const bridge = await createWebLaunch({
    port: 0,
    updates: {
      check: async () => {
        checks++;
      },
      state: () => ({ status: "idle" }),
    },
    fetchImpl: async () =>
      Response.json({
        accountId: "alice",
        roomId: "room-a",
        sessionToken: "a".repeat(64),
        expiresAt: Date.now() + 3600000,
      }),
    requestHandoff: async (descriptor) => {
      const headers = { Authorization: `Bearer ${descriptor.nonce}` };
      const context = await (
        await fetch(descriptor.endpoint + "/claim", { method: "POST", headers })
      ).json();
      assert.equal(context.accountId, "alice");
      assert.equal(context.roomId, "room-a");
      applied++;
      await fetch(descriptor.endpoint + "/result", {
        method: "POST",
        headers,
        body: JSON.stringify({ applied: true }),
      });
    },
  });
  t.after(bridge.close);
  const call = async (method, body, origin = "https://todo.zky.lol") =>
    fetch(
      `http://127.0.0.1:${bridge.port}/api/local-desktop/online/${method}`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Qingdan-Local": "1",
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal(
    (await call("probe", {}, "https://untrusted.example")).status,
    403,
  );
  const firstProbe = await (await call("probe", {})).json();
  assert.match(firstProbe.instanceId, /^[a-f0-9]{32}$/);
  const prepared = await (
    await call("prepare", { accountId: "alice", roomId: "room-a" })
  ).json();
  assert.equal(prepared.instanceId, firstProbe.instanceId);
  const receipt = await (
    await call("launch", {
      requestId: prepared.requestId,
      ticket: "b".repeat(64),
    })
  ).json();
  assert.deepEqual(receipt, { started: true, applied: true });
  assert.equal(checks, 1);
  assert.equal(applied, 1);
});
test("download wait reports progress, stops for cancellation, and does not equate an available update with a complete download", async () => {
  const controller = new AbortController();
  const statuses = [];
  await assert.rejects(
    waitForDesktopDownload(
      {
        check: async () => {},
        state: () => ({ status: "downloading", progress: 25 }),
      },
      {
        signal: controller.signal,
        onStatus: (message) => {
          statuses.push(message);
          if (message.includes("25")) controller.abort();
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.ok(statuses.some((message) => message.includes("25")));
});
test("the website does not report success until a different installed-app instance completes a fresh handoff", async (t) => {
  const calls = [],
    progress = [];
  let prepares = 0,
    launches = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    if (url.endsWith("/prepare"))
      return Response.json({
        requestId: (++prepares === 1 ? "a" : "d").repeat(32),
        challenge: "b".repeat(64),
        instanceId: prepares === 1 ? "old" : "new",
      });
    if (url === "/api/desktop/handoff")
      return Response.json({ ticket: "c".repeat(64) });
    if (url.endsWith("/launch"))
      return Response.json({
        started: true,
        applied: true,
        ...(++launches === 1 ? { restarting: true } : {}),
      });
    if (url.endsWith("/probe")) return Response.json({ instanceId: "new" });
    throw Error("Unexpected request");
  });
  const result = await requestOnlineLaunch(
    "alice",
    "room-a",
    new AbortController().signal,
    (message) => progress.push(message),
  );
  assert.equal(result.applied, true);
  assert.equal(prepares, 2);
  assert.equal(launches, 2);
  assert.equal(calls.filter((url) => url === "/api/desktop/handoff").length, 2);
  assert.ok(progress.some((message) => message.includes("安装新版")));
});
test("a stopped standalone app falls back to the existing local installer service", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url.includes(":8791")) throw Error("not running");
    if (url.endsWith("/prepare"))
      return Response.json({
        requestId: "a".repeat(32),
        challenge: "b".repeat(64),
      });
    if (url === "/api/desktop/handoff")
      return Response.json({ ticket: "c".repeat(64) });
    if (url.endsWith("/launch"))
      return Response.json({ started: true, applied: true });
    throw Error("Unexpected request");
  });
  assert.equal(
    (await requestOnlineLaunch("alice", "room-a", new AbortController().signal))
      .applied,
    true,
  );
  assert.match(calls.at(-1), /:8790\/api\/local-desktop\/online\/launch$/);
});
