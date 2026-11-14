import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
let handoff = {};
try { handoff = require("../desktop/session-handoff.cjs"); } catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const descriptor = { version: 1, endpoint: "http://127.0.0.1:52341", nonce: "a".repeat(64) };
const session = { accountId: "alice", roomId: "room-a", sessionToken: "b".repeat(64) };

test("handoff accepts only a bounded loopback descriptor and credential shape", () => {
  assert.equal(typeof handoff.validateDescriptor, "function");
  assert.deepEqual(handoff.validateDescriptor(descriptor), descriptor);
  for (const endpoint of ["http://localhost:52341", "https://127.0.0.1:52341", "http://127.0.0.1:52341/path", "http://127.0.0.1:52341?x", "http://user@127.0.0.1:52341", "http://127.0.0.1.evil:52341", "http://127.1:52341", "http://127.0.0.1:52341/"]) {
    assert.throws(() => handoff.validateDescriptor({ ...descriptor, endpoint }));
  }
  for (const value of [{ ...descriptor, nonce: "bad" }, { ...descriptor, extra: true }, { ...descriptor, version: 2 }]) assert.throws(() => handoff.validateDescriptor(value));
  assert.deepEqual(handoff.validateSession(session), session);
  for (const value of [{ ...session, accountId: "bad\r\nheader" }, { ...session, roomId: "../session" }, { ...session, roomId: "a".repeat(129) }, { ...session, sessionToken: "" }]) assert.throws(() => handoff.validateSession(value));
});

test("stdin handoff waits for EOF and rejects oversize, malformed and missing input", async () => {
  assert.equal(typeof handoff.readDescriptor, "function");
  const input = new PassThrough();
  const result = handoff.readDescriptor(input);
  input.end(JSON.stringify(descriptor));
  assert.deepEqual(await result, descriptor);
  for (const text of ["x".repeat(2049), "{}", "{broken"]) {
    const stream = new PassThrough(), pending = handoff.readDescriptor(stream);
    stream.end(text);
    await assert.rejects(pending, /交接/);
  }
  await assert.rejects(handoff.readDescriptor(new PassThrough(), { timeoutMs: 5 }), /交接/);
});

test("claimed session is checked only against fixed application endpoints and never follows redirects", async () => {
  assert.equal(typeof handoff.claimSession, "function");
  const calls = [];
  const result = await handoff.claimSession(descriptor, "http://127.0.0.1:8790/app", async (url, options) => {
    calls.push([String(url), options]);
    return { ok: true, json: async () => calls.length === 1 ? session : calls.length === 2 ? { user: { id: "alice" } } : { room: { id: "room-a" } } };
  });
  assert.deepEqual(result, session);
  assert.deepEqual(calls.map(([url]) => url), [descriptor.endpoint + "/claim", "http://127.0.0.1:8790/api/session", "http://127.0.0.1:8790/api/rooms/room-a"]);
  assert.equal(calls[0][1].headers.Authorization, "Bearer " + descriptor.nonce);
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[1][1].headers.Cookie, "qd_session=" + session.sessionToken);
  assert.equal(calls[1][1].headers["X-QD-Account"], "alice");
  assert.ok(calls.every(([, options]) => options.redirect === "error"));
});

test("invalid account or inaccessible room stops before applying credentials with sanitized errors", async () => {
  assert.equal(typeof handoff.claimSession, "function");
  for (const mode of ["account", "room", "network"]) {
    let calls = 0;
    await assert.rejects(handoff.claimSession(descriptor, "http://127.0.0.1:8790/app", async () => {
      calls++;
      if (mode === "network") throw Error(session.sessionToken);
      return { ok: calls !== 3 || mode !== "room", json: async () => calls === 1 ? session : { user: { id: mode === "account" ? "bob" : "alice" } } };
    }), error => !error.message.includes(session.sessionToken) && /登录|画布|交接/.test(error.message));
    if (mode === "account") assert.equal(calls, 2);
  }
});

test("handoff rejects HTTP-success room responses with a different ID or invalid JSON", async () => {
  for (const mode of ["wrong-room", "html"]) {
    let calls = 0;
    await assert.rejects(handoff.claimSession(descriptor, "http://127.0.0.1:8790/app", async () => {
      calls++;
      return { ok: true, json: async () => {
        if (calls === 1) return session;
        if (calls === 2) return { user: { id: "alice" } };
        if (mode === "html") throw new SyntaxError("Unexpected token <");
        return { room: { id: "another-room" } };
      } };
    }), /交接验证失败/);
    assert.equal(calls, 3);
  }
});

