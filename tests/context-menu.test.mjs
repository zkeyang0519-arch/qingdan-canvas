import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspace,
  createObject,
  makeBlock,
} from "../src/canvas/model.js";
import {
  buildCanvasMenu,
  applyCanvasMenuAction,
  groupTargets,
} from "../src/canvas/context-menu.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";

function fixture() {
  const state = createWorkspace();
  const boardId = state.boards[0].id;
  const note = {
    ...createObject(boardId, "note"),
    id: "note",
    blocks: [makeBlock("保留原文")],
  };
  const frame = {
    ...createObject(boardId, "frame"),
    id: "frame",
    title: "灵感板",
    fixedBounds: true,
    width: 600,
    height: 400,
  };
  const other = { ...createObject(boardId, "note"), id: "other", x: 800 };
  return {
    state: { ...state, objects: [note, frame, other] },
    boardId,
    note,
    frame,
    other,
  };
}
function menu(f, objectId, selection = [objectId], readOnly = false) {
  return buildCanvasMenu({
    state: f.state,
    boardId: f.boardId,
    context: { objectId, world: { x: 123, y: 456 } },
    selection,
    readOnly,
  });
}
const ids = (items) => items.filter((i) => !i.separator).map((i) => i.id);

test("便签和清单显示自己的编辑操作，灵感板显示重命名和解散", () => {
  const f = fixture();
  const noteMenu = menu(f, "note");
  for (const id of [
    "edit",
    "convert",
    "reference",
    "backlinks",
    "colors",
    "front",
    "back",
  ]) {
    assert.ok(ids(noteMenu).includes(id), `便签缺少 ${id}`);
  }
  assert.equal(noteMenu.find((i) => i.id === "convert").label, "转为清单");
  f.state.objects[0].noteKind = "checklist";
  assert.equal(
    menu(f, "note").find((i) => i.id === "convert").label,
    "转为文字",
  );
  const frameIds = ids(menu(f, "frame"));
  assert.ok(frameIds.includes("rename"));
  assert.ok(frameIds.includes("dissolve"));
  for (const id of ["edit", "colors", "convert", "group", "join"])
    assert.ok(!frameIds.includes(id));
});

test("右键空白处不复用旧选区，右键另一个对象则正确切换操作目标", () => {
  const f = fixture();
  const blank = menu(f, undefined, ["note"]);
  assert.ok(ids(blank).includes("new-note"));
  assert.ok(ids(blank).includes("fit"));
  assert.ok(!ids(blank).includes("delete"));
  assert.deepEqual(
    menu(f, "other", ["note"]).find((i) => i.id === "delete").target.ids,
    ["other"],
  );
  const multi = menu(f, "note", ["note", "other"]);
  assert.deepEqual(multi.find((i) => i.id === "colors").target.ids, [
    "note",
    "other",
  ]);
  assert.deepEqual(multi.find((i) => i.id === "new-note").target.point, {
    x: 123,
    y: 456,
  });
});

test("右键转换保留条目内容和身份，颜色修改可通过共享数据校验", () => {
  const f = fixture();
  const converted = applyCanvasMenuAction(
    f.state,
    menu(f, "note").find((i) => i.id === "convert"),
    f,
  );
  assert.equal(converted.objects[0].noteKind, "checklist");
  assert.deepEqual(converted.objects[0].blocks, f.note.blocks);
  const action = {
    ...menu(f, "note", ["note", "other"]).find((i) => i.id === "colors"),
    value: "sage",
  };
  const colored = applyCanvasMenuAction(converted, action, f);
  const shared = prepareEdit(colored);
  assert.equal(shared.find((o) => o.id === "note").color, "sage");
  assert.equal(shared.find((o) => o.id === "other").color, "sage");
  assert.equal(shared.find((o) => o.id === "frame").title, "灵感板");
});

test("重命名使用最新对象，只修改名称而不覆盖其他成员刚改的尺寸", () => {
  const f = fixture();
  const action = {
    ...menu(f, "frame").find((i) => i.id === "rename"),
    value: "  资料收集  ",
  };
  const live = {
    ...f.state,
    objects: f.state.objects.map((o) =>
      o.id === "frame" ? { ...o, width: 900 } : o,
    ),
  };
  const next = applyCanvasMenuAction(live, action, f);
  const frame = prepareEdit(next).find((o) => o.id === "frame");
  assert.equal(frame.title, "资料收集");
  assert.equal(frame.width, 900);
});

