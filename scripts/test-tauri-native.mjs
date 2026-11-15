// Run after tauri-acceptance-server.mjs and a test-harness build with the
// cn.zky.qingdao.acceptance identifier. Never use a production profile here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { build } from "esbuild";
const exe = path.resolve(
  process.argv[2] || ".tmp/tauri-acceptance/Qingdao-Acceptance.exe",
);
const origin = "http://127.0.0.1:18788",
  local = "http://127.0.0.1:8792/api/local-desktop/online/";
const profile = await fs.mkdtemp(path.resolve(".tmp/tauri-native-profile-"));
const results = [],
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
let app, c;
const waitFor = async (fn, message, count = 120) => {
  for (let i = 0; i < count; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await pause(100);
  }
  throw Error(message);
};
async function connect() {
  const pages = await (await fetch("http://127.0.0.1:19446/json")).json();
  const page = pages.find(
    (p) =>
      p.type === "page" &&
      (p.url.startsWith(origin) || p.url.includes("tauri.localhost")),
  );
  if (!page) throw Error("No acceptance WebView");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description ||
          JSON.stringify(r.exceptionDetails),
      );
    return r.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
async function start(resume = false, directory = profile) {
  const env = {
    ...process.env,
    QINGDAO_TEST_DATA_DIR: directory,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19446",
  };
  if (!resume) env.QINGDAO_PREVIEW_URL = origin + "/app";
  else delete env.QINGDAO_PREVIEW_URL;
  app = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  app.on("error", (e) => console.error(e.message));
  c = await waitFor(connect, "Application did not open");
  await waitFor(() => c.evaluate("!!window.qingdanDesktop"), "Bridge missing");
}
const invoke = (op, data = null) =>
  c.evaluate(
    `window.__TAURI_INTERNALS__.invoke('desktop',${JSON.stringify({ op, data })})`,
  );
const text = () => c.evaluate("document.body.innerText");
const identity = () =>
  c.evaluate("fetch('/api/session').then(r=>r.json()).then(r=>r.user?.id)");
