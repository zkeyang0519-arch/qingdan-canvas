import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as model from "../src/canvas/model.js";
import * as layout from "../src/canvas/layout.js";
import * as geometry from "../src/canvas/geometry.js";
import * as boards from "../src/canvas/inspirationBoards.js";
import { cardTilt } from "../src/canvas/freeform.js";
import { todoPages } from "../src/canvas/todoPages.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";

// Invoke the real canvas handlers, as in canvas-board-drag.test.mjs. Assertions
// cover the resulting state and project membership, not source text or CSS.
const source = await readFile(
  new URL("../src/canvas/Canvas.jsx", import.meta.url),
  "utf8",
);
const section = (from, to) =>
  source.slice(source.indexOf(from), source.indexOf(to));
const handlers = [
  section("  const addNote = ", "  const pasteText = "),
  section("  const down = ", "  const lastTouch = "),
  section("  const move = ", "  moveRef.current = move;"),
  section("  const up = ", "  const startResize = "),
].join("\n");

function fixture(t, { scale = 1, blocked = false, home = false } = {}) {
  const state = model.createWorkspace();
  const boardId = state.boards[0].id;
  const a = {
    ...model.createObject(boardId, "note", { x: 100, y: 100 }),
    id: "a",
    width: 200,
    height: 160,
  };
  const b = {
    ...model.createObject(boardId, "note", { x: 360, y: 100 }),
    id: "b",
    noteKind: "checklist",
    width: 200,
    height: 160,
    blocks: [
      { ...model.makeBlock("准备活动清单"), dueAt: "2026-12-01T10:00:00.000Z" },
    ],
  };
  state.objects = home
    ? [
        model.createInspirationBoard(
          boardId,
          { x: 0, y: 0, width: 1000, height: 700 },
          "已有项目",
        ),
      ]
    : [a, b];
  const workspace = { current: { current: state } };
  const view = { ...geometry.defaultView(), x: 0, y: 0, scale };
  const timers = { alignmentTimer: {}, groupTimer: {}, longPress: {} };
  t.after(() =>
    Object.values(timers).forEach((ref) => clearTimeout(ref.current)),
  );
  let selected = [],
    context = null,
    nextView = view;
  const env = {
    ...model,
    ...layout,
    ...geometry,
    ...boards,
    ...timers,
    state,
    boardId,
    workspace,
    view,
    blocked,
    arranged: false,
    live: { current: { state, boardId, view, blocked } },
    selection: [],
    objects: new Map(state.objects.map((o) => [o.id, o])),
    gesture: { current: null },
    space: { current: false },
    pointer: {},
    points: { current: new Map() },
    lastTouch: {},
    suppressClick: {},
    moveRef: {},
    contextMenuUntil: {},
    viewport: {
      current: { setPointerCapture() {}, hasPointerCapture: () => false },
    },
    dockedCollectionId: null,
    dockedCollection: null,
    actual: layout.displayRect,
    isShown: (o, all) => !layout.hiddenByAncestor(all, o.id),
    local: (e) => ({ x: e.clientX, y: e.clientY }),
    contentPoint: (p) => geometry.screenToWorld(p, view),
    center: () => ({ x: 650, y: 450 }),
    arrangement: { queueBirth() {} },
    onExit() {},
    onEdit() {},
    exitImageEdit() {},
    begin() {},
    end() {},
    onToast() {},
    onContext: (value) => {
      context = value;
    },
    onView: (value) => {
      nextView = value;
    },
    update: (action) => {
      const next =
        typeof action === "function"
          ? action(workspace.current.current)
          : action;
      workspace.current.current = next;
      env.live.current.state = next;
    },
    setSelection: (ids) => {
      selected = ids;
    },
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
  ])
    env[`set${key}`] = () => {};
  const methods = new Function(
    ...Object.keys(env),
    `${handlers}\nreturn {down,move,up,addNote};`,
  )(...Object.values(env));
  env.moveRef.current = methods.move;
  const event = (x, y, extra = {}) => ({
    clientX: x * scale,
    clientY: y * scale,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    target: { closest: () => null },
    preventDefault() {},
    ...extra,
  });
  return {
    ...methods,
    env,
    event,
    state: () => workspace.current.current,
    selected: () => selected,
    context: () => context,
    view: () => nextView,
    boardId,
    a,
    b,
  };
}

