import test from "node:test";
import assert from "node:assert/strict";
import {
  inputDraftKey,
  loadInputDrafts,
  saveInputDrafts,
} from "../src/desktop/input-drafts.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("desktop drafts survive a new reader with origin/account/room/project isolation", () => {
  const disk = storage();
  const key = inputDraftKey("https://todo.zky.lol", "user-1", "room-1");
  saveInputDrafts(
    key,
    { "project-1": "未提交\n第二行", "project-2": "另一个项目" },
    disk,
  );
  assert.deepEqual(loadInputDrafts(key, disk), {
    "project-1": "未提交\n第二行",
    "project-2": "另一个项目",
  });
  for (const tuple of [
    ["http://127.0.0.1:8788", "user-1", "room-1"],
    ["https://todo.zky.lol", "user-2", "room-1"],
    ["https://todo.zky.lol", "user-1", "room-2"],
  ])
    assert.deepEqual(loadInputDrafts(inputDraftKey(...tuple), disk), {});
});

test("bad or unavailable storage cannot masquerade as saved drafts", () => {
  const disk = storage();
  disk.setItem("key", "broken JSON");
  assert.throws(() => loadInputDrafts("key", disk));
  assert.equal(disk.getItem("key"), "broken JSON");
  assert.throws(
    () =>
      saveInputDrafts(
        "key",
        { p: "text" },
        {
          setItem() {},
          getItem() {
            return null;
          },
        },
      ),
    /未能确认/,
  );
  assert.throws(() => saveInputDrafts("key", { p: 42 }, disk), /格式不正确/);
});
