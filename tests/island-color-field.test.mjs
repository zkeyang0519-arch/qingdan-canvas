import test from "node:test";
import assert from "node:assert/strict";
import { createIslandColorField } from "../src/desktop/island-color-field.js";
import { defaultIslandAppearance } from "../src/desktop/island-appearance.js";
const profile = defaultIslandAppearance.profiles.glass;
const field = (extra = {}) =>
  createIslandColorField({
    width: 291,
    height: 48,
    radius: 26,
    profile,
    design: "glass",
    ...extra,
  });

test("玻璃与原版共享整个色块流动，关闭光学层后像素相同", () => {
  const original = field({ design: "flow" });
  const clear = field({ profile: { ...profile, glassStrength: 0 } });
  for (const phase of [0, 1, 3])
    assert.deepEqual(clear.render(phase), original.render(phase));
  const a = original.render(0),
    b = original.render(2);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) > 5) changed++;
  assert.ok(
    changed > original.width * original.height * 0.4,
    "whole color blocks move, not only a light sweep",
  );
});

test("增强玻璃主要作用于边缘，林间苔绿中心与小舱颜色保留", () => {
  const base = field({ design: "flow" }).render(0);
  const glass = field(),
    pixels = glass.render(0);
  const at = (x, y) => (y * glass.width + x) * 4;
  const difference = (i) =>
    Math.abs(pixels[i] - base[i]) +
    Math.abs(pixels[i + 1] - base[i + 1]) +
    Math.abs(pixels[i + 2] - base[i + 2]);
  assert.ok(difference(at(108, 1)) > difference(at(108, 24)) * 3);
  assert.ok(difference(at(108, 24)) < 15);
  const small = field({
    width: 74,
    height: 48,
    radius: 24,
    small: true,
    design: "flow",
  });
  assert.deepEqual(Array.from(small.render(2).slice(0, 3)), [203, 217, 191]);
  assert.deepEqual(small.render(0), small.render(3));
});

test("单色、八色、竖舱与放大尺寸均产生完整有限帧", () => {
  for (const [width, height, radius] of [
    [54, 84, 28],
    [54, 42, 22],
    [410, 64, 26],
    [900, 160, 26],
  ]) {
    for (const colors of [["#123456"], Array(8).fill("#abcdef")]) {
      const instance = field({
        width,
        height,
        radius,
        profile: { ...profile, colors },
      });
      const pixels = instance.render(1);
      assert.equal(pixels.length, instance.width * instance.height * 4);
      assert.ok(instance.width <= 216 && instance.height <= 86);
      for (let i = 0; i < pixels.length; i += 4) {
        assert.equal(pixels[i + 3], 255);
        assert.ok(pixels[i] > 0 && pixels[i + 1] > 0 && pixels[i + 2] > 0);
      }
    }
  }
});
