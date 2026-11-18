import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUpdateController } from "../desktop/updates.cjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";
import {
  islandAppearanceKey,
  defaultIslandAppearance,
} from "../src/desktop/island-appearance.js";

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
    export { default as IslandColorSurface } from './src/desktop/IslandColorSurface.jsx';
    export { createWorkspace, createObject, makeBlock, patchObjects } from './src/canvas/model.js';
    export { default as DesktopIslandWorkspace } from './src/desktop/DesktopIslandWorkspace.jsx';
    export { default as DesktopUpdateStatus } from './src/desktop/DesktopUpdateStatus.jsx';
    export { default as DesktopUpdateCheck } from './src/desktop/DesktopUpdateCheck.jsx';
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
  IslandColorSurface,
  DesktopIslandWorkspace,
  DesktopUpdateStatus,
  DesktopUpdateCheck,
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
    checks: 0,
    opened: [],
    handlers: new Set(),
    placementHandlers: new Set(),
    updateHandlers: new Set(),
    drag: [],
    dragOrigins: [],
    placement: {
      dock: "top",
      dragging: false,
      railOffset: 12,
      maxHeight: 1080,
      maxWidth: 1920,
      supportsJade: true,
    },
  };
  const bridge = {
    version: 1,
    getUpdateState: async () => ({ status: "idle", currentVersion: "0.3.0" }),
    checkForUpdates: async () => {
      calls.checks++;
      return {
        status: "idle",
        currentVersion: "0.3.0",
        message: "当前已是最新版本",
      };
    },
    onUpdateState: (callback) => {
      calls.updateHandlers.add(callback);
      return () => calls.updateHandlers.delete(callback);
    },
    getPlacement: async () => calls.placement,
    onPlacement: (callback) => {
      calls.placementHandlers.add(callback);
      return () => calls.placementHandlers.delete(callback);
    },
    drag: async (action, origin) => {
      calls.drag.push(action);
      if (action === "start") calls.dragOrigins.push(origin);
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

test("轻岛每条待办末尾可设置、修改、清除 DDL，不触发完成并保留输入", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    count: 2,
  });
  await click(host.querySelector(".island-twin-time"));
  await type(host.querySelector("textarea"), "未提交输入保留");
  const triggers = () => [
    ...host.querySelectorAll(".island-task-row .todo-deadline-button"),
  ];
  assert.equal(triggers().length, 2);
  assert.equal(triggers()[0].closest("label"), null);
  const first = triggers()[0];
  const before = controls.state().objects[0];
  await click(first);
  const editor = host.querySelector(".island-deadline-view");
  assert.ok(editor.closest(".island-panel"), "日历留在原生浮窗可点击区域内");
  assert.equal(host.querySelector(".island-tasks-view").hidden, true);
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  const selected = editor.querySelector('.rdp-day_button[tabindex="0"]');
  assert.equal(document.activeElement, selected);
  await click(selected);
  for (const [name, key] of [
    ["截止小时", "End"],
    ["截止分钟", "Home"],
  ])
    await act(async () =>
      editor
        .querySelector(`[aria-label="${name}"]`)
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  await click(button(editor, "确定"));
  let block = controls.state().objects[0].blocks[0];
  assert.ok(block.dueAt);
  assert.equal(new Date(block.dueAt).getHours(), 23);
  assert.equal(new Date(block.dueAt).getMinutes(), 0);
  assert.equal(block.done, false);
  assert.deepEqual(controls.state().objects[0].blocks[1], before.blocks[1]);
  assert.equal(document.activeElement, first);
  assert.equal(host.querySelector("textarea").value, "未提交输入保留");
  await click(first);
  await act(async () =>
    host
      .querySelector('[aria-label="截止小时"]')
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
  );
  await click(button(host.querySelector(".island-deadline-view"), "确定"));
  assert.equal(
    new Date(controls.state().objects[0].blocks[0].dueAt).getHours(),
    0,
  );
  await click(first);
  await click(button(host.querySelector(".island-deadline-view"), "移除时间"));
  block = controls.state().objects[0].blocks[0];
  assert.equal(block.dueAt, null);
  assert.equal(block.dueStartAt, null);
  assert.equal(block.done, false);
  assert.equal(host.querySelector(".island-deadline-view"), null);
});

test("轻岛选择 DDL 时悬停离开不收起，Escape 只取消日期且归还按钮焦点", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
  });
  await click(host.querySelector(".island-twin-time"));
  const before = controls.state().objects;
  const trigger = host.querySelector(".todo-deadline-button");
  await click(trigger);
  await act(async () => {
    host.querySelector(".dynamic-island").dispatchEvent(
      new MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 340));
  });
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  await act(async () =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal(host.querySelector(".island-deadline-view"), null);
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  assert.strictEqual(controls.state().objects, before);
  assert.equal(document.activeElement, trigger);
  await click(trigger);
  await click(button(host.querySelector(".island-deadline-view"), "取消"));
  assert.strictEqual(controls.state().objects, before);
});

test("轻岛 DDL 保存重查协作日期和最新锁定，拒绝覆盖并保留编辑器", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
  });
  await click(host.querySelector(".island-twin-time"));
  await click(host.querySelector(".todo-deadline-button"));
  const remoteDue = "2031-05-23T08:30:00.000Z";
  controls.receiveBeforeRender((state) => ({
    ...state,
    objects: state.objects.map((note) => ({
      ...note,
      blocks: note.blocks.map((block) => ({ ...block, dueAt: remoteDue })),
    })),
  }));
  await click(button(host.querySelector(".island-deadline-view"), "确定"));
  assert.equal(controls.state().objects[0].blocks[0].dueAt, remoteDue);
  assert.match(
    host.querySelector('.island-deadline-view [role="alert"]').textContent,
    /协作者修改/,
  );
  await click(button(host.querySelector(".island-deadline-view"), "取消"));
  await click(host.querySelector(".todo-deadline-button"));
  controls.receiveBeforeRender((state) => ({
    ...state,
    objects: state.objects.map((note) => ({ ...note, locked: true })),
  }));
  await click(button(host.querySelector(".island-deadline-view"), "移除时间"));
  assert.equal(controls.state().objects[0].blocks[0].dueAt, remoteDue);
  assert.match(
    host.querySelector('.island-deadline-view [role="alert"]').textContent,
    /锁定/,
  );
});

