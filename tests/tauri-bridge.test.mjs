import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
const source = (
  await build({
    entryPoints: ["desktop/tauri-bridge.js"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  })
).outputFiles[0].text;
function fixture(pathname = "/app") {
  const calls = [],
    listeners = new Map();
  const info = {
    work: { x: 0, y: 0, width: 1920, height: 1040 },
    bounds: { x: 803, y: 0, width: 314, height: 64 },
    cursor: { x: 960, y: 15 },
  };
  const window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, payload) => {
        calls.push(payload);
        if (payload.op === "geometry") return structuredClone(info);
        if (payload.op === "bounds") info.bounds = payload.data.bounds;
      },
    },
    __TAURI__: { event: { listen: (name, cb) => listeners.set(name, cb) } },
  };
  window.top = window;
  vm.runInNewContext(source, {
    window,
    location: { pathname },
    setTimeout,
    console,
  });
  return { bridge: window.qingdanDesktop, calls, listeners, info };
}
test("bridge only attaches to main app or explicit verification page", () => {
  assert.equal(fixture("/").bridge, undefined);
  assert.equal(fixture("/tauri-preview.html").bridge.version, 1);
});
test("expanded jade shape leaves the gap between two panes clickable through", async () => {
  const f = fixture();
  await f.bridge.setLayout({
    mode: "island",
    dock: "top",
    appearance: "jade",
    expanded: true,
    width: 370,
    height: 400,
  });
  const { rects } = f.calls.filter((c) => c.op === "bounds").at(-1).data;
  assert.ok(rects.some((r) => r.y === 20));
  assert.ok(rects.some((r) => r.y === 90));
  assert.ok(!rects.some((r) => r.y <= 60 && r.y + r.height > 60));
  await assert.rejects(
    f.bridge.setLayout({ mode: "island", width: 99999, height: 400 }),
  );
});
test("drag changes dock, persists placement and preserves serialized geometry", async () => {
  const f = fixture();
  await f.bridge.setLayout({
    mode: "island",
    appearance: "jade",
    dock: "top",
    expanded: false,
    width: 314,
    height: 64,
  });
  await f.bridge.drag("start", { x: 60, y: 30 });
  f.info.cursor = { x: 1800, y: 600 };
  await f.bridge.drag("move");
  const result = await f.bridge.drag("end");
  assert.equal(result.dock, "right");
  assert.equal(result.dragging, false);
  assert.equal(
    f.calls.find((c) => c.op === "save_position").data.dock,
    "right",
  );
});
test("quit acknowledgement waits for local save and reports failures", async () => {
  const f = fixture();
  f.bridge.onBeforeQuit(async () => ({
    hasDraft: true,
    draftsPersisted: true,
  }));
  await f.listeners.get("prepare-save")({ payload: "save-token" });
  assert.equal(f.calls.at(-1).data.token, "save-token");
  assert.equal(f.calls.at(-1).data.draftsPersisted, true);
  f.bridge.onBeforeQuit(async () => {
    throw Error("disk full");
  });
  await f.listeners.get("prepare-save")({ payload: "failed-token" });
  assert.equal(f.calls.at(-1).data.ok, false);
  f.bridge.onBeforeQuit(async () => ({ ok: false }));
  await f.listeners.get("prepare-save")({ payload: "refused-token" });
  assert.equal(f.calls.at(-1).data.ok, false);
});

test("missing save handler is explicit and update events reach the existing UI contract", async () => {
  const f = fixture();
  await f.listeners.get("prepare-save")({ payload: "startup-token" });
  assert.equal(
    f.calls.find((c) => c.op === "saved" && c.data.token === "startup-token")
      .data.missingHandler,
    true,
  );
  const states = [];
  f.bridge.onUpdateState((s) => states.push(s));
  f.listeners.get("update-state")({
    payload: { status: "downloaded", version: "0.4.1" },
  });
  assert.equal(states[0].version, "0.4.1");
  await f.bridge.checkForUpdates();
  assert.equal(f.calls.at(-1).op, "check_update");
  await f.bridge.installUpdate();
  assert.equal(f.calls.at(-1).op, "install_update");
});
