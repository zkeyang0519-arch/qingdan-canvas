import type { Env } from "../types";
import type {
  ChecklistSource,
  ExecutionSnapshot,
} from "../../shared/agent/contracts";
import type { ExecutionRunView } from "../../shared/agent/execution";
import type { ExecutionPrincipal } from "./execution-auth";
import { callAgentChecklist } from "../checklist-client";
import { hash } from "./outbox";
import { HttpError } from "../http";

type Run = {
  principal: ExecutionPrincipal;
  snapshot: ExecutionSnapshot;
  view: ExecutionRunView;
};
type Entry = {
  taskId: string;
  requestId: string;
  source: ChecklistSource;
  completedTurnId: string;
  status: "pending" | "applied" | "conflict" | "failed";
  message?: string;
  attempts: number;
  nextAt: number;
};
type Queue = {
  runId: string;
  principal: ExecutionPrincipal;
  entries: Entry[];
  indexKey?: string | null;
};
const key = (id: string) => `exec:writebacks:${id}`;
const pendingPrefix = "exec:writeback-pending:";
const dueKey = "exec:writeback-next";

// RunnerHub heartbeat and completion retries must not overwrite each other's
// alarm. The ordinary heartbeat remains the only source of device liveness.
export async function scheduleExecutionAlarm(storage: DurableObjectStorage) {
  const state = await storage.get<{ lastHeartbeat: number }>("state");
  const due = await storage.get<number>(dueKey);
  const next = Math.min(
    state?.lastHeartbeat ? state.lastHeartbeat + 45000 : Infinity,
    due ?? Infinity,
  );
  if (Number.isFinite(next))
    await storage.setAlarm?.(Math.max(Date.now() + 1000, next));
}

