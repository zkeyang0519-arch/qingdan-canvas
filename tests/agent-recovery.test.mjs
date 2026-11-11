import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";

test("an expired paused checkpoint requires explicit recovery before resuming the same batch", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  await f.control("pause");
  await f.until(async () => (await f.view()).queue.phase === "paused");
  const before = f.runs.getRun(f.runId);
  const lease = await f.expireLease();
  await f.restart();
  assert.equal(f.runs.getRun(f.runId).terminal, false);
  assert.equal(f.runs.getRun(f.runId).cancelRequested, false);
  assert.equal((await f.view()).queue.phase, "paused");
  assert.equal(f.controller.store.lease(f.runId).expiresAt, lease.expiresAt);
  await f.control("recover");
  await f.until(() => f.controller.store.lease(f.runId).expiresAt > Date.now());
  const recovered = f.runs.getRun(f.runId);
  assert.equal(recovered.threadId, before.threadId);
  assert.equal(recovered.activeTurnId, before.activeTurnId);
  assert.equal(recovered.cancelRequested, false);
  assert.equal((await f.view()).queue.phase, "paused");
  assert.equal((await f.nativeState()).calls.filter(call => call.method === "turn/start").length, 1);
  await f.control("resume");
  await f.finish();
  await f.assertExactlyOnce();
});

test("legacy checkpoint safety-stop recovery survives a lost renewal ACK without extending its receipt twice", async t => {
  const f=await recoveryHarness(t);
  await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const revision=(await f.view()).queue.revision;
  for(let n=0;n<3;n++)await f.tick();
  assert.equal((await f.view()).queue.revision,revision,"idle pause must not invalidate control revisions");
  const lease=await f.expireLease();
  f.runs.patchRun(f.runId,{cancelRequested:true,status:"reconciliation_required",resultError:"批次后续待办的执行授权已失效。"});
  await f.tick();
  assert.equal((await f.view()).queue.canResume,false);
  await assert.rejects(f.control("resume"));
  await f.control("recover");
  f.loseReply((action,input)=>action==="recover-lease"&&input.phase==="confirm");
  await f.until(()=>!f.online);
  const first=f.packets.find(packet=>packet.action==="recover-lease"&&packet.input.phase==="confirm");
  assert.equal(first.result.lease.leaseEpoch,lease.leaseEpoch);
  assert.equal(f.controller.store.lease(f.runId).expiresAt,lease.expiresAt);
  await f.restart();
  await f.until(()=>!f.runs.getRun(f.runId).cancelRequested&&f.controller.store.lease(f.runId).expiresAt>Date.now());
  const confirmations=f.packets.filter(packet=>packet.action==="recover-lease"&&packet.input.phase==="confirm");
  assert.equal(confirmations.length,2);
  assert.deepEqual(confirmations[0].result,confirmations[1].result);
  assert.equal((await f.view()).queue.phase,"paused");
  assert.equal((await f.nativeState()).calls.filter(call=>call.method==="turn/start").length,1);
  await f.control("resume");await f.finish();await f.assertExactlyOnce();
});

test("checkpoint recovery refuses another live native turn and never renews by timeout alone",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const lease=await f.expireLease();
  await f.restart(state=>state.threads[0].turns.push({id:"foreign-live-turn",status:"inProgress",items:[]}));
  await f.control("recover");
  for(let n=0;n<3;n++)await f.tick();
  assert.equal(f.controller.store.lease(f.runId).expiresAt,lease.expiresAt);
  assert.equal((await f.storage.get(`fixture:lease:${f.runId}`)).expiresAt,lease.expiresAt);
  assert.equal(f.packets.filter(packet=>packet.action==="recover-lease"&&packet.input.phase==="confirm").length,0);
  assert.equal((await f.nativeState()).calls.filter(call=>call.method==="turn/start").length,1);
  assert.equal(f.executor.hasHold,true);
});

