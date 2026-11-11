import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createObject } from "../src/canvas/model.js";

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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
let frameId = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent = [];
  constructor() {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(value) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  snapshot(objects = []) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        rows: objects.map((data) => ({
          id: data.id,
          revision: 1,
          deleted: false,
          data,
        })),
      }),
    });
  }
};
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
      'export {default as OpeningGate} from "./src/opening/OpeningGate.jsx"; export {default as OpeningPreparation} from "./src/opening/OpeningPreparation.jsx"; export {default as App} from "./src/App.jsx"; export {setActiveAccount} from "./src/api.js";',
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
        build.onResolve({ filter: /\/drafts\.js$/ }, (args) => ({
          path: args.path,
          namespace: "test-drafts",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-drafts" }, () => ({
          contents: `export const claimDraftIdentity = async (_scope, id) => ({id, release() {}});
          export const openDrafts = async () => ({ async get(store) { return store === "drafts" ? globalThis.openingDraft : undefined; }, async put(...args) { globalThis.openingDraftWrite?.(...args); }, close() {} });`,
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const { OpeningGate, OpeningPreparation, App, setActiveAccount } = await import(
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
const user = { id: "opening-user", name: "测试账号", username: "opening" };
const room = {
  id: "opening-room",
  name: "测试画布",
  role: "owner",
  createdAt: "2026-11-11T00:00:00.000Z",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function apiFixture(t, { loggedIn = false, intercept } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    requests.push({ url, options });
    const delayed = intercept?.(url, requests);
    if (delayed) return delayed;
    if (url === "/api/session")
      return Response.json({
        user: loggedIn ? user : null,
        legacyRoomCount: 0,
      });
    if (url === "/api/rooms") return Response.json({ rooms: [room] });
    if (url === "/api/rooms/opening-room") return Response.json({ room });
    if (url === "/api/rooms/opening-room/join") return Response.json({ room });
    throw new Error(`Unexpected request: ${url}`);
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
    frames.clear();
    sockets.length = 0;
    globalThis.openingDraft = undefined;
    globalThis.openingDraftWrite = undefined;
    setActiveAccount(null);
  });
  await act(async () =>
    root.render(
      React.createElement(
        OpeningGate,
        null,
        children || React.createElement(App),
      ),
    ),
  );
  return { host, media };
}
const enter = (host) => host.querySelector(".opening-entry");
const tick = (t, duration = 2000) =>
  act(async () => t.mock.timers.tick(duration));
const paint = async () => {
  for (let i = 0; i < 2; i++)
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    });
};
const click = (element) => act(async () => element.click());
const coverStatus = (host) =>
  host.querySelector(".opening-cover")?.dataset.status;
const paths = (requests) => requests.map((item) => item.url);

test("封面出现时立即预加载，慢会话期间禁用进入且隐藏背景", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = deferred();
  const requests = apiFixture(t, { intercept: () => session.promise });
  const { host } = await mount(t);
  assert.deepEqual(paths(requests), ["/api/session"]);
  assert.equal(enter(host).disabled, true);
  assert.equal(coverStatus(host), "loading");
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    true,
  );
  assert.equal(
    host.querySelector(".opening-destination").getAttribute("aria-hidden"),
    "true",
  );
  await click(enter(host));
  await tick(t, 3000);
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "waiting");
  await act(async () => session.resolve(Response.json({ user: null })));
  assert.ok(host.querySelector("form"));
  assert.equal(enter(host).disabled, true, "DOM 已提交仍需等绘制完成");
  await paint();
  assert.equal(enter(host).disabled, false);
  assert.equal(coverStatus(host), "ready");
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "waiting");
});

test("点击直接揭示已准备好的同一页面，不重复请求、不再出现加载页并恢复焦点", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = apiFixture(t);
  const { host } = await mount(t);
  await paint();
  const form = host.querySelector("form");
  assert.ok(form);
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
  assert.equal(host.querySelector("form"), form);
  assert.equal(host.querySelector(".loading-screen"), null);
  assert.deepEqual(paths(requests), ["/api/session"]);
});

test("减少动态效果仍等待点击，点击后立即开放应用", async (t) => {
  apiFixture(t);
  const { host } = await mount(t, { reduced: true });
  assert.ok(enter(host));
  assert.equal(enter(host).disabled, true);
  await click(enter(host));
  assert.ok(enter(host));
  await paint();
  await act(async () => enter(host).click());
  assert.equal(enter(host), null);
  assert.equal(
    host.querySelector(".opening-destination").hasAttribute("inert"),
    false,
  );
});

