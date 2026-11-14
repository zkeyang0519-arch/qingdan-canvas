import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
let startServer;
try {
  ({ startServer } = await import("../server.mjs"));
} catch {}
test("protected loopback panel server exists", () =>
  assert.equal(typeof startServer, "function"));
if (startServer) {
  const token = "a".repeat(64);
  async function setup(t) {
    let inspected = 0;
    const connector = {
      status: () => ({ status: "ready" }),
      inspect: async () => {
        inspected++;
        return { status: "ready" };
      },
      listSessions: async () => ({ sessions: [], nextCursor: null }),
      readSession: async (id) => ({ threadId: id }),
      configure: async () => ({ status: "ready" }),
      diagnostics: () => ({ status: "ready" }),
      close: async () => {},
    };
    const s = await startServer({ connector, token, port: 0 });
    t.after(() => s.close());
    return { ...s, count: () => inspected };
  }
  test("requires bearer even on loopback and does not disclose token in HTML", async (t) => {
    const s = await setup(t);
    assert.equal((await fetch(s.url + "/api/status")).status, 401);
    const html = await (await fetch(s.url + "/")).text();
    assert.ok(html.includes("Codex"));
    assert.equal(html.includes(token), false);
    assert.equal(
      (
        await fetch(s.url + "/api/status", {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
      200,
    );
  });
  test("rejects foreign Origin and Host, including with a valid bearer", async (t) => {
    const s = await setup(t);
    for (const headers of [
      { Origin: "https://evil.invalid" },
      { Host: "evil.invalid" },
    ]) {
      const status = await new Promise((resolve, reject) => {
        http
          .get(
            s.url + "/api/status",
            { headers: { Authorization: "Bearer " + token, ...headers } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          )
          .on("error", reject);
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
  });
  test("only fixed routes are available and bad JSON never starts a connection", async (t) => {
    const s = await setup(t);
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Origin: s.url,
    };
    assert.equal(
      (
        await fetch(s.url + "/api/rpc", {
          method: "POST",
          headers,
          body: JSON.stringify({ method: "turn/start" }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(s.url + "/api/connect", {
          method: "POST",
          headers,
          body: "broken",
        })
      ).status,
      400,
    );
    assert.equal(s.count(), 0);
    assert.equal(
      (
        await fetch(s.url + "/api/connect", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(s.count(), 1);
  });
  test("rejects oversized bodies, invalid search and malformed selected IDs", async (t) => {
    const s = await setup(t),
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Origin: s.url,
      };
    assert.equal(
      (
        await fetch(s.url + "/api/config", {
          method: "POST",
          headers,
          body: JSON.stringify({ manualPath: "x".repeat(70000) }),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(s.url + "/api/sessions?search=" + "x".repeat(201), {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(s.url + "/api/session?id=../outside", { headers })).status,
      400,
    );
  });
  test("preserves Chinese program paths across split HTTP chunks", async (t) => {
    let received;
    const s = await startServer({
      token,
      port: 0,
      connector: {
        configure: async (p) => {
          received = p;
          return {};
        },
      },
    });
    t.after(() => s.close());
    const target = "C:\\中文路径\\codex.exe",
      body = Buffer.from(JSON.stringify({ manualPath: target })),
      at = body.indexOf(Buffer.from("中")) + 1;
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        s.url + "/api/config",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.write(body.subarray(0, at));
      setTimeout(() => req.end(body.subarray(at)), 15);
    });
    assert.equal(status, 200);
    assert.equal(received, target);
  });
}
