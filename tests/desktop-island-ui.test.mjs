import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/app",
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
  "localStorage",
  "sessionStorage",
  "location",
  "history",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 5);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/desktop-island-ui-", import.meta.url),
);
await build({
  stdin: {
    contents: `
    export { default as DynamicIsland } from './src/island/DynamicIsland.jsx';
    export { createWorkspace, createObject, makeBlock, patchObjects } from './src/canvas/model.js';
    export { default as DesktopIslandWorkspace } from './src/desktop/DesktopIslandWorkspace.jsx';
    export { default as DesktopFrame } from './src/desktop/DesktopFrame.jsx';
    export { getDesktopBridge, requestDesktopLayout } from './src/desktop/bridge.js';
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
      name: "test-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
        builder.onResolve(
          { filter: /sync\/useRoomWorkspace\.js$/ },
          (args) => ({ path: args.path, namespace: "workspace" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "workspace" }, () => ({
          contents:
            "export const useRoomWorkspace = (...args) => globalThis.desktopTestWorkspace(...args);",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const {
  DynamicIsland,
  DesktopIslandWorkspace,
  DesktopFrame,
  getDesktopBridge,
  requestDesktopLayout,
  createWorkspace,
  createObject,
  makeBlock,
  patchObjects,
} = await import(pathToFileURL(path.join(output, "ui.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

function bridgeFixture() {
  const calls = {
    layout: [],
    hidden: 0,
    opened: [],
    handlers: new Set(),
    placementHandlers: new Set(),
    drag: [],
    placement: {
      dock: "top",
      dragging: false,
      railOffset: 12,
      maxHeight: 1080,
      maxWidth: 1920,
    },
  };
  const bridge = {
    version: 1,
    getPlacement: async () => calls.placement,
    onPlacement: (callback) => {
      calls.placementHandlers.add(callback);
      return () => calls.placementHandlers.delete(callback);
    },
    drag: async (action) => {
      calls.drag.push(action);
      calls.placement = {
        ...calls.placement,
        dragging: action === "start" || action === "move",
      };
      for (const callback of calls.placementHandlers) callback(calls.placement);
      return calls.placement;
    },
    setLayout: (value) => {
      calls.layout.push(value);
    },
    hide: () => {
      calls.hidden++;
    },
    openWorkspace: (id) => {
      calls.opened.push(id);
    },
    onBeforeQuit: (callback) => {
      calls.handlers.add(callback);
      return () => calls.handlers.delete(callback);
    },
  };
  return { bridge, calls };
}
async function mount(
  t,
  { desktop = false, wrapper = false, overrides = {} } = {},
) {
  const initial = createWorkspace();
  const room = { ...initial.boards[0], role: "owner" };
  const note = {
    ...createObject(room.id, "note"),
    noteKind: "checklist",
    blocks: [makeBlock("桌面真实待办")],
  };
  initial.objects = [note];
  const controls = {
    flushed: 0,
    retry: 0,
    choices: [],
    left: 0,
    drafts: [],
    hookCalls: 0,
  };
  const { bridge, calls } = bridgeFixture();
  window.qingdanDesktop = bridge;
  t.after(() => {
    delete window.qingdanDesktop;
    delete globalThis.desktopTestWorkspace;
  });
  function Fixture() {
    const [state, setState] = useState(initial);
    const [patch, setPatch] = useState(overrides);
    const current = useRef(state);
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
      startupReady: true,
      status: "saved",
      readOnly: false,
      assets: new Map(),
      end() {},
      flushLocal: async () => {
        controls.flushed++;
      },
      retry: () => {
        controls.retry++;
      },
      resolve: (choice) => {
        controls.choices.push(choice);
      },
      toggleBlock: (noteId, blockId) =>
        update((latest) =>
          patchObjects(latest, {
            [noteId]: {
              blocks: latest.objects
                .find((item) => item.id === noteId)
                .blocks.map((block) =>
                  block.id === blockId
                    ? { ...block, done: !block.done }
                    : block,
                ),
            },
          }),
        ),
      ...patch,
    };
    controls.setPatch = setPatch;
    controls.state = () => current.current;
    globalThis.desktopTestWorkspace = (...args) => {
      controls.hookCalls++;
      controls.hookArgs = args;
      return workspace;
    };
    const content = desktop
      ? React.createElement(DesktopIslandWorkspace, {
          room,
          user: { id: "desktop-user", name: "测试用户" },
          onLeave: () => {
            controls.left++;
          },
        })
      : React.createElement(DynamicIsland, {
          workspace,
          boardId: room.id,
          top: 12,
          closeOnWindowBlur: true,
          panelToolbar: React.createElement("p", null, "桌面工具"),
          closeLabel: "隐藏轻岛",
          closeText: "隐藏到托盘",
          onDisable: bridge.hide,
          onDraftsChange: (drafts) => {
            controls.drafts.push(drafts);
          },
        });
    return wrapper
      ? React.createElement(DesktopFrame, { mode: "island" }, content)
      : content;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Fixture)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, room, controls, bridge, calls };
}
async function click(element) {
  assert.ok(element);
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}
const button = (host, label) =>
  [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent.trim() === label,
  );
async function type(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    ).set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("桌面胶囊失焦时收起但保留输入，钉住后失焦保持展开", async (t) => {
  const { host, controls } = await mount(t);
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "还没提交的内容");
  await act(async () => window.dispatchEvent(new Event("blur")));
  assert.equal(
    button(host, "展开轻岛")?.getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(host.querySelector("textarea").value, "还没提交的内容");
  assert.ok(Object.values(controls.drafts.at(-1)).includes("还没提交的内容"));
  await click(button(host, "展开轻岛"));
  await click(button(host, "钉住轻岛"));
  await act(async () => window.dispatchEvent(new Event("blur")));
  assert.equal(button(host, "收起轻岛")?.getAttribute("aria-expanded"), "true");
});

test("桌面胶囊工具栏和关闭标签可定制，隐藏不删除任务", async (t) => {
  const { host, controls, calls } = await mount(t);
  await click(button(host, "展开轻岛"));
  assert.match(host.textContent, /桌面工具/);
  await click(button(host, "隐藏轻岛"));
  assert.equal(calls.hidden, 1);
  assert.equal(controls.state().objects.length, 1);
});

test("桌面拖动手柄独立于点击按钮，任务控件仍可操作", async (t) => {
  const { host, controls } = await mount(t, { desktop: true });
  const handle = host.querySelector('[data-desktop-drag="true"]');
  assert.ok(handle);
  assert.equal(
    handle.closest("button") === null,
    true,
    "native drag area must not be inside an interactive button",
  );
  assert.equal(handle.closest("section").getAttribute("aria-label"), "轻岛");
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, true);
});

async function pointer(element, type, x, y) {
  await act(async () => {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    element.dispatchEvent(event);
  });
}

test("桌面左右停靠显示侧签，展开保留横排任务和未提交输入", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "跨停靠保留的输入");
  for (const dock of ["left", "right", "top"]) {
    await act(async () => {
      for (const callback of calls.placementHandlers)
        callback({
          dock,
          dragging: false,
          railOffset: 80,
          maxHeight: 1080,
          maxWidth: 1920,
        });
    });
    assert.equal(host.querySelector(".dynamic-island").dataset.dock, dock);
    assert.equal(
      !!host.querySelector(".island-side-tab"),
      dock === "left" || dock === "right",
    );
    assert.equal(host.querySelector("textarea").value, "跨停靠保留的输入");
  }
  assert.equal(calls.placementHandlers.size, 1);
});

test("标题拖过阈值才移动，拖动期间收起且不会提交输入，取消后停止", async (t) => {
  const { host, calls, controls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "拖动不会提交");
  const handle = host.querySelector('[data-desktop-drag="true"]');
  await pointer(handle, "pointerdown", 100, 100);
  await pointer(handle, "pointermove", 103, 100);
  assert.deepEqual(calls.drag, []);
  await pointer(handle, "pointermove", 115, 110);
  assert.ok(calls.drag.includes("start"));
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "false");
  await pointer(handle, "pointercancel", 115, 110);
  assert.equal(calls.drag.at(-1), "cancel");
  assert.equal(host.querySelector("textarea").value, "拖动不会提交");
  assert.equal(controls.state().objects.length, 1);
  const count = calls.drag.length;
  await pointer(handle, "pointermove", 180, 110);
  assert.equal(calls.drag.length, count);
});

test("待办、展开按钮与输入框不能拖动窗口，钉住状态跨拖动保留", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  for (const target of [
    host.querySelector("textarea"),
    host.querySelector('input[type="checkbox"]'),
    button(host, "收起轻岛"),
  ]) {
    await pointer(target, "pointerdown", 50, 50);
    await pointer(target, "pointermove", 80, 70);
    await pointer(target, "pointerup", 80, 70);
  }
  assert.deepEqual(calls.drag, []);
  await click(button(host, "钉住轻岛"));
  const handle = host.querySelector('[data-desktop-drag="true"]');
  await pointer(handle, "pointerdown", 100, 100);
  await pointer(handle, "pointermove", 140, 100);
  await pointer(handle, "pointerup", 140, 100);
  assert.equal(calls.drag.at(-1), "end");
  assert.equal(
    button(host, "取消钉住轻岛").getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
});

test("连续两次拖动遇到延迟IPC时按开始结束顺序串行，旧结束不打断新拖动", async (t) => {
  const { host, bridge } = await mount(t, { desktop: true });
  const sent = [];
  let release;
  bridge.drag = (action) => {
    sent.push(action);
    if (sent.length === 1)
      return new Promise((resolve) => {
        release = () =>
          resolve({ dock: "free", dragging: true, railOffset: 12 });
      });
    return Promise.resolve({
      dock: "free",
      dragging: action === "start",
      railOffset: 12,
    });
  };
  const handle = host.querySelector('[data-desktop-drag="true"]');
  await pointer(handle, "pointerdown", 100, 100);
  await pointer(handle, "pointermove", 120, 100);
  await pointer(handle, "pointerup", 120, 100);
  await pointer(handle, "pointerdown", 150, 100);
  await pointer(handle, "pointermove", 180, 100);
  await act(async () => {
    release();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(sent, ["start", "end", "start"]);
  assert.equal(host.querySelector(".dynamic-island").dataset.dragging, "true");
  await pointer(handle, "pointerup", 180, 100);
  assert.equal(sent.at(-1), "end");
});

test("未越过拖动阈值时不重定向点击，侧签单击可正常展开", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  await act(async () => {
    for (const cb of calls.placementHandlers)
      cb({ dock: "left", dragging: false, railOffset: 12 });
  });
  const tab = host.querySelector(".island-side-tab"),
    wrapper = host.querySelector(".dynamic-island-dock"),
    captures = [];
  tab.setPointerCapture = () => captures.push("tab");
  wrapper.setPointerCapture = () => captures.push("wrapper");
  await pointer(tab, "pointerdown", 20, 45);
  await pointer(tab, "pointerup", 20, 45);
  assert.deepEqual(captures, []);
  await click(tab);
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
});

test("原生移动造成指针捕获丢失时结束在当前位置，不回跳原位置", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  const handle = host.querySelector('[data-desktop-drag="true"]');
  await pointer(handle, "pointerdown", 100, 100);
  await pointer(handle, "pointermove", 140, 100);
  await pointer(
    host.querySelector(".dynamic-island-dock"),
    "lostpointercapture",
    140,
    100,
  );
  assert.equal(calls.drag.at(-1), "end");
});

test("只有完整 preload bridge 启用桌面模式，URL 参数不能独自启用", async () => {
  assert.equal(
    typeof getDesktopBridge,
    "function",
    "desktop bridge gate is implemented",
  );
  delete window.qingdanDesktop;
  history.replaceState(null, "", "/app?desktopIsland=1");
  assert.equal(getDesktopBridge(), null);
  window.qingdanDesktop = { version: 1 };
  assert.equal(getDesktopBridge(), null);
  window.qingdanDesktop = bridgeFixture().bridge;
  assert.equal(getDesktopBridge(), window.qingdanDesktop);
  delete window.qingdanDesktop;
});

test("桌面工作区复用真实待办与固定身份，退出等待保存且报告未同步和输入", async (t) => {
  assert.equal(
    typeof DesktopIslandWorkspace,
    "function",
    "desktop workspace is implemented",
  );
  const { host, room, controls, calls } = await mount(t, {
    desktop: true,
    wrapper: true,
    overrides: { dirty: true },
  });
  assert.deepEqual(controls.hookArgs[2], { draftIdentity: "desktop-v1" });
  assert.equal(
    calls.handlers.size,
    1,
    "setup quit handler must not shadow workspace handler",
  );
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, true);
  await type(host.querySelector("textarea"), "本地输入");
  const result = await [...calls.handlers][0]();
  assert.equal(controls.flushed, 1);
  assert.deepEqual(result, {
    unsynced: true,
    hasDraft: true,
    accountId: "desktop-user",
    roomId: room.id,
  });
  await click(button(host, "在浏览器打开画布"));
  assert.deepEqual(calls.opened, [room.id]);
  await click(button(host, "隐藏轻岛"));
  assert.equal(calls.hidden, 1);
  await act(async () =>
    controls.setPatch({
      flushLocal: async () => {
        throw Error("磁盘保存失败");
      },
    }),
  );
  await assert.rejects([...calls.handlers][0](), /磁盘保存失败/);
});

test("桌面冲突与连接错误有恢复操作，锁定任务不被写入", async (t) => {
  assert.equal(
    typeof DesktopIslandWorkspace,
    "function",
    "desktop workspace is implemented",
  );
  const { host, controls } = await mount(t, {
    desktop: true,
    overrides: { conflict: "版本冲突", readOnly: true },
  });
  await click(button(host, "展开轻岛"));
  assert.match(host.textContent, /版本冲突/);
  assert.equal(host.querySelector('input[type="checkbox"]').disabled, true);
  await click(button(host, "保留我的冲突内容"));
  await click(button(host, "使用共享冲突内容"));
  assert.deepEqual(controls.choices, ["local", "remote"]);
  assert.ok(button(host, "先导出草稿"));
  await act(async () => controls.setPatch({ error: "连接失败" }));
  await click(button(host, "重试"));
  assert.equal(controls.retry, 1);
  assert.ok(button(host, "导出备份"));
});

test("返回画布前等待本地保存，保存失败留在原待办中", async (t) => {
  let finish;
  const saving = new Promise((resolve) => {
    finish = resolve;
  });
  const { host, controls } = await mount(t, {
    desktop: true,
    overrides: { flushLocal: () => saving },
  });
  await click(button(host, "展开轻岛"));
  await click(button(host, "返回画布列表"));
  assert.equal(controls.left, 0);
  await act(async () => {
    finish();
    await saving;
  });
  assert.equal(controls.left, 1);
  await act(async () =>
    controls.setPatch({
      flushLocal: async () => {
        throw Error("本地磁盘不可用");
      },
    }),
  );
  await click(button(host, "返回画布列表"));
  assert.equal(controls.left, 1);
  assert.match(host.textContent, /本地磁盘不可用/);
});

test("加载错误卡片按真实高度调整窗口，重试和返回入口保留", async (t) => {
  const oldBounds = HTMLElement.prototype.getBoundingClientRect;
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", function () {
    return this.classList.contains("desktop-loading-card")
      ? { x: 12, y: 12, width: 420, height: 300 }
      : oldBounds.call(this);
  });
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    overrides: { state: null, error: "网络暂时不可用" },
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  assert.deepEqual(calls.layout.at(-1), {
    mode: "island",
    width: 444,
    height: 324,
  });
  const callsBeforeRetry = controls.hookCalls;
  await click(button(host, "重试"));
  assert.equal(controls.retry, 0);
  assert.ok(controls.hookCalls > callsBeforeRetry);
  assert.ok(button(host, "返回画布列表"));
});

test("桌面最大高度使用显示器区域而非收起窗口高度", async () => {
  const { bridge } = bridgeFixture();
  bridge.setLayout = async () => ({ width: 354, height: 76, maxHeight: 540 });
  requestDesktopLayout(bridge, { mode: "island", width: 354, height: 76 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    document.documentElement.style.getPropertyValue("--desktop-max-height"),
    "540px",
  );
  bridge.setLayout = async () => ({ maxHeight: Number.NaN });
  requestDesktopLayout(bridge, { mode: "island", width: 354, height: 76 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    document.documentElement.style.getPropertyValue("--desktop-max-height"),
    "540px",
  );
  document.documentElement.style.removeProperty("--desktop-max-height");
});
