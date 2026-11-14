import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
const cloud = "https://qingdan-canvas.zkeyang0519.workers.dev";
const ticket = "d".repeat(64),
  token = "e".repeat(64);
async function fixture(t, options = {}) {
  const launches = [],
    redemptions = [];
  const server = createExperienceServer({
    service: {},
    upstream: "http://127.0.0.1:8788",
    onlineDesktop: {
      ...(options.now ? { now: options.now } : {}),
      launch: async (context, controls) => {
        launches.push(context);
        return options.launch
          ? options.launch(context, controls)
          : { started: true, applied: true };
      },
      fetchImpl: async (url, init) => {
        redemptions.push({ url, init });
        if (options.fetchImpl) return options.fetchImpl(url, init);
        return Response.json({
          accountId: "alice",
          roomId: "room-a",
          sessionToken: token,
          expiresAt: Date.now() + 3600000,
        });
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (pathname, body, headers = {}, method = "POST", signal) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: pathname,
          method,
          signal,
          headers: {
            Origin: cloud,
            "Content-Type": "application/json",
            "X-Qingdan-Local": "1",
            "Sec-Fetch-Site": "cross-site",
            ...headers,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              raw,
              json: () => JSON.parse(raw),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  return {
    request,
    launches,
    redemptions,
    prepare: () =>
      request("/api/local-desktop/online/prepare", {
        accountId: "alice",
        roomId: "room-a",
      }),
  };
}

test("online desktop handshake retains its verifier natively and returns only the applied receipt", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.status, 200);
  const p = prepared.json();
  assert.match(p.requestId, /^[a-f0-9]{32}$/);
  assert.match(p.challenge, /^[a-f0-9]{64}$/);
  assert.equal(p.verifier, undefined);
  const launched = await f.request("/api/local-desktop/online/launch", {
    requestId: p.requestId,
    ticket,
  });
  assert.equal(launched.status, 200);
  assert.deepEqual(launched.json(), { started: true, applied: true });
  assert.equal(launched.raw.includes(token), false);
  const [redemption] = f.redemptions,
    proof = JSON.parse(redemption.init.body);
  assert.equal(redemption.url, cloud + "/api/desktop/handoff/redeem");
  assert.equal(redemption.init.redirect, "error");
  assert.equal(
    createHash("sha256").update(proof.verifier).digest("hex"),
    p.challenge,
  );
  assert.equal(redemption.init.headers.Cookie, undefined);
  assert.equal(f.launches[0].origin, cloud);
  assert.equal(f.launches[0].accountId, "alice");
  assert.equal(
    (
      await f.request("/api/local-desktop/online/launch", {
        requestId: p.requestId,
        ticket,
      })
    ).status,
    410,
  );
  assert.equal(f.launches.length, 1);
});

test("online launch CORS is scoped to configured HTTPS origins and cannot open other local APIs", async (t) => {
  const f = await fixture(t);
  const official = await f.request(
    "/api/local-desktop/online/prepare",
    { accountId: "alice", roomId: "room-a" },
    { Origin: "https://todo.zky.lol" },
  );
  assert.equal(official.status, 200);
  assert.equal(
    official.headers["access-control-allow-origin"],
    "https://todo.zky.lol",
  );
  const preflight = await f.request(
    "/api/local-desktop/online/prepare",
    null,
    {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-qingdan-local",
      "Access-Control-Request-Private-Network": "true",
    },
    "OPTIONS",
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], cloud);
  assert.equal(
    preflight.headers["access-control-allow-private-network"],
    "true",
  );
  for (const headers of [
    { Origin: "https://evil.test" },
    { Origin: "https://todo.zky.lol.evil.test" },
    { Origin: "http://qingdan-canvas.zkeyang0519.workers.dev" },
    { Host: "evil.test" },
    { "X-Qingdan-Local": "" },
  ])
    assert.equal(
      (
        await f.request(
          "/api/local-desktop/online/prepare",
          { accountId: "alice", roomId: "room-a" },
          headers,
        )
      ).status,
      403,
    );
  for (const route of [
    "/api/session",
    "/api/local-runner/status",
    "/api/local-codex/status",
    "/api/local-desktop/launch",
  ])
    assert.equal((await f.request(route, {})).status, 403);
  assert.equal(f.redemptions.length, 0);
  assert.equal(f.launches.length, 0);
});

test("mismatched cloud identity and redirect/network failures never launch a desktop", async (t) => {
  for (const fetchImpl of [
    async () =>
      Response.json({
        accountId: "other",
        roomId: "room-a",
        sessionToken: token,
      }),
    async () => {
      throw Error("private failure");
    },
  ]) {
    const f = await fixture(t, { fetchImpl });
    const response = await f.prepare();
    assert.equal(response.status, 200);
    const result = await f.request("/api/local-desktop/online/launch", {
      requestId: response.json().requestId,
      ticket,
    });
    assert.ok(result.status >= 400);
    assert.equal(result.raw.includes("private failure"), false);
    assert.equal(f.launches.length, 0);
  }
});

test("expired prepare requests cannot redeem a cloud grant", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const prepared = await f.prepare();
  assert.equal(prepared.status, 200);
  now += 90001;
  assert.equal(
    (
      await f.request("/api/local-desktop/online/launch", {
        requestId: prepared.json().requestId,
        ticket,
      })
    ).status,
    410,
  );
  assert.equal(f.redemptions.length, 0);
});

test("online launch retains sanitized native cancellation and upgrade guidance without leaking other errors", async (t) => {
  for (const message of [
    "已取消切换，原桌面窗口和输入已保留。",
    "桌面窗口未响应本次交接，请从系统托盘安全退出轻岛后，再点击按钮。",
    "private failure with a credential",
  ]) {
    const handoff = !message.startsWith("private");
    const f = await fixture(t, {
      launch: async () => {
        throw Object.assign(Error(message), handoff ? { handoff: true } : {});
      },
    });
    const prepared = await f.prepare();
    const result = await f.request("/api/local-desktop/online/launch", {
      requestId: prepared.json().requestId,
      ticket,
    });
    assert.equal(result.status, 503);
    if (handoff) assert.equal(result.json().error, message);
    else assert.equal(result.raw.includes(message), false);
  }
});

test("a browser abandoning an in-flight cloud launch invalidates native activation", async (t) => {
  let entered, aborted;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const cancelled = new Promise((resolve) => {
    aborted = resolve;
  });
  const f = await fixture(t, {
    launch: (_context, { signal }) =>
      new Promise((resolve) => {
        entered();
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            resolve({ started: false });
          },
          { once: true },
        );
      }),
  });
  const prepared = await f.prepare();
  assert.equal(prepared.status, 200);
  const controller = new AbortController();
  const request = f.request(
    "/api/local-desktop/online/launch",
    { requestId: prepared.json().requestId, ticket },
    {},
    "POST",
    controller.signal,
  );
  const rejected = assert.rejects(request, { name: "AbortError" });
  await started;
  controller.abort();
  await rejected;
  await cancelled;
  assert.equal(
    (
      await f.request("/api/local-desktop/online/launch", {
        requestId: prepared.json().requestId,
        ticket,
      })
    ).status,
    410,
  );
});
