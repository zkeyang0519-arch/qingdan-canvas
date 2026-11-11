// Shared DTOs only. Authentication, persistence and execution are implemented by
// their owning services; parsing a DTO never grants authority to execute it.
import type { ApprovalDetails, ExecutionPermissions, InputQuestion } from "./permissions";
export type TaskRef = { canvasId: string; noteId: string; taskId: string };
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = boolean | { [key: string]: JsonValue };
export type ArtifactPredicate =
  | { type: "exists" }
  | { type: "jsonSchema"; schema: JsonSchema }
  | { type: "textContains"; text: string };
type CriterionBase = { id: string; description: string; required: boolean };
export type AcceptanceCriterion = CriterionBase &
  (
    | { kind: "command"; checkId: string }
    | { kind: "artifact"; relativePath: string; predicate: ArtifactPredicate }
    | { kind: "human" }
  );

export type PlanTask = {
  taskId: string;
  text: string;
  instruction: string;
  acceptance: AcceptanceCriterion[];
  dependsOn: string[];
  priority: 0 | 1 | 2 | 3;
  dueAt: string | null;
};
export type TaskSpec = Omit<PlanTask, "taskId"> & {
  taskRef: TaskRef;
  planId: string;
  sourceTextHash: string;
  specRevision: number;
  specHash: string;
  specStatus: "ready" | "stale";
  createdByMessageId: string;
};
export type PlanSnapshot = {
  planId: string;
  ownerId: string;
  bindingId: string;
  canvasId: string;
  sectionId: string;
  planRevision: number;
  tasks: TaskSpec[];
  order: string[];
};

// Constructed by the server after authentication, never accepted from model input.
export type AgentActor = {
  kind: "agent";
  ownerId: string;
  bindingId: string;
  authEpoch: number;
};
export type CreatePlanInput = {
  requestId: string;
  bindingId: string;
  canvasId: string;
  sectionId: string;
  createdByMessageId: string;
  tasks: PlanTask[];
};
export type ReorderPlanInput = {
  requestId: string;
  planId: string;
  expectedRevision: number;
  order: string[];
};
export type AgentCommand =
  | ({ type: "create_plan" } & CreatePlanInput)
  | ({ type: "reorder_plan" } & ReorderPlanInput);

export type RunKind = "summary" | "task";
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "verifying"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "reconciliation_required";
export type BatchStatus =
  "draft" | "running" | "paused" | "blocked" | "completed" | "cancelled";
export type ConnectionStatus = "online" | "offline";
export type VerifyState =
  "pending" | "running" | "passed" | "failed" | "waiting_human";
export type ProjectBinding = {
  bindingId: string;
  ownerId: string;
  canvasId: string;
  sectionId: string;
  runnerId: string;
  workspaceId: string;
  revision: number;
  authEpoch: number;
  enabled: boolean;
};
export type QueueBatch = {
  batchId: string;
  bindingId: string;
  bindingRevision: number;
  planId: string;
  adoptedPlanRevision: number;
  authorizedTaskIds: string[];
  state: BatchStatus;
  activeRunId: string | null;
  queueRevision: number;
  startedBy: string;
};
export type ExecutionRun = {
  runId: string;
  kind: RunKind;
  taskRef: TaskRef | null;
  snapshotId: string;
  specHash: string | null;
  status: RunStatus;
  attempt: number;
  threadId: string | null;
  activeTurnId: string | null;
  resultRef: string | null;
  verifyState: VerifyState;
};
export type InboxRecord = {
  eventId: string;
  payloadHash: string;
  sequence: number;
  status: "received" | "applied";
};
export type OutboxRecord = {
  commandId: string;
  payloadHash: string;
  sequence: number;
  status: "pending" | "acknowledged";
  retryAt: string | null;
};
export type RunMapping = {
  runId: string;
  threadId: string | null;
  turnId: string | null;
  launchIntent:
    | "prepared"
    | "thread_created"
    | "turn_sent"
    | "started"
    | "reconciliation_required";
  receivedCommands: string[];
  seq: number;
  workspaceLock: { workspaceId: string; leaseEpoch: number; expiresAt: string };
};

