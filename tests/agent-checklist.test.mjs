import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";

const engine = (async () => {
  const { outputFiles } = await build({
    entryPoints: [
      new URL("../worker/agent-checklist.ts", import.meta.url).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(outputFiles[0].text).toString("base64")
  );
})();

async function fixture(t, initial = [], sectionId = "ungrouped") {
  const {
    initializeAgentChecklist,
    trackAgentTaskVersions,
    runAgentChecklist,
  } = await engine;
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...args) {
      if (!args.length && query.trim().startsWith("CREATE TABLE")) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const result = /^\s*SELECT\b/i.test(query)
        ? statement.all(...args)
        : (statement.run(...args), []);
      return { toArray: () => result };
    },
  };
  const rows = new Map(initial.map((row) => [row.id, structuredClone(row)]));
  let sequence = 0;
  const context = {
    canvasId: "canvas",
    sectionId,
    accountId: "owner",
    accountName: "用户",
    bindingId: "binding",
    sql,
    rows: () => structuredClone([...rows.values()]),
    sequence: () => sequence,
    commit(changes) {
      const updated = changes.map(({ id, expectedRevision, data }) => {
        const current = rows.get(id);
        assert.equal(expectedRevision, current?.revision ?? 0);
        trackAgentTaskVersions(sql, current?.data ?? null, data);
        const row = {
          id,
          revision: expectedRevision + 1,
          data,
          deleted: data === null,
        };
        rows.set(id, row);
        return row;
      });
      if (updated.length) sequence++;
      return structuredClone(updated);
    },
  };
  initializeAgentChecklist(sql, context.rows);
  const call = (input) => runAgentChecklist(context, input).value;
  const noteChange = (noteId, edit) => {
    const row = rows.get(noteId);
    context.commit([
      {
        id: noteId,
        expectedRevision: row.revision,
        data: edit(structuredClone(row.data)),
      },
    ]);
  };
  const writes = () => db.prepare("SELECT total_changes() AS n").get().n;
  return { call, rows, noteChange, writes };
}

const create = {
  action: "create",
  requestId: "create",
  tasks: [
    { text: "第一项", instruction: "完成第一项", acceptance: "核对第一项" },
    { text: "第二项", instruction: "完成第二项", acceptance: "核对第二项" },
  ],
};
const ref = ({ noteId, taskId, generation, specRevision }) => ({
  noteId,
  taskId,
  generation,
  specRevision,
});
const snapshot = (f, tasks) =>
  f.call({ action: "snapshot", tasks: tasks.map(ref) }).items;
const finalize = (f, source, requestId = "finalize") =>
  f.call({
    action: "finalize",
    requestId,
    runId: "run",
    source,
    completedTurnId: "turn",
  });

test("structured file checks survive save and become the authorized acceptance snapshot", async (t) => {
  const f = await fixture(t);
  const checks = [
    {
      id: "file",
      kind: "artifact",
      required: true,
      description: "文件包含第一项",
      relativePath: "result.txt",
      predicate: { type: "textContains", text: "第一项" },
    },
  ];
  const created = f.call({
    ...create,
    tasks: [{ ...create.tasks[0], acceptanceChecks: checks }],
  });
  const task = created.tasks[0];
  assert.deepEqual(task.acceptanceChecks, checks);
  assert.deepEqual(snapshot(f, [task])[0].acceptance, checks);
  const saved = f.call({
    action: "save",
    requestId: "save-checks",
    noteId: task.noteId,
    taskId: task.taskId,
    expectedGeneration: task.generation,
    expectedSpecRevision: task.specRevision,
    instruction: "新执行说明",
    acceptance: task.acceptance,
  });
  assert.deepEqual(
    saved.tasks[0].acceptanceChecks,
    checks,
    "an older editor cannot silently erase checks",
  );
  const current = saved.tasks[0];
  const human = f.call({
    action: "save",
    requestId: "clear-checks",
    noteId: current.noteId,
    taskId: current.taskId,
    expectedGeneration: current.generation,
    expectedSpecRevision: current.specRevision,
    instruction: current.instruction,
    acceptance: current.acceptance,
    acceptanceChecks: [],
  });
  assert.ok(human.tasks[0].specRevision > current.specRevision);
  assert.equal(snapshot(f, human.tasks)[0].acceptance[0].kind, "human");
  assert.throws(() => snapshot(f, [current]), /变化|缺少/);
});

