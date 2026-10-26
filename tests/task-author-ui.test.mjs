import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";

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
  "CustomEvent",
  "MouseEvent",
  "Event",
  "getComputedStyle",
  "localStorage",
  "location",
  "history",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 900;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
globalThis.cancelAnimationFrame = clearTimeout;
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/task-author-ui-", import.meta.url),
);
await build({
  stdin: {
    contents:
      'export { TaskAuthorsProvider, AuthorAvatarToggle } from "./src/canvas/TaskAuthors.jsx"; export { default as Canvas } from "./src/canvas/Canvas.jsx"; export { default as Note } from "./src/canvas/Note.jsx"; export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, createInspirationBoard, makeBlock } from "./src/canvas/model.js"; export { default as ProfileSettings } from "./src/auth/ProfileSettings.jsx"; export { default as App } from "./src/App.jsx"; export { setActiveAccount } from "./src/api.js";',
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
      name: "omit-css",
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
const {
  TaskAuthorsProvider,
  AuthorAvatarToggle,
  Note,
  Canvas,
  ArrangedWorkspace,
  TodoToolsProvider,
  createWorkspace,
  createObject,
  createInspirationBoard,
  makeBlock,
  ProfileSettings,
  App,
  setActiveAccount,
} = await import(pathToFileURL(path.join(output, "ui.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});
const alice = { id: "alice", name: "小张" },
  bob = { id: "bob", name: "小李" };
const click = async (element) => {
  assert.ok(element);
  await act(async () => element.click());
};

test("头像需要确认裁剪才上传，取消与失败保留原头像，移除后恢复默认头像", async (t) => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    setActiveAccount(null);
  });
  setActiveAccount(alice.id);
  const requests = [];
  let fail = false;
  let delayUpload = false;
  let finishUpload;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "/api/profile/avatar")
      return new Response(JSON.stringify({ email: null, available: false }), {
        headers: { "Content-Type": "application/json" },
      });
    requests.push({ url, ...options });
    const response = new Response(
      JSON.stringify(
        fail
          ? { error: "上传失败，请重试。" }
          : {
              user: {
                ...alice,
                avatarVersion:
                  options.method === "DELETE" ? null : "uploaded-v1",
              },
            },
      ),
      {
        status: fail ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    if (delayUpload && options.method === "PUT")
      return new Promise((resolve) => {
        finishUpload = () => resolve(response);
      });
    return response;
  });
  // JSDOM has no image decoder or canvas; exercise the real form and request code.
  const priorDecode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({
    width: 400,
    height: 200,
    close() {},
  });
  t.after(() => {
    if (priorDecode) globalThis.createImageBitmap = priorDecode;
    else delete globalThis.createImageBitmap;
  });
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => ({
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    clip() {},
    drawImage() {},
  }));
  t.mock.method(
    window.HTMLCanvasElement.prototype,
    "toBlob",
    function (callback, mime) {
      callback(new Blob(["encoded avatar"], { type: mime }));
    },
  );
  let changeUser;
  function Profile() {
    const [user, setUser] = useState(alice);
    changeUser = setUser;
    return React.createElement(ProfileSettings, {
      user,
      onUpdate: (result) => setUser(result.user),
      onLogout() {},
    });
  }
  await act(async () => root.render(React.createElement(Profile)));
  const input = host.querySelector('input[type="file"]');
  assert.ok(input, "提供头像上传入口");
  const select = async (file) => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
  };
  await select(
    new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    }),
  );
  assert.equal(requests.length, 0);
  assert.match(host.querySelector('[role="alert"]').textContent, /20\s*MB/);
  const png = new File(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=",
        "base64",
      ),
    ],
    "photo.png",
    { type: "image/png" },
  );
  await select(png);
  assert.equal(requests.length, 0, "选图后先调整圆形选区，不立即上传");
  assert.ok(host.querySelector('[aria-label="裁剪头像"]'));
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "取消裁剪",
    ),
  );
  assert.equal(requests.length, 0);
  assert.equal(host.querySelector(".profile-avatar img"), null);
  await select(png);
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "确认头像",
    ),
  );
  assert.equal(requests[0].url, "/api/profile/avatar");
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].headers["X-QD-Account"], "alice");
  assert.ok(
    requests[0].body instanceof Blob,
    "图片以二进制发送，不能转成 JSON",
  );
  assert.equal(requests[0].headers["Content-Type"], "image/webp");
  const src = host.querySelector(".profile-avatar img")?.getAttribute("src");
  assert.equal(src, "/api/avatars/alice?v=uploaded-v1&account=alice");
  await select(png);
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "取消裁剪",
    ),
  );
  assert.equal(
    host.querySelector(".profile-avatar img")?.getAttribute("src"),
    src,
  );
  assert.equal(requests.length, 1, "取消裁剪保留现有头像且没有上传请求");
  fail = true;
  await select(png);
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "确认头像",
    ),
  );
  assert.ok(host.querySelector('[role="alert"]'));
  assert.ok(
    host.querySelector('[aria-label="裁剪头像"]'),
    "失败保留裁剪以便重试",
  );
  assert.equal(
    host.querySelector(".profile-avatar img")?.getAttribute("src"),
    src,
  );
  let finishDecode, startedDecode;
  const decoding = new Promise((resolve) => {
    startedDecode = resolve;
  });
  globalThis.createImageBitmap = () =>
    new Promise((resolve) => {
      finishDecode = () => resolve({ width: 200, height: 200, close() {} });
      startedDecode();
    });
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [png] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await decoding;
    setActiveAccount("bob");
    finishDecode();
  });
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "确认头像",
    ),
  );
  assert.equal(
    requests.at(-1).headers["X-QD-Account"],
    "alice",
    "裁剪期间切换账号也只能请求修改原用户头像",
  );
  setActiveAccount("alice");
  fail = false;
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "移除头像",
    ),
  );
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(host.querySelector(".profile-avatar img"), null);
  assert.equal(host.querySelector(".profile-avatar").textContent, "小");
  globalThis.createImageBitmap = async () => ({
    width: 400,
    height: 200,
    close() {},
  });
  delayUpload = true;
  await select(png);
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "确认头像",
    ),
  );
  assert.ok(finishUpload);
  await act(async () => {
    setActiveAccount("bob");
    changeUser({ ...bob, username: "bob" });
  });
  assert.equal(input.disabled, false, "换账号后解除旧头像上传的忙碌状态");
  await act(async () => finishUpload());
  assert.equal(
    host.querySelector("strong").textContent,
    "bob",
    "旧上传结果不能覆盖新账号",
  );
  assert.equal(host.querySelector(".profile-avatar img"), null);
  assert.equal(host.querySelector('[aria-label="裁剪头像"]'), null);
});

