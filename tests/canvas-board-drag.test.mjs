import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as model from "../src/canvas/model.js";
import * as layout from "../src/canvas/layout.js";
import * as geometry from "../src/canvas/geometry.js";
import * as boards from "../src/canvas/inspirationBoards.js";
import { collectionTouches } from "../src/canvas/collectionWrap.js";

// Exercise the actual pointer handlers, including pointerup's last move and
// placement, so a correct geometry helper cannot hide a clamp in the UI.
const source = await readFile(
  new URL("../src/canvas/Canvas.jsx", import.meta.url),
  "utf8",
);
const handlers = [
  source.slice(
    source.indexOf("  const move = "),
    source.indexOf("  moveRef.current = move;"),
  ),
  source.slice(
    source.indexOf("  const up = "),
    source.indexOf("  const startResize = "),
  ),
].join("\n");

function drag(
  t,
  { noteKind = "text", selected = ["note"], scale = 1, extra = [] } = {},
) {
  const state = model.createWorkspace();
  const boardId = state.boards[0].id;
  const home = {
    ...model.createInspirationBoard(boardId, {
      x: 200,
      y: 200,
      width: 700,
      height: 500,
    }),
    id: "home",
  };
  const note = {
    ...model.createObject(boardId, "note", { x: 260, y: 300 }),
    id: "note",
    parentId: home.id,
    noteKind,
    width: 200,
    height: 180,
    layoutHeight: 180,
  };
  const neighbor = {
    ...model.createInspirationBoard(boardId, {
      x: 950,
      y: 200,
      width: 500,
      height: 500,
    }),
    id: "neighbor",
  };
  state.objects = [
    home,
    note,
    neighbor,
    ...extra.map((o) => ({ ...o, boardId })),
  ];
  const view = { ...geometry.defaultView(), scale };
  const workspace = { current: { current: state } };
  const gesture = {
    current: {
      kind: "move",
      started: true,
      start: { x: 300, y: 350 },
      view,
      ids: selected,
      anchorId: selected[0],
      snapshot: state,
      pointerId: 1,
    },
  };
  const timers = { alignmentTimer: {}, groupTimer: {}, longPress: {} };
  t.after(() =>
    Object.values(timers).forEach((ref) => clearTimeout(ref.current)),
  );
  const env = {
    ...model,
    ...layout,
    ...geometry,
    ...boards,
    ...timers,
    collectionTouches,
    state,
    boardId,
    view,
    workspace,
    gesture,
    arranged: false,
    blocked: false,
    dockedCollection: null,
    dockedCollectionId: null,
    actual: layout.displayRect,
    local: (event) => ({ x: event.clientX, y: event.clientY }),
    isShown: (object, all) => !layout.hiddenByAncestor(all, object.id),
    collectionRect: (object) => object,
    pointer: {},
    points: { current: new Map() },
    suppressClick: {},
    moveRef: {},
    live: { current: { blocked: false } },
    viewport: { current: { hasPointerCapture: () => false } },
    window: {},
    GROUP_DWELL_MS: 2000,
    BOARD_DWELL_MS: 1000,
    update: (action) => {
      workspace.current.current =
        typeof action === "function"
          ? action(workspace.current.current)
          : action;
    },
    end: () => {},
    onToast: () => {},
  };
  for (const key of [
    "Dragging",
    "Lifted",
    "Guides",
    "DragAnchor",
    "DropTarget",
    "GroupHover",
    "Placement",
    "Marquee",
    "BoardDraft",
    "Selection",
  ])
    env[`set${key}`] = () => {};
  const { move, up } = new Function(
    ...Object.keys(env),
    `${handlers}\nreturn { move, up };`,
  )(...Object.values(env));
  env.moveRef.current = move;
  const event = (x, y, modifiers) => ({
    clientX: 300 + x * scale,
    clientY: 350 + y * scale,
    pointerId: 1,
    ...modifiers,
  });
  return {
    move: (x, y, modifiers = {}) => move(event(x, y, modifiers)),
    up: (x, y, modifiers = {}) => up(event(x, y, modifiers)),
    get: (id = "note") =>
      workspace.current.current.objects.find((o) => o.id === id),
    home,
    neighbor,
  };
}

for (const noteKind of ["text", "checklist"]) {
  for (const { name, delta, during, after } of [
    { name: "left", delta: [-500, 0], during: [-240, 300], after: [150, 300] },
    { name: "right", delta: [1500, 0], during: [1760, 300], after: [788, 300] },
    { name: "top", delta: [0, -600], during: [260, -300], after: [260, 228] },
    { name: "bottom", delta: [0, 900], during: [260, 1200], after: [260, 658] },
  ]) {
    test(`${noteKind} follows the pointer beyond the ${name} edge and returns only on release`, (t) => {
      const ui = drag(t, { noteKind });
      ui.move(...delta);
      assert.deepEqual([ui.get().x, ui.get().y], during);
      assert.equal(ui.get().parentId, "home");
      ui.up(...delta);
      assert.deepEqual([ui.get().x, ui.get().y], after);
      assert.equal(ui.get().parentId, "home");
      assert.deepEqual(ui.get("home"), ui.home);
      assert.deepEqual(ui.get("neighbor"), ui.neighbor);
    });
  }
}

test("board notes cross a neighboring board without collision or edge attraction at any zoom", (t) => {
  for (const scale of [0.5, 1, 2]) {
    const ui = drag(t, { scale });
    for (const x of [747, 753, 1100, 1475]) {
      ui.move(x - 260, 0);
      assert.equal(ui.get().x, x);
    }
    ui.up(1215, 0);
    assert.equal(ui.get().x, 788);
    assert.equal(ui.get().parentId, "home");
  }
});

test("Alt still returns a board note on release and pointerup uses the final position", (t) => {
  const ui = drag(t);
  ui.move(20, 0, { altKey: true });
  ui.up(-800, -800, { altKey: true });
  assert.deepEqual([ui.get().x, ui.get().y], [150, 228]);
  assert.equal(ui.get().parentId, "home");
});

test("a board note passes through a nested frame without a collision stop", (t) => {
  const inner = {
    ...model.createInspirationBoard("", {
      x: 550,
      y: 340,
      width: 280,
      height: 220,
    }),
    id: "inner",
    parentId: "home",
  };
  const ui = drag(t, { extra: [inner] });
  ui.move(400, 0);
  assert.deepEqual([ui.get().x, ui.get().y], [660, 300]);
  assert.equal(ui.get().parentId, "home");
});

test("dragging an inspiration board still stops at its neighbor with its members attached", (t) => {
  const ui = drag(t, { selected: ["home"] });
  ui.move(1500, 0);
  ui.up(1500, 0);
  assert.equal(ui.get("home").x, 226);
  assert.equal(ui.get().x, 286);
  assert.equal(ui.get().parentId, "home");
  assert.deepEqual(ui.get("neighbor"), ui.neighbor);
});
