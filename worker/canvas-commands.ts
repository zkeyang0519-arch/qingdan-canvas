import type { CanvasData, Change, Row } from "./types";
import type {
  CanvasCommand,
  CommandContext,
  CommandPlan,
  DeletionSnapshot,
  NoteData,
  TaskBlock,
} from "./mcp/contracts";
import { McpBusinessError } from "./mcp/errors";
import {
  parseToolInput,
  type NewBlockInput,
  type TaskPatch,
} from "./mcp/schemas";
import {
  ancestry,
  assertRevision,
  canvasRows,
  finishPlan,
  noteRow,
  objectRow,
  snapshot,
  writable,
} from "./mcp/domain";

function applyPatch(
  block: TaskBlock,
  patch: TaskPatch,
  live: Map<string, Row>,
  context: CommandContext,
): TaskBlock {
  const next = structuredClone(block);
  if (patch.text !== undefined)
    next.runs = [{ type: "text", text: patch.text }];
  if (patch.runs !== undefined)
    next.runs = patch.runs.map((run) => {
      if (run.type === "text") return { type: "text", text: run.text };
      objectRow(live, run.target_id);
      return { type: "ref", targetId: run.target_id, label: run.label };
    });
  if (patch.remark === null) delete next.remark;
  else if (patch.remark !== undefined && patch.remark !== next.remark?.text)
    next.remark = { text: patch.remark, updatedAt: context.now };
  if (patch.done !== undefined && patch.done !== next.done) {
    next.done = patch.done;
    next.completedAt = patch.done ? context.now : null;
  }
  if (patch.due_at !== undefined) {
    if (patch.due_at !== null || next.dueAt != null) next.dueAt = patch.due_at;
    if (patch.due_at === null && next.dueStartAt != null)
      next.dueStartAt = null;
  }
  if (patch.due_start_at !== undefined) {
    if (patch.due_at === null && patch.due_start_at !== null)
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Cannot set a start while clearing the end.",
      );
    if (patch.due_start_at !== null || next.dueStartAt != null)
      next.dueStartAt = patch.due_start_at;
  }
  if (next.dueStartAt != null && (!next.dueAt || next.dueStartAt >= next.dueAt))
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "A start date requires a later end date.",
    );
  return next;
}
function allocateId(
  prefix: string,
  context: CommandContext,
  used: Set<string>,
): string {
  const id = context.makeId(prefix);
  if (!id || id.length > 256 || used.has(id))
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Generated identifier collided with existing content.",
    );
  used.add(id);
  return id;
}
function idSet(rows: readonly Row[]): Set<string> {
  return new Set(
    rows.flatMap((r) => [
      r.id,
      ...(r.data?.type === "note"
        ? (r.data as NoteData).blocks.map((b) => b.id)
        : []),
    ]),
  );
}
function createBlocks(
  items: NewBlockInput[],
  live: Map<string, Row>,
  context: CommandContext,
  used: Set<string>,
): TaskBlock[] {
  return items.map((item) =>
    applyPatch(
      {
        id: allocateId("b", context, used),
        runs: [],
        done: false,
        createdAt: context.now,
        completedAt: null,
        createdByUserId: context.accountId,
        createdByName: context.accountName,
      },
      item,
      live,
      context,
    ),
  );
}
function noteChange(
  row: Row & { data: NoteData },
  next: NoteData,
  context: CommandContext,
): Change[] {
  if (JSON.stringify(row.data) === JSON.stringify(next)) return [];
  return [
    {
      id: row.id,
      expectedRevision: row.revision,
      data: { ...next, updatedAt: context.now },
    },
  ];
}
function notePlan(
  rows: readonly Row[],
  row: Row & { data: NoteData },
  next: NoteData,
  snapshots: DeletionSnapshot[],
  context: CommandContext,
): CommandPlan {
  const changes = noteChange(row, next, context);
  return finishPlan(
    rows,
    changes,
    snapshots,
    {
      canvas_id: context.canvasId,
      note_id: row.id,
      task_ids: next.blocks.map((b) => b.id),
      revision: row.revision + (changes.length ? 1 : 0),
      changed: changes.length > 0,
    },
    context.canvasId,
  );
}
function existingNote(live: Map<string, Row>, id: string, revision: number) {
  const row = noteRow(live, id);
  assertRevision(row, revision);
  writable(live, row.data);
  return row;
}
function newNote(
  rows: readonly Row[],
  live: Map<string, Row>,
  sectionId: string,
  blocks: TaskBlock[],
  style: { note_kind?: "text" | "checklist"; color?: string },
  context: CommandContext,
  used: Set<string>,
): CommandPlan {
  const parent =
    sectionId === "ungrouped" ? null : objectRow(live, sectionId, "frame").data;
  if (parent) writable(live, parent);
  const members = [...live.values()]
    .map((r) => r.data!)
    .filter((o) => o.parentId === (parent?.id ?? null));
  const x = parent ? Number(parent.x) + 24 : 80 + (members.length % 4) * 306;
  const y = parent
    ? Math.max(
        Number(parent.y) + 48,
        ...members.map((o) => Number(o.y) + Number(o.height) + 24),
      )
    : 100 + Math.floor(members.length / 4) * 220;
  const id = allocateId("o", context, used);
  const data: NoteData = {
    id,
    type: "note",
    boardId: context.canvasId,
    parentId: parent?.id ?? null,
    x,
    y,
    width: 280,
    height: 190,
    zIndex: Date.parse(context.now),
    locked: false,
    createdAt: context.now,
    updatedAt: context.now,
    noteKind: style.note_kind ?? "text",
    color: style.color ?? "paper",
    blocks,
  };
  const changes: Change[] = [{ id, expectedRevision: 0, data }];
  let child: CanvasData = data;
  // Grow frames only as needed, from the immediate parent outward. Persisted
  // dimensions are authoritative; measured browser heights never participate.
  for (const frame of parent ? [parent, ...ancestry(live, parent)] : []) {
    writable(live, frame);
    const left = Math.min(Number(frame.x), Number(child.x) - 24);
    const top = Math.min(Number(frame.y), Number(child.y) - 48);
    const right = Math.max(
      Number(frame.x) + Number(frame.width),
      Number(child.x) + Number(child.width) + 24,
    );
    const bottom = Math.max(
      Number(frame.y) + Number(frame.height),
      Number(child.y) + Number(child.height) + 24,
    );
    const expanded = {
      ...frame,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
    if (
      (["x", "y", "width", "height"] as const).some(
        (k) => expanded[k] !== frame[k],
      )
    )
      changes.push({
        id: frame.id,
        expectedRevision: live.get(frame.id)!.revision,
        data: { ...expanded, updatedAt: context.now },
      });
    child = expanded;
  }
  return finishPlan(
    rows,
    changes,
    [],
    {
      canvas_id: context.canvasId,
      note_id: id,
      task_ids: blocks.map((b) => b.id),
      revision: 1,
      changed: true,
    },
    context.canvasId,
  );
}

export function planCanvasCommand(
  rows: readonly Row[],
  command: CanvasCommand,
  context: CommandContext,
): CommandPlan {
  const live = canvasRows(rows, context.canvasId),
    used = idSet(rows);
  const input = parseToolInput(command.name, command.input);
  if (input.canvas_id !== context.canvasId)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Command canvas does not match context.",
    );
  switch (command.name) {
    case "create_tasks": {
      const input = parseToolInput(command.name, command.input);
      if ("note_id" in input.target) {
        const row = existingNote(
          live,
          input.target.note_id,
          input.expected_revision!,
        );
        const blocks = createBlocks(input.items, live, context, used);
        const plan = notePlan(
          rows,
          row,
          {
            ...row.data,
            blocks: [...row.data.blocks, ...blocks],
            ...(row.data.blockOrder
              ? {
                  blockOrder: [
                    ...row.data.blockOrder,
                    ...blocks.map((b) => b.id),
                  ],
                }
              : {}),
          },
          [],
          context,
        );
        plan.result.task_ids = blocks.map((b) => b.id);
        return plan;
      }
      return newNote(
        rows,
        live,
        input.target.section_id,
        createBlocks(input.items, live, context, used),
        { note_kind: "checklist" },
        context,
        used,
      );
    }
    case "create_note": {
      const input = parseToolInput(command.name, command.input);
      return newNote(
        rows,
        live,
        input.target.section_id,
        createBlocks(input.blocks, live, context, used),
        input,
        context,
        used,
      );
    }
    case "update_task": {
      const input = parseToolInput(command.name, command.input),
        row = existingNote(live, input.note_id, input.expected_revision);
      snapshot(row.data, input.task_id);
      const next = {
        ...row.data,
        blocks: row.data.blocks.map((b) =>
          b.id === input.task_id
            ? applyPatch(b, input.patch, live, context)
            : b,
        ),
      };
      const plan = notePlan(rows, row, next, [], context);
      plan.result.task_id = input.task_id;
      return plan;
    }
    case "delete_task": {
      const input = parseToolInput(command.name, command.input),
        row = existingNote(live, input.note_id, input.expected_revision);
      const removed = snapshot(row.data, input.task_id);
      const next = {
        ...row.data,
        blocks: row.data.blocks.filter((b) => b.id !== input.task_id),
        ...(row.data.blockOrder
          ? {
              blockOrder: row.data.blockOrder.filter(
                (id) => id !== input.task_id,
              ),
            }
          : {}),
      };
      const plan = notePlan(rows, row, next, [removed], context);
      plan.result.task_id = input.task_id;
      return plan;
    }
    case "update_note": {
      const input = parseToolInput(command.name, command.input),
        row = existingNote(live, input.note_id, input.expected_revision);
      const edits = input.edits ?? [],
        removals = input.remove_task_ids ?? [];
      const editIds = new Set(edits.map((e) => e.task_id)),
        removeIds = new Set(removals);
      if (
        editIds.size !== edits.length ||
        removeIds.size !== removals.length ||
        removals.some((id) => editIds.has(id))
      )
        throw new McpBusinessError(
          "VALIDATION_ERROR",
          "Each task may be edited or removed once.",
        );
      for (const edit of edits) snapshot(row.data, edit.task_id);
      const snapshots = row.data.blocks
        .filter((b) => removeIds.has(b.id))
        .map((b) => snapshot(row.data, b.id));
      if (snapshots.length !== removals.length)
        throw new McpBusinessError(
          "NOT_FOUND",
          "Task was not found in this note.",
        );
      const appended = createBlocks(
        input.append_blocks ?? [],
        live,
        context,
        used,
      );
      const next: NoteData = {
        ...row.data,
        blocks: row.data.blocks
          .filter((b) => !removeIds.has(b.id))
          .map((b) => {
            const edit = edits.find((e) => e.task_id === b.id);
            return edit ? applyPatch(b, edit.patch, live, context) : b;
          })
          .concat(appended),
        ...(input.note_kind !== undefined ? { noteKind: input.note_kind } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(row.data.blockOrder
          ? {
              blockOrder: [
                ...row.data.blockOrder.filter((id) => !removeIds.has(id)),
                ...appended.map((b) => b.id),
              ],
            }
          : {}),
      };
      return notePlan(rows, row, next, snapshots, context);
    }
  }
}

export function planRestoreBlocks(
  rows: readonly Row[],
  snapshots: readonly DeletionSnapshot[],
  context: CommandContext,
): CommandPlan {
  const live = canvasRows(rows, context.canvasId),
    pending = new Map<string, NoteData>(),
    used = idSet(rows);
  if (!snapshots.length || snapshots.length > 100)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Restore requires 1–100 deleted blocks.",
    );
  const key = (noteId: string, taskId: string) =>
    JSON.stringify([noteId, taskId]);
  const remaining = new Map(snapshots.map((s) => [key(s.noteId, s.taskId), s]));
  if (remaining.size !== snapshots.length)
    throw new McpBusinessError(
      "REVISION_CONFLICT",
      "A deleted task was selected more than once.",
    );
  const ordered: DeletionSnapshot[] = [];
  // Restore right-hand neighbors first, including when every block was deleted.
  // Original adjacency, rather than caller order, determines the final order.
  while (remaining.size) {
    const next = [...remaining.values()].find(
      (s) => !s.nextTaskId || !remaining.has(key(s.noteId, s.nextTaskId)),
    );
    if (!next)
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Deleted block adjacency contains a cycle.",
      );
    ordered.push(next);
    remaining.delete(key(next.noteId, next.taskId));
  }
  for (const saved of ordered) {
    const row = noteRow(live, saved.noteId);
    writable(live, row.data);
    if (saved.taskId !== saved.block.id || used.has(saved.taskId))
      throw new McpBusinessError(
        "REVISION_CONFLICT",
        "A restored task identifier already exists.",
      );
    used.add(saved.taskId);
    const note = pending.get(row.id) ?? structuredClone(row.data);
    let at = saved.nextTaskId
      ? note.blocks.findIndex((b) => b.id === saved.nextTaskId)
      : -1;
    if (at < 0 && saved.previousTaskId) {
      const previous = note.blocks.findIndex(
        (b) => b.id === saved.previousTaskId,
      );
      if (previous >= 0) at = previous + 1;
    }
    if (at < 0) at = note.blocks.length;
    note.blocks.splice(at, 0, structuredClone(saved.block));
    if (note.blockOrder) {
      let orderAt = saved.nextTaskId
        ? note.blockOrder.indexOf(saved.nextTaskId)
        : -1;
      if (orderAt < 0 && saved.previousTaskId) {
        const previous = note.blockOrder.indexOf(saved.previousTaskId);
        if (previous >= 0) orderAt = previous + 1;
      }
      note.blockOrder.splice(
        orderAt < 0 ? note.blockOrder.length : orderAt,
        0,
        saved.taskId,
      );
    }
    pending.set(row.id, note);
  }
  const changes = [...pending].flatMap(([id, next]) =>
    noteChange(noteRow(live, id), next, context),
  );
  return finishPlan(
    rows,
    changes,
    [],
    {
      canvas_id: context.canvasId,
      changed: changes.length > 0,
      notes: changes.map((c) => ({
        note_id: c.id,
        revision: c.expectedRevision + 1,
      })),
      task_ids: snapshots.map((s) => s.taskId),
    },
    context.canvasId,
  );
}
