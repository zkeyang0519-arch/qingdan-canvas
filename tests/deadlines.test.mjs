import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspace,
  createObject,
  makeBlock,
  validateWorkspace,
} from "../src/canvas/model.js";
import { sharedObject } from "../shared/canvas-contract.js";
import { prepareEdit } from "../src/sync/workspace-changes.js";
import { mergeData, undoChanges } from "../src/sync/replica.js";
import * as deadlines from "../shared/deadline.js";
import * as arranged from "../src/canvas/arranged-model.js";
import { todoPages } from "../src/canvas/todoPages.js";
import * as selection from "../src/canvas/deadlineInput.js";

const dueAt = "2026-10-22T02:00:00.000Z";
function fixture() {
  const state = createWorkspace();
  const note = {
    ...createObject(state.boards[0].id, "note"),
    blocks: [makeBlock("提交设计"), makeBlock("整理资料")],
  };
  state.objects = [note];
  return { state, note };
}

test("每条截止时间经过共享清理和备份读取后仍然保留", () => {
  const { state, note } = fixture();
  note.blocks[0].dueAt = dueAt;
  note.blocks[1].dueAt = null;
  const shared = prepareEdit(state)[0];
  assert.equal(shared.blocks[0].dueAt, dueAt);
  assert.equal(shared.blocks[1].dueAt, null);
  const restored = validateWorkspace(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.objects[0].blocks[0].dueAt, dueAt);
});

test("没有截止时间的旧待办仍然有效", () => {
  const { state, note } = fixture();
  assert.equal(sharedObject(note).blocks[0].dueAt, undefined);
  assert.doesNotThrow(() => validateWorkspace(state));
});

test("服务器和备份都拒绝无效日期、含糊的时区和非日期截止时间", () => {
  for (const value of [
    "",
    "tomorrow",
    0,
    {},
    "2026-02-30T02:00:00.000Z",
    "2026-10-22T10:00",
    "2026-10-22",
  ]) {
    const { state, note } = fixture();
    note.blocks[0].dueAt = value;
    assert.throws(() => sharedObject(note), undefined, String(value));
    assert.throws(() => validateWorkspace(state), undefined, String(value));
  }
});

test("设置截止时间与协作者编辑正文和完成事项能够合并，撤销只撤销截止时间", () => {
  const { state } = fixture();
  const base = prepareEdit(state)[0];
  const changed = structuredClone(state);
  changed.objects[0].blocks[0].dueAt = dueAt;
  const local = prepareEdit(changed)[0];
  const remote = structuredClone(base);
  remote.blocks[0].runs[0].text = "协作者补充正文";
  remote.blocks[0].done = true;
  remote.blocks[0].completedAt = "2026-10-21T12:00:00.000Z";
  const merged = mergeData(base, local, remote);
  assert.equal(merged.blocks[0].dueAt, dueAt);
  assert.equal(merged.blocks[0].runs[0].text, "协作者补充正文");
  assert.equal(merged.blocks[0].done, true);
  const undone = undoChanges([base], [local], [merged])[0];
  assert.equal(undone.blocks[0].dueAt, undefined);
  assert.equal(undone.blocks[0].done, true);
  assert.equal(undone.blocks[0].runs[0].text, "协作者补充正文");
});

test("同时修改同一截止时间会提示冲突，不会静默覆盖", () => {
  const { state, note } = fixture();
  note.blocks[0].dueAt = dueAt;
  const base = prepareEdit(state)[0];
  const local = structuredClone(state),
    remote = structuredClone(state);
  local.objects[0].blocks[0].dueAt = "2026-10-23T02:00:00.000Z";
  remote.objects[0].blocks[0].dueAt = null;
  assert.throws(
    () => mergeData(base, prepareEdit(local)[0], prepareEdit(remote)[0]),
    /冲突/,
  );
});

