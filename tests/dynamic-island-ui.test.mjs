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
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "MouseEvent",
  "KeyboardEvent",
  "Event",
  "CompositionEvent",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/dynamic-island-ui-", import.meta.url),
);
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});
await build({
  stdin: {
    contents: `
      export { default as DynamicIsland } from "./src/island/DynamicIsland.jsx";
      export { createWorkspace, createObject, makeBlock, patchObjects, blockText } from "./src/canvas/model.js";
      export { panePages } from "./src/canvas/arranged-model.js";
    `,
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
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "island.mjs"),
});
const {
  DynamicIsland,
  createWorkspace,
  createObject,
  makeBlock,
  patchObjects,
  blockText,
  panePages,
} = await import(pathToFileURL(path.join(output, "island.mjs")));

async function mount(t, { count = 3, empty = false } = {}) {
  localStorage.clear();
  const original = createWorkspace();
  const boardId = original.boards[0].id;
  const page = {
    ...createObject(boardId, "frame", { x: 80, y: 80 }),
    title: "产品设计",
    createdAt: "2026-11-01T00:00:00.000Z",
    fixedBounds: true,
    width: 600,
    height: 400,
  };
  const other = {
    ...createObject(boardId, "frame", { x: 900, y: 80 }),
    title: "内容计划",
    createdAt: "2026-11-02T00:00:00.000Z",
    fixedBounds: true,
    width: 600,
    height: 400,
  };
  const note = {
    ...createObject(boardId, "note", { x: 104, y: 128 }),
    parentId: page.id,
    noteKind: "checklist",
    blocks: Array.from({ length: count }, (_, index) =>
      makeBlock(`任务 ${index + 1}`, index === 1),
    ),
  };
  const otherNote = {
    ...createObject(boardId, "note", { x: 924, y: 128 }),
    parentId: other.id,
    noteKind: "checklist",
    blocks: [makeBlock("另一个项目的待办")],
  };
  original.objects = empty ? [] : [page, other, note, otherNote];
  original.preferences.views[boardId] = {
    arranged: { pageId: empty ? "ungrouped" : page.id, active: "left" },
  };
  const host = document.createElement("main");
  document.body.append(host);
  const controls = { updates: [], toggles: [], before: 0, disabled: 0 };
  function Fixture() {
    const [state, setState] = useState(original);
    const [readOnly, setReadOnly] = useState(false);
    const [hidden, setHidden] = useState(false);
    const current = useRef(state);
    current.current = state;
    const update = (action, options = {}) => {
      controls.updates.push(options);
      const next =
        typeof action === "function" ? action(current.current) : action;
      if (!next || next === current.current) return;
      current.current = next;
      setState(next);
    };
    const workspace = {
      state,
      current,
      update,
      readOnly,
      status: "saved",
      toggleBlock(noteId, blockId) {
        controls.toggles.push([noteId, blockId]);
        update((latest) => {
          const target = latest.objects.find((object) => object.id === noteId);
          return patchObjects(latest, {
            [noteId]: {
              blocks: target.blocks.map((block) =>
                block.id === blockId
                  ? {
                      ...block,
                      done: !block.done,
                      completedAt: block.done ? null : new Date().toISOString(),
                    }
                  : block,
              ),
            },
          });
        });
      },
    };
    Object.assign(controls, {
      update,
      setReadOnly,
      setHidden,
      state: () => current.current,
      // Simulate the sync engine receiving a newer snapshot before React paints.
      receiveBeforeRender(action) {
        current.current = action(current.current);
      },
    });
    return React.createElement(DynamicIsland, {
      workspace,
      boardId,
      top: 64,
      hidden,
      beforeAction() {
        controls.before++;
      },
      onDisable() {
        controls.disabled++;
      },
    });
  }
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Fixture)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, controls, boardId, page, other, note, otherNote };
}

