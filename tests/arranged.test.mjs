import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspace,
  createObject,
  makeBlock,
  collectObjects,
} from "../src/canvas/model.js";
import { todoPages } from "../src/canvas/todoPages.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";
import { undoChanges } from "../src/sync/replica.js";
import {
  panePages,
  choosePanePage,
  setSurface,
  createChecklistPage,
  appendPageObjects,
  editPageBlock,
  insertPageBlocks,
  deletePageTasks,
  clearCompletedPageTasks,
  takeOutToPage,
  writablePage,
} from "../src/canvas/arranged-model.js";

function fixture() {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const left = {
    ...createObject(boardId, "frame", { x: 100, y: 80 }),
    id: "left",
    title: "产品想法",
    fixedBounds: true,
    width: 600,
    height: 400,
  };
  const right = {
    ...createObject(boardId, "frame", { x: 900, y: 80 }),
    id: "right",
    title: "周末计划",
    fixedBounds: true,
    width: 600,
    height: 400,
  };
  const note = {
    ...createObject(boardId, "note", { x: 124, y: 128 }),
    id: "note",
    parentId: "left",
    noteKind: "checklist",
    blocks: [makeBlock("原待办"), makeBlock("另一条")],
    fixedHeight: true,
    height: 210,
  };
  note.blocks[0].remark = {
    text: "保留备注",
    updatedAt: new Date().toISOString(),
  };
  const dock = {
    ...createObject(boardId, "collection"),
    id: `${boardId}-root`,
  };
  return {
    state: { ...state, objects: [...state.objects, dock, left, right, note] },
    boardId,
    left,
    right,
    note,
  };
}
const pages = (f) => panePages(f.state, f.boardId);

test("两栏始终显示同一项目，切换标签只修改本机偏好", () => {
  const f = fixture();
  assert.equal(pages(f).left.id, "left");
  assert.equal(pages(f).right.id, "left");
  const next = choosePanePage(f.state, f.boardId, "left", "right");
  const selected = panePages(next, f.boardId);
  assert.equal(selected.left.id, "right");
  assert.equal(selected.right.id, "right");
  assert.strictEqual(next.objects, f.state.objects);
  assert.deepEqual(prepareEdit(next), prepareEdit(f.state));
});

test("服务器返回对象顺序变化时，标签顺序和当前项目保持稳定", () => {
  const f = fixture();
  f.left.createdAt = "2026-10-20T00:00:00.000Z";
  f.right.createdAt = "2026-10-21T00:00:00.000Z";
  const next = { ...f.state, objects: [...f.state.objects].reverse() };
  assert.equal(panePages(next, f.boardId).left.id, "left");
  assert.deepEqual(
    panePages(next, f.boardId).pages.map((p) => p.id),
    ["left", "right"],
  );
  const saved = setSurface(f.state, f.boardId, "arranged");
  assert.equal(saved.preferences.views[f.boardId].arranged.pageId, "left");
  assert.equal(panePages(saved, f.boardId).right.id, "left");
});

test("项目删除或收纳后两栏一起回退，只有一页仍有完成栏", () => {
  const f = fixture();
  let next = choosePanePage(f.state, f.boardId, "right", "right");
  next = collectObjects(
    next,
    ["right"],
    next.objects.find((o) => o.type === "collection").id,
  );
  assert.equal(panePages(next, f.boardId).left.id, "left");
  assert.equal(panePages(next, f.boardId).right.id, "left");
  assert.strictEqual(choosePanePage(next, f.boardId, "right", "missing"), next);
});

test("旧双栏偏好沿用当前操作项目，迁移和刷新不改变共享内容", () => {
  const f = fixture();
  f.state.preferences.views[f.boardId] = {
    arranged: { left: "left", right: "right", active: "right" },
  };
  assert.equal(panePages(f.state, f.boardId).left.id, "right");
  const migrated = setSurface(f.state, f.boardId, "arranged");
  assert.deepEqual(migrated.preferences.views[f.boardId].arranged, {
    pageId: "right",
    active: "right",
  });
  const restored = JSON.parse(JSON.stringify(migrated));
  assert.equal(panePages(restored, f.boardId).left.id, "right");
  assert.equal(panePages(restored, f.boardId).right.id, "right");
  assert.deepEqual(prepareEdit(migrated), prepareEdit(f.state));
});

test("切换排列模式不改变共享内容、画布位置、缩放或对象尺寸", () => {
  const f = fixture();
  f.state.preferences.views[f.boardId] = { x: 421, y: -39, scale: 1.25 };
  const next = setSurface(f.state, f.boardId, "arranged");
  assert.strictEqual(next.objects, f.state.objects);
  assert.equal(next.preferences.views[f.boardId].surface, "arranged");
  assert.equal(next.preferences.views[f.boardId].x, 421);
  assert.equal(next.preferences.views[f.boardId].scale, 1.25);
  assert.deepEqual(prepareEdit(next), prepareEdit(f.state));
  const restored = setSurface(next, f.boardId, "canvas");
  assert.equal(restored.preferences.views[f.boardId].y, -39);
  assert.equal(restored.objects.find((o) => o.id === "note").height, 210);
});