test("轻岛只读禁止设置 DDL，打开后失去编辑权禁用确认与清除", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    overrides: { readOnly: true },
  });
  await click(host.querySelector(".island-twin-time"));
  assert.equal(host.querySelector(".todo-deadline-button").disabled, true);
  await act(async () => controls.setPatch({ readOnly: false }));
  await click(host.querySelector(".todo-deadline-button"));
  const before = controls.state().objects;
  await act(async () => controls.setPatch({ readOnly: true }));
  const editor = host.querySelector(".island-deadline-view");
  assert.equal(button(editor, "确定").disabled, true);
  await act(async () =>
    editor
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.strictEqual(controls.state().objects, before);
  await click(button(editor, "取消"));
  assert.equal(host.querySelector(".island-deadline-view"), null);
});
async function mount(
  t,
  {
    desktop = false,
    wrapper = false,
    overrides = {},
    count = 1,
    supportsJade = true,
    supportsTwinIsland = false,
    supportsRetainedTwinIsland = false,
    supportsFixedTwinFrame = false,
    supportsIslandResize = false,
  } = {},
) {
  const initial = createWorkspace();
  const room = { ...initial.boards[0], role: "owner" };
  const note = {
    ...createObject(room.id, "note"),
    noteKind: "checklist",
    blocks: Array.from({ length: count }, (_, i) =>
      makeBlock(i ? `桌面待办 ${i + 1}` : "桌面真实待办"),
    ),
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
  calls.placement.supportsJade = supportsJade;
  calls.placement.supportsTwinIsland = supportsTwinIsland;
  calls.placement.supportsRetainedTwinIsland = supportsRetainedTwinIsland;
  calls.placement.supportsFixedTwinFrame = supportsFixedTwinFrame;
  calls.placement.supportsIslandResize = supportsIslandResize;
  window.qingdanDesktop = bridge;
  t.after(() => {
    delete window.qingdanDesktop;
    delete globalThis.desktopTestWorkspace;
  });
  function Fixture() {
    const [state, setState] = useState(initial);
    const [patch, setPatch] = useState(overrides);
    const [generation, setGeneration] = useState(0);
    const [account, setAccount] = useState("desktop-user");
    controls.remount = () => setGeneration((value) => value + 1);
    controls.setAccount = setAccount;
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
    controls.update = update;
    controls.receiveBeforeRender = (action) => {
      current.current = action(current.current);
    };
    globalThis.desktopTestWorkspace = (...args) => {
      controls.hookCalls++;
      controls.hookArgs = args;
      return workspace;
    };
    const content = desktop
      ? React.createElement(DesktopIslandWorkspace, {
          key: `${account}/${generation}`,
          room,
          user: { id: account, name: "测试用户" },
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

async function appearanceInput(host, label, value) {
  await act(async () => {
    const input = host.querySelector(`[aria-label="${label}"]`);
    assert.ok(input, label);
    const prototype =
      input.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("双岛直接完成沿用真实任务，过渡期间重复点击不完成下一条", async (t) => {
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 2,
  });
  assert.equal(host.querySelector(".dynamic-island").dataset.layout, "twins");
  assert.equal(host.querySelector(".island-twin-time").textContent, "剩余2 项");
  const first = host.querySelector(".island-twin-complete");
  await act(async () => {
    first.click();
    first.click();
  });
  assert.deepEqual(
    controls.state().objects[0].blocks.map((b) => !!b.done),
    [true, false],
  );
  assert.equal(
    host.querySelector(".island-twin-out").textContent,
    "桌面真实待办",
  );
  assert.equal(
    host.querySelector(".island-twin-current").textContent,
    "桌面待办 2",
  );
  assert.equal(host.querySelector(".island-twin-complete").disabled, true);
  await act(async () => new Promise((r) => setTimeout(r, 500)));
  await click(host.querySelector(".island-twin-complete"));
  assert.equal(host.querySelector(".island-twin-complete"), null);
  assert.equal(host.querySelector(".dynamic-island").dataset.empty, "true");
  assert.equal(host.querySelector(".island-twin-time").textContent, "已清空");
  await act(async () => new Promise((r) => setTimeout(r, 15)));
  assert.equal(calls.layout.at(-1).appearance, "jade-twins");
  assert.equal(calls.layout.at(-1).empty, true);
});

test("双岛左右贴边悬停小仓打开完整面板，空态新增和完成恢复仍工作", async (t) => {
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 0,
  });
  for (const side of ["left", "right"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock: side };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    assert.equal(host.querySelector(".island-twin-complete"), null);
    await act(async () => {
      host.querySelector(".island-twin-time").dispatchEvent(
        new MouseEvent("pointerover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await new Promise((r) => setTimeout(r, 150));
    });
    assert.equal(host.querySelector(".dynamic-island").dataset.peek, "false");
    assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
    assert.equal(
      host.querySelector(".island-panel").hasAttribute("inert"),
      false,
    );
    await type(host.querySelector("textarea"), `保留${side}草稿`);
    await click(button(host, "收起轻岛"));
    assert.equal(document.activeElement, button(host, "展开轻岛"));
  }
  await click(button(host, "展开轻岛"));
  await click(button(host, "添加待办"));
  assert.equal(controls.state().objects.length, 2);
  await click(button(host, "收起轻岛"));
  assert.equal(host.querySelector(".island-twin-complete"), null);
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  await click(button(host, "已完成 1"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[1].blocks[0].done, false);
});

async function hoverIsland(
  element,
  entered,
  relatedTarget = document.body,
  pointerType = "mouse",
  buttons = 0,
) {
  await act(async () => {
    const event = new MouseEvent(entered ? "pointerover" : "pointerout", {
      bubbles: true,
      relatedTarget,
      buttons,
    });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    element.dispatchEvent(event);
  });
}

test("双岛横向与左右悬停显示全部待办，移入列表和短暂移出不会收起", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, calls, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    count: 36,
  });
  const state = controls.state();
  const island = host.querySelector(".dynamic-island");
  const panel = host.querySelector(".island-panel");
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  for (const dock of ["top", "left", "right"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    const capsule = host.querySelector(".island-twin-time");
    await hoverIsland(capsule, true);
    await tick(119);
    assert.equal(island.dataset.open, "false");
    await tick(1);
    assert.equal(island.dataset.open, "true");
    assert.equal(panel.hasAttribute("inert"), false);
    assert.equal(host.querySelector(".island-twin-header").hidden, false);
    assert.equal(capsule.getAttribute("aria-expanded"), "true");
    assert.equal(host.querySelectorAll(".island-task-row").length, 36);
    assert.equal(
      host.querySelectorAll(".island-task-text")[35].textContent,
      "桌面待办 36",
    );
    await tick(10);
    assert.equal(calls.layout.at(-1).expanded, true);
    assert.equal(calls.layout.at(-1).dock, dock);
    assert.equal(calls.layout.at(-1).retained, true);
    await hoverIsland(capsule, false, panel);
    await tick(400);
    assert.equal(island.dataset.open, "true");
    await hoverIsland(panel, false);
    await tick(200);
    await hoverIsland(panel, true);
    await tick(400);
    assert.equal(island.dataset.open, "true");
    await hoverIsland(panel, false);
    await tick(299);
    assert.equal(island.dataset.open, "true");
    await tick(1);
    assert.equal(island.dataset.open, "false");
  }
  assert.strictEqual(
    controls.state(),
    state,
    "hover never writes workspace data",
  );
});

test("小仓重新展开只显示剩余待办，设置与完成记录不会遮挡列表", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  localStorage.removeItem(islandAppearanceKey);
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 3,
  });
  const island = host.querySelector(".dynamic-island");
  const panel = host.querySelector(".island-panel");
  const settings = host.querySelector(".island-options-trigger");
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  await hoverIsland(host.querySelector(".island-twin-time"), true);
  await tick(120);
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  const taskState = controls.state();
  await click(button(host, "收起轻岛"));
  for (const dock of ["top", "left", "right"]) {
    for (const exit of ["collapse", "leave", "blur", "drag"]) {
      await act(async () => {
        calls.placement = { ...calls.placement, dock, dragging: false };
        for (const handler of calls.placementHandlers) handler(calls.placement);
      });
      await hoverIsland(host.querySelector(".island-twin-time"), true);
      await tick(120);
      assert.equal(island.dataset.open, "true");
      assert.equal(
        settings.getAttribute("aria-expanded"),
        "false",
        `${dock}/${exit}: hover opens tasks`,
      );
      assert.equal(
        host.querySelectorAll('.island-task-row[data-done="false"]').length,
        2,
      );
      await click(button(host, "已完成 1"));
      assert.equal(
        host.querySelectorAll('.island-task-row[data-done="true"]').length,
        1,
      );
      await click(settings);
      assert.equal(
        settings.getAttribute("aria-expanded"),
        "true",
        "settings require an explicit click",
      );
      await appearanceInput(host, "轻岛配色组合", "sage");
      if (exit === "collapse") await click(button(host, "收起轻岛"));
      else if (exit === "leave") {
        await hoverIsland(panel, false);
        await tick(300);
        assert.equal(
          island.dataset.open,
          "true",
          "clicked settings remain open while choosing a version",
        );
        await pointer(document.body, "pointerdown", 900, 900);
      } else if (exit === "blur") {
        await act(async () => window.dispatchEvent(new Event("blur")));
      } else {
        await act(async () => {
          calls.placement = { ...calls.placement, dragging: true };
          for (const handler of calls.placementHandlers)
            handler(calls.placement);
        });
      }
      assert.equal(island.dataset.open, "false");
      assert.equal(
        settings.getAttribute("aria-expanded"),
        "false",
        `${dock}/${exit}: settings do not survive collapse`,
      );
      assert.equal(
        controls.state(),
        taskState,
        "opening and closing panels never changes tasks",
      );
      assert.equal(
        JSON.parse(localStorage.getItem(islandAppearanceKey)).profiles.glass
          .colors[0],
        "#e3e9dc",
        "closing settings preserves the saved appearance",
      );
    }
  }
});

test("双岛仅小仓悬停展开，大仓文字和小猫可拖动，移回大仓取消展开", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, calls, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
  });
  const state = controls.state();
  const island = host.querySelector(".dynamic-island");
  const main = host.querySelector(".island-twin-main");
  const capsule = host.querySelector(".island-twin-time");
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  for (const dock of ["free", "top", "left", "right"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    for (const selector of [
      ".island-twin-main",
      ".island-twin-current",
      ".island-twin-pet",
    ]) {
      const target = host.querySelector(selector);
      await hoverIsland(target, true);
      await tick(500);
      assert.equal(island.dataset.open, "false", `${dock}: hover ${selector}`);
      await click(target);
      assert.equal(island.dataset.open, "false", `${dock}: click ${selector}`);
      const before = calls.drag.length;
      await pointer(target, "pointerdown", 50, 36);
      await pointer(target, "pointermove", 53, 36);
      assert.equal(calls.drag.length, before);
      await pointer(target, "pointermove", 80, 36);
      assert.equal(calls.drag.at(-1), "start");
      assert.equal(
        host.querySelector(".island-animal").dataset.playing,
        "false",
      );
      await tick(150);
      assert.equal(island.dataset.open, "false");
      await pointer(target, "pointerup", 80, 36);
      assert.equal(calls.drag.at(-1), "end");
      await click(target);
      await tick(500);
      assert.equal(island.dataset.open, "false");
      assert.equal(
        host.querySelector(".island-animal").dataset.playing,
        "true",
      );
      await hoverIsland(target, false);
    }
    const complete = host.querySelector(".island-twin-complete");
    if (dock === "left" || dock === "right") {
      assert.equal(complete, null, "side capsules only keep the draggable cat");
    } else {
      assert.ok(complete, "horizontal capsules retain quick completion");
      await hoverIsland(complete, true);
      await tick(150);
      assert.equal(island.dataset.open, "false");
      await hoverIsland(complete, false);
    }
    await hoverIsland(capsule, true);
    await tick(60);
    await hoverIsland(capsule, false, main);
    await tick(150);
    assert.equal(island.dataset.open, "false");
    // Moving between siblings must start a fresh small-capsule timer even
    // though the pointer never leaves the shared island section.
    await hoverIsland(main, false, capsule);
    await tick(119);
    assert.equal(island.dataset.open, "false");
    await tick(1);
    assert.equal(island.dataset.open, "true");
    await click(button(host, "收起轻岛"));
    assert.equal(document.activeElement, capsule);
    await hoverIsland(island, false);
  }
  assert.strictEqual(controls.state(), state);
});

