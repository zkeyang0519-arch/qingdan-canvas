import type { CanvasData, Row } from "./types";
import type {
  CanvasQuery,
  NoteData,
  QueryContext,
  TaskBlock,
} from "./mcp/contracts";
import { McpBusinessError } from "./mcp/errors";
import { parseToolInput } from "./mcp/schemas";
import {
  ancestry,
  blockText,
  canvasRows,
  flags,
  noteRow,
  objectRow,
  objectText,
  sectionId,
} from "./mcp/domain";
import { boundedPage, filterDigest, serializedBytes } from "./mcp/cursor";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function metadata(live: Map<string, Row>, row: Row & { data: NoteData }) {
  return {
    canvas_id: row.data.boardId,
    note_id: row.id,
    note_kind: row.data.noteKind,
    color: row.data.color,
    revision: row.revision,
    section_id: sectionId(live, row.data),
    parent_id: row.data.parentId,
    ...flags(live, row.data),
  };
}
function taskSummary(
  live: Map<string, Row>,
  row: Row & { data: NoteData },
  block: TaskBlock,
) {
  return {
    ...metadata(live, row),
    task_id: block.id,
    snippet:
      `${blockText(block)}${block.remark ? `\n${block.remark.text}` : ""}`.slice(
        0,
        240,
      ),
    done: block.done,
    created_at: block.createdAt,
    completed_at: block.completedAt,
    due_at: block.dueAt ?? null,
    due_start_at: block.dueStartAt ?? null,
    created_by: block.createdByUserId ?? null,
    created_by_name: block.createdByName ?? null,
  };
}
function taskDetail(
  live: Map<string, Row>,
  row: Row & { data: NoteData },
  block: TaskBlock,
  includeArchived: boolean,
) {
  const runs = block.runs.map((run) => {
    if (run.type === "text") return { type: "text", text: run.text };
    const target = run.targetId ? live.get(run.targetId)?.data : undefined;
    const available =
      !!target &&
      (includeArchived ||
        !(target.type === "collection" || flags(live, target).archived));
    return {
      type: "ref",
      target_id: run.targetId,
      label: run.label,
      display_text: available ? objectText(target).slice(0, 240) : run.label,
      unavailable: !available,
    };
  });
  return {
    ...taskSummary(live, row, block),
    runs,
    remark: block.remark
      ? { text: block.remark.text, updated_at: block.remark.updatedAt }
      : null,
  };
}
function validateSection(live: Map<string, Row>, section?: string) {
  if (section && section !== "ungrouped") objectRow(live, section, "frame");
}