async function mountPendingAvatarApp(t, nextLoginUser = bob) {
  history.replaceState(null, "", "/");
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    setActiveAccount(null);
  });
  let finishUpload;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const json = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/session")
      return json({
        user: { ...alice, username: "alice", avatarVersion: "old-avatar" },
      });
    if (url === "/api/rooms") return json({ rooms: [] });
    if (url === "/api/auth/login")
      return json({
        user: { ...nextLoginUser, avatarVersion: "new-session-avatar" },
      });
    if (url === "/api/profile/avatar" && options.method === "PUT") {
      assert.equal(options.headers["X-QD-Account"], "alice");
      return new Promise((resolve) => {
        finishUpload = () =>
          resolve(
            json({
              user: {
                ...alice,
                username: "alice",
                avatarVersion: "uploaded-after-close",
              },
            }),
          );
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const priorDecode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({
    width: 400,
    height: 200,
    close() {},
  });
  t.after(() => {
    if (priorDecode) globalThis.createImageBitmap = priorDecode;
    else delete globalThis.createImageBitmap;
  });
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => ({
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    clip() {},
    drawImage() {},
  }));
  t.mock.method(
    window.HTMLCanvasElement.prototype,
    "toBlob",
    (callback, mime) => callback(new Blob(["encoded avatar"], { type: mime })),
  );
  await act(async () => root.render(React.createElement(App)));
  await click(host.querySelector(".profile-button"));
  const input = host.querySelector('input[type="file"]');
  const png = new File(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=",
        "base64",
      ),
    ],
    "photo.png",
    { type: "image/png" },
  );
  Object.defineProperty(input, "files", { configurable: true, value: [png] });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  await click(
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "确认头像",
    ),
  );
  assert.ok(finishUpload, "上传已发出且仍在等待响应");
  await click(host.querySelector('.dialog-close[aria-label="关闭"]'));
  assert.equal(host.querySelector(".profile-settings"), null);
  return {
    host,
    finish: async () => {
      await act(async () => finishUpload());
    },
  };
}

