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
  "HTMLInputElement",
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
globalThis.getSelection = dom.window.getSelection.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
globalThis.cancelAnimationFrame = clearTimeout;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(new URL("../.tmp/order-ui-", import.meta.url));
await build({
  stdin: {
    contents:
      'export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, makeBlock } from "./src/canvas/model.js";',
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
          namespace: "css",
        }));
        build.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const {
  ArrangedWorkspace,
  TodoToolsProvider,
  createWorkspace,
  createObject,
  makeBlock,
} = await import(pathToFileURL(path.join(output, "ui.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

async function mount(t) {
  const original = createWorkspace(),
    boardId = original.boards[0].id;
  const note = {
    ...createObject(boardId, "note"),
    noteKind: "checklist",
    blocks: [
      { ...makeBlock("无日期"), id: "none" },
      { ...makeBlock("晚截止"), id: "late", dueAt: "2026-10-26T08:00:00.000Z" },
      {
        ...makeBlock("早截止"),
        id: "early",
        dueAt: "2026-10-24T08:00:00.000Z",
      },
      {
        ...makeBlock("已完成"),
        id: "done",
        done: true,
        completedAt: "2026-10-23T08:00:00.000Z",
      },
    ],
  };
  original.objects = [note];
  const host = document.createElement("main");
  document.body.append(host);
  const controls = { toasts: [] };
  function Fixture() {
    const [state, setState] = useState(original),
      [readOnly, setReadOnly] = useState(false),
      [editing, setEditing] = useState(null);
    const current = useRef(state),
      apiRef = useRef(null);
    current.current = state;
    const update = (action) => {
      const next = action(current.current);
      current.current = next;
      setState(next);
    };
    const workspace = {
      state,
      current,
      update,
      readOnly,
      assets: new Map(),
      assetVersion: 0,
      begin() {},
      end() {},
    };
    Object.assign(controls, {
      update,
      setReadOnly,
      state: () => current.current,
    });
    return React.createElement(
      TodoToolsProvider,
      { workspace, scope: "test", beforeAction() {}, onToast() {} },
      React.createElement(ArrangedWorkspace, {
        workspace,
        boardId,
        apiRef,
        editing,
        onEdit: (noteId, blockId) => setEditing({ noteId, blockId }),
        onExit: () => setEditing(null),
        onToast: (message) => controls.toasts.push(message),
        onCollection() {},
      }),
    );
  }
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Fixture)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, controls, note };
}
const order = (host) =>
  [...host.querySelectorAll(".pending-panel [data-task-id]")].map(
    (row) => row.dataset.taskId,
  );
const row = (host, id) => host.querySelector(`[data-task-id="${id}"]`);
async function click(element) {
  assert.ok(element);
  await act(async () => element.click());
}
async function drag(host, source, target, after = false) {
  const previous = document.elementFromPoint;
  // JSDOM has no layout or hit testing. Only the target lookup is supplied;
  // selection, pointer handlers, state updates and displayed order are real.
  document.elementFromPoint = () => row(host, target);
  try {
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientY: type === "pointerdown" ? 80 : after ? 10 : -10,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => row(host, source).dispatchEvent(event));
    }
  } finally {
    document.elementFromPoint = previous;
  }
}

test("点击截止时间排序后可向上、向下拖动，无自动锁序，完成栏保持原状", async (t) => {
  const { host, controls } = await mount(t);
  const button = host.querySelector('[aria-label="按截止时间排序"]');
  assert.ok(button, "未完成栏提供一次性排序按钮");
  assert.deepEqual(order(host), ["none", "late", "early"]);
  await click(button);
  assert.deepEqual(order(host), ["early", "late", "none"]);
  await drag(host, "none", "early");
  assert.deepEqual(order(host), ["none", "early", "late"]);
  await drag(host, "early", "late", true);
  assert.deepEqual(order(host), ["none", "late", "early"]);
  assert.deepEqual(
    [...host.querySelectorAll(".done-panel [data-task-id]")].map(
      (r) => r.dataset.taskId,
    ),
    ["done"],
  );
  await act(async () =>
    controls.update((s) => ({
      ...s,
      objects: s.objects.map((n) => ({
        ...n,
        blocks: n.blocks.map((b) =>
          b.id === "none" ? { ...b, dueAt: "2026-10-28T08:00:00.000Z" } : b,
        ),
      })),
    })),
  );
  assert.deepEqual(order(host), ["none", "late", "early"]);
  await click(button);
  assert.deepEqual(order(host), ["early", "late", "none"]);
  await act(async () => controls.setReadOnly(true));
  assert.equal(button.disabled, true);
  await drag(host, "none", "early");
  assert.deepEqual(order(host), ["early", "late", "none"]);
});

test("待办右键阻止浏览器默认菜单，仅显示删除，删除后只移除目标待办", async (t) => {
  const { host, controls } = await mount(t);
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 100,
    clientY: 150,
  });
  await act(async () =>
    row(host, "late").querySelector(".todo-copy").dispatchEvent(event),
  );
  assert.equal(event.defaultPrevented, true, "必须阻止浏览器右键菜单");
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.equal(menu.textContent.trim(), "删除");
  assert.equal(menu.querySelectorAll("button").length, 1);
  await click(menu.querySelector('[role="menuitem"]'));
  assert.deepEqual(order(host), ["none", "early"]);
  assert.equal(controls.state().trash[0].task.block.id, "late");
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test("只读待办的紧凑右键菜单仍拦截浏览器菜单并禁止删除", async (t) => {
  const { host, controls } = await mount(t);
  await act(async () => controls.setReadOnly(true));
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  await act(async () => row(host, "early").dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.querySelector('[role="menuitem"]').disabled, true);
});

test("大量已排序便签中回车拆分只改当前便签，后半段文字紧跟原事项", async (t) => {
  const { host, controls, note } = await mount(t);
  await act(async () =>
    controls.update((s) => ({
      ...s,
      objects: Array.from({ length: 201 }, (_, i) => ({
        ...note,
        id: `note-${i}`,
        blocks: [
          {
            ...makeBlock(i ? `任务${i}` : "beforeTAIL"),
            id: `split-${i}`,
            arrangedOrder: i,
          },
        ],
      })),
    })),
  );
  await act(async () =>
    row(host, "split-0")
      .querySelector(".todo-copy")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  const editor = host.querySelector(".block-editor");
  const range = document.createRange();
  range.setStart(editor.firstChild, 6);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () =>
    editor.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.deepEqual(controls.toasts, []);
  const restored = host.querySelector(".block-editor");
  assert.equal(restored.textContent, "TAIL");
  await act(async () => restored.blur());
  assert.deepEqual(
    controls
      .state()
      .objects.find((o) => o.id === "note-0")
      .blocks.map((b) => b.runs.map((r) => r.text || "").join("")),
    ["before", "TAIL"],
  );
  assert.equal(order(host)[0], "split-0");
  assert.equal(order(host)[2], "split-1");
});
