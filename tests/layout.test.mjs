import { wrapLegacyGroup } from "./legacy-groups.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/canvas/model.js";
import { intersects } from "../src/canvas/geometry.js";
const layout = await import("../src/canvas/layout.js").catch(() => ({}));
function fixture() {
  const state = model.createWorkspace(),
    board = state.boards[0].id;
  const a = {
    ...model.createObject(board, "note", { x: 100, y: 120 }),
    width: 100,
    height: 80,
  };
  const b = {
    ...model.createObject(board, "note", { x: 250, y: 180 }),
    width: 100,
    height: 80,
  };
  return { ...state, objects: [a, b] };
}
test("existing groups cannot be grouped a second time; their padding stays unchanged", () => {
  let state = fixture();
  const ids = state.objects.map((o) => o.id);
  state = model.groupObjects(state, ids);
  const frame = state.objects.at(-1);
  assert.equal(frame.x, 76);
  assert.equal(frame.y, 72);
  assert.equal(model.groupObjects(state, [frame.id]), state);
  assert.equal(model.groupObjects(state, ids), state);
  assert.equal(state.objects.filter((o) => o.type === "frame").length, 1);
});

test("moving nested groups translates all descendants once and a locked descendant blocks the entire move", () => {
  let s = fixture();
  s = model.groupObjects(
    s,
    s.objects.map((o) => o.id),
  );
  s = wrapLegacyGroup(s, [s.objects.at(-1).id]);
  const root = s.objects.at(-1),
    before = s.objects;
  const moved = model.moveObjects(s, [root.id, before[0].id], {
    x: 70,
    y: -30,
  });
  for (const o of moved.objects) {
    const old = before.find((p) => p.id === o.id);
    assert.equal(o.x, old.x + 70);
    assert.equal(o.y, old.y - 30);
  }
  const locked = {
    ...s,
    objects: s.objects.map((o, i) => (i === 0 ? { ...o, locked: true } : o)),
  };
  assert.deepEqual(
    model.moveObjects(locked, [root.id], { x: 100, y: 100 }).objects,
    locked.objects,
  );
});
test("moving and resizing a member shrink or grow every ancestor to its minimum padded bounds", () => {
  let s = fixture();
  s = model.groupObjects(
    s,
    s.objects.map((o) => o.id),
  );
  s = wrapLegacyGroup(s, [s.objects.at(-1).id]);
  const [a, b] = s.objects;
  s = model.patchObjects(s, {
    [b.id]: { x: 500, y: 400, width: 160, height: 110 },
  });
  const inner = s.objects.find((o) => o.id === a.parentId),
    outer = s.objects.at(-1);
  assert.equal(inner.x, 76);
  assert.equal(inner.width, 608);
  assert.equal(inner.height, 462);
  assert.equal(outer.width, inner.width + 48);
  assert.equal(outer.height, inner.height + 72);
  s = model.patchObjects(s, {
    [b.id]: { x: 210, y: 120, width: 100, height: 80 },
  });
  assert.equal(s.objects.find((o) => o.id === inner.id).width, 258);
});
test("nested ownership rejects cycles and reparenting a group into its descendant", () => {
  let s = fixture();
  s = model.groupObjects(
    s,
    s.objects.map((o) => o.id),
  );
  s = wrapLegacyGroup(s, [s.objects.at(-1).id]);
  const inner = s.objects.at(-2),
    outer = s.objects.at(-1);
  assert.equal(typeof model.reparentObjects, "function");
  assert.deepEqual(model.reparentObjects(s, [outer.id], inner.id), s);
  const bad = structuredClone(s);
  bad.objects.find((o) => o.id === outer.id).parentId = inner.id;
  assert.throws(() => model.validateWorkspace(bad), /循环/);
});
test("duplicate, dissolve, trash and restore retain the complete nested tree", () => {
  let s = fixture();
  s = model.groupObjects(
    s,
    s.objects.map((o) => o.id),
  );
  const inner = s.objects.at(-1);
  s = wrapLegacyGroup(s, [inner.id]);
  const outer = s.objects.at(-1);
  const doubled = model.duplicateObjects(s, [outer.id]);
  assert.equal(doubled.objects.length, 8);
  assert.doesNotThrow(() => model.validateWorkspace(doubled));
  const dissolved = model.deleteObjects(s, [inner.id]);
  assert.equal(dissolved.objects[0].parentId, outer.id);
  assert.doesNotThrow(() => model.validateWorkspace(dissolved));
  const deleted = model.deleteObjects(s, [outer.id], true);
  assert.equal(deleted.objects.length, 0);
  assert.equal(deleted.trash[0].objects.length, 4);
  const restored = model.restoreTrash(deleted, deleted.trash[0].id);
  assert.equal(restored.objects.length, 4);
  assert.doesNotThrow(() => model.validateWorkspace(restored));
});
test("collections accept images and remain icon sized without changing image bytes or geometry", () => {
  const s = fixture(),
    box = model.createObject(s.boards[0].id, "collection");
  const picture = {
    ...model.createObject(s.boards[0].id, "image"),
    assetId: "asset",
  };
  const next = model.collectObjects(
    { ...s, objects: [...s.objects, box, picture] },
    [s.objects[0].id, picture.id],
    box.id,
  );
  assert.equal(next.objects.find((o) => o.id === picture.id).parentId, box.id);
  assert.equal(box.width, 64);
  assert.equal(box.height, 64);
  assert.equal(next.objects.find((o) => o.id === picture.id).assetId, "asset");
});
test("marquee promotes fully selected group members to the existing group", () => {
  assert.equal(typeof layout.marqueeRoots, "function");
  let s = fixture();
  s = model.groupObjects(
    s,
    s.objects.map((o) => o.id),
  );
  const group = s.objects.at(-1);
  assert.deepEqual(
    layout.marqueeRoots(s.objects, { x: 99, y: 119, width: 252, height: 142 }),
    [group.id],
  );
});
test("edge snapping handles adjacency, overlapping left edges, distance, and screen-scale tolerance", () => {
  assert.equal(typeof layout.snapMove, "function");
  const target = { id: "target", x: 200, y: 100, width: 100, height: 100 };
  const rect = { x: 95, y: 120, width: 100, height: 60 };
  assert.equal(layout.snapMove(rect, [target], 1).x, 100);
  assert.equal(layout.snapMove({ ...rect, x: 204 }, [target], 1).x, 200);
  assert.equal(layout.snapMove({ ...rect, x: 209 }, [target], 1).x, 209);
  assert.equal(layout.snapMove({ ...rect, x: 214 }, [target], 0.5).x, 200);
  assert.equal(layout.snapMove({ ...rect, y: 500 }, [target], 1).x, 95);
});

