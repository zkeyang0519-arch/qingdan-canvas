import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultIslandAppearance,
  islandAppearanceKey,
  legacyIslandAppearanceKey,
  normalizeIslandAppearance,
  patchIslandAppearance,
  activeIslandAppearance,
  loadIslandAppearance,
  saveIslandAppearance,
  islandAppearanceStyle,
} from "../src/desktop/island-appearance.js";

test("两版独立保存，读取不写入、旧版颜色与待办草稿不变", () => {
  const legacy = '{"color":"#83dce5","transparency":75}';
  const entries = new Map([
    [legacyIslandAppearanceKey, legacy],
    ["board-data", "existing-task"],
    ["input-draft", "未提交的输入"],
  ]);
  const writes = [];
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      entries.set(key, value);
    },
  };
  assert.deepEqual(loadIslandAppearance(storage), defaultIslandAppearance);
  assert.deepEqual(writes, []);
  let appearance = patchIslandAppearance(defaultIslandAppearance, {
    profile: { colors: ["#102030", "#ABCDEF"], smallColor: "#203040" },
  });
  appearance = patchIslandAppearance(appearance, {
    design: "flow",
    profile: { colors: ["#aabbcc"], cycle: 6, motion: false },
  });
  saveIslandAppearance(appearance, storage);
  const loaded = loadIslandAppearance(storage);
  assert.deepEqual(loaded.profiles.glass.colors, ["#102030", "#abcdef"]);
  assert.deepEqual(loaded.profiles.flow.colors, ["#aabbcc"]);
  assert.equal(activeIslandAppearance(loaded).cycle, 6);
  assert.equal(activeIslandAppearance(loaded).motion, false);
  const reset = patchIslandAppearance(loaded, {
    profile: defaultIslandAppearance.profiles.flow,
  });
  assert.deepEqual(reset.profiles.glass, loaded.profiles.glass);
  assert.deepEqual(reset.profiles.flow, defaultIslandAppearance.profiles.flow);
  assert.deepEqual(writes, [islandAppearanceKey]);
  assert.equal(entries.get(legacyIslandAppearanceKey), legacy);
  assert.equal(entries.get("board-data"), "existing-task");
  assert.equal(entries.get("input-draft"), "未提交的输入");
});

test("自定义调色边界与损坏配置安全回退，不接受任意 CSS", () => {
  assert.deepEqual(normalizeIslandAppearance(null), defaultIslandAppearance);
  for (const colors of [
    [],
    ["red", "#fff", "url(example)", {}, 12],
    "#123456",
  ]) {
    assert.deepEqual(
      patchIslandAppearance(null, { profile: { colors } }).profiles.glass
        .colors,
      defaultIslandAppearance.profiles.glass.colors,
    );
  }
  let value = patchIslandAppearance(null, {
    profile: {
      colors: Array(12).fill("#ABCDEF"),
      cycle: 100,
      glassStrength: -1,
    },
  });
  assert.equal(activeIslandAppearance(value).colors.length, 8);
  assert.equal(activeIslandAppearance(value).cycle, 12);
  assert.equal(activeIslandAppearance(value).glassStrength, 0);
  value = patchIslandAppearance(value, {
    profile: {
      cycle: NaN,
      glassStrength: Infinity,
      motion: "true",
      smallColor: "red",
    },
  });
  assert.equal(activeIslandAppearance(value).cycle, 9);
  assert.equal(activeIslandAppearance(value).glassStrength, 0.9);
  assert.equal(activeIslandAppearance(value).smallColor, "#cbd9bf");
  assert.equal(normalizeIslandAppearance({ design: "bad" }).design, "glass");
  for (const colors of [
    ["#000000"],
    ["#ffffff"],
    ["#777777"],
    ["#000000", "#ffffff"],
  ]) {
    assert.doesNotMatch(
      JSON.stringify(
        islandAppearanceStyle(
          patchIslandAppearance(null, { profile: { colors } }),
        ),
      ),
      /NaN|Infinity/,
    );
  }
  const contrasting = islandAppearanceStyle(
    patchIslandAppearance(null, {
      profile: { colors: ["#000000", "#ffffff"] },
    }),
  );
  assert.equal(contrasting["--island-summary-fill"], "#fcfbf7eb");
  assert.equal(
    islandAppearanceStyle(defaultIslandAppearance)["--island-summary-fill"],
    "transparent",
  );
});

test("损坏或不可用的外观存储抛出错误供 UI 反馈，不清空旧内容", () => {
  const writes = [];
  assert.throws(
    () =>
      loadIslandAppearance({
        getItem: () => "{bad json",
        setItem: (...args) => writes.push(args),
      }),
    SyntaxError,
  );
  assert.throws(
    () =>
      saveIslandAppearance(defaultIslandAppearance, {
        setItem: () => {
          throw Error("无法写入");
        },
      }),
    /无法写入/,
  );
  assert.deepEqual(writes, []);
});

test("四季草地独立记住速度、动态开关和小舱配色，兼容已保存的两款外观", () => {
  const old = {
    version: 2,
    design: "flow",
    profiles: { flow: { colors: ["#123456"], cycle: 6 } },
  };
  const normalized = normalizeIslandAppearance(old);
  assert.equal(normalized.design, "flow");
  assert.deepEqual(normalized.profiles.flow.colors, ["#123456"]);
  let next = patchIslandAppearance(normalized, {
    design: "meadow",
    profile: { scrollSpeed: 48, motion: false, smallColor: "#aabbcc" },
  });
  assert.equal(activeIslandAppearance(next).scrollSpeed, 48);
  assert.equal(activeIslandAppearance(next).motion, false);
  assert.deepEqual(next.profiles.flow, normalized.profiles.flow);
  next = patchIslandAppearance(next, { profile: { scrollSpeed: 300 } });
  assert.equal(activeIslandAppearance(next).scrollSpeed, 60);
  next = patchIslandAppearance(next, { profile: { scrollSpeed: NaN } });
  assert.equal(activeIslandAppearance(next).scrollSpeed, 24);
  next = patchIslandAppearance(next, {
    profile: defaultIslandAppearance.profiles.meadow,
  });
  assert.deepEqual(
    next.profiles.meadow,
    defaultIslandAppearance.profiles.meadow,
  );
  assert.deepEqual(next.profiles.flow, normalized.profiles.flow);
});