test("双岛掠过和触摸不触发悬停展开，拖动取消待展开计时，输入和钉住继续保护面板", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
  });
  const island = host.querySelector(".dynamic-island");
  const pet = host.querySelector(".island-twin-pet");
  const capsule = host.querySelector(".island-twin-time");
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  await hoverIsland(capsule, true, document.body, "touch");
  await tick(150);
  assert.equal(island.dataset.open, "false");
  await hoverIsland(capsule, true, document.body, "mouse", 1);
  await tick(150);
  assert.equal(island.dataset.open, "false");
  await hoverIsland(capsule, true);
  await tick(50);
  await hoverIsland(capsule, false);
  await tick(150);
  assert.equal(island.dataset.open, "false");
  await hoverIsland(capsule, true);
  await pointer(pet, "pointerdown", 277, 36);
  await pointer(pet, "pointermove", 307, 36);
  await hoverIsland(capsule, true);
  await tick(150);
  assert.equal(island.dataset.open, "false");
  await pointer(pet, "pointercancel", 307, 36);
  await tick(1);
  await hoverIsland(capsule, true);
  await tick(120);
  const input = host.querySelector("textarea");
  await act(async () => input.focus());
  await type(input, "悬停展开时的未提交内容");
  await hoverIsland(island, false);
  await tick(400);
  assert.equal(island.dataset.open, "true");
  await act(async () => input.blur());
  await tick(300);
  assert.equal(island.dataset.open, "false");
  assert.equal(input.value, "悬停展开时的未提交内容");
  assert.equal(controls.state().objects.length, 1);
  await hoverIsland(capsule, true);
  await tick(120);
  await click(button(host, "钉住轻岛"));
  await hoverIsland(island, false);
  await tick(400);
  assert.equal(island.dataset.open, "true");
});

test("小仓悬停后的原位点击不误完成任务，移动后正常操作，主动收起不立即重开", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 2,
  });
  const island = host.querySelector(".dynamic-island");
  const capsule = host.querySelector(".island-twin-time");
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  await hoverIsland(capsule, true);
  await pointer(capsule, "pointermove", 100, 40);
  await tick(120);
  const task = host.querySelector('.island-task-row input[type="checkbox"]');
  const clickAt = (element, x, y) =>
    act(async () => {
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
        }),
      );
    });
  await clickAt(task, 100, 40);
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  assert.equal(task.checked, false);
  await click(button(host, "收起轻岛"));
  assert.equal(island.dataset.open, "false");
  // Resizing the panel can reveal the capsule under a stationary pointer.
  await hoverIsland(capsule, true, task);
  await tick(150);
  assert.equal(island.dataset.open, "false");
  await hoverIsland(island, false);
  await hoverIsland(capsule, true);
  await pointer(capsule, "pointermove", 100, 40);
  await tick(120);
  await pointer(task, "pointermove", 120, 60);
  await clickAt(task, 120, 60);
  assert.equal(controls.state().objects[0].blocks[0].done, true);
  assert.equal(controls.state().objects[0].blocks[1].done, false);
});

