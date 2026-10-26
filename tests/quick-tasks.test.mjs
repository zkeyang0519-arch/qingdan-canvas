import test from "node:test";
import assert from "node:assert/strict";
import {
  addQuickTask,
  loadQuickTasks,
  removeQuickTask,
  serializeQuickTasks,
} from "../src/canvas/quickTasks.js";

function storage(initial = null) {
  let value = initial;
  return {
    getItem() {
      return value;
    },
    setItem(_key, next) {
      value = next;
    },
    value() {
      return value;
    },
  };
}

test("常用清单库读取损坏数据时回到空列表，并可保存规范化模板", () => {
  const target = storage("not-json");
  assert.deepEqual(loadQuickTasks("alice", target), []);
  const saved = addQuickTask([], "  中午 12 点吃饭  ", {
    id: "quick-1",
    createdAt: "2026-10-26T00:00:00.000Z",
  });
  assert.deepEqual(saved, [
    {
      id: "quick-1",
      text: "中午 12 点吃饭",
      createdAt: "2026-10-26T00:00:00.000Z",
    },
  ]);
  target.setItem("qingdan.quick-tasks:alice", serializeQuickTasks(saved));
  assert.deepEqual(loadQuickTasks("alice", target), saved);
});

test("常用清单库拒绝空模板并支持删除，保存失败不阻塞当前操作", () => {
  const initial = [
    { id: "one", text: "喝水", createdAt: "2026-10-26T00:00:00.000Z" },
    { id: "two", text: "拉伸", createdAt: "2026-10-26T00:01:00.000Z" },
  ];
  assert.equal(addQuickTask(initial, "   "), initial);
  assert.deepEqual(removeQuickTask(initial, "one"), [initial[1]]);
  assert.equal(removeQuickTask(initial, "missing"), initial);
  const broken = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota");
    },
  };
  assert.doesNotThrow(() => loadQuickTasks("alice", broken));
});
