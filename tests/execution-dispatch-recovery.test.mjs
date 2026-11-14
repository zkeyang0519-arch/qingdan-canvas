import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { projectItems, savedProjectSummary } from "./fixtures/project-execution.mjs";
Error.stackTraceLimit = 0;
const bundle = await build({
  entryPoints: [resolve("worker/execution/dispatch.ts")],
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
const principal = {
  ownerId: "alice",
  runnerId: "runner",
  bindingId: "binding",
  bindingRevision: 1,
  authEpoch: 1,
};
function fixture({ managed = false } = {}) {
  const rows = new Map(),
    reservations = new Map();
  let failKey = null,
    leases = [];
  const canvasCalls = [], eventReads = [];
  let canvasHandler = async () => ({});
  const storage = {
    async get(key) {
      return structuredClone(rows.get(key));
    },
    async put(key, value) {
      if (typeof key === "string") rows.set(key, structuredClone(value));
      else
        for (const [k, v] of Object.entries(key))
          rows.set(k, structuredClone(v));
    },
    async delete(key) {
      if (failKey === key) {
        failKey = null;
        throw Error("injected storage failure");
      }
      return rows.delete(key);
    },
    async list({ prefix = "", limit = 1000, reverse = false, startAfter } = {}) {
      let found = [...rows]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || (reverse ? key < startAfter : key > startAfter)))
        .sort(([a], [b]) => a.localeCompare(b));
      if (reverse) found.reverse();
      const selected = found.slice(0, limit);
      if (prefix.startsWith("exec:event:")) eventReads.push({ reverse, count: selected.length });
      return new Map(structuredClone(selected));
    },
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
        displayPath: "demo",
      },
    ]),
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
  const env = {
    BATCH_QUEUE_ENABLED: managed ? "true" : "false",
    ROOMS: {
      idFromName(id) {
        assert.equal(id, "canvas");
        return id;
      },
      get() {
        return {
          async fetch(url, init) {
            const input = JSON.parse(init.body);
            canvasCalls.push(input);
            const value = await canvasHandler(input.input);
            return value instanceof Response ? value : Response.json(value);
          },
        };
      },
    },
    DB: {
      prepare(sql) {
        let args;
        return {
          bind(...value) {
            args = value;
            return this;
          },
          async first() {
            if (sql.includes("agent_execution_requests"))
              return reservations.get(args.join(":"));
            if (sql.includes("agent_workspace_leases"))
              return structuredClone(leases.find(lease => lease.workspace_id === args[1] && (args.length < 3 || lease.run_id === args[2])) ?? null);
            if (sql.includes("agent_bindings")) return binding;
            if (sql.includes("agent_devices")) return device;
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
  const intent = async (input) =>
    (
      await dispatch.fetch(
        new Request("https://runner/execution/intent", {
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
  const putRun = async (
    id = "run",
    {
      terminal = false,
      envelope = true,
      status = terminal ? "verifying" : "running",
      command = "command",
    } = {},
  ) => {
    const payload = {
      type: "create_run",
      requestId: "create-" + id,
      runId: id,
      bindingId: "binding",
      bindingRevision: 1,
      kind: "task",
      snapshotId: "snapshot",
      payloadHash: "a".repeat(64),
    };
    const now = new Date().toISOString();
    const r = {
      principal,
      snapshot: { runId: id, workspaceId: "workspace", kind: "task" },
      reportCommandId: command,
      outputBytes: 0,
      truncated: false,
      view: {
        runId: id,
        bindingId: "binding",
        workspaceId: "workspace",
        kind: "task",
        status,
        threadId: "thread",
        turnId: "turn-new",
        terminal,
        stopConfirmed: terminal,
        reportRevision: 0,
        commandId: command,
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
      },
      commands: [
        {
          payload,
          receipt: {
            runId: id,
            commandId: command,
            status: "accepted",
            acceptedAt: now,
          },
          envelope: envelope
            ? {
                protocolVersion: 1,
                commandId: command,
                runId: id,
                bindingRevision: 1,
                authEpoch: 1,
                leaseEpoch: 1,
                payloadHash: "b".repeat(64),
                issuedAt: now,
                expiresAt: new Date(Date.now() + 300000).toISOString(),
                payload,
              }
            : null,
          ack: null,
          sequence: 1,
          eventFloor: 0,
        },
      ],
    };
    await storage.put("exec:run:" + id, r);
    return r;
  };
  return {
    storage,
    rows,
    native,
    intent,
    get dispatch() { return dispatch; },
    restart() { dispatch = new ExecutionDispatch(storage, env); },
    putRun,
    canvasCalls,
    eventReads,
    canvas(handler) {
      canvasHandler = handler;
    },
    fail(key) {
      failKey = key;
    },
    lease(value) {
      leases = value;
    },
  };
}
const report = {
  runId: "run",
  commandId: "command",
  revision: 1,
  status: "verifying",
  threadId: "thread",
  turnId: "turn-new",
  terminal: true,
  stopConfirmed: true,
};

for (const reportFirst of [true, false]) {
  test(`final answer survives restart with ${reportFirst ? "report" : "events"} delivered first and is cleared on continuation`, async () => {
    const f = fixture();
    await f.putRun();
    const event = { protocolVersion: 1, eventId: "final-output", runnerId: "runner", runId: "run", threadId: "thread", turnId: "turn-new", seq: 1, occurredAt: new Date().toISOString(), type: "turn.completed", payload: { status: "completed", outcome: null, summary: null, error: null, output: "已修复导出，测试通过。" } };
    const sendReport = () => f.native("report", { ...report, output: "已修复导出，测试通过。" });
    const sendEvents = () => f.native("events", { events: [event] });
    await (reportFirst ? sendReport() : sendEvents());
    f.restart();
    await (reportFirst ? sendEvents() : sendReport());
    f.restart();
    const result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
    assert.equal(result.run.output, "已修复导出，测试通过。");
    assert.equal(result.events[0].payload.output, "已修复导出，测试通过。");
    await f.dispatch.tool(principal, "codex_continue_run", { requestId: "follow-final", runId: "run", expectedTurnId: "turn-new", mode: "reply", message: "继续检查" });
    assert.equal((await f.dispatch.tool(principal, "codex_get_run", { runId: "run" })).run.output, undefined);
    await sendReport();
    assert.equal((await f.dispatch.tool(principal, "codex_get_run", { runId: "run" })).run.output, undefined);
  });
}

test("truncated display output retains the assistant phase and item boundary", async () => {
  const f = fixture();
  const run = await f.putRun();
  run.outputBytes = 999999;
  await f.storage.put("exec:run:run", run);
  await f.native("events", { events: [{ protocolVersion: 1, eventId: "truncated-output", runnerId: "runner", runId: "run", threadId: "thread", turnId: "turn-new", seq: 1, occurredAt: new Date().toISOString(), type: "output.delta", payload: { text: "final answer", channel: "assistant", itemId: "answer", phase: "completed", messagePhase: "final_answer" } }] });
  const result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
  assert.equal(result.events[0].payload.messagePhase, "final_answer");
  assert.equal(result.events[0].payload.phase, "completed");
  assert.equal(result.events[0].payload.channel, "assistant");
  assert.equal(result.events[0].payload.itemId, "answer");
});

const finalEvent = (overrides = {}) => ({
  protocolVersion: 1, eventId: "legacy-result", runnerId: "runner", runId: "run", threadId: "thread", turnId: "turn-new", seq: 30001, occurredAt: new Date().toISOString(), type: "turn.completed",
  payload: { status: "completed", summary: null, error: null, outcome: { runId: "run", taskId: "task", outcome: "done", summary: "六项修改已完成，测试通过。", changedFiles: [], evidenceRefs: [], remainingIssues: [], nextTaskNotes: [] } }, ...overrides,
});
const eventKey = (runId, seq) => `exec:event:${runId}:${String(seq).padStart(16, "0")}`;

test("legacy terminal list and get return the final result from a small tail despite 30000 progress events", async () => {
  const f = fixture();
  const run = await f.putRun("run", { terminal: true });
  run.view.lastSeq = 30001;
  f.rows.set("exec:run:run", run);
  f.rows.set("exec:list:binding:" + run.view.createdAt + ":run", "run");
  for (let seq = 1; seq <= 30000; seq++) f.rows.set(eventKey("run", seq), { ...finalEvent({ seq, type: "output.delta" }), payload: { text: "[output truncated]", channel: "assistant" } });
  f.rows.set(eventKey("run", 30001), finalEvent());
  const list = await (await f.dispatch.fetch(new Request("https://runner/execution/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal }) }))).json();
  assert.equal(list.runs[0].output, "六项修改已完成，测试通过。");
  assert.equal(list.runs[0].resultReadComplete, true);
  assert.ok(f.eventReads.reduce((sum, read) => sum + read.count, 0) <= 64);
  assert.ok(f.eventReads.every(read => read.reverse));
  f.eventReads.length = 0;
  const result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
  assert.equal(result.run.output, "六项修改已完成，测试通过。");
  assert.equal(result.run.resultReadComplete, true);
  assert.equal(result.hasMore, true);
  assert.ok(f.eventReads.reduce((sum, read) => sum + read.count, 0) <= 165);
});

test("indexed completion survives restart without scanning older event pages and keeps the detailed report answer", async () => {
  const f = fixture();
  await f.putRun();
  await f.native("events", { events: [finalEvent({ seq: 1 })] });
  await f.native("report", report);
  f.restart();
  const result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
  assert.equal(result.run.output, "六项修改已完成，测试通过。");
  assert.equal(result.run.resultReadComplete, true);
  assert.equal(f.eventReads.filter(read => read.reverse).length, 0);
  await f.native("report", { ...report, revision: 2, output: "详细结果及验证说明。" });
  assert.equal((await f.dispatch.tool(principal, "codex_get_run", { runId: "run" })).run.output, "详细结果及验证说明。");
});

test("terminal lookup never reuses another turn and distinguishes pending delivery from a receipt with no answer", async () => {
  const f = fixture();
  await f.putRun("run", { terminal: true });
  f.rows.set(eventKey("run", 1), finalEvent({ seq: 1, turnId: "old-turn" }));
  let result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
  assert.equal(result.run.output, undefined);
  assert.equal(result.run.resultReadComplete, false);
  f.rows.set(eventKey("run", 2), finalEvent({ seq: 2, payload: { status: "completed", output: "", outcome: null, summary: null, error: null } }));
  result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
  assert.equal(result.run.output, undefined);
  assert.equal(result.run.resultReadComplete, true);
});

for (const indexed of [false, true]) {
  test(`${indexed ? "indexed" : "legacy"} result boundary excludes later next-turn events while preserving the report answer`, async () => {
    const f = fixture();
    await f.putRun();
    const completion = finalEvent({ seq: 1 });
    if (indexed) await f.native("events", { events: [completion] });
    else f.rows.set(eventKey("run", 1), completion);
    await f.native("report", { ...report, output: "详细的本轮最终答复。" });
    await f.native("events", { events: [
      { ...completion, eventId: "next-turn-started", turnId: "next-turn", seq: 2, type: "turn.started", payload: {} },
      { ...completion, eventId: "next-turn-output", turnId: "next-turn", seq: 3, type: "output.delta", payload: { text: "下一轮已经开始", channel: "assistant", itemId: "next-message", phase: "delta" } },
    ] });
    const result = await f.dispatch.tool(principal, "codex_get_run", { runId: "run" });
    assert.equal(result.run.resultSeq, 1);
    assert.equal(result.run.lastSeq, 3);
    assert.equal(result.run.output, "详细的本轮最终答复。");
    assert.equal(result.run.resultReadComplete, true);
  });
}

test("composer settings survive the intent, immutable snapshot and run history", async () => {
  const f = fixture();
  await f.native("context", { contexts: [{ workspaceId: "workspace", capturedAt: new Date().toISOString(), gitBaseline: { commit: null, branch: "main", dirty: false }, threads: [] }] });
  const projectKey = "project:state:" + createHash("sha256").update(JSON.stringify({ p: { authEpoch: 1, bindingId: "binding", bindingRevision: 1, ownerId: "alice", runnerId: "runner" }, workspaceRevision: 1 })).digest("hex");
  await f.storage.put(projectKey, { state: { bindingId: "binding", bindingRevision: 1, status: "ready", ready: true, stale: true, summaryRevision: 7, summary: savedProjectSummary, capturedAt: "2026-11-12T02:00:00.000Z", sourceRunId: "summary-run", threadId: null, turnId: null, cwd: "demo", gitBaseline: null, error: null, activeRunId: null }, acceptedPrevious: true, operationId: null, cwd: "demo" });
  const executionSettings = { model: "test-model", fastMode: true };
  const request = { requestId: "composer-submit", bindingId: "binding", bindingRevision: 1, kind: "task", instruction: "检查项目", executionSettings };
  const { input } = await f.intent(request);
  assert.deepEqual((await f.storage.get("exec:snapshot:" + input.snapshotId)).snapshot.executionSettings, executionSettings);
  await assert.rejects(f.intent({ ...request, executionSettings: { model: "other", fastMode: false } }), { status: 409 });
  await f.dispatch.tool(principal, "codex_create_run", input);
  const { run } = await f.dispatch.tool(principal, "codex_get_run", { runId: input.runId });
  assert.deepEqual(run.executionSettings, executionSettings);
  assert.equal(run.submission.text, "检查项目");
  assert.equal(run.submission.projectSummaryStale, true);
  assert.equal(run.submission.projectCapturedAt, "2026-11-12T02:00:00.000Z");
});

test("project submission snapshots all sources and saved context, revalidates them, and never schedules per-item completion", async () => {
  const f = fixture({ managed: true });
  await f.native("context", { contexts: [{ workspaceId: "workspace", capturedAt: new Date().toISOString(), gitBaseline: { commit: null, branch: "main", dirty: true }, threads: [] }] });
  const projectKey = "project:state:" + createHash("sha256").update(JSON.stringify({
    p: { authEpoch: 1, bindingId: "binding", bindingRevision: 1, ownerId: "alice", runnerId: "runner" }, workspaceRevision: 1,
  })).digest("hex");
  await f.storage.put(projectKey, { state: { bindingId: "binding", bindingRevision: 1, status: "ready", ready: true, stale: false, summaryRevision: 7, summary: savedProjectSummary, capturedAt: "2026-11-12T02:00:00.000Z", sourceRunId: "summary-run", threadId: null, turnId: null, cwd: "demo", gitBaseline: null, error: null, activeRunId: null }, acceptedPrevious: false, operationId: null, cwd: "demo" });
  const items = projectItems();
  const sourceTasks = items.map(({ source }) => ({ noteId: source.taskRef.noteId, taskId: source.taskRef.taskId, generation: source.generation, specRevision: source.specRevision }));
  let stale = false;
  f.canvas(async input => {
    assert.equal(input.action, "snapshot");
    assert.deepEqual(input.tasks, sourceTasks);
    return stale ? Response.json({ error: "待办已变化" }, { status: 409 }) : { items };
  });
  const request = { requestId: "project-submit", bindingId: "binding", bindingRevision: 1, kind: "task", executionMode: "project", sourceTasks };
  const { input } = await f.intent(request);
  assert.deepEqual(await f.intent(request), { input });
  await assert.rejects(f.intent({ ...request, executionMode: undefined }), { status: 409 });
  const { snapshot } = await f.storage.get("exec:snapshot:" + input.snapshotId);
  assert.equal(snapshot.executionMode, "project");
  assert.deepEqual(snapshot.projectTasks, items);
  assert.equal(snapshot.batch, undefined);
  assert.ok(items.every(item => item.taskId !== snapshot.task.taskRef.taskId));
  assert.deepEqual(snapshot.context.projectSummary, savedProjectSummary);
  assert.equal(snapshot.summaryRevision, 7);
  stale = true;
  await assert.rejects(f.dispatch.tool(principal, "codex_create_run", input), { status: 409 });
  assert.equal(await f.storage.get("exec:run:" + input.runId), undefined);
  stale = false;
  const receipt = await f.dispatch.tool(principal, "codex_create_run", input);
  assert.deepEqual(await f.dispatch.tool(principal, "codex_create_run", input), receipt);
  const read = async () => f.dispatch.tool(principal, "codex_get_run", { runId: input.runId });
  const { run } = await read();
  assert.equal(run.executionMode, "project");
  assert.equal(run.sourceBacked, true);
  assert.equal(run.batch, undefined);
  assert.equal(run.queue, undefined);
  assert.deepEqual(run.submission.tasks, items);
  assert.deepEqual(run.submission.projectSummary, savedProjectSummary);
  assert.equal(run.submission.summaryRevision, 7);
  assert.equal(run.submission.projectCapturedAt, "2026-11-12T02:00:00.000Z");
  assert.equal(run.submission.projectSummaryStale, false);
  assert.match(run.submission.text, /CSV 导出/);
  assert.match(run.submission.text, /按钮溢出/);
  const list = await (await f.dispatch.fetch(new Request("https://runner/execution/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal }) }))).json();
  assert.deepEqual(list.runs[0].submission, run.submission);
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), input.runId);
  const second = await f.intent({ ...request, requestId: "another-project-submit" });
  await assert.rejects(f.dispatch.tool(principal, "codex_create_run", second.input), { status: 409 });
  f.lease([{ run_id: input.runId, workspace_id: "workspace", lease_epoch: 1, expires_at: Date.now() + 60000 }]);
  const delivered = await f.native("poll", {});
  assert.equal(delivered.deliveries.length, 1);
  assert.deepEqual(delivered.deliveries[0].snapshot.projectTasks, items);
  for (const status of ["stored", "applied"]) await f.native("ack", { commandId: receipt.commandId, status });
  const eventBase = { protocolVersion: 1, runnerId: "runner", runId: input.runId, threadId: report.threadId, turnId: report.turnId, occurredAt: new Date().toISOString() };
  await f.native("events", { events: [
    { ...eventBase, eventId: "project-command", seq: 1, type: "output.delta", payload: { channel: "command", itemId: "command-item", phase: "started", title: "npm test", text: "" } },
    { ...eventBase, eventId: "project-answer", seq: 2, type: "output.delta", payload: { channel: "assistant", itemId: "answer-item", phase: "completed", text: "已处理所选待办，详见验证。" } },
    { ...eventBase, eventId: "project-result", seq: 3, type: "turn.completed", payload: { status: "completed", outcome: { runId: input.runId, taskId: snapshot.task.taskRef.taskId, outcome: "done", summary: "导出和移动端修改完成，待用户核对。", changedFiles: [], evidenceRefs: [], remainingIssues: [], nextTaskNotes: [] }, summary: null, error: null } },
  ] });
  await f.native("report", { ...report, runId: input.runId, commandId: receipt.commandId });
  assert.equal((await read()).run.status, "verifying");
  assert.equal((await read()).run.stopConfirmed, true);
  assert.equal((await read()).events[0].payload.channel, "command");
  assert.equal((await read()).events[2].payload.outcome.summary, "导出和移动端修改完成，待用户核对。");
  assert.equal(await f.storage.get("exec:writebacks:" + input.runId), undefined);
  assert.equal(f.canvasCalls.filter(c => c.input.action === "finalize").length, 0);
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), undefined);
  const followup = { requestId: "follow-project", runId: input.runId, expectedTurnId: report.turnId, mode: "reply", message: "继续核对导出。" };
  stale = true;
  await assert.rejects(f.dispatch.tool(principal, "codex_continue_run", followup), { status: 409 });
  stale = false;
  await f.dispatch.tool(principal, "codex_continue_run", followup);
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), input.runId);
  const cancelled = await f.dispatch.tool(principal, "codex_cancel_run", { requestId: "stop-project", runId: input.runId });
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), input.runId);
  // A request to stop is not enough to release the project reservation.
  f.lease([{ run_id: input.runId, workspace_id: "workspace", lease_epoch: 2, expires_at: Date.now() + 60000 }]);
  await f.native("poll", {});
  for (const status of ["stored", "applied"]) await f.native("ack", { commandId: cancelled.commandId, status });
  await f.native("report", { ...report, runId: input.runId, commandId: cancelled.commandId, revision: 2, status: "cancelled" });
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), undefined);
  await f.dispatch.tool(principal, "codex_create_run", second.input);
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"), second.input.runId);
});

async function cancelledContinuation(mode = "steer", delivered = false) {
  const f = fixture();
  await f.native("context", { contexts: [{ workspaceId: "workspace", capturedAt: new Date().toISOString(), gitBaseline: { commit: null, branch: null, dirty: false }, threads: [] }] });
  const { input } = await f.intent({ requestId: "intent", bindingId: "binding", bindingRevision: 1, kind: "task", instruction: "synthetic task" });
  const created = await f.dispatch.tool(principal, "codex_create_run", input);
  const lease = { run_id: input.runId, workspace_id: "workspace", lease_epoch: 1, expires_at: Date.now() + 60000 };
  f.lease([lease]);
  assert.equal((await f.native("poll", {})).deliveries[0].envelope.commandId, created.commandId);
  for (const status of ["stored", "applied"]) await f.native("ack", { commandId: created.commandId, status });
  await f.native("report", { ...report, runId: input.runId, commandId: created.commandId, status: mode === "reply" ? "verifying" : "running", terminal: mode === "reply", stopConfirmed: mode === "reply" });
  const continued = await f.dispatch.tool(principal, "codex_continue_run", { requestId: "continue", runId: input.runId, expectedTurnId: report.turnId, mode, message: "continue" });
  if (delivered) {
    lease.lease_epoch++;
    f.lease([lease]);
    assert.equal((await f.native("poll", {})).deliveries[0].envelope.commandId, continued.commandId);
  }
  const cancelled = await f.dispatch.tool(principal, "codex_cancel_run", { requestId: "cancel", runId: input.runId });
  f.lease([{ ...lease, expires_at: Date.now() - 60000 }]);
  const run = () => f.storage.get("exec:run:" + input.runId);
  const inspect = leaseEpoch => f.native("reconcile", { phase: "inspect", runId: input.runId, workspaceId: "workspace", leaseEpoch });
  const confirmation = ticket => ({ phase: "confirm", runId: input.runId, recoveryId: ticket.recoveryId, requestId: "confirm-" + ticket.recoveryId,
    proof: { kind: "native_stopped", consumerHeld: true, claim: { runId: input.runId, workspaceId: "workspace", leaseEpoch: ticket.leaseEpoch, lockToken: "original-lock" }, journal: { commandId: ticket.originalCommandId, snapshotHash: ticket.snapshotHash, sealed: true }, threadId: report.threadId, turnId: report.turnId, turnsStopped: true, backgroundTerminalsStopped: true },
    report: { ...report, runId: input.runId, commandId: ticket.currentCommandId, revision: ticket.reportRevision + 1, status: "cancelled" } });
  return { ...f, runId: input.runId, created, continued, cancelled, run, inspect, confirmation };
}

for (const mode of ["steer", "reply"]) test(`cancelled undispatched continuation permits expired-lease stop reconciliation: ${mode}`, async () => {
  const f = await cancelledContinuation(mode);
  let run = await f.run();
  assert.deepEqual(run.commands.map(command => [command.payload.type, !!command.envelope, !!command.settled]), [["create_run", true, true], ["continue_run", false, true], ["cancel_run", false, false]]);
  assert.deepEqual(await f.native("poll", {}), { offers: [], deliveries: [] });
  assert.deepEqual(await f.native("report", { ...report, runId: f.runId, commandId: f.created.commandId, revision: 2, status: "cancelled" }), { ok: true, ignored: true }, "ordinary old-command reports still cannot settle a newer head");
  const { ticket } = await f.inspect(1);
  assert.equal(ticket.action, "stop");
  assert.equal(ticket.originalCommandId, f.created.commandId);
  assert.equal(ticket.currentCommandId, f.cancelled.commandId);
  const confirm = f.confirmation(ticket);
  const wrongClaim = structuredClone(confirm);
  wrongClaim.proof.claim.leaseEpoch++;
  await assert.rejects(f.native("reconcile", wrongClaim), { status: 409 });
  const wrongJournal = structuredClone(confirm);
  wrongJournal.proof.journal.commandId = f.continued.commandId;
  await assert.rejects(f.native("reconcile", wrongJournal), { status: 409 });
  const settled = await f.native("reconcile", confirm);
  assert.equal(settled.settled, true);
  assert.deepEqual(await f.native("reconcile", confirm), settled);
  run = await f.run();
  assert.equal(run.view.status, "cancelled");
  assert.equal(run.view.terminal && run.view.stopConfirmed, true);
  assert.equal(run.commands[1].envelope, null);
  assert.equal(run.commands[1].ack, null);
  assert.equal(await f.storage.get("exec:active"), undefined);
});

for (const condition of ["unsealed", "acknowledged", "reported", "changed-head"]) test(`cancelled undispatched continuation rejects inconsistent ${condition} evidence`, async () => {
  const f = await cancelledContinuation();
  const run = await f.run(), continued = run.commands[1];
  // Contradictory records are deliberate guard probes, not claimed public flows.
  if (condition === "unsealed") continued.settled = false;
  if (condition === "acknowledged") continued.ack = { commandId: f.continued.commandId, status: "stored" };
  if (condition === "reported") run.reportCommandId = f.continued.commandId;
  if (condition === "changed-head") run.view.commandId = f.continued.commandId;
  await f.storage.put("exec:run:" + f.runId, run);
  await assert.rejects(f.inspect(1), { status: 409 });
  assert.equal((await f.storage.list({ prefix: "exec:reconcile-ticket:" })).size, 0);
  assert.equal((await f.run()).view.stopConfirmed, false);
});

test("cancelled undispatched continuation exception never skips an actually issued reply or its lease", async () => {
  const f = await cancelledContinuation("reply", true);
  await assert.rejects(f.inspect(1), { status: 409 });
  const { ticket } = await f.inspect(2);
  assert.equal(ticket.originalCommandId, f.continued.commandId);
  assert.equal(ticket.currentCommandId, f.cancelled.commandId);
  const staleProof = f.confirmation(ticket);
  staleProof.proof.journal.commandId = f.created.commandId;
  await assert.rejects(f.native("reconcile", staleProof), { status: 409 });
  assert.equal((await f.run()).view.stopConfirmed, false);
});

test("managed dispatch persists ordered permits, pause CAS, writeback retry, final stop and directory reservation", async () => {
  const f=fixture({managed:true});
  await f.native("context",{contexts:[{workspaceId:"workspace",capturedAt:new Date().toISOString(),gitBaseline:{commit:null,branch:null,dirty:false},threads:[]}]});
  const items=[0,1,2].map(i=>({taskId:`task-${i}`,text:`任务 ${i}`,instruction:`写 ${i}`,acceptance:[{id:`check-${i}`,kind:"artifact",description:`文件 ${i}`,required:true,relativePath:`${i}.txt`,predicate:{type:"exists"}}],source:{taskRef:{canvasId:"canvas",noteId:"note",taskId:`task-${i}`},generation:1,specRevision:1}}));
  let outage=true, writes=[];
  f.canvas(async input=>{
    if(["snapshot","validate"].includes(input.action))return {items:items.filter(i=>input.tasks.some(t=>t.taskId===i.taskId))};
    writes.push(input);return outage?Response.json({error:"offline"},{status:503}):{status:"applied"};
  });
  const request={requestId:"managed",bindingId:"binding",bindingRevision:1,kind:"task",sourceTasks:items.map(i=>({noteId:"note",taskId:i.taskId,generation:1,specRevision:1})),autoComplete:true};
  const {input}=await f.intent(request);const receipt=await f.dispatch.tool(principal,"codex_create_run",input);
  assert.equal((await f.storage.get("exec:run:"+input.runId)).snapshot.batch.managed,true);
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"),input.runId);
  const another=(await f.intent({...request,requestId:"second"})).input;
  await assert.rejects(f.dispatch.tool(principal,"codex_create_run",another),/未完成的批次/);
  f.lease([{run_id:input.runId,workspace_id:"workspace",lease_epoch:1,expires_at:Date.now()+60000}]);
  await f.native("poll",{});
  const read=async()=>(await f.dispatch.tool(principal,"codex_get_run",{runId:input.runId})).run;
  const control=async(action,revision,extra={})=>(await f.dispatch.fetch(new Request("https://runner/execution/queue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({principal,input:{bindingId:"binding",bindingRevision:1,runId:input.runId,requestId:crypto.randomUUID(),expectedRevision:revision,action,...extra}})}))).json();
  const progress={currentIndex:0,items:items.map(i=>({taskId:i.taskId,text:i.text,status:"pending",summary:""}))};
  let seq=0;
  for(let i=0;i<3;i++) {
    progress.currentIndex=i;progress.items[i]={...progress.items[i],status:"done",summary:"已写文件",completedTurnId:`turn-${i}`};
    const state={...report,runId:input.runId,commandId:receipt.commandId,revision:i+1,turnId:`turn-${i}`,status:"running",terminal:false,stopConfirmed:false,batch:structuredClone(progress)};
    await f.native("report",state);
    const gateInput={runId:input.runId,commandId:receipt.commandId,fromIndex:i,completedTurnId:`turn-${i}`,reportRevision:i+1};
    assert.equal((await f.native("batch-gate",gateInput)).decision,"wait");
    assert.equal(writes.length,i===0?0:2+i-1);
    const event=(type,payload)=>({protocolVersion:1,eventId:crypto.randomUUID(),runnerId:"runner",runId:input.runId,threadId:"thread",turnId:`turn-${i}`,seq:++seq,occurredAt:new Date().toISOString(),type,payload});
    await f.native("events",{events:[event("turn.completed",{status:"completed",outcome:{runId:input.runId,taskId:items[i].taskId,outcome:"done",summary:"完成",changedFiles:[`${i}.txt`],evidenceRefs:[],remainingIssues:[],nextTaskNotes:[]},summary:null,error:null}),event("verification.completed",{results:[{criterionId:`check-${i}`,status:"passed",evidenceRefs:[`native:${i}.txt`],outputHash:"a".repeat(64)}]})]});
    if(i===0) {
      await control("pause",(await read()).queue.revision);
      await assert.rejects(control("resume",1),/状态已更改/);
      assert.equal((await f.native("batch-gate",gateInput)).decision,"wait");
      assert.equal((await read()).queue.phase,"finalizing");
      outage=false;
      const pending=await f.storage.get("exec:writebacks:"+input.runId);pending.entries[0].nextAt=0;await f.storage.put("exec:writebacks:"+input.runId,pending);
      assert.equal((await f.native("batch-gate",gateInput)).decision,"wait");
      assert.equal((await read()).queue.phase,"paused");
      await control("resume",(await read()).queue.revision);
    }
    const permit=await f.native("batch-gate",gateInput);
    assert.equal(permit.decision,i===2?"finish":"advance");
    assert.deepEqual(await f.native("batch-gate",gateInput),permit);
    if(i<2)assert.equal((await read()).queue.currentIndex,i+1);
    if(i>0)await assert.rejects(f.native("batch-gate",{...gateInput,completedTurnId:"turn-0"}),/轮次或报告/);
  }
  const current=await read();assert.equal(current.terminal,false);assert.equal(writes.length,4);
  await f.native("report",{...report,runId:input.runId,commandId:receipt.commandId,revision:4,turnId:"turn-2",batch:progress});
  assert.equal((await read()).queue.phase,"completed");
  assert.equal(await f.storage.get("exec:queue-workspace:workspace"),undefined);
  assert.equal(await f.storage.get("exec:active"),undefined);
});

test("managed cancellation before launch stops the whole queue and clears its logical reservation",async()=>{
  const f=fixture({managed:true});await f.native("context",{contexts:[{workspaceId:"workspace",capturedAt:new Date().toISOString(),gitBaseline:{commit:null,branch:null,dirty:false},threads:[]}]});
  const {input}=await f.intent({requestId:"cancel-managed",bindingId:"binding",bindingRevision:1,kind:"task",items:[{instruction:"one"},{instruction:"two"}]});
  await f.dispatch.tool(principal,"codex_create_run",input);
  await f.dispatch.tool(principal,"codex_cancel_run",{requestId:"cancel-queue",runId:input.runId});
  const {run}=await f.dispatch.tool(principal,"codex_get_run",{runId:input.runId});assert.equal(run.queue.phase,"cancelled");assert.equal(run.stopConfirmed,true);assert.equal(await f.storage.get("exec:queue-workspace:workspace"),undefined);
});

async function seedBatch(f, statuses) {
  const run = await f.putRun();
  run.view.batch = {
    currentIndex: Math.min(1, statuses.length - 1),
    items: statuses.map((status, i) => ({
      taskId: `item-${i + 1}`,
      text: `任务 ${i + 1}`,
      status,
      summary: status === "done" ? "完成" : "",
    })),
  };
  run.snapshot.batch = {
    items: run.view.batch.items.map(({ taskId, text }) => ({
      taskId,
      text,
      instruction: text,
      acceptance: [
        { id: "human", kind: "human", description: "确认", required: true },
      ],
    })),
  };
  await f.storage.put("exec:run:run", run);
  return run;
}

test("accepted real-task reports use a durable immutable writeback and expose its result", async () => {
  const f = fixture(),
    run = await seedBatch(f, ["running", "pending"]);
  run.snapshot.batch.autoComplete = true;
  for (const item of run.snapshot.batch.items)
    item.source = {
      taskRef: { canvasId: "canvas", noteId: "note", taskId: item.taskId },
      generation: 1,
      specRevision: 1,
    };
  await f.storage.put("exec:run:run", run);
  f.canvas(async () => ({ status: "applied" }));
  const progress = structuredClone(run.view.batch);
  progress.currentIndex = 0;
  progress.items[0].status = "done";
  progress.items[0].completedTurnId = "first-turn";
  await f.native("report", {
    ...report,
    status: "running",
    terminal: false,
    stopConfirmed: false,
    batch: progress,
  });
  assert.equal(f.canvasCalls.length, 1);
  assert.equal(f.canvasCalls[0].input.action, "finalize");
  assert.deepEqual(
    f.canvasCalls[0].input.source,
    run.snapshot.batch.items[0].source,
  );
  const view = await f.dispatch.tool(principal, "codex_get_run", {
    runId: "run",
  });
  assert.equal(view.run.batch.items[0].writeback.status, "applied");
  await f.native("report", {
    ...report,
    status: "running",
    terminal: false,
    stopConfirmed: false,
    batch: progress,
  });
  assert.equal(f.canvasCalls.length, 1);
});

test("cancelled or superseded report cannot newly check off source tasks", async () => {
  const f = fixture(),
    run = await seedBatch(f, ["running", "pending"]);
  run.snapshot.batch.autoComplete = true;
  for (const item of run.snapshot.batch.items)
    item.source = {
      taskRef: { canvasId: "canvas", noteId: "note", taskId: item.taskId },
      generation: 1,
      specRevision: 1,
    };
  await f.storage.put("exec:run:run", run);
  await f.dispatch.tool(principal, "codex_cancel_run", {
    requestId: "cancel-linked",
    runId: "run",
  });
  const progress = structuredClone(run.view.batch);
  progress.items[0].status = "done";
  progress.items[0].completedTurnId = "first-turn";
  await f.native("report", { ...report, batch: progress });
  assert.equal(f.canvasCalls.length, 0);
});

test("terminal cancellation settles every unfinished batch item", async () => {
  for (const pendingCancel of [false, true]) {
    const f = fixture();
    const run = await seedBatch(f, ["done", "blocked", "pending"]);
    if (pendingCancel) {
      await f.dispatch.tool(principal, "codex_cancel_run", {
        requestId: "cancel",
        runId: "run",
      });
    }
    const payload = pendingCancel
      ? report // A prior turn's terminal report proves the pending cancel can settle.
      : { ...report, status: "cancelled", batch: run.view.batch };
    assert.equal((await f.native("report", payload)).settled, true);
    const current = await f.storage.get("exec:run:run");
    assert.equal(current.view.status, "cancelled");
    assert.equal(current.view.batch.currentIndex, 1);
    assert.deepEqual(current.view.batch.items, [
      run.view.batch.items[0],
      { ...run.view.batch.items[1], status: "cancelled" },
      { ...run.view.batch.items[2], status: "cancelled" },
    ]);
    assert.equal((await f.native("report", payload)).ignored, true);
  }
});

test("an uncertain batch ACK can recover to applied without regressing on older replays", async () => {
  const f = fixture();
  await seedBatch(f, ["running", "pending"]);
  await f.storage.put("exec:command-run:command", "run");
  const stored = { commandId: "command", status: "stored" };
  const uncertain = {
    ...stored,
    status: "uncertain",
    reason: "interrupted before receipt",
  };
  const applied = { ...stored, status: "applied" };
  await f.native("ack", stored);
  await f.native("ack", uncertain);
  await assert.rejects(f.native("ack", { ...applied, connectionEpoch: 2 }), {
    status: 409,
  });
  assert.deepEqual(await f.native("ack", applied), { ok: true });
  assert.deepEqual(await f.native("ack", uncertain), { ok: true });
  assert.deepEqual(await f.native("ack", applied), { ok: true });
  assert.deepEqual(await f.native("ack", stored), { ok: true });
  await assert.rejects(f.native("ack", { ...uncertain, reason: "different" }), {
    status: 409,
  });
  assert.deepEqual(
    (await f.storage.get("exec:run:run")).commands[0].ack,
    applied,
  );
});

test("an uncertain non-batch ACK cannot change to applied", async () => {
  const f = fixture();
  await f.putRun();
  await f.storage.put("exec:command-run:command", "run");
  const stored = { commandId: "command", status: "stored" };
  await f.native("ack", stored);
  await f.native("ack", { ...stored, status: "uncertain" });
  await assert.rejects(f.native("ack", { ...stored, status: "applied" }), {
    status: 409,
  });
});

const batchIntent = {
  requestId: "batch",
  bindingId: "binding",
  bindingRevision: 1,
  kind: "task",
  items: [
    { instruction: " 写第一项 ", acceptance: "核对第一项" },
    { instruction: "写第二项" },
  ],
};

test("real checklist intent derives its task data and revalidates saved versions before dispatch", async () => {
  const f = fixture();
  await f.native("context", {
    contexts: [
      {
        workspaceId: "workspace",
        capturedAt: new Date().toISOString(),
        gitBaseline: { commit: null, branch: null, dirty: false },
        threads: [],
      },
    ],
  });
  const sourceTasks = [
    {
      noteId: "real-note",
      taskId: "real-task",
      generation: 7,
      specRevision: 3,
    },
  ];
  let changed = false;
  f.canvas(async (input) => {
    assert.equal(input.action, "snapshot");
    assert.deepEqual(input.tasks, sourceTasks);
    return changed
      ? Response.json({ error: "待办已变化" }, { status: 409 })
      : {
          items: [
            {
              taskId: "real-task",
              text: "真实待办标题",
              instruction: "已保存的执行要求",
              acceptance: [
                {
                  id: "review",
                  kind: "human",
                  description: "已保存的标准",
                  required: true,
                },
              ],
              source: {
                taskRef: {
                  canvasId: "canvas",
                  noteId: "real-note",
                  taskId: "real-task",
                },
                generation: 7,
                specRevision: 3,
              },
            },
          ],
        };
  });
  const { input } = await f.intent({
    requestId: "real-intent",
    bindingId: "binding",
    bindingRevision: 1,
    kind: "task",
    sourceTasks,
    autoComplete: true,
  });
  const saved = await f.storage.get("exec:snapshot:" + input.snapshotId);
  assert.equal(saved.snapshot.task.taskRef.noteId, "real-note");
  assert.equal(saved.snapshot.task.specRevision, 3);
  assert.equal(saved.snapshot.batch.autoComplete, true);
  assert.equal(saved.snapshot.batch.items[0].instruction, "已保存的执行要求");
  changed = true;
  await assert.rejects(f.dispatch.tool(principal, "codex_create_run", input), {
    status: 409,
  });
  assert.equal(await f.storage.get("exec:run:" + input.runId), undefined);
  changed = false;
  await f.dispatch.tool(principal, "codex_create_run", input);
  assert.equal(f.canvasCalls.length, 3);
});

test("one batch is delivered in order under one immutable run and keeps its lease between items", async () => {
  const f = fixture();
  await f.native("context", {
    contexts: [
      {
        workspaceId: "workspace",
        capturedAt: new Date().toISOString(),
        gitBaseline: { commit: null, branch: null, dirty: false },
        threads: [],
      },
    ],
  });
  const { input } = await f.intent(batchIntent);
  assert.deepEqual(await f.intent(batchIntent), { input });
  await assert.rejects(
    f.intent({ ...batchIntent, items: [...batchIntent.items].reverse() }),
    /请求编号已用于不同内容/,
  );
  await f.dispatch.tool(principal, "codex_create_run", input);
  const view = async () =>
    (await f.dispatch.tool(principal, "codex_get_run", { runId: input.runId }))
      .run;
  const firstId = `${input.runId}-item-1`,
    secondId = `${input.runId}-item-2`;
  const pending = {
    currentIndex: 0,
    items: [
      { taskId: firstId, text: "写第一项", status: "pending", summary: "" },
      { taskId: secondId, text: "写第二项", status: "pending", summary: "" },
    ],
  };
  assert.deepEqual((await view()).batch, pending);
  f.lease([
    {
      run_id: input.runId,
      workspace_id: "workspace",
      lease_epoch: 1,
      expires_at: Date.now() + 60000,
    },
  ]);
  const [{ envelope, snapshot }] = (await f.native("poll", {})).deliveries;
  assert.equal(snapshot.task.taskRef.taskId, firstId);
  assert.equal(snapshot.payloadHash, input.payloadHash);
  assert.deepEqual(
    snapshot.batch.items.map(({ taskId, text, instruction, acceptance }) => [
      taskId,
      text,
      instruction,
      acceptance[0].description,
    ]),
    [
      [firstId, "写第一项", "写第一项", "核对第一项"],
      [secondId, "写第二项", "写第二项", "由用户检查本次试运行结果。"],
    ],
  );

  const update = {
    ...report,
    runId: input.runId,
    commandId: envelope.commandId,
    status: "running",
    terminal: false,
    stopConfirmed: false,
  };
  const inProgress = {
    currentIndex: 1,
    items: [
      { ...pending.items[0], status: "done", summary: "完成第一项" },
      { ...pending.items[1], status: "running" },
    ],
  };
  for (const invalid of [
    { ...inProgress, currentIndex: 2 },
    { ...inProgress, currentIndex: 0, items: [] },
    { ...inProgress, currentIndex: 0, items: inProgress.items.slice(0, 1) },
    { ...inProgress, items: [...inProgress.items].reverse() },
    {
      ...inProgress,
      items: [
        inProgress.items[0],
        { ...inProgress.items[1], text: "错误的标题" },
      ],
    },
  ]) {
    await assert.rejects(f.native("report", { ...update, batch: invalid }));
  }
  assert.deepEqual((await view()).batch, pending);
  assert.deepEqual(await f.native("report", { ...update, batch: inProgress }), {
    ok: true,
  });
  assert.deepEqual((await view()).batch, inProgress);
  assert.deepEqual(await f.native("report", { ...update, revision: 2 }), {
    ok: true,
  });
  assert.deepEqual(
    (await view()).batch,
    inProgress,
    "older clients omit batch progress",
  );
  assert.equal(await f.storage.get("exec:active"), input.runId);
  assert.equal((await view()).terminal, false);
});

test("manual intents reject ambiguous batch fields and oversized snapshots", async () => {
  const f = fixture();
  await f.native("context", {
    contexts: [
      {
        workspaceId: "workspace",
        capturedAt: new Date().toISOString(),
        gitBaseline: { commit: null, branch: null, dirty: false },
        threads: [],
      },
    ],
  });
  for (const invalid of [
    { instruction: "一起传入" },
    { acceptance: "任务验收属于单项" },
    { kind: "summary" },
    { items: [] },
    { items: Array.from({ length: 51 }, () => ({ instruction: "任务" })) },
    { items: [{ instruction: " " }] },
    { items: undefined },
  ]) {
    await assert.rejects(f.intent({ ...batchIntent, ...invalid }), {
      status: 400,
    });
  }
  await assert.rejects(
    f.intent({
      ...batchIntent,
      items: [{ instruction: "中".repeat(20000) }],
    }),
    { status: 413 },
  );
});

test("a non-batch run cannot acquire progress through a native report", async () => {
  const f = fixture();
  await f.putRun();
  await assert.rejects(
    f.native("report", {
      ...report,
      batch: {
        currentIndex: 0,
        items: [
          { taskId: "foreign", text: "外部任务", status: "done", summary: "" },
        ],
      },
    }),
    { status: 409 },
  );
  assert.equal((await f.storage.get("exec:run:run")).view.reportRevision, 0);
});

test("reply cannot queue a command for a completed or cancelled batch", async () => {
  for (const [status, itemStatus] of [
    ["verifying", "done"],
    ["cancelled", "cancelled"],
  ]) {
    const f = fixture();
    const r = await f.putRun("run", { terminal: true, status });
    r.view.batch = {
      currentIndex: 0,
      items: [
        { taskId: "item", text: "任务", status: itemStatus, summary: "" },
      ],
    };
    await f.storage.put("exec:run:run", r);
    await assert.rejects(
      f.dispatch.tool(principal, "codex_continue_run", {
        requestId: "reply",
        runId: "run",
        expectedTurnId: "turn-new",
        message: "继续",
        mode: "reply",
      }),
      { status: 409 },
    );
    assert.equal((await f.storage.get("exec:run:run")).commands.length, 1);
    assert.equal(await f.storage.get("exec:pending:run"), undefined);
  }
});

test("reply still queues for a paused batch and a legacy single task", async () => {
  for (const pausedBatch of [true, false]) {
    const f = fixture();
    const r = await f.putRun("run", {
      terminal: true,
      status: pausedBatch ? "waiting_input" : "verifying",
    });
    if (pausedBatch) {
      r.view.batch = {
        currentIndex: 0,
        items: [
          { taskId: "item", text: "任务", status: "blocked", summary: "" },
        ],
      };
      await f.storage.put("exec:run:run", r);
    }
    const receipt = await f.dispatch.tool(principal, "codex_continue_run", {
      requestId: "reply",
      runId: "run",
      expectedTurnId: "turn-new",
      message: "继续",
      mode: "reply",
    });
    assert.equal(receipt.status, "accepted");
    assert.equal((await f.storage.get("exec:run:run")).commands.length, 2);
    assert.equal(await f.storage.get("exec:pending:run"), "run");
  }
});

test("terminal report retries finish pending and active cleanup after either storage interruption", async () => {
  for (const failedKey of ["exec:pending:run", "exec:active"]) {
    const f = fixture();
    await f.putRun();
    await f.putRun("next", { envelope: false });
    await f.storage.put({
      "exec:pending:run": "run",
      "exec:pending:next": "next",
      "exec:active": "run",
    });
    f.fail(failedKey);
    await assert.rejects(f.native("report", report), /injected/);
    const retry = await f.native("report", report);
    assert.equal(retry.settled, true);
    assert.equal(await f.storage.get("exec:active"), undefined);
    assert.equal(await f.storage.get("exec:pending:run"), undefined);
    assert.deepEqual((await f.native("poll", {})).offers, [
      { runId: "next", workspaceId: "workspace" },
    ]);
    await f.storage.put("exec:active", "another");
    await f.native("report", report);
    assert.equal(await f.storage.get("exec:active"), "another");
  }
});
test("queued cancellation receipt retries finish cleanup without another command", async () => {
  const f = fixture();
  await f.putRun("run", { envelope: false });
  await f.storage.put("exec:pending:run", "run");
  const input = { requestId: "cancel", runId: "run" };
  f.fail("exec:pending:run");
  await assert.rejects(
    f.dispatch.tool(principal, "codex_cancel_run", input),
    /injected/,
  );
  const retry = await f.dispatch.tool(principal, "codex_cancel_run", input);
  assert.equal(retry.status, "accepted");
  assert.equal(await f.storage.get("exec:pending:run"), undefined);
  assert.equal((await f.storage.get("exec:run:run")).commands.length, 2);
});
test("delayed events and clock offsets cannot overwrite report-established current turn", async () => {
  const f = fixture();
  await f.putRun();
  const future = new Date(Date.now() + 5000);
  for (const [i, time] of [
    future.toISOString(),
    new Date(+future + 8 * 3600000).toISOString().replace("Z", "+08:00"),
  ].entries()) {
    await f.native("events", {
      events: [
        {
          protocolVersion: 1,
          eventId: "old-" + i,
          runnerId: "runner",
          runId: "run",
          threadId: "thread",
          turnId: "turn-old",
          seq: i + 1,
          occurredAt: time,
          type: "turn.started",
          payload: {},
        },
      ],
    });
  }
  const r = await f.storage.get("exec:run:run");
  assert.equal(r.view.turnId, "turn-new");
  assert.equal(r.view.status, "running");
  assert.equal(r.view.lastSeq, 2);
});
test("reply cannot overflow pending cap and active cancellation remains reachable beyond a prefix page", async () => {
  const f = fixture();
  await f.putRun("finished", { terminal: true });
  for (let i = 0; i < 100; i++)
    await f.storage.put("exec:pending:a" + String(i).padStart(3, "0"), "a" + i);
  await assert.rejects(
    f.dispatch.tool(principal, "codex_continue_run", {
      requestId: "reply",
      runId: "finished",
      expectedTurnId: "turn-new",
      message: "continue",
      mode: "reply",
    }),
    /上限/,
  );
  assert.equal((await f.storage.get("exec:run:finished")).view.terminal, true);
  const active = await f.putRun("zz-active", {
    status: "cancel_requested",
    envelope: false,
    command: "cancel",
  });
  active.commands[0].payload = {
    type: "cancel_run",
    requestId: "cancel",
    runId: "zz-active",
  };
  await f.storage.put({
    "exec:run:zz-active": active,
    "exec:pending:zz-active": "zz-active",
    "exec:active": "zz-active",
  });
  f.lease([
    {
      run_id: "zz-active",
      workspace_id: "workspace",
      lease_epoch: 1,
      expires_at: Date.now() + 60000,
    },
  ]);
  assert.equal(
    (await f.native("poll", {})).deliveries[0]?.envelope.payload.type,
    "cancel_run",
  );
});
test("stored ACK signals retired delivery, and stale terminal reports cannot authorize lease release", async () => {
  const f = fixture(),
    r = await f.putRun();
  await f.storage.put("exec:command-run:command", "run");
  await f.native("ack", { commandId: "command", status: "stored" });
  r.commands[0].settled = true;
  r.view.commandId = "next";
  r.commands.push({
    ...r.commands[0],
    receipt: { ...r.commands[0].receipt, commandId: "next" },
    settled: false,
    payload: {
      type: "continue_run",
      runId: "run",
      requestId: "next",
      mode: "steer",
      expectedTurnId: "turn-new",
      message: "new",
    },
  });
  await f.storage.put("exec:run:run", r);
  assert.equal(
    (await f.native("ack", { commandId: "command", status: "stored" }))
      .superseded,
    true,
  );
  assert.equal((await f.native("report", report)).settled, undefined);
});

test("only an older applied batch command loses advance authorization after a newer steer", async () => {
  for (const [batch, applied, expected] of [
    [true, true, { ok: true, superseded: true }],
    [true, false, { ok: true }],
    [false, true, { ok: true }],
  ]) {
    const f = fixture(),
      run = await f.putRun();
    if (batch) {
      run.snapshot.batch = {
        items: [
          {
            taskId: "item-1",
            text: "第一项",
            instruction: "第一项",
            acceptance: [],
          },
        ],
      };
      run.view.batch = {
        currentIndex: 0,
        items: [
          { taskId: "item-1", text: "第一项", status: "running", summary: "" },
        ],
      };
      await f.storage.put("exec:run:run", run);
    }
    await f.storage.put("exec:command-run:command", "run");
    const stored = { commandId: "command", status: "stored" };
    if (applied) {
      await f.native("ack", stored);
      await f.native("ack", { ...stored, status: "applied" });
      assert.deepEqual(await f.native("ack", stored), { ok: true });
    }

    const steer = await f.dispatch.tool(principal, "codex_continue_run", {
      requestId: "new-steer",
      runId: "run",
      expectedTurnId: "turn-new",
      message: "补充说明",
      mode: "steer",
    });
    assert.deepEqual(await f.native("ack", stored), expected);
    const current = await f.storage.get("exec:run:run");
    assert.equal(current.view.commandId, steer.commandId);
    assert.equal(
      current.commands[0].ack.status,
      applied ? "applied" : "stored",
    );
    assert.equal(current.commands[0].settled, undefined);
  }
});

test("cancellation stays available after bounded queue history outgrows the continuation budget", async()=>{
  const f=fixture(),r=await f.putRun();
  r.snapshot.context={projectSummary:null,decisions:Array.from({length:10},()=>"x".repeat(8000)),previousTaskNotes:["x".repeat(8000)],gitBaseline:{commit:null,branch:null,dirty:false}};
  r.snapshot.batch={managed:true,items:[{taskId:"task",text:"task",instruction:"task",acceptance:[]}]};
  r.view.batch={currentIndex:0,items:[{taskId:"task",text:"task",status:"running",summary:""}]};
  const results=Array.from({length:30},(_,i)=>({criterionId:String(i)+"c".repeat(150),status:"passed",evidenceRefs:["native:artifact"],outputHash:"a".repeat(64)}));
  r.queueState={revision:1,index:0,phase:"running",pauseRequested:false,repairs:{},human:{},accepted:{},permits:Object.fromEntries(Array.from({length:49},(_,i)=>[`${i}:turn-${i}`,{decision:"advance",queueRevision:i+1,permitId:crypto.randomUUID(),nextIndex:i+1}])),verification:{results}};
  r.view.queue={managed:true,revision:1,currentIndex:0,phase:"running",pauseRequested:false,canResume:false,repairCount:0,turnId:"turn-new",verification:{results}};
  await f.storage.put("exec:run:run",r);
  const receipt=await f.dispatch.tool(principal,"codex_cancel_run",{requestId:"large-stop",runId:"run"});
  assert.equal(receipt.status,"accepted");const saved=await f.storage.get("exec:run:run");assert.equal(saved.view.status,"cancel_requested");assert.equal(saved.commands.at(-1).payload.type,"cancel_run");
  const replay=await f.dispatch.tool(principal,"codex_cancel_run",{requestId:"large-stop-again",runId:"run"});assert.equal(replay.commandId,receipt.commandId);assert.equal((await f.storage.get("exec:run:run")).commands.length,2);
  const limited=fixture(),oversized=await limited.putRun();oversized.snapshot.context={decisions:["x".repeat(112000)]};await limited.storage.put("exec:run:run",oversized);
  await assert.rejects(limited.dispatch.tool(principal,"codex_continue_run",{requestId:"large-continue",runId:"run",expectedTurnId:"turn-new",message:"more",mode:"steer"}),{status:413});
});

test("fifty long criterion proofs survive native ingest and replay without duplicating results in the run journal",async()=>{
  const f=fixture(),r=await f.putRun();
  const criteria=Array.from({length:50},(_,i)=>({id:String(i).padStart(2,"0")+"验".repeat(254),kind:"artifact",description:"文件存在",required:true,relativePath:`${i}.txt`,predicate:{type:"exists"}}));
  r.snapshot.batch={managed:true,items:[{taskId:"task",text:"task",instruction:"task",acceptance:criteria}]};
  r.view.batch={currentIndex:0,items:[{taskId:"task",text:"task",status:"done",summary:"完成",completedTurnId:"turn-new"}]};r.view.reportRevision=1;
  await f.storage.put("exec:run:run",r);
  const results=criteria.map(c=>({criterionId:c.id,status:"passed",evidenceRefs:["native:artifact:"+"a".repeat(64)],outputHash:"a".repeat(64),message:"本机已读取并核对文件内容。"}));
  assert.ok(Buffer.byteLength(JSON.stringify({results}))>16000);
  const base={protocolVersion:1,runnerId:"runner",runId:"run",threadId:"thread",turnId:"turn-new",occurredAt:new Date().toISOString()};
  const events=[{...base,eventId:"large-done",seq:1,type:"turn.completed",payload:{status:"completed",outcome:{runId:"run",taskId:"task",outcome:"done",summary:"完成",changedFiles:[],evidenceRefs:[],remainingIssues:[],nextTaskNotes:[]},summary:null,error:null}},{...base,eventId:"large-proof",seq:2,type:"verification.completed",payload:{results}}];
  assert.deepEqual(await f.native("events",{events}),{eventIds:["large-done","large-proof"]});
  const input={runId:"run",commandId:"command",fromIndex:0,completedTurnId:"turn-new",reportRevision:1};
  const gate=await f.native("batch-gate",input);assert.equal(gate.decision,"finish");assert.deepEqual(await f.native("batch-gate",input),gate);
  const saved=await f.storage.get("exec:run:run");assert.equal(saved.queueState.verification,undefined);assert.equal(saved.view.queue.verification,undefined);
  const view=await f.dispatch.tool(principal,"codex_get_run",{runId:"run"});assert.equal(view.run.queue.verification.results.length,50);
});

test("permission selection is immutable in user-issued snapshots and summary always stays read-only",async()=>{
  const f=fixture();await f.native("context",{contexts:[{workspaceId:"workspace",capturedAt:new Date().toISOString(),gitBaseline:{commit:null,branch:null,dirty:false},threads:[]}]});
  for(const [kind,selection,profile] of [["task",undefined,"full_access"],["task","full_access","full_access"],["task","workspace_manual","workspace_manual"],["task","workspace_auto","workspace_auto"],["task","read_only","read_only"],["summary","full_access","read_only"],["summary","workspace_auto","read_only"]]) {
    const {input}=await f.intent({requestId:crypto.randomUUID(),bindingId:"binding",bindingRevision:1,kind,instruction:"test",...(selection?{executionPermissions:{profile:selection}}:{})});
    const stored=await f.storage.get("exec:snapshot:"+input.snapshotId);assert.deepEqual(stored.snapshot.executionPermissions,{profile,network:profile === "full_access"});
    await assert.rejects(f.dispatch.tool(principal,"codex_create_run",{...input,executionPermissions:{profile:"workspace_auto"}}),{status:400});
  }
  await assert.rejects(f.intent({requestId:"full-access",bindingId:"binding",bindingRevision:1,kind:"task",instruction:"x",executionPermissions:{profile:"workspace_auto",network:true}}),{status:400});
});

const respond = async(f,input,p=principal)=>(await f.dispatch.fetch(new Request("https://runner/execution/respond",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({principal:p,input:{bindingId:"binding",bindingRevision:1,runId:"run",requestId:crypto.randomUUID(),expectedTurnId:"turn-new",pendingRequestId:"approval-1",...input}})}))).json();
async function pendingApproval(f,{kind="approval",requestId="approval-1"}={}) {
  await f.putRun("run",{status:kind==="approval"?"waiting_approval":"waiting_input"});
  const base={protocolVersion:1,eventId:crypto.randomUUID(),runnerId:"runner",runId:"run",threadId:"thread",turnId:"turn-new",seq:1,occurredAt:new Date().toISOString()};
  const payload=kind==="approval"?{requestId,description:"需要写文件",details:{method:"item/commandExecution/requestApproval",command:"Write-Output test",cwd:"D:/test",files:["a.txt"],allowedDecisions:["accept","decline","cancel"]}}:{requestId,questions:[{id:"wording",prompt:"请输入文案",isSecret:false,options:[{label:"hello",description:"常规问候"}]}]};
  await f.native("events",{events:[{...base,type:kind==="approval"?"approval.requested":"input.requested",payload}]});
}
test("authenticated request replies preserve command identity, replay receipts, and clear delivered answer bodies",async()=>{
  const f=fixture();await pendingApproval(f);
  const view=await f.dispatch.tool(principal,"codex_get_run",{runId:"run"});assert.equal(view.run.pendingRequests[0].details.command,"Write-Output test");
  const request={requestId:"reply-1",response:{decision:"accept"}};
  await assert.rejects(respond(f,{...request,requestId:"old-turn",expectedTurnId:"old"}),{status:409});
  await assert.rejects(respond(f,{...request,requestId:"old-binding",bindingRevision:2}),{status:409});
  await assert.rejects(respond(f,request,{...principal,ownerId:"bob"}),{status:403});
  const receipt=await respond(f,request);assert.equal(receipt.status,"queued");assert.deepEqual(await respond(f,request),receipt);
  await assert.rejects(respond(f,{...request,response:{decision:"decline"}}),{status:409});
  await assert.rejects(respond(f,{response:{decision:"decline"}}),{status:409});
  const inbox=await f.native("responses",{runId:"run"});assert.equal(inbox.responses.length,1);assert.equal(inbox.responses[0].pendingRequestId,"approval-1");assert.equal(inbox.responses[0].responseId,receipt.responseId);
  assert.equal((await f.storage.get("exec:run:run")).view.commandId,"command");
  await f.native("response-ack",{runId:"run",responseId:receipt.responseId,status:"applied"});
  assert.deepEqual(await f.native("responses",{runId:"run"}),{responses:[]});assert.equal((await respond(f,request)).status,"applied");
  assert.deepEqual((await f.dispatch.tool(principal,"codex_get_run",{runId:"run"})).run.pendingRequests,[]);
  const persisted=await f.storage.get("exec:response:"+receipt.responseId);assert.equal(persisted.response,undefined);
});
test("question answers validate exact questions; cancellation and later turns revoke queued responses",async()=>{
  const f=fixture();await pendingApproval(f,{kind:"input"});
  await assert.rejects(respond(f,{response:{decision:"accept"}}),{status:400});
  await assert.rejects(respond(f,{response:{answers:{wrong:{answers:["hello"]}}}}),{status:400});
  const receipt=await respond(f,{response:{answers:{wording:{answers:["hello"]}}}});
  await f.dispatch.tool(principal,"codex_cancel_run",{requestId:"stop-before-reply",runId:"run"});
  assert.deepEqual(await f.native("responses",{runId:"run"}),{responses:[]});assert.equal((await f.storage.get("exec:response:"+receipt.responseId)).status,"cancelled");
  const later=fixture();await pendingApproval(later);const r=await later.storage.get("exec:run:run");r.view.turnId="next-turn";await later.storage.put("exec:run:run",r);
  await assert.rejects(respond(later,{response:{decision:"accept"}}),{status:409});
  assert.deepEqual((await later.dispatch.tool(principal,"codex_get_run",{runId:"run"})).run.pendingRequests,[]);
});

test("native approval decision restrictions are enforced and resolution clears pending state",async()=>{
  const f=fixture();await f.putRun("run",{status:"waiting_approval"});
  const base={protocolVersion:1,runnerId:"runner",runId:"run",threadId:"thread",turnId:"turn-new",occurredAt:new Date().toISOString()};
  await f.native("events",{events:[{...base,eventId:"restricted",seq:1,type:"approval.requested",payload:{requestId:"approval-1",description:"本请求无法安全扩权",details:{method:"item/commandExecution/requestApproval",command:"network action",allowedDecisions:["decline","cancel"]}}}]});
  await assert.rejects(respond(f,{response:{decision:"accept"}}),{status:403});
  const receipt=await respond(f,{response:{decision:"decline"}});
  await f.native("events",{events:[{...base,eventId:"resolved",seq:2,type:"request.resolved",payload:{requestId:"approval-1",status:"responded"}}]});
  assert.equal((await f.storage.get("exec:response:"+receipt.responseId)).status,"applied");
  assert.equal((await f.storage.get("exec:response:"+receipt.responseId)).response,undefined);
  assert.deepEqual((await f.dispatch.tool(principal,"codex_get_run",{runId:"run"})).run.pendingRequests,[]);
});

test("requests arriving before first or subsequent turn reports survive interim views and inbox polls",async()=>{
  const f=fixture(),r=await f.putRun();r.view.threadId=null;r.view.turnId=null;await f.storage.put("exec:run:run",r);
  const event=(requestId,turnId,seq)=>({protocolVersion:1,eventId:"event-"+requestId,runnerId:"runner",runId:"run",threadId:"thread",turnId,seq,occurredAt:new Date().toISOString(),type:"approval.requested",payload:{requestId,description:"请核对"}});
  const read=async()=>(await f.dispatch.tool(principal,"codex_get_run",{runId:"run"})).run;
  await f.native("events",{events:[event("first","turn-first",1)]});
  assert.deepEqual((await read()).pendingRequests,[]);assert.equal((await read()).executionPermissions,undefined,"legacy permissions must remain unrecorded");
  assert.deepEqual(await f.native("responses",{runId:"run"}),{responses:[]});
  assert.equal((await f.storage.get("exec:requests:run:first")).state,"pending");
  await f.native("report",{...report,turnId:"turn-first",terminal:false,stopConfirmed:false,status:"waiting_approval"});
  assert.equal((await read()).pendingRequests[0].requestId,"first");
  await f.native("events",{events:[event("second","turn-second",2)]});
  assert.equal((await read()).pendingRequests[0].requestId,"first");
  await f.native("responses",{runId:"run"});assert.equal((await f.storage.get("exec:requests:run:second")).state,"pending");
  await f.native("report",{...report,revision:2,turnId:"turn-second",terminal:false,stopConfirmed:false,status:"waiting_approval"});
  assert.deepEqual((await read()).pendingRequests.map(p=>p.requestId),["second"]);
  await assert.rejects(respond(f,{pendingRequestId:"second",expectedTurnId:"turn-second",response:{decision:"accept"}}),{status:403},"legacy approval cannot grant unknown capabilities");
  await respond(f,{pendingRequestId:"second",expectedTurnId:"turn-second",response:{decision:"decline"}});
  await f.native("report",{...report,revision:3,turnId:"turn-second"});assert.deepEqual((await read()).pendingRequests,[]);
});
