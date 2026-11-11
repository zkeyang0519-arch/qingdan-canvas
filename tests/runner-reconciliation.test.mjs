import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

test("a lost thread creation reply is sealed and settled without starting a turn after reconnect and SQLite restart", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  f.setMode("normal");
  await f.restart();
  await f.reconnect();
  for (let n = 0; n < 8 && f.executor.hasHold; n++) await f.tick();
  assert.equal(f.executor.hasHold, false);
  const state = await f.nativeState();
  assert.equal(state.threads.length, 1);
  assert.equal(state.calls.filter(c => c.method === "turn/start").length, 0);
  assert.equal((await f.view()).status, "cancelled");
  const confirm = f.packets.find(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.equal(confirm.input.proof.kind, "never_dispatched");
  assert.equal(confirm.input.proof.launchStage, "thread_requested");
  assert.equal(confirm.input.proof.journal.sealed, true);
});

test("a lost reconciliation confirmation ACK replays its immutable proof and report after restart", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  f.loseReply((action, input) => action === "reconcile" && input.phase === "confirm");
  await f.until(() => !f.online);
  const sent = f.packets.find(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.ok(sent);
  assert.equal(f.executor.hasHold, true);
  f.setMode("normal");
  await f.restart();
  await f.until(() => !f.executor.hasHold);
  const attempts = f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.ok(attempts.length >= 2);
  assert.deepEqual(attempts.at(-1).input, sent.input);
  assert.equal((await f.storage.list({ prefix: "exec:reconcile-receipt:" })).size, 1);
});

test("manual inspection with a live lease never interrupts work, but explicit cancellation can settle the same claim", async t => {
  const f = await recoveryHarness(t, { mode: "background-cancel" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  f.runs.patchRun(f.runId, { status: "reconciliation_required" });
  // Publish uncertainty first so the cloud permits read-only inspection.
  await f.native("report", { runId: f.runId, commandId: f.journal.latest(f.runId).envelope.commandId, revision: 100, status: "reconciliation_required", threadId: "thread-1", turnId: "thread-1-turn-1", terminal: false, stopConfirmed: false });
  await f.reconnect();
  await f.tick();
  let state = await f.nativeState();
  assert.equal(state.calls.filter(c => /turn\/interrupt|backgroundTerminals\/terminate/.test(c.method)).length, 0);
  assert.equal(f.executor.hasHold, true);
  // A terminal model turn does not make its inherited background commands
  // safe to terminate under an inspect_only ticket, including after restart.
  await f.restart(state => {
    state.threads[0].turns[0].status = "failed";
    state.threads[0].turns[0].error = { message: "fixture native failure" };
  });
  state = await f.nativeState();
  assert.equal(state.calls.filter(c => /turn\/interrupt|backgroundTerminals\/terminate/.test(c.method)).length, 0);
  assert.equal(state.threads[0].terminals.length, 2);
  assert.equal(f.executor.hasHold, true);
  await f.dispatch.tool(f.principal, "codex_cancel_run", { runId: f.runId, requestId: crypto.randomUUID() });
  await f.reconnect();
  await f.until(() => !f.executor.hasHold);
  state = await f.nativeState();
  assert.deepEqual(state.threads[0].terminals, []);
  assert.equal(state.calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal((await f.view()).status, "cancelled");
});

test("a pending thread/start reply cannot send a turn or revive a cancelled run after sealing and confirmation", async t => {
  const f = await recoveryHarness(t, { mode: "delayed-thread-start", requestTimeoutMs: 8000 });
  await f.create();
  const pending = f.tick();
  try {
    for (let n = 0; n < 100 && !(await f.nativeState()).threads.length; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await f.nativeState()).threads.length, 1);
    assert.equal(f.runs.getRun(f.runId).launchIntent, "thread_requested");
    await f.dispatch.tool(f.principal, "codex_cancel_run", { runId: f.runId, requestId: crypto.randomUUID() });
    await f.executor.reconcileHeldRun();
    assert.equal(f.executor.hasHold, false);
  } finally {
    await writeFile(path.join(f.base, "native.json.release-thread"), "release");
    await pending;
  }
  await f.tick();
  assert.equal((await f.nativeState()).calls.filter(c => c.method === "turn/start").length, 0);
  assert.equal(f.runs.getRun(f.runId).status, "cancelled");
  assert.equal((await f.view()).status, "cancelled");
});

test("cached native stop proof and settled ACK never release or interrupt a new unrelated native turn after restart", async t => {
  const f = await recoveryHarness(t, { mode: "background-cancel" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  await f.dispatch.tool(f.principal, "codex_cancel_run", { runId: f.runId, requestId: crypto.randomUUID() });
  f.loseReply((action, input) => action === "reconcile" && input.phase === "confirm");
  await f.executor.reconcileHeldRun();
  assert.equal(f.online, false);
  const sent = f.packets.find(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.equal(sent.input.proof.kind, "native_stopped");
  await f.restart(state => {
    state.threads[0].turns.push({ id: "manual-other-turn", status: "inProgress", items: [], error: null });
  });
  await f.reconnect();
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.controller.store.leases().length, 1);
  const calls = (await f.nativeState()).calls;
  assert.ok(calls.filter(c => c.method === "turn/interrupt").every(c => c.params.turnId === "thread-1-turn-1"));
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
});

test("turn_sent without a mapped thread never becomes never_dispatched proof", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  f.runs.patchRun(f.runId, { launchIntent: "turn_sent", pendingRequestId: `initial-${f.runId}` });
  await f.expireLease();
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm").length, 0);
  assert.equal((await f.view()).stopConfirmed, false);
});

test("a stale ticket from a late ordinary report gets a new request while retaining the old immutable confirmation", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  let original;
  f.beforeRequest(async (action, input) => {
    if (action !== "reconcile" || input.phase !== "confirm" || original) return;
    original = structuredClone(input);
    await f.native("report", { ...input.report, status: "reconciliation_required", terminal: false, stopConfirmed: false });
  });
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, true);
  assert.ok(original);
  await f.restart();
  await f.until(() => !f.executor.hasHold);
  const replay = f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm").at(-1).input;
  assert.notEqual(replay.requestId, original.requestId);
  assert.notEqual(replay.recoveryId, original.recoveryId);
  assert.equal(replay.report.revision, original.report.revision + 1);
  assert.equal(original.report.status, "cancelled");
  assert.equal((await f.nativeState()).calls.filter(c => c.method === "turn/start").length, 0);
});

test("a connection replaced during inspect cannot confirm its stale response and retries on the current epoch", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  let interrupted = false;
  f.loseReply((action, input) => {
    if (action !== "reconcile" || input.phase !== "inspect" || interrupted) return false;
    interrupted = true;
    void f.reconnect();
    return true;
  });
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm").length, 0);
  await f.reconnect();
  await f.until(() => !f.executor.hasHold);
  const calls = f.packets.filter(p => p.action === "reconcile");
  assert.ok(calls.at(-1).epoch > calls[0].epoch);
  assert.equal((await f.nativeState()).calls.filter(c => c.method === "turn/start").length, 0);
});

