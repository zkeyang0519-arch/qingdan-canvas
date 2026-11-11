import { DurableObject } from "cloudflare:workers";
import { ExecutionDispatch } from "../../worker/execution/dispatch";
import { executionRoute } from "../../worker/execution/execution-router";
import { hash, materialize } from "../../worker/execution/outbox";
import { HttpError } from "../../worker/http";

const principal = { ownerId: "audit-owner", runnerId: "runner", bindingId: "binding", bindingRevision: 1, authEpoch: 1 };

// Only this isolated test worker exposes storage/failure controls. The production
// dispatch controller, native HTTP authentication, D1 and SQLite DO are real.
export class RecoveryHub extends DurableObject<any> {
  async fetch(request: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const base = this.ctx.storage;
      const storage = new Proxy(base, {
        get(target, property) {
          if (property === "put") return async (key: any, value: any) => {
            const entries = typeof key === "string" ? [[key, value]] : Object.entries(key);
            const fault = await base.get<string>("fixture:fault");
            const run = entries.find(([name]) => name.startsWith("exec:run:"))?.[1];
            const control = entries.some(([name]) => name.startsWith("exec:queue-control:"));
            const confirm = entries.some(([name]) => name.startsWith("exec:reconcile-receipt:"));
            const permit = run && Object.keys(run.queueState?.permits ?? {}).length > 0;
            const consumed = run && (run.queueState?.repairs["0"] ?? 0) > 0;
            const match = fault === "control-before" && control || fault === "control-after" && run?.queueState?.pauseRequested || fault === "repair-before" && permit || fault === "repair-after" && consumed || fault?.startsWith("confirm-") && confirm;
            if (match) {
              await base.delete("fixture:fault");
              if (fault!.endsWith("after")) await (base.put as any)(key, value);
              throw new Error("injected " + fault);
            }
            return (base.put as any)(key, value);
          };
          if (property === "delete") return async (key: any) => {
            if (key === "exec:active" && await base.get("fixture:fault") === "cleanup") {
              await base.delete("fixture:fault");
              throw new Error("injected cleanup");
            }
            return base.delete(key);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const dispatch = new ExecutionDispatch(storage, this.env);
      const invoke = async (action: string, input: unknown) => (await dispatch.fetch(new Request("https://runner/execution/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal, input }) }))).json();
      try {
        if (!new URL(request.url).pathname.startsWith("/fixture")) return await dispatch.fetch(request);
        const input = await request.json() as any;
        if (input.op === "inject") { await base.put("fixture:fault", input.fault); return Response.json({ ok: true }); }
        if (input.op === "state") return Response.json(Object.fromEntries(await base.list()));
        if (input.op === "control") return Response.json(await invoke("queue", input.input));
        if (input.op === "cancel") return Response.json(await dispatch.tool(principal, "codex_cancel_run", { runId: input.runId, requestId: input.requestId ?? crypto.randomUUID() }));
        if (input.op === "seed") {
          await base.put({ "exec:context:workspace": { workspaceId: "workspace", capturedAt: new Date().toISOString(), gitBaseline: { commit: null, branch: null, dirty: false }, threads: [] }, "exec:context-auth:workspace": { authEpoch: 1, revision: 1 } });
          const { input: command } = await invoke("intent", { bindingId: "binding", bindingRevision: 1, requestId: crypto.randomUUID(), kind: input.kind === "summary" ? "summary" : "task", ...(input.kind === "managed" ? { items: [{ instruction: "one" }, { instruction: "two" }] } : { instruction: "synthetic task" }) }) as any;
          await dispatch.tool(principal, "codex_create_run", command);
          const run: any = await base.get("exec:run:" + command.runId);
          if (input.mode === "queue") {
            run.snapshot.batch.items.forEach((item: any, i: number) => item.acceptance = [{ id: "check" + i, kind: "artifact", description: "result", required: true, relativePath: i + ".txt", predicate: { type: "exists" } }]);
            run.snapshot.payloadHash = await hash({ ...run.snapshot, payloadHash: undefined });
            run.commands[0].payload.payloadHash = run.snapshot.payloadHash;
            Object.assign(run.view, { status: "running", threadId: "thread", turnId: "turn0", reportRevision: 1 });
            Object.assign(run.view.batch.items[0], { status: "done", completedTurnId: "turn0", summary: "done" });
            run.view.queue.turnId = "turn0";
            await base.put({
              [`exec:queue-proof:${command.runId}:turn0:turn.completed`]: { type: "turn.completed", threadId: "thread", turnId: "turn0", payload: { status: "completed", outcome: { runId: command.runId, taskId: run.view.batch.items[0].taskId, outcome: "done" } } },
              [`exec:queue-proof:${command.runId}:turn0:verification.completed`]: { type: "verification.completed", threadId: "thread", turnId: "turn0", payload: { results: [{ criterionId: "check0", status: "failed", failureKind: "predicate", evidenceRefs: ["synthetic:artifact"], outputHash: "a".repeat(64) }] } },
            });
          }
          const envelope = await materialize(run.commands[0], 1, 1, 1);
          if (input.mode !== "queue") envelope.expiresAt = new Date(Date.now() - 60000).toISOString();
          const expiresAt = Date.now() + (input.mode === "queue" ? 600000 : -60000);
          await this.env.DB.prepare("INSERT INTO agent_workspace_leases(runner_id,workspace_id,run_id,lease_epoch,expires_at) VALUES(?,?,?,?,?)").bind("runner", "workspace", command.runId, 1, expiresAt).run();
          await base.put({ ["exec:run:" + command.runId]: run, ["exec:command-run:" + envelope.commandId]: command.runId, "exec:active": command.runId });
          return Response.json({ runId: command.runId, commandId: envelope.commandId, snapshotHash: run.snapshot.payloadHash, expiresAt });
        }
        throw new Error("unknown fixture operation");
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof HttpError ? error.status : 500 });
      }
    });
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    try {
      if (new URL(request.url).pathname === "/fixture") return env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName("runner")).fetch(request);
      return await executionRoute(request, env, ctx) ?? new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof HttpError ? error.status : 500 });
    }
  },
};