test("pending validation is read-only and rejects reorder, stale checks, and removed tasks", async (t) => {
  const f = await fixture(t);
  const first = f.call(create);
  const input = { action: "validate", tasks: first.tasks.map(ref) };
  const before = f.writes();
  assert.equal(f.call(input).items.length, 2);
  assert.equal(f.writes(), before);
  f.call({
    action: "reorder",
    requestId: "reverse-pending",
    expectedSequence: first.sequence,
    order: [...first.tasks]
      .reverse()
      .map(({ noteId, taskId }) => ({ noteId, taskId })),
  });
  assert.throws(() => f.call(input), /顺序/);
  const remaining = f.call({ action: "list" }).tasks;
  const last = remaining[1];
  f.noteChange(last.noteId, (note) => ({
    ...note,
    blocks: note.blocks.filter((block) => block.id !== last.taskId),
  }));
  assert.throws(
    () => f.call({ action: "validate", tasks: remaining.map(ref) }),
    /不存在|顺序/,
  );
});

test("file checks reject escapes and duplicate identities before creating tasks", async (t) => {
  const f = await fixture(t);
  const check = {
    id: "same",
    kind: "artifact",
    required: true,
    description: "文件",
    relativePath: "../outside.txt",
    predicate: { type: "exists" },
  };
  assert.throws(() =>
    f.call({
      ...create,
      tasks: [{ ...create.tasks[0], acceptanceChecks: [check] }],
    }),
  );
  const safe = { ...check, relativePath: "safe.txt" };
  assert.throws(() =>
    f.call({
      ...create,
      tasks: [{ ...create.tasks[0], acceptanceChecks: [safe, safe] }],
    }),
  );
  assert.equal(f.call({ action: "list" }).tasks.length, 0);
});

test("create receipts retain the original task references after the list changes", async (t) => {
  const f = await fixture(t);
  const first = f.call(create);
  const createdTasks = first.tasks.map(({ noteId, taskId }) => ({
    noteId,
    taskId,
  }));
  assert.deepEqual(first.createdTasks, createdTasks);

  const [{ noteId, taskId }] = createdTasks;
  f.noteChange(noteId, (note) => ({
    ...note,
    blocks: note.blocks.filter((block) => block.id !== taskId),
  }));
  const replay = f.call(create);
  assert.equal(replay.operationId, first.operationId);
  assert.deepEqual(replay.createdTasks, createdTasks);
  assert.ok(replay.tasks.every((task) => task.taskId !== taskId));
  assert.equal(replay.sequence, first.sequence + 1);
  assert.equal(f.call({ action: "list" }).createdTasks, undefined);
});

test("private create receipt lookups do not write and survive deletion of the bound section", async (t) => {
  const frame = {
    id: "section",
    revision: 1,
    deleted: false,
    data: {
      id: "section",
      type: "frame",
      boardId: "canvas",
      parentId: null,
      title: "分组",
      collapsed: false,
      locked: false,
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      zIndex: 1,
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
    },
  };
  const f = await fixture(t, [frame], frame.id);
  const lookup = (requestId, tasks = create.tasks) =>
    f.call({ action: "create_receipt", requestId, tasks });
  const before = f.writes();
  assert.throws(
    () => f.call({ action: "create_receipt", requestId: create.requestId }),
    { status: 400 },
  );
  assert.deepEqual(lookup(create.requestId), { found: false });
  assert.equal(f.writes(), before);
  const created = f.call(create);
  const expected = {
    found: true,
    operationId: created.operationId,
    createdTasks: created.createdTasks,
  };
  assert.deepEqual(lookup(create.requestId), expected);

  const [task] = created.tasks;
  assert.throws(() => lookup(create.requestId, [...create.tasks].reverse()), {
    status: 409,
  });
  assert.throws(
    () =>
      lookup(create.requestId, [
        { ...create.tasks[0], instruction: "不同要求" },
        create.tasks[1],
      ]),
    { status: 409 },
  );
  f.call({
    ...create,
    requestId: "append",
    targetNoteId: task.noteId,
    expectedNoteRevision: task.noteRevision,
  });
  assert.throws(() => lookup("append"), { status: 409 });
  f.call({
    action: "reorder",
    requestId: "not-create",
    expectedSequence: f.call({ action: "list" }).sequence,
    order: [{ noteId: task.noteId, taskId: task.taskId }],
  });
  f.noteChange(task.noteId, (data) => ({ ...data, parentId: null }));
  f.noteChange(frame.id, () => null);
  const after = f.writes();
  assert.throws(() => f.call({ action: "list" }), { status: 409 });
  assert.deepEqual(lookup(create.requestId), expected);
  assert.deepEqual(lookup("unknown"), { found: false });
  assert.throws(() => lookup("not-create"), { status: 409 });
  assert.equal(f.writes(), after);
});

