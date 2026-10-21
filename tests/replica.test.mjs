import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeData,
  reconcile,
  changesFor,
  undoChanges,
} from "../src/sync/replica.js";

const object = {
  id: "n1",
  x: 10,
  y: 20,
  blocks: [
    { id: "b1", done: false, runs: [{ type: "text", text: "设计" }] },
    { id: "b2", done: false, runs: [{ type: "text", text: "开发" }] },
  ],
};
const rows = (data) => [{ id: data.id, revision: 1, deleted: false, data }];

const image = {
  id: "image",
  type: "image",
  assetId: "asset",
  x: 100,
  alt: "参考图",
};
const uploadedImage = {
  ...image,
  assetMetadata: { id: "asset", mime: "image/jpeg", byteLength: 1200 },
};

test("刚添加的图片在上传补全文件信息后仍可撤销，并可重做", () => {
  assert.deepEqual(undoChanges([], [image], [uploadedImage]), []);
  const redone = undoChanges([image], [], []);
  assert.equal(redone[0].assetId, image.assetId);
  assert.deepEqual(
    undoChanges([], redone, [
      { ...redone[0], assetMetadata: uploadedImage.assetMetadata },
    ]),
    [],
  );
});

test("图片上传后的真实协作修改仍会阻止撤销删除", () => {
  for (const patch of [
    { x: 200 },
    { alt: "他人修改的标题" },
    { assetId: "different-asset" },
  ]) {
    assert.throws(
      () => undoChanges([], [image], [{ ...uploadedImage, ...patch }]),
      /冲突/,
    );
  }
});

test("撤销图片移动时保留后来补充的文件信息", () => {
  const result = undoChanges(
    [image],
    [{ ...image, x: 200 }],
    [{ ...uploadedImage, x: 200 }],
  );
  assert.equal(result[0].x, 100);
  assert.deepEqual(result[0].assetMetadata, uploadedImage.assetMetadata);
});

test("不同成员修改同一清单不同事项时两项均保留", () => {
  const a = structuredClone(object),
    b = structuredClone(object);
  a.blocks[0].done = true;
  b.blocks[1].done = true;
  assert.deepEqual(
    mergeData(object, a, b).blocks.map((b) => b.done),
    [true, true],
  );
});
test("拖动和修改清单文字互不覆盖", () => {
  const a = { ...object, x: 100 },
    b = structuredClone(object);
  b.blocks[0].runs[0].text = "新设计";
  const merged = mergeData(object, a, b);
  assert.equal(merged.x, 100);
  assert.equal(merged.blocks[0].runs[0].text, "新设计");
});
test("同一文本并发更改明确冲突，输入不被修改", () => {
  const a = structuredClone(object),
    b = structuredClone(object);
  a.blocks[0].runs[0].text = "甲";
  b.blocks[0].runs[0].text = "乙";
  assert.throws(() => mergeData(object, a, b), { name: "ConflictError" });
  assert.equal(a.blocks[0].runs[0].text, "甲");
});
test("编辑与远端删除冲突，不能静默复活", () => {
  assert.throws(() => mergeData(object, { ...object, x: 30 }, null), /冲突/);
});
test("重传被确认的相同内容不会产生第二次更改", () => {
  const after = { ...object, x: 30 };
  const remote = [{ ...rows(after)[0], revision: 2 }];
  const objects = reconcile(rows(object), [after], remote);
  assert.deepEqual(changesFor(remote, objects), []);
});
test("删除发送墓碑和实际预期版本", () => {
  assert.deepEqual(changesFor(rows(object), []), [
    { id: "n1", expectedRevision: 1, data: null },
  ]);
});
test("撤销只反转自己的字段，保留别人的清单勾选", () => {
  const after = { ...object, x: 100 };
  const current = structuredClone(after);
  current.blocks[1].done = true;
  const result = undoChanges([object], [after], [current]);
  assert.equal(result[0].x, 10);
  assert.equal(result[0].blocks[1].done, true);
});
test("撤销同字段的后续他人更改时拒绝覆盖", () => {
  assert.throws(
    () =>
      undoChanges([object], [{ ...object, x: 100 }], [{ ...object, x: 200 }]),
    /冲突/,
  );
});
test("并发新增不同事项和不同对象保留", () => {
  const a = {
    ...object,
    blocks: [...object.blocks, { id: "b3", done: false }],
  };
  const b = {
    ...object,
    blocks: [...object.blocks, { id: "b4", done: false }],
  };
  assert.equal(mergeData(object, a, b).blocks.length, 4);
  assert.equal(reconcile([], [{ id: "a" }], rows({ id: "b" })).length, 2);
});