test("悬浮小舱展开待办，点击打开当前画布，收起后保留未提交草稿", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, room, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    supportsFixedTwinFrame: true,
    count: 3,
  });
  const tick = (ms) => act(async () => t.mock.timers.tick(ms));
  const island = host.querySelector(".dynamic-island");
  const header = host.querySelector(".island-twin-header");
  const capsule = host.querySelector(".island-twin-time");
  for (const dock of ["top", "left", "right"]) {
    const previousOpens = calls.opened.length;
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const callback of calls.placementHandlers) callback(calls.placement);
    });
    await hoverIsland(capsule, true);
    await pointer(capsule, "pointermove", 100, 40);
    await tick(120);
    assert.equal(header.hidden, false);
    assert.equal(island.dataset.open, "true");
    assert.equal(island.dataset.fixedFrame, "true");
    assert.equal(calls.opened.length, previousOpens);
    assert.equal(capsule.getAttribute("aria-label"), "打开画布");
    const firstTask = host.querySelector(
      '.island-task-row input[type="checkbox"]',
    );
    await act(async () =>
      firstTask.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: 120,
          clientY: 300,
          screenX: 100,
          screenY: 40,
        }),
      ),
    );
    assert.equal(
      controls.state().objects[0].blocks[0].done,
      false,
      "native edge repositioning cannot put a task under a stationary click",
    );
    await act(async () =>
      capsule.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          detail: 1,
          clientX: 100,
          clientY: 40,
        }),
      ),
    );
    await act(async () =>
      capsule.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 2 }),
      ),
    );
    assert.deepEqual(calls.opened.slice(previousOpens), [room.id]);
    assert.equal(island.dataset.open, "true");
    await click(button(host, "收起轻岛"));
    await tick(200);
    assert.equal(
      island.dataset.open,
      "false",
      "explicit collapse does not bounce open",
    );
    await hoverIsland(island, false);
    await hoverIsland(capsule, true);
    await tick(120);
    assert.equal(island.dataset.open, "true");
    assert.equal(!!host.querySelector(".island-twin-complete"), dock === "top");
    await click(button(host, "收起轻岛"));
    await hoverIsland(island, false);
  }
  await click(capsule);
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, true);
  assert.equal(
    host.querySelector(".island-twin-current").textContent,
    "桌面待办 2",
  );
  await type(host.querySelector("textarea"), "保留未提交草稿");
  await click(button(host, "收起轻岛"));
  await click(capsule);
  assert.equal(host.querySelector("textarea").value, "保留未提交草稿");
  await click(button(host, "已完成 1"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  assert.equal(
    host.querySelector(".island-twin-current").textContent,
    "桌面真实待办",
  );
});

test("双岛只读、最新锁定或远端已完成均不误写，不启动成功动画", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 2,
    overrides: { readOnly: true },
  });
  assert.equal(host.querySelector(".island-twin-complete").disabled, true);
  await click(host.querySelector(".island-twin-complete"));
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  await act(async () => controls.setPatch({}));
  const stale = host.querySelector(".island-twin-complete");
  controls.receiveBeforeRender((state) =>
    patchObjects(state, { [state.objects[0].id]: { locked: true } }),
  );
  await click(stale);
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  assert.equal(host.querySelector(".island-twin-out"), null);
  await act(async () =>
    controls.update((state) =>
      patchObjects(state, { [state.objects[0].id]: { locked: false } }),
    ),
  );
  controls.receiveBeforeRender((state) =>
    patchObjects(state, {
      [state.objects[0].id]: {
        blocks: state.objects[0].blocks.map((b, i) => ({
          ...b,
          done: i === 0,
        })),
      },
    }),
  );
  await click(host.querySelector(".island-twin-complete"));
  assert.deepEqual(
    controls.state().objects[0].blocks.map((b) => b.done),
    [true, false],
  );
  assert.equal(host.querySelector(".island-twin-out"), null);
});

test("双岛完成动画卸载不再写任务，减少动态效果时立即可操作下一条", async (t) => {
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 3,
  });
  await click(host.querySelector(".island-twin-complete"));
  await act(async () => controls.remount());
  await act(async () => new Promise((r) => setTimeout(r, 500)));
  assert.deepEqual(
    controls.state().objects[0].blocks.map((b) => !!b.done),
    [true, false, false],
  );
  t.mock.method(window, "matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  await click(host.querySelector(".island-twin-complete"));
  assert.equal(host.querySelector(".island-twin-out"), null);
  assert.equal(host.querySelector(".island-twin-complete").disabled, false);
  assert.deepEqual(
    controls.state().objects[0].blocks.map((b) => !!b.done),
    [true, true, false],
  );
});

test("仅支持旧雾玉的客户端继续使用旧几何，不发送双岛请求", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  assert.equal(host.querySelector(".dynamic-island").dataset.layout, undefined);
  await act(async () => new Promise((r) => setTimeout(r, 15)));
  assert.ok(calls.layout.every((layout) => layout.appearance !== "jade-twins"));
});

test("旧桌面组件保留可操作的原布局，升级提示不会发送不兼容的双舱尺寸", async (t) => {
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsJade: false,
  });
  assert.equal(
    host.querySelector(".dynamic-island").dataset.appearance,
    undefined,
  );
  assert.equal(host.querySelector(".island-animal"), null);
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, true);
  assert.match(host.textContent, /更新本机代码并重启轻岛/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  assert.ok(calls.layout.length > 0);
  assert.ok(
    calls.layout.every((layout) => !layout.appearance && layout.width >= 240),
  );
});

