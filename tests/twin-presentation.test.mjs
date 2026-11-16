import test from "node:test";
import assert from "node:assert/strict";
import { twinTime } from "../src/island/twin-presentation.js";

test("时间仓使用当前待办的本地截止时间，跨月明天、数量和空态正确", () => {
  const now = new Date(2026, 10, 30, 10, 0);
  const task = (due) => ({ block: { dueAt: due } });
  assert.equal(
    twinTime(task(new Date(2026, 10, 30, 14, 30).toISOString()), 3, now).label,
    "今天",
  );
  const tomorrow = twinTime(
    task(new Date(2026, 11, 1, 9, 5).toISOString()),
    3,
    now,
  );
  assert.equal(tomorrow.label, "明天");
  assert.equal(tomorrow.value, "09:05");
  assert.equal(
    twinTime(task(new Date(2026, 10, 28, 14, 30).toISOString()), 3, now).label,
    "11/28",
  );
  for (const missing of [undefined, "bad", "2026-11-30"])
    assert.deepEqual(twinTime(task(missing), 3, now), {
      kind: "count",
      label: "剩余",
      value: "3 项",
      title: "还有 3 项待办",
    });
  assert.equal(twinTime(undefined, 0, now).value, "已清空");
});
