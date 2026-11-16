import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultIslandAppearance,
  islandAppearanceKey,
  normalizeIslandAppearance,
  loadIslandAppearance,
  saveIslandAppearance,
  islandAppearanceStyle,
} from "../src/desktop/island-appearance.js";

test("外观读取不写入存储，保存只覆盖独立外观键", () => {
  const entries = new Map([
    ["board-data", '{"objects":["existing-task"]}'],
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
  saveIslandAppearance({ color: "#83DCE5", transparency: 84 }, storage);
  assert.deepEqual(loadIslandAppearance(storage), {
    color: "#83dce5",
    transparency: 84,
  });
  assert.deepEqual(writes, [islandAppearanceKey]);
  assert.equal(entries.get("board-data"), '{"objects":["existing-task"]}');
  assert.equal(entries.get("input-draft"), "未提交的输入");
});

test("外观非法或越界值安全回退，不接受任意 CSS", () => {
  assert.deepEqual(normalizeIslandAppearance(null), defaultIslandAppearance);
  for (const color of ["red", "#fff", "url(example)", {}, 12]) {
    assert.equal(
      normalizeIslandAppearance({ color }).color,
      defaultIslandAppearance.color,
    );
  }
  for (const transparency of [NaN, Infinity, "80", null]) {
    assert.equal(normalizeIslandAppearance({ transparency }).transparency, 70);
  }
  assert.equal(
    normalizeIslandAppearance({ transparency: -20 }).transparency,
    0,
  );
  assert.equal(
    normalizeIslandAppearance({ transparency: 120 }).transparency,
    100,
  );
  assert.equal(
    normalizeIslandAppearance({ transparency: 71.8 }).transparency,
    72,
  );
  assert.equal(
    islandAppearanceStyle({ color: "#53c7c2", transparency: 0 })[
      "--island-glass-alpha"
    ],
    "1.00",
  );
  assert.equal(
    islandAppearanceStyle({ color: "#53c7c2", transparency: 100 })[
      "--island-glass-alpha"
    ],
    "0.00",
  );
  for (const color of ["#000000", "#ffffff", "#777777"]) {
    assert.doesNotMatch(
      JSON.stringify(islandAppearanceStyle({ color })),
      /NaN|Infinity/,
    );
  }
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
