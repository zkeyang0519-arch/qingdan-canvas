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
      'export { TaskAuthorsProvider, AuthorAvatarToggle } from "./src/canvas/TaskAuthors.jsx"; export { default as Canvas } from "./src/canvas/Canvas.jsx"; export { default as Note } from "./src/canvas/Note.jsx"; export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, createInspirationBoard, makeBlock } from "./src/canvas/model.js";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
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

async function mount(
  t,
  {
    user = alice,
    roomId = "room",
    arranged = false,
    canvas = false,
    members = [],
  } = {},
) {
  const original = createWorkspace(),
    boardId = original.boards[0].id;
  const board = createInspirationBoard(boardId, { x: 80, y: 80 });
  const note = {
    ...createObject(boardId, "note"),
    parentId: board.id,
    noteKind: "checklist",
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
  function Fixture() {
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
      { user, roomId, members },
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
                view: { mode: "canvas", x: 0, y: 0, zoom: 1 },
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
  return { host, updates, state: () => latest, note, unmount };
}

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
  await act(async () =>
    f.host
      .querySelector(".note-block")
      .dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, button: 2 }),
      ),
  );
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