test("same account and room saves then reuses the window without draft consent or navigation", async () => {
  assert.equal(typeof handoff.applySessionHandoff, "function");
  const calls = [];
  assert.deepEqual(await handoff.applySessionHandoff({
    session, prepare: async () => ({ ok: true, accountId: "alice", roomId: "room-a", hasDraft: true, unsynced: true }),
    confirm: async () => { throw Error("must not discard same-room draft"); },
    activate: async (_session, { reuse }) => calls.push(["activate", reuse]),
  }), { applied: true });
  assert.deepEqual(calls, [["activate", true]]);
});

test("room/account replacement waits for save and default-cancel consent before activation", async () => {
  assert.equal(typeof handoff.applySessionHandoff, "function");
  for (const saved of [{ ok: true, accountId: "alice", roomId: "other", hasDraft: true }, { ok: true, accountId: "bob", roomId: "room-a", unsynced: true }]) {
    const calls = [];
    let finish;
    const pending = handoff.applySessionHandoff({ session, prepare: () => new Promise(resolve => { finish = resolve; }), confirm: async () => { calls.push("confirm"); return false; }, activate: async () => calls.push("activate") });
    assert.deepEqual(calls, []);
    finish(saved);
    assert.equal((await pending).code, "cancelled");
    assert.deepEqual(calls, ["confirm"]);
  }
  let activated = false;
  await assert.rejects(handoff.applySessionHandoff({ session, prepare: async () => ({ ok: false }), activate: async () => { activated = true; } }), /保存/);
  assert.equal(activated, false);
});

test("approved replacement completes only after activation and readiness finish", async () => {
  assert.equal(typeof handoff.applySessionHandoff, "function");
  let finish, done = false;
  const pending = handoff.applySessionHandoff({ session, prepare: async () => ({ ok: true, accountId: "bob", roomId: "room-b", hasDraft: true }), confirm: async () => true, activate: async (_session, { reuse }) => { assert.equal(reuse, false); await new Promise(resolve => { finish = resolve; }); } }).then(result => { done = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  finish();
  assert.deepEqual(await pending, { applied: true });
});

test("broker ACK sends only bounded non-secret result data", async () => {
  assert.equal(typeof handoff.acknowledge, "function");
  const calls = [];
  await handoff.acknowledge(descriptor, { applied: false, code: "failed", error: session.sessionToken }, async (url, options) => { calls.push([url, options]); return { ok: true }; });
  assert.equal(calls[0][0], descriptor.endpoint + "/result");
  assert.equal(calls[0][1].headers.Authorization, "Bearer " + descriptor.nonce);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.applied, false);
  assert.equal(body.code, "failed");
  assert.ok(!body.error.includes(session.sessionToken));
});

test("handoff checks broker liveness after confirmation and cannot activate an expired transfer", async () => {
  let finishConfirm, activated = false;
  const order = [];
  const pending = handoff.applySessionHandoff({
    session, prepare: async () => ({ ok: true, accountId: "bob", roomId: "other", hasDraft: true }),
    confirm: async () => { order.push("confirm"); return new Promise(resolve => { finishConfirm = resolve; }); },
    ensureActive: async () => { order.push("check"); throw Error("交接已过期"); },
    activate: async () => { activated = true; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["confirm"]);
  finishConfirm(true);
  await assert.rejects(pending, /过期/);
  assert.equal(activated, false);
  assert.deepEqual(order, ["confirm", "check"]);
});

test("broker liveness uses the authenticated fixed check route and rejects expired or malformed replies", async () => {
  assert.equal(typeof handoff.ensureActive, "function");
  let request;
  await handoff.ensureActive(descriptor, async (url, options) => { request = [url, options]; return { ok: true, json: async () => ({ active: true }) }; });
  assert.equal(request[0], descriptor.endpoint + "/check");
  assert.equal(request[1].method, "POST");
  assert.equal(request[1].headers.Authorization, "Bearer " + descriptor.nonce);
  assert.equal(request[1].redirect, "error");
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ active: false }) }, { ok: true, json: async () => ({}) }]) {
    await assert.rejects(handoff.ensureActive(descriptor, async () => response), /过期/);
  }
});
