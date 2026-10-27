import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";

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
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(new URL("../.tmp/deadline-ui-", import.meta.url));
await build({
  stdin: {
    contents:
      'export { TaskDeadlinePopover } from "./src/canvas/TaskDeadline.jsx"; export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, createInspirationBoard, makeBlock } from "./src/canvas/model.js";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "omit-css-in-dom-tests",
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
  outfile: path.join(output, "picker.mjs"),
});
const {
  TaskDeadlinePopover,
  ArrangedWorkspace,
  TodoToolsProvider,
  createWorkspace,
  createObject,
  createInspirationBoard,
  makeBlock,
} = await import(pathToFileURL(path.join(output, "picker.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

async function mount(t, { saveError = "" } = {}) {
  const host = document.createElement("main");
  document.body.append(host);
  const saves = [];
  const controls = {};
  function Fixture() {
    const [active, setActive] = useState(0);
    const [values, setValues] = useState(["2028-02-29T02:05:00.000Z", null]);
    const [starts, setStarts] = useState([null, null]);
    const [disabled, setDisabled] = useState(false);
    controls.setDisabled = setDisabled;
    return React.createElement(
      "div",
      null,
      [0, 1].map((index) =>
        React.createElement(
          "div",
          { className: "todo-row", key: index },
          React.createElement(
            TaskDeadlinePopover,
            {
              open: active === index,
              onOpenChange: (open) => setActive(open ? index : null),
              task: {
                title: `待办 ${index + 1}`,
                dueAt: values[index],
                dueStartAt: starts[index],
              },
              disabled,
              onClose: () => setActive(null),
              onSave: (value, dueStartAt = null) => {
                if (saveError) return saveError;
                saves.push({
                  index,
                  value,
                  ...(dueStartAt ? { dueStartAt } : {}),
                });
                setStarts((before) =>
                  before.map((old, i) => (i === index ? dueStartAt : old)),
                );
                setValues((before) =>
                  before.map((old, i) => (i === index ? value : old)),
                );
                setActive(null);
              },
            },
            React.createElement(
              "button",
              { type: "button" },
              `选择时间 ${index + 1}`,
            ),
          ),
        ),
      ),
    );
  }
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Fixture)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, saves, controls };
}
const dialog = () => document.querySelector('[role="dialog"]');
const byText = (text) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
const click = async (element) => {
  assert.ok(element, "button exists");
  await act(async () => {
    element.dispatchEvent(
      new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    element.focus();
  });
  await act(async () => element.click());
};

test("确认区间后重新打开保留两端，再点日期会保存为单日", async (t) => {
  const { saves } = await mount(t);
  const day = (label) =>
    [...dialog().querySelectorAll(".rdp-day_button")].find((button) =>
      button.getAttribute("aria-label")?.includes(label),
    );
  await click(day("2028年2月27日"));
  await click(day("2028年2月28日"));
  await click(byText("确定"));
  assert.equal(
    saves[0].dueStartAt,
    new Date("2028-02-27T00:00:00").toISOString(),
  );
  await click(byText("选择时间 1"));
  assert.match(
    dialog().querySelector(".task-deadline-summary").textContent,
    /2028年2月27日.*2028年2月28日/,
  );
  await click(day("2028年2月26日"));
  await click(byText("确定"));
  assert.equal(saves[1].dueStartAt, undefined);
  await click(byText("选择时间 1"));
  assert.doesNotMatch(
    dialog().querySelector(".task-deadline-summary").textContent,
    / – /,
  );
});

test("截止弹层脱离待办行，取消和 Escape 放弃草稿且恢复按钮焦点", async (t) => {
  const { host, saves } = await mount(t);
  assert.ok(!dialog().closest(".todo-row"), "弹层必须脱离所有待办的堆叠上下文");
  assert.equal(host.contains(dialog()), false);
  await click(byText("取消"));
  assert.equal(dialog(), null);
  assert.equal(saves.length, 0);
  await click(byText("选择时间 1"));
  await act(async () =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal(dialog(), null);
  assert.ok(document.activeElement === byText("选择时间 1"));
});

test("日历和时分在确认后一起保存，切换待办不会写入未保存的值", async (t) => {
  const { saves } = await mount(t);
  const day = [...dialog().querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("2028年2月28日"),
  );
  await click(day);
  assert.equal(saves.length, 0);
  const hour = dialog().querySelector(
    '[role="spinbutton"][aria-label="截止小时"]',
  );
  const minute = dialog().querySelector(
    '[role="spinbutton"][aria-label="截止分钟"]',
  );
  assert.ok(hour && minute, "提供可访问的小时和分钟滚轮");
  await act(async () => {
    minute.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  await click(byText("确定"));
  const expected = new Date("2028-02-29T02:05:00.000Z");
  expected.setDate(28);
  expected.setMinutes(6);
  assert.deepEqual(saves, [{ index: 0, value: expected.toISOString() }]);
  await click(byText("选择时间 1"));
  assert.equal(
    dialog()
      .querySelector('[aria-label="截止分钟"]')
      .getAttribute("aria-valuenow"),
    "6",
  );
  await click(byText("选择时间 2"));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.ok(dialog().textContent.includes("待办 2"));
  assert.equal(saves.length, 1);
  await click(byText("取消"));
  await click(byText("选择时间 1"));
  await click(byText("移除时间"));
  assert.deepEqual(saves.at(-1), { index: 0, value: null });
});

test("DDL 日历按单日、向后区间、向前重置和区间后重选运行", async (t) => {
  await mount(t);
  const picker = dialog();
  const day = (label) =>
    [...picker.querySelectorAll(".rdp-day_button")].find((button) =>
      button.getAttribute("aria-label")?.includes(label),
    );
  const rangeState = () => ({
    starts: picker.querySelectorAll(".rdp-range_start").length,
    ends: picker.querySelectorAll(".rdp-range_end").length,
    middle: picker.querySelectorAll(".rdp-range_middle").length,
  });

  await click(day("2028年2月28日"));
  assert.deepEqual(rangeState(), { starts: 0, ends: 0, middle: 0 });
  assert.equal(picker.querySelectorAll(".rdp-selected").length, 1);
  assert.match(
    picker.querySelector(".task-deadline-summary").textContent,
    /28日/,
  );
  assert.doesNotMatch(
    picker.querySelector(".task-deadline-summary").textContent,
    /–/,
  );

  await click(day("2028年2月29日"));
  assert.deepEqual(rangeState(), { starts: 1, ends: 1, middle: 0 });
  assert.match(
    picker.querySelector(".task-deadline-summary").textContent,
    /28日.*29日/,
  );

  await click(day("2028年2月27日"));
  assert.deepEqual(rangeState(), { starts: 0, ends: 0, middle: 0 });
  assert.equal(picker.querySelectorAll(".rdp-selected").length, 1);
  assert.match(
    picker.querySelector(".task-deadline-summary").textContent,
    /27日/,
  );

  await click(day("2028年2月29日"));
  assert.deepEqual(rangeState(), { starts: 1, ends: 1, middle: 1 });
  await click(day("2028年2月28日"));
  assert.deepEqual(rangeState(), { starts: 0, ends: 0, middle: 0 });
  assert.equal(picker.querySelectorAll(".rdp-selected").length, 1);
  assert.match(
    picker.querySelector(".task-deadline-summary").textContent,
    /28日/,
  );
});

test("小时和分钟循环到23与00，跨列操作保留选中的日期", async (t) => {
  const { saves } = await mount(t);
  const hour = dialog().querySelector('[aria-label="截止小时"]');
  const minute = dialog().querySelector('[aria-label="截止分钟"]');
  const key = async (element, value) => {
    await act(async () =>
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
    );
  };
  await key(hour, "Home");
  await key(minute, "End");
  await key(hour, "ArrowUp");
  await key(minute, "ArrowDown");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.equal(hour.getAttribute("aria-valuenow"), "23");
  assert.equal(minute.getAttribute("aria-valuenow"), "0");
  await click(byText("确定"));
  const expected = new Date("2028-02-29T02:05:00.000Z");
  expected.setHours(23, 0, 0, 0);
  assert.deepEqual(saves, [{ index: 0, value: expected.toISOString() }]);
});

test("打开后切到只读不能保存或移除，关闭仍可用", async (t) => {
  const { controls, saves } = await mount(t);
  await act(async () => controls.setDisabled(true));
  assert.equal(byText("确定").disabled, true);
  assert.equal(byText("移除时间").disabled, true);
  assert.equal(
    dialog()
      .querySelector('[aria-label="截止小时"]')
      .getAttribute("aria-disabled"),
    "true",
  );
  await act(async () =>
    dialog()
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(saves.length, 0);
  await click(byText("取消"));
  assert.equal(dialog(), null);
});

test("协作保存失败时保留草稿并展示错误", async (t) => {
  const { saves } = await mount(t, {
    saveError: "截止时间已被协作者修改，请关闭后重新设置。",
  });
  await click(byText("确定"));
  assert.ok(dialog());
  assert.match(
    dialog().querySelector('[role="alert"]').textContent,
    /协作者修改/,
  );
  assert.equal(saves.length, 0);
});

test("滚轮仍在滑动时不能确认旧值，停稳后保存最终分钟", async (t) => {
  const { saves } = await mount(t);
  const minute = dialog().querySelector('[aria-label="截止分钟"]');
  await act(async () =>
    minute.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  assert.equal(byText("确定").disabled, true, "滑动时禁止确认旧值");
  await act(async () =>
    dialog()
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(saves.length, 0);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.equal(byText("确定").disabled, false);
  await click(byText("确定"));
  const expected = new Date("2028-02-29T02:05:00.000Z");
  expected.setMinutes(6);
  assert.deepEqual(saves, [{ index: 0, value: expected.toISOString() }]);
});

test("拖动中关闭弹层会清理鼠标手势，后续页面移动不被拦截", async (t) => {
  await mount(t);
  const minute = dialog().querySelector('[aria-label="截止分钟"]');
  await act(async () => {
    minute.dispatchEvent(
      new window.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientY: 80,
      }),
    );
    document.dispatchEvent(
      new window.MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientY: 50,
      }),
    );
  });
  await act(async () =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal(dialog(), null);
  const move = new window.MouseEvent("mousemove", {
    bubbles: true,
    cancelable: true,
    clientY: 10,
  });
  document.dispatchEvent(move);
  assert.equal(
    move.defaultPrevented,
    false,
    "关闭后不能残留拦截全局鼠标移动的处理器",
  );
});

test("触摸手势被系统取消后关闭弹层，也不会残留全局鼠标监听", async (t) => {
  await mount(t);
  const minute = dialog().querySelector('[aria-label="截止分钟"]');
  await act(async () => {
    minute.dispatchEvent(
      new window.Event("touchstart", { bubbles: true, cancelable: true }),
    );
    minute.dispatchEvent(
      new window.Event("touchcancel", { bubbles: true, cancelable: true }),
    );
  });
  await act(async () =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  const move = new window.MouseEvent("mousemove", {
    bubbles: true,
    cancelable: true,
    clientY: 10,
  });
  document.dispatchEvent(move);
  assert.equal(move.defaultPrevented, false);
});

test("排列视图从截止弹层打开重命名时，新对话框不会被旧弹层关闭", async (t) => {
  const original = createWorkspace(),
    boardId = original.boards[0].id;
  const board = createInspirationBoard(boardId, { x: 80, y: 80 });
  board.title = "项目甲";
  const note = {
    ...createObject(boardId, "note"),
    parentId: board.id,
    noteKind: "checklist",
    blocks: [makeBlock("第一条待办")],
  };
  original.objects.push(board, note);
  original.preferences.views[boardId] = {
    arranged: { pageId: board.id, active: "left" },
  };
  const host = document.createElement("main");
  document.body.append(host);
  function Fixture() {
    const [state, setState] = useState(original);
    const current = React.useRef(state);
    current.current = state;
    const workspace = {
      state,
      current,
      assets: new Map(),
      assetVersion: 0,
      begin() {},
      end() {},
      update(action) {
        const next =
          typeof action === "function" ? action(current.current) : action;
        current.current = next;
        setState(next);
      },
    };
    return React.createElement(
      TodoToolsProvider,
      { workspace, scope: "test", beforeAction() {}, onToast() {} },
      React.createElement(ArrangedWorkspace, {
        workspace,
        boardId,
        apiRef: React.useRef(null),
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
  await click(host.querySelector(".todo-deadline-button"));
  assert.ok(dialog()?.classList.contains("task-deadline-popover"));
  await click(host.querySelector('[aria-label="重命名当前灵感板"]'));
  assert.ok(
    dialog()?.querySelector('[aria-label="灵感板名称"]'),
    "重命名对话框必须保持打开",
  );
  assert.equal(document.querySelectorAll(".task-deadline-popover").length, 0);
});
