import test from "node:test";
import assert from "node:assert/strict";
import { prepareImageFile } from "../src/canvas/image-import.js";

test("按真实文件签名识别图片，避免错误扩展名阻塞共享上传", async () => {
  const bytes = new Uint8Array([
    255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1,
  ]);
  const file = new File([bytes], "误标的图片.png", { type: "image/png" });
  const prepared = await prepareImageFile(file);
  assert.equal(prepared.type, "image/jpeg");
  assert.equal(prepared.name, file.name);
  assert.deepEqual(new Uint8Array(await prepared.arrayBuffer()), bytes);
});

test("合法 PNG 保留原文件，非图片内容在写入画布之前拒绝", async () => {
  const file = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    "测试.png",
    { type: "image/png" },
  );
  assert.strictEqual(await prepareImageFile(file), file);
  await assert.rejects(
    prepareImageFile(
      new File(["<svg></svg>"], "伪装.png", { type: "image/png" }),
    ),
    /无法识别/,
  );
});