test("分组、移出和解散菜单真正更新归属，解散保留内容", () => {
  const f = fixture();
  let state = applyCanvasMenuAction(
    f.state,
    menu(f, "note").find((i) => i.id === "group"),
    f,
  );
  const group = state.objects.find(
    (o) => !f.state.objects.some((old) => old.id === o.id),
  );
  assert.equal(group.type, "frame");
  assert.equal(state.objects.find((o) => o.id === "note").parentId, group.id);
  const grouped = { ...f, state };
  state = applyCanvasMenuAction(
    state,
    menu(grouped, "note").find((i) => i.id === "detach"),
    f,
  );
  assert.equal(state.objects.find((o) => o.id === "note").parentId, null);
  const join = {
    ...menu({ ...f, state }, "note").find((i) => i.id === "join"),
    value: "frame",
  };
  state = applyCanvasMenuAction(state, join, f);
  assert.equal(state.objects.find((o) => o.id === "note").parentId, "frame");
  state = applyCanvasMenuAction(
    state,
    menu({ ...f, state }, "frame").find((i) => i.id === "dissolve"),
    f,
  );
  assert.ok(!state.objects.some((o) => o.id === "frame"));
  assert.equal(state.objects.find((o) => o.id === "note").parentId, null);
  assert.equal(
    state.objects.find((o) => o.id === "note").blocks[0].runs[0].text,
    "保留原文",
  );
  assert.equal(state.trash[0].objects[0].id, "frame");
});

test("层级操作把对象放到其他对象之前或之后", () => {
  const f = fixture();
  const front = applyCanvasMenuAction(
    f.state,
    menu(f, "note").find((i) => i.id === "front"),
    f,
  );
  assert.ok(
    front.objects.find((o) => o.id === "note").zIndex >
      front.objects.find((o) => o.id === "other").zIndex,
  );
  const back = applyCanvasMenuAction(
    front,
    menu({ ...f, state: front }, "note").find((i) => i.id === "back"),
    f,
  );
  assert.ok(
    back.objects.find((o) => o.id === "note").zIndex <
      back.objects.find((o) => o.id === "other").zIndex,
  );
});

test("只读和父级锁定会禁用操作，打开菜单后发生的锁定也不能被绕过", () => {
  const f = fixture();
  const color = {
    ...menu(f, "note").find((i) => i.id === "colors"),
    value: "rose",
  };
  assert.equal(
    applyCanvasMenuAction(f.state, color, { ...f, readOnly: true }),
    f.state,
  );
  assert.equal(
    menu(f, "note", ["note"], true).find((i) => i.id === "colors").disabled,
    true,
  );
  f.state = {
    ...f.state,
    objects: f.state.objects.map((o) =>
      o.id === "frame"
        ? { ...o, locked: true }
        : o.id === "note"
          ? { ...o, parentId: "frame" }
          : o,
    ),
  };
  const locked = menu(f, "note");
  assert.equal(locked.find((i) => i.id === "edit").disabled, true);
  assert.equal(locked.find((i) => i.id === "lock").disabled, true);
  assert.equal(applyCanvasMenuAction(f.state, color, f), f.state);
  const unlocked = applyCanvasMenuAction(
    f.state,
    menu(f, "frame").find((i) => i.id === "unlock"),
    f,
  );
  assert.equal(unlocked.objects.find((o) => o.id === "frame").locked, false);
});

test("加入分组只列出当前画布中可用的目标，不允许形成循环", () => {
  const f = fixture();
  f.state.objects.push(
    { ...f.frame, id: "locked", locked: true },
    { ...f.frame, id: "foreign", boardId: "elsewhere" },
  );
  assert.deepEqual(
    groupTargets(f.state, ["note"], f.boardId).map((o) => o.id),
    ["frame"],
  );
  assert.deepEqual(groupTargets(f.state, ["frame"], f.boardId), []);
});

test("解散同时选中的框和子便签时，仍保留子便签内容", () => {
  const f = fixture();
  f.state.objects[0] = { ...f.note, parentId: "frame" };
  const action = menu(f, "frame", ["frame", "note"]).find(
    (i) => i.id === "dissolve",
  );
  const next = applyCanvasMenuAction(f.state, action, f);
  assert.ok(!next.objects.some((o) => o.id === "frame"));
  assert.equal(next.objects.find((o) => o.id === "note")?.parentId, null);
  assert.equal(
    next.objects.find((o) => o.id === "note")?.blocks[0].runs[0].text,
    "保留原文",
  );
});

test("固定收纳框可以重命名，但不能从右键菜单删除", () => {
  const f = fixture();
  f.state.objects.push({
    ...createObject(f.boardId, "collection"),
    id: "dock",
  });
  const items = menu(f, "dock");
  assert.equal(items.find((i) => i.id === "dissolve").disabled, true);
  const renamed = applyCanvasMenuAction(
    f.state,
    { ...items.find((i) => i.id === "rename"), value: "资料箱" },
    f,
  );
  assert.equal(renamed.objects.find((o) => o.id === "dock").title, "资料箱");
  const retained = applyCanvasMenuAction(
    renamed,
    items.find((i) => i.id === "dissolve"),
    f,
  );
  assert.ok(retained.objects.some((o) => o.id === "dock"));
});
