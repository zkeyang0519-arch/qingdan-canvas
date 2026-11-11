import type {
  BatchProgress,
  ExecutionSnapshot,
  RunOutcome,
} from "../shared/agent/contracts";
import type { RunRecord } from "./types";

export function initialBatch(
  snapshot: ExecutionSnapshot,
): BatchProgress | undefined {
  if (snapshot.kind !== "task" || !snapshot.batch) return;
  return {
    currentIndex: 0,
    items: snapshot.batch.items.map(({ taskId, text }) => ({
      taskId,
      text,
      status: "pending",
      summary: "",
    })),
  };
}

// The authorized snapshot never changes. Only its current-item projection is
// used to build a prompt and attach the trusted identity to a model receipt.
export function currentSnapshot(run: RunRecord): ExecutionSnapshot {
  const snapshot = run.snapshot;
  if (snapshot.kind !== "task" || !snapshot.batch || !run.batch)
    return snapshot;
  const item = snapshot.batch.items[run.batch.currentIndex];
  if (!item) throw Error("批次当前待办不存在。");
  return {
    ...snapshot,
    task: {
      ...snapshot.task,
      text: item.text,
      instruction: item.instruction,
      acceptance: item.acceptance,
      taskRef: item.source?.taskRef ?? {
        ...snapshot.task.taskRef,
        taskId: item.taskId,
      },
      specRevision: item.source?.specRevision ?? snapshot.task.specRevision,
    },
  };
}

export function finishBatchItem(
  run: RunRecord,
  result: RunOutcome | null,
  turnStatus: string,
  cancelled: boolean,
): Partial<RunRecord> {
  if (!run.batch) return {};
  const batch = structuredClone(run.batch),
    index = batch.currentIndex;
  const item = batch.items[index];
  const done =
    !cancelled && turnStatus === "completed" && result?.outcome === "done";
  item.status = done
    ? "done"
    : cancelled
      ? "cancelled"
      : turnStatus !== "completed"
        ? "failed"
        : (result?.outcome ?? "needs_input");
  item.summary = (
    cancelled
      ? "已停止。"
      : (result?.summary ?? "未取得有效结果，请补充说明后继续。")
  ).slice(0, 2000);
  if (done && run.activeTurnId) item.completedTurnId = run.activeTurnId;
  else delete item.completedTurnId;
  if (cancelled)
    for (let i = index + 1; i < batch.items.length; i++)
      batch.items[i].status = "cancelled";
  const managed = run.snapshot.kind === "task" && run.snapshot.batch?.managed;
  const ready = done && (managed || index + 1 < batch.items.length);
  const phase = cancelled
    ? "cancelled"
    : ready
      ? "ready"
      : done
        ? "complete"
        : "paused";
  return {
    batch,
    batchPhase: phase,
    active: ready,
    terminal: !ready,
    status: cancelled
      ? "cancelled"
      : ready
        ? "running"
        : done
          ? "verifying"
          : turnStatus !== "completed" || result?.outcome === "failed"
            ? "failed"
            : "waiting_input",
  };
}
