import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/project-summary-durable.mjs";
const input = (requestId) => ({
  bindingId: "binding",
  bindingRevision: 1,
  requestId,
});
async function prepare(f) {
  await f.inject("prepared-after");
  assert.equal((await f.project("initialize", input("init"))).http, 500);
  const state = await f.project("state", { inspectOnly: true });
  assert.ok(state.activeRunId);
  const rows = await f.rows();
  assert.equal(rows["exec:run:" + state.activeRunId], undefined);
  return { state, launch: rows["project:launch:" + state.activeRunId] };
}

test('real DO: summary read progress survives restart and ignores older reports', {timeout:60000}, async t => {
  const f=await fixture(t);
  const first=await f.project('initialize',input('progress'));
  await f.dispatch(first.activeRunId);
  const run=(await f.rows())['exec:run:'+first.activeRunId];
  const summaryProgress={phase:'reading',totalRecords:100,readRecords:12,cachedRecords:70,pagesRead:2,startedAt:'2026-11-12T08:00:00.000Z',updatedAt:'2026-11-12T08:01:00.000Z',model:'gpt-6.1-terra',effort:'medium'};
  const report={runId:first.activeRunId,commandId:run.view.commandId,revision:2,status:'running',threadId:'summary-thread',turnId:'summary-turn',terminal:false,stopConfirmed:false,summaryProgress};
  assert.equal((await f.call({op:'native',action:'report',input:report})).http,200);
  assert.deepEqual((await f.project('state',{inspectOnly:true})).summaryProgress,summaryProgress);
  await f.restart();
  assert.deepEqual((await f.project('state',{inspectOnly:true})).summaryProgress,summaryProgress);
  assert.equal((await f.call({op:'native',action:'report',input:{...report,revision:1,summaryProgress:{...summaryProgress,readRecords:1}}})).http,200);
  assert.deepEqual((await f.project('state',{inspectOnly:true})).summaryProgress,summaryProgress);
});

test(
  "real DO: terminal summary report survives restart before its delayed result arrives",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.project("initialize", input("result-delivery"));
    assert.equal(first.http, 200);
    await f.dispatch(first.activeRunId);
    const run = (await f.rows())["exec:run:" + first.activeRunId];
    const report = await f.call({
      op: "native",
      action: "report",
      input: {
        runId: first.activeRunId,
        commandId: run.view.commandId,
        revision: 1,
        status: "verifying",
        threadId: "summary-thread",
        turnId: "summary-turn",
        terminal: true,
        stopConfirmed: true,
        summaryContext: {
          workspaceId: "workspace",
          capturedAt: new Date().toISOString(),
          gitBaseline: { commit: null, branch: null, dirty: false },
        },
      },
    });
    assert.equal(report.http, 200);
    assert.equal((await f.project("state")).status, "finalizing");
    await f.restart();
    const waiting = await f.project("state", { inspectOnly: true });
    assert.equal(waiting.status, "finalizing");
    assert.equal(waiting.ready, false);
    assert.equal(waiting.error, null);
    assert.equal((await f.project("refresh", input("premature"))).http, 409);
    const summary = {
      overview: "已读取完整的项目摘要。",
      completed: [],
      inProgress: [],
      pending: [{ text: "补齐已发现的待办", evidenceRef: "README.md" }],
      blockers: [],
      verification: [],
      uncertainties: [],
    };
    const delivery = await f.call({
      op: "native",
      action: "events",
      input: {
        events: [
          {
            protocolVersion: 1,
            eventId: "delayed-summary-result",
            runnerId: "runner",
            runId: first.activeRunId,
            threadId: "summary-thread",
            turnId: "summary-turn",
            seq: 1,
            type: "turn.completed",
            occurredAt: new Date().toISOString(),
            payload: {
              status: "completed",
              summary,
              outcome: null,
              error: null,
            },
          },
        ],
      },
    });
    assert.equal(delivery.http, 200);
    const ready = await f.project("state");
    assert.equal(ready.status, "ready");
    assert.equal(ready.ready, true);
    assert.equal(ready.error, null);
    assert.equal(ready.summaryRevision, 1);
    assert.deepEqual(ready.summary, summary);
    assert.equal(
      Object.keys(await f.rows()).filter((k) => k.startsWith("exec:run:"))
        .length,
      1,
    );
  },
);

