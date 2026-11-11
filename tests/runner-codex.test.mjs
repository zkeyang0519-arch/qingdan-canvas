import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeSnapshot } from "./fixtures/agent-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const buildDir = await mkdtemp(path.join(root, ".tmp/runner-tests-build-"));
let api;
try {
  await build({
    stdin: {
      contents:
        "export * from './runner/codex-adapter.ts'; export * from './runner/store.ts'; export * from './runner/workspace.ts'; export * from './runner/batch.ts';",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
    outfile: path.join(buildDir, "runner.mjs"),
    logLevel: "silent",
  });
  api = await import(pathToFileURL(path.join(buildDir, "runner.mjs")));
} catch (error) {
  test("local Codex adapter is implemented", () => assert.fail(error.message));
}
test.after(() => rm(buildDir, { recursive: true, force: true }));

if (api) {
  const {
    CodexAdapter,
    RunnerStore,
    readGitBaseline,
    currentSnapshot,
    finishBatchItem,
  } = api;
  async function fixture(t, mode = "normal") {
    const dir = await mkdtemp(path.join(root, ".tmp/runner-codex-"));
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace);
    const dbPath = path.join(dir, "runner.sqlite"),
      statePath = path.join(dir, "fake.json");
    const store = new RunnerStore(dbPath);
    const adapters = [];
    const open = async (nextMode = mode, extra = {}) => {
      const adapter = new CodexAdapter({
        store,
        runnerId: "runner-a",
        workspaces: [{ workspaceId: "workspace-a", root: workspace }],
        command: process.execPath,
        args: [path.join(root, "tests/fixtures/fake-codex.mjs")],
        env: {
          ...process.env,
          FAKE_CODEX_STATE: statePath,
          FAKE_CODEX_MODE: nextMode,
          FAKE_RUNNER_DB: dbPath,
        },
        requestTimeoutMs: 800,
        shutdownTimeoutMs: 200,
        ...extra,
      });
      adapters.push(adapter);
      await adapter.connect();
      return adapter;
    };
    const snapshot = async (runId = "run-a", kind = "task") => {
      const value = makeSnapshot({
        runId,
        snapshotId: `snapshot-${runId}`,
        kind,
      });
      value.context.gitBaseline = await readGitBaseline(workspace);
      if (kind === "summary") value.task = null;
      else value.task.taskRef.taskId = `task-${runId}`;
      return value;
    };
    t.after(async () => {
      for (const adapter of adapters) await adapter.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    });
    return {
      dir,
      workspace,
      dbPath,
      statePath,
      store,
      open,
      snapshot,
      state: async () => JSON.parse(await readFile(statePath, "utf8")),
    };
  }

  async function batchSnapshot(f, runId = "batch-a") {
    const s = await f.snapshot(runId);
    s.batch = {
      items: [1, 2, 3].map((n) => ({
        taskId: `${runId}-item-${n}`,
        text: `待办 ${n}`,
        instruction: `执行待办 ${n}。`,
        acceptance: [
          {
            id: `check-${n}`,
            kind: "human",
            required: true,
            description: `核对待办 ${n}`,
          },
        ],
      })),
    };
    Object.assign(s.task, s.batch.items[0]);
    delete s.task.taskId;
    s.task.taskRef.taskId = s.batch.items[0].taskId;
    return s;
  }
  async function batchSettled(adapter, runId = "batch-a") {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const run = adapter.getRun(runId);
      if (run.batchPhase === "ready" || run.terminal) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("batch item did not settle");
  }

  async function checklistBatch(f) {
    const snapshot = await batchSnapshot(f);
    snapshot.batch.autoComplete = true;
    snapshot.batch.items.forEach((item, index) => {
      item.source = {
        taskRef: {
          ...snapshot.task.taskRef,
          noteId: `note-${index + 1}`,
          taskId: item.taskId,
        },
        generation: 1,
        specRevision: index + 1,
      };
    });
    snapshot.task.taskRef = snapshot.batch.items[0].source.taskRef;
    snapshot.task.specRevision = snapshot.batch.items[0].source.specRevision;
    return snapshot;
  }

  test("a checklist batch reports completion proof for the matching item and source note", async (t) => {
    const f = await fixture(t);
    const adapter = await f.open();
    const snapshot = await checklistBatch(f);
    const first = await adapter.startFreshRun(snapshot);
    const ready = await batchSettled(adapter);
    assert.equal(ready.batch.items[0].completedTurnId, first.turnId);
    const second = await adapter.advanceBatchRun(snapshot.runId);
    const next = await batchSettled(adapter);
    assert.equal(next.batch.items[1].completedTurnId, second.turnId);
    assert.deepEqual(currentSnapshot(next).task.taskRef, {
      canvasId: snapshot.task.taskRef.canvasId,
      noteId: "note-2",
      taskId: "batch-a-item-2",
    });
    await adapter.cancelRun(snapshot.runId);
    assert.equal(
      adapter.getRun(snapshot.runId).batch.items[0].completedTurnId,
      first.turnId,
    );
    assert.equal(
      adapter.getRun(snapshot.runId).batch.items[1].completedTurnId,
      second.turnId,
    );
  });

  test("approval reviewer parsing accepts only the two supported explicit values and defaults to user", () => {
    assert.equal(typeof api.parseApprovalsReviewer, "function");
    assert.equal(api.parseApprovalsReviewer(undefined), "user");
    assert.equal(api.parseApprovalsReviewer("user"), "user");
    assert.equal(api.parseApprovalsReviewer("auto_review"), "auto_review");
    for (const value of [
      "",
      "never",
      "guardian_subagent",
      " auto_review",
      true,
    ])
      assert.throws(() => api.parseApprovalsReviewer(value), {
        code: "VALIDATION_ERROR",
      });
  });
  for (const reviewer of [undefined, "auto_review"]) {
    test(`approval reviewer ${reviewer ?? "default"} applies to new threads, turns and follow-ups without relaxing sandbox permissions`, async (t) => {
      const f = await fixture(t),
        adapter = await f.open(
          "normal",
          reviewer ? { approvalsReviewer: reviewer } : {},
        );
      const task = await f.snapshot("review-task");
      await adapter.startFreshRun(task);
      const completed = await adapter.waitForRun(task.runId, 4000);
      await adapter.continueRun({
        requestId: "review-follow-up",
        runId: task.runId,
        expectedTurnId: completed.activeTurnId,
        mode: "reply",
        message: "Check again",
      });
      await adapter.waitForRun(task.runId, 4000);
      const summary = await f.snapshot("review-summary", "summary");
      await adapter.startFreshRun(summary);
      await adapter.waitForRun(summary.runId, 4000);
      const state = await f.state();
      const requests = state.calls.filter((call) =>
        ["thread/start", "thread/resume", "turn/start"].includes(call.method),
      );
      assert.ok(requests.some((call) => call.method === "thread/resume"));
      for (const { params } of requests) {
        assert.equal(params.approvalsReviewer, reviewer ?? "user");
        assert.equal(params.approvalPolicy, "on-request");
      }
      const starts = requests.filter((call) => call.method === "thread/start");
      assert.deepEqual(
        starts.map((call) => call.params.sandbox),
        ["workspace-write", "read-only"],
      );
      const turns = requests.filter((call) => call.method === "turn/start");
      assert.deepEqual(
        turns.map((call) => call.params.sandboxPolicy.type),
        ["workspaceWrite", "workspaceWrite", "readOnly"],
      );
      assert.ok(
        turns.every(
          (call) => call.params.sandboxPolicy.networkAccess === false,
        ),
      );
      assert.deepEqual(turns[0].params.sandboxPolicy.writableRoots, [
        f.workspace,
      ]);
    });
  }
  test("explicit approval reviewer survives batch advancement and reconnecting an active turn", async (t) => {
    const f = await fixture(t),
      adapter = await f.open("normal", { approvalsReviewer: "auto_review" });
    await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    await adapter.advanceBatchRun("batch-a");
    await batchSettled(adapter);
    await adapter.cancelRun("batch-a");
    const hanging = await f.open("hang", { approvalsReviewer: "auto_review" });
    await hanging.startFreshRun(await f.snapshot("active-review"));
    await hanging.close({ stopRuns: false });
    const recovered = await f.open("hang", {
      approvalsReviewer: "auto_review",
    });
    await recovered.reconcileRun("active-review");
    const resumes = (await f.state()).calls.filter(
      (call) => call.method === "thread/resume",
    );
    assert.equal(resumes.length, 2);
    for (const { params } of resumes) {
      assert.equal(params.approvalsReviewer, "auto_review");
      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.sandbox, "workspace-write");
    }
  });
  test("a successful result racing cancellation cannot create checklist completion proof", () => {
    const run = {
      activeTurnId: "turn-racing-cancel",
      snapshot: { kind: "task" },
      batch: {
        currentIndex: 1,
        items: [
          { taskId: "task-a", status: "done", completedTurnId: "turn-a" },
          { taskId: "task-b", status: "running" },
        ],
      },
    };
    const { batch } = finishBatchItem(
      run,
      { outcome: "done", summary: "已完成" },
      "completed",
      true,
    );
    assert.equal(batch.items[0].completedTurnId, "turn-a");
    assert.equal(batch.items[1].status, "cancelled");
    assert.equal(batch.items[1].completedTurnId, undefined);
  });
  for (const profile of ["read_only", "workspace_manual", "workspace_auto"]) {
    test(`immutable ${profile} permissions override legacy environment reviewer on every task turn`, async (t) => {
      const f = await fixture(t),
        adapter = await f.open("normal", { approvalsReviewer: "auto_review" });
      const snapshot = await f.snapshot();
      snapshot.executionPermissions = { profile, network: false };
      await adapter.startFreshRun(snapshot);
      const finished = await adapter.waitForRun("run-a", 4000);
      await adapter.continueRun({
        requestId: "profile-follow-up",
        runId: "run-a",
        expectedTurnId: finished.activeTurnId,
        mode: "reply",
        message: "Review",
      });
      await adapter.waitForRun("run-a", 4000);
      const calls = (await f.state()).calls.filter((c) =>
        ["thread/start", "thread/resume", "turn/start"].includes(c.method),
      );
      for (const call of calls) {
        assert.equal(
          call.params.approvalsReviewer,
          profile === "workspace_auto" ? "auto_review" : "user",
        );
        assert.equal(call.params.approvalPolicy, "on-request");
        if (call.method === "turn/start") {
          assert.equal(
            call.params.sandboxPolicy.type,
            profile === "read_only" ? "readOnly" : "workspaceWrite",
          );
          assert.equal(call.params.sandboxPolicy.networkAccess, false);
        } else
          assert.equal(
            call.params.sandbox,
            profile === "read_only" ? "read-only" : "workspace-write",
          );
      }
    });
  }

  test("an automatic checklist completion seals the current item against a between-item steer", async (t) => {
    const f = await fixture(t);
    const adapter = await f.open();
    const snapshot = await checklistBatch(f);
    await adapter.startFreshRun(snapshot);
    const ready = await batchSettled(adapter);
    await assert.rejects(
      adapter.continueRun({
        requestId: "between-item-supplement",
        runId: snapshot.runId,
        expectedTurnId: ready.activeTurnId,
        mode: "steer",
        message: "请再核对当前项的结果。",
      }),
      { code: "ITEM_SEALED" },
    );
    assert.equal((await f.state()).threads[0].turns.length, 1);
  });

  test("three batch items execute sequential turns in one chat and a later submission creates another chat", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    const s = await batchSnapshot(f);
    const launched = await adapter.startFreshRun(s);
    for (let i = 0; i < 3; i++) {
      const run = await batchSettled(adapter);
      assert.equal(run.batch.currentIndex, i);
      assert.equal(run.batch.items[i].status, "done");
      assert.equal(run.threadId, launched.threadId);
      assert.equal(run.terminal, i === 2);
      assert.equal(run.active, i !== 2);
      assert.equal((await f.state()).threads[0].turns.length, i + 1);
      if (i < 2) await adapter.advanceBatchRun("batch-a");
    }
    assert.equal(adapter.getRun("batch-a").batchPhase, "complete");
    assert.deepEqual(adapter.getRun("batch-a").snapshot, s);
    const starts = (await f.state()).calls.filter(
      (c) => c.method === "turn/start",
    );
    assert.ok(
      !starts[0].params.additionalContext.qingdan_task.value.includes("待办 2"),
    );
    assert.deepEqual(
      starts.map((c) => c.params.input[0].text),
      ["执行待办 1。", "执行待办 2。", "执行待办 3。"],
    );
    assert.equal(new Set(starts.map((c) => c.params.threadId)).size, 1);
    const next = await adapter.startFreshRun(await batchSnapshot(f, "batch-b"));
    assert.notEqual(next.threadId, launched.threadId);
    await batchSettled(adapter, "batch-b");
    await adapter.cancelRun("batch-b");
  });

  test("a persisted between-item cancellation finishes after restart without reusing the completed event", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    f.store.patchRun("batch-a", {
      cancelRequested: true,
      status: "cancel_requested",
    });
    await adapter.close({ stopRuns: false });
    const resumed = await f.open();
    await resumed.reconcileRun("batch-a");
    assert.equal(resumed.getRun("batch-a").status, "cancelled");
    assert.equal(resumed.getRun("batch-a").terminal, true);
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "turn/start").length,
      1,
    );
  });

  test("a supplement between batch items starts a follow-up for the completed current item", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    const ready = await batchSettled(adapter);
    await adapter.continueRun({
      requestId: "between-item-supplement",
      runId: "batch-a",
      expectedTurnId: ready.activeTurnId,
      mode: "steer",
      message: "请再核对当前项的结果。",
    });
    const retried = await batchSettled(adapter);
    assert.equal(retried.batch.currentIndex, 0);
    assert.equal(retried.batchPhase, "ready");
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "turn/steer").length,
      0,
    );
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "turn/start").at(-1)
        .params.input[0].text,
      "请再核对当前项的结果。",
    );
    await adapter.cancelRun("batch-a");
  });

  test("a pending manual batch retry does not report the previous turn's completion proof", async (t) => {
    const f = await fixture(t, "batch-exit-second"),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    const ready = await batchSettled(adapter);
    assert.equal(ready.batch.items[0].completedTurnId, ready.activeTurnId);
    const receipt = await adapter.continueRun({
      requestId: "between-item-supplement",
      runId: "batch-a",
      expectedTurnId: ready.activeTurnId,
      mode: "steer",
      message: "请再核对当前项的结果。",
    });
    assert.equal(receipt.status, "reconciliation_required");
    const pending = adapter.getRun("batch-a");
    assert.equal(pending.batch.items[0].status, "running");
    assert.equal(pending.batch.items[0].completedTurnId, undefined);
  });

  test("batch cancellation between items confirms background commands have stopped before release", async (t) => {
    const f = await fixture(t, "batch-background"),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    await adapter.cancelRun("batch-a");
    assert.equal(adapter.getRun("batch-a").status, "cancelled");
    const state = await f.state();
    assert.equal(state.threads[0].terminals.length, 0);
    assert.equal(
      state.calls.filter(
        (c) => c.method === "thread/backgroundTerminals/terminate",
      ).length,
      2,
    );
  });

  test("a blocked batch item pauses later work and a reply retries that item in the same chat", async (t) => {
    const f = await fixture(t, "batch-block-second"),
      adapter = await f.open();
    const first = await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    await adapter.advanceBatchRun("batch-a");
    const paused = await batchSettled(adapter);
    assert.equal(paused.batchPhase, "paused");
    assert.equal(paused.status, "waiting_input");
    assert.equal(paused.batch.items[1].status, "blocked");
    assert.equal(paused.batch.items[2].status, "pending");
    await assert.rejects(adapter.advanceBatchRun("batch-a"), {
      code: "BATCH_NOT_READY",
    });
    assert.equal((await f.state()).threads[0].turns.length, 2);
    await adapter.continueRun({
      requestId: "fix-block",
      runId: "batch-a",
      expectedTurnId: paused.activeTurnId,
      mode: "reply",
      message: "问题已解决，请完成当前待办。",
    });
    await batchSettled(adapter);
    await adapter.advanceBatchRun("batch-a");
    const done = await batchSettled(adapter);
    assert.equal(done.batchPhase, "complete");
    assert.equal(done.threadId, first.threadId);
    assert.equal((await f.state()).threads[0].turns.length, 4);
  });

  test("cancelling between batch items stops the queue without dispatching the next turn", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    await adapter.cancelRun("batch-a");
    const run = adapter.getRun("batch-a");
    assert.equal(run.status, "cancelled");
    assert.equal(run.terminal, true);
    assert.equal(run.active, false);
    assert.deepEqual(
      run.batch.items.map((i) => i.status),
      ["done", "cancelled", "cancelled"],
    );
    await assert.rejects(adapter.advanceBatchRun("batch-a"), {
      code: "BATCH_NOT_READY",
    });
    assert.equal((await f.state()).threads[0].turns.length, 1);
  });

  test("a lost second batch turn reply recovers the same turn without repeating it", async (t) => {
    const f = await fixture(t, "batch-exit-second"),
      adapter = await f.open();
    await adapter.startFreshRun(await batchSnapshot(f));
    await batchSettled(adapter);
    const advanced = await adapter.advanceBatchRun("batch-a");
    assert.equal(advanced.status, "reconciliation_required");
    const restarted = await f.open("normal");
    await restarted.reconcileRun("batch-a");
    assert.equal(restarted.getRun("batch-a").batchPhase, "ready");
    assert.equal(restarted.getRun("batch-a").batch.currentIndex, 1);
    assert.equal((await f.state()).threads[0].turns.length, 2);
    await restarted.advanceBatchRun("batch-a");
    await batchSettled(restarted);
    assert.equal((await f.state()).threads[0].turns.length, 3);
  });

  test("natural-language task and follow-up omit dispatch data while wire identities remain stable", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    const snapshot = await f.snapshot("natural-task");
    snapshot.task.text = "创建欢迎文件";
    snapshot.task.instruction = "创建 welcome.txt，内容为你好。";
    snapshot.task.acceptance = [
      {
        id: "check-a",
        kind: "human",
        required: true,
        description: "welcome.txt 内容为你好。",
      },
    ];
    const launch = await adapter.startFreshRun(snapshot);
    assert.equal(launch.status, "started", launch.reason);
    await adapter.waitForRun(snapshot.runId, 4000);
    let calls = (await f.state()).calls;
    const start = calls.find((c) => c.method === "turn/start").params;
    assert.equal(start.input[0].text, "创建 welcome.txt，内容为你好。");
    assert.ok(
      start.additionalContext.qingdan_task.value.includes(
        snapshot.task.acceptance[0].description,
      ),
    );
    for (const internal of [
      snapshot.runId,
      snapshot.snapshotId,
      snapshot.ownerId,
      snapshot.bindingId,
      snapshot.payloadHash,
    ])
      assert.ok(!start.input[0].text.includes(internal), internal);
    assert.equal(start.clientUserMessageId, "initial-natural-task");
    assert.equal(start.outputSchema, undefined);
    const registration = calls.find((c) => c.method === "thread/start").params;
    assert.equal(registration.dynamicTools[0].name, "qingdan_report_result");
    assert.match(
      registration.dynamicTools[0].inputSchema.properties.changedFiles
        .description,
      /相对路径/,
    );
    assert.match(
      registration.dynamicTools[0].inputSchema.properties.remainingIssues
        .description,
      /done/,
    );
    assert.match(
      registration.dynamicTools[0].inputSchema.properties.remainingIssues
        .description,
      /空数组/,
    );
    assert.equal(
      registration.dynamicTools[0].inputSchema.properties.runId,
      undefined,
    );
    assert.equal(
      registration.dynamicTools[0].inputSchema.properties.taskId,
      undefined,
    );
    assert.equal(
      calls.find((c) => c.method === "thread/name/set").params.name,
      "轻单 · 创建欢迎文件",
    );
    const first = adapter.getRun(snapshot.runId);
    assert.equal(first.result.runId, snapshot.runId);
    assert.equal(first.result.taskId, snapshot.task.taskRef.taskId);
    await adapter.continueRun({
      requestId: "natural-follow",
      runId: snapshot.runId,
      expectedTurnId: first.activeTurnId,
      mode: "reply",
      message: "再增加一行：欢迎回来。",
    });
    await adapter.waitForRun(snapshot.runId, 4000);
    calls = (await f.state()).calls;
    const follow = calls.filter((c) => c.method === "turn/start").at(-1).params;
    assert.equal(follow.input[0].text, "再增加一行：欢迎回来。");
    assert.ok(!follow.input[0].text.includes(snapshot.payloadHash));
    assert.ok(!follow.input[0].text.includes("natural-follow"));
    assert.equal(follow.clientUserMessageId, "natural-follow");
    assert.equal(
      calls.findLast((c) => c.method === "thread/resume").params
        .developerInstructions,
      registration.developerInstructions,
    );
    assert.ok(
      follow.additionalContext?.qingdan_task.value.includes(
        "welcome.txt 内容为你好。",
      ),
    );
    assert.equal(adapter.getRun(snapshot.runId).threadId, first.threadId);
  });

  test("desktop refresh follows a confirmed dispatch and never repeats execution or follow-up refresh", async (t) => {
    const f = await fixture(t),
      calls = [];
    const adapter = await f.open("normal", {
      desktopProjectSync: async (root) => {
        assert.equal(f.store.getRun("run-a").launchResult?.status, "started");
        calls.push(root);
      },
    });
    const snapshot = await f.snapshot();
    const launch = await adapter.startFreshRun(snapshot);
    await adapter.waitForRun("run-a", 4000);
    assert.deepEqual(calls, [f.workspace]);
    assert.equal(adapter.getRun("run-a").desktopSync.status, "requested");
    await adapter.startFreshRun(snapshot);
    await adapter.continueRun({
      requestId: "desktop-follow",
      runId: "run-a",
      expectedTurnId: launch.turnId,
      mode: "reply",
      message: "补充核对",
    });
    await adapter.waitForRun("run-a", 4000);
    assert.deepEqual(calls, [f.workspace]);
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "thread/start").length,
      1,
    );
  });

  test("desktop refresh failure leaves execution intact and replay only retries the refresh", async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    const adapter = await f.open("normal", {
      desktopProjectSync: async () => {
        if (++attempts === 1) throw Error("Desktop unavailable");
      },
    });
    const snapshot = await f.snapshot();
    await adapter.startFreshRun(snapshot);
    const completed = await adapter.waitForRun("run-a", 4000);
    assert.equal(completed.result.outcome, "done");
    assert.equal(adapter.getRun("run-a").desktopSync.status, "failed");
    await adapter.startFreshRun(snapshot);
    const retriedAt = Date.now();
    while (
      adapter.getRun("run-a").desktopSync.status === "pending" &&
      Date.now() - retriedAt < 4000
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attempts, 2);
    assert.equal(adapter.getRun("run-a").desktopSync.status, "requested");
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "turn/start").length,
      1,
    );
  });

  test("slow desktop refresh does not delay task execution and close awaits the refresh", async (t) => {
    const f = await fixture(t);
    let release;
    const adapter = await f.open("normal", {
      desktopProjectSync: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const launch = await adapter.startFreshRun(await f.snapshot());
    const startedAt = Date.now();
    while (!release && Date.now() - startedAt < 4000)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof release, "function");
    assert.equal(launch.status, "started");
    await adapter.waitForRun("run-a", 4000);
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(adapter.getRun("run-a").desktopSync.status, "requested");
  });

  test("desktop-only bookkeeping failure cannot change a confirmed task dispatch", async (t) => {
    const f = await fixture(t);
    const patch = f.store.patchRun.bind(f.store);
    f.store.patchRun = (id, fields) => {
      if ("desktopSync" in fields)
        throw Error("SQLITE_BUSY during desktop bookkeeping");
      return patch(id, fields);
    };
    const adapter = await f.open("normal", {
      desktopProjectSync: async () => {},
    });
    const launch = await adapter.startFreshRun(await f.snapshot());
    assert.equal(launch.status, "started");
    const completed = await adapter.waitForRun("run-a", 4000);
    assert.equal(completed.result.outcome, "done");
    assert.equal(completed.status, "verifying");
    await adapter.close();
  });

  test("replacing a disconnected adapter need not wait for desktop refresh or write after close", async (t) => {
    const f = await fixture(t);
    let release;
    const adapter = await f.open("normal", {
      desktopProjectSync: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await adapter.startFreshRun(await f.snapshot());
    await adapter.waitForRun("run-a", 4000);
    const closing = adapter.close({ stopRuns: false, waitDesktop: false });
    const immediate = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    release();
    await closing;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(immediate, true);
    assert.equal(adapter.getRun("run-a").desktopSync.status, "pending");
  });

  test("natural-language summary keeps useful context and its read-only scope", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    const snapshot = await f.snapshot("natural-summary", "summary");
    snapshot.context.projectSummary = {
      overview: "这是个人网站",
      completed: [{ text: "首页已有草稿" }],
      inProgress: [],
      pending: [],
      blockers: [],
      verification: [],
      uncertainties: [],
    };
    snapshot.context.decisions = ["使用中文文件名"];
    snapshot.context.previousTaskNotes = ["上一项已创建说明文档"];
    await adapter.startFreshRun(snapshot);
    await adapter.waitForRun(snapshot.runId, 4000);
    const calls = (await f.state()).calls;
    const start = calls.find((c) => c.method === "turn/start").params;
    const text = start.input[0].text;
    assert.match(text, /^请只读检查当前项目/);
    assert.ok(start.additionalContext?.qingdan_task);
    for (const value of [
      "个人网站",
      "首页已有草稿",
      "使用中文文件名",
      "上一项已创建说明文档",
      "README",
      "AGENTS.md",
      "Git",
      "推测",
    ])
      assert.ok(
        start.additionalContext.qingdan_task.value.includes(value),
        value,
      );
    for (const value of [
      snapshot.runId,
      snapshot.ownerId,
      snapshot.payloadHash,
    ])
      assert.ok(!text.includes(value), value);
    assert.equal(
      calls.find((c) => c.method === "thread/name/set").params.name,
      "轻单 · 项目总结",
    );
  });

  test("a result tool records the outcome while the conversation ends in natural language", async (t) => {
    for (const kind of ["task", "summary"]) {
      const f = await fixture(t, "report"),
        adapter = await f.open();
      const snapshot = await f.snapshot(`reported-${kind}`, kind);
      await adapter.startFreshRun(snapshot);
      const run = await adapter.waitForRun(snapshot.runId, 4000);
      assert.equal(run.output, "已完成本次任务，并核对了结果。");
      assert.equal(run.resultValid, true);
      assert.equal(run.status, "verifying");
      if (kind === "task") {
        assert.equal(run.result.outcome, "done");
        assert.equal(run.result.runId, snapshot.runId);
        assert.equal(run.result.taskId, snapshot.task.taskRef.taskId);
      } else assert.equal(run.result.overview, "测试项目");
      const response = (await f.state()).calls.find(
        (c) => c.method === "server-response",
      );
      assert.equal(response.params.result.success, true);
    }
  });

  test("missing, invalid and foreign-turn reports cannot complete a task", async (t) => {
    for (const mode of [
      "report-missing",
      "report-invalid",
      "report-wrong-turn",
    ]) {
      const f = await fixture(t, mode),
        adapter = await f.open();
      await adapter.startFreshRun(await f.snapshot());
      const run = await adapter.waitForRun("run-a", 4000);
      assert.equal(run.resultValid, false, mode);
      assert.equal(run.status, "waiting_input", mode);
      assert.equal(run.result, null, mode);
      if (mode === "report-invalid") {
        const reply = (await f.state()).calls.find(
          (c) => c.method === "server-response",
        );
        assert.match(
          reply.params.result.contentItems[0].text,
          /changedFiles.*相对路径/,
        );
        assert.match(
          reply.params.result.contentItems[0].text,
          /remainingIssues.*空数组/,
        );
      }
    }
  });

  test("new tool-mode conversations cannot replace a missing report with JSON in the final reply", async (t) => {
    const f = await fixture(t, "business-output"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    const run = await adapter.waitForRun("run-a", 4000);
    assert.equal(run.resultValid, false);
    assert.equal(run.status, "waiting_input");
  });

  test("a pre-steer report arriving during steering cannot complete the supplemental request", async (t) => {
    const f = await fixture(t, "report-steer-race"),
      adapter = await f.open();
    const launched = await adapter.startFreshRun(await f.snapshot());
    await adapter.continueRun({
      requestId: "steer-after-report",
      runId: "run-a",
      expectedTurnId: launched.turnId,
      mode: "steer",
      message: "再检查另一份文件。",
    });
    const run = await adapter.waitForRun("run-a", 4000);
    assert.equal(run.resultValid, false);
    assert.equal(run.status, "waiting_input");
    const call = (await f.state()).calls.find((c) => c.method === "turn/steer");
    assert.equal(call.params.input[0].text, "再检查另一份文件。");
  });

  test("a report does not finish a live turn and cancellation discards it", async (t) => {
    const f = await fixture(t, "report-hold"),
      adapter = await f.open();
    const launch = await adapter.startFreshRun(await f.snapshot());
    assert.equal(launch.status, "started", adapter.getRun("run-a").resultError);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (adapter.getRun("run-a").reportedResult) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      adapter.getRun("run-a").reportedResult?.result.outcome,
      "done",
      adapter.getRun("run-a").resultError ??
        (await readFile(`${f.statePath}.error`, "utf8").catch(() => undefined)),
    );
    assert.equal(adapter.getRun("run-a").terminal, false);
    assert.equal(adapter.getRun("run-a").resultValid, false);
    await adapter.cancelRun("run-a");
    const run = await adapter.waitForRun("run-a", 4000);
    assert.equal(run.status, "cancelled");
    assert.equal(run.result, null);
  });

  test("a report followed by execution failure cannot supply a successful result", async (t) => {
    const f = await fixture(t, "report-failed"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    const run = await adapter.waitForRun("run-a", 4000);
    assert.equal(run.status, "failed");
    assert.equal(run.resultValid, false);
    assert.equal(run.result, null);
  });

  test("report history recovers a lost completion without re-executing the task", async (t) => {
    const f = await fixture(t, "report-silent"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await assert.rejects(adapter.waitForRun("run-a", 250), {
      code: "WAIT_TIMEOUT",
    });
    f.store.patchRun("run-a", { output: "", reportedResult: null });
    const restarted = await f.open("metadata-history");
    assert.equal((await restarted.reconcileRun("run-a")).status, "completed");
    assert.equal(
      restarted.getRun("run-a").output,
      "已完成本次任务，并核对了结果。",
    );
    assert.equal(restarted.getRun("run-a").resultValid, true);
    assert.equal(restarted.getRun("run-a").result.outcome, "done");
    assert.equal(
      (await f.state()).calls.filter((c) => c.method === "turn/start").length,
      1,
    );
  });

  test("a follow-up without a new report cannot reuse the previous turn outcome", async (t) => {
    const f = await fixture(t, "report"),
      adapter = await f.open();
    const launched = await adapter.startFreshRun(await f.snapshot());
    await adapter.waitForRun("run-a", 4000);
    await adapter.close();
    const restarted = await f.open("report-missing");
    await restarted.continueRun({
      requestId: "follow-without-report",
      runId: "run-a",
      expectedTurnId: launched.turnId,
      mode: "reply",
      message: "再核对一次。",
    });
    const run = await restarted.waitForRun("run-a", 4000);
    assert.equal(run.resultValid, false);
    assert.equal(run.status, "waiting_input");
  });

  test("business result receives authoritative task identities; legacy identities still must match", async (t) => {
    for (const mode of [
      "business-output",
      "legacy-output",
      "wrong-result-id",
    ]) {
      const f = await fixture(t),
        adapter = await f.open();
      const snapshot = await f.snapshot();
      await adapter.startFreshRun(snapshot);
      const first = await adapter.waitForRun(snapshot.runId, 4000);
      await adapter.close();
      // Seed the persisted shape of a pre-tool run. Only these existing chats
      // may still use a JSON final message when a new turn resumes them.
      f.store.patchRun(snapshot.runId, {
        resultChannel: undefined,
        reportedResult: null,
      });
      const legacy = await f.open(mode);
      await legacy.continueRun({
        requestId: `legacy-${mode}`,
        runId: snapshot.runId,
        expectedTurnId: first.activeTurnId,
        mode: "reply",
        message: "继续核对。",
      });
      const result = await legacy.waitForRun(snapshot.runId, 4000);
      assert.ok(
        (await f.state()).calls.filter((c) => c.method === "turn/start").at(-1)
          .params.outputSchema,
      );
      assert.equal(result.resultValid, mode !== "wrong-result-id", mode);
      if (mode !== "wrong-result-id") {
        assert.equal(result.result.runId, snapshot.runId);
        assert.equal(result.result.taskId, snapshot.task.taskRef.taskId);
      } else assert.equal(result.status, "waiting_input");
    }
  });

  test("summary and tasks A/B each start a fresh thread in the selected workspace and return results", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    const launches = [];
    for (const [runId, kind] of [
      ["summary", "summary"],
      ["a", "task"],
      ["b", "task"],
    ]) {
      const launched = await adapter.startFreshRun(
        await f.snapshot(runId, kind),
      );
      launches.push(launched);
      assert.equal(launched.status, "started");
      const result = await adapter.waitForRun(runId, 4000);
      assert.equal(result.status, "verifying");
      assert.equal(result.resultValid, true);
      assert.equal(
        kind === "summary" ? result.result.overview : result.result.outcome,
        kind === "summary" ? "测试项目" : "done",
      );
    }
    assert.equal(new Set(launches.map((v) => v.threadId)).size, 3);
    const state = await f.state();
    assert.deepEqual(
      state.calls.slice(0, 2).map((v) => v.method),
      ["initialize", "initialized"],
    );
    assert.deepEqual(
      state.calls
        .filter((v) => v.method === "thread/start")
        .map((v) => [v.params.cwd, v.params.sandbox, v.params.approvalPolicy]),
      [
        [f.workspace, "read-only", "on-request"],
        [f.workspace, "workspace-write", "on-request"],
        [f.workspace, "workspace-write", "on-request"],
      ],
    );
    assert.deepEqual(
      state.calls
        .filter((v) => v.method === "turn/start")
        .map((v) => v.persistedThreadId),
      launches.map((v) => v.threadId),
    );
  });

  test("replaying a run does not launch twice, and reusing a run ID with changed content is rejected", async (t) => {
    const f = await fixture(t),
      adapter = await f.open(),
      snapshot = await f.snapshot();
    const first = await adapter.startFreshRun(snapshot);
    await adapter.waitForRun("run-a", 4000);
    assert.deepEqual(await adapter.startFreshRun(snapshot), first);
    await assert.rejects(
      adapter.startFreshRun({ ...snapshot, memoryEpoch: 99 }),
      { code: "IDEMPOTENCY_KEY_REUSED" },
    );
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "thread/start").length,
      1,
    );
  });

  test("continuation reuses its task thread and command retries cannot create an extra turn", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    const first = await adapter.startFreshRun(await f.snapshot());
    await adapter.waitForRun("run-a", 4000);
    const input = {
      requestId: "continue-a",
      runId: "run-a",
      expectedTurnId: first.turnId,
      message: "补充说明",
      mode: "reply",
    };
    const next = await adapter.continueRun(input);
    await adapter.waitForRun("run-a", 4000);
    assert.equal(next.threadId, first.threadId);
    assert.notEqual(next.turnId, first.turnId);
    assert.deepEqual(await adapter.continueRun(input), next);
    await assert.rejects(
      adapter.continueRun({ ...input, message: "不同内容" }),
      { code: "IDEMPOTENCY_KEY_REUSED" },
    );
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "thread/start").length,
      1,
    );
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "turn/start").length,
      2,
    );
  });

  for (const mode of [
    "early-completed",
    "duplicate",
    "foreign-completed",
    "exit-completed",
  ])
    test(`${mode}: only a mapped turn completes once`, async (t) => {
      const f = await fixture(t, mode),
        adapter = await f.open();
      await adapter.startFreshRun(await f.snapshot());
      const result = await adapter.waitForRun("run-a", 4000);
      assert.equal(result.status, "verifying");
      const events = f.store.eventsAfter(0).map((v) => v.event);
      assert.equal(events.filter((v) => v.type === "turn.completed").length, 1);
      assert.ok(events.every((v) => v.turnId !== "foreign-turn"));
    });

  test("lost thread/start response stays uncertain across restart and never silently relaunches", async (t) => {
    const f = await fixture(t, "exit-thread-start"),
      adapter = await f.open(),
      snapshot = await f.snapshot();
    assert.equal(
      (await adapter.startFreshRun(snapshot)).status,
      "reconciliation_required",
    );
    const restarted = await f.open("normal");
    assert.equal(
      (await restarted.startFreshRun(snapshot)).status,
      "reconciliation_required",
    );
    assert.equal(
      (await restarted.reconcileRun("run-a")).status,
      "reconciliation_required",
    );
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "thread/start").length,
      1,
    );
  });

  test("lost turn/start response is recovered by paginated history without repeating execution", async (t) => {
    const f = await fixture(t, "exit-turn-start"),
      adapter = await f.open();
    assert.equal(
      (await adapter.startFreshRun(await f.snapshot())).status,
      "reconciliation_required",
    );
    const state = await f.state();
    state.threads[0].turns.push({
      id: "unrelated-newer-turn",
      status: "completed",
      error: null,
      items: [],
    });
    await writeFile(f.statePath, JSON.stringify(state));
    const restarted = await f.open("normal");
    assert.equal((await restarted.reconcileRun("run-a")).status, "completed");
    assert.equal(restarted.getRun("run-a").result.outcome, "done");
    assert.equal(
      (await restarted.startFreshRun(await f.snapshot())).status,
      "started",
    );
    assert.equal(restarted.getRun("run-a").status, "verifying");
    assert.equal(restarted.getRun("run-a").terminal, true);
    const calls = (await f.state()).calls;
    assert.equal(calls.filter((v) => v.method === "turn/start").length, 1);
    assert.ok(
      calls.some(
        (v) => v.method === "thread/turns/list" && v.params.cursor === "1",
      ),
    );
  });

  test("reconciliation loads wrapped, paginated item history when turn summaries omit items", async (t) => {
    const f = await fixture(t, "silent-completed"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await assert.rejects(adapter.waitForRun("run-a", 250), {
      code: "WAIT_TIMEOUT",
    });
    f.store.patchRun("run-a", { output: "" });
    const restarted = await f.open("metadata-history");
    assert.equal((await restarted.reconcileRun("run-a")).status, "completed");
    assert.equal(restarted.getRun("run-a").result.outcome, "done");
    assert.ok(
      (await f.state()).calls.some(
        (v) => v.method === "thread/items/list" && v.params.cursor === "1",
      ),
    );
  });

  test("replaying a saved started receipt after restart reconciles its existing thread", async (t) => {
    const f = await fixture(t, "silent-completed"),
      adapter = await f.open(),
      snapshot = await f.snapshot();
    const first = await adapter.startFreshRun(snapshot);
    await assert.rejects(adapter.waitForRun("run-a", 250), {
      code: "WAIT_TIMEOUT",
    });
    const restarted = await f.open("normal");
    assert.deepEqual(await restarted.startFreshRun(snapshot), first);
    assert.equal(restarted.getRun("run-a").terminal, true);
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "turn/start").length,
      1,
    );
  });

  test("a failed resume is retried before a saved started receipt claims recovery", async (t) => {
    const f = await fixture(t, "exit-running"),
      adapter = await f.open(),
      snapshot = await f.snapshot();
    await adapter.startFreshRun(snapshot);
    await assert.rejects(adapter.waitForRun("run-a", 150), {
      code: "WAIT_TIMEOUT",
    });
    const restarted = await f.open("resume-once-fails");
    assert.equal(
      (await restarted.startFreshRun(snapshot)).status,
      "reconciliation_required",
    );
    assert.equal((await restarted.startFreshRun(snapshot)).status, "started");
    assert.equal(
      (await f.state()).calls.filter((v) => v.method === "thread/resume")
        .length,
      2,
    );
    assert.equal(restarted.getRun("run-a").status, "running");
  });

  for (const mode of ["approval", "input"])
    test(`${mode} requests wait for an explicit reply and retain the running turn`, async (t) => {
      const f = await fixture(t, mode),
        adapter = await f.open();
      const run = await adapter.startFreshRun(await f.snapshot());
      const request = await adapter.waitForRequest("run-a", 4000);
      assert.equal(
        adapter.getRun("run-a").status,
        mode === "approval" ? "waiting_approval" : "waiting_input",
      );
      assert.equal(
        (await f.state()).calls.filter((v) => v.method === "server-response")
          .length,
        0,
      );
      await adapter.reconcileRun("run-a");
      assert.equal(
        adapter.getRun("run-a").status,
        mode === "approval" ? "waiting_approval" : "waiting_input",
      );
      await adapter.respondToRequest(
        request.id,
        mode === "approval"
          ? { decision: "accept" }
          : { answers: { choice: { answers: ["测试"] } } },
      );
      assert.equal(
        (await adapter.waitForRun("run-a", 4000)).activeTurnId,
        run.turnId,
      );
    });
  for (const mode of ["approval", "file-approval", "input"]) {
    test(`cloud ${mode} responses bind the native run thread turn request and publish safe closure`, async (t) => {
      const f = await fixture(t, mode),
        adapter = await f.open();
      const snapshot = await f.snapshot();
      snapshot.executionPermissions = {
        profile: "workspace_manual",
        network: false,
      };
      await adapter.startFreshRun(snapshot);
      const request = await adapter.waitForRequest("run-a", 4000);
      const event = f.store
        .eventsAfter(0)
        .map((r) => r.event)
        .find(
          (e) =>
            e.type ===
            (mode === "input" ? "input.requested" : "approval.requested"),
        );
      if (mode === "input")
        assert.deepEqual(event.payload.questions[0].options, [
          { label: "测试", description: "使用测试环境" },
        ]);
      else {
        assert.equal(
          event.payload.details.method,
          mode === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/fileChange/requestApproval",
        );
        assert.deepEqual(event.payload.details.allowedDecisions, [
          "accept",
          "decline",
          "cancel",
        ]);
        assert.ok(!JSON.stringify(event).includes("fake-private-token"));
        assert.ok(!JSON.stringify(event).includes("private raw patch"));
        if (mode === "file-approval")
          assert.deepEqual(event.payload.details.files, [
            `${f.workspace}/safe.txt`,
          ]);
      }
      const delivery = {
        responseId: "answer-a",
        pendingRequestId: request.id,
        runId: request.runId,
        threadId: request.threadId,
        turnId: request.turnId,
        response:
          mode === "input"
            ? { answers: { choice: { answers: ["测试"] } } }
            : { decision: "accept" },
      };
      await assert.rejects(
        adapter.respondToCloudRequest({ ...delivery, turnId: "wrong-turn" }),
        { code: "REVISION_CONFLICT" },
      );
      assert.equal(
        (await f.state()).calls.filter((c) => c.method === "server-response")
          .length,
        0,
      );
      await adapter.respondToCloudRequest(delivery);
      await adapter.waitForRun("run-a", 4000);
      const resolved = f.store
        .eventsAfter(0)
        .map((r) => r.event)
        .find((e) => e.type === "request.resolved");
      assert.equal(resolved.payload.requestId, request.id);
      assert.equal(resolved.payload.status, "responded");
      assert.ok(!JSON.stringify(resolved).includes("answers"));
      await assert.rejects(adapter.respondToCloudRequest(delivery), {
        code: "REQUEST_NOT_FOUND",
      });
    });
  }
  for (const [mode, profile] of [
    ["file-approval", "read_only"],
    ["session-approval", "workspace_manual"],
    ["network-approval", "workspace_manual"],
  ]) {
    test(`${profile} rejects accepting ${mode} that expands its immutable scope`, async (t) => {
      const f = await fixture(t, mode),
        adapter = await f.open();
      const snapshot = await f.snapshot();
      snapshot.executionPermissions = { profile, network: false };
      await adapter.startFreshRun(snapshot);
      const request = await adapter.waitForRequest("run-a", 4000);
      const event = f.store
        .eventsAfter(0)
        .map((r) => r.event)
        .find((e) => e.type === "approval.requested");
      assert.deepEqual(event.payload.details.allowedDecisions, [
        "decline",
        "cancel",
      ]);
      await assert.rejects(
        adapter.respondToRequest(request.id, { decision: "accept" }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        adapter.respondToRequest(request.id, { decision: "acceptForSession" }),
        { code: "VALIDATION_ERROR" },
      );
      await adapter.respondToRequest(request.id, { decision: "decline" });
      await adapter.waitForRun("run-a", 4000);
    });
  }
  test("native pending requests expire on cancellation, disconnection, restart and their own deadline", async (t) => {
    for (const action of ["cancel", "disconnect", "expire"]) {
      let now = Date.now();
      const f = await fixture(t, "approval"),
        adapter = await f.open("approval", { now: () => now });
      await adapter.startFreshRun(await f.snapshot());
      const request = await adapter.waitForRequest("run-a", 4000);
      if (action === "cancel") await adapter.cancelRun("run-a");
      if (action === "disconnect") await adapter.close({ stopRuns: false });
      if (action === "expire") {
        now += 16 * 60_000;
        adapter.expireRequests();
      }
      await assert.rejects(
        adapter.respondToRequest(request.id, { decision: "accept" }),
      );
      const resolution = f.store
        .eventsAfter(0)
        .map((r) => r.event)
        .find((e) => e.type === "request.resolved");
      assert.equal(
        resolution.payload.status,
        action === "cancel" ? "cancelled" : "expired",
      );
      if (action === "disconnect") {
        const reopened = await f.open("hang");
        assert.equal(reopened.pendingRequests("run-a").length, 0);
        await assert.rejects(
          reopened.respondToRequest(request.id, { decision: "accept" }),
          { code: "REQUEST_NOT_FOUND" },
        );
      }
    }
  });

  test("cancellation is not final until the matching turn actually stops", async (t) => {
    const f = await fixture(t, "hang"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    assert.equal((await adapter.cancelRun("run-a")).status, "cancel_requested");
    assert.equal((await adapter.waitForRun("run-a", 4000)).status, "cancelled");
  });

  test("a completion arriving during history reconciliation cannot be reverted to running", async (t) => {
    const f = await fixture(t, "complete-during-read"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    assert.equal((await adapter.reconcileRun("run-a")).status, "completed");
    assert.equal(adapter.getRun("run-a").terminal, true);
    assert.equal(adapter.getRun("run-a").status, "verifying");
    assert.equal(
      f.store
        .eventsAfter(0)
        .filter((row) => row.event.type === "turn.completed").length,
      1,
    );
  });

  test("a history query failure cannot overwrite a completion received while awaiting it", async (t) => {
    const f = await fixture(t, "complete-during-read-error"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    assert.equal((await adapter.reconcileRun("run-a")).status, "completed");
    assert.equal(adapter.getRun("run-a").status, "verifying");
    assert.equal(adapter.getRun("run-a").terminal, true);
  });

  test("cancellation terminates only its thread's paginated background terminals before releasing the workspace", async (t) => {
    const f = await fixture(t, "background-cancel"),
      adapter = await f.open();
    const launch = await adapter.startFreshRun(await f.snapshot());
    await adapter.cancelRun("run-a");
    assert.equal((await adapter.waitForRun("run-a", 4000)).status, "cancelled");
    const state = await f.state();
    assert.equal(state.threads[0].terminals.length, 0);
    assert.deepEqual(
      state.calls
        .filter((v) => v.method === "thread/backgroundTerminals/terminate")
        .map((v) => v.params),
      [
        { threadId: launch.threadId, processId: "process-a" },
        { threadId: launch.threadId, processId: "process-b" },
      ],
    );
    assert.ok(
      state.calls.some(
        (v) =>
          v.method === "thread/backgroundTerminals/list" &&
          v.params.cursor === "1",
      ),
    );
  });

  test("a background terminal that cannot be confirmed stopped keeps the workspace blocked", async (t) => {
    const f = await fixture(t, "background-stuck"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await adapter.cancelRun("run-a");
    await assert.rejects(adapter.waitForRun("run-a", 300), {
      code: "WAIT_TIMEOUT",
    });
    assert.equal(adapter.getRun("run-a").status, "reconciliation_required");
    assert.equal(adapter.getRun("run-a").active, true);
    assert.equal(
      f.store.eventsAfter(0).some((row) => row.event.type === "run.cancelled"),
      false,
    );
    await assert.rejects(adapter.startFreshRun(await f.snapshot("next")), {
      code: "WORKSPACE_BUSY",
    });
  });

  test("cancellation intent survives missing notifications and history reconciliation", async (t) => {
    const f = await fixture(t, "silent-cancelled"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await adapter.cancelRun("run-a");
    await assert.rejects(adapter.waitForRun("run-a", 100), {
      code: "WAIT_TIMEOUT",
    });
    assert.equal((await adapter.reconcileRun("run-a")).status, "completed");
    assert.equal(adapter.getRun("run-a").status, "cancelled");
  });

  test("unconfirmed cancellation and shutdown retain reconciliation status", async (t) => {
    const f = await fixture(t, "ignore-cancel"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await adapter.cancelRun("run-a");
    await adapter.close();
    assert.equal(f.store.getRun("run-a").status, "reconciliation_required");
  });

  test("invalid model output never becomes a successful task result", async (t) => {
    const f = await fixture(t, "invalid-output"),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    const result = await adapter.waitForRun("run-a", 4000);
    assert.equal(result.resultValid, false);
    assert.equal(result.status, "waiting_input");
    assert.match(result.resultError, /structured|JSON|结果/);
  });

  test("project discovery pages through all source kinds and only returns registered workspaces", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    for (const runId of ["a", "b"]) {
      await adapter.startFreshRun(await f.snapshot(runId));
      await adapter.waitForRun(runId, 4000);
    }
    const projects = await adapter.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].threads.length, 2);
    const call = (await f.state()).calls.find(
      (v) => v.method === "thread/list",
    );
    assert.deepEqual(call.params.sourceKinds, [
      "cli",
      "vscode",
      "exec",
      "appServer",
    ]);
    await assert.rejects(
      adapter.startFreshRun({
        ...(await f.snapshot("unknown")),
        workspaceId: "unregistered",
      }),
      { code: "ACCESS_DENIED" },
    );
  });

  test("version mismatch prevents the app-server process from starting", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.open("normal", {
        env: {
          ...process.env,
          FAKE_VERSION: "9.0.0",
          FAKE_CODEX_STATE: f.statePath,
        },
      }),
      { code: "CODEX_VERSION_MISMATCH" },
    );
    await assert.rejects(readFile(f.statePath));
  });

  test("SQLite reopens existing runs and refuses unknown future schema versions", async (t) => {
    const f = await fixture(t),
      adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await adapter.waitForRun("run-a", 4000);
    await adapter.close();
    const reopened = new RunnerStore(f.dbPath);
    assert.equal(reopened.getRun("run-a").result.outcome, "done");
    reopened.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();
    assert.throws(() => new RunnerStore(f.dbPath), {
      code: "STORE_VERSION_UNSUPPORTED",
    });
  });
}
