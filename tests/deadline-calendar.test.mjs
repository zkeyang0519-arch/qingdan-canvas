import test from "node:test";
import assert from "node:assert/strict";
import * as calendar from "../src/canvas/deadline-calendar.js";
import * as arranged from "../src/canvas/arranged-model.js";
import {
  createWorkspace,
  createObject,
  makeBlock,
} from "../src/canvas/model.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";

const task = (id, dueAt, done = false) => ({
  key: id,
  note: { id: `note-${id}` },
  block: { ...makeBlock("同名任务"), id, dueAt, done },
  locked: false,
});

test("区间待办在月历覆盖整个日期区间，中间日期也能打开同一待办", () => {
  const item = task("range", "2026-10-29T15:59:00.000Z");
  item.block.dueStartAt = "2026-10-26T16:00:00.000Z";
  const [event] = calendar.deadlineEvents({ tasks: [item] });
  assert.equal(event.start, "2026-10-26T16:00:00.000Z");
  assert.equal(event.end, "2026-10-29T15:59:00.000Z");
  assert.equal(calendar.deadlineEventOnDay(event, "2026-10-28"), true);
  assert.equal(calendar.deadlineEventOnDay(event, "2026-10-30"), false);
});

test("仅将当前灵感板的有效未完成 DDL 映射为独立任务，时间相同仍保留", () => {
  const due = "2026-10-28T10:00:00.000Z";
  const page = {
    tasks: [
      task("b", due),
      task("a", due),
      task("done", due, true),
      task("none", null),
      task("bad", "invalid"),
    ],
  };
  const events = calendar.deadlineEvents(page, { now: 0 });
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
  assert.deepEqual(
    events.map((e) => e.extendedProps.blockId),
    ["a", "b"],
  );
  assert.ok(events.every((e) => e.start === due && e.allDay === false));
  assert.equal(calendar.deadlineEvents(null).length, 0);
  const all = calendar.deadlineEvents(page, { showCompleted: true, now: 0 });
  assert.equal(all.length, 3);
  assert.equal(all.at(-1).extendedProps.status, "done");
});

test("日期按本地时区分组，深夜 DDL 不截取 UTC 日期", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    assert.equal(
      calendar.localDayKey("2026-10-28T16:30:00.000Z"),
      "2026-10-29",
    );
    process.env.TZ = "America/Los_Angeles";
    assert.equal(
      calendar.localDayKey("2026-10-28T02:00:00.000Z"),
      "2026-10-27",
    );
    assert.equal(calendar.localDayKey("invalid"), "");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("月历偏好只在本机保存，切换项目与画布后仍保留", () => {
  const state = createWorkspace(),
    board = state.boards[0].id;
  const frame = createObject(board, "frame");
  state.objects.push(frame);
  const next = arranged.setArrangedView(state, board, "calendar");
  assert.equal(arranged.panePages(next, board).view, "calendar");
  assert.strictEqual(next.objects, state.objects);
  assert.deepEqual(prepareEdit(next), prepareEdit(state));
  const chosen = arranged.choosePanePage(next, board, "left", frame.id);
  assert.equal(arranged.panePages(chosen, board).view, "calendar");
  const returned = arranged.setSurface(
    arranged.setSurface(chosen, board, "canvas"),
    board,
    "arranged",
  );
  assert.equal(arranged.panePages(returned, board).view, "calendar");
  assert.strictEqual(arranged.setArrangedView(next, board, "invalid"), next);
});
