import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/app",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "sessionStorage",
  "localStorage",
  "MouseEvent",
  "Event",
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
  disconnect() {}
};
const { createRoot } = await import("react-dom/client");
let failure,
  claims = 0,
  opened = 0,
  released = 0;
const drafts = new Map();
const errors = [];
window.addEventListener("error", (event) => {
  errors.push(event.error);
  event.preventDefault();
});
window.qingdanDesktop = {
  version: 1,
  setLayout() {},
  hide() {},
  openWorkspace() {},
  onBeforeQuit: () => () => {},
};
globalThis.desktopStartupStorage = {
  claim: async (_scope, id) => {
    claims++;
    if (failure === "claim") throw Error("草稿身份暂时无法锁定");
    return {
      id,
      release() {
        released++;
      },
    };
  },
  open: async () => {
    opened++;
    if (failure === "storage") throw Error("本地存储暂时无法打开");
    return {
      get: async (_store, key) => structuredClone(drafts.get(key)),
      put: async (_store, key, value) =>
        drafts.set(key, structuredClone(value)),
      close() {},
    };
  },
};
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: "snapshot", rows: [] }),
      });
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
};
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/desktop-startup-", import.meta.url),
);
await build({
  stdin: {
    contents:
      'export { default as DesktopIslandWorkspace } from "./src/desktop/DesktopIslandWorkspace.jsx";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "storage-browser-boundaries",
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
          path: "startup-storage",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const claimDraftIdentity=(...args)=>globalThis.desktopStartupStorage.claim(...args); export const openDrafts=()=>globalThis.desktopStartupStorage.open();",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "workspace.mjs"),
});
const { DesktopIslandWorkspace } = await import(
  pathToFileURL(path.join(output, "workspace.mjs"))
);
after(async () => {
  dom.window.close();
  delete globalThis.desktopStartupStorage;
  await rm(output, { recursive: true, force: true });
});
const room = {
  id: "startup-room",
  name: "启动恢复",
  role: "owner",
  createdAt: "2026-11-13T00:00:00Z",
};
const user = { id: "startup-user", name: "桌面用户" };

for (const initialFailure of ["claim", "storage"]) {
  test(`桌面初始化${initialFailure === "claim" ? "身份锁" : "存储"}失败后重试重新创建真实同步工作区`, async (t) => {
    claims = 0;
    opened = 0;
    released = 0;
    errors.length = 0;
    drafts.clear();
    sessionStorage.clear();
    failure = initialFailure;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      failure = null;
      await act(async () => root.unmount());
      host.remove();
    });
    await act(async () =>
      root.render(
        React.createElement(DesktopIslandWorkspace, {
          room,
          user,
          onLeave() {},
        }),
      ),
    );
    assert.ok(host.querySelector(".desktop-loading-card"));
    assert.match(
      host.textContent,
      initialFailure === "claim" ? /身份暂时无法锁定/ : /存储暂时无法打开/,
    );
    assert.equal(claims, 1);
    failure = null;
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "重试",
    );
    assert.ok(retry);
    await act(async () =>
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    assert.equal(
      claims,
      2,
      "retry must repeat initialization rather than call a missing replica",
    );
    assert.ok(host.querySelector('[aria-label="展开轻岛"]'));
    assert.equal(host.querySelector(".desktop-loading-card"), null);
    assert.equal(
      errors.length,
      0,
      "retry must not throw an uncaught TypeError",
    );
    if (initialFailure === "storage")
      assert.equal(
        released,
        1,
        "failed initialization releases its claimed draft identity",
      );
  });
}
