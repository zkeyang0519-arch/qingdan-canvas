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
  url: "http://127.0.0.1:8790/app",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "NodeFilter",
  "sessionStorage",
  "localStorage",
  "location",
  "history",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 5);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
HTMLElement.prototype.scrollIntoView = function () {};
const { createRoot } = await import("react-dom/client");
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  constructor() {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = 3;
  }
};
const saved = new Map();
let storageGate;
globalThis.desktopOpeningStorage = {
  claim: async (_scope, id) => ({ id, release() {} }),
  open: async () => {
    if (storageGate) await storageGate;
    return {
      get: async (_store, key) => structuredClone(saved.get(key)),
      put: async (_store, key, value) => saved.set(key, structuredClone(value)),
      close() {},
    };
  },
};
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/desktop-opening-ui-", import.meta.url),
);
await build({
  stdin: {
    contents: 'export { default as App } from "./src/App.jsx";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "local-browser-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
        builder.onResolve({ filter: /\/drafts\.js$/ }, () => ({
          path: "opening-storage",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const claimDraftIdentity=(...args)=>globalThis.desktopOpeningStorage.claim(...args); export const openDrafts=()=>globalThis.desktopOpeningStorage.open();",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "app.mjs"),
});
const { App } = await import(pathToFileURL(path.join(output, "app.mjs")));
after(async () => {
  dom.window.close();
  delete globalThis.desktopOpeningStorage;
  await rm(output, { recursive: true, force: true });
});
const user = { id: "handoff-user", name: "网页用户", username: "same-user" };
const room = {
  id: "handoff-room",
  name: "当前画布",
  role: "owner",
  createdAt: "2026-11-14T00:00:00Z",
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function mount(
  t,
  {
    query = "?room=handoff-room",
    session,
    selectedRoom,
    gate,
    cached = false,
    contextResult,
  } = {},
) {
  dom.reconfigure({ url: `http://127.0.0.1:8790/app${query}` });
  sessionStorage.clear();
  localStorage.clear();
  saved.clear();
  const note = {
    ...createObject(room.id, "note"),
    noteKind: "checklist",
    blocks: [makeBlock("缓存中尚未确认的待办")],
  };
  const rows = cached
    ? [{ id: note.id, revision: 1, deleted: false, data: note }]
    : [];
  if (cached)
    saved.set(`${user.id}/${room.id}/desktop-v1`, {
      replica: { version: 1, base: rows, objects: [note], flight: null },
    });
  sockets.length = 0;
  storageGate = gate;
  const calls = { layouts: [], contexts: [], quit: null };
  window.qingdanDesktop = {
    version: 1,
    setLayout: (value) => {
      calls.layouts.push(value);
      return Promise.resolve({ maxHeight: 900 });
    },
    setContext: (value) => {
      calls.contexts.push(value);
      if (value.accountId && contextResult) return contextResult(value);
      return Promise.resolve(true);
    },
    hide() {},
    openWorkspace() {},
    onBeforeQuit: (handler) => {
      calls.quit = handler;
      return () => {
        if (calls.quit === handler) calls.quit = null;
      };
    },
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "/api/session")
      return session ? await session : Response.json({ user });
    if (url === "/api/rooms") return Response.json({ rooms: [room] });
    if (url.startsWith("/api/rooms/"))
      return selectedRoom
        ? await selectedRoom
        : Response.json({
            room: { ...room, id: url.slice("/api/rooms/".length) },
          });
    throw Error(`Unexpected request: ${url}`);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(App)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.qingdanDesktop;
  });
  let scope = 0;
  return {
    host,
    calls,
    rows,
    navigate: async (nextRoom) => {
      dom.reconfigure({ url: `http://127.0.0.1:8790/app?room=${nextRoom}` });
      await act(async () =>
        root.render(React.createElement(App, { key: ++scope })),
      );
    },
  };
}
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
}
async function click(element) {
  assert.ok(element);
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

test("网页交接从session到room和草稿读取一直保持小胶囊，snapshot后才报告目标上下文", async (t) => {
  const session = deferred(),
    selectedRoom = deferred(),
    storage = deferred();
  const { host, calls } = await mount(t, {
    session: session.promise,
    selectedRoom: selectedRoom.promise,
    gate: storage.promise,
  });
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(
    calls.layouts.some((layout) => layout.mode === "setup"),
    false,
  );
  await act(async () => session.resolve(Response.json({ user })));
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".home"), null);
  await act(async () => selectedRoom.resolve(Response.json({ room })));
  await settle();
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(
    calls.layouts.every(
      (layout) =>
        layout.mode === "island" &&
        layout.width === 354 &&
        layout.height === 76,
    ),
    true,
  );
  await act(async () => storage.resolve());
  assert.equal(
    calls.contexts.some((context) => context.accountId),
    false,
    "room data alone is not a ready replica",
  );
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows: [] }) }),
  );
  await settle();
  assert.deepEqual(calls.contexts.at(-1), {
    accountId: user.id,
    roomId: room.id,
  });
  assert.ok(host.querySelector('[aria-label="展开轻岛"]'));
  assert.equal(
    calls.layouts.some((layout) => layout.mode === "setup"),
    false,
  );
  assert.deepEqual(await calls.quit(), {
    unsynced: false,
    hasDraft: false,
    draftsPersisted: true,
    accountId: user.id,
    roomId: room.id,
  });
  await click(host.querySelector('[aria-label="展开轻岛"]'));
  await click(host.querySelector('[aria-label="返回画布列表"]'));
  assert.ok(host.querySelector(".home"));
  assert.equal(calls.layouts.at(-1).mode, "setup");
  assert.deepEqual(calls.contexts.at(-1), { accountId: null, roomId: null });
});

