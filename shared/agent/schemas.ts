import { z } from "zod";
import type {
  AcceptanceCriterion,
  AgentCommand,
  BatchItem,
  CommandEnvelope,
  ExecutionSnapshot,
  PlanTask,
  ProjectSummary,
  RunOutcome,
  RunnerEvent,
  TaskSpec,
} from "./contracts";
import { AgentValidationError } from "./errors";
import { normalizeAgentDeadline } from "./deadlines";
import { MAX_PLAN_TASKS, sortPlan } from "./sort-plan";
import { approvalDetailsSchema, executionPermissionsSchema, inputQuestionSchema } from "./permissions";

const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value),
    "Invalid identifier",
  );
const text = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => value.trim().length > 0, "Text is required");
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveRevision = revision.min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
const ids = (max: number) =>
  z.array(id).max(max).refine(unique, "Duplicate identifiers");
const instant = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    try {
      return normalizeAgentDeadline(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid timestamp or missing timezone",
      });
      return z.NEVER;
    }
  });
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .transform((value) => value.replaceAll("\\", "/"))
  .refine(
    (value) =>
      !/[\x00-\x1f\x7f<>:"|?*]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Expected a project-relative file path",
  );
const predicate = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("exists") }),
  z.strictObject({
    type: z.literal("jsonSchema"),
    schema: z.union([z.boolean(), z.record(z.string(), z.json())]),
  }),
  z.strictObject({ type: z.literal("textContains"), text: text(8000) }),
]);
const criterionBase = { id, description: text(4000), required: z.boolean() };
export const acceptanceCriterionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...criterionBase, kind: z.literal("command"), checkId: id }),
  z.strictObject({
    ...criterionBase,
    kind: z.literal("artifact"),
    relativePath,
    predicate,
  }),
  z.strictObject({ ...criterionBase, kind: z.literal("human") }),
]) satisfies z.ZodType<AcceptanceCriterion>;
const taskFields = {
  text: text(32000),
  instruction: text(32000),
  acceptance: z
    .array(acceptanceCriterionSchema)
    .min(1)
    .max(50)
    .refine(
      (values) => unique(values.map((value) => value.id)),
      "Duplicate criterion identifiers",
    )
    .refine(
      (values) => values.some((value) => value.required),
      "At least one required acceptance criterion is needed",
    ),
  dependsOn: ids(MAX_PLAN_TASKS).default([]),
  priority: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .default(2),
  dueAt: instant.nullable().default(null),
};
export const planTaskSchema = z.strictObject({
  taskId: id,
  ...taskFields,
}) satisfies z.ZodType<PlanTask>;
const taskRefSchema = z.strictObject({ canvasId: id, noteId: id, taskId: id });
export const taskSpecSchema = z.strictObject({
  ...taskFields,
  taskRef: taskRefSchema,
  planId: id,
  sourceTextHash: hash,
  specRevision: positiveRevision,
  specHash: hash,
  specStatus: z.enum(["ready", "stale"]),
  createdByMessageId: id,
}) satisfies z.ZodType<TaskSpec>;
export const agentCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create_plan"),
    requestId: id,
    bindingId: id,
    canvasId: id,
    sectionId: id,
    createdByMessageId: id,
    tasks: z.array(planTaskSchema).min(1).max(MAX_PLAN_TASKS),
  }),
  z.strictObject({
    type: z.literal("reorder_plan"),
    requestId: id,
    planId: id,
    expectedRevision: revision,
    order: ids(MAX_PLAN_TASKS).min(1),
  }),
]) satisfies z.ZodType<AgentCommand>;

const summaryItem = z.strictObject({
  text: text(8000),
  evidenceRef: id.optional(),
});
const summaryItems = z.array(summaryItem).max(100);
export const projectSummarySchema = z.strictObject({
  overview: text(16000),
  completed: summaryItems,
  inProgress: summaryItems,
  pending: summaryItems,
  blockers: summaryItems,
  verification: summaryItems,
  uncertainties: summaryItems,
}) satisfies z.ZodType<ProjectSummary>;
export const runOutcomeSchema = z
  .strictObject({
    runId: id,
    taskId: id.nullable(),
    outcome: z.enum(["done", "blocked", "needs_input", "failed"]),
    summary: text(16000),
    changedFiles: z.array(relativePath).max(2000),
    evidenceRefs: ids(200),
    remainingIssues: z.array(text(8000)).max(100),
    nextTaskNotes: z.array(text(8000)).max(100),
  })
  .refine(
    (value) => value.outcome !== "done" || value.remainingIssues.length === 0,
    "A done outcome cannot have unresolved issues",
  ) satisfies z.ZodType<RunOutcome>;

