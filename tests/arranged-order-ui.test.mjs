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
globalThis.localStorage = dom.window.localStorage;
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

async function mount(t, { accountId } = {}) {
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
    const [libraryKey, setAccount] = useState(accountId);
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
      setAccount,
      state: () => current.current,
    });
    return React.createElement(
      TodoToolsProvider,
      { workspace, scope: "test", beforeAction() {}, onToast() {} },
      React.createElement(ArrangedWorkspace, {
        workspace,
        boardId,
        libraryKey,
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

test("常用清单从账号读取，每次一键添加生成独立新待办且保留模板", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return Response.json({
      items: [
        {
          id: "lunch",
          text: "中午12点吃饭",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
  });
  const { host, controls } = await mount(t, { accountId: "account-lunch" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  await click(
    document.querySelector('[aria-label="添加常用待办：中午12点吃饭"]'),
  );
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  await click(
    document.querySelector('[aria-label="添加常用待办：中午12点吃饭"]'),
  );
  const lunches = controls
    .state()
    .objects.flatMap((o) => o.blocks || [])
    .filter((b) => b.runs?.[0]?.text === "中午12点吃饭");
  assert.equal(lunches.length, 2);
  assert.notEqual(lunches[0].id, lunches[1].id);
  assert.notEqual(lunches[0].createdAt, "2020-01-01T00:00:00.000Z");
  assert.ok(
    requests.every(
      (r) => r.options.headers["X-QD-Account"] === "account-lunch",
    ),
  );
});

test("常用清单保存失败保留输入并显示错误，重试成功后再清空", async (t) => {
  let fail = true;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST") {
      if (fail)
        return Response.json({ error: "暂时无法保存" }, { status: 503 });
      return Response.json({
        items: [
          {
            id: "water",
            text: JSON.parse(options.body).text,
            createdAt: "2026-10-27T00:00:00.000Z",
          },
        ],
      });
    }
    return Response.json({ items: [] });
  });
  const { host } = await mount(t, { accountId: "account-retry" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  const input = document.querySelector('[aria-label="常用待办内容"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input, "喝水");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(document.querySelector(".quick-task-save"));
  assert.equal(input.value, "喝水");
  assert.match(
    document.querySelector(".quick-task-library").textContent,
    /暂时无法保存/,
  );
  fail = false;
  await click(document.querySelector(".quick-task-save"));
  assert.equal(input.value, "");
  assert.ok(!!document.querySelector('[aria-label="添加常用待办：喝水"]'));
});

test("只迁入当前账号的本地模板，云端删除后重开不会再次导入", async (t) => {
  const legacy = {
    id: "legacy-one",
    text: "旧账号模板",
    createdAt: "2026-10-20T00:00:00.000Z",
  };
  localStorage.setItem(
    "qingdan.quick-tasks:account-migrate",
    JSON.stringify([legacy]),
  );
  localStorage.setItem(
    "qingdan.quick-tasks:other-account",
    JSON.stringify([{ ...legacy, id: "private", text: "其他账号的模板" }]),
  );
  let items = [],
    imports = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST") {
      items.push(JSON.parse(options.body));
      imports++;
    }
    if (options.method === "DELETE") items = [];
    return Response.json({ items });
  });
  const { host } = await mount(t, { accountId: "account-migrate" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  assert.equal(imports, 1);
  assert.deepEqual(items, [legacy]);
  await click(
    document.querySelector('[aria-label="删除常用待办：旧账号模板"]'),
  );
  await click(document.querySelector('[aria-label="关闭弹窗"]'));
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  assert.equal(imports, 1);
  assert.equal(document.querySelectorAll(".quick-task-item").length, 0);
});

test("切换账号后旧清单请求迟到，不会显示或导入到新账号", async (t) => {
  let finishOld;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.headers["X-QD-Account"] === "account-slow")
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    return Response.json({
      items: [
        { id: "b", text: "新账号模板", createdAt: "2026-10-27T00:00:00.000Z" },
      ],
    });
  });
  const { host, controls } = await mount(t, { accountId: "account-slow" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  await act(async () => controls.setAccount("account-fast"));
  await act(async () =>
    finishOld(
      Response.json({
        items: [
          {
            id: "a",
            text: "旧账号私有模板",
            createdAt: "2026-10-27T00:00:00.000Z",
          },
        ],
      }),
    ),
  );
  assert.ok(
    !!document.querySelector('[aria-label="添加常用待办：新账号模板"]'),
  );
  assert.equal(
    document.querySelectorAll('[aria-label="添加常用待办：旧账号私有模板"]')
      .length,
    0,
  );
  assert.doesNotMatch(
    localStorage.getItem("qingdan.quick-tasks:account-fast"),
    /旧账号/,
  );
});

test("账号库满时保留待迁入的本地模板，删除一项后可以重试迁入", async (t) => {
  const legacy = {
    id: "pending",
    text: "待迁入模板",
    createdAt: "2026-10-20T00:00:00.000Z",
  };
  localStorage.setItem(
    "qingdan.quick-tasks:account-full",
    JSON.stringify([legacy]),
  );
  let items = Array.from({ length: 100 }, (_, i) => ({
    ...legacy,
    id: `saved-${i}`,
    text: `已保存${i}`,
  }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      if (items.length === 100)
        return Response.json(
          { error: "常用清单最多保存 100 条" },
          { status: 409 },
        );
      items.push(JSON.parse(options.body));
    }
    if (options.method === "DELETE")
      items = items.filter((item) => !url.endsWith(`/${item.id}`));
    return Response.json({ items });
  });
  const { host } = await mount(t, { accountId: "account-full" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  const remove = document.querySelector('[aria-label="删除常用待办：已保存0"]');
  assert.ok(!!remove, "迁入失败仍可管理账号里的已有模板");
  assert.equal(remove.disabled, false);
  await click(remove);
  assert.deepEqual(
    JSON.parse(localStorage.getItem("qingdan.quick-tasks:account-full")),
    [legacy],
  );
  await click(document.querySelector(".quick-task-error button"));
  assert.ok(
    !!document.querySelector('[aria-label="添加常用待办：待迁入模板"]'),
  );
  assert.equal(items.length, 100);
});
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
  assert.equal(button.textContent.trim(), "", "DDL 排序按钮只显示图标");
  assert.ok(button.querySelector("svg"), "DDL 排序按钮保留排序图标");
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

test("排列模式每条待办的删除按钮只移除当前待办", async (t) => {
  const { host, controls } = await mount(t);
  const button = host.querySelector('[aria-label="删除待办：晚截止"]');
  assert.ok(button, "每条待办都应提供单条删除按钮");
  await click(button);
  assert.deepEqual(order(host), ["none", "early"]);
  const doneRow = host.querySelector('[data-task-id="done"]');
  assert.ok(doneRow, "完成栏待办不应被误删");
  assert.equal(controls.state().trash[0].task.block.id, "late");
});

test("清空已完成先确认数量，取消确认不会删除待办", async (t) => {
  const { host, controls } = await mount(t);
  const clearButton = host.querySelector('[aria-label="清空已完成待办"]');
  assert.ok(clearButton);
  const originalConfirm = window.confirm;
  let message = "";
  window.confirm = (value) => {
    message = value;
    return false;
  };
  try {
    await click(clearButton);
  } finally {
    window.confirm = originalConfirm;
  }
  assert.match(message, /1 条已完成待办/);
  assert.ok(host.querySelector('[data-task-id="done"]'));
  assert.equal(controls.state().trash.length, 0);
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

test("常用清单库可以保存模板并一键添加到当前清单", async (t) => {
  window.localStorage.clear();
  let items = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST")
      items.push({
        ...JSON.parse(options.body),
        createdAt: "2026-10-27T00:00:00.000Z",
      });
    return Response.json({ items });
  });
  const { host, controls } = await mount(t, { accountId: "account-save" });
  await click(host.querySelector('[aria-label="打开常用清单"]'));
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog?.classList.contains("quick-task-library"));
  const input = dialog.querySelector('textarea[aria-label="常用待办内容"]');
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setter.call(input, "中午12点吃饭");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(dialog.querySelector('button[type="submit"]'));
  const quick = dialog.querySelector(
    '[aria-label="添加常用待办：中午12点吃饭"]',
  );
  assert.ok(quick, "保存后立即出现可复用的待办模板");
  await click(quick);
  const added = controls
    .state()
    .objects.flatMap((object) => object.blocks || [])
    .find((block) => block.runs?.some((run) => run.text === "中午12点吃饭"));
  assert.ok(added, "点击模板后新增待办");
  assert.equal(document.querySelector('[role="dialog"]'), null);
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