test("resize snapping aligns the moving edges, holds briefly, and releases beyond the threshold", () => {
  assert.equal(typeof layout.snapResize, "function");
  const target = { id: "b", x: 420, y: 100, width: 200, height: 250 };
  const rect = { x: 100, y: 100, width: 314, height: 244 };
  const snap = layout.snapResize(rect, [target], 0.5, {}, { now: 0 });
  assert.deepEqual([snap.width, snap.height], [320, 250]);
  const held = layout.snapResize(
    { ...rect, width: 338, height: 268 },
    [target],
    0.5,
    snap.snaps,
    { now: 80 },
  );
  assert.deepEqual([held.width, held.height], [320, 250]);
  const released = layout.snapResize(
    { ...rect, width: 348, height: 278 },
    [target],
    0.5,
    held.snaps,
    { now: 200 },
  );
  assert.deepEqual([released.width, released.height], [348, 278]);
  assert.deepEqual(
    layout.snapResize(rect, [{ ...target, y: 700 }], 1).width,
    320,
  );
  assert.equal(
    layout.snapResize({ ...rect, width: 166 }, [{ ...target, x: 259 }], 1)
      .width,
    166,
    "a target must not shrink a note below minimum width",
  );
});

test("moving edges pause on distant alignment and release without restarting a crossed line", () => {
  const target = { id: "remote", x: 500, y: 700, width: 180, height: 100 };
  const rect = { x: 316, y: 100, width: 180, height: 100 };
  const snap = layout.snapMove(
    rect,
    [target],
    1,
    {},
    { pause: true, now: 0, previousRect: { ...rect, x: 300 } },
  );
  assert.equal(snap.x, 320);
  const held = layout.snapMove({ ...rect, x: 342 }, [target], 1, snap.snaps, {
    pause: true,
    now: 60,
    previousRect: rect,
  });
  assert.equal(held.x, 320);
  const released = layout.snapMove(
    { ...rect, x: 342 },
    [target],
    1,
    held.snaps,
    { pause: true, now: 161, previousRect: { ...rect, x: 342 } },
  );
  assert.equal(released.x, 342);
  const crossed = layout.snapMove(
    { ...rect, x: 340 },
    [target],
    1,
    {},
    { pause: true, now: 0, previousRect: { ...rect, x: 300 } },
  );
  assert.equal(crossed.x, 320);
  const expired = layout.snapMove(
    { ...rect, x: 342 },
    [target],
    1,
    snap.snaps,
    { pause: true, now: 200, previousRect: rect },
  );
  assert.equal(expired.x, 342);
  const strongPull = layout.snapMove(
    { ...rect, x: 360 },
    [target],
    1,
    snap.snaps,
    { pause: true, now: 60, previousRect: rect },
  );
  assert.equal(strongPull.x, 360);
  const zoomed = layout.snapMove(
    { ...rect, x: 364 },
    [target],
    0.5,
    snap.snaps,
    { pause: true, now: 60, previousRect: rect },
  );
  assert.equal(zoomed.x, 320, "hold distance is measured in screen pixels");
});