test(
  "real DO: cancel wins, seal ACK is lost, reconstruction and late direct create cannot launch or alter a newer operation",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      { state, launch } = await prepare(f);
    const cancel = { runId: state.activeRunId, requestId: "stop" };
    await f.inject("seal-after");
    assert.equal((await f.tool("codex_cancel_run", cancel)).http, 500);
    await f.restart();
    const receipt = await f.tool("codex_cancel_run", cancel);
    assert.equal(receipt.http, 200);
    assert.equal(receipt.sealedLaunch.runId, state.activeRunId);
    assert.equal(receipt.stopConfirmed, undefined);
    assert.equal((await f.tool("codex_create_run", launch.input)).http, 409);
    let rows = await f.rows();
    assert.equal(
      Object.keys(rows).some(
        (k) =>
          k.startsWith("exec:run:") ||
          k.startsWith("exec:pending:") ||
          k.startsWith("exec:command-run:"),
      ),
      false,
    );
    const next = await f.project("refresh", input("next"));
    assert.equal(next.http, 200);
    await f.tool("codex_cancel_run", { ...cancel, requestId: "late-stop" });
    assert.equal(
      (await f.project("state", { inspectOnly: true })).activeRunId,
      next.activeRunId,
    );
    rows = await f.rows();
    assert.equal(
      Object.keys(rows).filter((k) => k.startsWith("exec:run:")).length,
      1,
    );
  },
);

test(
  "real DO: create wins and ordinary cancellation waits for native stop, while two tabs cannot replace it",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      { state, launch } = await prepare(f);
    assert.equal((await f.tool("codex_create_run", launch.input)).http, 200);
    assert.equal((await f.dispatch(state.activeRunId)).deliveries.length, 1);
    const results = await Promise.all([
      f.tool("codex_cancel_run", {
        runId: state.activeRunId,
        requestId: "stop",
      }),
      f.project("refresh", input("racing-refresh")),
    ]);
    assert.equal(results[0].http, 200);
    assert.equal(results[0].sealedLaunch, undefined);
    assert.equal(results[1].http, 409);
    const rows = await f.rows(),
      run = rows["exec:run:" + state.activeRunId];
    assert.equal(run.view.status, "cancel_requested");
    assert.equal(run.view.stopConfirmed, false);
    assert.equal(run.commands.at(-1).payload.type, "cancel_run");
    assert.equal(
      Object.keys(rows).filter((k) => k.startsWith("exec:run:")).length,
      1,
    );
  },
);

test(
  "real DO: state rebuild completes the exact committed launch; simultaneous initializers share one run",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.inject("coordinator-before");
    assert.equal((await f.project("initialize", input("first"))).http, 500);
    await f.restart();
    const recovered = await f.project("state");
    assert.equal(recovered.http, 200);
    assert.ok(recovered.activeRunId);
    const two = await Promise.all([
      f.project("initialize", { ...input("chat-one"), chatId: "one" }),
      f.project("initialize", { ...input("chat-two"), chatId: "two" }),
    ]);
    assert.ok(
      two.every(
        (s) => s.http === 200 && s.activeRunId === recovered.activeRunId,
      ),
    );
    assert.equal(
      Object.keys(await f.rows()).filter((k) => k.startsWith("exec:run:"))
        .length,
      1,
    );
  },
);

for (const first of ["create", "cancel"])
  test(
    `real DO: overlapping create/cancel requests serialize when ${first} enters first`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t),
        { state, launch } = await prepare(f);
      const create = ["codex_create_run", launch.input],
        cancel = [
          "codex_cancel_run",
          { runId: state.activeRunId, requestId: "stop-race" },
        ];
      const leading = f.tool(...(first === "create" ? create : cancel), true);
      await f.held();
      const following = f.tool(...(first === "create" ? cancel : create));
      await f.release();
      const [a, b] = await Promise.all([leading, following]),
        rows = await f.rows();
      assert.equal(a.http, 200);
      if (first === "cancel") {
        assert.ok(a.sealedLaunch);
        assert.equal(b.http, 409);
        assert.equal(
          Object.keys(rows).some(
            (k) =>
              k.startsWith("exec:run:") ||
              k.startsWith("exec:pending:") ||
              k.startsWith("exec:command-run:"),
          ),
          false,
        );
      } else {
        assert.equal(b.http, 200);
        assert.equal(b.sealedLaunch, undefined);
        assert.ok(rows["exec:run:" + state.activeRunId]);
        assert.equal(
          Object.keys(rows).filter((k) => k.startsWith("exec:run:")).length,
          1,
        );
      }
    },
  );
