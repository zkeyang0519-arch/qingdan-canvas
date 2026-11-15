import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopPreviewSelected,
  probeInstalledDesktop,
  requestOnlineLaunch,
} from "../src/desktop/online-launch.js";
test("preview selection stays in this tab and never falls back to the installed Electron bridge", async (t) => {
  const previousWindow = globalThis.window,
    previousFetch = globalThis.fetch,
    storage = new Map(),
    calls = [];
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });
  globalThis.window = {
    location: { href: "https://todo.zky.lol/app?desktop=tauri-preview" },
    sessionStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  };
  assert.equal(desktopPreviewSelected(), true);
  window.location.href = "https://todo.zky.lol/app?room=board";
  assert.equal(desktopPreviewSelected(), true);
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === "/api/desktop/handoff")
      return Response.json({ ticket: "a".repeat(64) });
    if (url.endsWith("prepare"))
      return Response.json({
        requestId: "a".repeat(32),
        challenge: "b".repeat(64),
      });
    if (url.endsWith("launch"))
      return Response.json({ started: true, applied: true });
    return Response.json({ protocol: 1 });
  };
  const signal = new AbortController().signal;
  await probeInstalledDesktop(signal);
  await requestOnlineLaunch("alice", "room-a", signal);
  assert.ok(
    calls
      .filter((u) => u.startsWith("http"))
      .every((u) => u.startsWith("http://127.0.0.1:8792/")),
  );
  window.location.href = "https://todo.zky.lol/app?desktop=stable";
  assert.equal(desktopPreviewSelected(), false);
  await probeInstalledDesktop(signal);
  assert.ok(calls.at(-1).startsWith("http://127.0.0.1:8791/"));
});