for (const scale of [0.5, 1, 2]) {
  test(`default blank drag pans without grouping or changing cards at zoom ${scale}`, (t) => {
    const ui = fixture(t, { scale });
    const before = structuredClone(ui.state());
    ui.down(ui.event(70, 70));
    ui.move(ui.event(590, 290));
    ui.up(ui.event(590, 290));
    assert.deepEqual(ui.selected(), []);
    assert.deepEqual([ui.view().x, ui.view().y], [520 * scale, 220 * scale]);
    assert.deepEqual(ui.state(), before);
    assert.equal(ui.context(), null);
  });

  test(`Ctrl drag creates an empty inspiration board without regrouping existing cards at zoom ${scale}`, (t) => {
    const ui = fixture(t, { scale });
    const before = structuredClone(ui.state().objects);
    ui.down(ui.event(70, 70, { ctrlKey: true }));
    ui.move(ui.event(710, 550, { ctrlKey: true }));
    ui.up(ui.event(710, 550, { ctrlKey: true }));
    const frame = ui.state().objects.at(-1);
    assert.ok(boards.isInspirationBoard(frame));
    assert.deepEqual(
      [frame.x, frame.y, frame.width, frame.height],
      [70, 70, 640, 480],
    );
    assert.deepEqual(ui.state().objects.slice(0, -1), before);
    assert.deepEqual(ui.selected(), [frame.id]);
  });
}

test("point creation inside a board joins it, explicit board creation works, and outside cards stay free", (t) => {
  const ui = fixture(t, { home: true });
  const frame = ui.state().objects[0];
  ui.addNote("text", { x: 70, y: 80 });
  const member = ui.state().objects.at(-1);
  assert.equal(member.parentId, frame.id);
  assert.equal(
    prepareEdit(ui.state()).find((o) => o.id === member.id).parentId,
    frame.id,
  );
  assert.deepEqual(
    todoPages(ui.state(), ui.boardId).map((page) => page.id),
    [frame.id],
  );
  ui.addNote("checklist", { x: 340, y: 80 }, frame.id);
  assert.equal(ui.state().objects.at(-1).parentId, frame.id);
  ui.addNote("text", { x: 1200, y: 80 });
  const loose = ui.state().objects.at(-1);
  assert.equal(loose.parentId, null);
  assert.deepEqual([loose.x, loose.y], [1200, 80]);
  assert.ok(
    todoPages(ui.state(), ui.boardId).some((page) => page.id === "ungrouped"),
  );
  assert.deepEqual(ui.state().objects[0], frame);
});

test("blank drag, Space and middle button pan without changing content", (t) => {
  for (const mode of ["blank", "space", "middle"]) {
    const ui = fixture(t);
    const before = structuredClone(ui.state());
    ui.env.space.current = mode === "space";
    const extra = { button: mode === "middle" ? 1 : 0 };
    ui.down(ui.event(40, 40, extra));
    ui.move(ui.event(100, 90, extra));
    ui.up(ui.event(100, 90, extra));
    assert.deepEqual([ui.view().x, ui.view().y], [60, 50]);
    assert.deepEqual(ui.state(), before);
  }
});

test("board creation uses the latest remote lock and does not modify a locked board", (t) => {
  const ui = fixture(t, { home: true });
  const frame = ui.state().objects[0];
  ui.env.update((s) => model.patchObjects(s, { [frame.id]: { locked: true } }));
  const before = structuredClone(ui.state());
  ui.addNote("text", { x: 70, y: 80 });
  ui.addNote("checklist", { x: 340, y: 80 }, frame.id);
  assert.deepEqual(ui.state(), before);
});

test("read-only canvas does not create cards or inspiration boards", (t) => {
  const ui = fixture(t, { blocked: true });
  const before = structuredClone(ui.state());
  ui.addNote();
  ui.down(ui.event(70, 70, { ctrlKey: true }));
  ui.move(ui.event(710, 550, { ctrlKey: true }));
  ui.up(ui.event(710, 550, { ctrlKey: true }));
  assert.deepEqual(ui.state(), before);
});

test("right click and Shift quick grouping remain available", (t) => {
  const ui = fixture(t);
  ui.down(ui.event(40, 40, { button: 2 }));
  ui.up(ui.event(40, 40, { button: 2 }));
  assert.ok(ui.context());
  ui.down(ui.event(70, 70, { shiftKey: true }));
  ui.move(ui.event(590, 290, { shiftKey: true }));
  ui.up(ui.event(590, 290, { shiftKey: true }));
  assert.equal(ui.state().objects.filter((o) => o.type === "frame").length, 1);
});

test("decorative tilt is stable, small, and leaves checklist and shared geometry intact", () => {
  const note = model.createObject("board", "note");
  const before = structuredClone(note);
  assert.ok(Math.abs(cardTilt(note)) > 0 && Math.abs(cardTilt(note)) <= 2);
  assert.equal(cardTilt(note), cardTilt(structuredClone(note)));
  assert.equal(cardTilt({ ...note, noteKind: "checklist" }), 0);
  assert.equal(cardTilt({ ...note, type: "frame" }), 0);
  assert.deepEqual(note, before);
});
