import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as model from "../src/canvas/model.js";
import { placeBoardObjects } from "../src/canvas/layout.js";
import {
  isInspirationBoard,
  boardsOverlap,
} from "../src/canvas/inspirationBoards.js";
import { defaultView, screenToWorld } from "../src/canvas/geometry.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";

// Exercise the toolbar's actual creation handler so routing back to an ordinary
// group is caught even if the separate board factory still works correctly.
const source = await readFile(
  new URL("../src/CanvasWorkspace.jsx", import.meta.url),
  "utf8",
);
const logic = source.slice(
  source.indexOf("  const add = "),
  source.indexOf("  const fit = "),
);
function toolbar() {
  const state = model.createWorkspace();
  const workspace = { current: { current: state } };
  const view = defaultView();
  const room = { id: state.boards[0].id };
  const run = new Function(
    "room",
    "canvas",
    "workspace",
    "update",
    "setSelection",
    "exitEdit",
    "createObject",
    "createInspirationBoard",
    "placeBoardObjects",
    "screenToWorld",
    "view",
    "onView",
    "readOnly",
    `${logic}\nreturn add;`,
  );
  const add = run(
    room,
    {
      current: {
        getPoint: () => ({ x: 100, y: 80 }),
        getSize: () => ({ width: 1200, height: 800 }),
      },
    },
    workspace,
    (action) => {
      workspace.current.current = action(workspace.current.current);
    },
    () => {},
    () => {},
    model.createObject,
    model.createInspirationBoard,
    placeBoardObjects,
    screenToWorld,
    view,
    (next) => Object.assign(view, next),
    false,
  );
  return { add, workspace, view };
}

test("左侧新建灵感板使用可缩放的板类型，尺寸修改通过共享数据校验后仍保留", () => {
  const ui = toolbar();
  ui.add("frame");
  const state = ui.workspace.current.current;
  const frame = state.objects.at(-1);
  assert.equal(isInspirationBoard(frame), true);
  const resized = model.patchObjects(state, {
    [frame.id]: { width: 850, height: 560 },
  });
  const shared = prepareEdit(resized).find((o) => o.id === frame.id);
  assert.equal(shared.width, 850);
  assert.equal(shared.height, 560);
});

test("连续点击左侧新建灵感板会避开已有板，且新板的缩放手柄处于视口内", () => {
  const ui = toolbar();
  ui.add("frame");
  ui.add("frame");
  const [first, second] = ui.workspace.current.current.objects;
  assert.equal(boardsOverlap(first, second), false);
  const right = (second.x + second.width) * ui.view.scale + ui.view.x;
  const bottom = (second.y + second.height) * ui.view.scale + ui.view.y;
  assert.ok(right < 1200 && bottom < 800, "新板右下角需要能直接拖动");
});
