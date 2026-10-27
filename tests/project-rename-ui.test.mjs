import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  createObject,
  createInspirationBoard,
  makeBlock,
} from "../src/canvas/model.js";

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
  "KeyboardEvent",
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
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
globalThis.cancelAnimationFrame = clearTimeout;
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  sent = [];
  constructor() {
    sockets.push(this);
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: "snapshot", rows: [] }),
      });
    });
  }
  send(value) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
};
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/project-rename-ui-", import.meta.url),
);
await build({
  stdin: {
    contents:
      'export { default as App } from "./src/App.jsx"; export { useRoomWorkspace } from "./src/sync/useRoomWorkspace.js"; export { setActiveAccount } from "./src/api.js";',
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
      name: "browser-boundaries",
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
          export const openDrafts = async () => ({ async get() { return globalThis.projectRenameDraftRead?.(); }, async put() {}, close() {} });`,
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const { App, useRoomWorkspace, setActiveAccount } = await import(
  pathToFileURL(path.join(output, "ui.mjs"))
);
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});
const user = { id: "owner-a", name: "小张", username: "owner" };
const original = {
  id: "project-a",
  name: "原项目",
  role: "owner",
  createdAt: "2026-10-24T00:00:00.000Z",
};
const response = (body, status = 200) => Response.json(body, { status });
function apiFixture(t, patch, read) {
  let room = { ...original };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "PATCH") {
      const result = patch
        ? await patch(JSON.parse(options.body))
        : response({ room: { ...room, ...JSON.parse(options.body) } });
      if (result.ok) room = (await result.clone().json()).room;
      return result;
    }
    const delayedRead = read?.(url);
    if (delayedRead) return delayedRead;
    if (url === "/api/session") return response({ user });
    if (url === "/api/rooms")
      return response({
        rooms: [
          room,
          { ...room, id: "joined", name: "成员项目", role: "editor" },
        ],
      });
    if (url === "/api/rooms/project-a") return response({ room });
    if (url === "/api/rooms/joined")
      return response({ room: { ...room, id: "joined", role: "editor" } });
    throw new Error(`Unexpected request: ${url}`);
  });
  return requests;
}
async function mount(t, Component = App, props = {}) {
  history.replaceState(null, "", "/");
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next = props) => {
    await act(async () => root.render(React.createElement(Component, next)));
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    setActiveAccount(null);
  });
  await render();
  return { host, render };
}
function button(host, text) {
  const found = [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === text ||
      item.textContent.trim() === text,
  );
  assert.ok(found, `找不到按钮：${text}`);
  return found;
}
const click = async (element) => {
  await act(async () => element.click());
};
const submit = async (host) => {
  await act(async () =>
    host
      .querySelector('[role="dialog"] form')
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
};
async function fill(host, value) {
  const input = host.querySelector('[role="dialog"] input');
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const openRename = (host) => click(button(host, "修改项目名称：原项目"));

test("从画布或排列进入运维时隐藏收纳入口，关闭后恢复同一个收纳箱", async (t) => {
  apiFixture(t);
  const { host } = await mount(t);
  await click(host.querySelector(".room-card"));
  const dock = createObject(original.id, "collection");
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({
        data: JSON.stringify({
          type: "snapshot",
          rows: [{ id: dock.id, revision: 1, data: dock, deleted: false }],
        }),
      }),
  );
  const originalDock = host.querySelector(".collection-dock");
  assert.ok(!!originalDock);
  const dockId = originalDock.dataset.objectId;
  await click(button(host, "运维资产"));
  assert.equal(host.querySelectorAll(".object-collection").length, 0);
  await click(button(host, "关闭运维资产"));
  assert.equal(
    host.querySelector(".collection-dock")?.dataset.objectId,
    dockId,
  );
  await click(button(host, "排列"));
  assert.equal(
    host.querySelectorAll(".arranged-collection").length,
    0,
    "收纳箱入口只在画布模式显示",
  );
  await click(button(host, "运维资产"));
  assert.equal(host.querySelectorAll(".arranged-collection").length, 0);
});

test("灵感板、清单、便签显示创建时间，排列每行显示条目创建时间而非DDL", async (t) => {
  apiFixture(t);
  const { host } = await mount(t);
  await click(host.querySelector(".room-card"));
  const createdAt = "2026-10-01T01:02:00.000Z";
  const board = { ...createInspirationBoard(original.id), createdAt };
  const checklist = {
    ...createObject(original.id, "note"),
    parentId: board.id,
    noteKind: "checklist",
    createdAt,
    blocks: [
      {
        ...makeBlock("核对创建时间"),
        createdAt: "2026-10-02T03:04:00.000Z",
        dueAt: "2027-01-01T12:00:00.000Z",
      },
    ],
  };
  const sticky = {
    ...createObject(original.id, "note"),
    noteKind: "text",
    createdAt,
  };
  await act(async () =>
    sockets
      .at(-1)
      .onmessage({
        data: JSON.stringify({
          type: "snapshot",
          rows: [board, checklist, sticky].map((data) => ({
            id: data.id,
            revision: 1,
            data,
            deleted: false,
          })),
        }),
      }),
  );
  assert.equal(
    host.querySelector(".frame-created-at").getAttribute("datetime"),
    createdAt,
  );
  assert.equal(host.querySelectorAll(".board-add").length, 0);
  assert.equal(host.querySelectorAll(".note-created-at").length, 2);
  await click(button(host, "排列"));
  const time = host.querySelector(
    `[data-task-id="${checklist.blocks[0].id}"] .todo-created-meta time`,
  );
  assert.equal(time?.getAttribute("datetime"), "2026-10-02T03:04:00.000Z");
  assert.ok(
    [...host.querySelectorAll(".checklist-created-at")].some(
      (el) => el.getAttribute("datetime") === createdAt,
    ),
  );
});

test("首页重命名入口只对创建者显示，保存后卡片与再次进入的标题更新", async (t) => {
  const requests = apiFixture(t);
  const { host } = await mount(t);
  assert.equal(
    host.querySelectorAll('[aria-label^="修改项目名称："]').length,
    1,
  );
  assert.equal(host.querySelector("button button"), null);
  await openRename(host);
  assert.equal(host.querySelector('[role="dialog"] input').value, "原项目");
  assert.equal(
    document.activeElement,
    host.querySelector('[role="dialog"] input'),
  );
  await fill(host, "  本周计划  ");
  await submit(host);
  const patch = requests.find((entry) => entry.method === "PATCH");
  assert.equal(patch.url, "/api/rooms/project-a");
  assert.equal(patch.headers["X-QD-Account"], user.id);
  assert.deepEqual(JSON.parse(patch.body), { name: "本周计划" });
  assert.equal(host.querySelector('[role="dialog"]'), null);
  assert.ok(
    [...host.querySelectorAll("h2")].some(
      (heading) => heading.textContent === "本周计划",
    ),
  );
  await click(host.querySelector(".room-card"));
  assert.equal(host.querySelector(".board-title").textContent, "本周计划");
  assert.equal(sockets.at(-1).readyState, 1);
  await click(button(host, "修改项目名称：本周计划"));
  await fill(host, "画布内改名");
  await submit(host);
  assert.equal(host.querySelector(".board-title").textContent, "画布内改名");
  await click(button(host, "返回画布列表"));
  assert.ok(
    [...host.querySelectorAll("h2")].some(
      (heading) => heading.textContent === "画布内改名",
    ),
  );
});

test("空名称不提交，取消不修改；失败保留输入并能重试，保存期间不重复发送", async (t) => {
  let resolve;
  let attempts = 0;
  const requests = apiFixture(t, (body) => {
    attempts++;
    return attempts === 1
      ? new Promise((done) => {
          resolve = done;
        })
      : response({ room: { ...original, name: body.name } });
  });
  const { host } = await mount(t);
  await openRename(host);
  await fill(host, "   ");
  assert.equal(button(host, "保存名称").disabled, true);
  await submit(host);
  assert.equal(attempts, 0);
  await fill(host, "待保存名称");
  await submit(host);
  await submit(host);
  assert.equal(attempts, 1);
  assert.equal(host.querySelector('[role="dialog"] input').disabled, true);
  await act(async () => resolve(response({ error: "网络暂时不可用" }, 503)));
  assert.match(
    host.querySelector('[role="dialog"] [role="alert"]').textContent,
    /网络暂时不可用/,
  );
  assert.equal(host.querySelector('[role="dialog"] input').value, "待保存名称");
  await submit(host);
  assert.equal(attempts, 2);
  await click(button(host, "修改项目名称：待保存名称"));
  await fill(host, "不会保存");
  await click(button(host, "取消"));
  assert.equal(requests.filter((entry) => entry.method === "PATCH").length, 2);
  assert.ok(
    [...host.querySelectorAll("h2")].some(
      (heading) => heading.textContent === "待保存名称",
    ),
  );
});

test("会话失效后迟到的改名响应不会进入登录界面", async (t) => {
  let resolve;
  apiFixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { host } = await mount(t);
  await openRename(host);
  await fill(host, "旧账号私有名称");
  await submit(host);
  await act(async () =>
    window.dispatchEvent(new Event("qingdan-session-expired")),
  );
  await act(async () =>
    resolve(response({ room: { ...original, name: "旧账号私有名称" } })),
  );
  assert.equal(host.textContent.includes("旧账号私有名称"), false);
  assert.equal(host.querySelector('[role="dialog"]'), null);
  assert.ok(host.querySelector('input[autocomplete="username"]'));
});

test("取消弹窗并离开项目后迟到保存只更新列表，不重新打开画布", async (t) => {
  let resolve;
  apiFixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { host } = await mount(t);
  await click(host.querySelector(".room-card"));
  await openRename(host);
  await fill(host, "离开后的新名");
  await submit(host);
  await click(button(host, "关闭弹窗"));
  await click(button(host, "返回画布列表"));
  await act(async () =>
    resolve(response({ room: { ...original, name: "离开后的新名" } })),
  );
  assert.ok(host.querySelector(".home"));
  assert.equal(location.search, "");
  assert.ok(
    [...host.querySelectorAll("h2")].some(
      (heading) => heading.textContent === "离开后的新名",
    ),
  );
});

test("改名同步本地备份元数据，不重连、重写对象或产生撤销记录", async (t) => {
  let workspace;
  function Probe({ room }) {
    workspace = useRoomWorkspace(room, user);
    return null;
  }
  const { render } = await mount(t, Probe, { room: original });
  const objects = workspace.state.objects;
  const socket = sockets.at(-1);
  const connections = sockets.length;
  await render({ room: { ...original, name: "元数据新名称" } });
  assert.equal(workspace.state.boards[0].name, "元数据新名称");
  assert.equal(workspace.state.objects, objects);
  assert.equal(workspace.canUndo, false);
  assert.equal(sockets.length, connections);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(socket.sent, []);
});

for (const destination of ["列表", "详情"])
  test(`改名成功后较早发出的${destination}读取不能覆盖新名称`, async (t) => {
    let finishSave, finishRead;
    let delayRead = false,
      freshName = "";
    const path = destination === "列表" ? "/api/rooms" : "/api/rooms/project-a";
    apiFixture(
      t,
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
      (url) => {
        if (url !== path) return null;
        if (freshName)
          return response(
            destination === "列表"
              ? { rooms: [{ ...original, name: freshName }] }
              : { room: { ...original, name: freshName } },
          );
        return delayRead
          ? new Promise((resolve) => {
              finishRead = resolve;
            })
          : null;
      },
    );
    const { host } = await mount(t);
    if (destination === "列表") await click(host.querySelector(".room-card"));
    await openRename(host);
    await fill(host, "已保存的新名称");
    await submit(host);
    await click(button(host, "关闭弹窗"));
    delayRead = true;
    await click(
      destination === "列表"
        ? button(host, "返回画布列表")
        : host.querySelector(".room-card"),
    );
    assert.ok(finishRead);
    await act(async () =>
      finishSave(response({ room: { ...original, name: "已保存的新名称" } })),
    );
    await act(async () =>
      finishRead(
        response(
          destination === "列表" ? { rooms: [original] } : { room: original },
        ),
      ),
    );
    assert.equal(
      host.querySelector(
        destination === "列表" ? ".room-card h2" : ".board-title",
      ).textContent,
      "已保存的新名称",
    );
    freshName = "另一设备的更新";
    if (destination === "列表") {
      await click(host.querySelector(".room-card"));
      await click(button(host, "返回画布列表"));
    } else {
      await click(button(host, "返回画布列表"));
      await click(host.querySelector(".room-card"));
    }
    assert.equal(
      host.querySelector(
        destination === "列表" ? ".room-card h2" : ".board-title",
      ).textContent,
      freshName,
    );
  });

test("草稿初始化完成前收到改名也采用最新名称", async (t) => {
  let finishDraft, workspace;
  const pending = new Promise((resolve) => {
    finishDraft = resolve;
  });
  globalThis.projectRenameDraftRead = () => pending;
  t.after(() => {
    delete globalThis.projectRenameDraftRead;
  });
  function Probe({ room }) {
    workspace = useRoomWorkspace(room, user);
    return null;
  }
  const { render } = await mount(t, Probe, { room: original });
  assert.equal(workspace.state, null);
  await render({ room: { ...original, name: "初始化中的新名称" } });
  await act(async () => finishDraft(undefined));
  assert.equal(workspace.state.boards[0].name, "初始化中的新名称");
  assert.equal(workspace.canUndo, false);
});
