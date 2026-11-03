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
        "export * from './runner/codex-adapter.ts'; export * from './runner/store.ts'; export * from './runner/workspace.ts';",
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
  const { CodexAdapter, RunnerStore, readGitBaseline } = api;
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