export const runnerCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create_run"),
    requestId: id,
    runId: id,
    bindingId: id,
    bindingRevision: positiveRevision,
    kind: z.enum(["summary", "task"]),
    snapshotId: id,
    payloadHash: hash,
  }),
  z.strictObject({
    type: z.literal("continue_run"),
    requestId: id,
    runId: id,
    expectedTurnId: id,
    message: text(32000),
    mode: z.enum(["reply", "steer"]),
  }),
  z.strictObject({ type: z.literal("cancel_run"), requestId: id, runId: id }),
]);
export const commandEnvelopeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    commandId: id,
    runId: id,
    bindingRevision: positiveRevision,
    authEpoch: positiveRevision,
    leaseEpoch: positiveRevision,
    payloadHash: hash,
    issuedAt: instant,
    expiresAt: instant,
    payload: runnerCommandSchema,
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (value.expiresAt <= value.issuedAt)
      issue("Expiry must follow issue time");
    if (value.runId !== value.payload.runId)
      issue("Envelope and payload must refer to the same run");
    if (value.payload.type === "create_run") {
      if (value.bindingRevision !== value.payload.bindingRevision)
        issue("Binding revisions must match");
    }
  }) satisfies z.ZodType<CommandEnvelope>;

const eventBase = {
  protocolVersion: z.literal(1),
  eventId: id,
  runnerId: id,
  runId: id,
  threadId: id.nullable(),
  turnId: id.nullable(),
  seq: positiveRevision,
  occurredAt: instant,
};
const turnIdentity = { threadId: id, turnId: id };
const verificationResult = z.strictObject({
  criterionId: id,
  status: z.enum(["passed", "failed", "needs_input"]),
  evidenceRefs: ids(100),
  exitCode: z
    .number()
    .int()
    .min(-2147483648)
    .max(2147483647)
    .nullable()
    .optional(),
  outputHash: hash.optional(),
  failureKind: z.enum(["predicate", "command_exit", "timeout", "access_denied", "unsupported", "error"]).optional(),
  message: z.string().max(1000).optional(),
});
export const runnerEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...eventBase,
      type: z.literal("run.accepted"),
      threadId: z.null(),
      turnId: z.null(),
      payload: z.strictObject({ status: z.enum(["queued", "preparing"]) }),
    }),
    z.strictObject({
      ...eventBase,
      type: z.literal("thread.created"),
      threadId: id,
      turnId: z.null(),
      payload: z.strictObject({}),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("turn.started"),
      payload: z.strictObject({}),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("output.delta"),
      payload: z.strictObject({ text: z.string().min(1).max(32000) }),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("approval.requested"),
      payload: z.strictObject({ requestId: id, description: text(8000), details:approvalDetailsSchema.optional() }),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("input.requested"),
      payload: z.strictObject({
        requestId: id,
        questions: z
          .array(inputQuestionSchema)
          .min(1)
          .max(20)
          .refine(
            (questions) => unique(questions.map((q) => q.id)),
            "Duplicate question identifiers",
          ),
      }),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type:z.literal("request.resolved"),
      payload:z.strictObject({requestId:id,status:z.enum(["responded","expired","cancelled"]),reason:z.string().max(1000).optional()}),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("turn.completed"),
      payload: z.strictObject({
        status: z.enum(["completed", "failed", "interrupted"]),
        outcome: runOutcomeSchema.nullable(),
        summary: projectSummarySchema.nullable(),
        error: text(8000).nullable(),
      }),
    }),
    z.strictObject({
      ...eventBase,
      ...turnIdentity,
      type: z.literal("verification.completed"),
      payload: z.strictObject({
        results: z
          .array(verificationResult)
          .min(1)
          .max(50)
          .refine(
            (results) => unique(results.map((result) => result.criterionId)),
            "Duplicate verification results",
          ),
      }),
    }),
    z.strictObject({
      ...eventBase,
      type: z.literal("run.cancelled"),
      payload: z.strictObject({ reason: text(8000) }),
    }),
    z.strictObject({
      ...eventBase,
      type: z.literal("heartbeat"),
      payload: z.strictObject({
        leaseEpoch: positiveRevision,
        connectionEpoch: positiveRevision,
      }),
    }),
  ])
  .superRefine((event, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (event.turnId !== null && event.threadId === null)
      issue("A turn requires a thread");
    if (event.type === "turn.completed") {
      const { outcome, summary, status, error } = event.payload;
      if (outcome && outcome.runId !== event.runId)
        issue("Outcome run does not match event run");
      if (outcome && summary) issue("Summary and task results are distinct");
      if (status !== "completed" && (outcome?.outcome === "done" || summary))
        issue("A failed or interrupted turn cannot report completion");
      if (status === "completed" && error)
        issue("A completed turn cannot carry a terminal error");
    }
  }) satisfies z.ZodType<RunnerEvent>;

