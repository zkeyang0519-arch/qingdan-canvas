import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspace,
  createObject,
  makeBlock,
} from "../src/canvas/model.js";
import * as arranged from "../src/canvas/arranged-model.js";
import { sharedObject } from "../shared/canvas-contract.js";
import { mergeData, undoChanges } from "../src/sync/replica.js";

function fixture() {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const frame = { ...createObject(boardId, "frame"), id: "page" };
  const block = (id, dueAt) => ({
    ...makeBlock(id),
    id,
    ...(dueAt ? { dueAt } : {}),
  });
  const first = {
    ...createObject(boardId, "note"),
    id: "first",
    parentId: frame.id,
    createdAt: "2026-10-20T00:00:00.000Z",
    blocks: [
      block("no-date-a"),
      block("late", "2026-10-26T08:00:00.000Z"),
      {
        ...block("done", "2026-10-20T08:00:00.000Z"),
        done: true,
        completedAt: "2026-10-21T08:00:00.000Z",
      },
    ],
  };
  const second = {
    ...createObject(boardId, "note"),
    id: "second",
    parentId: frame.id,
    createdAt: "2026-10-21T00:00:00.000Z",
    blocks: [
      block("early-a", "2026-10-24T08:00:00.000Z"),
      block("no-date-b"),
      block("early-b", "2026-10-24T08:00:00.000Z"),
    ],
  };
  const other = {
    ...createObject(boardId, "note"),
    id: "other",
    blocks: [block("other-task")],
  };
  state.objects = [frame, first, second, other];
  return { state, boardId, frame, first, second, other };
}
const pending = (state, boardId) =>
  arranged
    .panePages(state, boardId)
    .pages.find((p) => p.id === "page")
    .tasks.filter((t) => !t.block.done)
    .map((t) => t.key);

test("DDL 排序跨便签按时间升序，无日期置底，同时间与无日期保留相对顺序", () => {
  assert.equal(typeof arranged.sortPendingPageTasks, "function");
  const f = fixture(),
    original = structuredClone(f.state);
  const next = arranged.sortPendingPageTasks(f.state, f.boardId, "page");
  assert.deepEqual(pending(next, f.boardId), [
    "early-a",
    "early-b",
    "late",
    "no-date-a",
    "no-date-b",
  ]);
  assert.deepEqual(f.state, original, "不直接修改原状态");
  assert.deepEqual(
    next.objects.find((o) => o.id === "first").blocks[2],
    f.first.blocks[2],
  );
  assert.strictEqual(
    next.objects.find((o) => o.id === "other"),
    f.other,
  );
  for (const before of f.state.objects) {
    const after = next.objects.find((o) => o.id === before.id);
    for (const field of ["x", "y", "width", "height", "parentId"])
      assert.equal(after[field], before[field], "只改排列顺序，不改画布布局");
    assert.deepEqual(
      after.blocks?.map((b) => b.id),
      before.blocks?.map((b) => b.id),
    );
  }
  assert.strictEqual(
    arranged.sortPendingPageTasks(next, f.boardId, "page"),
    next,
  );
  const restored = {
    ...next,
    objects: next.objects.map(sharedObject).reverse(),
  };
  assert.deepEqual(pending(restored, f.boardId), [
    "early-a",
    "early-b",
    "late",
    "no-date-a",
    "no-date-b",
  ]);
  const undone = {
    ...next,
    objects: undoChanges(f.state.objects, next.objects, next.objects),
  };
  assert.deepEqual(pending(undone, f.boardId), [
    "no-date-a",
    "late",
    "early-a",
    "no-date-b",
    "early-b",
  ]);
});

test("自动排序后能上下手动移动，修改 DDL 不自动重排，再次点击才排序", () => {
  assert.equal(typeof arranged.movePendingPageTask, "function");
  const f = fixture();
  const sorted = arranged.sortPendingPageTasks(f.state, f.boardId, "page");
  const movedUp = arranged.movePendingPageTask(
    sorted,
    f.boardId,
    "page",
    "no-date-b",
    "early-a",
    "before",
  );
  assert.deepEqual(pending(movedUp, f.boardId), [
    "no-date-b",
    "early-a",
    "early-b",
    "late",
    "no-date-a",
  ]);
  const movedDown = arranged.movePendingPageTask(
    movedUp,
    f.boardId,
    "page",
    "early-a",
    "late",
    "after",
  );
  assert.deepEqual(pending(movedDown, f.boardId), [
    "no-date-b",
    "early-b",
    "late",
    "early-a",
    "no-date-a",
  ]);
  const edited = arranged.setPageDeadline(
    movedDown,
    f.boardId,
    "page",
    "first",
    "late",
    "2026-10-23T08:00:00.000Z",
    "2026-10-26T08:00:00.000Z",
  );
  assert.deepEqual(pending(edited, f.boardId), pending(movedDown, f.boardId));
  assert.deepEqual(
    pending(
      arranged.sortPendingPageTasks(edited, f.boardId, "page"),
      f.boardId,
    ),
    ["late", "early-b", "early-a", "no-date-b", "no-date-a"],
  );
});