test("收起显示待办摘要，悬浮展开按原顺序列出全部待办，逐条完成和恢复", async (t) => {
  const { host, controls } = await mount(t, { desktop: true, count: 36 });
  assert.equal(
    host.querySelector(".island-summary").textContent,
    "桌面真实待办",
  );
  await act(async () => {
    host.querySelector(".dynamic-island").dispatchEvent(
      new MouseEvent("pointerover", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  assert.equal(host.querySelector(".island-summary").textContent, "项目待办");
  assert.equal(host.querySelector(".island-current"), null);
  assert.equal(host.querySelector(".island-task-controls"), null);
  assert.deepEqual(
    [...host.querySelectorAll(".island-task-text")].map(
      (item) => item.textContent,
    ),
    Array.from({ length: 36 }, (_, i) =>
      i ? `桌面待办 ${i + 1}` : "桌面真实待办",
    ),
  );
  await click(
    host.querySelectorAll('.island-task-row input[type="checkbox"]')[1],
  );
  assert.equal(controls.state().objects[0].blocks[1].done, true);
  assert.equal(controls.state().objects[0].blocks[0].done, false);
  await click(button(host, "已完成 1"));
  assert.equal(host.querySelectorAll(".island-task-row").length, 1);
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[1].done, false);
  await click(button(host, "返回待办"));
  await type(host.querySelector("textarea"), "动物小跑团新增");
  await act(async () =>
    host
      .querySelector("textarea")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
  assert.equal(controls.state().objects.length, 2);
  assert.equal(host.querySelectorAll(".island-task-row").length, 37);
});

test("奔跑固定为小猫且不再轮换，隐藏及全部完成后暂停", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { host } = await mount(t, { desktop: true });
  const animal = () => host.querySelector(".island-animal");
  const first = animal().dataset.animal;
  assert.equal(first, "classic-cat");
  assert.equal(animal().dataset.playing, "true");
  await act(async () => t.mock.timers.tick(60000));
  assert.equal(animal().dataset.animal, "classic-cat");
  assert.equal(animal().dataset.playing, "true");
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  t.after(() => {
    delete document.hidden;
  });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  const paused = animal().dataset.animal;
  await act(async () => t.mock.timers.tick(30000));
  assert.equal(animal().dataset.animal, paused);
  assert.equal(animal().dataset.playing, "false");
  delete document.hidden;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(animal().dataset.playing, "true");
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(animal().dataset.playing, "false");
  const finished = animal().dataset.animal;
  await act(async () => t.mock.timers.tick(30000));
  assert.equal(animal().dataset.animal, finished);
});

test("双岛空态仍保留奔跑小猫，重新挂载也不改变动物", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    count: 0,
  });
  for (let round = 0; round < 3; round++) {
    await act(async () => t.mock.timers.tick(60000));
    assert.equal(
      host.querySelector(".island-animal").dataset.animal,
      "classic-cat",
    );
    assert.equal(host.querySelector(".island-animal").dataset.playing, "true");
    await act(async () => controls.remount());
  }
});

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
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
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