test("排列新建灵感板可以立即用作独立页面且不移动原内容", () => {
  const f = fixture();
  const next = createChecklistPage(f.state, f.boardId, "新的灵感");
  const created = next.objects.at(-1);
  assert.equal(created.title, "新的灵感");
  assert.equal(created.fixedBounds, true);
  assert.ok(created.x >= f.right.x + f.right.width);
  assert.ok(todoPages(next, f.boardId).some((p) => p.id === created.id));
  assert.strictEqual(
    next.objects.find((o) => o.id === f.note.id),
    f.note,
  );
});

test("添加到右栏只写入右灵感板，保留左栏和引用块的身份", () => {
  const f = fixture();
  const incoming = {
    ...createObject(f.boardId, "note"),
    blocks: [makeBlock("右栏新事项")],
  };
  const next = appendPageObjects(f.state, f.boardId, "right", [incoming]);
  const added = next.objects.find((o) => o.id === incoming.id);
  assert.equal(added.parentId, "right");
  assert.equal(added.blocks[0].id, incoming.blocks[0].id);
  assert.ok(added.x > f.right.x);
  assert.strictEqual(
    next.objects.find((o) => o.id === f.note.id),
    f.note,
  );
});

test("排列新增内容扩展固定灵感板边界而不移动原成员", () => {
  const f = fixture();
  const incoming = {
    ...createObject(f.boardId, "note"),
    blocks: [makeBlock("底部新事项")],
  };
  const next = appendPageObjects(f.state, f.boardId, "left", [incoming]);
  const frame = next.objects.find((o) => o.id === "left"),
    added = next.objects.find((o) => o.id === incoming.id);
  assert.ok(frame.y + frame.height >= added.y + added.height + 20);
  assert.equal(frame.x, f.left.x);
  assert.equal(frame.y, f.left.y);
  assert.strictEqual(
    next.objects.find((o) => o.id === f.note.id),
    f.note,
  );
});

test("已删除、已锁定和已收纳的页面不会接收延迟导入或编辑", () => {
  const f = fixture();
  const incoming = createObject(f.boardId, "image");
  assert.strictEqual(
    appendPageObjects(f.state, f.boardId, "missing", [incoming]),
    f.state,
  );
  const locked = {
    ...f.state,
    objects: f.state.objects.map((o) =>
      o.id === "left" ? { ...o, locked: true } : o,
    ),
  };
  assert.equal(writablePage(locked, f.boardId, "left"), null);
  assert.strictEqual(
    appendPageObjects(locked, f.boardId, "left", [incoming]),
    locked,
  );
  assert.strictEqual(
    editPageBlock(locked, f.boardId, "left", "note", f.note.blocks[0].id, [
      { type: "text", text: "错写" },
    ]),
    locked,
  );
  const archived = collectObjects(
    f.state,
    ["left"],
    f.state.objects.find((o) => o.type === "collection").id,
  );
  assert.strictEqual(
    appendPageObjects(archived, f.boardId, "left", [incoming]),
    archived,
  );
});

test("编辑行保留最新备注、完成状态和其他协作者新增的行", () => {
  const f = fixture(),
    key = f.note.blocks[0].id;
  const remote = makeBlock("协作者新行");
  const live = {
    ...f.state,
    objects: f.state.objects.map((o) =>
      o.id === "note"
        ? {
            ...o,
            blocks: o.blocks
              .map((b) =>
                b.id === key
                  ? {
                      ...b,
                      done: true,
                      remark: { text: "新的备注", updatedAt: 2 },
                    }
                  : b,
              )
              .concat(remote),
          }
        : o,
    ),
  };
  const next = editPageBlock(live, f.boardId, "left", "note", key, [
    { type: "text", text: "编辑正文" },
  ]);
  const blocks = next.objects.find((o) => o.id === "note").blocks;
  assert.equal(blocks[0].runs[0].text, "编辑正文");
  assert.equal(blocks[0].done, true);
  assert.equal(blocks[0].remark.text, "新的备注");
  assert.deepEqual(blocks.at(-1), remote);
  assert.strictEqual(
    editPageBlock(live, f.boardId, "right", "note", key, []),
    live,
  );
});

test("编辑器换行和多行粘贴保持原行 ID、备注及未编辑的行", () => {
  const f = fixture(),
    block = f.note.blocks[0],
    extra = [makeBlock("新一行"), makeBlock("新二行")];
  const next = insertPageBlocks(
    f.state,
    f.boardId,
    "left",
    "note",
    block.id,
    { ...block, runs: [{ type: "text", text: "首行" }] },
    extra,
  );
  const blocks = next.objects.find((o) => o.id === "note").blocks;
  assert.deepEqual(
    blocks.map((b) => b.id),
    [block.id, ...extra.map((b) => b.id), f.note.blocks[1].id],
  );
  assert.equal(blocks[0].remark.text, "保留备注");
});

