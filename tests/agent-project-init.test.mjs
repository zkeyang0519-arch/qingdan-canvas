import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
Error.stackTraceLimit = 1;
const bundle = await build({
  entryPoints: ["worker/execution/dispatch.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { ExecutionDispatch } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
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
        Object.entries(k).some(([key, value]) => /^project:state:[a-f0-9]+$/.test(key) && !value.pendingLaunch)
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

test("project initialization replays one read-only summary and only terminal matched evidence becomes ready", async () => {
  const f = fixture();
  await f.seed();
  assert.equal((await f.call("project-state")).status, "uninitialized");
  const first = await f.call("project-initialize", init());
  assert.equal(first.status, "queued");
  assert.equal(first.ready, false);
  assert.ok(first.activeRunId);
  assert.equal(
    (await f.call("project-initialize", init("other"))).activeRunId,
    first.activeRunId,
  );
  const run = f.rows.get("exec:run:" + first.activeRunId);
  assert.equal(run.snapshot.kind, "summary");
  assert.equal(run.snapshot.task, null);
  assert.equal(run.view.threadId, null);
  f.restart();
  assert.equal(
    (await f.call("project-initialize", init())).activeRunId,
    first.activeRunId,
  );
  await f.finish(first.activeRunId);
  const ready = await f.call("project-state");
  assert.equal(ready.ready, true);
  assert.equal(ready.summaryRevision, 1);
  assert.deepEqual(ready.summary, summary);
  assert.equal(ready.sourceRunId, first.activeRunId);
  assert.equal(ready.threadId, "thread-" + first.activeRunId);
  assert.equal(ready.cwd, "D:/demo");
  assert.equal(ready.gitBaseline.commit, "a".repeat(40));
  assert.deepEqual(await f.call("project-state"), ready);
});

test("fresh chat and refresh create new runs, failed refresh requires explicit previous summary adoption", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  await f.finish(a.activeRunId);
  const b = await f.call("project-initialize", init("new-chat", "chat-2"));
  assert.notEqual(b.activeRunId, a.activeRunId);
  assert.equal(b.ready, false);
  assert.equal(b.stale, true);
  assert.equal(
    (await f.call("project-initialize", init("new-chat-replay", "chat-2")))
      .activeRunId,
    b.activeRunId,
  );
  await f.finish(b.activeRunId, false);
  let failed = await f.call("project-state");
  assert.equal(failed.status, "failed");
  assert.equal(failed.ready, false);
  assert.equal(failed.summaryRevision, 1);
  await assert.rejects(
    f.call("project-use-previous", {
      ...init("old-wrong"),
      expectedSummaryRevision: 2,
      expectedSourceRunId: a.activeRunId,
      expectedActiveRunId: b.activeRunId,
    }),
    (e) => e.status === 409,
  );
  const previous = await f.call("project-use-previous", {
    ...init("old"),
    expectedSummaryRevision: 1,
    expectedSourceRunId: a.activeRunId,
    expectedActiveRunId: b.activeRunId,
  });
  assert.equal(previous.ready, true);
  assert.equal(previous.stale, true);
  const c = await f.call("project-refresh", init("refresh"));
  assert.notEqual(c.activeRunId, b.activeRunId);
  await f.finish(c.activeRunId);
  assert.equal((await f.call("project-state")).summaryRevision, 2);
  assert.equal(
    (await f.call("project-refresh", init("refresh"))).summaryRevision,
    2,
  );
});

test("busy directory leaves summary queued and rebindings cannot inject an old summary", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  f.lease([
    {
      run_id: "other-run",
      workspace_id: "workspace",
      lease_epoch: 1,
      expires_at: Date.now() + 60000,
    },
  ]);
  assert.deepEqual(await f.native("poll", {}), { offers: [], deliveries: [] });
  assert.equal((await f.call("project-state")).status, "queued");
  f.lease([]);
  await f.finish(a.activeRunId);
  await assert.rejects(
    f.call("project-state", {}, { ...p, ownerId: "bob" }),
    (e) => e.status === 403,
  );
  f.binding.revision = 2;
  await assert.rejects(
    f.call("project-refresh", init("stale")),
    (e) => e.status === 403,
  );
  const state = await f.call("project-state", {}, { ...p, bindingRevision: 2 });
  assert.equal(state.ready, false);
  assert.equal(state.summary, null);
  await assert.rejects(
    f.call(
      "project-initialize",
      { ...init(), bindingRevision: 2 },
      { ...p, bindingRevision: 2 },
    ),
    (e) => e.status === 409,
    "same request cannot be reused under a new binding revision",
  );
});

test("oversized and mismatched completion evidence never becomes a ready summary", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  await f.finish(a.activeRunId);
  const b = await f.call("project-refresh", init("larger"));
  const r = f.rows.get("exec:run:" + b.activeRunId);
  r.summaryContext = {
    workspaceId: "workspace",
    capturedAt: new Date().toISOString(),
    gitBaseline: r.snapshot.context.gitBaseline,
  };
  r.view = {
    ...r.view,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
    threadId: "current",
    turnId: "current-turn",
  };
  await f.storage.put("exec:run:" + b.activeRunId, r);
  const e = {
    type: "turn.completed",
    runId: b.activeRunId,
    threadId: "current",
    turnId: "current-turn",
    occurredAt: new Date().toISOString(),
    payload: {
      status: "completed",
      summary: {
        ...summary,
        overview: "x".repeat(16000),
        pending: [{ text: "y".repeat(8000) }, { text: "z".repeat(1000) }],
      },
    },
  };
  await f.storage.put("project:result:" + b.activeRunId, e);
  const large = await f.call("project-state");
  assert.equal(large.ready, false);
  assert.equal(large.status, "failed");
  assert.equal(large.summaryRevision, 1);
  await f.storage.put("project:result:" + b.activeRunId, {
    ...e,
    payload: { ...e.payload, summary },
    threadId: "wrong-thread",
  });
  assert.equal((await f.call("project-state")).ready, false);
});

test("recovery after launch commit creates no second summary and native provenance cannot change", async () => {
  const f = fixture();
  await f.seed();
  f.failNextCoordinatorSave();
  await assert.rejects(
    f.call("project-initialize", init()),
    /injected coordinator save failure/,
  );
  assert.equal(
    [...f.rows.keys()].filter((k) => k.startsWith("exec:run:")).length,
    1,
  );
  f.restart();
  const recovered = await f.call("project-initialize", init());
  assert.equal(
    [...f.rows.keys()].filter((k) => k.startsWith("exec:run:")).length,
    1,
  );
  await f.finish(recovered.activeRunId);
  const run = f.rows.get("exec:run:" + recovered.activeRunId);
  await assert.rejects(
    f.native("report", {
      runId: run.view.runId,
      commandId: run.view.commandId,
      revision: 2,
      status: "verifying",
      threadId: run.view.threadId,
      turnId: run.view.turnId,
      terminal: true,
      stopConfirmed: true,
      summaryContext: { ...run.summaryContext, workspaceId: "wrong" },
    }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    f.native("report", {
      runId: run.view.runId,
      commandId: run.view.commandId,
      revision: 2,
      status: "verifying",
      threadId: run.view.threadId,
      turnId: run.view.turnId,
      terminal: true,
      stopConfirmed: true,
      summaryContext: {
        ...run.summaryContext,
        gitBaseline: { commit: null, branch: null, dirty: true },
      },
    }),
    (e) => e.status === 409,
  );
  assert.deepEqual(
    (await f.call("project-state")).gitBaseline,
    run.summaryContext.gitBaseline,
  );
});