const labelled = (host, label) =>
  [...host.querySelectorAll("[aria-label]")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
const panel = (host) =>
  host.querySelector('[role="region"][aria-label="灵动岛待办"]');
const toggle = (host) =>
  labelled(host, "展开灵动岛") || labelled(host, "收起灵动岛");
const isExpanded = (host) =>
  toggle(host)?.getAttribute("aria-expanded") === "true";
const taskNote = (controls, noteId) =>
  controls.state().objects.find((object) => object.id === noteId);

test("键盘焦点离开未钉住的面板后正常收起", async (t) => {
  const { host } = await mount(t);
  await act(async () => toggle(host).focus());
  await key(toggle(host), "Enter");
  await click(toggle(host));
  await key(toggle(host), "Tab");
  await act(async () => labelled(host, "灵动岛项目").focus());
  const outside = document.createElement("button");
  document.body.append(outside);
  t.after(() => outside.remove());
  await key(labelled(host, "灵动岛项目"), "Tab");
  await act(async () => outside.focus());
  await pause(450);
  assert.equal(isExpanded(host), false);
});

test("钉住的面板在其他弹层关闭后恢复展开", async (t) => {
  const { host, controls } = await mount(t);
  await click(toggle(host));
  await click(labelled(host, "钉住灵动岛"));
  await act(async () => controls.setHidden(true));
  assert.equal(isExpanded(host), false);
  await act(async () => controls.setHidden(false));
  assert.equal(isExpanded(host), true);
});

async function click(element) {
  assert.ok(element, "目标控件应存在");
  await act(async () =>
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
}
async function enterText(element, text) {
  assert.ok(element, "输入控件应存在");
  const prototype =
    element.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(element, value, options = {}) {
  assert.ok(element, "键盘操作目标应存在");
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    ),
  );
}
async function hover(element, entered) {
  await act(async () => {
    for (const prefix of ["mouse", "pointer"])
      element.dispatchEvent(
        new MouseEvent(`${prefix}${entered ? "over" : "out"}`, {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
  });
}
async function pause(milliseconds) {
  await act(
    async () => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  );
}

test("灵动岛使用当前项目的真实完成计数，勾选和恢复写回同一任务", async (t) => {
  const { host, controls, note } = await mount(t);
  assert.equal(isExpanded(host), false);
  const collapsed = panel(host);
  if (collapsed)
    assert.ok(
      collapsed.hasAttribute("inert") ||
        collapsed.getAttribute("aria-hidden") === "true",
    );
  assert.match(labelled(host, "待办进度")?.textContent || "", /1\s*\/\s*3/);
  await click(toggle(host));
  assert.equal(isExpanded(host), true);
  assert.ok(!panel(host).textContent.includes("另一个项目的待办"));
  await click(labelled(host, "完成待办：任务 1"));
  assert.equal(taskNote(controls, note.id).blocks[0].done, true);
  assert.ok(taskNote(controls, note.id).blocks[0].completedAt);
  assert.deepEqual(controls.toggles[0], [note.id, note.blocks[0].id]);
  assert.match(labelled(host, "待办进度")?.textContent || "", /2\s*\/\s*3/);
  await click(labelled(host, "恢复待办：任务 1"));
  assert.equal(taskNote(controls, note.id).blocks[0].done, false);
  assert.ok(controls.before >= 2);
});

test("新增保留多行单条待办，并落在当前项目而不修改已有内容", async (t) => {
  const { host, controls, boardId, page, note } = await mount(t);
  await click(toggle(host));
  const before = controls.state();
  const text = "第一行内容\n第二行内容";
  await enterText(labelled(host, "新增待办"), text);
  await click(labelled(host, "添加待办"));
  const added = controls
    .state()
    .objects.filter(
      (object) => !before.objects.some((old) => old.id === object.id),
    );
  assert.equal(added.length, 1);
  assert.equal(added[0].boardId, boardId);
  assert.equal(added[0].parentId, page.id);
  assert.equal(added[0].noteKind, "checklist");
  assert.equal(added[0].blocks.length, 1);
  assert.equal(blockText(added[0].blocks[0]), text);
  assert.equal(added[0].blocks[0].done, false);
  assert.deepEqual(taskNote(controls, note.id).blocks, note.blocks);
  assert.equal(labelled(host, "新增待办").value, "");
  assert.ok(controls.before > 0);
});

test("只读与锁定状态禁止勾选和新增，旧渲染点击仍重查最新锁定", async (t) => {
  const { host, controls, page, note } = await mount(t);
  await click(toggle(host));
  await enterText(labelled(host, "新增待办"), "保留输入");
  await act(async () => controls.setReadOnly(true));
  assert.equal(labelled(host, "完成待办：任务 1").disabled, true);
  assert.equal(labelled(host, "添加待办").disabled, true);
  const readOnlyState = controls.state();
  await click(labelled(host, "完成待办：任务 1"));
  await click(labelled(host, "添加待办"));
  assert.strictEqual(controls.state(), readOnlyState);
  assert.equal(controls.toggles.length, 0);
  await act(async () => controls.setReadOnly(false));
  const staleCheckbox = labelled(host, "完成待办：任务 1");
  controls.receiveBeforeRender((state) =>
    patchObjects(state, { [page.id]: { locked: true } }),
  );
  const lockedState = controls.state();
  await click(staleCheckbox);
  await click(labelled(host, "添加待办"));
  assert.strictEqual(controls.state(), lockedState);
  assert.equal(controls.toggles.length, 0);
  assert.equal(labelled(host, "新增待办").value, "保留输入");
  await act(async () =>
    controls.update((state) =>
      patchObjects(state, {
        [page.id]: { locked: false },
        [note.id]: { locked: true },
      }),
    ),
  );
  assert.equal(labelled(host, "完成待办：任务 1").disabled, true);
});

test("中文输入法 Enter 不提前提交，组词完成后 Enter 才新增一次", async (t) => {
  const { host, controls } = await mount(t);
  await click(toggle(host));
  const input = labelled(host, "新增待办");
  const count = controls.state().objects.length;
  await enterText(input, "准备换行");
  await key(input, "Enter", { shiftKey: true });
  assert.equal(controls.state().objects.length, count);
  await act(async () =>
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await enterText(input, "中文待办");
  await key(input, "Enter", { isComposing: true, keyCode: 229 });
  assert.equal(controls.state().objects.length, count);
  assert.equal(input.value, "中文待办");
  await act(async () =>
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "中文待办",
      }),
    ),
  );
  await key(input, "Enter");
  assert.equal(controls.state().objects.length, count + 1);
  assert.equal(input.value, "");
});

test("悬停展开后延迟收起，钉住保持展开，Escape 收起并归还胶囊焦点", async (t) => {
  const { host } = await mount(t);
  await hover(toggle(host), true);
  await pause(160);
  assert.equal(isExpanded(host), true);
  await hover(toggle(host), false);
  assert.equal(isExpanded(host), true, "离开时不应立即关闭");
  await pause(450);
  assert.equal(isExpanded(host), false);
  await click(toggle(host));
  await click(labelled(host, "钉住灵动岛"));
  await hover(toggle(host), false);
  await pause(450);
  assert.equal(isExpanded(host), true);
  await click(labelled(host, "取消钉住灵动岛"));
  const input = labelled(host, "新增待办");
  await act(async () => input.focus());
  await key(input, "Escape");
  assert.equal(isExpanded(host), false);
  assert.strictEqual(document.activeElement, toggle(host));
});

test("长列表保留最后一条操作，项目选择同步本机偏好且新增跟随所选页", async (t) => {
  const { host, controls, boardId, other, otherNote } = await mount(t, {
    count: 36,
  });
  await click(toggle(host));
  assert.ok(labelled(host, "完成待办：任务 36"));
  await click(labelled(host, "完成待办：任务 36"));
  assert.ok(labelled(host, "恢复待办：任务 36"));
  const select = labelled(host, "灵动岛项目");
  assert.equal(select.tagName, "SELECT");
  await enterText(labelled(host, "新增待办"), "原项目未提交草稿");
  const objectsBefore = controls.state().objects;
  const originalPageId = panePages(controls.state(), boardId).page.id;
  await act(async () => {
    select.value = other.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(panePages(controls.state(), boardId).page.id, other.id);
  assert.strictEqual(controls.state().objects, objectsBefore);
  assert.ok(
    controls.updates.some(
      (options) => options.record === false && options.navigation === true,
    ),
  );
  assert.ok(labelled(host, "完成待办：另一个项目的待办"));
  assert.ok(!labelled(host, "完成待办：任务 1"));
  assert.equal(labelled(host, "新增待办").value, "");
  await enterText(labelled(host, "新增待办"), "新项目新增");
  await click(labelled(host, "添加待办"));
  const latestPage = panePages(controls.state(), boardId).page;
  assert.equal(latestPage.tasks.length, otherNote.blocks.length + 1);
  assert.ok(
    latestPage.tasks.some(
      (task) =>
        blockText(task.block) === "新项目新增" &&
        task.note.parentId === other.id,
    ),
  );
  await act(async () => {
    select.value = originalPageId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(labelled(host, "新增待办").value, "原项目未提交草稿");
});

test("空画布显示零进度，拒绝空白提交并可添加首条未分组待办", async (t) => {
  const { host, controls, boardId } = await mount(t, { empty: true });
  assert.match(labelled(host, "待办进度")?.textContent || "", /0\s*\/\s*0/);
  await click(toggle(host));
  assert.ok(panel(host));
  assert.equal(panel(host).querySelectorAll('[role="checkbox"]').length, 0);
  assert.match(panel(host).textContent, /暂无|还没有|空空|第一条|添加/);
  await enterText(labelled(host, "新增待办"), "  \n  ");
  await click(labelled(host, "添加待办"));
  assert.equal(controls.state().objects.length, 0);
  await enterText(labelled(host, "新增待办"), "首条待办");
  await click(labelled(host, "添加待办"));
  const page = panePages(controls.state(), boardId).page;
  assert.equal(page.id, "ungrouped");
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].note.parentId, null);
  assert.equal(blockText(page.tasks[0].block), "首条待办");
});

test("关闭模式仅通知宿主，不改共享任务或项目选择", async (t) => {
  const { host, controls } = await mount(t);
  await click(toggle(host));
  const before = controls.state();
  await click(labelled(host, "关闭灵动岛模式"));
  assert.equal(controls.disabled, 1);
  assert.strictEqual(controls.state(), before);
});
