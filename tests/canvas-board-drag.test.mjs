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
  {
    noteKind = "text",
    selected = ["note"],
    scale = 1,
    extra = [],
    noteProps = {},
    neighborProps = {},
  } = {},
) {
  let now = 1000;
  class DragDate extends Date {
    static now() {
      return now;
    }
  }
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
    ...noteProps,
  };
  const neighbor = {
    ...model.createInspirationBoard(boardId, {
      x: 950,
      y: 200,
      width: 500,
      height: 500,
    }),
    id: "neighbor",
    ...neighborProps,
  };
  state.objects = [
    home,
    note,
    neighbor,
    ...extra.map((o) => ({ ...o, boardId })),
  ];
  const view = { ...geometry.defaultView(), scale };
  const start = { x: (note.x + 40) * scale, y: (note.y + 50) * scale };
  const workspace = { current: { current: state } };
  const gesture = {
    current: {
      kind: "move",
      started: true,
      start,
      view,
      ids: selected,
      anchorId: selected[0],
      snapshot: state,
      pointerId: 1,
      alignmentMotion: {
        ...start,
        at: now,
        slowSince: null,
        enabled: false,
      },
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
    Date: DragDate,
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
    BOARD_EXIT_DWELL_MS: 1000,
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
  let hover = null;
  env.setGroupHover = (next) => {
    hover = typeof next === "function" ? next(hover) : next;
  };
  const { move, up } = new Function(
    ...Object.keys(env),
    `${handlers}\nreturn { move, up };`,
  )(...Object.values(env));
  env.moveRef.current = move;
  const event = (x, y, modifiers) => ({
    clientX: start.x + x * scale,
    clientY: start.y + y * scale,
    pointerId: 1,
    ...modifiers,
  });
  return {
    move: (x, y, modifiers = {}) => {
      now += modifiers.elapsedMs ?? 16;
      move(event(x, y, modifiers));
    },
    up: (x, y, modifiers = {}) => {
      now += modifiers.elapsedMs ?? 16;
      up(event(x, y, modifiers));
    },
    replay: (elapsedMs) => {
      now += elapsedMs;
      move(gesture.current.lastPointer);
    },
    tick: (elapsedMs) => {
      now += elapsedMs;
      t.mock.timers.tick(elapsedMs);
    },
    get: (id = "note") =>
      workspace.current.current.objects.find((o) => o.id === id),
    hover: () => hover,
    home,
    neighbor,
  };
}

for (const scale of [0.5, 1, 2]) {
  test(`loose notes enter a board immediately at zoom ${scale}`, (t) => {
    const ui = drag(t, { scale, noteProps: { parentId: null, y: 850 } });
    ui.move(0, -500);
    assert.equal(ui.hover()?.ready, true);
    ui.up(0, -500);
    assert.equal(ui.get().parentId, "home");
    assert.deepEqual(
      ui.get("home"),
      ui.home,
      "receiving feedback does not resize stored geometry",
    );
  });
}

for (const noteProps of [{}, { noteKind: "checklist" }, { type: "image" }]) {
  test(`board ${noteProps.type || noteProps.noteKind || "note"} can leave after a one-second canvas pause`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ui = drag(t, { noteProps });
    ui.move(-500, 0);
    ui.tick(999);
    assert.equal(ui.hover()?.ready, false);
    assert.equal(
      ui.get().parentId,
      "home",
      "membership is committed only on release",
    );
    ui.tick(1);
    assert.equal(ui.hover()?.ready, true);
    ui.up(-500, 0);
    assert.equal(ui.get().parentId, null);
    assert.deepEqual([ui.get().x, ui.get().y], [-240, 300]);
    ui.tick(2000);
    assert.equal(ui.get().parentId, null);
  });
}

test("moving on the canvas restarts exit waiting while small screen-space jitter is allowed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = drag(t, { scale: 2 });
  ui.move(-500, 0);
  ui.tick(800);
  ui.move(-510, 0);
  ui.tick(800);
  assert.equal(ui.hover()?.ready, false);
  ui.move(-508, 0, { elapsedMs: 0 });
  ui.tick(200);
  assert.equal(ui.hover()?.ready, true);
  ui.up(-508, 0);
  assert.equal(ui.get().parentId, null);
});

test("re-entering a board cancels exit readiness and early release returns inside", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = drag(t);
  ui.move(-500, 0);
  ui.tick(1000);
  ui.move(0, 0);
  ui.move(-500, 0);
  ui.tick(500);
  ui.up(-500, 0);
  ui.tick(2000);
  assert.equal(ui.get().parentId, "home");
  assert.equal(ui.get().x, 150);
  assert.equal(ui.hover(), null);
});

test("board members transfer directly to another board, but cannot detach on a locked board", (t) => {
  const ui = drag(t);
  ui.move(800, 0);
  ui.up(800, 0);
  assert.equal(ui.get().parentId, "neighbor");
  assert.deepEqual(
    [ui.get().x, ui.get().y],
    [1060, 300],
    "transfer preserves the requested landing point",
  );
  const locked = drag(t, { neighborProps: { locked: true } });
  locked.move(800, 0);
  locked.replay(2000);
  locked.up(800, 0);
  assert.equal(locked.get().parentId, "home");
});

