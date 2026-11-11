import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "getComputedStyle",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
);
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/opening-cover-ui-", import.meta.url),
);
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});
await build({
  stdin: {
    contents:
      'export {default as OpeningGate} from "./src/opening/OpeningGate.jsx"; export {default as App} from "./src/App.jsx";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  jsx: "automatic",
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "browser-styles",
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "test-css",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const { OpeningGate, App } = await import(
  pathToFileURL(path.join(output, "ui.mjs"))
);

function preference(reduced = false) {
  const listeners = new Set();
  const media = {
    matches: reduced,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    change(value) {
      media.matches = value;
      listeners.forEach((listener) => listener({ matches: value }));
    },
  };
  window.matchMedia = () => media;
  return media;
}
function unauthenticated(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    assert.equal(url, "/api/session");
    return Response.json({ user: null, legacyRoomCount: 0 });
  });
  return requests;
}
async function mount(t, { url = "/", reduced = false, children } = {}) {
  history.replaceState(null, "", url);
  const media = preference(reduced);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(
        OpeningGate,
        null,
        children || React.createElement("button", null, "应用内操作"),
      ),
    ),
  );
  return { host, media };
}
const enter = (host) => host.querySelector(".opening-entry");
const tick = (t, duration = 2000) =>
  act(async () => t.mock.timers.tick(duration));

test("封面持续等待点击，不挂载应用或提前请求账号", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = unauthenticated(t);
  const { host } = await mount(t, { children: React.createElement(App) });
  await tick(t, 10000);
  assert.ok(enter(host));
  assert.equal(host.querySelector("form"), null);
  assert.deepEqual(requests, []);
});

test("点击后只挂载一次真实应用，动画缺少完成事件时仍能进入并恢复焦点", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = unauthenticated(t);
  const { host } = await mount(t, { children: React.createElement(App) });
  const button = enter(host);
  button.focus();
  await act(async () => {
    button.click();
    button.click();
  });
  assert.equal(button.disabled, true);
  assert.ok(host.querySelector("form"));
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    true,
  );
  await tick(t);
  assert.equal(enter(host), null);
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    false,
  );
  assert.ok(
    host.querySelector(".opening-destination").contains(document.activeElement),
  );
  assert.deepEqual(requests, ["/api/session"]);
});

test("减少动态效果仍等待点击，点击后立即开放应用", async (t) => {
  const { host } = await mount(t, { reduced: true });
  assert.ok(enter(host));
  assert.equal(host.querySelector(".opening-destination"), null);
  await act(async () => enter(host).click());
  assert.equal(enter(host), null);
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    false,
  );
});

test("图片加载失败不会绕过点击或阻止进入", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = await mount(t);
  await act(async () =>
    host
      .querySelectorAll("img")
      .forEach((image) => image.dispatchEvent(new Event("error"))),
  );
  assert.ok(enter(host));
  await act(async () => enter(host).click());
  await tick(t);
  assert.equal(enter(host), null);
  assert.equal(
    host.querySelector(".opening-destination").textContent,
    "应用内操作",
  );
});

test("画布邀请链接的查询参数和片段在进入前后保持原样", async (t) => {
  const url = "/?room=shared%20room#invite=one-time%2Btoken";
  const { host } = await mount(t, { url, reduced: true });
  assert.equal(location.pathname + location.search + location.hash, url);
  await act(async () => enter(host).click());
  assert.equal(location.pathname + location.search + location.hash, url);
});

test("OAuth 专用授权页面直接进入原有登录流程", async (t) => {
  const requests = unauthenticated(t);
  const { host } = await mount(t, {
    url: "/mcp/consent?handle=authorization-handle",
    children: React.createElement(App),
  });
  assert.equal(enter(host), null);
  assert.ok(host.querySelector("form"));
  assert.deepEqual(requests, ["/api/session"]);
  assert.equal(location.search, "?handle=authorization-handle");
});

test("进入过程中开启减少动态效果立即完成过渡", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, media } = await mount(t);
  await act(async () => enter(host).click());
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    true,
  );
  await act(async () => media.change(true));
  assert.equal(enter(host), null);
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    false,
  );
});

test("进入动画期间拦截应用的全局快捷键，完成后恢复", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  function ShortcutDestination() {
    const [notes, setNotes] = React.useState(0);
    React.useEffect(() => {
      const shortcut = (event) => {
        if (event.key === "n") setNotes((value) => value + 1);
      };
      document.addEventListener("keydown", shortcut);
      return () => document.removeEventListener("keydown", shortcut);
    }, []);
    return React.createElement("output", null, notes);
  }
  const { host } = await mount(t, {
    children: React.createElement(ShortcutDestination),
  });
  await act(async () => enter(host).click());
  const pressN = () =>
    document.body.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
  await act(async () => pressN());
  assert.equal(host.querySelector("output").textContent, "0");
  await tick(t);
  await act(async () => pressN());
  assert.equal(host.querySelector("output").textContent, "1");
});
