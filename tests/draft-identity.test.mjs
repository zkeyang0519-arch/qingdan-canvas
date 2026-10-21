import test from "node:test";
import assert from "node:assert/strict";
import { claimDraftIdentity } from "../src/sync/drafts.js";
test("复制标签页时草稿标识分离，原标签关闭后可恢复同一标识", async () => {
  const held = new Set();
  const locks = {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  const a = await claimDraftIdentity("room", "same-tab", locks);
  const b = await claimDraftIdentity("room", "same-tab", locks);
  assert.notEqual(a.id, b.id);
  a.release();
  b.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const c = await claimDraftIdentity("room", "same-tab", locks);
  assert.equal(c.id, "same-tab");
  c.release();
});