export class ChecklistWritebacks {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private now = Date.now,
  ) {}
  // Returned writes are committed with the accepted report. No Canvas mutation
  // happens until the immutable source and retry receipt are durable.
  async stage(run: Run, acceptedTaskIds?: string[]): Promise<Record<string, unknown>> {
    const batch = run.snapshot.kind === "task" ? run.snapshot.batch : undefined;
    if (
      !batch?.autoComplete ||
      (batch.managed && !acceptedTaskIds) ||
      !run.view.batch ||
      ["cancel_requested", "cancelled"].includes(run.view.status)
    )
      return {};
    const queue = (await this.storage.get<Queue>(key(run.view.runId))) ?? {
      runId: run.view.runId,
      principal: run.principal,
      entries: [],
    };
    let changed = false;
    for (const item of run.view.batch.items) {
      const source = batch.items.find((i) => i.taskId === item.taskId)?.source;
      if (
        !source ||
        (acceptedTaskIds && !acceptedTaskIds.includes(item.taskId)) ||
        item.status !== "done" ||
        !item.completedTurnId ||
        queue.entries.some((e) => e.taskId === item.taskId)
      )
        continue;
      queue.entries.push({
        taskId: item.taskId,
        requestId: `complete-${await hash({ runId: queue.runId, taskRef: source.taskRef })}`,
        source,
        completedTurnId: item.completedTurnId,
        status: "pending",
        attempts: 0,
        nextAt: this.now(),
      });
      changed = true;
    }
    if (!changed) return {};
    return this.indexWrites(queue);
  }
  private async indexWrites(queue: Queue): Promise<Record<string, unknown>> {
    const waiting = queue.entries.filter((e) => e.status === "pending");
    if (!waiting.length) {
      queue.indexKey = null;
      return { [key(queue.runId)]: queue };
    }
    const nextAt = Math.min(...waiting.map((e) => e.nextAt));
    queue.indexKey = `${pendingPrefix}${String(Math.max(0, nextAt)).padStart(16, "0")}:${queue.runId}`;
    return {
      [key(queue.runId)]: queue,
      [queue.indexKey]: { runId: queue.runId, nextAt },
      [dueKey]: Math.min(
        nextAt,
        (await this.storage.get<number>(dueKey)) ?? Infinity,
      ),
    };
  }
  async flushRun(runId: string) {
    const queue = await this.storage.get<Queue>(key(runId));
    if (!queue) return;
    const oldIndex = queue.indexKey;
    // At most one bounded Canvas RPC per invocation; backlog cannot monopolize
    // RunnerHub and delay heartbeats or stop commands during a Canvas outage.
    for (const entry of [...queue.entries].sort(
      (a, b) => a.nextAt - b.nextAt,
    )) {
      if (entry.status !== "pending" || entry.nextAt > this.now()) continue;
      try {
        const value = await callAgentChecklist(this.env, queue.principal, {
          action: "finalize",
          requestId: entry.requestId,
          runId,
          source: entry.source,
          completedTurnId: entry.completedTurnId,
        });
        if (value.status !== "applied" && value.status !== "conflict")
          throw new HttpError(502, "清单回写返回了未知状态。");
        entry.status = value.status;
        entry.message =
          typeof value.message === "string"
            ? value.message.slice(0, 1000)
            : undefined;
      } catch (error) {
        entry.attempts++;
        entry.message = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1000);
        if (
          error instanceof HttpError &&
          error.status >= 400 &&
          error.status < 500
        )
          entry.status = "failed";
        else
          entry.nextAt =
            this.now() +
            Math.min(60000, 2000 * 2 ** Math.min(entry.attempts, 5));
      }
      // Save after every receipt. A lost response or storage failure reuses the
      // same Canvas receipt and cannot re-check a task the user later reopened.
      break;
    }
    await this.storage.put(await this.indexWrites(queue));
    if (oldIndex && oldIndex !== queue.indexKey)
      await this.storage.delete(oldIndex);
    await this.schedule();
  }
  async retryDue() {
    const pending = await this.storage.list<{ runId: string; nextAt: number }>({
      prefix: pendingPrefix,
      limit: 100,
    });
    for (const [index, value] of pending) {
      const queue = await this.storage.get<Queue>(key(value.runId));
      if (!queue || queue.indexKey !== index) {
        await this.storage.delete(index);
        continue;
      }
      if (value.nextAt > this.now()) break;
      await this.flushRun(value.runId);
      break;
    }
    await this.schedule();
  }
  private async schedule() {
    const pending = await this.storage.list<{ nextAt: number }>({
      prefix: pendingPrefix,
      limit: 1,
    });
    if (pending.size)
      await this.storage.put(
        dueKey,
        Math.max(
          this.now() + 1000,
          Math.min(...[...pending.values()].map((v) => v.nextAt)),
        ),
      );
    else await this.storage.delete(dueKey);
    await scheduleExecutionAlarm(this.storage);
  }
  async decorate(run: Run): Promise<ExecutionRunView> {
    const batch = run.snapshot.kind === "task" ? run.snapshot.batch : undefined;
    if (!batch?.items.some((item) => item.source) || !run.view.batch)
      return run.view;
    const queue = await this.storage.get<Queue>(key(run.view.runId));
    const view = structuredClone(run.view);
    view.sourceBacked = true;
    for (const item of view.batch!.items) {
      if (!batch.items.find((i) => i.taskId === item.taskId)?.source) continue;
      const entry = queue?.entries.find((e) => e.taskId === item.taskId);
      if (entry)
        item.writeback = {
          status: entry.status,
          ...(entry.message ? { message: entry.message } : {}),
        };
      else if (
        !batch.autoComplete ||
        ["cancel_requested", "cancelled"].includes(view.status)
      )
        item.writeback = {
          status: "disabled",
          message: batch.autoComplete
            ? "批次已停止，不新增完成回写。"
            : "本批次未启用自动勾选。",
        };
      else if (item.status === "done")
        item.writeback = { status: "pending", message: "等待同步到真实清单。" };
    }
    return view;
  }
}