const snapshotBase = {
  executionPermissions: executionPermissionsSchema.optional(),
  snapshotId: id,
  runId: id,
  ownerId: id,
  bindingId: id,
  bindingRevision: positiveRevision,
  workspaceId: id,
  summaryRevision: revision,
  memoryEpoch: revision,
  sourceRefs: ids(200),
  payloadHash: hash,
  capturedAt: instant,
  allowedCheckIds: ids(100),
  context: z.strictObject({
    projectSummary: projectSummarySchema.nullable(),
    decisions: z.array(text(8000)).max(100),
    previousTaskNotes: z.array(text(8000)).max(100),
    gitBaseline: z.strictObject({
      commit: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .nullable(),
      branch: text(256).nullable(),
      dirty: z.boolean(),
    }),
  }),
};
const batchItemSchema = z.strictObject({
  taskId: id,
  text: taskFields.text,
  instruction: taskFields.instruction,
  acceptance: taskFields.acceptance,
  source: z
    .strictObject({
      taskRef: taskRefSchema,
      generation: revision.min(1),
      specRevision: revision.min(1),
    })
    .optional(),
}) satisfies z.ZodType<BatchItem>;
const batchSchema = z.strictObject({
  managed: z.literal(true).optional(),
  items: z
    .array(batchItemSchema)
    .min(1)
    .max(MAX_PLAN_TASKS)
    .refine(
      (items) => unique(items.map(({ taskId }) => taskId)),
      "Duplicate batch task identifiers",
    ),
  autoComplete: z.boolean().optional(),
});
const orderedJson = (value: unknown) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const executionSnapshotSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("summary"),
      task: z.null(),
    }),
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("task"),
      task: taskSpecSchema,
      batch: batchSchema.optional(),
    }),
  ])
  .superRefine((snapshot, ctx) => {
    if(snapshot.kind === "summary" && snapshot.executionPermissions && snapshot.executionPermissions.profile !== "read_only")
      ctx.addIssue({code:"custom",message:"Project summaries require read-only permissions"});
    if (snapshot.kind !== "task") return;
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (snapshot.task.specStatus !== "ready")
      issue("Stale task specifications cannot be dispatched");
    if (snapshot.task.dependsOn.includes(snapshot.task.taskRef.taskId))
      issue("A task cannot depend on itself");
    const first = snapshot.batch?.items[0];
    if (
      first &&
      (first.taskId !== snapshot.task.taskRef.taskId ||
        first.text !== snapshot.task.text ||
        first.instruction !== snapshot.task.instruction ||
        (first.source &&
          (orderedJson(first.source.taskRef) !==
            orderedJson(snapshot.task.taskRef) ||
            first.source.specRevision !== snapshot.task.specRevision)) ||
        orderedJson(first.acceptance) !== orderedJson(snapshot.task.acceptance))
    )
      issue("The first batch item must match the dispatched task");
    if (snapshot.batch) {
      const { items, autoComplete } = snapshot.batch;
      if (autoComplete && items.some((item) => !item.source))
        issue("Automatic completion requires checklist sources");
      if (
        items.some(
          ({ source, taskId }) =>
            source &&
            (source.taskRef.taskId !== taskId ||
              source.taskRef.canvasId !== snapshot.task.taskRef.canvasId),
        )
      )
        issue("Checklist source must identify its batch item and canvas");
    }
    const tasks = snapshot.batch?.items ?? [snapshot.task];
    for (const task of tasks)
      for (const criterion of task.acceptance)
        if (
          criterion.kind === "command" &&
          !snapshot.allowedCheckIds.includes(criterion.checkId)
        )
          issue("Acceptance command is not registered for this snapshot");
  }) satisfies z.ZodType<ExecutionSnapshot>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const tooManyTasks = result.error.issues.some(
    (issue) =>
      issue.code === "too_big" &&
      issue.path.length === 1 &&
      issue.path[0] === "tasks",
  );
  throw new AgentValidationError(
    tooManyTasks ? "LIMIT_EXCEEDED" : "VALIDATION_ERROR",
    tooManyTasks ? "一个计划最多包含 50 条任务。" : "任务数据格式无效。",
    {
      issues: result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    },
  );
}

export function parseAgentCommand(value: unknown): AgentCommand {
  const command = parse(agentCommandSchema, value);
  if (command.type === "create_plan") sortPlan(command.tasks);
  return command;
}
export function parseRunnerEvent(value: unknown): RunnerEvent {
  return parse(runnerEventSchema, value);
}
export function parseRunOutcome(value: unknown): RunOutcome {
  return parse(runOutcomeSchema, value);
}
export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  return parse(commandEnvelopeSchema, value);
}
export function parseExecutionSnapshot(value: unknown): ExecutionSnapshot {
  return parse(executionSnapshotSchema, value);
}