test("截止前24小时开始提醒，到时切换超时，完成后的待办不再提醒", () => {
  const end = Date.parse(dueAt);
  const block = { dueAt, done: false };
  assert.equal(deadlines.deadlineInfo(block, end - 86400001).status, "normal");
  assert.equal(deadlines.deadlineInfo(block, end - 86400000).status, "urgent");
  const twoHours = deadlines.deadlineInfo(block, end - 7200000);
  assert.equal(twoHours.status, "urgent");
  assert.equal(twoHours.ratio, 1 / 12);
  assert.equal(twoHours.compact, "2h");
  assert.equal(deadlines.deadlineInfo(block, end).status, "late");
  assert.equal(
    deadlines.deadlineInfo(block, end + 7200000).relative,
    "已超时 2 小时",
  );
  assert.equal(
    deadlines.deadlineInfo({ ...block, done: true }, end + 7200000).status,
    "done",
  );
  assert.equal(deadlines.deadlineInfo({ done: false }, end).status, "none");
});

test("时间按天小时分钟显示，不会把未到一分钟错误显示为零", () => {
  const end = Date.parse(dueAt);
  const block = { dueAt };
  assert.equal(
    deadlines.deadlineInfo(block, end - 30000).relative,
    "剩余不足 1 分钟",
  );
  assert.equal(
    deadlines.deadlineInfo(block, end + 30000).relative,
    "已超时不足 1 分钟",
  );
  assert.equal(
    deadlines.deadlineInfo(block, end + 90060000).relative,
    "已超时 1 天 1 小时 1 分钟",
  );
  assert.equal(deadlines.deadlineInfo(block, end - 172800000).compact, "2天");
});