test("saved checklist rows round trip, reorder by source identity and finalize two items in one note", async (t) => {
  const f = await fixture(t);
  const created = f.call(create);
  assert.equal(f.call(create).operationId, created.operationId);
  assert.equal(f.rows.size, 1);
  const [a, b] = created.tasks;
  assert.equal(a.noteId, b.noteId);
  assert.deepEqual(
    created.tasks.map((x) => [x.text, x.done, x.specStatus]),
    [
      ["第一项", false, "ready"],
      ["第二项", false, "ready"],
    ],
  );
  const reordered = f.call({
    action: "reorder",
    requestId: "sort",
    expectedSequence: created.sequence,
    order: [b, a].map(({ noteId, taskId }) => ({ noteId, taskId })),
  });
  assert.deepEqual(
    reordered.tasks.map((x) => x.taskId),
    [b.taskId, a.taskId],
  );
  assert.throws(() => snapshot(f, [a, b]), { status: 409 });
  const items = snapshot(f, reordered.tasks);
  assert.equal(items[0].instruction, "完成第二项");
  assert.equal(items[0].acceptance[0].description, "核对第二项");
  assert.equal(finalize(f, items[0].source, "one").status, "applied");
  assert.equal(finalize(f, items[1].source, "two").status, "applied");
  assert.deepEqual(
    f.call({ action: "list" }).tasks.map((x) => x.done),
    [true, true],
  );
  assert.ok(
    f.rows
      .get(a.noteId)
      .data.blocks.every((x) => x.createdByUserId === "owner"),
  );
});

test("edits and ABA invalidate old snapshots; replay cannot re-check a reopened item", async (t) => {
  const f = await fixture(t);
  const [a, b] = f.call(create).tasks;
  const [first, second] = snapshot(f, [a, b]);
  const edit = (taskId, fn) =>
    f.noteChange(a.noteId, (note) => ({
      ...note,
      blocks: note.blocks.map((x) => (x.id === taskId ? fn(x) : x)),
    }));
  edit(a.taskId, (block) => ({
    ...block,
    runs: [{ type: "text", text: "修改" }],
  }));
  edit(a.taskId, (block) => ({
    ...block,
    runs: [{ type: "text", text: "第一项" }],
  }));
  assert.equal(finalize(f, first.source, "stale").status, "conflict");
  assert.equal(
    f.call({ action: "list" }).tasks.find((x) => x.taskId === a.taskId)
      .specStatus,
    "stale",
  );
  const receipt = finalize(f, second.source, "second");
  assert.equal(receipt.status, "applied");
  edit(b.taskId, (block) => ({ ...block, done: false, completedAt: null }));
  assert.deepEqual(finalize(f, second.source, "second"), receipt);
  assert.equal(
    finalize(f, second.source, "different-request").status,
    "conflict",
  );
  assert.equal(
    f.call({ action: "list" }).tasks.find((x) => x.taskId === b.taskId).done,
    false,
  );
});