test("删除排列选中行不会删除整张便签或另一栏，备注进入回收站", () => {
  const f = fixture();
  const next = deletePageTasks(f.state, f.boardId, "left", [
    f.note.blocks[0].id,
  ]);
  const note = next.objects.find((o) => o.id === "note");
  assert.deepEqual(note.blocks, [f.note.blocks[1]]);
  assert.equal(next.trash[0].task.block.remark.text, "保留备注");
  assert.strictEqual(
    deletePageTasks(f.state, f.boardId, "right", [f.note.blocks[0].id]),
    f.state,
  );
});

test("清空仅删除当前项目未锁定的已完成事项，保留未完成、其他项目和备注备份", () => {
  const f = fixture();
  f.note.blocks[0].done = true;
  const completed = {
    ...createObject(f.boardId, "note"),
    parentId: "left",
    blocks: [{ ...makeBlock("另一个已完成事项"), done: true }],
  };
  const other = {
    ...createObject(f.boardId, "note"),
    parentId: "right",
    blocks: [{ ...makeBlock("其他项目已完成"), done: true }],
  };
  const locked = {
    ...createObject(f.boardId, "note"),
    parentId: "left",
    locked: true,
    blocks: [{ ...makeBlock("锁定事项"), done: true }],
  };
  f.state.objects.push(completed, other, locked);
  const next = clearCompletedPageTasks(f.state, f.boardId, "left");
  assert.deepEqual(next.objects.find((o) => o.id === "note").blocks, [
    f.note.blocks[1],
  ]);
  assert.deepEqual(next.objects.find((o) => o.id === completed.id).blocks, []);
  assert.strictEqual(
    next.objects.find((o) => o.id === other.id),
    other,
  );
  assert.strictEqual(
    next.objects.find((o) => o.id === locked.id),
    locked,
  );
  assert.equal(next.trash.length, 2);
  assert.equal(
    next.trash.find((entry) => entry.task.block.id === f.note.blocks[0].id).task
      .block.remark.text,
    "保留备注",
  );
  assert.strictEqual(clearCompletedPageTasks(next, f.boardId, "left"), next);
});

test("清空在项目为空、已锁定、已收纳或已删除时不修改内容", () => {
  const f = fixture();
  assert.strictEqual(
    clearCompletedPageTasks(f.state, f.boardId, "left"),
    f.state,
  );
  assert.strictEqual(
    clearCompletedPageTasks(f.state, f.boardId, "right"),
    f.state,
  );
  assert.strictEqual(
    clearCompletedPageTasks(f.state, f.boardId, "missing"),
    f.state,
  );
  f.note.blocks[0].done = true;
  const locked = {
    ...f.state,
    objects: f.state.objects.map((o) =>
      o.id === "left" ? { ...o, locked: true } : o,
    ),
  };
  assert.strictEqual(
    clearCompletedPageTasks(locked, f.boardId, "left"),
    locked,
  );
  const archived = collectObjects(
    f.state,
    ["left"],
    f.state.objects.find((o) => o.type === "collection").id,
  );
  assert.strictEqual(
    clearCompletedPageTasks(archived, f.boardId, "left"),
    archived,
  );
});

test("批量清空可以一次撤销并保留协作者对未完成事项的后续修改", () => {
  const f = fixture();
  f.note.blocks[0].done = true;
  f.note.blocks.push({ ...makeBlock("另一个已完成事项"), done: true });
  const next = clearCompletedPageTasks(f.state, f.boardId, "left");
  assert.deepEqual(
    undoChanges(f.state.objects, next.objects, next.objects).find(
      (o) => o.id === "note",
    ).blocks,
    f.note.blocks,
  );
  const live = next.objects.map((o) =>
    o.id === "note"
      ? {
          ...o,
          blocks: o.blocks.map((b) => ({
            ...b,
            runs: [{ type: "text", text: "协作者更新" }],
          })),
        }
      : o,
  );
  const undone = undoChanges(f.state.objects, next.objects, live);
  const blocks = undone.find((o) => o.id === "note").blocks;
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.find((b) => b.id === f.note.blocks[0].id),
    f.note.blocks[0],
  );
  assert.equal(
    blocks.find((b) => b.id === f.note.blocks[1].id).runs[0].text,
    "协作者更新",
  );
  assert.deepEqual(
    blocks.find((b) => b.id === f.note.blocks[2].id),
    f.note.blocks[2],
  );
});

test("收纳后可以取出到指定栏，重新检查目的页面和来源锁", () => {
  const f = fixture(),
    dock = f.state.objects.find((o) => o.type === "collection");
  const archived = collectObjects(f.state, ["note"], dock.id);
  const next = takeOutToPage(archived, f.boardId, "right", "note");
  assert.equal(next.objects.find((o) => o.id === "note").parentId, "right");
  assert.equal(
    todoPages(next, f.boardId).find((p) => p.id === "right").tasks.length,
    2,
  );
  const locked = {
    ...archived,
    objects: archived.objects.map((o) =>
      o.id === dock.id ? { ...o, locked: true } : o,
    ),
  };
  assert.strictEqual(takeOutToPage(locked, f.boardId, "right", "note"), locked);
  assert.strictEqual(
    takeOutToPage(archived, f.boardId, "missing", "note"),
    archived,
  );
});