test("a replaced local lease cannot borrow the old durable claim for reconciliation", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  const lease = f.controller.store.lease(f.runId);
  f.controller.store.saveLease({ ...lease, leaseEpoch: lease.leaseEpoch + 1 });
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.packets.filter(p => p.action === "reconcile").length, 0);
  assert.equal((await f.view()).stopConfirmed, false);
});

test("an absent durable claim never becomes proof just because the local run is absent", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  // Offer has not been consumed: there is no claim or acquired workspace lock.
  await f.executor.reconcileHeldRun();
  assert.equal(f.packets.filter(p => p.action === "reconcile").length, 0);
  assert.equal((await f.view()).stopConfirmed, false);
});

test("user reconnect settles a known turn when an old pending report is superseded by cancellation on an expired lease", async t => {
  const f = await recoveryHarness(t, { mode: "background-cancel" });
  await f.create();
  f.loseReply((action, input) => action === "report" && input.status === "running");
  await f.until(() => !f.online);
  const firstReport = f.packets.find(p => p.action === "report").input;
  await f.dispatch.tool(f.principal, "codex_cancel_run", { runId: f.runId, requestId: crypto.randomUUID() });
  await f.expireLease();
  // A native disconnect marks an existing mapped turn uncertain. Retain its
  // old ordinary report exactly as it was when the transport lost the ACK.
  f.runs.patchRun(f.runId, { status: "reconciliation_required" });
  await f.reconnect();
  await f.until(() => !f.executor.hasHold);
  const replay = f.packets.filter(p => p.action === "report" && p.input.revision === firstReport.revision);
  assert.ok(replay.length >= 2);
  assert.deepEqual(replay[1].input, firstReport);
  assert.equal(replay[1].result.ignored, true);
  assert.equal((await f.view()).status, "cancelled");
  assert.equal((await f.nativeState()).calls.filter(c => c.method === "turn/start").length, 1);
  assert.deepEqual((await f.nativeState()).threads[0].terminals, []);
  assert.equal(f.packets.find(p => p.action === "reconcile" && p.input.phase === "confirm").input.proof.kind, "native_stopped");
});
