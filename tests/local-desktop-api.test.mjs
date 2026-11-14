import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { createLocalDesktopApi } from "../scripts/lib/local-desktop-api.mjs";
const sessionToken = "a".repeat(64);

async function fixture(t) {
  let expiresAt = Date.now() + 3600000;
  let starts = 0,
    sessionStatus = 200,
    launchError,
    roomStatus = 200;
  const worker = createServer((req, res) => {
    assert.ok(["/api/session", "/api/rooms/room-a"].includes(req.url));
    res.writeHead(req.url === "/api/session" ? sessionStatus : roomStatus, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/api/session"
          ? {
              sessionExpiresAt: expiresAt,
              user:
                req.headers.cookie === `qd_session=${sessionToken}`
                  ? { id: "alice" }
                  : null,
            }
          : { room: { id: "room-a" } },
      ),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${worker.address().port}`;
  const server = createExperienceServer({
    service: {},
    upstream,
    desktopApi: createLocalDesktopApi({
      upstream,
      launch: async (...args) => {
        assert.deepEqual(args, [
          { accountId: "alice", roomId: "room-a", sessionToken, expiresAt },
        ]);
        if (launchError) throw launchError;
        starts++;
        return { started: true, applied: true };
      },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Origin: origin,
    "X-Qingdan-Local": "1",
    "X-QD-Account": "alice",
    Cookie: `qd_session=${sessionToken}; unrelated=do-not-forward`,
    "Content-Type": "application/json",
  };
  const call = (options = {}) =>
    fetch(`${origin}/api/local-desktop/launch`, {
      method: "POST",
      body: '{"roomId":"room-a"}',
      ...options,
      headers: { ...headers, ...options.headers },
    });
  return {
    origin,
    upstream,
    headers,
    call,
    starts: () => starts,
    setExpiry: (value) => {
      expiresAt = value;
    },
    failSession: () => {
      sessionStatus = 503;
    },
    failLaunch: () => {
      launchError = Error("桌面运行时下载失败，请稍后重试。");
    },
    forbidRoom: () => {
      roomStatus = 403;
    },
  };
}

test("desktop launch verifies the browser session and accepts no launch parameters", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Cookie: "" },
    { "X-QD-Account": "" },
    { "X-QD-Account": "bob" },
    { Cookie: "qd_session=bad" },
  ]) {
    assert.equal((await f.call({ headers })).status, 401);
  }
  for (const body of [
    '{"url":"https://evil.test"}',
    '{"command":"whoami"}',
    '{"ownerId":"alice"}',
    "[]",
    "null",
    '""',
    "{",
    "{}",
    '{"roomId":"../escape"}',
    '{"roomId":"room-a","sessionToken":"forged"}',
  ]) {
    assert.equal((await f.call({ body })).status, 400);
  }
  assert.equal(
    (await f.call({ headers: { "Content-Type": "text/plain" } })).status,
    415,
  );
  assert.equal(
    (await f.call({ body: JSON.stringify({ payload: "a".repeat(2048) }) }))
      .status,
    413,
  );
  assert.equal(f.starts(), 0);
  const launched = await f.call();
  assert.equal(launched.status, 200);
  assert.deepEqual(await launched.json(), { started: true, applied: true });
  assert.equal(f.starts(), 1);
  f.failSession();
  assert.equal((await f.call()).status, 503);
  assert.equal(f.starts(), 1);
});

test("local launch requires verified persistent cookie expiry and refuses missing or expired metadata", async (t) => {
  const f = await fixture(t);
  for (const value of [
    undefined,
    null,
    "2099-01-01",
    Date.now() - 1000,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    f.setExpiry(value);
    const response = await f.call();
    assert.equal(response.status, 503);
  }
  assert.equal(f.starts(), 0);
  f.setExpiry(Date.now() + 60000);
  assert.equal((await f.call()).status, 200);
  assert.equal(f.starts(), 1);
});

test("desktop launch failures reach the button without reporting success", async (t) => {
  const f = await fixture(t);
  f.failLaunch();
  const response = await f.call();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "桌面运行时下载失败，请稍后重试。",
  });
  assert.equal(f.starts(), 0);
});

test("a logged-in browser cannot hand off a room it cannot access", async (t) => {
  const f = await fixture(t);
  f.forbidRoom();
  assert.equal((await f.call()).status, 403);
  assert.equal(f.starts(), 0);
});

test("desktop endpoint rejects foreign sites and DNS rebinding but allows explicit local app ports", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: "https://evil.test" },
    { Origin: "null" },
    { Origin: "" },
    { "X-Qingdan-Local": "" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "http://127.0.0.1:9999" },
  ]) {
    assert.equal((await f.call({ headers })).status, 403);
  }
  const status = await new Promise((resolve, reject) => {
    const req = request(
      `${f.origin}/api/local-desktop/launch`,
      { method: "POST", headers: { ...f.headers, Host: "evil.test" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end('{"roomId":"room-a"}');
  });
  assert.equal(status, 403);
  assert.equal(f.starts(), 0);
  for (const origin of [f.upstream, "http://127.0.0.1:5178"]) {
    const preflight = await f.call({
      method: "OPTIONS",
      body: undefined,
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,x-qingdan-local,x-qd-account",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    const launched = await f.call({ headers: { Origin: origin } });
    assert.equal(launched.status, 200);
    assert.equal(launched.headers.get("access-control-allow-origin"), origin);
  }
  assert.equal(f.starts(), 2);
  assert.equal((await f.call({ method: "GET", body: undefined })).status, 405);
  assert.equal(
    (
      await fetch(`${f.origin}/api/local-desktop/launch?url=bad`, {
        method: "POST",
        headers: f.headers,
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(f.starts(), 2);
});
