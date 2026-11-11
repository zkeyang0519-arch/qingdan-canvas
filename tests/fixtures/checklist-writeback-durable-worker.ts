import { RunnerHub } from "../../worker/execution/hub";
import { CanvasRoom } from "../../worker/room";
import { ExecutionDispatch } from "../../worker/execution/dispatch";
import { executionRoute } from "../../worker/execution/execution-router";
import { nativePrincipal } from "../../worker/execution/execution-auth";
import { HttpError } from "../../worker/http";

const principal = { ownerId: "audit-owner", runnerId: "runner", bindingId: "binding", bindingRevision: 1, authEpoch: 1 };

// Fault injection and observations live only in this isolated worker. The
// production Hub owns HTTP dispatch, socket leases and actual persisted alarms.
export class WritebackHub extends RunnerHub {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/fixture") return super.fetch(request);
    return this.ctx.blockConcurrencyWhile(async () => {
      const input = await request.json() as any;
      if (input.op === "state") return Response.json({ rows: Object.fromEntries(await this.ctx.storage.list()), alarm: await this.ctx.storage.getAlarm(), alarmRuns: await this.ctx.storage.get("fixture:alarmRuns") ?? 0 });
      if (input.op === "create") {
        const dispatch = new ExecutionDispatch(this.ctx.storage, this.env);
        const response = await dispatch.fetch(new Request("https://runner/execution/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal, input: { requestId: "source-task-run", bindingId: "binding", bindingRevision: 1, kind: "task", sourceTasks: input.tasks, autoComplete: true } }) }));
        if (!response.ok) return response;
        const { input: command } = await response.json() as any;
        return Response.json(await dispatch.tool(principal, "codex_create_run", command));
      }
      throw Error("Unknown fixture operation");
    });
  }
  async alarm() {
    await super.alarm();
    await this.ctx.storage.put("fixture:alarmRuns", (await this.ctx.storage.get<number>("fixture:alarmRuns") ?? 0) + 1);
  }
}

export class WritebackCanvas extends CanvasRoom {
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/fixture") return Response.json({ rows: this.rows(), sequence: this.sequence(), calls: await this.ctx.storage.get("fixture:finalizeCalls") ?? [] });
    const input = pathname === "/internal/agent-checklist" ? (await request.clone().json() as any).input : null;
    const response = await super.fetch(request);
    if (input?.action !== "finalize" || !response.ok) return response;
    const result = await response.clone().json() as any;
    const calls = await this.ctx.storage.get<any[]>("fixture:finalizeCalls") ?? [];
    await this.ctx.storage.put("fixture:finalizeCalls", [...calls, { input, result }]);
    if (result.status === "applied" && !await this.ctx.storage.get("fixture:droppedAck")) {
      await this.ctx.storage.put("fixture:droppedAck", true);
      return Response.json({ error: "Injected response loss after Canvas completion committed" }, { status: 503 });
    }
    return response;
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    try {
      const pathname = new URL(request.url).pathname;
      const hub = env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName("runner"));
      if (pathname === "/fixture/hub") return hub.fetch(new Request("https://runner/fixture", request));
      if (pathname === "/fixture/connect") {
        const device = await nativePrincipal(request, env);
        return hub.fetch("https://runner/connect", { headers: { Upgrade: "websocket", "X-Runner-Id": device.runner_id, "X-Auth-Epoch": String(device.auth_epoch) } });
      }
      if (pathname.startsWith("/fixture/canvas/")) {
        const route = pathname.slice("/fixture/canvas/".length);
        const target = route === "checklist" ? "internal/agent-checklist" : route;
        return env.ROOMS.get(env.ROOMS.idFromName("canvas")).fetch(new Request("https://canvas.internal/" + target, request));
      }
      return await executionRoute(request, env, ctx) ?? new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof HttpError ? error.status : 500 });
    }
  },
};