async function stop() {
  const exited = new Promise((r) => app.once("exit", r));
  void invoke("test_exit").catch(() => {});
  await Promise.race([
    exited,
    pause(12000).then(() => {
      throw Error("Saved exit timed out");
    }),
  ]);
  c.close();
  c = null;
  await pause(500);
}
async function native(route, body, site = origin) {
  return fetch(local + route, {
    method: "POST",
    headers: {
      Origin: site,
      "Content-Type": "application/json",
      "X-Qingdan-Local": "1",
    },
    body: JSON.stringify(body),
  });
}
async function handoff(account = "alice", room = "room-a") {
  const prepared = await (
    await native("prepare", { accountId: account, roomId: room })
  ).json();
  assert.ok(prepared.challenge);
  const grant = await (
    await fetch(origin + "/api/desktop/handoff", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: `qd_session=${(account === "alice" ? "a" : "b").repeat(64)}`,
        "X-QD-Account": account,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId: room, challenge: prepared.challenge }),
    })
  ).json();
  assert.ok(grant.ticket);
  const response = await native("launch", {
    requestId: prepared.requestId,
    ticket: grant.ticket,
  });
  return {
    status: response.status,
    body: await response.json(),
    prepared,
    grant,
  };
}
async function input(value) {
  await c.evaluate(
    `document.querySelector('textarea').focus();document.querySelector('textarea').select()`,
  );
  if (value) await c.send("Input.insertText", { text: value });
  else {
    await c.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await c.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }
  await pause(150);
}
const pass = (name) => {
  results.push(name);
  console.log("PASS", name);
};
try {
  await start();
  assert.equal((await invoke("check_update")).status, "unsupported");
  const launch = await handoff();
  assert.equal(launch.status, 200, JSON.stringify(launch.body));
  await waitFor(
    async () => /验证账号 A的初始待办/.test(await text()),
    "Real room not rendered",
  );
  assert.equal(await identity(), "alice");
  assert.ok(!(await c.evaluate("document.cookie")).includes("qd_session"));
  assert.equal(
    (
      await native("launch", {
        requestId: launch.prepared.requestId,
        ticket: launch.grant.ticket,
      })
    ).status,
    410,
  );
  assert.equal(
    (
      await native(
        "status",
        { requestId: launch.prepared.requestId },
        "https://todo.zky.lol",
      )
    ).status,
    404,
  );
  pass(
    "native handoff / verified account and room / HttpOnly cookie / one-use ownership",
  );
  await c.evaluate(
    `document.querySelector('[aria-label="钉住轻岛"]')?.click()`,
  );
  await waitFor(
    () => c.evaluate("!!document.querySelector('textarea')"),
    "Input unavailable",
  );
  await input("交接后真实同步新增");
  await c.evaluate(`document.querySelector('[aria-label="添加待办"]').click()`);
  await waitFor(
    async () =>
      JSON.stringify(
        await (
          await fetch(origin + "/api/rooms/room-a/snapshot", {
            headers: {
              Cookie: "qd_session=" + "a".repeat(64),
              "X-QD-Account": "alice",
            },
          })
        ).json(),
      ).includes("交接后真实同步新增"),
    "Task not synced to real Worker",
  );
  pass("desktop edit persisted through real WebSocket/DO snapshot");
  await input("同账号交接和重启必须保留");
  await c.evaluate("window.__handoffMarker='unchanged'");
  assert.equal((await handoff()).status, 200);
  assert.equal(await c.evaluate("window.__handoffMarker"), "unchanged");
  assert.equal(
    await c.evaluate("document.querySelector('textarea').value"),
    "同账号交接和重启必须保留",
  );
  pass("same-account same-room handoff preserves renderer and pending input");
  await stop();
  await start(true);
  await waitFor(
    () =>
      c.evaluate(
        "document.querySelector('textarea')?.value === '同账号交接和重启必须保留'",
      ),
    "Restart did not restore draft",
  );
  assert.equal(await identity(), "alice");
  assert.ok((await c.evaluate("location.href")).endsWith("room=room-a"));
  pass("saved process exit and restart restores login, room and input");
  const portable = (
    await build({
      entryPoints: ["desktop/portable-state.mjs"],
      bundle: true,
      format: "iife",
      globalName: "QingdaoPortable",
      write: false,
    })
  ).outputFiles[0].text;
  await c.evaluate(portable);
  const backup = await c.evaluate("QingdaoPortable.exportPortable('alice')");
  await input("");
  await pause(500);
  await fetch(origin + "/__fixture/fail-b");
  assert.equal((await handoff("bob", "room-b")).status, 503);
  await waitFor(
    async () => (await identity()) === "alice",
    "Failed handoff did not roll back account",
  );
  assert.ok((await c.evaluate("location.href")).endsWith("room=room-a"));
  await fetch(origin + "/__fixture/reset");
  pass("failed cross-account navigation rolls back cookie and original room");
  assert.equal((await handoff("bob", "room-b")).status, 200);
  assert.equal(await identity(), "bob");
  await c.evaluate(
    "window.qingdanDesktop.onBeforeQuit(async()=>{throw Error('fixture disk full')})",
  );
  const refused = await invoke("test_exit").then(
    () => false,
    () => true,
  );
  assert.equal(refused, true);
  await c.send("Page.reload");
  await waitFor(
    () => c.evaluate("!!document.querySelector('.dynamic-island')"),
    "Reload failed",
  );
  pass("successful account switch and save failure prevents exit");
  await stop();
  const importProfile = await fs.mkdtemp(
    path.resolve(".tmp/tauri-import-profile-"),
  );
  await start(false, importProfile);
  await c.send("Network.setCookie", {
    name: "qd_session",
    value: "a".repeat(64),
    url: origin,
    path: "/",
    httpOnly: true,
    expires: Math.floor(Date.now() / 1000) + 3600,
  });
  await c.send("Page.reload");
  await waitFor(
    async () => (await identity()) === "alice",
    "Import account login failed",
  );
  await c.evaluate(portable);
  const imported = await c.evaluate(
    `QingdaoPortable.importPortable(${JSON.stringify(backup)},'alice')`,
  );
  assert.ok(imported.drafts > 0);
  assert.ok(imported.inputs > 0);
  const again = await c.evaluate(
    `QingdaoPortable.importPortable(${JSON.stringify(backup)},'alice')`,
  );
  assert.equal(again.drafts, 0);
  await c.send("Page.navigate", { url: origin + "/app?room=room-a" });
  await waitFor(
    () =>
      c.evaluate(
        "document.querySelector('textarea')?.value === '同账号交接和重启必须保留'",
      ),
    "Imported input not recovered",
  );
  pass(
    "portable native IndexedDB/localStorage import is idempotent and restores input",
  );
  await fs.mkdir("output/tauri-preview2", { recursive: true });
  await fs.writeFile(
    "output/tauri-preview2/native-account.png",
    Buffer.from(
      (await c.send("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await stop();
  await fs.writeFile(
    "output/tauri-preview2/native-acceptance.json",
    JSON.stringify(
      { passed: results, profile, date: new Date().toISOString() },
      null,
      2,
    ),
  );
} finally {
  c?.close();
  // Only this script's isolated acceptance child is stopped on failure.
  if (app?.exitCode === null) app.kill();
}