test("checkpoint recovery requires the exact completed-turn writeback and rejects cloud cancellation before confirm",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const lease=await f.expireLease();await f.tick();
  const key=`exec:writebacks:${f.runId}`, queue=await f.storage.get(key);
  await f.storage.delete(key);
  await assert.rejects(f.control("recover"),/清单回写尚未确认/);
  await f.storage.put(key,{...queue,entries:queue.entries.map(entry=>({...entry,completedTurnId:"wrong-turn"}))});
  await assert.rejects(f.control("recover"),/清单回写尚未确认/);
  await f.storage.put(key,queue);await f.control("recover");
  let cancelled=false;
  f.beforeRequest(async(action,input)=>{
    if(!cancelled&&action==="recover-lease"&&input.phase==="confirm") {
      cancelled=true;
      await f.dispatch.tool(f.principal,"codex_cancel_run",{requestId:crypto.randomUUID(),runId:f.runId});
    }
  });
  await f.until(()=>cancelled);
  assert.equal(f.controller.store.lease(f.runId).expiresAt,lease.expiresAt);
  assert.equal((await f.storage.get(`fixture:lease:${f.runId}`)).expiresAt,lease.expiresAt);
  assert.equal((await f.storage.list({prefix:"exec:lease-recovery:"})).size,0);
});

test("explicit lifecycle stop during native checkpoint inspection cannot be cleared by recovery",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const lease=await f.expireLease();await f.tick();await f.control("recover");
  let stopping;
  f.beforeRequest((action,input)=>{
    if(!stopping&&action==="recover-lease"&&input.phase==="inspect")stopping=f.executor.suspend();
  });
  await f.tick();await stopping;
  assert.equal(f.packets.filter(packet=>packet.action==="recover-lease"&&packet.input.phase==="confirm").length,0);
  const remaining=await f.storage.get(`fixture:lease:${f.runId}`);
  assert.ok(!remaining||remaining.expiresAt===lease.expiresAt);
  assert.equal(f.runs.getRun(f.runId).cancelRequested,true);
  assert.equal(f.journal.checkpointRecovery(f.runId),undefined);
});

test("a persisted lifecycle stop intent defeats legacy migration even if shutdown crashes before cleanup",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  await f.expireLease();
  f.runs.patchRun(f.runId,{cancelRequested:true,status:"reconciliation_required",resultError:"运行租约已过期。"});
  await f.tick();await f.control("recover");
  assert.ok(f.journal.checkpointRecovery(f.runId));
  const save=f.journal.recordStopIntent.bind(f.journal);
  f.journal.recordStopIntent=(...args)=>{save(...args);throw Error("fault: stop intent committed before old recovery marker cleanup");};
  await f.executor.suspend();
  assert.equal(f.journal.stopIntent(f.runId).reason,"运行器已暂停。");
  assert.ok(f.journal.checkpointRecovery(f.runId),"old marker survives this injected crash window");
  await f.restart();
  for(let n=0;n<3;n++)await f.tick();
  assert.equal(f.packets.filter(packet=>packet.action==="recover-lease"&&packet.input.phase==="confirm").length,0);
  assert.equal((await f.storage.list({prefix:"exec:lease-recovery:"})).size,0);
  assert.equal(f.runs.getRun(f.runId).cancelRequested,true);
});

test("restart honors a persisted lifecycle stop with a live lease before any batch advancement",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const save=f.journal.recordStopIntent.bind(f.journal);
  f.journal.recordStopIntent=(...args)=>{save(...args);throw Error("fault: live-lease stop intent committed before native stop");};
  await f.executor.suspend();
  assert.equal(f.runs.getRun(f.runId).cancelRequested,false);
  await f.restart();
  assert.equal(f.runs.getRun(f.runId).cancelRequested,true);
  assert.equal(f.runs.getRun(f.runId).terminal,true);
  assert.equal((await f.nativeState()).calls.filter(call=>call.method==="turn/start").length,1);
});

