import type { ProjectSummary } from "./contracts";

export interface ProjectContext {
  bindingId: string;
  bindingRevision: number;
  status:
    | "uninitialized"
    | "queued"
    | "running"
    | "ready"
    | "failed"
    | "reconciliation_required";
  ready: boolean;
  stale: boolean;
  summaryRevision: number;
  summary: ProjectSummary | null;
  capturedAt: string | null;
  sourceRunId: string | null;
  threadId: string | null;
  turnId: string | null;
  cwd: string | null;
  gitBaseline: {
    commit: string | null;
    branch: string | null;
    dirty: boolean;
  } | null;
  error: string | null;
  activeRunId: string | null;
  pendingLaunch?: {
    runId: string;
    operationId: string;
    projectRequestId?: string;
  };
  sealedLaunch?: {
    runId: string;
    operationId: string;
    projectRequestId?: string;
    sealedAt: string;
  };
  recoveryRuns?: {
    runId: string;
    status: string;
    terminal: boolean;
    stopConfirmed: boolean;
  }[];
  canRefresh?: boolean;
}
