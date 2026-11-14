import test from "node:test";
import assert from "node:assert/strict";
import { fixture, init, summary } from "./fixtures/project-summary.mjs";

async function reportFirst(f, runId, status = "verifying") {
  f.lease([
    {
      run_id: runId,
      workspace_id: "workspace",
      lease_epoch: 1,
      expires_at: Date.now() + 60000,
    },
  ]);
  await f.native("poll", {});
  const run = f.rows.get("exec:run:" + runId);
  const report = {
    runId,
    commandId: run.view.commandId,
    revision: 1,
    status,
    threadId: "thread-" + runId,
    turnId: "turn-" + runId,
    terminal: true,
    stopConfirmed: true,
    summaryContext: {
      workspaceId: "workspace",
      capturedAt: new Date().toISOString(),
      gitBaseline: { commit: null, branch: null, dirty: false },
    },
    ...(status === "failed" ? { error: "Codex connection failed" } : {}),
  };
  await f.native("report", report);
  return report;
}

test("summary completion report waits for delayed result events across restart without failing or launching another run", async () => {
  const f = fixture();
  await f.seed();
  const previous = await f.call("project-initialize", init());
  await f.finish(previous.activeRunId);
  const next = await f.call("project-refresh", init("next"));
  const report = await reportFirst(f, next.activeRunId);
  let state = await f.call("project-state", { inspectOnly: true });
  assert.equal(state.status, "finalizing");
  assert.equal(state.ready, false);
  assert.equal(state.error, null);
  assert.equal(state.stale, true);
  assert.equal(state.sourceRunId, previous.activeRunId);
  assert.equal(state.summaryRevision, 1);
  f.restart();
  assert.equal((await f.call("project-state")).status, "finalizing");
  await assert.rejects(
    f.call("project-refresh", init("premature-refresh")),
    (e) => e.status === 409,
  );
  assert.equal(
    (await f.call("project-initialize", init("chat", "chat"))).activeRunId,
    next.activeRunId,
  );
  assert.equal(
    [...f.rows.keys()].filter((k) => k.startsWith("exec:run:")).length,
    2,
  );
  const event = {
    protocolVersion: 1,
    eventId: "summary-result",
    runnerId: "runner",
    runId: next.activeRunId,
    threadId: report.threadId,
    turnId: report.turnId,
    seq: 1,
    type: "turn.completed",
    occurredAt: new Date().toISOString(),
    payload: {
      status: "completed",
      summary: { ...summary, overview: "新的完整摘要" },
      outcome: null,
      error: null,
    },
  };
  await f.native("events", { events: [event] });
  state = await f.call("project-state");
  assert.equal(state.status, "ready");
  assert.equal(state.ready, true);
  assert.equal(state.error, null);
  assert.equal(state.sourceRunId, next.activeRunId);
  assert.equal(state.summaryRevision, 2);
  assert.equal(state.summary.overview, "新的完整摘要");
  await f.native("events", { events: [event] });
  await f.native("report", report);
  assert.equal((await f.call("project-state")).summaryRevision, 2);
});

test("an explicit failed summary report remains failed even when its event has not arrived", async () => {
  const f = fixture();
  await f.seed();
  const state = await f.call("project-initialize", init());
  await reportFirst(f, state.activeRunId, "failed");
  const failed = await f.call("project-state");
  assert.equal(failed.status, "failed");
  assert.equal(failed.ready, false);
  assert.match(failed.error, /Codex connection failed/);
});

test("a continued summary waits for the current turn and replaces its earlier summary exactly once", async () => {
  const f = fixture();
  await f.seed();
  const first = await f.call("project-initialize", init());
  await f.finish(first.activeRunId);
  const prior = f.rows.get("exec:run:" + first.activeRunId);
  await f.tool("codex_continue_run", {
    requestId: "continue-summary",
    runId: first.activeRunId,
    expectedTurnId: prior.view.turnId,
    mode: "reply",
    message: "补充项目进度",
  });
  f.lease([
    {
      run_id: first.activeRunId,
      workspace_id: "workspace",
      lease_epoch: 2,
      expires_at: Date.now() + 60000,
    },
  ]);
  await f.native("poll", {});
  const current = f.rows.get("exec:run:" + first.activeRunId);
  await f.native("report", {
    runId: first.activeRunId,
    commandId: current.view.commandId,
    revision: 2,
    threadId: prior.view.threadId,
    turnId: "new-summary-turn",
    status: "verifying",
    terminal: true,
    stopConfirmed: true,
    summaryContext: prior.summaryContext,
  });
  const waiting = await f.call("project-state");
  assert.equal(waiting.status, "finalizing");
  assert.equal(waiting.ready, false);
  assert.equal(waiting.summaryRevision, 1);
  assert.deepEqual(waiting.summary, summary);
  const event = {
    protocolVersion: 1,
    eventId: "continued-summary-result",
    runnerId: "runner",
    runId: first.activeRunId,
    threadId: prior.view.threadId,
    turnId: "new-summary-turn",
    seq: 2,
    type: "turn.completed",
    occurredAt: new Date().toISOString(),
    payload: {
      status: "completed",
      summary: { ...summary, overview: "继续核对后的新结果" },
      outcome: null,
      error: null,
    },
  };
  await f.native("events", { events: [event] });
  const ready = await f.call("project-state");
  assert.equal(ready.ready, true);
  assert.equal(ready.summaryRevision, 2);
  assert.equal(ready.summary.overview, "继续核对后的新结果");
  assert.equal(ready.turnId, "new-summary-turn");
  await f.native("events", { events: [event] });
  assert.equal((await f.call("project-state")).summaryRevision, 2);
});

test("stopping result delivery allows recovery and a late result cannot revive the cancelled summary", async () => {
  const f = fixture();
  await f.seed();
  const first = await f.call("project-initialize", init());
  const report = await reportFirst(f, first.activeRunId);
  await f.tool("codex_cancel_run", {
    runId: first.activeRunId,
    requestId: "stop-delivery",
  });
  const stopped = await f.call("project-state");
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.ready, false);
  assert.equal(
    f.rows.get("exec:run:" + first.activeRunId).view.status,
    "cancelled",
  );
  await f.native("events", {
    events: [
      {
        protocolVersion: 1,
        eventId: "late-cancelled-result",
        runnerId: "runner",
        runId: first.activeRunId,
        threadId: report.threadId,
        turnId: report.turnId,
        seq: 1,
        type: "turn.completed",
        occurredAt: new Date().toISOString(),
        payload: { status: "completed", summary, outcome: null, error: null },
      },
    ],
  });
  const late = await f.call("project-state");
  assert.equal(late.status, "failed");
  assert.equal(late.summaryRevision, 0);
  const retry = await f.call("project-refresh", init("after-stop"));
  assert.notEqual(retry.activeRunId, first.activeRunId);
});

test("a late stop after matching summary delivery does not revoke its accepted result", async () => {
  const f = fixture();
  await f.seed();
  const first = await f.call("project-initialize", init());
  await f.finish(first.activeRunId);
  await f.tool("codex_cancel_run", {
    runId: first.activeRunId,
    requestId: "late-stop",
  });
  const state = await f.call("project-state");
  assert.equal(state.ready, true);
  assert.equal(state.summaryRevision, 1);
});
