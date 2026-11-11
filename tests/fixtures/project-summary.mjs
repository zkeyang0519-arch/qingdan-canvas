import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const bundleDir = mkdtempSync(resolve("node_modules/.cache/project-summary-"));
await build({
  entryPoints: ["worker/execution/dispatch.ts"],
  bundle: true,
  outfile: resolve(bundleDir, "dispatch.mjs"),
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { ExecutionDispatch } = await import(
  pathToFileURL(resolve(bundleDir, "dispatch.mjs"))
);
rmSync(bundleDir, { recursive: true, force: true });
const p = {
  ownerId: "alice",
  runnerId: "runner",
  bindingId: "binding",
  bindingRevision: 1,
  authEpoch: 1,
};
const summary = {
  overview: "已读取测试说明",
  completed: [],
  inProgress: [],
  pending: [{ text: "完成测试", evidenceRef: "README.md" }],
  blockers: [],
  verification: [],
  uncertainties: [],
};
function fixture() {
  const rows = new Map(),
    reservations = new Map();
  let leases = [];
  let failCoordinator = false;
  const storage = {
    async get(k) {
      return structuredClone(rows.get(k));
    },
    async put(k, v) {
      if (
        failCoordinator &&
        typeof k !== "string" &&
        Object.keys(k).some((key) => /^project:state:[a-f0-9]+$/.test(key))
      ) {
        failCoordinator = false;
        throw Error("injected coordinator save failure");
      }
      if (typeof k === "string") rows.set(k, structuredClone(v));
      else
        for (const [key, value] of Object.entries(k))
          rows.set(key, structuredClone(value));
    },
    async delete(k) {
      return rows.delete(k);
    },
    async list({
      prefix = "",
      limit = 1000,
      reverse = false,
      startAfter,
    } = {}) {
      let a = [...rows]
        .filter(
          ([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter),
        )
        .sort(([a], [b]) => a.localeCompare(b));
      if (reverse) a.reverse();
      return new Map(structuredClone(a.slice(0, limit)));
    },
    async setAlarm() {},
  };
  const binding = {
    binding_id: "binding",
    owner_id: "alice",
    runner_id: "runner",
    workspace_id: "workspace",
    canvas_id: "canvas",
    revision: 1,
    enabled: 1,
  };
  const device = {
    runner_id: "runner",
    owner_id: "alice",
    auth_epoch: 1,
    connection_epoch: 1,
    last_seen_at: Date.now(),
    revoked_at: null,
    workspaces_json: JSON.stringify([
      {
        workspaceId: "workspace",
        name: "Demo",
        revision: 1,
        checks: [],
        displayPath: "D:/demo",
      },
    ]),
  };
  const env = {
    PROJECT_SUMMARY_ENABLED: "true",
    DB: {
      prepare(sql) {
        let args;
        return {
          bind(...a) {
            args = a;
            return this;
          },
          async first() {
            if (sql.includes("agent_execution_requests"))
              return reservations.get(args.join(":"));
            if (sql.includes("agent_bindings"))
              return args[0] === binding.binding_id &&
                args[1] === binding.owner_id &&
                args[2] === binding.runner_id &&
                args[3] === binding.revision
                ? binding
                : null;
            if (sql.includes("agent_devices"))
              return device.revoked_at ? null : device;
            throw Error(sql);
          },
          async run() {
            if (
              sql.startsWith(
                "INSERT OR IGNORE INTO agent_execution_requests",
              ) &&
              !reservations.has(args.slice(0, 2).join(":"))
            )
              reservations.set(args.slice(0, 2).join(":"), {
                payload_hash: args[2],
                runner_id: args[3],
                binding_id: args[4],
              });
            return { success: true };
          },
          async all() {
            return { results: structuredClone(leases) };
          },
        };
      },
    },
  };
  let dispatch = new ExecutionDispatch(storage, env);
  const call = async (action, input = {}, principal = p) =>
    (
      await dispatch.fetch(
        new Request("https://runner/execution/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principal, input }),
        }),
      )
    ).json();
  const native = async (action, input) =>
    (
      await dispatch.fetch(
        new Request("https://runner/execution/native/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runnerId: "runner",
            authEpoch: 1,
            input: { connectionEpoch: 1, ...input },
          }),
        }),
      )
    ).json();
  const seed = async () => {
    await storage.put({
      "exec:context:workspace": {
        workspaceId: "workspace",
        capturedAt: new Date().toISOString(),
        gitBaseline: { commit: "a".repeat(40), branch: "main", dirty: false },
        threads: [],
      },
      "exec:context-auth:workspace": { authEpoch: 1, revision: 1 },
    });
  };
  async function finish(runId, ok = true) {
    const r = rows.get("exec:run:" + runId),
      cmd = r.commands[0];
    leases = [
      {
        run_id: runId,
        workspace_id: "workspace",
        lease_epoch: 1,
        expires_at: Date.now() + 60000,
      },
    ];
    await native("poll", {});
    await native("events", {
      events: [
        {
          protocolVersion: 1,
          eventId: "event-" + runId,
          runnerId: "runner",
          runId,
          threadId: "thread-" + runId,
          turnId: "turn-" + runId,
          seq: 1,
          type: "turn.completed",
          occurredAt: new Date().toISOString(),
          payload: {
            status: ok ? "completed" : "failed",
            summary: ok ? summary : null,
            outcome: null,
            error: ok ? null : "test failure",
          },
        },
      ],
    });
    await native("report", {
      runId,
      commandId: cmd.receipt.commandId,
      revision: 1,
      status: ok ? "verifying" : "failed",
      threadId: "thread-" + runId,
      turnId: "turn-" + runId,
      terminal: true,
      stopConfirmed: true,
      summaryContext: {
        workspaceId: "workspace",
        capturedAt: new Date().toISOString(),
        gitBaseline: { commit: "a".repeat(40), branch: "main", dirty: false },
      },
      ...(ok ? {} : { error: "test failure" }),
    });
    leases = [];
  }
  return {
    rows,
    storage,
    tool: (name, input, principal = p) => dispatch.tool(principal, name, input),
    env,
    binding,
    device,
    call,
    native,
    seed,
    finish,
    restart() {
      dispatch = new ExecutionDispatch(storage, env);
    },
    failNextCoordinatorSave() {
      failCoordinator = true;
    },
    lease(l) {
      leases = l;
    },
  };
}
const init = (id = "first", chatId) => ({
  ...p,
  requestId: id,
  ...(chatId ? { chatId } : {}),
  ownerId: undefined,
  runnerId: undefined,
  authEpoch: undefined,
});

export { fixture, p, init, summary };