test("双岛动物拖动保留横向抓取点，完成和设置控件不触发拖动", async (t) => {
  const { host, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
  });
  const main = host.querySelector(".island-twin-main");
  const pet = host.querySelector(".island-twin-pet");
  main.getBoundingClientRect = () => ({
    left: 12,
    top: 12,
    width: 293,
    height: 48,
  });
  pet.getBoundingClientRect = () => ({
    left: 257,
    top: 16,
    width: 40,
    height: 40,
  });
  await pointer(
    host.querySelector(".island-twin-complete"),
    "pointerdown",
    40,
    36,
  );
  await pointer(
    host.querySelector(".island-twin-complete"),
    "pointermove",
    70,
    36,
  );
  await pointer(
    host.querySelector(".island-twin-complete"),
    "pointerup",
    70,
    36,
  );
  assert.deepEqual(calls.drag, []);
  await pointer(pet, "pointerdown", 277, 36);
  await pointer(pet, "pointermove", 307, 36);
  await pointer(pet, "pointerup", 307, 36);
  assert.deepEqual(calls.dragOrigins[0], { x: 277, y: 36 });
  // Suppressed click after dragging must not expand the panel.
  await click(pet);
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "false");
  await click(pet);
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "false");
  const capsule = host.querySelector(".island-twin-time");
  const beforeSmall = calls.drag.length;
  await pointer(capsule, "pointerdown", 350, 36);
  await pointer(capsule, "pointermove", 380, 36);
  await pointer(capsule, "pointerup", 380, 36);
  assert.equal(calls.drag.length, beforeSmall);
  await click(capsule);
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  const settings = host.querySelector(".island-options-trigger");
  const before = calls.drag.length;
  await pointer(settings, "pointerdown", 320, 36);
  await pointer(settings, "pointermove", 350, 36);
  await pointer(settings, "pointerup", 350, 36);
  assert.equal(calls.drag.length, before);
});

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
    host.querySelector('.island-task-row input[type="checkbox"]'),
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
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  assert.equal(controls.state().objects[0].blocks[0].done, true);
  await type(host.querySelector("textarea"), "本地输入");
  const result = await [...calls.handlers][0]();
  assert.equal(controls.flushed, 1);
  assert.deepEqual(result, {
    unsynced: true,
    hasDraft: true,
    draftsPersisted: true,
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

test("重启和切换账号分别恢复未提交输入，输入不变成待办", async (t) => {
  const { host, controls, calls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "第一行未提交\n第二行继续写");
  assert.equal((await [...calls.handlers][0]()).draftsPersisted, true);
  await act(async () => controls.remount());
  assert.equal(
    host.querySelector("textarea").value,
    "第一行未提交\n第二行继续写",
  );
  assert.equal(controls.state().objects.length, 1);
  await act(async () => controls.setAccount("another-account"));
  assert.equal(host.querySelector("textarea").value, "");
  await type(host.querySelector("textarea"), "另一个账号的草稿");
  await act(async () => controls.setAccount("desktop-user"));
  assert.equal(
    host.querySelector("textarea").value,
    "第一行未提交\n第二行继续写",
  );
});

test("输入存储失败保留当前文字并拒绝更新保存确认，恢复后可重试", async (t) => {
  const { host, calls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = () => {
    throw Error("磁盘空间不足");
  };
  t.after(() => {
    window.Storage.prototype.setItem = original;
  });
  await type(host.querySelector("textarea"), "必须保留的输入");
  assert.equal(host.querySelector("textarea").value, "必须保留的输入");
  assert.match(host.textContent, /输入尚未保存到本机/);
  await assert.rejects([...calls.handlers][0](), /磁盘空间不足/);
  window.Storage.prototype.setItem = original;
  assert.equal((await [...calls.handlers][0]()).draftsPersisted, true);
});

test("提交成功后重启不恢复已提交输入，提交保存失败时保留文字", async (t) => {
  const { host, controls } = await mount(t, { desktop: true });
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "提交后保留为待办");
  await act(async () =>
    host
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(host.querySelector("textarea").value, "");
  await act(async () => controls.remount());
  assert.equal(host.querySelector("textarea").value, "");
  assert.equal(controls.state().objects.length, 2);
  await type(host.querySelector("textarea"), "保存失败不能清空");
  await act(async () =>
    controls.setPatch({
      flushLocal: async () => {
        throw Error("无法写入");
      },
    }),
  );
  await act(async () =>
    host
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(host.querySelector("textarea").value, "保存失败不能清空");
  await act(async () => controls.remount());
  assert.equal(host.querySelector("textarea").value, "保存失败不能清空");
});

test("更新提醒接受下载状态，稍后不安装，保存失败保持可重试", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  let notify,
    resolveState,
    installs = 0;
  const bridge = {
    getUpdateState: () =>
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    onUpdateState: (callback) => {
      notify = callback;
      return () => {};
    },
    installUpdate: async () => {
      installs++;
      throw Error("输入草稿尚未保存");
    },
    checkForUpdates: async () => {},
  };
  await act(async () =>
    root.render(React.createElement(DesktopUpdateStatus, { bridge })),
  );
  await act(async () => {
    notify({ status: "downloaded", version: "0.3.0" });
    resolveState({ status: "checking" });
  });
  assert.match(host.textContent, /新版 0.3.0已就绪/);
  await click(button(host, "稍后"));
  assert.equal(installs, 0);
  assert.equal(button(host, "重启更新"), undefined);
  await click(button(host, "有更新"));
  await click(button(host, "重启更新"));
  assert.equal(installs, 1);
  assert.match(host.textContent, /输入草稿尚未保存/);
  assert.equal(button(host, "重启更新").disabled, false);
});

test("更新保存前同步冻结交互，保存失败后立即恢复输入且保留内容", async (t) => {
  let releaseSave;
  const saving = new Promise((_, reject) => {
    releaseSave = reject;
  });
  const { host, calls } = await mount(t, {
    desktop: true,
    overrides: { flushLocal: () => saving },
  });
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "更新过程中必须保留");
  assert.equal(host.querySelector(".desktop-update-status"), null);
  const main = host.querySelector("main");
  await act(async () => {
    for (const handler of calls.updateHandlers)
      handler({
        status: "installing",
        currentVersion: "0.3.0",
        version: "0.4.0",
      });
    // This assertion runs before React commits the update-state render.
    assert.equal(main.inert, true);
    assert.equal(main.hasAttribute("inert"), true);
    const prepared = [...calls.handlers][0]();
    releaseSave(Error("保存失败，稍后重试"));
    await assert.rejects(prepared, /保存失败/);
  });
  assert.match(
    host.querySelector(".desktop-update-status").textContent,
    /正在保存并重启更新/,
  );
  await act(async () => {
    for (const handler of calls.updateHandlers)
      handler({
        status: "downloaded",
        version: "0.4.0",
        error: "保存失败，稍后重试",
      });
    assert.equal(main.inert, false);
    assert.equal(main.hasAttribute("inert"), false);
  });
  assert.equal(host.querySelector("textarea").value, "更新过程中必须保留");
  await type(host.querySelector("textarea"), "失败后继续编辑");
  assert.equal(host.querySelector("textarea").value, "失败后继续编辑");
});

test("收起的顶部和侧签显示首条未完成待办，完成后自动前移", async (t) => {
  const { host, bridge, calls } = await mount(t, { desktop: true, count: 2 });
  assert.equal(
    host.querySelector(".island-summary").textContent,
    "桌面真实待办",
  );
  await click(button(host, "展开轻岛"));
  await click(host.querySelector('.island-task-row input[type="checkbox"]'));
  await click(button(host, "收起轻岛"));
  assert.equal(host.querySelector(".island-summary").textContent, "桌面待办 2");
  await act(async () => {
    calls.placement = { ...calls.placement, dock: "left" };
    for (const handler of calls.placementHandlers) handler(calls.placement);
  });
  assert.equal(
    host.querySelector(".island-side-word").textContent,
    "桌面待办 2",
  );
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
  assert.equal(
    host.querySelector('.island-task-row input[type="checkbox"]').disabled,
    true,
  );
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

test("双岛两版独立调色，横向左右与重挂载保留设置，不改待办或输入草稿", async (t) => {
  localStorage.removeItem(islandAppearanceKey);
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    count: 2,
  });
  const initial = controls.state();
  const island = () => host.querySelector(".dynamic-island");
  const saved = () => JSON.parse(localStorage.getItem(islandAppearanceKey));
  assert.equal(island().dataset.material, "clear-glass");
  assert.equal(
    localStorage.getItem(islandAppearanceKey),
    null,
    "mount never saves",
  );
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "改外观时保留的输入");
  await [...calls.handlers][0]();
  const otherEntries = () =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key !== islandAppearanceKey)
        .map((key) => [key, localStorage.getItem(key)]),
    );
  const before = otherEntries();
  await click(host.querySelector(".island-options-trigger"));
  await appearanceInput(host, "轻岛配色组合", "spring");
  await appearanceInput(host, "色块 1颜色", "#46acbf");
  await appearanceInput(host, "小舱色值", "#badcaa");
  await appearanceInput(host, "流动周期", "6");
  await appearanceInput(host, "玻璃强度", "75");
  await click(button(host, "添加色块"));
  assert.equal(saved().profiles.glass.colors.length, 4);
  await appearanceInput(host, "色块 4色值", "#bbccdd");
  const glass = saved().profiles.glass;
  assert.equal(glass.colors[0], "#46acbf");
  assert.equal(glass.colors[3], "#bbccdd");
  assert.equal(glass.smallColor, "#badcaa");
  assert.equal(glass.cycle, 6);
  assert.equal(glass.glassStrength, 0.75);
  await click(button(host, "色块流动"));
  assert.equal(island().dataset.material, "color-flow");
  assert.equal(host.querySelectorAll(".island-color-sheen").length, 0);
  assert.deepEqual(
    saved().profiles.flow,
    defaultIslandAppearance.profiles.flow,
  );
  await appearanceInput(host, "轻岛配色组合", "sage");
  await click(button(host, "删除色块 2"));
  await click(host.querySelector('[aria-label="启用色块流动"]'));
  const flow = saved().profiles.flow;
  assert.deepEqual(flow.colors, ["#e3e9dc", "#9caa91"]);
  assert.equal(flow.motion, false);
  await click(button(host, "清透玻璃"));
  assert.deepEqual(saved().profiles.glass, glass);
  assert.equal(host.querySelectorAll(".island-color-sheen").length, 2);
  for (const dock of ["left", "right", "top"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    assert.equal(
      island().style.getPropertyValue("--island-small-color"),
      "#badcaa",
    );
    assert.equal(
      island().style.getPropertyValue("--island-glass-strength"),
      "0.75",
    );
    assert.match(
      island().style.getPropertyValue("--island-field-fill"),
      /#46acbf/,
    );
  }
  await act(async () => controls.remount());
  assert.equal(
    host.querySelector('[aria-label="色块 1颜色"]').value,
    "#46acbf",
  );
  assert.equal(host.querySelector('[aria-label="流动周期"]').value, "6");
  assert.equal(host.querySelector("textarea").value, "改外观时保留的输入");
  assert.equal(
    controls.state(),
    initial,
    "appearance never updates shared workspace",
  );
  assert.deepEqual(otherEntries(), before);
  await click(button(host, "恢复当前外观"));
  assert.deepEqual(
    saved().profiles.glass,
    defaultIslandAppearance.profiles.glass,
  );
  assert.deepEqual(
    saved().profiles.flow,
    flow,
    "reset preserves the other version",
  );
  assert.deepEqual(otherEntries(), before);
  assert.equal(controls.state(), initial);
});

test("双岛调色输入保留面板，普通失焦仍收起；保存失败可预览并重试", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  localStorage.removeItem(islandAppearanceKey);
  const original = window.Storage.prototype.setItem;
  t.after(() => {
    window.Storage.prototype.setItem = original;
    localStorage.removeItem(islandAppearanceKey);
  });
  const { host, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
  });
  const initial = controls.state();
  await click(button(host, "展开轻岛"));
  await click(host.querySelector(".island-options-trigger"));
  const range = host.querySelector('[aria-label="流动周期"]');
  await act(async () => range.focus());
  await hoverIsland(range, false);
  await act(async () => t.mock.timers.tick(400));
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  const color = host.querySelector('[aria-label="色块 1颜色"]');
  await act(async () => {
    color.focus();
    window.dispatchEvent(new Event("blur"));
  });
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
  await act(async () => {
    color.blur();
    window.dispatchEvent(new Event("blur"));
  });
  assert.equal(host.querySelector(".dynamic-island").dataset.open, "false");
  await click(button(host, "展开轻岛"));
  window.Storage.prototype.setItem = function (key, value) {
    if (key === islandAppearanceKey) throw Error("存储已满");
    return original.call(this, key, value);
  };
  await appearanceInput(host, "色块 1颜色", "#aabbcc");
  assert.equal(
    host.querySelector('[aria-label="色块 1颜色"]').value,
    "#aabbcc",
  );
  assert.match(
    host.querySelector(".island-appearance-error").textContent,
    /已预览.*暂未保存/,
  );
  assert.equal(localStorage.getItem(islandAppearanceKey), null);
  assert.equal(controls.state(), initial);
  window.Storage.prototype.setItem = original;
  await appearanceInput(host, "流动周期", "5");
  assert.equal(host.querySelector(".island-appearance-error"), null);
  assert.equal(
    JSON.parse(localStorage.getItem(islandAppearanceKey)).profiles.glass
      .colors[0],
    "#aabbcc",
  );
  assert.equal(
    JSON.parse(localStorage.getItem(islandAppearanceKey)).profiles.glass.cycle,
    5,
  );
  assert.equal(controls.state(), initial);
});

