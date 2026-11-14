import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";

const calls = (state, method) => state.calls.filter(call => call.method === method);
const failTurn = state => {
  const thread = state.threads[0];
  thread.turns[0].status = "failed";
  thread.turns[0].error = { message: "Native task failed after starting background commands" };
  thread.status = { type: "idle" };
};

test("failed native turns stop background commands before reporting stop and releasing the workspace after restart", async t => {
  const f = await recoveryHarness(t, { mode: "background-cancel" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  assert.equal((await f.nativeState()).threads[0].terminals.length, 2);
  await f.restart(failTurn);
  await f.until(() => !f.executor.hasHold);
  const native = await f.nativeState();
  assert.deepEqual(native.threads[0].terminals, []);
  assert.deepEqual(calls(native, "thread/backgroundTerminals/terminate").map(c => c.params), [
    { threadId: "thread-1", processId: "process-a" },
    { threadId: "thread-1", processId: "process-b" },
  ]);
  assert.equal((await f.view()).stopConfirmed, true);
  assert.equal(f.controller.store.leases().length, 0);
});

test("failed background cleanup preserves the lease across reconnect until a later native inspection confirms stop", async t => {
  const f = await recoveryHarness(t, { mode: "background-stuck" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  await f.restart(failTurn);
  await f.reconnect();
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.controller.store.leases().length, 1);
  assert.equal((await f.view()).stopConfirmed, false);
  assert.equal((await f.nativeState()).threads[0].terminals.length, 2);
  f.setMode("normal");
  await f.restart();
  await f.until(() => !f.executor.hasHold);
  assert.deepEqual((await f.nativeState()).threads[0].terminals, []);
  assert.equal((await f.view()).stopConfirmed, true);
});

test("legacy local terminal flags do not release surviving background commands after restart", async t => {
  const f = await recoveryHarness(t, { mode: "background-stuck" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  // Old versions persisted these flags before checking background commands.
  f.runs.patchRun(f.runId, { terminal: true, active: false, status: "failed" });
  await f.restart(failTurn);
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.controller.store.leases().length, 1);
  assert.equal((await f.view()).stopConfirmed, false);
});

test("a legacy interrupt marker committed before the RPC still stops the same native turn after restart", async t => {
  const f = await recoveryHarness(t, { mode: "hang" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  const mark = f.journal.interruptOnce.bind(f.journal);
  let injected = false;
  f.journal.interruptOnce = key => {
    const created = mark(key);
    if (!injected && created) {
      injected = true;
      throw Error("Crash after durable interrupt intent but before RPC send");
    }
    return created;
  };
  await f.expireLease();
  await f.tick();
  assert.equal(injected, true);
  assert.equal(calls(await f.nativeState(), "turn/interrupt").length, 0);
  await f.restart();
  await f.reconnect();
  for (let n = 0; n < 5 && f.executor.hasHold; n++) await f.tick();
  const native = await f.nativeState();
  assert.deepEqual(calls(native, "turn/interrupt").map(c => c.params), [
    { threadId: "thread-1", turnId: "thread-1-turn-1" },
  ]);
  assert.equal(native.threads[0].turns[0].status, "interrupted");
  assert.equal(f.executor.hasHold, false);
});

test("recovering an old stop never interrupts a different turn or releases its active thread", async t => {
  const f = await recoveryHarness(t, { mode: "hang" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  const run = f.runs.getRun(f.runId);
  f.journal.interruptOnce(`${f.runId}:${run.activeTurnId}:safety-stop`);
  await f.expireLease();
  await f.restart(state => {
    state.threads[0].turns[0].status = "interrupted";
    state.threads[0].turns.push({ id: "other-manual-turn", status: "inProgress", error: null, items: [] });
  });
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(calls(await f.nativeState(), "turn/interrupt").length, 0);
  assert.equal(f.executor.hasHold, true);
  assert.equal((await f.view()).stopConfirmed, false);
});
