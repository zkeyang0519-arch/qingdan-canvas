import { DurableObject } from "cloudflare:workers";
import { ExecutionDispatch } from "../../worker/execution/dispatch";
import { HttpError } from "../../worker/http";
const principal = {
  ownerId: "audit-owner",
  runnerId: "runner",
  bindingId: "binding",
  bindingRevision: 1,
  authEpoch: 1,
};

// Test-only failure injection around real SQLite DO writes. No production
// methods, timers or models are replaced. Every request uses the Hub's gate.
export class SummaryHub extends DurableObject<any> {
  async fetch(request: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const base = this.ctx.storage;
      const storage = new Proxy(base, {
        get(target, property) {
          if (property === "put")
            return async (key: any, value: any) => {
              const entries =
                typeof key === "string" ? [[key, value]] : Object.entries(key);
              const fault = await base.get<string>("fixture:fault");
              const prepared = entries.some(
                ([k, v]) =>
                  k.startsWith("project:launch:") &&
                  (v as any).phase === "prepared",
              );
              const committed = entries.some(
                ([k, v]) =>
                  k.startsWith("project:launch:") &&
                  (v as any).phase === "committed",
              );
              const sealed = entries.some(
                ([k, v]) =>
                  k.startsWith("project:launch:") &&
                  (v as any).phase === "sealed",
              );
              const match =
                (fault === "prepared-after" && prepared) ||
                (fault === "coordinator-before" && committed) ||
                (fault === "seal-after" && sealed);
              if (match) {
                await base.delete("fixture:fault");
                if (fault!.endsWith("after"))
                  await (base.put as any)(key, value);
                throw Error("injected " + fault);
              }
              return (base.put as any)(key, value);
            };
          const v = Reflect.get(target, property, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const dispatch = new ExecutionDispatch(storage, this.env);
      try {
        const input = (await request.json()) as any;
        if (input.hold) {
          await this.env.DB.prepare(
            "INSERT OR REPLACE INTO fixture_barrier VALUES('race',0)",
          ).run();
          while (
            !(
              await this.env.DB.prepare(
                "SELECT released FROM fixture_barrier WHERE id='race'",
              ).first()
            ).released
          )
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (input.op === "seed") {
          await base.put({
            "exec:context:workspace": {
              workspaceId: "workspace",
              capturedAt: new Date().toISOString(),
              gitBaseline: { commit: null, branch: null, dirty: false },
              threads: [],
            },
            "exec:context-auth:workspace": { authEpoch: 1, revision: 1 },
          });
          return Response.json({ ok: true });
        }
        if (input.op === "inject") {
          await base.put("fixture:fault", input.fault);
          return Response.json({ ok: true });
        }
        if (input.op === "rows")
          return Response.json(Object.fromEntries(await base.list()));
        if (input.op === "tool")
          return Response.json(
            await dispatch.tool(principal, input.name, input.input),
          );
        const envelope =
          input.op === "native"
            ? {
                runnerId: "runner",
                authEpoch: 1,
                input: { connectionEpoch: 1, ...input.input },
              }
            : { principal, input: input.input };
        return await dispatch.fetch(
          new Request(
            "https://runner/execution/" +
              (input.op === "native" ? "native/" : "project-") +
              input.action,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(envelope),
            },
          ),
        );
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: e instanceof HttpError ? e.status : 500 },
        );
      }
    });
  }
}
export default {
  fetch(request: Request, env: any) {
    return env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName("runner")).fetch(
      request,
    );
  },
};