test("multiple board members detach together after the same canvas pause", (t) => {
  const second = {
    ...model.createObject("", "note", { x: 500, y: 450 }),
    id: "second",
    parentId: "home",
    width: 180,
    height: 120,
    layoutHeight: 120,
  };
  const ui = drag(t, { selected: ["note", "second"], extra: [second] });
  ui.move(-700, 0);
  ui.replay(1000);
  ui.up(-700, 0);
  assert.equal(ui.get().parentId, null);
  assert.equal(ui.get("second").parentId, null);
  assert.deepEqual(ui.get("home"), ui.home);
});

test("ordinary groups still require two seconds to accept a loose note", (t) => {
  const group = {
    ...model.createObject("", "frame", { x: 1500, y: 1000 }),
    id: "group",
    width: 600,
    height: 500,
  };
  const ui = drag(t, { noteProps: { parentId: null, y: 850 }, extra: [group] });
  ui.move(1400, 300);
  assert.equal(ui.hover()?.ready, false);
  ui.replay(1000);
  assert.equal(ui.hover()?.ready, false);
  ui.replay(1000);
  assert.equal(ui.hover()?.ready, true);
  ui.up(1400, 300);
  assert.equal(ui.get().parentId, "group");
});

test("release before the exit deadline cannot be changed by a later timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = drag(t);
  ui.move(-500, 0);
  ui.tick(999);
  ui.up(-500, 0, { elapsedMs: 0 });
  ui.tick(2000);
  assert.equal(ui.get().parentId, "home");
  assert.equal(ui.get().x, 150);
});

test("a board without enough space refuses immediate entry without claiming the loose note", (t) => {
  const ui = drag(t, {
    noteProps: { parentId: null, y: 850, width: 4000 },
  });
  ui.move(0, -500);
  assert.equal(ui.hover()?.unavailable, true);
  ui.up(0, -500);
  assert.equal(ui.get().parentId, null);
});

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

function alignmentScene(t, options = {}) {
  const loose = {
    ...model.createObject("", options.type || "note", { x: 100, y: 1000 }),
    id: "loose",
    width: 200,
    height: 180,
    layoutHeight: 180,
  };
  const target = { ...loose, id: "target", x: 500, y: 1200 };
  return drag(t, { selected: ["loose"], extra: [loose, target], ...options });
}

test("fast drags pass alignment lines without pausing at every zoom", (t) => {
  for (const scale of [0.5, 1, 2]) {
    const ui = alignmentScene(t, { scale });
    ui.move(220, 0);
    assert.equal(ui.get("loose").x, 320);
    ui.up(220, 0);
    assert.equal(ui.get("loose").x, 320);
  }
});

test("fast release near an edge keeps the pointer position instead of enabling alignment", (t) => {
  const ui = alignmentScene(t);
  ui.move(195, 0);
  assert.equal(ui.get("loose").x, 295);
  ui.up(195, 0);
  assert.equal(ui.get("loose").x, 295);
});

test("slowing down enables edge alignment and accelerating releases an active hold immediately", (t) => {
  for (const scale of [0.5, 1, 2]) {
    const ui = alignmentScene(t, { scale });
    ui.move(190, 0);
    ui.move(191, 0, { elapsedMs: 40 });
    ui.move(197, 0, { elapsedMs: 80 });
    assert.equal(ui.get("loose").x, 300, `slow alignment at scale ${scale}`);
    ui.move(220, 0);
    assert.equal(ui.get("loose").x, 320);
  }
});

test("stopping near an edge aligns after settling but does not recapture a distant crossed line", (t) => {
  const near = alignmentScene(t);
  near.move(195, 0);
  near.replay(60);
  assert.equal(near.get("loose").x, 295);
  near.replay(61);
  assert.equal(near.get("loose").x, 300);
  const crossed = alignmentScene(t);
  crossed.move(220, 0);
  crossed.replay(121);
  assert.equal(crossed.get("loose").x, 320);
});

test("board boundary attraction waits for a slow drag while collision prevention remains intact", (t) => {
  const fast = drag(t, { selected: ["home"] });
  fast.move(21, 0);
  assert.equal(fast.get("home").x, 221);
  fast.up(21, 0);
  assert.equal(fast.get("home").x, 221);
  const slow = drag(t, { selected: ["home"] });
  slow.move(15, 0);
  slow.move(16, 0, { elapsedMs: 40 });
  slow.move(21, 0, { elapsedMs: 80 });
  assert.equal(slow.get("home").x, 226);
  assert.equal(slow.get().x, 286);
});

test("images also bypass edge attraction when moving fast and align when slowed", (t) => {
  const ui = alignmentScene(t, { type: "image" });
  ui.move(195, 0);
  assert.equal(ui.get("loose").x, 295);
  ui.move(196, 0, { elapsedMs: 40 });
  ui.move(197, 0, { elapsedMs: 80 });
  assert.equal(ui.get("loose").x, 300);
  ui.move(220, 0);
  assert.equal(ui.get("loose").x, 320);
});

test("the settling timer aligns a stopped pointer and is cancelled on release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = alignmentScene(t);
  ui.move(195, 0);
  ui.tick(119);
  assert.equal(ui.get("loose").x, 295);
  ui.tick(1);
  assert.equal(ui.get("loose").x, 300);
  ui.move(215, 0);
  ui.up(215, 0);
  ui.tick(1000);
  assert.equal(ui.get("loose").x, 315);
});

test("a long pointerdown pause cannot make a subsequent fast jump look slow", (t) => {
  const ui = alignmentScene(t);
  ui.move(195, 0, { elapsedMs: 5000 });
  assert.equal(ui.get("loose").x, 295);
});
