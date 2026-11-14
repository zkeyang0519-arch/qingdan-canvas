import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createObject, makeBlock } from "../src/canvas/model.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "sessionStorage"])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const drafts = new Map();
let writesFail = false, online = true, lastWorkspace, writeGate;
const claims = [];
globalThis.desktopDraftFixture = {
  claim: async (scope, id) => { claims.push({ scope, id }); return { id, release() {} }; },
  open: async () => ({
    get: async (_store, key) => structuredClone(drafts.get(key)),
    put: async (_store, key, value) => {
      if (writesFail) throw Error("测试存储已满");
      if (writeGate) await writeGate;
      drafts.set(key, structuredClone(value));
    },
    close() {},
  }),
};
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = online ? 1 : 0;
  constructor() {
    if (online) queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: "snapshot", rows: [] }) });
    });
  }
  send() {}
  close() { this.readyState = 3; }
};
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(new URL("../.tmp/desktop-sync-", import.meta.url));
await build({
  stdin: {
    contents: 'export { useRoomWorkspace } from "./src/sync/useRoomWorkspace.js";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [{ name: "draft-storage", setup(builder) {
    builder.onResolve({ filter: /\/drafts\.js$/ }, () => ({ path: "draft-fixture", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: "export const claimDraftIdentity=(...args)=>globalThis.desktopDraftFixture.claim(...args); export const openDrafts=()=>globalThis.desktopDraftFixture.open();",
      loader: "js",
    }));
  } }],
  outfile: path.join(output, "hook.mjs"),
});
const { useRoomWorkspace } = await import(pathToFileURL(path.join(output, "hook.mjs")));
after(async () => {
  dom.window.close();
  delete globalThis.desktopDraftFixture;
  await rm(output, { recursive: true, force: true });
});
const room = { id: "desktop-sync-room", name: "工作清单", role: "owner", createdAt: "2026-11-13T00:00:00Z" };
const user = { id: "desktop-user", name: "桌面用户" };
function Probe({ identity, selectedRoom = room, account = user }) {
  lastWorkspace = useRoomWorkspace(selectedRoom, account, { draftIdentity: identity });
  return null;
}
async function mount(props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe, props)));
  return async () => { await act(async () => root.unmount()); host.remove(); };
}
function reset() {
  drafts.clear(); claims.length = 0; sessionStorage.clear(); online = true; writesFail = false; writeGate = null;
}

test("桌面草稿身份在窗口重建后恢复未同步待办，并按账号和画布隔离", async () => {
  reset();
  let dispose = await mount({ identity: "desktop-v1" });
  try {
    assert.deepEqual(claims.at(-1), { scope: `${user.id}/${room.id}`, id: "desktop-v1" });
    const note = { ...createObject(room.id, "note"), noteKind: "checklist", blocks: [makeBlock("重启后仍保留")] };
    await act(async () => lastWorkspace.update(current => ({ ...current, objects: [...current.objects, note] })));
    await act(async () => lastWorkspace.flushLocal());
    assert.ok(drafts.get(`${user.id}/${room.id}/desktop-v1`).replica.objects.some(item => item.id === note.id));
    await dispose(); dispose = null;
    sessionStorage.clear(); online = false;
    dispose = await mount({ identity: "desktop-v1" });
    assert.ok(lastWorkspace.state.objects.some(item => item.id === note.id));
    assert.equal(lastWorkspace.dirty, true);
    await dispose(); dispose = null;
    dispose = await mount({ identity: "desktop-v1", account: { ...user, id: "other-user" } });
    assert.equal(lastWorkspace.state.objects.length, 0);
    await dispose(); dispose = null;
    dispose = await mount({ identity: "desktop-v1", selectedRoom: { ...room, id: "other-room" } });
    assert.equal(lastWorkspace.state.objects.length, 0);
  } finally { if (dispose) await dispose(); }
});

test("退出前显式保存等待写入完成并向调用方报告保存失败", async () => {
  reset();
  const dispose = await mount({ identity: "desktop-v1" });
  try {
    assert.equal(typeof lastWorkspace.flushLocal, "function");
    writesFail = true;
    await assert.rejects(lastWorkspace.flushLocal(), /测试存储已满/);
    writesFail = false;
    let release;
    writeGate = new Promise(resolve => { release = resolve; });
    let completed = false;
    const saving = lastWorkspace.flushLocal().then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(completed, false);
    release();
    await saving;
    writeGate = null;
    assert.equal(completed, true);
    assert.ok(drafts.has(`${user.id}/${room.id}/desktop-v1`));
  } finally { writesFail = false; await dispose(); }
});

test("普通网页继续使用标签页身份，桌面固定身份不覆盖网页标签页记录", async () => {
  reset();
  const key = `qingdan.cloud.tab.${room.id}`;
  sessionStorage.setItem(key, "browser-tab");
  let dispose = await mount({ identity: "desktop-v1" });
  try {
    assert.equal(sessionStorage.getItem(key), "browser-tab");
    await dispose(); dispose = null;
    dispose = await mount({});
    assert.equal(claims.at(-1).id, "browser-tab");
  } finally { if (dispose) await dispose(); }
});