test("排序会重新检查页面、锁定与完成状态，拒绝过期拖动目标", () => {
  assert.equal(typeof arranged.movePendingPageTask, "function");
  const f = fixture();
  for (const state of [
    {
      ...f.state,
      objects: f.state.objects.map((o) =>
        o.id === "page" ? { ...o, locked: true } : o,
      ),
    },
    {
      ...f.state,
      objects: f.state.objects.map((o) =>
        o.id === "first" ? { ...o, locked: true } : o,
      ),
    },
  ]) {
    assert.strictEqual(
      arranged.sortPendingPageTasks(state, f.boardId, "page"),
      state,
    );
    assert.strictEqual(
      arranged.movePendingPageTask(
        state,
        f.boardId,
        "page",
        "early-a",
        "late",
        "before",
      ),
      state,
    );
  }
  for (const [source, target] of [
    ["done", "late"],
    ["early-a", "done"],
    ["gone", "late"],
    ["early-a", "other-task"],
    ["late", "late"],
  ])
    assert.strictEqual(
      arranged.movePendingPageTask(
        f.state,
        f.boardId,
        "page",
        source,
        target,
        "before",
      ),
      f.state,
    );
  assert.strictEqual(
    arranged.sortPendingPageTasks(f.state, f.boardId, "missing"),
    f.state,
  );
});

test("共享排序字段保留并校验，与协作者的备注变更独立合并", () => {
  const f = fixture(),
    local = structuredClone(f.first),
    remote = structuredClone(f.first);
  local.blocks[0].arrangedOrder = 4;
  const clean = sharedObject(local);
  assert.equal(clean.blocks[0].arrangedOrder, 4);
  remote.blocks[0].remark = {
    text: "协作者备注",
    updatedAt: "2026-10-23T08:00:00.000Z",
  };
  const merged = mergeData(f.first, clean, remote);
  assert.equal(merged.blocks[0].arrangedOrder, 4);
  assert.equal(merged.blocks[0].remark.text, "协作者备注");
  for (const invalid of [NaN, Infinity, -1, "1", null]) {
    local.blocks[0].arrangedOrder = invalid;
    assert.throws(() => sharedObject(local));
  }
});

test("排序后回车拆分待办仍紧跟原事项，不会跳到无日期待办之后", () => {
  const f = fixture();
  const sorted = arranged.sortPendingPageTasks(f.state, f.boardId, "page");
  const next = arranged.insertPageBlocks(
    sorted,
    f.boardId,
    "page",
    "second",
    "early-a",
    f.second.blocks[0],
    [{ ...makeBlock("插入项"), id: "inserted" }],
  );
  assert.deepEqual(pending(next, f.boardId), [
    "early-a",
    "inserted",
    "early-b",
    "late",
    "no-date-a",
    "no-date-b",
  ]);
});

test("手动排序只更新顺序实际变化的便签", () => {
  const f = fixture();
  const sorted = arranged.sortPendingPageTasks(f.state, f.boardId, "page");
  const next = arranged.movePendingPageTask(
    sorted,
    f.boardId,
    "page",
    "early-b",
    "early-a",
    "before",
  );
  assert.strictEqual(
    next.objects.find((o) => o.id === "first"),
    sorted.objects.find((o) => o.id === "first"),
  );
  assert.deepEqual(pending(next, f.boardId), [
    "early-b",
    "early-a",
    "late",
    "no-date-a",
    "no-date-b",
  ]);
});

test("其他待办被锁定时，仍能紧跟当前未锁定事项插入，且不改锁定便签", () => {
  const f = fixture();
  const sorted = arranged.sortPendingPageTasks(f.state, f.boardId, "page");
  const locked = {
    ...sorted,
    objects: sorted.objects.map((o) =>
      o.id === "first" ? { ...o, locked: true } : o,
    ),
  };
  const next = arranged.insertPageBlocks(
    locked,
    f.boardId,
    "page",
    "second",
    "early-a",
    f.second.blocks[0],
    [{ ...makeBlock("插入"), id: "inserted" }],
  );
  assert.deepEqual(pending(next, f.boardId), [
    "early-a",
    "inserted",
    "early-b",
    "late",
    "no-date-a",
    "no-date-b",
  ]);
  assert.strictEqual(
    next.objects.find((o) => o.id === "first"),
    locked.objects.find((o) => o.id === "first"),
  );
});

test("超过同步上限的排序在应用前明确拒绝，不留下无法同步的顺序", () => {
  const f = fixture();
  f.state.objects = [
    f.frame,
    ...Array.from({ length: 201 }, (_, i) => ({
      ...createObject(f.boardId, "note"),
      id: `note-${String(i).padStart(3, "0")}`,
      createdAt: "2026-10-20T00:00:00.000Z",
      parentId: "page",
      blocks: [
        {
          ...makeBlock(String(i)),
          id: `task-${i}`,
          dueAt: new Date(Date.UTC(2026, 10, 1, 0, 201 - i)).toISOString(),
        },
      ],
    })),
  ];
  const before = structuredClone(f.state);
  assert.throws(
    () => arranged.sortPendingPageTasks(f.state, f.boardId, "page"),
    /200/,
  );
  assert.deepEqual(f.state, before);
});