test("resize pauses on distant alignment lines and catches a crossed edge without requiring adjacent elements", () => {
  const target = { id: "remote", x: 500, y: 100, width: 200, height: 300 };
  const before = { x: 0, y: 100, width: 280, height: 280 };
  const raw = { ...before, height: 320 };
  const snap = layout.snapResize(
    raw,
    [target],
    1,
    {},
    { now: 0, previousRect: before },
  );
  assert.equal(
    snap.height,
    300,
    "crossing the remote bottom edge must catch its alignment line",
  );
  const held = layout.snapResize(
    { ...raw, height: 326 },
    [target],
    1,
    snap.snaps,
    { now: 100, previousRect: raw },
  );
  assert.equal(held.height, 300);
  const free = layout.snapResize(
    { ...raw, height: 326 },
    [target],
    1,
    held.snaps,
    { now: 161, previousRect: { ...raw, height: 326 } },
  );
  assert.equal(
    free.height,
    326,
    "continue from the pointer after the short pause",
  );
  const pulled = layout.snapResize(
    { ...raw, height: 350 },
    [target],
    1,
    snap.snaps,
    { now: 30, previousRect: raw },
  );
  assert.equal(pulled.height, 350, "a decisive pull must not feel locked");
  const expired = layout.snapResize(
    { ...raw, height: 326 },
    [target],
    1,
    snap.snaps,
    { now: 200, previousRect: before },
  );
  assert.equal(
    expired.height,
    326,
    "crossing an already held line must not restart its expired pause",
  );
});
test("image placement predicts a collision-free position without moving existing content", () => {
  assert.equal(typeof layout.placementInFrame, "function");
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const sibling = { id: "other", x: 24, y: 48, width: 150, height: 100 };
  const image = { width: 100, height: 80 };
  const preview = layout.placementInFrame(frame, image, [sibling], {
    x: 30,
    y: 50,
  });
  assert.ok(preview.x >= 24 && preview.y >= 48);
  assert.equal(preview.width, 100);
  assert.equal(preview.height, 80);
  assert.equal(
    intersects(preview, {
      ...sibling,
      x: sibling.x - 20,
      y: sibling.y - 20,
      width: sibling.width + 40,
      height: sibling.height + 40,
    }),
    false,
  );
  assert.deepEqual(
    preview,
    layout.placementInFrame(frame, image, [sibling], { x: 30, y: 50 }),
  );
  assert.equal(sibling.x, 24);
});