test("blank specs and reference text require explicit preparation; removed and restored tasks stay stale", async (t) => {
  const f = await fixture(t);
  const [task] = f.call({
    ...create,
    tasks: [{ text: "题目", instruction: "", acceptance: "" }],
  }).tasks;
  assert.equal(task.specStatus, "missing");
  assert.throws(() => snapshot(f, [task]), { status: 409 });
  f.noteChange(task.noteId, (note) => ({
    ...note,
    blocks: [
      {
        ...note.blocks[0],
        runs: [{ type: "ref", targetId: "reference", label: "文章" }],
      },
    ],
  }));
  const [current] = f.call({ action: "list" }).tasks;
  assert.equal(current.editableText, false);
  const save = {
    action: "save",
    requestId: "save",
    noteId: task.noteId,
    taskId: task.taskId,
    expectedGeneration: current.generation,
    expectedSpecRevision: current.specRevision,
    instruction: "检查引用",
    acceptance: "核对输出",
  };
  assert.throws(() => f.call({ ...save, text: "覆盖引用" }), { status: 409 });
  const [ready] = f.call(save).tasks;
  assert.equal(ready.specStatus, "ready");
  assert.equal(ready.text, "[[文章]]");
  const [item] = snapshot(f, [ready]);
  const note = structuredClone(f.rows.get(task.noteId).data);
  f.noteChange(task.noteId, (row) => ({ ...row, blocks: [] }));
  f.noteChange(task.noteId, () => note);
  const [restored] = f.call({ action: "list" }).tasks;
  assert.equal(restored.specStatus, "stale");
  assert.ok(restored.generation > ready.generation);
  assert.equal(finalize(f, item.source).status, "conflict");
});

test("selected reorder preserves all other slots and versions", async (t) => {
  const f = await fixture(t);
  const original = f.call({
    ...create,
    tasks: [...create.tasks, { ...create.tasks[0], text: "第三项" }],
  });
  const [a, b, c] = original.tasks;
  const reorder = {
    action: "reorder",
    requestId: "reorder",
    expectedSequence: original.sequence,
    order: [c, a].map(({ noteId, taskId }) => ({ noteId, taskId })),
  };
  const sorted = f.call(reorder);
  assert.deepEqual(sorted.tasks.map(ref), [c, b, a].map(ref));
  assert.deepEqual(f.call(reorder), sorted);
  assert.throws(() => f.call({ ...reorder, requestId: "another" }), {
    status: 409,
  });
});

test("reordering checklist items ignores both locked and unlocked article notes", async (t) => {
  const source = await fixture(t);
  const [task] = source.call(create).tasks;
  const sourceNote = source.rows.get(task.noteId).data;
  for (const locked of [false, true]) {
    const article = {
      id: "article",
      revision: 7,
      deleted: false,
      data: {
        ...sourceNote,
        id: "article",
        locked,
        noteKind: "text",
        blocks: sourceNote.blocks.map((block, index) => ({
          ...block,
          id: `paragraph-${index}`,
          runs: [{ type: "text", text: `文章第 ${index + 1} 段` }],
        })),
      },
    };
    const f = await fixture(t, [article]);
    const initial = f.call(create);
    const [first, second] = initial.tasks;
    const sorted = f.call({
      action: "reorder",
      requestId: "sort",
      expectedSequence: initial.sequence,
      order: [second, first].map(({ noteId, taskId }) => ({ noteId, taskId })),
    });
    assert.deepEqual(sorted.tasks.map(ref), [second, first].map(ref));
    assert.deepEqual(f.rows.get(article.id), article);
  }
});

test("pre-existing checklist rows receive version 1 and locked rows cannot be dispatched", async (t) => {
  const source = await fixture(t);
  const [item] = source.call(create).tasks;
  const note = source.rows.get(item.noteId);
  const f = await fixture(t, [note]);
  const [old] = f.call({ action: "list" }).tasks;
  assert.equal(old.generation, 1);
  assert.equal(old.specStatus, "missing");
  const [ready] = f.call({
    action: "save",
    requestId: "save-existing",
    noteId: old.noteId,
    taskId: old.taskId,
    expectedGeneration: old.generation,
    expectedSpecRevision: old.specRevision,
    instruction: "执行",
    acceptance: "核对",
  }).tasks;
  const [{ source: captured }] = snapshot(f, [ready]);
  f.noteChange(old.noteId, (data) => ({ ...data, locked: true }));
  const [locked] = f.call({ action: "list" }).tasks;
  assert.equal(locked.generation, 1);
  assert.equal(locked.locked, true);
  assert.equal(locked.editableText, false);
  assert.throws(() => snapshot(f, [locked]), { status: 409 });
  const conflict = finalize(f, captured);
  assert.equal(conflict.status, "conflict");
  f.noteChange(old.noteId, (data) => ({ ...data, locked: false }));
  assert.deepEqual(finalize(f, captured), conflict);
  assert.equal(f.call({ action: "list" }).tasks[0].done, false);
});
