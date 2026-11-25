import type { Env } from "../types";
import type { ExecutionPrincipal } from "./execution-auth";
import type {
  ExecutionSnapshot,
  RunnerEvent,
} from "../../shared/agent/contracts";
import type { ExecutionRunView } from "../../shared/agent/execution";
const prefix = "exec:retention-pending:";
type Run = {
  principal: ExecutionPrincipal;
  snapshot: ExecutionSnapshot;
  view: ExecutionRunView;
};
type Pending = { runId: string; attempts: number; nextAt: number };
export class ExecutionRetentionOutbox {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
  ) {}
  async stage(run: Run) {
    if (
      this.env.CHAT_ENABLED !== "true" ||
      run.snapshot.kind !== "task" ||
      !run.view.terminal ||
      !run.view.stopConfirmed ||
      run.view.status !== "succeeded"
    )
      return {};
    const key = prefix + run.view.runId;
    if (
      await this.storage.get(
        "exec:retention-sent:" + run.view.runId + ":" + run.view.reportRevision,
      )
    )
      return {};
    const old = await this.storage.get<Pending>(key);
    return {
      [key]: old || {
        runId: run.view.runId,
        attempts: 0,
        nextAt: Date.now() + 1000,
      },
      "exec:retention-next": Math.min(
        (await this.storage.get<number>("exec:retention-next")) || Infinity,
        Date.now() + 1000,
      ),
    };
  }
  async flush() {
    if (this.env.CHAT_ENABLED !== "true") return;
    const pending = await this.storage.list<Pending>({ prefix, limit: 20 });
    for (const [key, entry] of pending) {
      if (entry.nextAt > Date.now()) continue;
      const run = await this.storage.get<Run>("exec:run:" + entry.runId);
      if (
        !run ||
        run.snapshot.kind !== "task" ||
        !run.view.terminal ||
        !run.view.stopConfirmed ||
        run.view.status !== "succeeded"
      ) {
        await this.storage.delete(key);
        continue;
      }
      try {
        const tail = await this.storage.list<RunnerEvent>({
          prefix: "exec:event:" + entry.runId + ":",
          reverse: true,
          limit: 64,
        });
        const events = [...tail.values()].filter(
          (e) => e.turnId === run.view.turnId,
        );
        const completion = events.find(
          (e): e is Extract<RunnerEvent, { type: "turn.completed" }> =>
            e.type === "turn.completed",
        );
        const verification = events.find(
          (e): e is Extract<RunnerEvent, { type: "verification.completed" }> =>
            e.type === "verification.completed",
        );
        const output =
          run.view.output ||
          completion?.payload.output ||
          completion?.payload.outcome?.summary;
        if (!output) throw Error("等待原任务结果");
        const verified =
          verification?.payload.results.length &&
          verification.payload.results.every((r) => r.status === "passed");
        const evidence = [
          ...(completion
            ? [
                {
                  id: completion.eventId,
                  label: "Codex 最终回执",
                  kind: "answer" as const,
                  ok: completion.payload.status === "completed",
                  text: output.slice(0, 3000),
                },
              ]
            : []),
          ...(verification
            ? [
                {
                  id: verification.eventId,
                  label: "任务验收",
                  kind: "tool" as const,
                  ok: !!verified,
                  text: JSON.stringify(verification.payload).slice(0, 3000),
                },
              ]
            : []),
        ];
        const result = await this.env.AGENT_CHATS.get(
          this.env.AGENT_CHATS.idFromName(run.principal.ownerId),
        ).executionRetentionResult({
          principal: run.principal,
          report: {
            taskId: "execution:" + run.view.runId,
            jobId: "execution:" + run.view.runId,
            finalRevision: Math.max(1, run.view.reportRevision),
            status: "completed",
            goal: (
              run.view.submission?.text ||
              run.snapshot.task.instruction ||
              "待办执行"
            ).slice(0, 8000),
            summary: output.slice(0, 8000),
            messageIds: ["execution:" + run.view.runId],
            evidence,
            verifiedEvidenceIds:
              verified && verification ? [verification.eventId] : [],
          },
        });
        if (
          result.error &&
          ![401, 403, 409, 400].includes(result.status || 500)
        )
          throw Error("复盘回执未确认");
        await this.storage.put(
          "exec:retention-sent:" +
            run.view.runId +
            ":" +
            run.view.reportRevision,
          true,
        );
        await this.storage.delete(key);
      } catch {
        entry.attempts++;
        entry.nextAt =
          Date.now() +
          Math.min(300000, 2000 * 2 ** Math.min(entry.attempts, 7));
        await this.storage.put(key, entry);
      }
    }
    const remaining = await this.storage.list<Pending>({ prefix });
    if (remaining.size)
      await this.storage.put(
        "exec:retention-next",
        Math.min(...[...remaining.values()].map((e) => e.nextAt)),
      );
    else await this.storage.delete("exec:retention-next");
  }
}