test("swept group boundaries stop fast crossings on every side, slide tangentially, and tolerate existing overlap", () => {
  assert.equal(typeof layout.constrainFrameMove, "function");
  const object = { x: 100, y: 240, width: 100, height: 80 };
  const frame = { x: 376, y: 172, width: 188, height: 232 };
  const pairs = [{ object, frame }];
  let move = layout.constrainFrameMove(pairs, { x: 0, y: 0 }, { x: 800, y: 0 });
  assert.equal(move.x, 152);
  move = layout.constrainFrameMove(pairs, move, { x: 800, y: 290 });
  assert.deepEqual([move.x, move.y], [152, 290]);
  move = layout.constrainFrameMove(pairs, move, { x: 800, y: 290 });
  assert.deepEqual([move.x, move.y], [800, 290]);
  move = layout.constrainFrameMove(
    [{ object: { ...object, x: 800 }, frame }],
    { x: 0, y: 0 },
    { x: -1000, y: 0 },
  );
  assert.equal(move.x, -212);
  move = layout.constrainFrameMove(
    [{ object: { ...object, x: 410, y: 0 }, frame }],
    { x: 0, y: 0 },
    { x: 0, y: 900 },
  );
  assert.equal(move.y, 68);
  move = layout.constrainFrameMove(
    [{ object: { ...object, x: 410, y: 600 }, frame }],
    { x: 0, y: 0 },
    { x: 0, y: -900 },
  );
  assert.equal(move.y, -172);
  move = layout.constrainFrameMove(
    [{ object: { ...object, x: 400 }, frame }],
    { x: 0, y: 0 },
    { x: -400, y: 0 },
  );
  assert.equal(
    move.x,
    -400,
    "old overlapping content can leave without teleporting on load",
  );
});

test("padded group snapping uses screen-scaled tolerance and can be disabled without disabling collision", () => {
  assert.equal(typeof layout.constrainFrameMove, "function");
  const pairs = [
    {
      object: { x: 100, y: 240, width: 100, height: 80 },
      frame: { x: 376, y: 172, width: 188, height: 232 },
    },
  ];
  for (const scale of [0.25, 0.7, 2, 4]) {
    const desired = { x: 152 - 6 / scale, y: 0 };
    const snapped = layout.constrainFrameMove(pairs, { x: 0, y: 0 }, desired, {
      scale,
    });
    assert.equal(snapped.x, 152);
    assert.ok(snapped.guides.some((g) => g.axis === "x" && g.at === 352));
    const free = layout.constrainFrameMove(pairs, { x: 0, y: 0 }, desired, {
      scale,
      snap: false,
    });
    assert.equal(free.x, desired.x);
    const blocked = layout.constrainFrameMove(
      pairs,
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { scale, snap: false },
    );
    assert.equal(blocked.x, 152);
  }
});

test("a child edge translated with another selected member does not repeatedly pull the selection", () => {
  const pairs = [
    {
      object: { x: 100, y: 240, width: 100, height: 80 },
      frame: { x: 230, y: 192, width: 594, height: 152 },
      movingFrame: { x: 230, y: 192, width: 148, height: 152 },
      fixedFrame: { x: 676, y: 192, width: 148, height: 152 },
    },
  ];
  let move = layout.constrainFrameMove(pairs, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(
    move.x,
    10,
    "the moving edge keeps a constant 30px gap, so it must not attract itself",
  );
  for (let i = 0; i < 3; i++) {
    move = layout.constrainFrameMove(pairs, move, move);
    assert.equal(
      move.x,
      10,
      "stationary pointer and release do not accumulate snapping offsets",
    );
  }
});