export type SummaryItem = { text: string; evidenceRef?: string };
export type ProjectSummary = {
  overview: string;
  completed: SummaryItem[];
  inProgress: SummaryItem[];
  pending: SummaryItem[];
  blockers: SummaryItem[];
  verification: SummaryItem[];
  uncertainties: SummaryItem[];
};
export type MemoryRecord = {
  id: string;
  ownerId: string;
  projectId: string | null;
  kind:
    | "user_preference"
    | "project_decision"
    | "chat_summary"
    | "project_snapshot";
  key: string;
  value: string;
  sourceRefs: string[];
  status: "active" | "superseded" | "deleted";
  revision: number;
  updatedAt: string;
};
type SnapshotBase = {
  executionPermissions?: ExecutionPermissions;
  snapshotId: string;
  runId: string;
  ownerId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string;
  summaryRevision: number;
  memoryEpoch: number;
  sourceRefs: string[];
  payloadHash: string;
  capturedAt: string;
  allowedCheckIds: string[];
  context: {
    projectSummary: ProjectSummary | null;
    decisions: string[];
    previousTaskNotes: string[];
    gitBaseline: {
      commit: string | null;
      branch: string | null;
      dirty: boolean;
    };
  };
};
export type ChecklistSource = {
  taskRef: TaskRef;
  generation: number;
  specRevision: number;
};
export type BatchItem = {
  taskId: string;
  text: string;
  instruction: string;
  acceptance: AcceptanceCriterion[];
  source?: ChecklistSource;
};
export type BatchProgress = {
  currentIndex: number;
  items: {
    taskId: string;
    text: string;
    status:
      | "pending"
      | "running"
      | "done"
      | "blocked"
      | "needs_input"
      | "failed"
      | "cancelled";
    summary: string;
    completedTurnId?: string;
    writeback?: {
      status: "pending" | "applied" | "conflict" | "failed" | "disabled";
      message?: string;
    };
  }[];
};
export type ExecutionSnapshot = SnapshotBase &
  (
    | { kind: "summary"; task: null }
    | {
        kind: "task";
        task: TaskSpec;
        batch?: { items: BatchItem[]; autoComplete?: boolean; managed?: true };
      }
  );
export type RunOutcome = {
  runId: string;
  taskId: string | null;
  outcome: "done" | "blocked" | "needs_input" | "failed";
  summary: string;
  changedFiles: string[];
  evidenceRefs: string[];
  remainingIssues: string[];
  nextTaskNotes: string[];
};
export type CreateRunInput = {
  requestId: string;
  runId: string;
  bindingId: string;
  bindingRevision: number;
  kind: RunKind;
  snapshotId: string;
  /** Digest of the referenced execution snapshot, checked by its owner. */
  payloadHash: string;
};
export type ContinueRunInput = {
  requestId: string;
  runId: string;
  expectedTurnId: string;
  message: string;
  mode: "reply" | "steer";
};
export type CancelRunInput = { requestId: string; runId: string };
export type RunnerCommand =
  | ({ type: "create_run" } & CreateRunInput)
  | ({ type: "continue_run" } & ContinueRunInput)
  | ({ type: "cancel_run" } & CancelRunInput);
export type CommandEnvelope = {
  protocolVersion: 1;
  commandId: string;
  runId: string;
  bindingRevision: number;
  authEpoch: number;
  leaseEpoch: number;
  /** Digest of this command's payload for deduplication, not the snapshot hash. */
  payloadHash: string;
  issuedAt: string;
  expiresAt: string;
  payload: RunnerCommand;
};
export type VerificationResult = {
  criterionId: string;
  status: "passed" | "failed" | "needs_input";
  evidenceRefs: string[];
  exitCode?: number | null;
  outputHash?: string;
  failureKind?: "predicate" | "command_exit" | "timeout" | "access_denied" | "unsupported" | "error";
  message?: string;
};
export type RunnerEventPayloads = {
  "run.accepted": { status: "queued" | "preparing" };
  "thread.created": Record<string, never>;
  "turn.started": Record<string, never>;
  "output.delta": { text: string };
  "approval.requested": { requestId: string; description: string; details?: ApprovalDetails };
  "input.requested": {
    requestId: string;
    questions: InputQuestion[];
  };
  "request.resolved": { requestId: string; status:"responded"|"expired"|"cancelled"; reason?:string };
  "turn.completed": {
    status: "completed" | "failed" | "interrupted";
    outcome: RunOutcome | null;
    summary: ProjectSummary | null;
    error: string | null;
  };
  "verification.completed": { results: VerificationResult[] };
  "run.cancelled": { reason: string };
  heartbeat: { leaseEpoch: number; connectionEpoch: number };
};
export type EventEnvelope<
  T extends keyof RunnerEventPayloads = keyof RunnerEventPayloads,
> = {
  [K in T]: {
    protocolVersion: 1;
    eventId: string;
    runnerId: string;
    runId: string;
    threadId: string | null;
    turnId: string | null;
    seq: number;
    type: K;
    occurredAt: string;
    payload: RunnerEventPayloads[K];
  };
}[T];
export type RunnerEvent = EventEnvelope;
