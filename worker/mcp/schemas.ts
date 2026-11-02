import { z } from "zod";
import { McpBusinessError } from "./errors";

const id = z.string().min(1).max(256);
const cursor = z.string().min(1).max(2048).optional();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export function normalizeInstant(value: string): string {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(
      value,
    );
  if (!m)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Dates require an RFC 3339 timestamp with a timezone.",
    );
  const [, year, month, day, hour, minute, second, , zone] = m;
  const y = Number(year),
    mo = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validZone =
    zone.toUpperCase() === "Z" ||
    (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59);
  const time = Date.parse(value);
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > days[mo - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    !validZone ||
    !Number.isFinite(time)
  )
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Invalid calendar date or timezone.",
    );
  const result = new Date(time).toISOString();
  if (result.length !== 24)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Date is outside the supported range.",
    );
  return result;
}
const instant = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    try {
      return normalizeInstant(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid RFC 3339 timestamp" });
      return z.NEVER;
    }
  });
const run = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(32000) }),
  z.strictObject({
    type: z.literal("ref"),
    target_id: id,
    label: z.string().max(2000),
  }),
]);
const patchShape = {
  text: z.string().max(32000).optional(),
  runs: z.array(run).max(200).optional(),
  remark: z.string().max(8000).nullable().optional(),
  done: z.boolean().optional(),
  due_at: instant.nullable().optional(),
  due_start_at: instant.nullable().optional(),
};
const patch = z
  .strictObject(patchShape)
  .refine(
    (v) => !(v.text !== undefined && v.runs !== undefined),
    "Use text or runs, not both",
  );
const newBlock = z
  .strictObject(patchShape)
  .refine(
    (v) => (v.text !== undefined) !== (v.runs !== undefined),
    "A block needs text or runs",
  );
const blocks = z.array(newBlock).min(1).max(50);
const sectionTarget = z.strictObject({ section_id: id });
const target = z.union([z.strictObject({ note_id: id }), sectionTarget]);
const style = {
  note_kind: z.enum(["text", "checklist"]).optional(),
  color: z
    .enum(["paper", "sage", "sand", "rose", "blue", "lavender"])
    .optional(),
};
const write = { canvas_id: id, request_id: id };
const noteMutation = { ...write, note_id: id, expected_revision: revision };
export const toolSchemas = {
  list_canvases: z.strictObject({
    cursor,
    limit: z.number().int().min(1).max(50).default(20),
  }),
  get_canvas: z.strictObject({ canvas_id: id }),
  search_content: z
    .strictObject({
      canvas_id: id,
      query: z
        .string()
        .max(2000)
        .transform((v) => v.toLowerCase())
        .default(""),
      kind: z.enum(["task", "note"]).default("task"),
      done: z.boolean().optional(),
      due_from: instant.optional(),
      due_to: instant.optional(),
      created_by: id.optional(),
      section_id: id.optional(),
      include_archived: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
      cursor,
    })
    .refine(
      (v) =>
        v.kind !== "note" ||
        [v.done, v.due_from, v.due_to, v.created_by].every(
          (v) => v === undefined,
        ),
      "Task filters require kind=task",
    )
    .refine(
      (v) => !v.due_from || !v.due_to || v.due_from < v.due_to,
      "Date range requires from < to",
    ),
  get_content: z
    .strictObject({
      canvas_id: id,
      note_id: id,
      task_id: id.optional(),
      include_archived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
      cursor,
    })
    .refine(
      (v) => !v.task_id || !v.cursor,
      "A single task does not accept a cursor",
    ),
  create_tasks: z
    .strictObject({
      ...write,
      target,
      items: blocks,
      expected_revision: revision.optional(),
    })
    .refine(
      (v) =>
        "note_id" in v.target
          ? v.expected_revision !== undefined
          : v.expected_revision === undefined,
      "Only an existing note requires expected_revision",
    ),
  update_task: z.strictObject({ ...noteMutation, task_id: id, patch }),
  delete_task: z.strictObject({ ...noteMutation, task_id: id }),
  create_note: z.strictObject({
    ...write,
    target: sectionTarget,
    blocks,
    ...style,
  }),
  update_note: z.strictObject({
    ...noteMutation,
    edits: z
      .array(z.strictObject({ task_id: id, patch }))
      .max(100)
      .optional(),
    append_blocks: blocks.optional(),
    remove_task_ids: z.array(id).max(100).optional(),
    ...style,
  }),
};
export type ToolName = keyof typeof toolSchemas;
export type WriteToolName =
  | "create_tasks"
  | "update_task"
  | "delete_task"
  | "create_note"
  | "update_note";
export type QueryToolName = "get_canvas" | "search_content" | "get_content";
export type ToolInput<N extends ToolName> = z.output<(typeof toolSchemas)[N]>;
export type TaskPatch = z.output<typeof patch>;
export type NewBlockInput = z.output<typeof newBlock>;
export function parseToolInput<N extends ToolName>(
  name: N,
  input: unknown,
): ToolInput<N> {
  const schema = toolSchemas[name];
  if (!schema) throw new McpBusinessError("VALIDATION_ERROR", "Unknown tool.");
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Invalid tool input.",
      false,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  return parsed.data as ToolInput<N>;
}
