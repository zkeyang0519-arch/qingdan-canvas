import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "AbortController",
  "AbortSignal",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
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
const output = await mkdtemp(new URL("../.tmp/calendar-ui-", import.meta.url));
await build({
  stdin: {
    contents:
      'export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, createInspirationBoard, makeBlock, patchObjects } from "./src/canvas/model.js";',
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
  outfile: path.join(output, "calendar.mjs"),
});
const {
  ArrangedWorkspace,
  TodoToolsProvider,
  createWorkspace,
  createObject,
  createInspirationBoard,
  makeBlock,
  patchObjects,
} = await import(pathToFileURL(path.join(output, "calendar.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

async function mount(t) {
  const original = createWorkspace(),
    boardId = original.boards[0].id;
  const page = createInspirationBoard(boardId, { x: 80, y: 80 }, "产品设计");
  const other = createInspirationBoard(boardId, { x: 900, y: 80 }, "内容计划");
  const date = new Date();
  date.setDate(28);
  date.setHours(18, 0, 0, 0);
  const note = {
    ...createObject(boardId, "note"),
    parentId: page.id,
    noteKind: "checklist",
    blocks: Array.from({ length: 6 }, (_, i) => ({
      ...makeBlock(`任务 ${i + 1}`),
      dueAt: date.toISOString(),
    })),
  };
  note.blocks.push(makeBlock("没有日期的任务"));
  const otherNote = {
    ...createObject(boardId, "note"),
    parentId: other.id,
    noteKind: "checklist",
    blocks: [{ ...makeBlock("另一个灵感板"), dueAt: date.toISOString() }],
  };
  original.objects.push(page, other, note, otherNote);
  original.preferences.views[boardId] = {
    arranged: { pageId: page.id, active: "left" },
  };
  const host = document.createElement("main");
  document.body.append(host);
  const controls = { edits: [] };
  function Fixture() {
    const [state, setState] = useState(original),
      [readOnly, setReadOnly] = useState(false);
    const current = useRef(state);
    const api = useRef(null);
    current.current = state;
    const update = (action) => {
      const next = action(current.current);
      current.current = next;
      setState(next);
    };
    const workspace = {
      state,
      current,
      readOnly,
      assets: new Map(),
      assetVersion: 0,
      begin() {},
      end() {},
      update,
      toggleBlock(noteId, blockId) {
        update((s) => {
          const latest = s.objects.find((o) => o.id === noteId);
          return patchObjects(s, {
            [noteId]: {
              blocks: latest.blocks.map((b) =>
                b.id === blockId ? { ...b, done: !b.done } : b,
              ),
            },
          });
        });
      },
    };
    Object.assign(controls, {
      update,
      setReadOnly,
      state: () => current.current,
      api,
    });
    return React.createElement(
      TodoToolsProvider,
      { workspace, scope: "test", beforeAction() {}, onToast() {} },
      React.createElement(ArrangedWorkspace, {
        workspace,
        boardId,
        apiRef: api,
        onEdit(...args) {
          controls.edits.push(args);
        },
        onExit() {},
        onToast() {},
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
  return { host, controls, note, page, other, date, boardId };
}

async function click(element) {
  assert.ok(element, "目标控件应存在");
  await act(async () =>
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
}
const findText = (host, text) =>
  [...host.querySelectorAll('button,a,[role="button"],[role="link"]')].find(
    (e) => e.textContent.trim() === text,
  );
const dayPanel = () => document.querySelector('[aria-label="当天 DDL"]');
async function openCalendar(host) {
  await click(host.querySelector('[aria-label="切换到月历"]'));
}
async function openDay(host) {
  await click(findText(host, "还有 3 项"));
}

test("同日六项以 3+3 展示，展开保留全部、完成后清单同步", async (t) => {
  const { host, controls, note } = await mount(t);
  await openCalendar(host);
  if (!findText(host, "还有 3 项"))
    await writeFile(
      new URL("../.tmp/calendar-dom.html", import.meta.url),
      host.outerHTML,
    );
  assert.ok(findText(host, "还有 3 项"));
  assert.equal(
    host.querySelectorAll(".deadline-calendar .ddl-event").length,
    3,
  );
  await openDay(host);
  assert.equal(dayPanel().querySelectorAll(".deadline-day-task").length, 6);
  assert.ok(!dayPanel().textContent.includes("另一个灵感板"));
  await click(dayPanel().querySelector('button[aria-label="完成：任务 1"]'));
  assert.equal(dayPanel().querySelectorAll(".deadline-day-task").length, 5);
  assert.equal(
    controls.state().objects.find((o) => o.id === note.id).blocks[0].done,
    true,
  );
  await click(host.querySelector(".ddl-completed-filter input"));
  assert.equal(dayPanel().querySelectorAll(".deadline-day-task").length, 6);
  assert.ok(dayPanel().querySelector('button[aria-label="恢复：任务 1"]'));
  await click(host.querySelector('[aria-label="切换到清单"]'));
  assert.ok(
    host
      .querySelector('.checklist-pane[data-pane="right"]')
      .textContent.includes("任务 1"),
  );
});

test("日期入口按本地日期打开当天，23:59 DDL 不跨入次日", async (t) => {
  const { host, controls, note, date } = await mount(t);
  date.setHours(23, 59, 59, 999);
  await act(async () =>
    controls.update((s) =>
      patchObjects(s, {
        [note.id]: {
          blocks: [{ ...note.blocks[0], dueAt: date.toISOString() }],
        },
      }),
    ),
  );
  await openCalendar(host);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-28`;
  const cell = host.querySelector(`[data-date="${key}"]`);
  assert.ok(cell.querySelector(".ddl-event"));
  const nextDay = host.querySelector(`[data-date="${key.slice(0, -2)}29"]`);
  assert.equal(nextDay.querySelector(".ddl-event"), null);
  await click(findText(cell, "28"));
  assert.ok(dayPanel().textContent.includes("任务 1"));
  assert.equal(dayPanel().querySelectorAll(".deadline-day-task").length, 1);
});

test("改期沿用日期选择器，保存后月历重新分组且来源定位回到清单", async (t) => {
  const { host, controls, note, date } = await mount(t);
  await openCalendar(host);
  await openDay(host);
  await click(dayPanel().querySelector('[aria-label="修改截止时间：任务 1"]'));
  const picker = document.querySelector(".task-deadline-popover");
  assert.ok(picker);
  const target = [...picker.querySelectorAll(".rdp-day_button")].find(
    (e) => e.textContent === "29",
  );
  await click(target);
  await click(findText(picker, "确定"));
  assert.equal(document.querySelector(".task-deadline-popover"), null);
  assert.equal(
    new Date(
      controls.state().objects.find((o) => o.id === note.id).blocks[0].dueAt,
    ).getDate(),
    29,
  );
  assert.equal(dayPanel().querySelectorAll(".deadline-day-task").length, 5);
  await click(findText(dayPanel(), "在清单中查看"));
  assert.equal(
    host
      .querySelector('[aria-label="切换到清单"]')
      .getAttribute("aria-pressed"),
    "true",
  );
});

test("编辑中协作者将截止时间改到其他日期，旧草稿不能覆盖且可以关闭", async (t) => {
  const { host, controls, note, date } = await mount(t);
  await openCalendar(host);
  await openDay(host);
  await click(dayPanel().querySelector('[aria-label="修改截止时间：任务 1"]'));
  date.setDate(29);
  await act(async () =>
    controls.update((s) =>
      patchObjects(s, {
        [note.id]: {
          blocks: note.blocks.map((b, i) =>
            i === 0 ? { ...b, dueAt: date.toISOString() } : b,
          ),
        },
      }),
    ),
  );
  const picker = document.querySelector(".task-deadline-popover");
  assert.ok(picker, "协作改期时编辑弹层保持可关闭并提示冲突");
  await click(findText(picker, "确定"));
  assert.match(picker.textContent, /已被协作者修改/);
  assert.equal(
    controls.state().objects.find((o) => o.id === note.id).blocks[0].dueAt,
    date.toISOString(),
  );
  await click(findText(picker, "取消"));
  assert.equal(document.querySelector(".task-deadline-popover"), null);
});

test("月历跟随灵感板切换，已完成可显示，只读与锁定阻止写入", async (t) => {
  const { host, controls, note } = await mount(t);
  await openCalendar(host);
  await openDay(host);
  await act(async () => controls.setReadOnly(true));
  assert.equal(
    dayPanel().querySelector('button[aria-label="完成：任务 1"]').disabled,
    true,
  );
  await act(async () => {
    controls.setReadOnly(false);
    controls.update((s) => patchObjects(s, { [note.id]: { locked: true } }));
  });
  assert.equal(
    dayPanel().querySelector('button[aria-label="完成：任务 1"]').disabled,
    true,
  );
  await click(host.querySelector('[role="tab"][aria-label="内容计划"]'));
  assert.equal(dayPanel(), null);
  assert.ok(
    host
      .querySelector(".deadline-calendar")
      .textContent.includes("另一个灵感板"),
  );
  assert.ok(
    !host.querySelector(".deadline-calendar").textContent.includes("任务 1"),
  );
});

test("切换月历后编辑快捷键不调用已卸载清单的旧选择", async (t) => {
  const { host, controls } = await mount(t);
  await act(async () => controls.api.current.selectAll());
  await openCalendar(host);
  await act(async () => controls.api.current.editSelected());
  assert.equal(controls.edits.length, 0);
});

test("从月历取出无 DDL 的收纳任务后切到清单定位", async (t) => {
  const { host, controls, boardId, page } = await mount(t);
  const dock = createObject(boardId, "collection");
  const stored = {
    ...createObject(boardId, "note"),
    parentId: dock.id,
    noteKind: "checklist",
    blocks: [makeBlock("恢复的未设日期任务")],
  };
  await act(async () =>
    controls.update((s) => ({ ...s, objects: [...s.objects, dock, stored] })),
  );
  await openCalendar(host);
  await act(async () =>
    controls.api.current.takeOutArranged(stored.id, page.id),
  );
  assert.equal(
    host
      .querySelector('[aria-label="切换到清单"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(
    host
      .querySelector(".arranged-columns")
      .textContent.includes("恢复的未设日期任务"),
  );
});