test("a recovery receipt committed before lease renewal restarts with the same bounded expiry",async t=>{
  const f=await recoveryHarness(t);await f.create();await f.control("pause");
  await f.until(async()=>(await f.view()).queue.phase==="paused");
  const lease=await f.expireLease();await f.tick();await f.control("recover");
  const put=f.storage.put.bind(f.storage);let receipt;
  f.storage.put=async(key,value)=>{
    await put(key,value);
    if(!receipt&&typeof key==="string"&&key.startsWith("exec:lease-recovery:")) {
      receipt=structuredClone(value);f.disconnect();
      throw Error("fault: recovery receipt committed before D1 renewal");
    }
  };
  await f.until(()=>!!receipt);
  assert.equal((await f.storage.get(`fixture:lease:${f.runId}`)).expiresAt,lease.expiresAt);
  await f.restart();
  await f.until(()=>f.controller.store.lease(f.runId).expiresAt>Date.now());
  assert.deepEqual(f.controller.store.lease(f.runId),receipt);
  assert.deepEqual(await f.storage.get(`fixture:lease:${f.runId}`),receipt);
  assert.equal((await f.nativeState()).calls.filter(call=>call.method==="turn/start").length,1);
  await f.control("resume");await f.finish();await f.assertExactlyOnce();
});

test("cloud dispatch saved before delivery survives reconnect and a new device controller", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, _input, result) => action === "poll" && result.deliveries.length === 1);
  await f.until(() => !f.online);
  assert.equal((await f.nativeState()).calls.filter(call => call.method === "turn/start").length, 0);
  const oldController = f.controller, oldEpoch = f.epoch;
  const command = (await f.storage.get("exec:run:" + f.runId)).commands[0];
  assert.ok(command.envelope, "server envelope was committed before reply loss");
  await f.restart();
  assert.notEqual(f.controller, oldController);
  assert.ok(f.epoch > oldEpoch);
  await f.finish();
  await f.assertExactlyOnce();
  assert.deepEqual((await f.storage.get("exec:run:" + f.runId)).commands[0].envelope, command.envelope);
});

test("native accepted initial turn with lost reply is reconciled after restart without a second chat or turn", async t => {
  const f = await recoveryHarness(t, { mode: "exit-turn-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  assert.equal((await f.nativeState()).calls.filter(call => call.method === "turn/start").length, 1);
  f.setMode("normal");
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
});

test("lost native reply for the second item recovers that turn and consumes its permit once", async t => {
  const f = await recoveryHarness(t, { mode: "batch-exit-second" });
  await f.create();
  await f.until(() => f.runs.getRun(f.runId)?.pendingRequestId && f.runs.getRun(f.runId)?.batch.currentIndex === 1);
  const pending = f.runs.getRun(f.runId);
  assert.equal(pending.batchPhase, "running");
  assert.equal(pending.status, "reconciliation_required");
  const state = await f.nativeState();
  assert.equal(state.calls.filter(call => call.method === "turn/start").length, 2);
  assert.equal(state.threads[0].turns[1].items[0].clientId, pending.batchPermit.permitId);
  f.setMode("normal");
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
});

test("a local turn marker saved before native send blocks uncertain replay after restart", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  const original = f.runs.patchRun.bind(f.runs);
  let injected = false;
  f.runs.patchRun = (runId, patch) => {
    const saved = original(runId, patch);
    if (!injected && patch.launchIntent === "turn_sent") {
      injected = true;
      throw Error("fault: local pending turn committed before native send");
    }
    return saved;
  };
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  assert.equal(injected, true);
  await f.restart();
  for (let n = 0; n < 4; n++) await f.tick();
  const state = await f.nativeState(), view = await f.view();
  assert.equal(state.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(state.calls.filter(call => call.method === "turn/start").length, 0);
  assert.equal(state.threads.length, 1);
  assert.equal(view.threadId, state.threads[0].id);
  assert.equal(view.status, "reconciliation_required");
  assert.equal(view.queue.phase, "blocked");
  assert.match(view.error, /禁止自动重发/);
  assert.equal(view.stopConfirmed, false);
  assert.equal(f.executor.hasHold, true);
  assert.equal((await f.storage.list({ prefix: "fixture:done:" })).size, 0);
});

test("a second-item turn marker without a native receipt keeps the original batch blocked after restart", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  const patchRun = f.runs.patchRun.bind(f.runs);
  let interrupted = false;
  f.runs.patchRun = (runId, patch) => {
    const saved = patchRun(runId, patch);
    if (!interrupted && patch.launchIntent === "turn_sent" && patch.batch?.currentIndex === 1) {
      interrupted = true;
      f.disconnect();
      throw Error("fault: second-item pending turn saved before native send");
    }
    return saved;
  };
  await f.until(() => interrupted);
  const pending = f.runs.getRun(f.runId).pendingRequestId;
  assert.ok(pending);
  await f.restart();
  for (let n = 0; n < 4; n++) await f.tick();
  const state = await f.nativeState(), view = await f.view();
  assert.equal(state.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(state.calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal(f.runs.getRun(f.runId).pendingRequestId, pending);
  assert.equal(view.batch.currentIndex, 1);
  assert.equal(view.status, "reconciliation_required");
  assert.equal(view.queue.phase, "blocked");
  assert.equal(view.stopConfirmed, false);
  assert.equal(f.executor.hasHold, true);
  assert.deepEqual([...await f.storage.list({ prefix: "fixture:done:" })].map(([key]) => key), ["fixture:done:task-1"]);
});

test("a persisted applied ACK lost in transit never repeats the native command after restart", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, input) => action === "ack" && input.status === "applied");
  await f.until(() => !f.online);
  const entry = f.journal.latest(f.runId);
  assert.equal(entry.phase, "applied");
  assert.equal(entry.acked, false);
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
  const acknowledgements = f.packets.filter(packet => packet.action === "ack" && packet.input.status === "applied");
  assert.ok(acknowledgements.length >= 2);
  assert.deepEqual(acknowledgements[0].input, acknowledgements[1].input);
});

