import { z } from "zod";
import { todoPages } from "../src/canvas/todoPages.js";
import type { AcceptanceCriterion } from "../shared/agent/contracts";
import {
  checklistCreateTasksSchema as createTasks,
  checklistMutationSchema as mutationSchema,
} from "../shared/agent/checklist";
import { planCanvasCommand } from "./canvas-commands";
import { check } from "./http";
import type { CommandContext, NoteData, TaskBlock } from "./mcp/contracts";
import { blockText } from "./mcp/domain";
import { canonicalJson } from "./mcp/room-storage";
import type { CanvasData, Change, Row } from "./types";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x20\x7f]+$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const generation = revision.min(1);
const taskFields = { noteId: id, taskId: id };
const expectedTask = { ...taskFields, generation, specRevision: revision };
const createReceiptSchema = z.strictObject({
  operationId: id,
  createdTasks: z.array(z.strictObject(taskFields)).min(1).max(50),
});
const inputSchema = z.discriminatedUnion("action", [
  ...mutationSchema.options,
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("create_receipt"),
    requestId: id,
    tasks: createTasks,
  }),
  z.strictObject({ action: z.literal("receipt"), request: mutationSchema }),
  z.strictObject({
    action: z.literal("abandon_request"),
    request: mutationSchema,
  }),
  z.strictObject({
    action: z.literal("snapshot"),
    tasks: z.array(z.strictObject(expectedTask)).min(1).max(50),
  }),
  z.strictObject({
    action: z.literal("validate"),
    tasks: z.array(z.strictObject(expectedTask)).min(1).max(50),
    allowCompleted: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("finalize"),
    requestId: id,
    runId: id,
    completedTurnId: id,
    source: z.strictObject({
      taskRef: z.strictObject({ canvasId: id, ...taskFields }),
      generation,
      specRevision: generation,
    }),
  }),
]);

const checklist = (data: CanvasData | null): data is NoteData =>
  data?.type === "note" && data.noteKind === "checklist";
const source = (block: TaskBlock) =>
  canonicalJson({ runs: block.runs, remark: block.remark?.text ?? null });
const semantic = (block: TaskBlock) =>
  canonicalJson({
    source: source(block),
    done: block.done,
    completedAt: block.completedAt,
    dueAt: block.dueAt ?? null,
    dueStartAt: block.dueStartAt ?? null,
  });

