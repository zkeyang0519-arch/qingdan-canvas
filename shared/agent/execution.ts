import { z } from "zod";
import { runnerCommandSchema, runnerEventSchema } from "./schemas";
import { MAX_PLAN_TASKS } from "./sort-plan";
import type { QueueView } from "./queue";
import { permissionSelectionSchema, type ExecutionPermissions, type PendingExecutionRequest } from "./permissions";
import type {
  BatchProgress,
  CommandEnvelope,
  ExecutionSnapshot,
  RunnerEvent,
  RunStatus,
} from "./contracts";
export type { BatchProgress } from "./contracts";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x20\x7f]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const executionToolNames = [
  "codex_list_projects",
  "codex_create_run",
  "codex_get_run",
  "codex_continue_run",
  "codex_cancel_run",
] as const;
export type ExecutionToolName = (typeof executionToolNames)[number];
export const executionToolSchemas = {
  codex_list_projects: z.strictObject({
    runnerId: id,
    cursor: z.number().int().min(0).max(10000).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  codex_create_run: runnerCommandSchema.options[0].omit({ type: true }),
  codex_get_run: z.strictObject({
    runId: id,
    afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  codex_continue_run: runnerCommandSchema.options[1].omit({ type: true }),
  codex_cancel_run: runnerCommandSchema.options[2].omit({ type: true }),
};
const manualInstruction = z.string().trim().min(1).max(32000);
const manualAcceptance = z.string().trim().min(1).max(4000);
export const manualIntentSchema = z
  .strictObject({
    requestId: id,
    bindingId: id,
    bindingRevision: revision,
    kind: z.enum(["task", "summary"]),
    executionPermissions: permissionSelectionSchema.optional(),
    instruction: manualInstruction.optional(),
    acceptance: manualAcceptance.optional(),
    items: z
      .array(
        z.strictObject({
          instruction: manualInstruction,
          acceptance: manualAcceptance.optional(),
        }),
      )
      .min(1)
      .max(MAX_PLAN_TASKS)
      .optional(),
    sourceTasks: z
      .array(
        z.strictObject({
          noteId: id,
          taskId: id,
          generation: revision,
          specRevision: revision,
        }),
      )
      .min(1)
      .max(MAX_PLAN_TASKS)
      .refine(
        (items) =>
          new Set(
            items.map(({ noteId, taskId }) => JSON.stringify([noteId, taskId])),
          ).size === items.length,
        "Duplicate checklist sources",
      )
      .optional(),
    autoComplete: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.kind === "summary"
        ? !v.items && !v.sourceTasks && v.autoComplete === undefined
        : v.sourceTasks
          ? !v.items && !v.instruction && !v.acceptance
          : v.autoComplete === undefined &&
            (v.items ? !v.instruction && !v.acceptance : !!v.instruction),
    "Provide a task instruction, ordered batch items, or checklist sources",
  );
export const executionToolsRequestSchema = z.strictObject({
  bindingId: id,
  name: z.enum(executionToolNames),
  arguments: z.record(z.string(), z.unknown()),
});
export const projectContextSchema = z.strictObject({
  workspaceId: id,
  capturedAt: timestamp,
  gitBaseline: z.strictObject({
    commit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    branch: z.string().min(1).max(256).nullable(),
    dirty: z.boolean(),
  }),
  threads: z
    .array(
      z.strictObject({
        threadId: id,
        title: z.string().max(200),
        updatedAt: timestamp,
      }),
    )
    .max(30),
});
export type ExecutionProjectContext = z.infer<typeof projectContextSchema>;
export const nativeSummaryContextSchema = projectContextSchema.pick({
  workspaceId: true,
  capturedAt: true,
  gitBaseline: true,
});
export type NativeSummaryContext = z.infer<typeof nativeSummaryContextSchema>;
export const executionContextSchema = z.strictObject({
  connectionEpoch: revision,
  contexts: z.array(projectContextSchema).max(100),
});
export const executionPollSchema = z.strictObject({
  connectionEpoch: revision,
});
export const executionAckSchema = z.strictObject({
  connectionEpoch: revision,
  commandId: id,
  status: z.enum(["stored", "rejected", "applied", "uncertain"]),
  reason: z.string().max(1000).optional(),
});
export const executionEventsSchema = z.strictObject({
  connectionEpoch: revision,
  events: z.array(runnerEventSchema).min(1).max(50),
});
const reportedBatchItem = z.strictObject({
  taskId: id,
  text: z.string().min(1).max(32000),
  status: z.enum([
    "pending",
    "running",
    "done",
    "blocked",
    "needs_input",
    "failed",
    "cancelled",
  ]),
  summary: z.string().max(16000),
  completedTurnId: id.optional(),
});
const completedTurnBelongsToDoneItem = (
  item: z.infer<typeof reportedBatchItem>,
) => item.completedTurnId === undefined || item.status === "done";
const reportedBatchProgressSchema = z
  .strictObject({
    currentIndex: z.number().int().min(0),
    items: z
      .array(reportedBatchItem.refine(completedTurnBelongsToDoneItem))
      .min(1)
      .max(MAX_PLAN_TASKS),
  })
  .refine((v) => v.currentIndex < v.items.length, "Invalid batch index");
export const batchProgressSchema = z
  .strictObject({
    currentIndex: reportedBatchProgressSchema.shape.currentIndex,
    items: z
      .array(
        reportedBatchItem
          .extend({
            writeback: z
              .strictObject({
                status: z.enum([
                  "pending",
                  "applied",
                  "conflict",
                  "failed",
                  "disabled",
                ]),
                message: z.string().max(2000).optional(),
              })
              .optional(),
          })
          .refine(completedTurnBelongsToDoneItem),
      )
      .min(1)
      .max(MAX_PLAN_TASKS),
  })
  .refine(
    (v) => v.currentIndex < v.items.length,
    "Invalid batch index",
  ) satisfies z.ZodType<BatchProgress>;
// Revision is persisted by native per run, globally across commands. commandId is
// the latest command whose application the report describes. Old-command reports
// may be replayed, but never fold across a newly accepted command.
export const executionReportSchema = z
  .strictObject({
    connectionEpoch: revision,
    runId: id,
    commandId: id,
    revision,
    status: z.enum([
      "preparing",
      "running",
      "waiting_input",
      "waiting_approval",
      "verifying",
      "failed",
      "cancelled",
      "reconciliation_required",
    ]),
    threadId: id.nullable(),
    turnId: id.nullable(),
    terminal: z.boolean(),
    stopConfirmed: z.boolean(),
    error: z.string().max(2000).optional(),
    batch: reportedBatchProgressSchema.optional(),
    summaryContext: nativeSummaryContextSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.turnId && !v.threadId)
      ctx.addIssue({ code: "custom", message: "Turn requires thread" });
    if (v.stopConfirmed && !v.terminal)
      ctx.addIssue({ code: "custom", message: "Stop requires terminal" });
    if (v.status === "cancelled" && (!v.terminal || !v.stopConfirmed))
      ctx.addIssue({
        code: "custom",
        message: "Cancellation requires confirmed stop",
      });
    if (
      v.terminal &&
      ["preparing", "running", "waiting_approval"].includes(v.status)
    )
      ctx.addIssue({
        code: "custom",
        message: "Active state cannot be terminal",
      });
  });
export type ExecutionReport = z.infer<typeof executionReportSchema>;
export type ExecutionAck = z.infer<typeof executionAckSchema>;
export interface ExecutionAckResponse {
  ok: true;
  superseded?: true;
}
export interface ExecutionReportResponse {
  ok: true;
  ignored?: true;
  settled?: true;
}
export interface ExecutionRunView {
  executionPermissions?: ExecutionPermissions;
  pendingRequests?: PendingExecutionRequest[];
  queue?: QueueView;
  sourceBacked?: boolean;
  runId: string;
  bindingId: string;
  workspaceId: string;
  kind: "task" | "summary";
  status: RunStatus;
  threadId: string | null;
  turnId: string | null;
  terminal: boolean;
  stopConfirmed: boolean;
  reportRevision: number;
  commandId: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  error?: string;
  batch?: BatchProgress;
}
export interface ExecutionPollResponse {
  offers: { runId: string; workspaceId: string }[];
  deliveries: { envelope: CommandEnvelope; snapshot: ExecutionSnapshot }[];
}
export interface ExecutionRunResult {
  run: ExecutionRunView;
  events: RunnerEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
  truncated: boolean;
}
export interface ExecutionReceipt {
  runId: string;
  commandId: string;
  status: "accepted";
  acceptedAt: string;
}
