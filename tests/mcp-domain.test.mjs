import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const dir = await mkdtemp(new URL("../.tmp/mcp-domain-", import.meta.url));
let domain;
try {
  await build({
    stdin: {
      contents: `export * from './worker/mcp/schemas.ts'; export * from './worker/mcp/errors.ts'; export * from './worker/canvas-commands.ts'; export * from './worker/canvas-queries.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "domain.mjs"),
    logLevel: "silent",
  });
  domain = await import(pathToFileURL(path.join(dir, "domain.mjs")));
} catch (error) {
  test("semantic domain modules are available", () =>
    assert.fail(error.message));
}
if (domain) {
  const {
    parseToolInput,
    toolSchemas,
    planCanvasCommand,
    planRestoreBlocks,
    queryCanvas,
    McpBusinessError,
    businessErrorResult,
  } = domain;
  const old = "2026-10-01T00:00:00.000Z",
    now = "2026-10-27T08:00:00.000Z";
  const block = (id, text = id, extra = {}) => ({
    id,
    runs: [{ type: "text", text }],
    done: false,
    createdAt: old,
    completedAt: null,
    createdByUserId: "original",
    createdByName: "原作者",
    ...extra,
  });
  const note = (
    id = "note",
    blocks = [block("a"), block("b"), block("c")],
    extra = {},
  ) => ({
    id,
    type: "note",
    boardId: "canvas",
    parentId: null,
    x: 80,
    y: 100,
    width: 280,
    height: 190,
    zIndex: 1,
    locked: false,
    createdAt: old,
    updatedAt: old,
    noteKind: "text",
    color: "paper",
    blocks,
    ...extra,
  });
  const frame = (id = "section", extra = {}) => ({
    ...note(id, [], extra),
    type: "frame",
    title: id,
    collapsed: false,
    ...extra,
  });
  const row = (data, revision = 4) => ({
    id: data.id,
    revision,
    deleted: false,
    data,
  });
  const ctx = () => {
    let n = 0;
    return {
      canvasId: "canvas",
      accountId: "alice",
      accountName: "Alice",
      now,
      makeId: (prefix) => `${prefix}-${++n}`,
    };
  };
  const qc = { canvasId: "canvas", canvasName: "我的画布", sequence: 7 };
  const command = (name, input, rows = [row(note())]) =>
    planCanvasCommand(
      rows,
      { name, input: { canvas_id: "canvas", request_id: "request", ...input } },
      ctx(),
    );
  const query = (name, input = {}, rows = [row(note())], context = qc) =>
    queryCanvas(
      rows,
      { name, input: { canvas_id: "canvas", ...input } },
      context,
    );
  const errorCode = (code) => (error) =>
    error instanceof McpBusinessError && error.code === code;

  test("nine strict tool schemas reject protected/unknown fields and ambiguous targets", () => {
    assert.deepEqual(
      Object.keys(toolSchemas).sort(),
      [
        "list_canvases",
        "get_canvas",
        "search_content",
        "get_content",
        "create_tasks",
        "update_task",
        "delete_task",
        "create_note",
        "update_note",
      ].sort(),
    );
    for (const input of [
      {
        canvas_id: "canvas",
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { createdByUserId: "spoof" },
        request_id: "r",
      },
      {
        canvas_id: "canvas",
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { text: "x", runs: [] },
        request_id: "r",
      },
    ])
      assert.throws(
        () => parseToolInput("update_task", input),
        errorCode("VALIDATION_ERROR"),
      );
    for (const name of [
      "create_tasks",
      "update_task",
      "delete_task",
      "create_note",
      "update_note",
    ])
      assert.throws(
        () => parseToolInput(name, { canvas_id: "canvas" }),
        errorCode("VALIDATION_ERROR"),
      );
    assert.throws(
      () =>
        parseToolInput("create_tasks", {
          canvas_id: "canvas",
          target: { note_id: "note", section_id: "section" },
          items: [{ text: "x" }],
          request_id: "r",
        }),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () =>
        command("create_tasks", {
          target: { note_id: "note" },
          items: [{ text: "x" }],
        }),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () =>
        parseToolInput("create_note", {
          canvas_id: "canvas",
          target: { section_id: "ungrouped" },
          blocks: [{ text: "x" }],
          color: "red",
          request_id: "r",
        }),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("business errors serialize only stable safe fields", () => {
    const result = businessErrorResult(
      new McpBusinessError("REVISION_CONFLICT", "Read latest", false, {
        current_revision: 8,
      }),
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: "REVISION_CONFLICT",
      message: "Read latest",
      retryable: false,
      details: { current_revision: 8 },
    });
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
  });

  test("text notes and checklist blocks have task parity", () => {
    for (const noteKind of ["text", "checklist"]) {
      const result = query("search_content", { kind: "task" }, [
        row(note("note", [block("a")], { noteKind })),
      ]);
      assert.equal(result.items[0].task_id, "a");
      const plan = command(
        "update_task",
        {
          note_id: "note",
          task_id: "a",
          expected_revision: 4,
          patch: { text: "changed" },
        },
        [row(note("note", [block("a")], { noteKind }))],
      );
      assert.equal(plan.changes[0].data.blocks[0].runs[0].text, "changed");
    }
  });

  test("targeted edits preserve author, untouched metadata, array and block order", () => {
    const source = note(
      "note",
      [
        block("a", "a", {
          dueAt: "2026-11-01T00:00:00.000Z",
          remark: { text: "keep", updatedAt: old },
          arrangedOrder: 7,
        }),
        block("b", "b", { done: true, completedAt: old }),
        block("c"),
      ],
      { blockOrder: ["c", "a", "b"] },
    );
    const before = structuredClone(source);
    const plan = command(
      "update_note",
      {
        note_id: "note",
        expected_revision: 4,
        edits: [{ task_id: "b", patch: { text: "edited" } }],
        note_kind: "checklist",
        color: "sage",
      },
      [row(source)],
    );
    const changed = plan.changes[0].data;
    assert.deepEqual(changed.blocks[0], before.blocks[0]);
    assert.deepEqual(changed.blocks[2], before.blocks[2]);
    assert.equal(changed.blocks[1].createdByUserId, "original");
    assert.equal(changed.blocks[1].completedAt, old);
    assert.deepEqual(changed.blockOrder, ["c", "a", "b"]);
    assert.deepEqual(source, before);
  });

  test("date input normalizes explicit offsets and rejects invalid calendar dates", () => {
    const patch = {
      due_at: "2026-11-01T10:00:00+08:00",
      due_start_at: "2026-11-01T09:00:00+08:00",
    };
    const plan = command("update_task", {
      note_id: "note",
      task_id: "a",
      expected_revision: 4,
      patch,
    });
    assert.equal(
      plan.changes[0].data.blocks[0].dueAt,
      "2026-11-01T02:00:00.000Z",
    );
    assert.equal(
      plan.changes[0].data.blocks[0].dueStartAt,
      "2026-11-01T01:00:00.000Z",
    );
    for (const due_at of [
      "2026-02-30T01:00:00Z",
      "2026-11-01",
      "tomorrow",
      "2026-11-01T01:00:00",
      "2026-11-01T24:00:00Z",
      "2026-11-01T01:00:00+24:00",
    ])
      assert.throws(
        () =>
          command("update_task", {
            note_id: "note",
            task_id: "a",
            expected_revision: 4,
            patch: { due_at },
          }),
        errorCode("VALIDATION_ERROR"),
      );
    assert.throws(
      () =>
        command("update_task", {
          note_id: "note",
          task_id: "a",
          expected_revision: 4,
          patch: { due_start_at: "2026-11-01T01:00:00Z" },
        }),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () =>
        command("update_task", {
          note_id: "note",
          task_id: "a",
          expected_revision: 4,
          patch: {
            due_at: "2026-11-01T01:00:00Z",
            due_start_at: "2026-11-01T01:00:00Z",
          },
        }),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("clear semantics remove remark, clear date range, and leave omitted fields", () => {
    const b = block("a", "x", {
      remark: { text: "remark", updatedAt: old },
      dueAt: "2026-11-02T00:00:00.000Z",
      dueStartAt: "2026-11-01T00:00:00.000Z",
    });
    const plan = command(
      "update_task",
      {
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { remark: null, due_at: null },
      },
      [row(note("note", [b]))],
    );
    const changed = plan.changes[0].data.blocks[0];
    assert.equal(changed.remark, undefined);
    assert.equal(changed.dueAt, null);
    assert.equal(changed.dueStartAt, null);
    assert.deepEqual(changed.runs, b.runs);
    assert.throws(
      () =>
        command("update_task", {
          note_id: "note",
          task_id: "a",
          expected_revision: 4,
          patch: { text: null },
        }),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("done timestamps are server generated, stable on repeat, cleared on reopening", () => {
    const plan = command("update_task", {
      note_id: "note",
      task_id: "a",
      expected_revision: 4,
      patch: { done: true },
    });
    assert.equal(plan.changes[0].data.blocks[0].completedAt, now);
    const repeated = command(
      "update_task",
      {
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { done: true },
      },
      [row(note("note", [block("a", "a", { done: true, completedAt: old })]))],
    );
    assert.deepEqual(repeated.changes, []);
    assert.equal(repeated.result.changed, false);
    assert.equal(repeated.result.revision, 4);
    const reopened = command(
      "update_task",
      {
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { done: false },
      },
      [row(plan.changes[0].data)],
    );
    assert.equal(reopened.changes[0].data.blocks[0].completedAt, null);
    assert.deepEqual(
      command("update_note", {
        note_id: "note",
        expected_revision: 4,
        edits: [{ task_id: "a", patch: { text: "a" } }],
        color: "paper",
      }).changes,
      [],
    );
  });

  test("all existing note mutations require a whole-note matching revision", () => {
    for (const [name, input] of [
      ["update_task", { task_id: "a", patch: { done: true } }],
      ["delete_task", { task_id: "a" }],
      ["update_note", { color: "rose" }],
      [
        "create_tasks",
        { target: { note_id: "note" }, items: [{ text: "new" }] },
      ],
    ]) {
      assert.throws(
        () =>
          command(name, {
            ...(name === "create_tasks" ? {} : { note_id: "note" }),
            ...input,
            expected_revision: 3,
          }),
        errorCode("REVISION_CONFLICT"),
      );
    }
  });

  test("explicit ungrouped placement uses persisted dimensions and attributes new tasks", () => {
    const root = { ...frame("canvas-root"), type: "collection" };
    const plan = command(
      "create_tasks",
      {
        target: { section_id: "ungrouped" },
        items: [{ text: "first" }, { text: "second", done: true }],
      },
      [row(root)],
    );
    const created = plan.changes[0].data;
    assert.equal(created.parentId, null);
    assert.equal(created.noteKind, "checklist");
    assert.equal(created.x, 386);
    assert.equal(created.y, 100);
    assert.equal(created.width, 280);
    assert.equal(created.blocks.length, 2);
    assert.equal(created.blocks[0].createdByUserId, "alice");
    assert.equal(created.blocks[0].createdByName, "Alice");
    assert.equal(created.blocks[1].completedAt, now);
    assert.equal(plan.result.revision, 1);
  });

  test("section placement uses stored height and expands only necessary frame bounds", () => {
    const section = frame("section", { x: 10, y: 20, width: 328, height: 300 });
    const member = note("existing", [block("old")], {
      parentId: "section",
      x: 34,
      y: 68,
      height: 400,
      layoutHeight: 20,
    });
    const plan = command(
      "create_note",
      { target: { section_id: "section" }, blocks: [{ text: "new" }] },
      [row(section), row(member)],
    );
    const created = plan.changes.find((c) => c.expectedRevision === 0).data;
    assert.equal(created.x, 34);
    assert.equal(created.y, 492);
    const resized = plan.changes.find((c) => c.id === "section").data;
    assert.equal(resized.height, 686);
    assert.equal(resized.width, 328);
  });

  test("batch planning validates every item and never mutates its input", () => {
    const rows = [row(note())],
      before = structuredClone(rows);
    assert.throws(
      () =>
        command(
          "create_tasks",
          {
            target: { note_id: "note" },
            expected_revision: 4,
            items: [
              { text: "valid" },
              { runs: [{ type: "ref", target_id: "elsewhere", label: "bad" }] },
            ],
          },
          rows,
        ),
      errorCode("NOT_FOUND"),
    );
    assert.deepEqual(rows, before);
    for (const count of [0, 51])
      assert.throws(
        () =>
          command("create_tasks", {
            target: { section_id: "ungrouped" },
            items: Array.from({ length: count }, () => ({ text: "x" })),
          }),
        errorCode("VALIDATION_ERROR"),
      );
  });

  test("writes reject locked or archived targets through every ancestor", () => {
    for (const [parent, code] of [
      [frame("outer", { locked: true }), "LOCKED"],
      [{ ...frame("outer"), type: "collection" }, "ARCHIVED"],
    ]) {
      const rows = [
        row(parent),
        row(frame("inner", { parentId: "outer" })),
        row(note("note", [block("a")], { parentId: "inner" })),
      ];
      assert.throws(
        () =>
          command(
            "update_task",
            {
              note_id: "note",
              task_id: "a",
              expected_revision: 4,
              patch: { text: "bad" },
            },
            rows,
          ),
        errorCode(code),
      );
      assert.throws(
        () =>
          command(
            "create_note",
            { target: { section_id: "inner" }, blocks: [{ text: "bad" }] },
            rows,
          ),
        errorCode(code),
      );
    }
    assert.throws(
      () =>
        command(
          "update_note",
          { note_id: "note", expected_revision: 4, color: "sage" },
          [row(note("note", [block("a")], { locked: true }))],
        ),
      errorCode("LOCKED"),
    );
  });

  test("references resolve only active same-canvas objects and text replacement removes references", () => {
    const rows = [
      row(note()),
      row(note("foreign", [block("f")], { boardId: "other" })),
      row(note("deleted")),
    ];
    rows[2].deleted = true;
    for (const target_id of ["foreign", "deleted", "https://example.com"])
      assert.throws(
        () =>
          command(
            "update_task",
            {
              note_id: "note",
              task_id: "a",
              expected_revision: 4,
              patch: { runs: [{ type: "ref", target_id, label: "label" }] },
            },
            rows,
          ),
        errorCode("NOT_FOUND"),
      );
    const plan = command("update_task", {
      note_id: "note",
      task_id: "a",
      expected_revision: 4,
      patch: { runs: [{ type: "ref", target_id: "note", label: "self" }] },
    });
    assert.deepEqual(plan.changes[0].data.blocks[0].runs, [
      { type: "ref", targetId: "note", label: "self" },
    ]);
    const replaced = command(
      "update_task",
      {
        note_id: "note",
        task_id: "a",
        expected_revision: 4,
        patch: { text: "plain" },
      },
      [row(plan.changes[0].data)],
    );
    assert.deepEqual(replaced.changes[0].data.blocks[0].runs, [
      { type: "text", text: "plain" },
    ]);
  });

  test("deletion saves original neighbors and keeps empty notes", () => {
    const plan = command("delete_task", {
      note_id: "note",
      task_id: "b",
      expected_revision: 4,
    });
    assert.deepEqual(
      plan.changes[0].data.blocks.map((b) => b.id),
      ["a", "c"],
    );
    assert.equal(plan.deletionSnapshots[0].previousTaskId, "a");
    assert.equal(plan.deletionSnapshots[0].nextTaskId, "c");
    assert.equal(plan.deletionSnapshots[0].block.createdByUserId, "original");
    const empty = command(
      "delete_task",
      { note_id: "note", task_id: "a", expected_revision: 4 },
      [row(note("note", [block("a")]))],
    );
    assert.equal(empty.changes[0].data.type, "note");
    assert.deepEqual(empty.changes[0].data.blocks, []);
  });

  test("update_note removals capture original adjacency and reject conflicting operations", () => {
    const plan = command("update_note", {
      note_id: "note",
      expected_revision: 4,
      remove_task_ids: ["a", "b"],
      append_blocks: [{ text: "new" }],
    });
    assert.equal(plan.deletionSnapshots[1].previousTaskId, "a");
    assert.equal(plan.deletionSnapshots[1].nextTaskId, "c");
    assert.deepEqual(
      plan.changes[0].data.blocks.map((b) => b.runs[0].text),
      ["c", "new"],
    );
    assert.throws(
      () =>
        command("update_note", {
          note_id: "note",
          expected_revision: 4,
          edits: [{ task_id: "a", patch: { done: true } }],
          remove_task_ids: ["a"],
        }),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("recovery inserts original blocks at neighbors and preserves current edits/style", () => {
    const deleted = command("delete_task", {
      note_id: "note",
      task_id: "b",
      expected_revision: 4,
    });
    const current = deleted.changes[0].data;
    current.blocks[0].runs = [{ type: "text", text: "someone edited" }];
    current.color = "rose";
    const restored = planRestoreBlocks(
      [row(current, 8)],
      deleted.deletionSnapshots,
      ctx(),
    );
    assert.equal(restored.changes[0].expectedRevision, 8);
    assert.deepEqual(
      restored.changes[0].data.blocks.map((b) => b.id),
      ["a", "b", "c"],
    );
    assert.equal(
      restored.changes[0].data.blocks[0].runs[0].text,
      "someone edited",
    );
    assert.equal(
      restored.changes[0].data.blocks[1].createdByUserId,
      "original",
    );
    assert.equal(restored.changes[0].data.color, "rose");
    const appended = planRestoreBlocks(
      [row(note("note", [block("x")]))],
      deleted.deletionSnapshots,
      ctx(),
    );
    assert.deepEqual(
      appended.changes[0].data.blocks.map((b) => b.id),
      ["x", "b"],
    );
    assert.throws(
      () => planRestoreBlocks([row(note())], deleted.deletionSnapshots, ctx()),
      errorCode("REVISION_CONFLICT"),
    );
    assert.throws(
      () => planRestoreBlocks([], deleted.deletionSnapshots, ctx()),
      errorCode("NOT_FOUND"),
    );
    assert.throws(
      () =>
        planRestoreBlocks(
          [row(note("note", [], { locked: true }))],
          deleted.deletionSnapshots,
          ctx(),
        ),
      errorCode("LOCKED"),
    );
  });

  test("search matches case-insensitive text, reference labels and remarks with task filters", () => {
    const rows = [
      row(frame()),
      row(
        note(
          "note",
          [
            block("a", "Alpha", { dueAt: "2026-11-01T00:00:00.000Z" }),
            block("b", "Beta", {
              done: true,
              completedAt: old,
              dueAt: "2026-11-02T00:00:00.000Z",
            }),
            block("c", "Other", {
              remark: { text: "ALPHA remark", updatedAt: old },
            }),
            block("d", "", {
              runs: [{ type: "ref", targetId: "missing", label: "Alpha ref" }],
            }),
          ],
          { parentId: "section" },
        ),
      ),
    ];
    assert.deepEqual(
      query("search_content", { query: "alpha" }, rows).items.map(
        (b) => b.task_id,
      ),
      ["a", "c", "d"],
    );
    const filtered = query(
      "search_content",
      {
        done: false,
        created_by: "original",
        section_id: "section",
        due_from: "2026-11-01T00:00:00Z",
        due_to: "2026-11-02T00:00:00Z",
      },
      rows,
    );
    assert.deepEqual(
      filtered.items.map((b) => b.task_id),
      ["a"],
    );
    assert.throws(
      () => query("search_content", { kind: "note", done: false }, rows),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () =>
        query(
          "search_content",
          { kind: "note", due_from: "2026-11-01T00:00:00Z" },
          rows,
        ),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("search excludes archive ancestry by default and reports archived and effective locks", () => {
    const rows = [
      row({ ...frame("archive"), type: "collection" }),
      row(frame("nested", { parentId: "archive", locked: true })),
      row(note("note", [block("a")], { parentId: "nested" })),
    ];
    assert.deepEqual(query("search_content", {}, rows).items, []);
    const result = query("search_content", { include_archived: true }, rows);
    assert.equal(result.items[0].archived, true);
    assert.equal(result.items[0].locked, true);
    assert.throws(
      () => query("get_content", { note_id: "note" }, rows),
      errorCode("ARCHIVED"),
    );
    assert.equal(
      query("get_content", { note_id: "note", include_archived: true }, rows)
        .items[0].task_id,
      "a",
    );
  });

  test("stable pagination binds cursors to canvas, normalized filters and sequence", () => {
    const rows = [
      row(note("z", [block("z"), block("a")])),
      row(note("a", [block("b")])),
    ];
    const first = query("search_content", { limit: 2 }, rows);
    assert.deepEqual(
      first.items.map((b) => [b.note_id, b.task_id]),
      [
        ["a", "b"],
        ["z", "a"],
      ],
    );
    assert.ok(first.next_cursor);
    assert.deepEqual(
      query(
        "search_content",
        { limit: 2, cursor: first.next_cursor },
        rows,
      ).items.map((b) => b.task_id),
      ["z"],
    );
    assert.throws(
      () =>
        query("search_content", { limit: 2, cursor: first.next_cursor }, rows, {
          ...qc,
          sequence: 8,
        }),
      errorCode("STALE_CURSOR"),
    );
    assert.throws(
      () =>
        query(
          "search_content",
          { query: "other", cursor: first.next_cursor },
          rows,
        ),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () =>
        query("search_content", { cursor: first.next_cursor }, rows, {
          ...qc,
          canvasId: "other",
        }),
      errorCode("VALIDATION_ERROR"),
    );
    for (const cursor of ["garbage", "e30", "a".repeat(3000)])
      assert.throws(
        () => query("search_content", { cursor }, rows),
        errorCode("VALIDATION_ERROR"),
      );
  });

  test("detail pagination binds note revision, defaults to 50, and search defaults to 20", () => {
    const rows = [
      row(
        note(
          "note",
          Array.from({ length: 110 }, (_, n) =>
            block(`b-${String(n).padStart(3, "0")}`),
          ),
        ),
      ),
    ];
    assert.equal(query("search_content", {}, rows).items.length, 20);
    const first = query("get_content", { note_id: "note" }, rows);
    assert.equal(first.items.length, 50);
    assert.equal(
      query("get_content", { note_id: "note", limit: 100 }, rows).items.length,
      100,
    );
    assert.equal(
      query("get_content", { note_id: "note", cursor: first.next_cursor }, rows)
        .items[0].task_id,
      "b-050",
    );
    assert.throws(
      () =>
        query("get_content", { note_id: "note", cursor: first.next_cursor }, [
          row(rows[0].data, 5),
        ]),
      errorCode("STALE_CURSOR"),
    );
    assert.throws(
      () => query("search_content", { limit: 51 }, rows),
      errorCode("VALIDATION_ERROR"),
    );
    assert.throws(
      () => query("get_content", { note_id: "note", limit: 101 }, rows),
      errorCode("VALIDATION_ERROR"),
    );
  });

  test("query projections expand references only once, preserve unavailable labels and bound output", () => {
    const rows = [
      row(
        note("note", [
          block("a", "", {
            runs: [
              { type: "ref", targetId: "target", label: "saved" },
              { type: "ref", targetId: "missing", label: "unavailable" },
              { type: "ref", targetId: "foreign", label: "private" },
            ],
          }),
        ]),
      ),
      row(
        note("target", [
          block("nested", "", {
            runs: [{ type: "ref", targetId: "missing", label: "nested label" }],
          }),
        ]),
      ),
      row(note("foreign", [block("secret", "secret")], { boardId: "other" })),
    ];
    const item = query("get_content", { note_id: "note", task_id: "a" }, rows)
      .items[0];
    assert.equal(item.runs[0].display_text, "[[nested label]]");
    assert.equal(item.runs[1].unavailable, true);
    assert.equal(item.runs[1].label, "unavailable");
    assert.equal(item.runs[2].unavailable, true);
    assert.equal(JSON.stringify(item).includes("secret"), false);
    const large = [
      row(
        note(
          "large",
          Array.from({ length: 50 }, (_, n) =>
            block(String(n), "界".repeat(2000)),
          ),
        ),
      ),
    ];
    const result = query("search_content", { limit: 50 }, large);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(result)).byteLength <= 256000,
    );
    assert.ok(result.items.every((b) => b.snippet.length <= 240));
  });

  test("get_canvas describes existing visible sections, ungrouped entry and content version", () => {
    const result = query("get_canvas", {}, [row(frame()), row(note())]);
    assert.equal(result.canvas_id, "canvas");
    assert.equal(result.name, "我的画布");
    assert.equal(result.sequence, 7);
    assert.ok(result.sections.some((s) => s.section_id === "section"));
    assert.ok(result.sections.some((s) => s.section_id === "ungrouped"));
    assert.equal(result.counts.notes, 1);
    assert.equal(result.counts.tasks, 3);
  });

  test("clearing already absent dates is a semantic no-op", () => {
    const result = command("update_task", {
      note_id: "note",
      task_id: "a",
      expected_revision: 4,
      patch: { due_at: null, due_start_at: null, remark: null, done: false },
    });
    assert.equal(result.result.changed, false);
    assert.deepEqual(result.changes, []);
  });

  test("adjacent deleted blocks restore in their original order even when snapshots are reordered", () => {
    const removed = command("update_note", {
      note_id: "note",
      expected_revision: 4,
      remove_task_ids: ["a", "b"],
    });
    for (const snapshots of [
      removed.deletionSnapshots,
      [...removed.deletionSnapshots].reverse(),
    ]) {
      const restored = planRestoreBlocks(
        [row(removed.changes[0].data, 9)],
        snapshots,
        ctx(),
      );
      assert.deepEqual(
        restored.changes[0].data.blocks.map((b) => b.id),
        ["a", "b", "c"],
      );
    }
  });

  test("batch create on an existing text note preserves old data and returns only generated task IDs", () => {
    const original = note("note", [block("a")], { blockOrder: ["a"] });
    const result = command(
      "create_tasks",
      {
        target: { note_id: "note" },
        expected_revision: 4,
        items: [{ text: "new", remark: "details" }],
      },
      [row(original)],
    );
    assert.deepEqual(result.changes[0].data.blocks[0], original.blocks[0]);
    assert.equal(result.changes[0].data.noteKind, "text");
    assert.deepEqual(result.result.task_ids, ["b-1"]);
    assert.deepEqual(result.changes[0].data.blockOrder, ["a", "b-1"]);
    assert.deepEqual(result.changes[0].data.blocks[1].remark, {
      text: "details",
      updatedAt: now,
    });
  });

  test("planning enforces object and note capacity without partial mutations", () => {
    const full = Array.from({ length: 2000 }, (_, n) =>
      row(note(`note-${n}`, [])),
    );
    assert.throws(
      () =>
        command(
          "create_note",
          { target: { section_id: "ungrouped" }, blocks: [{ text: "x" }] },
          full,
        ),
      errorCode("LIMIT_EXCEEDED"),
    );
    const rows = [row(note("note", [block("a", "x".repeat(250000))]))];
    assert.throws(
      () =>
        command(
          "create_tasks",
          {
            target: { note_id: "note" },
            expected_revision: 4,
            items: [{ text: "x".repeat(7000) }],
          },
          rows,
        ),
      errorCode("LIMIT_EXCEEDED"),
    );
    assert.equal(rows[0].data.blocks.length, 1);
  });

  test("detail pagination reduces page size to byte bound and still retrieves a complete single task", () => {
    const rows = [
      row(
        note("note", [
          block("a", "界".repeat(50000)),
          block("b", "界".repeat(50000)),
        ]),
      ),
    ];
    const first = query("get_content", { note_id: "note" }, rows);
    assert.equal(first.items.length, 1);
    assert.ok(first.next_cursor);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(first)).byteLength <= 256000,
    );
    assert.equal(
      query("get_content", { note_id: "note", cursor: first.next_cursor }, rows)
        .items[0].task_id,
      "b",
    );
    const one = query("get_content", { note_id: "note", task_id: "a" }, rows);
    assert.equal(one.items[0].runs[0].text.length, 50000);
  });

  test("recovery rechecks collection ancestors and refuses cross-note identifier conflicts", () => {
    const removed = command("delete_task", {
      note_id: "note",
      task_id: "b",
      expected_revision: 4,
    });
    const archived = [
      row({ ...frame("archive"), type: "collection" }),
      row({ ...removed.changes[0].data, parentId: "archive" }),
    ];
    assert.throws(
      () => planRestoreBlocks(archived, removed.deletionSnapshots, ctx()),
      errorCode("ARCHIVED"),
    );
    assert.throws(
      () =>
        planRestoreBlocks(
          [row(removed.changes[0].data), row(note("other", [block("b")]))],
          removed.deletionSnapshots,
          ctx(),
        ),
      errorCode("REVISION_CONFLICT"),
    );
  });

  test("creation expands fixed inspiration boards and their unlocked ancestors without moving existing content", () => {
    const outer = frame("outer", { width: 500, height: 300 });
    const inner = frame("inner", {
      parentId: "outer",
      x: 104,
      y: 148,
      width: 300,
      height: 200,
      fixedBounds: true,
    });
    const member = note("member", [], {
      parentId: "inner",
      x: 128,
      y: 196,
      height: 400,
    });
    const result = command(
      "create_note",
      { target: { section_id: "inner" }, blocks: [{ text: "new" }] },
      [row(outer), row(inner), row(member)],
    );
    assert.equal(result.changes.find((c) => c.id === "inner").data.height, 686);
    assert.equal(result.changes.find((c) => c.id === "outer").data.height, 758);
    assert.equal(
      result.changes.some((c) => c.id === "member"),
      false,
    );
  });

  test("RFC 3339 subsecond precision normalizes to the persisted UTC millisecond format", () => {
    const input = parseToolInput("update_task", {
      canvas_id: "canvas",
      note_id: "note",
      task_id: "a",
      expected_revision: 4,
      request_id: "r",
      patch: { due_at: "2026-11-01T10:00:00.123456789+08:00" },
    });
    assert.equal(input.patch.due_at, "2026-11-01T02:00:00.123Z");
  });
}
await rm(dir, { recursive: true, force: true });