test("lost event ACK replays identical durable events after restart without duplicate cloud history", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, input) => action === "events" && input.events.some(event => event.type === "verification.completed"));
  await f.until(() => !f.online);
  const page = f.journal.eventState(f.runId).page;
  assert.ok(page?.events.some(event => event.type === "verification.completed"));
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
  const replays = f.packets.filter(packet => packet.action === "events" && packet.input.events[0].eventId === page.events[0].eventId);
  assert.ok(replays.length >= 2);
  assert.deepEqual(replays[0].input, replays[1].input);
  const cloudEvents = [...(await f.storage.list({ prefix: `exec:event:${f.runId}:` })).values()];
  assert.equal(new Set(cloudEvents.map(event => event.eventId)).size, cloudEvents.length);
  for (const event of page.events) assert.equal(cloudEvents.filter(saved => saved.eventId === event.eventId).length, 1);
});

test("native completion survives cloud report commit with its ACK lost and reconnect", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, input) => action === "report" && input.batch?.items[0].status === "done");
  await f.until(() => !f.online);
  const pending = f.journal.run(f.runId).report;
  assert.equal(f.journal.run(f.runId).reportSent, false);
  assert.equal((await f.storage.get("exec:run:" + f.runId)).view.reportRevision, pending.revision);
  await f.reconnect();
  await f.finish();
  await f.assertExactlyOnce();
  const replays = f.packets.filter(packet => packet.action === "report" && packet.input.revision === pending.revision);
  assert.ok(replays.length >= 2);
  assert.deepEqual(replays[0].input, replays[1].input);
  assert.ok(replays[1].epoch > replays[0].epoch);
});

test("a persisted advance permit with lost ACK is replayed after cloud and runner restart", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, _input, result) => action === "batch-gate" && result.decision === "advance");
  await f.until(() => !f.online);
  const granted = f.packets.find(packet => packet.action === "batch-gate" && packet.result.decision === "advance");
  assert.equal((await f.nativeState()).calls.filter(call => call.method === "turn/start").length, 1);
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
  const replays = f.packets.filter(packet => packet.action === "batch-gate" && packet.input.completedTurnId === granted.input.completedTurnId);
  assert.ok(replays.length >= 2);
  assert.deepEqual(replays[0].result, replays[1].result);
});