test("图片加载失败不会绕过点击或阻止进入", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  apiFixture(t);
  const { host } = await mount(t);
  await act(async () =>
    host
      .querySelectorAll("img")
      .forEach((image) => image.dispatchEvent(new Event("error"))),
  );
  assert.ok(enter(host));
  await paint();
  await act(async () => enter(host).click());
  await tick(t);
  assert.equal(enter(host), null);
  assert.ok(host.querySelector("form"));
});

test("未登录的画布邀请链接在预加载和进入后保持原样", async (t) => {
  apiFixture(t);
  const url = "/?room=shared%20room#invite=one-time%2Btoken";
  const { host } = await mount(t, { url, reduced: true });
  assert.equal(location.pathname + location.search + location.hash, url);
  await paint();
  await act(async () => enter(host).click());
  assert.equal(location.pathname + location.search + location.hash, url);
});

test("OAuth 专用授权页面直接进入原有登录流程", async (t) => {
  const requests = apiFixture(t);
  const { host } = await mount(t, {
    url: "/mcp/consent?handle=authorization-handle",
    children: React.createElement(App),
  });
  assert.equal(enter(host), null);
  assert.ok(host.querySelector("form"));
  assert.deepEqual(paths(requests), ["/api/session"]);
  assert.equal(location.search, "?handle=authorization-handle");
});

test("进入过程中开启减少动态效果立即完成过渡", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  apiFixture(t);
  const { host, media } = await mount(t);
  await paint();
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

test("预加载、就绪等待及进入动画都拦截全局快捷键和粘贴，完成后恢复", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  apiFixture(t);
  function ShortcutDestination() {
    const [notes, setNotes] = React.useState(0);
    React.useEffect(() => {
      const shortcut = (event) => {
        if (event.key === "n") setNotes((value) => value + 1);
      };
      document.addEventListener("keydown", shortcut);
      const paste = () => setNotes((value) => value + 1);
      document.addEventListener("paste", paste);
      return () => {
        document.removeEventListener("keydown", shortcut);
        document.removeEventListener("paste", paste);
      };
    }, []);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(App),
      React.createElement("output", null, notes),
    );
  }
  const { host } = await mount(t, {
    children: React.createElement(ShortcutDestination),
  });
  const pressN = () =>
    document.body.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
  const sendInputs = () =>
    act(async () => {
      pressN();
      document.body.dispatchEvent(new Event("paste", { bubbles: true }));
    });
  await sendInputs();
  assert.equal(host.querySelector("output").textContent, "0");
  await paint();
  await sendInputs();
  assert.equal(host.querySelector("output").textContent, "0");
  await click(enter(host));
  await sendInputs();
  assert.equal(host.querySelector("output").textContent, "0");
  await tick(t);
  await sendInputs();
  assert.equal(host.querySelector("output").textContent, "2");
});

test("登录后的首页必须等待画布列表，不把空列表当成加载完成", async (t) => {
  const rooms = deferred();
  const requests = apiFixture(t, {
    loggedIn: true,
    intercept: (url) => url === "/api/rooms" && rooms.promise,
  });
  const { host } = await mount(t, { reduced: true });
  await paint();
  assert.deepEqual(paths(requests), ["/api/session", "/api/rooms"]);
  assert.equal(enter(host).disabled, true);
  await act(async () => rooms.resolve(Response.json({ rooms: [room] })));
  await paint();
  assert.equal(coverStatus(host), "ready");
  await click(enter(host));
  assert.ok(host.querySelector(".room-card"));
  assert.equal(host.querySelector(".loading-screen"), null);
});

test("准备期间窗口重新获得焦点不重复请求会话或中断正在加载的账号", async (t) => {
  const session = deferred();
  const rooms = deferred();
  const requests = apiFixture(t, {
    loggedIn: true,
    intercept: (url) =>
      url === "/api/session"
        ? session.promise
        : url === "/api/rooms"
          ? rooms.promise
          : undefined,
  });
  const { host } = await mount(t);
  await act(async () => window.dispatchEvent(new Event("focus")));
  assert.deepEqual(paths(requests), ["/api/session"]);
  await act(async () => session.resolve(Response.json({ user })));
  await act(async () => window.dispatchEvent(new Event("focus")));
  assert.deepEqual(paths(requests), ["/api/session", "/api/rooms"]);
  await act(async () => rooms.resolve(Response.json({ rooms: [room] })));
  await paint();
  assert.equal(coverStatus(host), "ready");
});

