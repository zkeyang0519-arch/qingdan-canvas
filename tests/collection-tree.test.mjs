import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/canvas/model.js";
import { normalizeLayout, descendantIds } from "../src/canvas/layout.js";
import { exportArchive, importArchive } from "../src/canvas/backup.js";
import { primaryCollection } from "../src/canvas/collectionDock.js";

function fixture() {
  const state = model.createWorkspace(),
    board = state.boards[0].id;
  const outer = model.createObject(board, "collection", { x: 800, y: 400 });
  const group = model.createObject(board, "frame");
  const inner = { ...model.createObject(board, "frame"), parentId: group.id };
  const note = {
    ...model.createObject(board, "note", { x: 100, y: 160 }),
    parentId: inner.id,
  };
  const image = {
    ...model.createObject(board, "image", { x: 420, y: 170 }),
    parentId: inner.id,
    assetId: "asset-test",
  };
  const box = {
    ...model.createObject(board, "collection", { x: 740, y: 160 }),
    parentId: group.id,
  };
  const saved = {
    ...model.createObject(board, "note", { x: -100, y: -100 }),
    parentId: box.id,
  };
  const blob = new Blob(
    ['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    { type: "image/svg+xml" },
  );
  state.assets[image.assetId] = {
    id: image.assetId,
    mime: blob.type,
    byteLength: blob.size,
  };
  state.objects = [outer, group, inner, note, image, box, saved];
  return {
    state: normalizeLayout(state),
    outer,
    group,
    inner,
    note,
    image,
    box,
    saved,
    blobs: new Map([[image.assetId, blob]]),
  };
}
const find = (state, id) => state.objects.find((o) => o.id === id);

test("deleting a collected group archives its entire tree and restores it inside the same box", () => {
  const { state, outer, group, image } = fixture();
  const collected = model.collectObjects(state, [group.id], outer.id);
  const next = model.deleteCollectedObjects(collected, outer.id, [group.id]);
  assert.deepEqual(
    next.objects.map((o) => o.id),
    [outer.id],
  );
  assert.equal(next.trash.length, 1);
  assert.equal(next.trash[0].objects.length, 6);
  assert.deepEqual(next.assets[image.assetId], collected.assets[image.assetId]);
  const restored = model.restoreTrash(next, next.trash[0].id);
  assert.deepEqual(restored.objects, collected.objects);
});

test("clearing collection contents preserves its box, locked subtrees and other projects", () => {
  const f = fixture();
  let state = model.collectObjects(f.state, [f.group.id], f.outer.id);
  state = model.patchObjects(state, { [f.note.id]: { locked: true } });
  state = model.addBoard(state, "Other");
  const otherBoard = state.boards.at(-1),
    otherBox = state.objects.find((o) => o.boardId === otherBoard.id);
  const a = {
    ...model.createObject(f.outer.boardId, "note"),
    parentId: f.outer.id,
  };
  const otherNote = {
    ...model.createObject(otherBoard.id, "note"),
    parentId: otherBox.id,
  };
  state.objects.push(a, otherNote);
  const next = model.deleteCollectedObjects(state, f.outer.id);
  assert.equal(find(next, a.id), undefined);
  assert.ok(find(next, f.outer.id));
  for (const o of state.objects.filter((o) => o.id !== a.id))
    assert.deepEqual(find(next, o.id), o);
  assert.deepEqual(
    next.trash[0].objects.map((o) => o.id),
    [a.id],
  );
  assert.equal(
    model.deleteCollectedObjects(next, f.outer.id, [
      f.outer.id,
      otherNote.id,
      f.group.id,
    ]),
    next,
  );
});

test("collecting a whole group preserves every nested object and selected descendants are not flattened", () => {
  const { state, outer, group, note } = fixture();
  const next = model.collectObjects(state, [group.id, note.id], outer.id);
  assert.equal(find(next, group.id).parentId, outer.id);
  for (const before of state.objects) {
    const after = find(next, before.id);
    assert.deepEqual(
      [after.x, after.y, after.width, after.height],
      [before.x, before.y, before.width, before.height],
    );
    if (before.id !== group.id) assert.equal(after.parentId, before.parentId);
  }
  assert.doesNotThrow(() => model.validateWorkspace(next));
});

test("collection boxes can be nested with their contents intact", () => {
  const { state, outer, box, saved } = fixture();
  const next = model.collectObjects(state, [box.id], outer.id);
  assert.equal(find(next, box.id).parentId, outer.id);
  assert.deepEqual(find(next, saved.id), find(state, saved.id));
  assert.doesNotThrow(() => model.validateWorkspace(next));
});

test("collection rejects self and ancestor cycles, other boards and locked subtrees", () => {
  const { state, outer, group, box, note } = fixture();
  assert.deepEqual(model.collectObjects(state, [outer.id], outer.id), state);
  assert.deepEqual(model.collectObjects(state, [group.id], box.id), state);
  const locked = model.patchObjects(state, { [note.id]: { locked: true } });
  assert.deepEqual(model.collectObjects(locked, [group.id], outer.id), locked);
  const foreign = model.addBoard(state, "另一个项目");
  const other = model.createObject(foreign.boards.at(-1).id, "collection");
  foreign.objects = [...foreign.objects, other];
  assert.deepEqual(
    model.collectObjects(foreign, [group.id], other.id),
    foreign,
  );
  const cyclic = model.patchObjects(state, {
    [group.id]: { parentId: box.id },
  });
  assert.throws(() => model.validateWorkspace(cyclic), /循环/);
});

test("an immovable selected group does not prevent another selected note entering its unlocked box", () => {
  const { state, group, box, note } = fixture();
  const outside = model.createObject(state.boards[0].id, "note", {
    x: -500,
    y: 400,
  });
  const locked = model.patchObjects(
    { ...state, objects: [...state.objects, outside] },
    { [note.id]: { locked: true } },
  );
  const next = model.collectObjects(locked, [group.id, outside.id], box.id);
  assert.equal(find(next, outside.id).parentId, box.id);
  for (const o of locked.objects.filter((o) => o.id !== outside.id))
    assert.deepEqual(find(next, o.id), o);
  assert.doesNotThrow(() => model.validateWorkspace(next));
});

for (const type of ["frame", "collection"])
  test(`taking out a ${type} translates its complete subtree by the same delta`, () => {
    const f = fixture(),
      root = type === "frame" ? f.group : f.box;
    const collected = model.collectObjects(f.state, [root.id], f.outer.id);
    assert.equal(typeof model.takeOutObject, "function");
    const origin = find(collected, root.id),
      point = { x: 900, y: 450 };
    const next = model.takeOutObject(collected, root.id, point);
    const moved = descendantIds(collected.objects, [root.id]);
    for (const before of collected.objects) {
      const after = find(next, before.id);
      assert.deepEqual(
        [after.x, after.y],
        moved.has(before.id)
          ? [before.x + point.x - origin.x, before.y + point.y - origin.y]
          : [before.x, before.y],
      );
      assert.equal(
        after.parentId,
        before.id === root.id ? null : before.parentId,
      );
    }
    assert.doesNotThrow(() => model.validateWorkspace(next));
    const locked = model.patchObjects(collected, {
      [f.saved.id]: { locked: true },
    });
    assert.deepEqual(model.takeOutObject(locked, root.id, point), locked);
  });

test("dissolving a collection releases an entire group beside the icon with internal spacing intact", () => {
  const { state, outer, group } = fixture();
  const collected = model.collectObjects(state, [group.id], outer.id);
  const before = find(collected, group.id);
  const next = model.deleteObjects(collected, [outer.id]);
  const after = find(next, group.id);
  assert.deepEqual(
    [after.x, after.y, after.parentId],
    [outer.x + outer.width + 24, outer.y, null],
  );
  for (const key of descendantIds(collected.objects, [group.id])) {
    const a = find(next, key),
      b = find(collected, key);
    assert.deepEqual(
      [a.x - after.x, a.y - after.y],
      [b.x - before.x, b.y - before.y],
    );
  }
  assert.doesNotThrow(() => model.validateWorkspace(next));
});

test("nested collections survive backup roundtrip, duplication, deletion and restore", async () => {
  const { state, outer, group, blobs } = fixture();
  const next = model.collectObjects(state, [group.id], outer.id);
  assert.equal(find(next, group.id).parentId, outer.id);
  const imported = await importArchive(await exportArchive(next, blobs));
  assert.deepEqual(imported.state, next);
  assert.equal(
    await imported.assets.get("asset-test").text(),
    await blobs.get("asset-test").text(),
  );
  const copied = model.duplicateObjects(next, [outer.id]);
  assert.equal(copied.objects.length, next.objects.length * 2);
  assert.doesNotThrow(() => model.validateWorkspace(copied));
  const deleted = model.deleteObjects(next, [outer.id], true);
  assert.equal(deleted.objects.length, 0);
  assert.deepEqual(
    model.restoreTrash(deleted, deleted.trash[0].id).objects,
    next.objects,
  );
});

test("dissolving a fixed collection releases contents beside its displayed position", () => {
  const { state, outer, group } = fixture();
  const collected = model.collectObjects(state, [group.id], outer.id);
  const origin = { x: -120, y: -250, width: 96, height: 96 };
  const next = model.deleteObjects(collected, [outer.id], false, {
    [outer.id]: origin,
  });
  const released = find(next, group.id);
  assert.deepEqual([released.x, released.y], [0, -250]);
  assert.deepEqual(
    next.trash[0].objects[0],
    find(collected, outer.id),
    "a viewport position must not overwrite the archived object's coordinates",
  );
});

test("taking out an older nested box keeps the same primary collection through backup", async () => {
  const state = model.createWorkspace(),
    board = state.boards[0].id;
  const dock = model.createObject(board, "collection", { x: 8000, y: 5000 });
  const older = {
    ...model.createObject(board, "collection"),
    parentId: dock.id,
  };
  const stored = normalizeLayout({ ...state, objects: [older, dock] });
  assert.equal(primaryCollection(stored, board).id, dock.id);
  const released = model.takeOutObject(stored, older.id, { x: 90, y: 10 });
  assert.equal(primaryCollection(released, board).id, dock.id);
  assert.deepEqual(
    [find(released, older.id).x, find(released, older.id).y],
    [90, 10],
  );
  const imported = await importArchive(
    await exportArchive(released, new Map()),
  );
  assert.equal(primaryCollection(imported.state, board).id, dock.id);
  const deleted = model.deleteObjects(released, [dock.id], true);
  assert.equal(primaryCollection(deleted, board).id, older.id);
});

test("moving an older collection into another board does not replace that board's fixed entrance", () => {
  const state = model.addBoard(model.createWorkspace(), "目标画布");
  const [source, target] = state.boards;
  const older = model.createObject(source.id, "collection");
  const dock = model.createObject(target.id, "collection");
  const initial = normalizeLayout({ ...state, objects: [older, dock] });
  const moved = model.moveToBoard(initial, [older.id], target.id);
  assert.equal(primaryCollection(moved, target.id).id, dock.id);
});

test("a new project owns an empty collection independent from existing stored contents", () => {
  const { state, outer, group } = fixture();
  const collected = model.collectObjects(state, [group.id], outer.id);
  const next = model.addBoard(collected, "独立项目");
  const board = next.boards.at(-1),
    dock = primaryCollection(next, board.id);
  assert.ok(dock, "new projects receive their own collection");
  assert.notEqual(dock.id, outer.id);
  assert.equal(next.objects.filter((o) => o.parentId === dock.id).length, 0);
  assert.equal(find(next, group.id).parentId, outer.id);
  assert.deepEqual(model.collectObjects(next, [group.id], dock.id), next);
  assert.deepEqual(
    model.takeOutObject(next, group.id, { x: 90, y: 10 }, board.id),
    next,
  );
});
