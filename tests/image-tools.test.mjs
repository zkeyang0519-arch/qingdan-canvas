import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/canvas/model.js";
import { exportArchive, importArchive } from "../src/canvas/backup.js";
const images = await import("../src/canvas/images.js").catch(() => ({}));

test("annotation coordinates invert cropped, rotated and flipped image coordinates", () => {
  assert.equal(typeof images.sourcePoint, "function");
  const { image } = fixture();
  Object.assign(image, {
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    rotation: 90,
    flipX: true,
  });
  const frame = images.imageFrame(image);
  assert.deepEqual([frame.width, frame.height], [220, 320]);
  const point = images.sourcePoint(image, { x: 0.3, y: 0.1 });
  assert.ok(Math.abs(point.x - 0.3) < 1e-10);
  assert.ok(Math.abs(point.y - 0.4) < 1e-10);
});

test("horizontal flip mirrors the displayed image after every rotation", () => {
  const { image } = fixture();
  for (const rotation of [0, 90, 180, 270]) {
    const before = { ...image, rotation, flipX: false };
    const after = { ...before, flipX: true };
    const point = images.sourcePoint(before, { x: 0.2, y: 0.7 });
    const mirrored = images.sourcePoint(after, { x: 0.8, y: 0.7 });
    assert.ok(
      Math.abs(point.x - mirrored.x) < 1e-10 &&
        Math.abs(point.y - mirrored.y) < 1e-10,
      `screen-horizontal flip at ${rotation} degrees`,
    );
  }
});
test("rotate preserves displayed image scale and crop restore never replaces the original asset", () => {
  assert.equal(typeof images.imageTransformPatch, "function");
  const { image } = fixture();
  const rotated = {
    ...image,
    ...images.imageTransformPatch(image, { rotation: 90 }),
  };
  assert.equal(rotated.width, 220);
  assert.equal(rotated.height, 320);
  const cropped = {
    ...image,
    ...images.imageTransformPatch(image, {
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    }),
  };
  assert.equal(cropped.width, 160);
  assert.equal(cropped.height, 110);
  const restored = {
    ...cropped,
    ...images.imageTransformPatch(cropped, { crop: null }),
  };
  assert.equal(restored.width, 320);
  assert.equal(restored.height, 220);
  assert.equal(restored.assetId, image.assetId);
});
test("image SVG escapes annotation text and old images render without edit fields", () => {
  assert.equal(typeof images.imageSvg, "function");
  const { image } = fixture();
  delete image.annotations;
  delete image.crop;
  delete image.rotation;
  delete image.flipX;
  assert.match(
    images.imageSvg(image, "blob:original"),
    /viewBox="0 0 640 440"/,
  );
  image.annotations = [
    {
      id: "text",
      kind: "text",
      points: [{ x: 0.1, y: 0.2 }],
      text: "<script>你好</script>",
      color: "#b47646",
    },
  ];
  const svg = images.imageSvg(image, "blob:original");
  assert.ok(svg.includes("&lt;script&gt;你好&lt;/script&gt;"));
  assert.ok(!svg.includes("<script>"));
});

function fixture() {
  const state = model.createWorkspace();
  const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
    type: "image/svg+xml",
  });
  const image = {
    ...model.createObject(state.boards[0].id, "image"),
    assetId: "asset-image",
    alt: "山景",
    naturalWidth: 640,
    naturalHeight: 440,
    width: 320,
    height: 220,
  };
  state.objects = [image];
  state.assets[image.assetId] = {
    id: image.assetId,
    mime: blob.type,
    byteLength: blob.size,
    name: "landscape.svg",
  };
  return { state, image, assets: new Map([[image.assetId, blob]]) };
}

test("invalid crop is rejected before it can overwrite a saved workspace", () => {
  const { state, image } = fixture();
  image.crop = { x: 0.8, y: 0, width: 0.5, height: 1 };
  assert.throws(() => model.validateWorkspace(state), /裁剪/);
});
test("nonfinite annotation coordinates and unsafe annotation colors are rejected", () => {
  const { state, image } = fixture();
  image.annotations = [
    {
      id: "mark",
      kind: "arrow",
      points: [
        { x: NaN, y: 0.2 },
        { x: 0.4, y: 0.6 },
      ],
      color: "#b47646",
    },
  ];
  assert.throws(() => model.validateWorkspace(state), /标注/);
  image.annotations[0].points[0].x = 0.1;
  image.annotations[0].color = "url(https://invalid.test)";
  assert.throws(() => model.validateWorkspace(state), /标注/);
});
test("a linked note stays independent when its image moves and its reference survives duplication", () => {
  const { state, image } = fixture();
  assert.equal(typeof model.createImageNote, "function");
  const linked = model.createImageNote(state, image.id),
    note = linked.objects.at(-1);
  assert.equal(note.type, "note");
  assert.equal(note.parentId, null);
  assert.equal(note.blocks[0].runs[0].targetId, image.id);
  const moved = model.moveObjects(linked, [image.id], { x: 80, y: 120 });
  assert.equal(moved.objects.find((o) => o.id === note.id).x, note.x);
  assert.equal(moved.objects.find((o) => o.id === note.id).y, note.y);
  const copied = model.duplicateObjects(linked, [image.id, note.id]);
  const newImage = copied.objects.find(
    (o) => o.type === "image" && o.id !== image.id,
  );
  const newNote = copied.objects.find(
    (o) => o.type === "note" && o.id !== note.id,
  );
  assert.equal(newNote.blocks[0].runs[0].targetId, newImage.id);
});
test("image edits and original asset survive archive export and import", async () => {
  const { state, image, assets } = fixture();
  image.crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  image.rotation = 90;
  image.flipX = true;
  image.annotations = [
    {
      id: "mark",
      kind: "text",
      points: [{ x: 0.3, y: 0.4 }],
      text: "暖色 <保留>",
      color: "#b47646",
    },
  ];
  const restored = await importArchive(await exportArchive(state, assets));
  assert.deepEqual(restored.state.objects[0], image);
  assert.equal(
    await restored.assets.get(image.assetId).text(),
    await assets.get(image.assetId).text(),
  );
});
