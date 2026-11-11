import { RunnerHub } from "../../worker/execution/hub";
import { CanvasRoom } from "../../worker/room";
import { ExecutionDispatch } from "../../worker/execution/dispatch";
import { executionRoute } from "../../worker/execution/execution-router";
import { nativePrincipal } from "../../worker/execution/execution-auth";
import { HttpError } from "../../worker/http";
import type { Env } from "../../worker/types";

const principal = { ownerId: "audit-owner", runnerId: "runner", bindingId: "binding", bindingRevision: 1, authEpoch: 1 };
type AlarmOrigin = { instanceId: string; alarmId: string | null };

// Fault injection and observations live only in this isolated worker. The
// production Hub owns HTTP dispatch, socket leases and actual persisted alarms.
export class WritebackHub extends RunnerHub {
  private readonly origin: AlarmOrigin;
  constructor(ctx: DurableObjectState, env: Env) {
    const origin: AlarmOrigin = { instanceId: crypto.randomUUID(), alarmId: null };
    // Trace the real DO-to-DO HTTP request without replacing its body or response.
    const rooms = {
      idFromName: env.ROOMS.idFromName.bind(env.ROOMS),
      get(id: DurableObjectId) {
        const stub = env.ROOMS.get(id);
        return { fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          request.headers.set("X-Fixture-Hub-Instance", origin.instanceId);
          if (origin.alarmId) request.headers.set("X-Fixture-Alarm-Id", origin.alarmId);
          return stub.fetch(request);
        } };
      },
    } as Env["ROOMS"];
    super(ctx, { ...env, ROOMS: rooms });
    this.origin = origin;
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/fixture") return super.fetch(request);
    return this.ctx.blockConcurrencyWhile(async () => {
      const input = await request.json() as any;
      if (input.op === "state") return Response.json({ rows: Object.fromEntries(await this.ctx.storage.list()), alarm: await this.ctx.storage.getAlarm(), instanceId: this.origin.instanceId, alarms: await this.ctx.storage.get("fixture:alarms") ?? [] });
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
    this.origin.alarmId = crypto.randomUUID();
    try {
      await super.alarm();
      const alarms = await this.ctx.storage.get<AlarmOrigin[]>("fixture:alarms") ?? [];
      await this.ctx.storage.put("fixture:alarms", [...alarms, { ...this.origin }]);
    } finally {
      this.origin.alarmId = null;
    }
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
    const origin = { instanceId: request.headers.get("X-Fixture-Hub-Instance"), alarmId: request.headers.get("X-Fixture-Alarm-Id") };
    await this.ctx.storage.put("fixture:finalizeCalls", [...calls, { input, result, origin }]);
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