test("确认上传后关闭资料弹窗，迟到的成功结果更新首页头像且重新打开仍显示新头像", async (t) => {
  const f = await mountPendingAvatarApp(t);
  assert.equal(
    f.host.querySelector(".profile-button img").getAttribute("src"),
    "/api/avatars/alice?v=old-avatar&account=alice",
  );
  await f.finish();
  assert.equal(
    f.host.querySelector(".profile-button img").getAttribute("src"),
    "/api/avatars/alice?v=uploaded-after-close&account=alice",
  );
  await click(f.host.querySelector(".profile-button"));
  assert.equal(
    f.host.querySelector(".profile-avatar img").getAttribute("src"),
    "/api/avatars/alice?v=uploaded-after-close&account=alice",
  );
  assert.equal(
    f.host.querySelector(".profile-notice"),
    null,
    "关闭后的请求不向新资料弹窗写入局部状态",
  );
});

test("关闭资料弹窗后重新登录，App 的账号与会话 epoch 防护拒绝旧头像响应", async (t) => {
  for (const nextUser of [bob, { ...alice, name: "再次登录的小张" }]) {
    await t.test(
      nextUser.id === "bob" ? "另一账号" : "同一账号的新会话",
      async (t) => {
        const f = await mountPendingAvatarApp(t, nextUser);
        await act(async () =>
          window.dispatchEvent(new Event("qingdan-session-expired")),
        );
        const username = f.host.querySelector('input[autocomplete="username"]');
        const password = f.host.querySelector(
          'input[autocomplete="current-password"]',
        );
        const set = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        await act(async () => {
          set.call(username, nextUser.id);
          username.dispatchEvent(new Event("input", { bubbles: true }));
          set.call(password, "password-for-test");
          password.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () =>
          f.host
            .querySelector("form")
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
        );
        assert.equal(
          f.host.querySelector(".profile-button").textContent,
          nextUser.name,
        );
        await f.finish();
        assert.equal(
          f.host.querySelector(".profile-button").textContent,
          nextUser.name,
        );
        assert.equal(
          f.host.querySelector(".profile-button img").getAttribute("src"),
          `/api/avatars/${nextUser.id}?v=new-session-avatar&account=${nextUser.id}`,
        );
      },
    );
  }
});

test("画布平移快捷键不会抢占头像开关的空格操作", async (t) => {
  window.localStorage.clear();
  const f = await mount(t, { canvas: true, roomId: "canvas-keyboard" });
  const toggle = f.host.querySelector('[role="switch"]');
  const key = new window.KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    toggle.focus();
    toggle.dispatchEvent(key);
  });
  assert.equal(key.defaultPrevented, false, "保留按钮原生空格激活行为");
  assert.equal(f.host.querySelector(".space-pan"), null);
});

test("灵感板和画布清单在抬头显示创建时间", async (t) => {
  const noteView = await mount(t, { roomId: "creation-note" });
  const noteTime = noteView.host.querySelector(".note-created-at");
  assert.ok(noteTime, "清单便签需要创建时间");
  assert.equal(
    noteTime.getAttribute("dateTime"),
    noteView.note.createdAt,
  );

  const canvasView = await mount(t, { canvas: true, roomId: "creation-board" });
  const frameTime = canvasView.host.querySelector(".frame-created-at");
  const frame = canvasView.state().objects.find((object) => object.type === "frame");
  assert.ok(frameTime, "灵感板需要创建时间");
  assert.equal(frameTime.getAttribute("dateTime"), frame.createdAt);
});

