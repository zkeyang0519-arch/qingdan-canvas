import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as model from "../src/canvas/model.js";
import * as geometry from "../src/canvas/geometry.js";
import * as paste from "../src/canvas/paste.js";
const fixture = JSON.parse(
  readFileSync(new URL("./sample-backup.json", import.meta.url)),
);

test("empty paragraphs become spacing and locked collected notes stay put on dissolve", () => {
  const state = model.createWorkspace(),
    board = state.boards[0].id,
    box = model.createObject(board, "collection");
  const note = {
    ...model.createObject(board, "note"),
    locked: true,
    parentId: box.id,
    blocks: [
      model.makeBlock("正文"),
      model.makeBlock(""),
      model.makeBlock("后续"),
    ],
  };
  const checklist = model.convertNote(note, "checklist");
  assert.equal(checklist.blocks[1].spacer, true);
  const dissolved = model.deleteObjects({ ...state, objects: [box, note] }, [
    box.id,
  ]);
  assert.equal(dissolved.objects[0].x, note.x);
  assert.equal(dissolved.objects[0].y, note.y);
  assert.equal(dissolved.objects[0].parentId, null);
});

test("v1 migration preserves task identities, completion dates and project isolation", () => {
  assert.equal(typeof model.migrateV1, "function");
  const state = model.migrateV1(fixture);
  assert.equal(state.version, 2);
  assert.equal(state.boards.length, 4);
  assert.equal(state.objects.length, 10);
  const note = state.objects.find((n) => n.blocks[0].id === "sample-task-3");
  assert.equal(note.boardId, "sample-web");
  assert.equal(note.blocks[0].completedAt, "2026-10-13T06:00:44.706Z");
  assert.equal(note.blocks[0].done, true);
  assert.equal(model.validateWorkspace(state).objects.length, 10);
});
test("right-click conversion and pointer-centered zoom preserve the world anchor", () => {
  assert.equal(typeof geometry.screenToWorld, "function");
  const view = { x: 120, y: -30, scale: 0.5 };
  assert.deepEqual(geometry.screenToWorld({ x: 70, y: 70 }, view), {
    x: -100,
    y: 200,
  });
  const zoomed = geometry.zoomAt(view, { x: 70, y: 70 }, 2);
  assert.deepEqual(geometry.screenToWorld({ x: 70, y: 70 }, zoomed), {
    x: -100,
    y: 200,
  });
});
test("local lists preserve numbers in ordinary prose and explicit completed markers", () => {
  assert.equal(typeof paste.parsePlainList, "function");
  const result = paste.parsePlainList(
    "1. 买咖啡\n- [x] 寄快递\n2026 年的计划\n3.14 圆周率\n\n直接换行",
  );
  assert.deepEqual(
    result.map((b) => [model.blockText(b), b.done]),
    [
      ["买咖啡", false],
      ["寄快递", true],
      ["2026 年的计划", false],
      ["3.14 圆周率", false],
      ["直接换行", false],
    ],
  );
});
const setup = () => {
  const state = model.createWorkspace();
  const board = state.boards[0].id;
  const a = model.createObject(board, "note", { x: -50, y: 80 });
  const b = model.createObject(board, "note", { x: 320, y: 160 });
  const box = model.createObject(board, "collection", { x: 700, y: 100 });
  return { ...state, objects: [a, b, box] };
};
test("group move preserves layout and locked member blocks the whole group move", () => {
  assert.equal(typeof model.groupObjects, "function");
  let state = setup();
  const [a, b] = state.objects;
  state = model.groupObjects(state, [a.id, b.id]);
  const group = state.objects.at(-1);
  state = model.moveObjects(state, [group.id], { x: 40, y: -20 });
  assert.deepEqual(
    state.objects.slice(0, 2).map((o) => [o.x, o.y]),
    [
      [-10, 60],
      [360, 140],
    ],
  );
  state.objects[0] = { ...state.objects[0], locked: true };
  const stopped = model.moveObjects(state, [group.id], { x: 50, y: 0 });
  assert.equal(stopped.objects[1].x, 360);
});
test("collection replaces group membership; dissolving retains the original note ID", () => {
  let state = setup();
  const [a, b, box] = state.objects;
  state = model.groupObjects(state, [a.id, b.id]);
  state = model.collectObjects(state, [a.id], box.id);
  assert.equal(state.objects.find((o) => o.id === a.id).parentId, box.id);
  state = model.deleteObjects(state, [box.id]);
  assert.equal(state.objects.find((o) => o.id === a.id).parentId, null);
  assert.equal(state.objects.filter((o) => o.id === a.id).length, 1);
});
test("mode round trip preserves multiline item, inline reference and completion", () => {
  const state = setup();
  const note = state.objects[0];
  note.noteKind = "checklist";
  note.blocks = [model.makeBlock("两行\n说明", true)];
  note.blocks[0].runs.push({
    type: "ref",
    targetId: state.objects[1].id,
    label: "素材",
  });
  const restored = model.convertNote(
    model.convertNote(note, "text"),
    "checklist",
  );
  assert.deepEqual(restored.blocks, note.blocks);
});
test("batch duplication remaps internal note references but preserves external references", () => {
  let state = setup();
  const [a, b] = state.objects;
  a.blocks[0].runs = [
    { type: "ref", targetId: b.id, label: "B" },
    { type: "ref", targetId: "outside", label: "外部" },
  ];
  state = model.duplicateObjects(state, [a.id, b.id]);
  const copies = state.objects.slice(-2);
  assert.equal(copies[0].blocks[0].runs[0].targetId, copies[1].id);
  assert.equal(copies[0].blocks[0].runs[1].targetId, "outside");
});
test("trash restores identifiers and rejects damaged geometry or container relationships", () => {
  let state = setup();
  const [a] = state.objects;
  state = model.deleteObjects(state, [a.id]);
  const batch = state.trash[0].id;
  state = model.restoreTrash(state, batch);
  assert.ok(state.objects.some((o) => o.id === a.id));
  const bad = structuredClone(state);
  bad.objects[0].x = Infinity;
  assert.throws(() => model.validateWorkspace(bad));
  const cross = structuredClone(state);
  cross.objects[0].parentId = "missing";
  assert.throws(() => model.validateWorkspace(cross));
});