test("像素庭院的尺寸拖动只在放手时保存，取消、换肤和重启保留正确的尺寸", async (t) => {
  localStorage.removeItem(islandAppearanceKey);
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    supportsFixedTwinFrame: true,
    supportsIslandResize: true,
  });
  const island = () => host.querySelector(".dynamic-island"),
    grip = () => host.querySelector(".island-resize-handle");
  const stored = () => JSON.parse(localStorage.getItem(islandAppearanceKey));
  await click(grip());
  await click(button(host, "四季像素庭院"));
  assert.ok(host.querySelector(".island-twin-main .island-pixel-surface"));
  assert.equal(
    host.querySelector(".island-twin-time .island-pixel-surface"),
    null,
  );
  await appearanceInput(host, "像素庭院滚动速度", "38");
  await pointer(grip(), "pointerdown", 270, 41);
  await pointer(grip(), "pointermove", 412, 86);
  assert.equal(island().dataset.extraWidth, "142");
  assert.equal(island().dataset.extraHeight, "45");
  assert.equal(stored().size.extraWidth, 0);
  await pointer(grip(), "pointercancel", 412, 86);
  assert.equal(island().dataset.extraWidth, "0");
  await pointer(grip(), "pointerdown", 270, 41);
  await pointer(grip(), "pointermove", 412, 86);
  await pointer(grip(), "pointerup", 412, 86);
  assert.deepEqual(stored().size, { extraWidth: 142, extraHeight: 45 });
  assert.equal(stored().design, "pixel");
  assert.equal(stored().profiles.pixel.scrollSpeed, 38);
  assert.deepEqual(calls.drag, []);
  await click(button(host, "清透玻璃"));
  await act(async () => controls.remount());
  assert.equal(island().dataset.extraWidth, "142");
  await click(grip());
  await appearanceInput(host, "大舱高度", "120");
  assert.equal(stored().size.extraHeight, 72);
  await click(button(host, "恢复默认尺寸"));
  assert.deepEqual(stored().size, { extraWidth: 0, extraHeight: 0 });
  assert.equal(stored().profiles.pixel.scrollSpeed, 38);
});

test("四季草地在横向与左右侧保留设置，展开待办仍保留草地且不改草稿", async (t) => {
  localStorage.removeItem(islandAppearanceKey);
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    count: 2,
  });
  const initial = controls.state();
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "四季设置中的草稿");
  await click(host.querySelector(".island-options-trigger"));
  await click(button(host, "四季草地"));
  assert.equal(
    host.querySelector(".dynamic-island").dataset.material,
    "seasonal-meadow",
  );
  assert.equal(host.querySelectorAll(".island-meadow-surface").length, 1);
  await appearanceInput(host, "草地滚动速度", "48");
  await click(host.querySelector('[aria-label="启用四季动画"]'));
  for (const dock of ["left", "right", "top"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    const surface = host.querySelector(".island-meadow-surface");
    assert.equal(surface.dataset.side, String(dock !== "top"));
    assert.equal(surface.dataset.reverse, String(dock === "left"));
    assert.equal(host.querySelector(".island-twin-header").hidden, false);
  }
  await act(async () => controls.remount());
  const saved = JSON.parse(localStorage.getItem(islandAppearanceKey));
  assert.equal(saved.design, "meadow");
  assert.equal(saved.profiles.meadow.scrollSpeed, 48);
  assert.equal(saved.profiles.meadow.motion, false);
  assert.equal(host.querySelector("textarea").value, "四季设置中的草稿");
  assert.equal(controls.state(), initial);
  await click(button(host, "清透玻璃"));
  assert.deepEqual(
    JSON.parse(localStorage.getItem(islandAppearanceKey)).profiles.glass,
    defaultIslandAppearance.profiles.glass,
  );
});

test("旧桌面布局与普通页面不读取或写入双岛外观设置", async (t) => {
  localStorage.setItem(islandAppearanceKey, "{unreadable");
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host } = await mount(t, { desktop: true, supportsTwinIsland: false });
  assert.equal(
    host.querySelector(".dynamic-island").dataset.material,
    undefined,
  );
  assert.equal(host.querySelector(".island-appearance-settings"), null);
  assert.equal(localStorage.getItem(islandAppearanceKey), "{unreadable");
});

test("双舱下方的设置弹窗保留草稿，历史版本只预览，检查更新走桌面接口", async (t) => {
  const { host, controls, calls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    count: 2,
  });
  const initial = controls.state();
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "还没有提交的待办");
  const appearanceBefore = localStorage.getItem(islandAppearanceKey);
  for (const dock of ["top", "left", "right"]) {
    await act(async () => {
      calls.placement = { ...calls.placement, dock };
      for (const handler of calls.placementHandlers) handler(calls.placement);
    });
    await click(button(host, "轻岛设置"));
    const dialog = host.querySelector('[role="dialog"][aria-label="轻岛设置"]');
    assert.ok(dialog);
    assert.equal(host.querySelector(".island-twin-header").hidden, false);
    assert.equal(host.querySelector(".island-tasks-view").hidden, true);
    assert.equal(document.activeElement, button(host, "返回待办列表"));
    const menu = dialog.querySelector(".island-release-menu");
    await click(menu.querySelector("summary"));
    const options = [...menu.querySelectorAll("button")];
    assert.equal(options.length, 6);
    for (const option of options) {
      assert.match(
        option.querySelector("img").getAttribute("src"),
        /^\/island-releases\/v0\.3\.[1-6]\.jpg$/,
      );
    }
    await click(button(host, "预览轻岛 v0.3.1"));
    assert.equal(menu.open, false);
    assert.equal(
      dialog.querySelector(".island-release-preview img").getAttribute("alt"),
      "轻岛 v0.3.1 外观预览",
    );
    assert.equal(localStorage.getItem(islandAppearanceKey), appearanceBefore);
    assert.equal(controls.state(), initial);
    await click(button(host, "检查更新"));
    assert.match(dialog.textContent, /当前已是最新版本/);
    await act(async () =>
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(host.querySelector(".dynamic-island").dataset.open, "true");
    assert.equal(host.querySelector(".island-tasks-view").hidden, false);
    assert.equal(document.activeElement, button(host, "轻岛设置"));
    assert.equal(host.querySelector("textarea").value, "还没有提交的待办");
  }
  assert.equal(calls.checks, 3);
  assert.equal(controls.state(), initial);
});

