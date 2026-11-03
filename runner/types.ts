import type {
  ExecutionSnapshot,
  ProjectSummary,
  RunOutcome,
  RunStatus,
  RunnerEvent,
} from "../shared/agent/contracts";
export type Workspace = { workspaceId: string; root: string };
export type LaunchResult =
  | { status: "started"; runId: string; threadId: string; turnId: string }
  | { status: "reconciliation_required"; runId: string; reason: string };
export type CommandReceipt = {
  commandId: string;
  runId: string;
  status: "accepted" | "cancel_requested" | "reconciliation_required";
  threadId: string | null;
  turnId: string | null;
};
export type ReconcileResult = {
  runId: string;
  status: "completed" | "running" | "not_started" | "reconciliation_required";
  reason?: string;
};
export type LaunchStage =
  "prepared" | "thread_requested" | "thread_created" | "turn_sent" | "started";
export type RunRecord = {
  runId: string;
  snapshot: ExecutionSnapshot;
  digest: string;
  root: string;
  threadId: string | null;
  activeTurnId: string | null;
  pendingRequestId: string | null;
  launchIntent: LaunchStage;
  status: RunStatus;
  active: boolean;
  terminal: boolean;
  cancelRequested: boolean;
  result: RunOutcome | ProjectSummary | null;
  resultValid: boolean;
  resultError: string | null;
  output: string;
  launchResult: LaunchResult | null;
};
export type PendingRequest = {
  id: string;
  wireId: string | number;
  runId: string;
  threadId: string;
  turnId: string;
  method: string;
  params: Record<string, unknown>;
};
export type StoredEvent = { cursor: number; event: RunnerEvent };