test("普通画布便签抬头也显示创建时间", async (t) => {
  const f = await mount(t, { roomId: "creation-text-note", noteKind: "text" });
  const created = f.host.querySelector(".note-created-at");
  assert.ok(created, "普通便签需要创建时间");
  assert.equal(created.getAttribute("dateTime"), f.note.createdAt);
});

test("排列模式的待办中间显示创建时间而不是截止时间", async (t) => {
  const f = await mount(t, { arranged: true, roomId: "creation-arranged" });
  const block = f.note.blocks[0];
  const createdTime = f.host.querySelector(
    `.todo-created-meta time[dateTime="${block.createdAt}"]`,
  );
  assert.ok(createdTime, "排列待办需要显示创建时间");
  assert.equal(
    f.host.querySelector(".todo-deadline-meta"),
    null,
    "创建时间展示不应继续使用截止时间元信息容器",
  );
});

async function mount(
  t,
  {
    user = alice,
    roomId = "room",
    arranged = false,
    canvas = false,
    noteKind = "checklist",
    members = [],
    profiles = [],
  } = {},
) {
  const original = createWorkspace(),
    boardId = original.boards[0].id;
  const board = createInspirationBoard(boardId, { x: 80, y: 80 });
  const note = {
    ...createObject(boardId, "note"),
    parentId: board.id,
    noteKind,
    blocks: [
      {
        ...makeBlock("小张的待办"),
        createdByUserId: alice.id,
        createdByName: alice.name,
      },
      {
        ...makeBlock("小李的待办"),
        createdByUserId: bob.id,
        createdByName: bob.name,
      },
      makeBlock("历史待办"),
    ],
  };
  original.objects.push(board, note);
  original.preferences.views[boardId] = {
    arranged: { pageId: board.id, active: "left" },
  };
  const host = document.createElement("main");
  document.body.append(host);
  let latest;
  const updates = [];
  const controls = {};
  function Fixture() {
    const [people, setProfiles] = useState(profiles);
    controls.setProfiles = setProfiles;
    const [state, setState] = useState(original),
      current = useRef(state),
      apiRef = useRef(null);
    current.current = latest = state;
    const workspace = {
      state,
      current,
      assets: new Map(),
      assetVersion: 0,
      begin() {},
      end() {},
      update(action) {
        updates.push(action);
        setState((s) => (typeof action === "function" ? action(s) : action));
      },
      toggleBlock(noteId, blockId) {
        this.update((s) => ({
          ...s,
          objects: s.objects.map((n) =>
            n.id !== noteId
              ? n
              : {
                  ...n,
                  blocks: n.blocks.map((b) =>
                    b.id !== blockId
                      ? b
                      : {
                          ...b,
                          done: !b.done,
                          completedAt: new Date().toISOString(),
                        },
                  ),
                },
          ),
        }));
      },
    };
    return React.createElement(
      TaskAuthorsProvider,
      { user, roomId, members, profiles: people },
      React.createElement(AuthorAvatarToggle),
      React.createElement(
        TodoToolsProvider,
        { workspace, scope: "test", beforeAction() {}, onToast() {} },
        arranged
          ? React.createElement(ArrangedWorkspace, {
              workspace,
              boardId,
              apiRef,
              onExit() {},
              onToast() {},
              onCollection() {},
            })
          : canvas
            ? React.createElement(Canvas, {
                workspace,
                boardId,
                apiRef,
                selection: [],
                view: { mode: "canvas", x: 0, y: 0, scale: 1 },
                onView() {},
                setSelection() {},
                onExit() {},
                onToast() {},
              })
            : React.createElement(Note, {
                object: state.objects.find((o) => o.id === note.id),
                objects: new Map(state.objects.map((o) => [o.id, o])),
                onToggle: (id) => workspace.toggleBlock(note.id, id),
                onEdit() {},
                onExit() {},
                onPatch() {},
              }),
      ),
    );
  }
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Fixture)));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  t.after(unmount);
  return { host, updates, state: () => latest, note, unmount, controls };
}

