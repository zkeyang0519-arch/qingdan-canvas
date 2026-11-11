import type {
  ExecutionSnapshot,
  ProjectSummary,
  RunOutcome,
  RunStatus,
  RunnerEvent,
  BatchProgress,
  VerificationResult,
} from "../shared/agent/contracts";
import type { NativeSummaryContext } from "../shared/agent/execution";
import type { SummaryEvidence } from "./summary-evidence";
import type {
  ApprovalDetails,
  InputQuestion,
} from "../shared/agent/permissions";
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
  // Missing on legacy runs, whose final messages still use outputSchema.
  resultChannel?: "tool";
  // Captured by the native runner at the actual start, never by the model.
  summaryContext?: NativeSummaryContext;
  summaryEvidence?: SummaryEvidence;
  reportedResult?: {
    turnId: string;
    callId: string;
    result: RunOutcome | ProjectSummary;
  } | null;
  launchResult: LaunchResult | null;
  // A successful OS request is not proof that the desktop rendered the chat.
  desktopSync?: { status: "pending" | "requested" | "failed"; error?: string };
  batch?: BatchProgress;
  batchPhase?: "running" | "ready" | "paused" | "complete" | "cancelled";
  verification?: {
    turnId: string;
    itemIndex: number;
    results: VerificationResult[];
    capturedAt: string;
  };
  batchPermit?: {
    permitId: string;
    decision: "advance" | "repair";
    fromIndex: number;
    fromTurnId: string;
    nextIndex: number;
  };
  repairCounts?: Record<string, number>;
  pendingInteractions?: { id: string; threadId: string; turnId: string }[];
};
export type PendingRequest = {
  id: string;
  wireId: string | number;
  runId: string;
  threadId: string;
  turnId: string;
  method: string;
  params: Record<string, unknown>;
  expiresAt: number;
  details?: ApprovalDetails;
  questions?: InputQuestion[];
  nativeScope?: { command?: string; cwd?: string; files?: string[] };
};
export type StoredEvent = { cursor: number; event: RunnerEvent };