test("直达画布等待服务端首个快照，本地草稿与 presence 消息不能提前解锁", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  apiFixture(t, { loggedIn: true });
  const cached = createObject(room.id, "note");
  globalThis.openingDraft = { replica: { objects: [cached] } };
  const { host } = await mount(t, {
    url: "/?room=opening-room",
    reduced: true,
  });
  await paint();
  assert.ok(host.querySelector(".cloud-canvas"), "本地草稿已挂载");
  assert.equal(enter(host).disabled, true);
  assert.equal(sockets.length, 1);
  await act(async () =>
    sockets[0].onmessage({
      data: JSON.stringify({ type: "presence", members: [] }),
    }),
  );
  await paint();
  assert.equal(enter(host).disabled, true);
  await act(async () => sockets[0].snapshot([cached]));
  await paint();
  assert.equal(coverStatus(host), "ready");
  await click(enter(host));
  assert.equal(enter(host), null);
  assert.equal(host.querySelector(".loading-screen"), null);
});

test("首个快照前断线留在封面重试，重建连接后就绪并仅消费一次邀请", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = apiFixture(t, { loggedIn: true });
  const { host } = await mount(t, {
    url: "/?room=opening-room#invite=test-token",
    reduced: true,
  });
  const oldSocket = sockets[0];
  assert.ok(oldSocket);
  await act(async () => oldSocket.onclose({ code: 1006 }));
  assert.equal(coverStatus(host), "error");
  assert.equal(enter(host).disabled, false);
  await click(enter(host));
  assert.equal(oldSocket.readyState, 3);
  assert.equal(coverStatus(host), "loading");
  assert.equal(sockets.length, 2);
  await act(async () => oldSocket.snapshot());
  await paint();
  assert.equal(enter(host).disabled, true, "旧连接的快照不能解锁新的一次准备");
  await act(async () => sockets[1].snapshot());
  await paint();
  assert.equal(coverStatus(host), "ready");
  assert.equal(
    paths(requests).filter((url) => url.endsWith("/join")).length,
    1,
  );
  await click(enter(host));
  assert.ok(host.querySelector(".cloud-canvas"));
});

test("会话请求失败在封面重试，成功后仍需另一次点击才能进入", async (t) => {
  const requests = apiFixture(t, {
    intercept: (_url, all) =>
      all.length === 1 &&
      Response.json({ error: "网络暂时不可用" }, { status: 503 }),
  });
  const { host } = await mount(t, { reduced: true });
  assert.equal(coverStatus(host), "error");
  assert.ok(host.textContent.includes("网络暂时不可用"));
  await click(enter(host));
  await paint();
  assert.equal(coverStatus(host), "ready");
  assert.deepEqual(paths(requests), ["/api/session", "/api/session"]);
  await click(enter(host));
  assert.equal(enter(host), null);
  assert.ok(host.querySelector("form"));
});

test("超过 20 秒可以重试，旧会话响应不会覆盖新页面或消费邀请", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const requests = apiFixture(t, {
    intercept: (_url, all) => all.length === 1 && first.promise,
  });
  const url = "/?room=opening-room#invite=not-consumed";
  const { host } = await mount(t, { url, reduced: true });
  await tick(t, 20000);
  assert.equal(coverStatus(host), "error");
  await click(enter(host));
  await paint();
  assert.equal(coverStatus(host), "ready");
  await act(async () => first.resolve(Response.json({ user })));
  await paint();
  assert.deepEqual(paths(requests), ["/api/session", "/api/session"]);
  assert.equal(location.pathname + location.search + location.hash, url);
  await click(enter(host));
  assert.ok(host.querySelector("form"));
});

test("旧的已登录列表请求在重试后完成不能继续加入邀请", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstRooms = deferred();
  const requests = apiFixture(t, {
    loggedIn: true,
    intercept: (url, all) => {
      if (url === "/api/rooms") return firstRooms.promise;
      if (url === "/api/session" && all.length > 1)
        return Response.json({ user: null });
    },
  });
  const { host } = await mount(t, {
    url: "/?room=opening-room#invite=retained",
  });
  await tick(t, 20000);
  await click(enter(host));
  await paint();
  await act(async () => firstRooms.resolve(Response.json({ rooms: [room] })));
  assert.equal(
    paths(requests).filter((url) => url.endsWith("/join")).length,
    0,
  );
  assert.equal(location.hash, "#invite=retained");
  assert.equal(coverStatus(host), "ready");
  assert.ok(host.querySelector("form"));
});