test("网页交接账号缺失保持小错误胶囊，不转到登录页", async (t) => {
  const { host, calls } = await mount(t, {
    session: Promise.resolve(Response.json({ user: null })),
  });
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".auth-page"), null);
  assert.match(host.textContent, /回到网页/);
  assert.ok(host.querySelector('[aria-label="重试打开轻岛"]'));
  assert.equal(
    calls.layouts.some((layout) => layout.mode === "setup"),
    false,
  );
  assert.deepEqual(calls.contexts.at(-1), { accountId: null, roomId: null });
});

test("网页交接画布失败显示原错误并可重试，不闪现画布选择页", async (t) => {
  const { host, calls } = await mount(t, {
    selectedRoom: Promise.resolve(
      Response.json({ error: "当前账号无权访问此画布" }, { status: 403 }),
    ),
  });
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".home"), null);
  assert.match(host.textContent, /当前账号无权访问此画布/);
  assert.ok(host.querySelector('[aria-label="重试打开轻岛"]'));
  assert.equal(
    calls.layouts.some((layout) => layout.mode === "setup"),
    false,
  );
});

test("普通CLI无room仍保留大窗登录流程", async (t) => {
  const { host, calls } = await mount(t, {
    query: "",
    session: Promise.resolve(Response.json({ user: null, legacyRoomCount: 0 })),
  });
  assert.equal(host.querySelector(".desktop-opening-capsule"), null);
  assert.ok(host.querySelector(".auth-page"));
  assert.equal(calls.layouts.at(-1).mode, "setup");
});

test("交接已有缓存但socket未就绪或断开时仍只显示无输入的小胶囊", async (t) => {
  const { host, calls } = await mount(t, { cached: true });
  await settle();
  assert.ok(
    sockets.length,
    "cached state has loaded and socket connection has started",
  );
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".dynamic-island, textarea, input"), null);
  assert.equal(
    calls.contexts.some((context) => context.accountId),
    false,
  );
  await act(async () => sockets.at(-1).onclose({ code: 1006 }));
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".dynamic-island, textarea, input"), null);
  assert.ok(
    calls.layouts.every(
      (layout) =>
        layout.mode === "island" &&
        layout.width === 354 &&
        layout.height === 76,
    ),
  );
});

test("交接snapshot就绪但主进程context确认未返回时不可输入", async (t) => {
  const ack = deferred();
  const { host, rows } = await mount(t, {
    cached: true,
    contextResult: () => ack.promise,
  });
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows }) }),
  );
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".dynamic-island, textarea, input"), null);
  await act(async () => ack.resolve(true));
  assert.equal(host.querySelector(".desktop-opening-capsule"), null);
  await click(host.querySelector('[aria-label="展开轻岛"]'));
  assert.ok(host.querySelector("textarea"));
  assert.match(host.textContent, /缓存中尚未确认的待办/);
});

test("context确认失败保持小错误胶囊，重试成功后才开放输入", async (t) => {
  const ack = deferred();
  let attempts = 0;
  const { host, rows } = await mount(t, {
    cached: true,
    contextResult: () =>
      ++attempts === 1 ? ack.promise : Promise.resolve(true),
  });
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows }) }),
  );
  await act(async () => ack.reject(Error("桌面连接暂时失败")));
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".dynamic-island, textarea, input"), null);
  assert.match(host.textContent, /桌面连接暂时失败/);
  await click(host.querySelector('[aria-label="重试打开轻岛"]'));
  assert.equal(host.querySelector(".dynamic-island"), null);
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows }) }),
  );
  assert.ok(host.querySelector('[aria-label="展开轻岛"]'));
});

test("旧画布迟到的context确认不会解锁新画布输入", async (t) => {
  const oldAck = deferred(),
    nextAck = deferred();
  const { host, navigate } = await mount(t, {
    contextResult: (context) =>
      context.roomId === room.id ? oldAck.promise : nextAck.promise,
  });
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows: [] }) }),
  );
  await navigate("next-room");
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({ data: JSON.stringify({ type: "snapshot", rows: [] }) }),
  );
  await act(async () => oldAck.resolve(true));
  assert.ok(host.querySelector(".desktop-opening-capsule"));
  assert.equal(host.querySelector(".dynamic-island, textarea, input"), null);
  await act(async () => nextAck.resolve(true));
  assert.ok(host.querySelector('[aria-label="展开轻岛"]'));
});