test("离线作者显示上传图片，加载失败回退首字，换图后恢复且不改待办", async (t) => {
  window.localStorage.clear();
  const f = await mount(t, {
    members: [{ userId: alice.id, name: alice.name }],
    profiles: [{ userId: bob.id, name: bob.name, avatarVersion: "bob-v1" }],
  });
  const before = structuredClone(f.state());
  const author = f.host.querySelectorAll(".task-author-avatar")[1];
  assert.equal(
    author.querySelector("img")?.getAttribute("src"),
    "/api/avatars/bob?v=bob-v1&account=alice",
  );
  await act(async () =>
    author.querySelector("img").dispatchEvent(new Event("error")),
  );
  assert.equal(author.querySelector("img"), null);
  assert.equal(author.textContent, "小");
  await act(async () =>
    f.controls.setProfiles([
      { userId: bob.id, name: bob.name, avatarVersion: "bob-v2" },
    ]),
  );
  assert.equal(
    author.querySelector("img")?.getAttribute("src"),
    "/api/avatars/bob?v=bob-v2&account=alice",
  );
  await click(f.host.querySelector('[role="switch"]'));
  assert.equal(f.host.querySelector(".task-author-avatar img"), null);
  await click(f.host.querySelector('[role="switch"]'));
  assert.equal(f.host.querySelectorAll(".task-author-avatar img").length, 1);
  assert.deepEqual(f.state(), before);
  assert.equal(f.updates.length, 0);
});

test("个人与协作清单均逐条显示作者，关闭不修改数据，菜单仍可查看作者", async (t) => {
  window.localStorage.clear();
  const f = await mount(t);
  const avatars = [...f.host.querySelectorAll(".task-author-avatar")];
  assert.deepEqual(
    avatars.map((a) => a.getAttribute("aria-label")),
    ["创建者：小张", "创建者：小李", "作者未记录"],
  );
  for (const row of f.host.querySelectorAll(".note-block"))
    assert.equal(
      row.firstElementChild.classList.contains("task-author-avatar"),
      true,
    );
  const toggle = f.host.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  const before = JSON.stringify(f.state());
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(f.host.querySelectorAll(".task-author-avatar").length, 0);
  assert.equal(JSON.stringify(f.state()), before);
  assert.equal(f.updates.length, 0);
  await click(f.host.querySelector(".todo-more-trigger"));
  assert.match(
    document.querySelector('[role="menu"]').textContent,
    /创建者：小张/,
  );
  await click(document.querySelector('[aria-label="关闭清单操作"]'));
  await click(f.host.querySelector('input[type="checkbox"]'));
  assert.equal(
    f.state().objects.find((o) => o.id === f.note.id).blocks[0].createdByUserId,
    alice.id,
  );
});

test("开关按账号和画布记忆，默认开启，键盘支持左右切换", async (t) => {
  window.localStorage.clear();
  const first = await mount(t, { roomId: "one" });
  await click(first.host.querySelector('[role="switch"]'));
  await first.unmount();
  const restored = await mount(t, { roomId: "one" });
  assert.equal(
    restored.host.querySelector('[role="switch"]').getAttribute("aria-checked"),
    "false",
  );
  const otherUser = await mount(t, { roomId: "one", user: bob });
  const otherRoom = await mount(t, { roomId: "two" });
  for (const f of [otherUser, otherRoom])
    assert.equal(
      f.host.querySelector('[role="switch"]').getAttribute("aria-checked"),
      "true",
    );
  const toggle = restored.host.querySelector('[role="switch"]');
  await act(async () =>
    toggle.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  await act(async () =>
    toggle.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  assert.equal(toggle.getAttribute("aria-checked"), "false");
});

test("排列视图与画布使用相同作者，离线作者仍显示，头像开关覆盖全部行", async (t) => {
  window.localStorage.clear();
  const f = await mount(t, {
    arranged: true,
    roomId: "arranged",
    members: [{ userId: alice.id, name: alice.name }],
  });
  const avatars = [...f.host.querySelectorAll(".task-author-avatar")];
  assert.equal(avatars.length, 3);
  assert.ok(
    avatars.some((a) => a.getAttribute("aria-label") === "创建者：小李"),
  );
  await click(f.host.querySelector('[role="switch"]'));
  assert.equal(f.host.querySelectorAll(".task-author-avatar").length, 0);
});
