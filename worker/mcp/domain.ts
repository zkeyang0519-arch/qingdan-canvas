import { sharedObject } from "../../shared/canvas-contract.js";
import type { CanvasData, Row, Change } from "../types";
import type {
  CommandPlan,
  DeletionSnapshot,
  NoteData,
  TaskBlock,
} from "./contracts";
import { McpBusinessError } from "./errors";

export function canvasRows(
  rows: readonly Row[],
  canvasId: string,
): Map<string, Row> {
  return new Map(
    rows
      .filter((r) => !r.deleted && r.data?.boardId === canvasId)
      .map((r) => [r.id, r]),
  );
}
export function objectRow(
  rows: Map<string, Row>,
  id: string,
  type?: CanvasData["type"],
): Row & { data: CanvasData } {
  const row = rows.get(id);
  if (!row?.data || (type && row.data.type !== type))
    throw new McpBusinessError(
      "NOT_FOUND",
      "Content was not found in this canvas.",
    );
  return row as Row & { data: CanvasData };
}
export function noteRow(
  rows: Map<string, Row>,
  id: string,
): Row & { data: NoteData } {
  return objectRow(rows, id, "note") as Row & { data: NoteData };
}
export function ancestry(
  rows: Map<string, Row>,
  object: CanvasData,
): CanvasData[] {
  const result: CanvasData[] = [],
    seen = new Set([object.id]);
  let parent = object.parentId;
  while (parent !== null) {
    if (seen.has(parent))
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Container hierarchy contains a cycle.",
      );
    seen.add(parent);
    const container = objectRow(rows, parent).data;
    if (container.type !== "frame" && container.type !== "collection")
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Invalid parent container.",
      );
    result.push(container);
    parent = container.parentId;
  }
  return result;
}
export function flags(rows: Map<string, Row>, object: CanvasData) {
  const chain = ancestry(rows, object);
  return {
    archived: chain.some((p) => p.type === "collection"),
    locked: [object, ...chain].some((p) => p.locked === true),
  };
}
export function writable(rows: Map<string, Row>, object: CanvasData) {
  const state = flags(rows, object);
  if (object.type === "collection" || state.archived)
    throw new McpBusinessError(
      "ARCHIVED",
      "Take this content out of the collection before editing.",
    );
  if (state.locked)
    throw new McpBusinessError("LOCKED", "Content or an ancestor is locked.");
}
export function assertRevision(row: Row, expected: number) {
  if (row.revision !== expected)
    throw new McpBusinessError(
      "REVISION_CONFLICT",
      "Read the latest note before editing.",
      false,
      { note_id: row.id, current_revision: row.revision },
    );
}
export function blockText(block: TaskBlock): string {
  return block.runs
    .map((run) => (run.type === "text" ? run.text : `[[${run.label}]]`))
    .join("");
}
export function objectText(object: CanvasData): string {
  return object.type === "note"
    ? (object as NoteData).blocks.map(blockText).join("\n")
    : String(object.title || object.alt || "");
}
export function sectionId(rows: Map<string, Row>, object: CanvasData): string {
  return (
    ancestry(rows, object)
      .filter((p) => p.type === "frame")
      .at(-1)?.id ?? "ungrouped"
  );
}
export function snapshot(note: NoteData, taskId: string): DeletionSnapshot {
  const index = note.blocks.findIndex((b) => b.id === taskId);
  if (index < 0)
    throw new McpBusinessError("NOT_FOUND", "Task was not found in this note.");
  return {
    noteId: note.id,
    taskId,
    block: structuredClone(note.blocks[index]),
    previousTaskId: note.blocks[index - 1]?.id ?? null,
    nextTaskId: note.blocks[index + 1]?.id ?? null,
  };
}
export function finishPlan(
  rows: readonly Row[],
  changes: Change[],
  deletionSnapshots: DeletionSnapshot[],
  result: Record<string, unknown>,
  canvasId: string,
): CommandPlan {
  const validated = changes.map((change) => {
    if (change.data && JSON.stringify(change.data).length > 256000)
      throw new McpBusinessError(
        "LIMIT_EXCEEDED",
        "Note exceeds the persisted object size limit.",
      );
    try {
      return {
        ...change,
        data: change.data ? (sharedObject(change.data) as CanvasData) : null,
      };
    } catch (error) {
      if (error instanceof McpBusinessError) throw error;
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "The resulting canvas object is invalid.",
      );
    }
  });
  const next = new Map(rows.map((r) => [r.id, r]));
  for (const change of validated)
    next.set(change.id, {
      id: change.id,
      revision: change.expectedRevision + 1,
      deleted: change.data === null,
      data: change.data,
    });
  const live = canvasRows([...next.values()], canvasId);
  if (
    live.size > 2000 ||
    JSON.stringify([...next.values()]).length > 8 * 1024 * 1024
  )
    throw new McpBusinessError("LIMIT_EXCEEDED", "Canvas capacity exceeded.");
  for (const row of live.values()) ancestry(live, row.data!);
  return { changes: validated, deletionSnapshots, result };
}