export function queryCanvas(
  rows: readonly Row[],
  query: CanvasQuery,
  context: QueryContext,
): Record<string, unknown> {
  const live = canvasRows(rows, context.canvasId),
    parsed = parseToolInput(query.name, query.input);
  if (parsed.canvas_id !== context.canvasId)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Query canvas does not match context.",
    );
  const notes = [...live.values()].filter(
    (r) => r.data?.type === "note",
  ) as (Row & { data: NoteData })[];
  switch (query.name) {
    case "get_canvas": {
      const visible = notes.filter((r) => !flags(live, r.data).archived);
      const sections = [...live.values()]
        .filter(
          (r) => r.data?.type === "frame" && !flags(live, r.data).archived,
        )
        .sort(
          (a, b) =>
            compare(String(a.data!.createdAt), String(b.data!.createdAt)) ||
            compare(a.id, b.id),
        )
        .map((r) => ({
          section_id: r.id,
          title: String(r.data!.title).slice(0, 240),
          parent_id: r.data!.parentId,
          revision: r.revision,
          ...flags(live, r.data!),
        }));
      const result = {
        canvas_id: context.canvasId,
        name: context.canvasName,
        sequence: context.sequence,
        sections: [
          ...sections,
          {
            section_id: "ungrouped",
            title: "未分组",
            parent_id: null,
            locked: false,
            archived: false,
          },
        ],
        counts: {
          notes: visible.length,
          tasks: visible.reduce((n, r) => n + r.data.blocks.length, 0),
        },
      };
      if (serializedBytes(result) > 256000)
        throw new McpBusinessError(
          "LIMIT_EXCEEDED",
          "Canvas summary exceeds the response size limit.",
        );
      return result;
    }
    case "search_content": {
      const input = parseToolInput(query.name, query.input);
      validateSection(live, input.section_id);
      const candidates = notes.filter(
        (r) =>
          (input.include_archived || !flags(live, r.data).archived) &&
          (!input.section_id ||
            (input.section_id === "ungrouped"
              ? sectionId(live, r.data) === "ungrouped"
              : ancestry(live, r.data).some((p) => p.id === input.section_id))),
      );
      const items: Record<string, unknown>[] = [];
      for (const row of candidates) {
        if (input.kind === "note") {
          const text = row.data.blocks
            .map((b) => `${blockText(b)}\n${b.remark?.text ?? ""}`)
            .join("\n");
          if (text.toLowerCase().includes(input.query))
            items.push({
              ...metadata(live, row),
              snippet: text.slice(0, 240),
              created_at: row.data.createdAt,
              task_count: row.data.blocks.length,
            });
        } else
          for (const block of row.data.blocks) {
            const searchable =
              `${blockText(block)}\n${block.remark?.text ?? ""}`.toLowerCase();
            if (
              !searchable.includes(input.query) ||
              (input.done !== undefined && block.done !== input.done) ||
              (input.created_by !== undefined &&
                block.createdByUserId !== input.created_by) ||
              (input.due_from !== undefined &&
                (!block.dueAt || block.dueAt < input.due_from)) ||
              (input.due_to !== undefined &&
                (!block.dueAt || block.dueAt >= input.due_to))
            )
              continue;
            items.push(taskSummary(live, row, block));
          }
      }
      items.sort(
        (a, b) =>
          compare(String(a.created_at), String(b.created_at)) ||
          compare(String(a.note_id), String(b.note_id)) ||
          compare(String(a.task_id ?? ""), String(b.task_id ?? "")),
      );
      const { cursor, limit, ...filters } = input;
      return boundedPage(
        items,
        limit,
        cursor,
        {
          canvas: context.canvasId,
          filter: filterDigest({ tool: query.name, ...filters }),
          sequence: context.sequence,
        },
        {
          canvas_id: context.canvasId,
          sequence: context.sequence,
          kind: input.kind,
        },
      );
    }
    case "get_content": {
      const input = parseToolInput(query.name, query.input),
        row = noteRow(live, input.note_id);
      if (flags(live, row.data).archived && !input.include_archived)
        throw new McpBusinessError(
          "ARCHIVED",
          "Enable include_archived to read collected content.",
        );
      const envelope = { ...metadata(live, row), sequence: context.sequence };
      if (input.task_id) {
        const block = row.data.blocks.find((b) => b.id === input.task_id);
        if (!block)
          throw new McpBusinessError(
            "NOT_FOUND",
            "Task was not found in this note.",
          );
        const result = {
          ...envelope,
          items: [taskDetail(live, row, block, input.include_archived)],
          next_cursor: null,
        };
        if (serializedBytes(result) > 1024 * 1024)
          throw new McpBusinessError(
            "LIMIT_EXCEEDED",
            "Task exceeds the response size limit.",
          );
        return result;
      }
      const { cursor, limit, ...filters } = input;
      return boundedPage(
        row.data.blocks.map((b) =>
          taskDetail(live, row, b, input.include_archived),
        ),
        limit,
        cursor,
        {
          canvas: context.canvasId,
          filter: filterDigest({ tool: query.name, ...filters }),
          sequence: context.sequence,
          revision: row.revision,
        },
        envelope,
      );
    }
  }
}
