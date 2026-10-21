import test from "node:test";
import assert from "node:assert/strict";
import {
  projectObjects,
  transactionBaseAfterRemote,
  prepareEdit,
  assetIdsToHydrate,
} from "../src/sync/workspace-changes.js";
import {
  createObject,
  createWorkspace,
  makeBlock,
  deleteObjects,
} from "../src/canvas/model.js";
import { undoChanges } from "../src/sync/replica.js";
test("旧拖拽快照不覆盖另一成员刚改的便签，拖回原点也正确", () => {
  const base = [
    { id: "a", x: 0 },
    { id: "b", text: "旧" },
  ];
  const first = [{ id: "a", x: 10 }, base[1]];
  const current = [first[0], { id: "b", text: "他人新文字" }];
  const next = projectObjects(first, [{ id: "a", x: 20 }, base[1]], current);
  assert.equal(next[1].text, "他人新文字");
  const back = projectObjects([{ id: "a", x: 20 }, base[1]], base, next);
  assert.equal(back[0].x, 0);
  assert.equal(back[1].text, "他人新文字");
});
test("编辑事务期间远端更改不会成为本地撤销内容", () => {
  const base = [
    { id: "a", x: 0 },
    { id: "b", text: "旧" },
  ];
  const local = [{ id: "a", x: 10 }, base[1]];
  const merged = [local[0], { id: "b", text: "远端新文字" }];
  const rebased = transactionBaseAfterRemote(base, local, merged);
  const undone = undoChanges(rebased, merged, merged);
  assert.equal(undone[0].x, 0);
  assert.equal(undone[1].text, "远端新文字");
});
test("超大文本在发布本地状态前被明确拒绝，原数据保持完整", () => {
  const s = createWorkspace(),
    board = s.boards[0].id;
  const note = {
    ...createObject(board, "note"),
    blocks: [makeBlock("a".repeat(256001))],
  };
  assert.throws(() => prepareEdit({ ...s, objects: [note] }), /过大/);
  assert.equal(s.objects.length, 0);
});
test("刷新后导出需要恢复回收站和资源表中的图片", () => {
  const s = createWorkspace(),
    board = s.boards[0].id;
  const image = {
    ...createObject(board, "image"),
    assetId: "img",
    naturalWidth: 1,
    naturalHeight: 1,
  };
  const withImage = {
    ...s,
    assets: { img: { id: "img", mime: "image/png", byteLength: 20 } },
    objects: [image],
  };
  const deleted = deleteObjects(withImage, [image.id]);
  assert.deepEqual(assetIdsToHydrate(deleted), ["img"]);
});

test("连续调整清单大小时自动测量高度不会阻断手势或覆盖文字", () => {
  const note = {
    ...createObject("board", "note"),
    noteKind: "checklist",
    height: 180,
    layoutHeight: 180,
    fixedHeight: true,
    blocks: [makeBlock("原文字")],
  };
  const measured = {
    ...note,
    layoutHeight: 260,
    blocks: [makeBlock("其他成员的新文字")],
  };
  const proposal = { ...note, width: 220, height: 160, layoutHeight: 160 };
  const [next] = projectObjects([note], [proposal], [measured]);
  assert.equal(next.width, 220);
  assert.equal(next.height, 160);
  assert.equal(next.fixedHeight, true);
  assert.equal(next.blocks[0].runs[0].text, "其他成员的新文字");
});

test("手动设定的清单高度模式在共享数据中保留", () => {
  const note = { ...createObject("board", "note"), fixedHeight: true };
  const [shared] = prepareEdit({ objects: [note] });
  assert.equal(shared.fixedHeight, true);
  assert.throws(
    () => prepareEdit({ objects: [{ ...note, fixedHeight: "true" }] }),
    /结构无效/,
  );
});

test("浏览器测量高度只用于本地布局，不发送到共享画布", () => {
  const note = { ...createObject("board", "note"), layoutHeight: 260 };
  const [shared] = prepareEdit({ objects: [note] });
  assert.equal(Object.hasOwn(shared, "layoutHeight"), false);
  assert.equal(note.layoutHeight, 260);
});