test("手动检查更新防重复，错误可重试，旧读取结果不能覆盖下载事件", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let notify,
    initial,
    finish,
    checks = 0,
    unsubscribed = 0;
  const bridge = {
    getUpdateState: () =>
      new Promise((resolve) => {
        initial = resolve;
      }),
    onUpdateState: (callback) => {
      notify = callback;
      return () => {
        unsubscribed++;
      };
    },
    checkForUpdates: () => {
      checks++;
      return new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
    },
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(React.createElement(DesktopUpdateCheck, { bridge })),
  );
  assert.doesNotMatch(host.textContent, /已是最新版本/);
  await click(button(host, "检查更新"));
  assert.equal(button(host, "检查中…").disabled, true);
  await click(button(host, "检查中…"));
  assert.equal(checks, 1);
  await act(async () => finish.reject(Error("网络暂不可用")));
  assert.match(
    host.querySelector('[role="alert"]').textContent,
    /网络暂不可用/,
  );
  assert.doesNotMatch(host.textContent, /已是最新版本/);
  await click(button(host, "检查更新"));
  await act(async () => {
    notify({ status: "downloaded", version: "0.4.0", currentVersion: "0.3.6" });
    initial({ status: "idle", currentVersion: "0.3.5" });
    finish.resolve({ status: "checking" });
  });
  assert.match(host.textContent, /新版 0\.4\.0 已就绪/);
  assert.match(host.textContent, /v0\.3\.6/);
  assert.equal(button(host, "重启更新").disabled, true);
  await act(async () =>
    root.render(React.createElement(DesktopUpdateCheck, { bridge: {} })),
  );
  assert.equal(unsubscribed, 1);
  assert.equal(button(host, "检查更新").disabled, true);
  assert.match(host.textContent, /暂不支持自动更新/);
});

test("色块渲染在隐藏、离屏、减少动态效果与卸载时停止，恢复时继续", async (t) => {
  const frames = new Map(),
    mediaListeners = new Set();
  let sequence = 0,
    draws = 0,
    visibility = false,
    intersect;
  const media = {
    matches: false,
    addEventListener: (_, callback) => mediaListeners.add(callback),
    removeEventListener: (_, callback) => mediaListeners.delete(callback),
  };
  const originalCanvas = window.CanvasRenderingContext2D;
  const originalIntersection = globalThis.IntersectionObserver;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  window.CanvasRenderingContext2D = function () {};
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => visibility,
  });
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      intersect = callback;
    }
    observe() {}
    disconnect() {}
  };
  t.mock.method(window, "matchMedia", () => media);
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", (id) => frames.delete(id));
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
    drawImage() {
      draws++;
    },
  }));
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: 291 },
    clientHeight: { value: 48 },
  });
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  t.after(async () => {
    if (mounted) await act(async () => root.unmount());
    host.remove();
    window.CanvasRenderingContext2D = originalCanvas;
    if (originalIntersection === undefined)
      delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersection;
    if (hiddenDescriptor)
      Object.defineProperty(document, "hidden", hiddenDescriptor);
    else delete document.hidden;
  });
  const render = (patch = {}) =>
    act(async () =>
      root.render(
        React.createElement(IslandColorSurface, {
          design: "glass",
          profile: { ...defaultIslandAppearance.profiles.glass, ...patch },
          playing: true,
        }),
      ),
    );
  await render();
  assert.equal(host.querySelector("canvas").dataset.ready, "true");
  assert.equal(frames.size, 1);
  const tick = async (now) =>
    act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(now));
    });
  const initial = draws;
  await tick(0);
  await tick(40);
  assert.ok(draws > initial);
  visibility = true;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(frames.size, 0);
  visibility = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(frames.size, 1);
  await act(async () => intersect([{ isIntersecting: false }]));
  assert.equal(frames.size, 0);
  await act(async () => intersect([{ isIntersecting: true }]));
  assert.equal(frames.size, 1);
  media.matches = true;
  await act(async () => mediaListeners.forEach((callback) => callback()));
  assert.equal(frames.size, 0);
  media.matches = false;
  await act(async () => mediaListeners.forEach((callback) => callback()));
  assert.equal(frames.size, 1);
  await render({ motion: false });
  assert.equal(frames.size, 0);
  await render();
  assert.equal(frames.size, 1);
  await act(async () => root.unmount());
  mounted = false;
  assert.equal(frames.size, 0);
  assert.equal(mediaListeners.size, 0);
});

test("设置内检查、下载、重启更新走原生控制器，保存失败可重试且不改调色", async (t) => {
  localStorage.removeItem(islandAppearanceKey);
  t.after(() => localStorage.removeItem(islandAppearanceKey));
  const { host, bridge, calls, controls } = await mount(t, {
    desktop: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
  });
  let checks = 0,
    installs = 0,
    failSave = true,
    finishSave;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.3.7" });
    updater.emit("download-progress", { percent: 38 });
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const controller = createUpdateController({
    updater,
    version: "0.3.6",
    changed: (value) => {
      for (const callback of calls.updateHandlers) callback(value);
    },
    prepare: async () => {
      if (failSave) throw Error("本机保存暂时失败");
      await new Promise((resolve) => {
        finishSave = resolve;
      });
      return { ok: true, ...(await [...calls.handlers][0]()) };
    },
    install: async (run) => run(),
  });
  bridge.checkForUpdates = () => controller.check();
  bridge.installUpdate = () => controller.install();
  await click(button(host, "展开轻岛"));
  await type(host.querySelector("textarea"), "安装前必须保留的草稿");
  const stateBefore = controls.state();
  await click(button(host, "轻岛设置"));
  await appearanceInput(host, "轻岛配色组合", "sage");
  const appearanceBefore = localStorage.getItem(islandAppearanceKey);
  const section = host.querySelector('[aria-label="轻岛版本更新"]');
  await click(button(section, "检查更新"));
  assert.equal(checks, 1);
  assert.match(section.textContent, /正在下载 38%/);
  assert.equal(button(section, "检查更新").disabled, true);
  assert.equal(installs, 0);
  await act(async () =>
    updater.emit("update-downloaded", { version: "0.3.7" }),
  );
  assert.equal(button(section, "重启更新").disabled, false);
  assert.equal(installs, 0, "download completion never restarts by itself");
  await click(button(section, "重启更新"));
  assert.equal(installs, 0);
  assert.match(
    section.querySelector('[role="alert"]').textContent,
    /本机保存暂时失败/,
  );
  assert.equal(button(section, "重启更新").disabled, false);
  assert.equal(host.querySelector("textarea").value, "安装前必须保留的草稿");
  failSave = false;
  await click(button(section, "重启更新"));
  assert.equal(button(section, "正在保存…").disabled, true);
  await click(button(section, "正在保存…"));
  assert.equal(installs, 0);
  await act(async () => finishSave());
  assert.equal(installs, 1);
  assert.ok(controls.flushed > 0);
  assert.equal(localStorage.getItem(islandAppearanceKey), appearanceBefore);
  assert.equal(controls.state(), stateBefore);
  assert.equal(host.querySelector("textarea").value, "安装前必须保留的草稿");
});