test("首屏懒加载内容仍在等待时不能进入，内容提交后才恢复按钮", async (t) => {
  apiFixture(t);
  const chunk = deferred();
  const Page = React.lazy(() => chunk.promise);
  const { host } = await mount(t, {
    reduced: true,
    children: React.createElement(
      React.Fragment,
      null,
      React.createElement(App),
      React.createElement(
        React.Suspense,
        {
          fallback: React.createElement(
            OpeningPreparation,
            { id: "calendar", status: "loading" },
            React.createElement("p", null, "正在加载月历…"),
          ),
        },
        React.createElement(Page),
      ),
    ),
  });
  await paint();
  assert.ok(host.querySelector("form"));
  assert.equal(enter(host).disabled, true);
  await act(async () =>
    chunk.resolve({
      default: () => React.createElement("output", null, "月历已渲染"),
    }),
  );
  await paint();
  assert.equal(coverStatus(host), "ready");
  assert.ok(host.textContent.includes("月历已渲染"));
  assert.ok(!host.textContent.includes("正在加载月历…"));
});

test("进入途中目标变为加载状态会取消退出，准备好后重新等待点击", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let change;
  function Destination() {
    const [status, setStatus] = React.useState("ready");
    change = setStatus;
    return React.createElement(
      OpeningPreparation,
      { status },
      React.createElement("output", null, status),
    );
  }
  const { host } = await mount(t, {
    children: React.createElement(Destination),
  });
  await paint();
  await click(enter(host));
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "entering");
  await act(async () => change("loading"));
  await tick(t);
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "waiting");
  assert.equal(enter(host).disabled, true);
  await act(async () => change("ready"));
  await paint();
  assert.equal(coverStatus(host), "ready");
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "waiting");
});

test("超时后原请求恢复可自行就绪，但不会自动进入", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = deferred();
  apiFixture(t, { intercept: () => session.promise });
  const { host } = await mount(t);
  await tick(t, 20000);
  assert.equal(coverStatus(host), "error");
  await act(async () => session.resolve(Response.json({ user: null })));
  await paint();
  assert.equal(coverStatus(host), "ready");
  assert.equal(host.querySelector(".opening-gate").dataset.phase, "waiting");
});

test("无权限的直达画布在封面显示错误并提供返回首页", async (t) => {
  apiFixture(t, {
    loggedIn: true,
    intercept: (url) =>
      url === "/api/rooms/opening-room" &&
      Response.json({ error: "你没有权限访问此画布" }, { status: 403 }),
  });
  const { host } = await mount(t, { url: "/?room=opening-room" });
  await paint();
  assert.equal(coverStatus(host), "error");
  assert.equal(host.querySelector(".opening-home").getAttribute("href"), "/");
  assert.ok(host.textContent.includes("你没有权限访问此画布"));
});

test("慢图片加载期间重试，旧工作区结束请求后不会留下心跳或写入过期资源", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const image = deferred();
  const activeHeartbeats = new Set();
  const createInterval = globalThis.setInterval;
  const removeInterval = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (callback, delay, ...args) => {
    const id = createInterval(callback, delay, ...args);
    if (delay === 20000) activeHeartbeats.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => {
    activeHeartbeats.delete(id);
    removeInterval(id);
  });
  t.after(() => activeHeartbeats.forEach(removeInterval));
  const assetWrites = [];
  globalThis.openingDraftWrite = (store, key) => {
    if (store === "assets") assetWrites.push(key);
  };
  globalThis.openingDraft = {
    replica: { objects: [], base: [] },
    assets: { "slow-image": { name: "cached.png" } },
  };
  const requests = apiFixture(t, {
    loggedIn: true,
    intercept: (url) => url.endsWith("/assets/slow-image") && image.promise,
  });
  const { host } = await mount(t, { url: "/?room=opening-room" });
  assert.ok(
    paths(requests).includes("/api/rooms/opening-room/assets/slow-image"),
  );
  assert.equal(sockets.length, 0);
  await tick(t, 20000);
  assert.equal(coverStatus(host), "error");
  globalThis.openingDraft = undefined;
  await click(enter(host));
  assert.equal(sockets.length, 1);
  assert.equal(activeHeartbeats.size, 1);
  await act(async () =>
    image.resolve(new Response(new Blob(["image"], { type: "image/png" }))),
  );
  assert.equal(activeHeartbeats.size, 1, "已卸载的工作区不能注册另一个心跳");
  assert.deepEqual(assetWrites, [], "旧请求不能继续写入资源库");
  await act(async () => sockets[0].snapshot());
  await paint();
  assert.equal(coverStatus(host), "ready");
});