test("日期输入按本机时区转换，重开时还原且拒绝不存在的日期", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(deadlines.parseDeadlineInput("2026-10-22T10:00"), dueAt);
    assert.equal(deadlines.deadlineInputValue(dueAt), "2026-10-22T10:00");
    assert.equal(deadlines.deadlineInputValue(null), "");
    for (const invalid of [
      "",
      "2026-02-30T10:00",
      "2026-10-22T25:00",
      "invalid",
    ])
      assert.throws(() => deadlines.parseDeadlineInput(invalid));
    process.env.TZ = "America/New_York";
    assert.throws(() => deadlines.parseDeadlineInput("2026-03-08T02:30"));
    assert.equal(
      deadlines.deadlineInputValue(
        deadlines.parseDeadlineInput("2026-10-22T10:00"),
      ),
      "2026-10-22T10:00",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("提醒时钟会在跨入24小时和刚超时的边界刷新", () => {
  const end = Date.parse(dueAt);
  assert.equal(deadlines.nextDeadlineTick([end], end - 86400100), 100);
  assert.equal(deadlines.nextDeadlineTick([end], end - 500), 500);
  assert.equal(deadlines.nextDeadlineTick([end], end), 30000);
});

test("切换截止月份和年份会限制日期，处理大小月与闰年并保留时间", () => {
  const january = { year: 2028, month: 1, day: 31, hour: 22, minute: 5 };
  const preserved = selection.updateDeadlineSelection(
    { ...january, day: 15 },
    "month",
    2,
  );
  assert.equal(preserved.day, 15);
  const february = selection.updateDeadlineSelection(january, "month", 2);
  assert.deepEqual(february, { ...january, month: 2, day: 29 });
  assert.equal(selection.deadlineMonthDays(february), 29);
  assert.equal(
    selection.updateDeadlineSelection(february, "year", 2027).day,
    28,
  );
  assert.equal(selection.updateDeadlineSelection(january, "month", 4).day, 30);
  assert.equal(selection.deadlineMonthDays({ year: 2100, month: 2 }), 28);
  assert.equal(selection.deadlineMonthDays({ year: 2000, month: 2 }), 29);
  assert.equal(january.day, 31);
});

test("截止选择器按本地时间回显，支持零点和逐分钟选择，新设置默认当天23:59", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const parts = selection.deadlineSelection("2026-10-21T16:05:00.000Z");
    assert.deepEqual(parts, {
      year: 2026,
      month: 10,
      day: 22,
      hour: 0,
      minute: 5,
    });
    assert.equal(
      deadlines.parseDeadlineInput(selection.deadlineSelectionValue(parts)),
      "2026-10-21T16:05:00.000Z",
    );
    const midnight = selection.updateDeadlineSelection(parts, "minute", 0);
    assert.equal(
      selection.deadlineSelectionValue(midnight),
      "2026-10-22T00:00",
    );
    const fresh = selection.deadlineSelection(
      null,
      Date.parse("2026-12-31T16:01:00.000Z"),
    );
    assert.equal(selection.deadlineSelectionValue(fresh), "2027-01-01T23:59");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("截止时间滚轮只生成小时和分钟两列", () => {
  const fields = selection.deadlineWheelFields();
  assert.deepEqual(
    fields.map(({ key, label }) => ({ key, label })),
    [
      { key: "hour", label: "时" },
      { key: "minute", label: "分" },
    ],
  );
  assert.deepEqual(
    fields[0].options,
    Array.from({ length: 24 }, (_, i) => i),
  );
  assert.deepEqual(
    fields[1].options,
    Array.from({ length: 60 }, (_, i) => i),
  );
  assert.equal(fields[0].format(0), "00");
  assert.equal(fields[1].format(59), "59");
});

test("日历日期与时分独立，选新日期保留时分且早期年份不偏移到1900年", () => {
  const parts = { year: 2028, month: 2, day: 29, hour: 0, minute: 59 };
  const date = selection.deadlineCalendarDate(parts);
  assert.equal(date.getFullYear(), 2028);
  assert.equal(date.getMonth(), 1);
  assert.equal(date.getDate(), 29);
  const selected = new Date(2028, 2, 1);
  assert.deepEqual(selection.selectDeadlineDate(parts, selected), {
    ...parts,
    month: 3,
    day: 1,
  });
  assert.equal(
    selection.deadlineCalendarDate({ ...parts, year: 4 }).getFullYear(),
    4,
  );
});

test("上下放不下的弹层改从侧面展开，窄屏沿用可滚动的上下布局", () => {
  const panel = { width: 340, height: 650 };
  assert.equal(
    selection.deadlinePopoverSide(
      { left: 490, right: 530, top: 280, bottom: 320 },
      panel,
      { width: 1160, height: 884 },
    ),
    "right",
  );
  assert.equal(
    selection.deadlinePopoverSide(
      { left: 960, right: 1000, top: 280, bottom: 320 },
      panel,
      { width: 1160, height: 884 },
    ),
    "left",
  );
  assert.equal(
    selection.deadlinePopoverSide(
      { left: 300, right: 340, top: 280, bottom: 320 },
      panel,
      { width: 375, height: 667 },
    ),
    "bottom",
  );
  assert.equal(
    selection.deadlinePopoverSide(
      { left: 490, right: 530, top: 100, bottom: 140 },
      panel,
      { width: 1160, height: 884 },
    ),
    "bottom",
  );
});

test("设置和移除截止时间保留其他行、正文、备注和完成状态", () => {
  const { state, note } = fixture();
  const pageId = todoPages(state, state.boards[0].id)[0].id;
  note.blocks[0].remark = { text: "协作者的备注", updatedAt: dueAt };
  const next = arranged.setPageDeadline(
    state,
    state.boards[0].id,
    pageId,
    note.id,
    note.blocks[0].id,
    dueAt,
    null,
  );
  assert.equal(next.objects[0].blocks[0].dueAt, dueAt);
  assert.equal(next.objects[0].blocks[0].remark.text, "协作者的备注");
  assert.strictEqual(next.objects[0].blocks[1], note.blocks[1]);
  const cleared = arranged.setPageDeadline(
    next,
    state.boards[0].id,
    pageId,
    note.id,
    note.blocks[0].id,
    null,
    dueAt,
  );
  assert.equal(cleared.objects[0].blocks[0].dueAt, null);
  assert.equal(cleared.objects[0].blocks[0].done, false);
});

test("截止弹窗打开后协作者修改了时间，旧弹窗不能覆盖它；锁定或移走的事项也不接收修改", () => {
  const { state, note } = fixture();
  const board = state.boards[0].id,
    pageId = todoPages(state, board)[0].id,
    key = note.blocks[0].id;
  note.blocks[0].dueAt = dueAt;
  assert.strictEqual(
    arranged.setPageDeadline(state, board, pageId, note.id, key, null, null),
    state,
  );
  note.locked = true;
  assert.strictEqual(
    arranged.setPageDeadline(state, board, pageId, note.id, key, null, dueAt),
    state,
  );
  note.locked = false;
  assert.strictEqual(
    arranged.setPageDeadline(
      state,
      board,
      "missing",
      note.id,
      key,
      null,
      dueAt,
    ),
    state,
  );
  assert.strictEqual(
    arranged.setPageDeadline(
      state,
      board,
      pageId,
      note.id,
      key,
      "invalid",
      dueAt,
    ),
    state,
  );
});