test("canvas completion committed with lost ACK retries the same writeback after persistent restart", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseWritebackReply();
  await f.until(() => !f.online);
  const pending = await f.storage.get("exec:writebacks:" + f.runId);
  assert.equal(pending.entries[0].status, "pending");
  assert.equal((await f.storage.get("fixture:done:task-1")).effects, 1);
  const requestId = pending.entries[0].requestId;
  await f.restart();
  // Drive the real persisted alarm retry without waiting for its 4s backoff.
  const queue = await f.storage.get("exec:writebacks:" + f.runId);
  queue.entries[0].nextAt = 0;
  await f.storage.put("exec:writebacks:" + f.runId, queue);
  await f.storage.put(queue.indexKey, { runId: f.runId, nextAt: 0 });
  await f.dispatch.retryWritebacks();
  await f.finish();
  await f.assertExactlyOnce();
  const firstCalls = (await f.storage.get("fixture:finalize-calls")).filter(call => call.source.taskRef.taskId === "task-1");
  assert.equal(firstCalls.length, 2);
  assert.deepEqual(firstCalls.map(call => call.requestId), [requestId, requestId]);
  assert.deepEqual(firstCalls[0], firstCalls[1]);
});

test("final completion report committed with lost ACK survives restart and releases only after replay settles", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  f.loseReply((action, input) => action === "report" && input.stopConfirmed);
  await f.until(() => !f.online);
  const report = f.journal.run(f.runId).report;
  assert.equal(report.stopConfirmed, true);
  assert.equal(f.journal.run(f.runId).reportSent, false);
  assert.equal(f.executor.hasHold, true);
  assert.equal((await f.view()).queue.phase, "completed");
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
  const terminal = f.packets.filter(packet => packet.action === "report" && packet.input.revision === report.revision);
  assert.ok(terminal.length >= 2);
  assert.deepEqual(terminal[0].input, terminal[1].input);
  assert.equal(terminal[1].result.settled, true);
});

test("final report interrupted between queue observation and receipt commit is replayed to settlement", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  const put = f.storage.put.bind(f.storage);
  let interrupted = false;
  f.storage.put = async (key, value) => {
    if (!interrupted && typeof key === "object" && Object.keys(key).some(name => name.startsWith("exec:report:")) && key["exec:run:" + f.runId]?.view.stopConfirmed) {
      interrupted = true;
      f.disconnect();
      throw Error("fault: terminal queue observed before report receipt commit");
    }
    return put(key, value);
  };
  await f.until(() => interrupted);
  const pending = f.journal.run(f.runId).report;
  assert.equal(pending.stopConfirmed, true);
  assert.equal(f.journal.run(f.runId).reportSent, false);
  assert.equal(await f.storage.get(`exec:report:${f.runId}:${pending.revision}`), undefined);
  await f.restart();
  await f.finish();
  await f.assertExactlyOnce();
  const replay = f.packets.find(packet => packet.action === "report" && packet.input.revision === pending.revision);
  assert.equal(replay.result.settled, true);
  assert.ok(await f.storage.get(`exec:report:${f.runId}:${pending.revision}`));
});

test("lost thread identity remains recoverably blocked after restart and never creates a replacement chat", async t => {
  const f = await recoveryHarness(t, { mode: "exit-thread-start" });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  f.setMode("normal");
  await f.restart();
  for (let n = 0; n < 4; n++) await f.tick();
  const state = await f.nativeState();
  assert.equal(state.threads.length, 1);
  assert.equal(state.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(state.calls.filter(call => call.method === "turn/start").length, 0);
  const view = await f.view();
  assert.equal(view.status, "reconciliation_required");
  assert.equal(view.queue.phase, "blocked");
  assert.equal(view.stopConfirmed, false);
  assert.equal((await f.storage.list({ prefix: "fixture:done:" })).size, 0);
  assert.equal(f.executor.hasHold, true);
});
