import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const origin = "http://127.0.0.1:8790";
const target = { accountId: "alice", roomId: "room-new", sessionToken: "b".repeat(64) };

async function fixture(t) {
  const listeners = new Map(), handlers = new Map(), calls = [];
  const electron = {
    app: { setPath() {}, setName() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on(name, fn) { listeners.set(name, fn); } },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  };
  const context = {
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:fs") return { mkdirSync() {}, writeFileSync() {} };
      if (name === "./session-handoff.cjs") return { ...require("../desktop/session-handoff.cjs"), claimSession: async () => target, acknowledge: async (_descriptor, result) => calls.push(["ack", result]) };
      if (name.startsWith("./")) return require("../desktop/" + name.slice(2));
      return require(name);
    },
    __dirname: "D:/fixture/desktop", process: { env: {}, platform: "win32" }, setTimeout, clearTimeout, console, Buffer, URL,
  };
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source + `\nglobalThis.host = { activateHandoff, waitForContext, requestSavedAction, requestHandoff, currentAction: () => actionPromise, prepare: saveBeforeQuit, setWindow(w) { window=w; quitting=false; }, cleanup() { clearTimeout(positionTimer); if(readyWaiter) clearTimeout(readyWaiter.timeout); } };`, context);
  const host = context.host;
  let bounds = { x: 783, y: 12, width: 354, height: 76 }, url = origin + "/app?room=room-old";
  const mainFrame = { url };
  const webContents = {
    mainFrame, getURL: () => url, send: (...args) => calls.push(["send", ...args]),
    session: {
      flushStorageData: async () => calls.push(["flush"]),
      cookies: {
        get: async input => { calls.push(["get-cookie", input]); return [{ name: "qd_session", path: "/", value: "a".repeat(64), expirationDate: 123456789 }]; },
        set: async cookie => calls.push(["set-cookie", cookie]), remove: async (...args) => calls.push(["remove-cookie", ...args]),
      },
    },
  };
  let loadHook;
  const window = {
    isDestroyed: () => false, webContents, isMinimized: () => false, show() { calls.push(["show"]); }, focus() {},
    getBounds: () => bounds, setBounds(next) { bounds = { ...next }; }, setShape() {},
    async loadURL(next) { calls.push(["load", next.startsWith("data:") ? "status" : next]); if (loadHook) await loadHook(next); url = next; mainFrame.url = next; },
  };
  host.setWindow(window);
  t.after(host.cleanup);
  const event = { sender: webContents, senderFrame: mainFrame };
  function layout() { handlers.get("qingdan-desktop:layout")(event, { mode: "island", width: 354, height: 76 }); }
  function report(accountId = target.accountId, roomId = target.roomId) { handlers.get("qingdan-desktop:context")(event, { accountId, roomId }); }
  return { host, calls, event, handlers, listeners, layout, report, setLoadHook(fn) { loadHook = fn; } };
}

test("host stops the old page before setting only the HttpOnly session cookie and waits for matching context plus island", async t => {
  const f = await fixture(t);
  let done = false;
  const pending = f.host.activateHandoff(target, { reuse: false }).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(call => ["flush", "load", "set-cookie"].includes(call[0])).map(call => call[0] === "set-cookie" ? [call[0]] : call), [["flush"], ["load", "status"], ["set-cookie"], ["load", origin + "/app?room=room-new"]]);
  const cookie = f.calls.find(call => call[0] === "set-cookie")[1];
  assert.deepEqual(JSON.parse(JSON.stringify(cookie)), { url: origin, name: "qd_session", value: target.sessionToken, httpOnly: true, secure: false, sameSite: "lax", path: "/" });
  assert.equal(done, false);
  f.report("bob", "room-new"); f.layout();
  await Promise.resolve();
  assert.equal(done, false);
  f.report();
  await pending;
  assert.equal(done, true);
});

test("host reuses an already matching island without navigating or discarding input", async t => {
  const f = await fixture(t);
  f.report(); f.layout();
  await f.host.activateHandoff(target, { reuse: true });
  assert.equal(f.calls.filter(call => call[0] === "load").length, 0);
  assert.equal(f.calls.filter(call => call[0] === "set-cookie").length, 1);
});

test("expired activation leaves both the original page and cookie untouched", async t => {
  for (const reuse of [true, false]) {
    const f = await fixture(t);
    await assert.rejects(f.host.activateHandoff(target, { reuse, ensureActive: async () => { throw Error("交接已过期"); } }), /过期/);
    assert.deepEqual(f.calls, []);
  }
});

test("failed replacement restores the old cookie and previous workspace after stopping the failed page", async t => {
  const f = await fixture(t);
  f.setLoadHook(async url => { if (url.endsWith("room=room-new")) throw Error("unavailable"); });
  await assert.rejects(f.host.activateHandoff(target, { reuse: false }), /未能接入/);
  const changes = f.calls.filter(call => ["load", "set-cookie"].includes(call[0]));
  assert.equal(changes[0][1], "status");
  assert.equal(changes[1][1].value, target.sessionToken);
  assert.equal(changes[3][1], "status");
  assert.equal(changes[4][1].value, "a".repeat(64));
  assert.equal(changes[4][1].expirationDate, 123456789);
  assert.equal(changes[5][1], origin + "/app?room=room-old");
  assert.equal(f.calls.some(call => call[0] === "remove-cookie"), false);
});

test("context IPC rejects foreign frames and malformed identities; save receipts keep validated identity", async t => {
  const f = await fixture(t);
  const report = f.handlers.get("qingdan-desktop:context");
  assert.throws(() => report({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }, { accountId: "alice", roomId: "room-old" }), /Untrusted/);
  assert.throws(() => report(f.event, { accountId: "alice", roomId: "../secret" }));
  assert.equal(report(f.event, { accountId: null, roomId: null }), true);
  const pending = f.host.prepare();
  const sent = f.calls.find(call => call[0] === "send");
  f.listeners.get("qingdan-desktop:prepared-quit")(f.event, { token: sent[2], ok: true, unsynced: true, hasDraft: true, accountId: "alice", roomId: "room-old" });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { ok: true, unsynced: true, hasDraft: true, accountId: "alice", roomId: "room-old" });
});

test("finishing an earlier reconnect cannot clear the queued handoff action lock", async t => {
  const f = await fixture(t);
  const reconnect = f.host.requestSavedAction("reload");
  const transfer = f.host.requestHandoff({ version: 1, endpoint: "http://127.0.0.1:52341", nonce: "c".repeat(64) });
  const firstSave = f.calls.find(call => call[0] === "send");
  f.listeners.get("qingdan-desktop:prepared-quit")(f.event, { token: firstSave[2], ok: true, unsynced: false, hasDraft: false });
  await reconnect;
  await new Promise(resolve => setImmediate(resolve));
  const activeAction = f.host.currentAction();
  const secondSave = f.calls.filter(call => call[0] === "send")[1];
  assert.ok(secondSave);
  f.listeners.get("qingdan-desktop:prepared-quit")(f.event, { token: secondSave[2], ok: false });
  await transfer;
  assert.equal(activeAction, transfer);
});