export function initializeAgentChecklist(
  sql: SqlStorage,
  rows: () => readonly Row[],
) {
  const existed = sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_task_versions'",
    )
    .toArray().length;
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_task_versions(
    note_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
    semantic TEXT, PRIMARY KEY(note_id,task_id));
    CREATE TABLE IF NOT EXISTS agent_task_specs(
    note_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    source TEXT, instruction TEXT NOT NULL, acceptance TEXT NOT NULL,
    PRIMARY KEY(note_id,task_id));
    CREATE TABLE IF NOT EXISTS agent_checklist_receipts(
    owner_id TEXT NOT NULL, binding_id TEXT NOT NULL, request_id TEXT NOT NULL,
    payload TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id,binding_id,request_id));
    CREATE TABLE IF NOT EXISTS agent_checklist_seals(
    owner_id TEXT NOT NULL, binding_id TEXT NOT NULL, request_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(owner_id,binding_id,request_id));`);
  if (
    !sql
      .exec(
        "SELECT name FROM pragma_table_info('agent_task_specs') WHERE name='acceptance_checks'",
      )
      .toArray().length
  )
    sql.exec(
      "ALTER TABLE agent_task_specs ADD COLUMN acceptance_checks TEXT NOT NULL DEFAULT '[]'",
    );
  if (!existed)
    for (const row of rows())
      if (!row.deleted) trackAgentTaskVersions(sql, null, row.data);
}

export function trackAgentTaskVersions(
  sql: SqlStorage,
  before: CanvasData | null,
  after: CanvasData | null,
) {
  if (!checklist(before) && !checklist(after)) return;
  const noteId = (before ?? after)!.id;
  const previous = new Map(
    (checklist(before) ? before.blocks : []).map((b) => [b.id, b]),
  );
  const next = new Map(
    (checklist(after) ? after.blocks : []).map((b) => [b.id, b]),
  );
  for (const taskId of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(taskId),
      block = next.get(taskId);
    const oldValue = old ? semantic(old) : null,
      value = block ? semantic(block) : null;
    if (value === oldValue) continue;
    sql.exec(
      `INSERT INTO agent_task_versions(note_id,task_id,generation,semantic) VALUES(?,?,1,?)
      ON CONFLICT(note_id,task_id) DO UPDATE SET generation=generation+1,semantic=excluded.semantic`,
      noteId,
      taskId,
      value,
    );
    if (old && (!block || source(old) !== source(block)))
      sql.exec(
        "UPDATE agent_task_specs SET source=NULL WHERE note_id=? AND task_id=?",
        noteId,
        taskId,
      );
  }
}

type AgentChecklistContext = {
  sql: SqlStorage;
  canvasId: string;
  sectionId: string;
  accountId: string;
  accountName: string;
  bindingId: string;
  rows: () => Row[];
  sequence: () => number;
  commit: (changes: Change[]) => Row[];
};
type Entry = { note: NoteData; block: TaskBlock; locked: boolean };
type Page = { id: string; tasks: Entry[]; objects: CanvasData[] };
type SpecRow = {
  revision: number;
  source: string | null;
  instruction: string;
  acceptance: string;
  acceptance_checks: string;
};
const key = ({ noteId, taskId }: { noteId: string; taskId: string }) =>
  JSON.stringify([noteId, taskId]);
const entryKey = ({ note, block }: Entry) =>
  key({ noteId: note.id, taskId: block.id });

export function runAgentChecklist(
  c: AgentChecklistContext,
  raw: unknown,
): { value: unknown; rows: Row[] } {
  const parsed = inputSchema.safeParse(raw);
  check(parsed.success, "待办清单请求格式无效。");
  const input = parsed.data;
  const findReceipt = (requestId: string) =>
    c.sql
      .exec<{ payload: string; value: string }>(
        "SELECT payload,value FROM agent_checklist_receipts WHERE owner_id=? AND binding_id=? AND request_id=?",
        c.accountId,
        c.bindingId,
        requestId,
      )
      .toArray()[0];
  const findSeal = (requestId: string) =>
    c.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM agent_checklist_seals WHERE owner_id=? AND binding_id=? AND request_id=?",
        c.accountId,
        c.bindingId,
        requestId,
      )
      .toArray()[0];
  // Inspect/seal before looking up the source group. A deleted source does not
  // erase the immutable outcome; absence alone never prevents a late commit.
  if (input.action === "receipt" || input.action === "abandon_request") {
    const original = input.request,
      payload = canonicalJson(original);
    const receipt = findReceipt(original.requestId);
    if (receipt) {
      check(receipt.payload === payload, "请求编号已用于不同内容。", 409);
      return {
        value: { status: "committed", ...JSON.parse(receipt.value) },
        rows: [],
      };
    }
    const seal = findSeal(original.requestId);
    if (seal) {
      check(seal.payload === payload, "请求编号已用于不同内容。", 409);
      return { value: { status: "sealed" }, rows: [] };
    }
    if (input.action === "receipt")
      return { value: { status: "absent" }, rows: [] };
    // The caller owns one transaction spanning this check and the tombstone.
    c.sql.exec(
      "INSERT INTO agent_checklist_seals(owner_id,binding_id,request_id,payload) VALUES(?,?,?,?)",
      c.accountId,
      c.bindingId,
      original.requestId,
      payload,
    );
    return { value: { status: "sealed" }, rows: [] };
  }
  if (input.action === "create_receipt") {
    const receipt = findReceipt(input.requestId);
    if (!receipt) return { value: { found: false }, rows: [] };
    const expected = canonicalJson({
      action: "create",
      requestId: input.requestId,
      tasks: input.tasks,
    });
    check(
      receipt.payload === expected,
      "该编号没有对应相同内容的创建待办回执。",
      409,
    );
    const created = createReceiptSchema.safeParse(JSON.parse(receipt.value));
    check(created.success, "创建回执缺少待办编号。", 409);
    return { value: { found: true, ...created.data }, rows: [] };
  }
  if ("requestId" in input) {
    const seal = findSeal(input.requestId);
    if (seal) {
      check(
        seal.payload === canonicalJson(input),
        "请求编号已用于不同内容。",
        409,
      );
      check(false, "此操作已封存，未修改清单。请核对后发起新操作。", 409);
    }
  }
  const all = c.rows();
  const allById = new Map(all.map((row) => [row.id, row]));
  const page = (rows: Row[]) =>
    (
      todoPages(
        {
          objects: rows.flatMap((row) =>
            !row.deleted && row.data ? [row.data] : [],
          ),
        },
        c.canvasId,
      ) as Page[]
    ).find((item) => item.id === c.sectionId);
  const current = page(all);
  const sectionExists = c.sectionId === "ungrouped" || !!current;
  const tasks = current?.tasks ?? [];
  const entries = new Map(
    tasks
      .filter((item) => checklist(item.note))
      .map((item) => [entryKey(item), item]),
  );
  const version = (noteId: string, taskId: string) =>
    c.sql
      .exec<{ generation: number; semantic: string | null }>(
        "SELECT generation,semantic FROM agent_task_versions WHERE note_id=? AND task_id=?",
        noteId,
        taskId,
      )
      .toArray()[0];
  const spec = (noteId: string, taskId: string) =>
    c.sql
      .exec<SpecRow>(
        "SELECT revision,source,instruction,acceptance,acceptance_checks FROM agent_task_specs WHERE note_id=? AND task_id=?",
        noteId,
        taskId,
      )
      .toArray()[0];
  const list = () => {
    const fresh = c.rows();
    const noteRevisions = new Map(fresh.map((row) => [row.id, row.revision]));
    const visible = (page(fresh)?.tasks ?? []).filter(
      (item) => checklist(item.note) && blockText(item.block).trim(),
    );
    const views = [];
    let bytes = 0;
    for (const item of visible.slice(0, 200)) {
      const { note, block } = item,
        saved = spec(note.id, block.id);
      const row = {
        noteId: note.id,
        taskId: block.id,
        text: blockText(block),
        done: block.done,
        completedAt: block.completedAt,
        noteRevision: noteRevisions.get(note.id),
        generation: version(note.id, block.id)?.generation ?? 1,
        specRevision: saved?.revision ?? 0,
        instruction: saved?.instruction ?? "",
        acceptance: saved?.acceptance ?? "",
        ...(saved?.acceptance_checks && saved.acceptance_checks !== "[]"
          ? {
              acceptanceChecks: JSON.parse(
                saved.acceptance_checks,
              ) as AcceptanceCriterion[],
            }
          : {}),
        locked: item.locked,
        editableText:
          !item.locked && block.runs.every((r) => r.type === "text"),
        specStatus:
          saved && saved.source !== source(block)
            ? "stale"
            : !saved?.instruction || !saved.acceptance
              ? "missing"
              : "ready",
      };
      bytes += new TextEncoder().encode(JSON.stringify(row)).length;
      if (bytes > 800_000) break;
      views.push(row);
    }
    return {
      canvasId: c.canvasId,
      sectionId: c.sectionId,
      sequence: c.sequence(),
      tasks: views,
      ...(views.length < visible.length ? { truncated: true } : {}),
    };
  };
  if (input.action !== "finalize")
    check(sectionExists, "绑定的清单分组不存在。", 409);
  if (input.action === "list") return { value: list(), rows: [] };
  const matching = (
    item: Entry,
    gen: number,
    specRev: number,
    allowCompleted = false,
  ) => {
    const { note, block } = item,
      saved = spec(note.id, block.id),
      state = version(note.id, block.id);
    return !item.locked &&
      (!block.done || allowCompleted) &&
      state?.generation === gen &&
      state.semantic === semantic(block) &&
      saved?.revision === specRev &&
      saved.instruction &&
      saved.acceptance &&
      saved.source === source(block)
      ? saved
      : undefined;
  };
  if (input.action === "snapshot" || input.action === "validate") {
    const order = new Map([...entries.keys()].map((k, index) => [k, index]));
    let previous = -1;
    const ids = new Set<string>();
    const items = input.tasks.map((ref) => {
      const index = order.get(key(ref));
      const item = entries.get(key(ref));
      check(
        item && index !== undefined && index > previous && !ids.has(ref.taskId),
        "待办不存在或执行顺序已经更改。",
        409,
      );
      previous = index;
      ids.add(ref.taskId);
      const saved = matching(
        item,
        ref.generation,
        ref.specRevision,
        input.action === "validate" && input.allowCompleted,
      );
      check(saved, "待办已变化、锁定或缺少有效执行要求。", 409);
      const checks = JSON.parse(
        saved.acceptance_checks,
      ) as AcceptanceCriterion[];
      const acceptance: AcceptanceCriterion[] = checks.length
        ? checks
        : [
            {
              id: "checklist-review",
              kind: "human",
              required: true,
              description: saved.acceptance,
            },
          ];
      return {
        taskId: ref.taskId,
        text: blockText(item.block),
        instruction: saved.instruction,
        acceptance,
        source: {
          taskRef: {
            canvasId: c.canvasId,
            noteId: ref.noteId,
            taskId: ref.taskId,
          },
          generation: ref.generation,
          specRevision: ref.specRevision,
        },
      };
    });
    return { value: { items }, rows: [] };
  }

  const payload = canonicalJson(input);
  const receipt = findReceipt(input.requestId);
  if (receipt) {
    check(receipt.payload === payload, "请求编号已用于不同内容。", 409);
    const saved = JSON.parse(receipt.value);
    return {
      value: input.action === "finalize" ? saved : { ...list(), ...saved },
      rows: [],
    };
  }
  const saveReceipt = (value: unknown) =>
    c.sql.exec(
      "INSERT INTO agent_checklist_receipts(owner_id,binding_id,request_id,payload,value) VALUES(?,?,?,?,?)",
      c.accountId,
      c.bindingId,
      input.requestId,
      payload,
      JSON.stringify(value),
    );
  const now = new Date().toISOString();
  const context: CommandContext = {
    canvasId: c.canvasId,
    accountId: c.accountId,
    accountName: c.accountName,
    now,
    makeId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
  };
  const putSpec = (
    noteId: string,
    block: TaskBlock,
    instruction: string,
    acceptance: string,
    acceptanceChecks: AcceptanceCriterion[] = [],
  ) =>
    c.sql.exec(
      `INSERT INTO agent_task_specs(note_id,task_id,revision,source,instruction,acceptance,acceptance_checks) VALUES(?,?,1,?,?,?,?)
     ON CONFLICT(note_id,task_id) DO UPDATE SET revision=revision+1,source=excluded.source,instruction=excluded.instruction,acceptance=excluded.acceptance,acceptance_checks=excluded.acceptance_checks
     WHERE agent_task_specs.source IS NOT excluded.source OR agent_task_specs.instruction<>excluded.instruction OR agent_task_specs.acceptance<>excluded.acceptance OR agent_task_specs.acceptance_checks<>excluded.acceptance_checks`,
      noteId,
      block.id,
      source(block),
      instruction,
      acceptance,
      canonicalJson(acceptanceChecks),
    );
  const patch = (item: Entry, taskPatch: { text?: string; done?: boolean }) =>
    c.commit(
      planCanvasCommand(
        all,
        {
          name: "update_task",
          input: {
            canvas_id: c.canvasId,
            request_id: input.requestId,
            note_id: item.note.id,
            task_id: item.block.id,
            expected_revision: allById.get(item.note.id)!.revision,
            patch: taskPatch,
          },
        },
        context,
      ).changes,
    );

  let changed: Row[] = [];
  if (input.action === "finalize") {
    const { taskRef, generation: expected, specRevision } = input.source;
    const item = entries.get(key(taskRef));
    const valid =
      sectionExists &&
      taskRef.canvasId === c.canvasId &&
      item &&
      matching(item, expected, specRevision);
    if (valid && item) changed = patch(item, { done: true });
    const result = valid
      ? { status: "applied", taskRef, sequence: c.sequence() }
      : {
          status: "conflict",
          message: "原待办已变化、锁定或移出分组，未自动勾选。",
        };
    saveReceipt(result);
    return { value: result, rows: changed };
  }

  let createdTasks: { noteId: string; taskId: string }[] | undefined;
  if (input.action === "create") {
    if (input.targetNoteId) {
      const row = allById.get(input.targetNoteId);
      check(
        checklist(row?.data ?? null) &&
          current?.objects.some((item) => item.id === input.targetNoteId),
        "目标清单不在当前分组。",
        409,
      );
      check(
        row!.revision === input.expectedNoteRevision,
        "清单已变化，请刷新后重试。",
        409,
      );
    }
    const plan = planCanvasCommand(
      all,
      {
        name: "create_tasks",
        input: {
          canvas_id: c.canvasId,
          request_id: input.requestId,
          target: input.targetNoteId
            ? { note_id: input.targetNoteId }
            : { section_id: c.sectionId },
          ...(input.expectedNoteRevision === undefined
            ? {}
            : { expected_revision: input.expectedNoteRevision }),
          items: input.tasks.map((task) => ({ text: task.text })),
        },
      },
      context,
    );
    changed = c.commit(plan.changes);
    const note = changed.find((row) => row.id === plan.result.note_id)
      ?.data as NoteData;
    const taskIds = plan.result.task_ids as string[];
    createdTasks = taskIds.map((taskId) => ({ noteId: note.id, taskId }));
    for (const [i, taskId] of taskIds.entries()) {
      const { instruction, acceptance, acceptanceChecks } = input.tasks[i];
      putSpec(
        note.id,
        note.blocks.find((block) => block.id === taskId)!,
        instruction,
        acceptance,
        acceptanceChecks,
      );
    }
  } else if (input.action === "save") {
    const item = entries.get(key(input));
    const saved = spec(input.noteId, input.taskId);
    check(
      item &&
        !item.locked &&
        version(input.noteId, input.taskId)?.generation ===
          input.expectedGeneration &&
        (saved?.revision ?? 0) === input.expectedSpecRevision,
      "待办已变化或锁定，请刷新后重试。",
      409,
    );
    let block = item.block;
    if (input.text !== undefined) {
      check(
        block.runs.every((run) => run.type === "text"),
        "包含引用的正文请在原清单编辑。",
        409,
      );
      changed = patch(item, { text: input.text });
      block =
        (changed[0]?.data as NoteData | undefined)?.blocks.find(
          (b) => b.id === block.id,
        ) ?? block;
    }
    putSpec(
      item.note.id,
      block,
      input.instruction,
      input.acceptance,
      input.acceptanceChecks ??
        (saved?.acceptance_checks
          ? (JSON.parse(saved.acceptance_checks) as AcceptanceCriterion[])
          : []),
    );
  } else {
    check(
      c.sequence() === input.expectedSequence,
      "清单顺序已变化，请刷新后重试。",
      409,
    );
    const selected = new Set(input.order.map(key));
    check(selected.size === input.order.length, "排序中包含重复待办。");
    const ordered = input.order.map((ref) => {
      const item = entries.get(key(ref));
      check(
        item && !item.block.done && !item.locked,
        "待办已完成、锁定或移出分组。",
        409,
      );
      return item;
    });
    const pending = [...entries.values()].filter(
      (item) => !item.block.done && blockText(item.block).trim(),
    );
    let i = 0;
    const next = pending.map((item) =>
      selected.has(entryKey(item)) ? ordered[i++] : item,
    );
    const notes = new Map<string, NoteData>();
    if (next.some((item, index) => item !== pending[index]))
      for (const [rank, item] of next.entries()) {
        if (item.block.arrangedOrder === rank) continue;
        check(!item.locked, "排序会修改锁定的待办，未保存。", 409);
        let note = notes.get(item.note.id);
        if (!note) {
          note = structuredClone(item.note);
          note.updatedAt = now;
          notes.set(note.id, note);
        }
        note.blocks.find((b) => b.id === item.block.id)!.arrangedOrder = rank;
      }
    check(notes.size <= 200, "一次最多调整 200 张便签。", 413);
    changed = c.commit(
      [...notes].map(([noteId, data]) => ({
        id: noteId,
        expectedRevision: allById.get(noteId)!.revision,
        data,
      })),
    );
  }
  const saved = {
    operationId: crypto.randomUUID(),
    ...(createdTasks ? { createdTasks } : {}),
  };
  saveReceipt(saved);
  return { value: { ...list(), ...saved }, rows: changed };
}
