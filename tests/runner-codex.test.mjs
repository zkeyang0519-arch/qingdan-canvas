import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeSnapshot } from "./fixtures/agent-fixtures.mjs";
import { projectItems, savedProjectSummary } from "./fixtures/project-execution.mjs";
import { handoffSummary } from "./fixtures/project-handoff.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const buildDir = await mkdtemp(path.join(root, ".tmp/runner-tests-build-"));
let api;
try {
  await build({
    stdin: {
      contents:
        "export * from './runner/codex-adapter.ts'; export * from './runner/store.ts'; export * from './runner/workspace.ts'; export * from './runner/batch.ts'; export {projectInspectionTool, projectInspectionRoot} from './runner/project-inspection.ts'; export { collectProjectHistory } from './runner/project-history.ts'; export { historyTool, initialHistoryRead } from './runner/project-history-pages.ts'; export {selectHistoryCache, historyReadInput} from './runner/summary-cache.ts'; export {resultTool} from './runner/prompt.ts';",
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

  test("project execution hands every selected instruction and saved project context to one Codex turn", async (t) => {
    const f = await fixture(t, "report");
    const snapshot = await f.snapshot("project-a");
    snapshot.executionMode = "project";
    snapshot.projectTasks = projectItems("canvas-a");
    snapshot.context.projectSummary = { ...handoffSummary, completed: savedProjectSummary.completed };
    const adapter = await f.open();
    await adapter.startFreshRun(snapshot);
    const run = await adapter.waitForRun("project-a", 4000);
    await adapter.startFreshRun(snapshot);
    const starts = (await f.state()).calls.filter(call => call.method === "turn/start");
    assert.equal(starts.length, 1);
    const prompt = starts[0].params.input[0].text;
    assert.match(prompt, /CSV 导出/);
    assert.match(prompt, /按钮溢出/);
    assert.match(starts[0].params.additionalContext.qingdan_task.value, /已有登录入口/);
    assert.match(starts[0].params.additionalContext.qingdan_task.value, /320px/);
    for (const text of ["JSON 导出已实现", "CSV 尚未实现", "空列表与中文编码", "补齐 CSV 格式转换时从这里开始", "保留 JSON 导出接口", "本轮未运行测试"]) {
      assert.ok(starts[0].params.additionalContext.qingdan_task.value.includes(text), text);
    }
    assert.equal(run.batch, undefined);
    assert.equal(run.terminal, true);
    assert.equal(run.status, "verifying");
    assert.equal(run.result.taskId, snapshot.task.taskRef.taskId);
    assert.ok(snapshot.projectTasks.every(item => item.taskId !== run.result.taskId));
  });

  test("public Codex output keeps message boundaries and command logs once without leaking reasoning", async (t) => {
    const f = await fixture(t, "hang");
    const adapter = await f.open();
    const started = await adapter.startFreshRun(await f.snapshot());
    const packet = (method, fields) => adapter.receive({ method, params: { threadId: started.threadId, turnId: started.turnId, ...fields } });
    packet("item/agentMessage/delta", { itemId: "comment-1", delta: "先检查项目。" });
    packet("item/completed", { item: { type: "agentMessage", id: "comment-1", phase: "commentary", text: "先检查项目。" } });
    packet("item/started", { item: { type: "commandExecution", id: "cmd-1", command: "npm test", cwd: f.workspace, status: "inProgress", aggregatedOutput: null } });
    packet("item/commandExecution/outputDelta", { itemId: "cmd-1", delta: "2 tests passed\n" });
    const completed = { type: "commandExecution", id: "cmd-1", command: "npm test", cwd: f.workspace, status: "completed", aggregatedOutput: "2 tests passed\n", exitCode: 0 };
    packet("item/completed", { item: completed });
    packet("item/completed", { item: completed });
    packet("item/completed", { item: { type: "fileChange", id: "files-1", status: "completed", changes: [{ path: "src/export.ts", kind: { type: "update", move_path: null }, diff: "private full diff" }] } });
    packet("item/reasoning/textDelta", { itemId: "reasoning-1", delta: "private internal reasoning" });
    packet("item/completed", { item: { type: "reasoning", id: "reasoning-1", content: ["private internal reasoning"], summary: ["private reasoning summary"] } });
    packet("item/completed", { item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "已完成导出。" } });
    const outputs = f.store.eventsAfter(0).map(row => row.event).filter(event => event.type === "output.delta");
    assert.equal(outputs.filter(event => event.payload.itemId === "comment-1" && event.payload.phase === "delta").map(event => event.payload.text).join(""), "先检查项目。");
    assert.equal(outputs.filter(event => event.payload.itemId === "answer-1").map(event => event.payload.text).join(""), "已完成导出。");
    const commands = outputs.filter(event => event.payload.channel === "command");
    assert.equal(commands.filter(event => event.payload.phase === "started").length, 1);
    assert.equal(commands.filter(event => event.payload.phase === "completed").length, 1);
    assert.equal(commands.map(event => event.payload.text).join(""), "2 tests passed\n");
    assert.equal(commands.at(-1).payload.title, "npm test · 退出码 0");
    assert.match(outputs.find(event => event.payload.channel === "file_change").payload.text, /src\/export.ts/);
    assert.doesNotMatch(JSON.stringify(outputs), /private/);
    assert.equal(adapter.getRun("run-a").output, "已完成导出。");
    assert.equal(outputs.find(event => event.payload.itemId === "comment-1" && event.payload.phase === "completed").payload.messagePhase, "commentary");
    assert.equal(outputs.find(event => event.payload.itemId === "answer-1").payload.messagePhase, "final_answer");
  });
  test("completed turn delivers the explicit final answer instead of trailing progress or partial text", async (t) => {
    const f = await fixture(t, "hang");
    const adapter = await f.open();
    const started = await adapter.startFreshRun(await f.snapshot());
    adapter.complete("run-a", {
      id: started.turnId, status: "completed", items: [
        { type: "agentMessage", id: "answer", phase: "final_answer", text: "已完成导出并通过测试。" },
        { type: "agentMessage", id: "partial", phase: "partial_answer", text: "仍在整理" },
        { type: "agentMessage", id: "legacy", phase: null, text: "未分类进度" },
        { type: "agentMessage", id: "comment", phase: "commentary", text: "当前分支 main" },
      ],
    }, true, true);
    assert.equal(adapter.getRun("run-a").output, "已完成导出并通过测试。");
    assert.equal(f.store.eventsAfter(0).find(({ event }) => event.type === "turn.completed").event.payload.output, "已完成导出并通过测试。");
  });
  test("a turn without a final answer cannot promote commentary or partial output to its result", async (t) => {
    const f = await fixture(t, "hang");
    const adapter = await f.open();
    const started = await adapter.startFreshRun(await f.snapshot());
    adapter.receive({ method: "item/completed", params: { threadId: started.threadId, turnId: started.turnId, item: { type: "agentMessage", id: "partial", phase: "partial_answer", text: "正在整理最终结果" } } });
    assert.equal(adapter.getRun("run-a").output, "");
    f.store.patchRun("run-a", { output: "旧版本误存的进度" });
    adapter.complete("run-a", { id: started.turnId, status: "completed", items: [
      { type: "agentMessage", id: "comment", phase: "commentary", text: "当前分支 main" },
      { type: "agentMessage", id: "partial", phase: "partial_answer", text: "正在整理最终结果" },
    ] }, true, true);
    assert.equal(adapter.getRun("run-a").output, "");
    assert.equal(f.store.eventsAfter(0).find(({ event }) => event.type === "turn.completed").event.payload.output, "");
  });
  test("legacy unphased progress before a command is not delivered as the final answer", async (t) => {
    const f = await fixture(t, "hang");
    const adapter = await f.open();
    const started = await adapter.startFreshRun(await f.snapshot());
    adapter.complete("run-a", { id: started.turnId, status: "completed", items: [
      { type: "agentMessage", id: "progress", phase: null, text: "现在检查 main 分支" },
      { type: "commandExecution", id: "cmd", command: "git status", status: "completed", exitCode: 0, aggregatedOutput: "main" },
    ] }, true, true);
    assert.equal(adapter.getRun("run-a").output, "");
  });
  async function legacyInspection(f, snapshot, mode) {
    const original = await f.open("report");
    await original.startFreshRun(snapshot);
    const first = await original.waitForRun(snapshot.runId, 4000);
    await original.close();
    const state = await f.state();
    state.threads.find(thread => thread.id === first.threadId).dynamicTools = state.threads.find(thread => thread.id === first.threadId).dynamicTools.filter(tool => tool.name !== "qingdan_read_project_history");
    state.threads.find(thread => thread.id === first.threadId).dynamicTools.push(api.projectInspectionTool());
    await writeFile(f.statePath, JSON.stringify(state));
    f.store.patchRun(snapshot.runId, { summaryHistory: undefined, summaryInspection: { root: await api.projectInspectionRoot(f.workspace), sources: [] } });
    const adapter = await f.open(mode);
    await adapter.continueRun({ requestId: "legacy-" + snapshot.runId, runId: snapshot.runId, expectedTurnId: first.activeTurnId, mode: "reply", message: "继续原项目检查。" });
    return adapter;
  }
  async function legacyHistory(f, snapshot, mode, original) {
    await original.startFreshRun(snapshot);
    const first = await original.waitForRun(snapshot.runId, 4000);
    const history = await api.collectProjectHistory(original.client, f.workspace, {
      excludeThreadIds: f.store.allRuns().filter(r => r.snapshot.kind === "summary").map(r => r.threadId).filter(Boolean),
    });
    const cache = api.selectHistoryCache(history, snapshot, f.workspace, f.store.allRuns());
    await original.close();
    const state = await f.state();
    state.threads.find(th => th.id === first.threadId).dynamicTools = [api.resultTool("summary", "history"), api.historyTool()];
    await writeFile(f.statePath, JSON.stringify(state));
    f.store.patchRun(snapshot.runId, { summaryInspection: undefined, summaryHistory: history, summaryHistoryCache: cache,
      summaryHistoryRead: api.initialHistoryRead(api.historyReadInput(history, cache)), summaryProgress: undefined,
      summaryContext: { ...first.summaryContext, sourceKind: "codex_history" } });
    const adapter = await f.open(mode);
    await adapter.continueRun({ requestId: "legacy-history-" + snapshot.runId, runId: snapshot.runId, expectedTurnId: first.activeTurnId, mode: "reply", message: "继续原历史总结。" });
    return adapter;
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
  for (const profile of ["read_only", "workspace_manual", "workspace_auto", "full_access"]) {
    test(`immutable ${profile} permissions override legacy environment reviewer on every task turn`, async (t) => {
      const f = await fixture(t),
        adapter = await f.open("normal", { approvalsReviewer: "auto_review" });
      const snapshot = await f.snapshot();
      snapshot.executionPermissions = { profile, network: profile === "full_access" };
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
        assert.equal(call.params.approvalPolicy, profile === "full_access" ? "never" : "on-request");
        if (call.method === "turn/start") {
          assert.equal(
            call.params.sandboxPolicy.type,
            profile === "read_only" ? "readOnly" : profile === "full_access" ? "dangerFullAccess" : "workspaceWrite",
          );
          if (profile !== "full_access") assert.equal(call.params.sandboxPolicy.networkAccess, false);
        } else
          assert.equal(
            call.params.sandbox,
            profile === "read_only" ? "read-only" : profile === "full_access" ? "danger-full-access" : "workspace-write",
          );
      }
    });
  }

  test("full access survives batch advancement, checkpoint recovery and reconnecting an active turn", async (t) => {
    const f = await fixture(t), adapter = await f.open("normal", { approvalsReviewer: "auto_review" });
    const snapshot = await batchSnapshot(f);
    snapshot.executionPermissions = { profile: "full_access", network: true };
    await adapter.startFreshRun(snapshot);
    await batchSettled(adapter);
    await adapter.confirmPausedCheckpoint("batch-a", async () => {});
    await adapter.advanceBatchRun("batch-a");
    await batchSettled(adapter);
    await adapter.cancelRun("batch-a");
    await adapter.close();
    const stopped = await f.open();
    await stopped.confirmRunStopped("batch-a");
    await stopped.close();
    const hanging = await f.open("hang", { approvalsReviewer: "auto_review" });
    const active = await f.snapshot("active-full-access");
    active.executionPermissions = { profile: "full_access", network: true };
    await hanging.startFreshRun(active);
    await hanging.close({ stopRuns: false });
    const recovered = await f.open("hang", { approvalsReviewer: "auto_review" });
    await recovered.reconcileRun(active.runId);
    const calls = (await f.state()).calls.filter(call => ["thread/start", "thread/resume", "turn/start"].includes(call.method));
    assert.equal(calls.filter(call => call.method === "thread/resume").length, 4);
    for (const { method, params } of calls) {
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.approvalsReviewer, "user");
      if (method === "turn/start") assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" });
      else assert.equal(params.sandbox, "danger-full-access");
    }
  });

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

  test("current summary rechecks cloud cancellation before starting its model turn", async (t) => {
    const f = await fixture(t, "report");
    const adapter = await f.open();
    const snapshot = await f.snapshot("cancel-after-history", "summary");
    let gates = 0;
    const result = await adapter.startFreshRun(snapshot, async stage => {
      if (stage === "turn" && ++gates === 2) throw Error("cloud cancelled summary");
    });
    assert.notEqual(result.status, "started");
    assert.match(result.reason, /cloud cancelled summary/);
    const calls = (await f.state()).calls;
    assert.equal(calls.some(call => call.method === "thread/list"), false);
    assert.equal(calls.some(call => call.method === "turn/start"), false);
  });

  test("composer model and fast mode reach both native thread and turn requests", async (t) => {
    const f = await fixture(t, "hang");
    await writeFile(f.statePath, JSON.stringify({
      threads: [], calls: [],
      models: [{ model: "selected-model", serviceTiers: [{ id: "priority" }], additionalSpeedTiers: ["fast"] }],
    }));
    const adapter = await f.open("hang", { model: "fallback-model" });
    const snapshot = await f.snapshot("chosen-model");
    snapshot.executionSettings = { model: "selected-model", fastMode: true, reasoningEffort: "high" };
    await adapter.startFreshRun(snapshot);
    const calls = (await f.state()).calls.filter(call => ["thread/start", "turn/start"].includes(call.method));
    assert.equal(calls.length, 2);
    for (const { params } of calls) {
      assert.equal(params.model, "selected-model");
      assert.equal(params.serviceTier, "priority");
    }
    assert.equal(calls[1].params.effort, "high");
  });

  test("native execution rejects fast mode when the model catalog advertises no fast tier", async (t) => {
    const f = await fixture(t, "hang");
    await writeFile(f.statePath, JSON.stringify({
      threads: [], calls: [],
      models: [{ model: "standard-only", serviceTiers: [] }],
    }));
    const adapter = await f.open();
    const snapshot = await f.snapshot("unsupported-fast");
    snapshot.executionSettings = { model: "standard-only", fastMode: true };
    const result = await adapter.startFreshRun(snapshot);
    assert.match(result.reason, /不支持快速模式/);
    assert.equal((await f.state()).calls.some(({ method }) => method === "thread/start"), false);
  });

  test("summary models are pinned to Terra medium without changing ordinary task models", async (t) => {
    const f = await fixture(t, "report");
    const adapter = await f.open("report", { model: "gpt-6-astra", effort: "max" });
    const task = await f.snapshot("model-task");
    await adapter.startFreshRun(task);
    await adapter.waitForRun(task.runId, 4000);
    const snapshot = await f.snapshot("model-summary", "summary");
    await adapter.startFreshRun(snapshot);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    const calls = (await f.state()).calls;
    const start = calls.find(c => c.method === "turn/start" && c.params.threadId === run.threadId);
    assert.equal(start.params.model, "gpt-6.1-terra");
    assert.equal(start.params.effort, "medium");
    assert.deepEqual(run.summarySettings, { model: "gpt-6.1-terra", effort: "medium" });
    const taskStart = calls.find(c => c.method === "turn/start" && c.params.threadId === adapter.getRun(task.runId).threadId);
    assert.equal(taskStart.params.model, "gpt-6-astra");
    assert.equal(taskStart.params.effort, "max");
  });

  test("current summaries inspect only requested files and can finish while unread content remains", async (t) => {
    const f = await fixture(t, "report-current");
    await writeFile(path.join(f.workspace, "README.md"), "Project plan: latest state\n".repeat(3000));
    await mkdir(path.join(f.workspace, "deep"));
    await writeFile(path.join(f.workspace, "deep/unrelated.md"), "Do not need to read this\n");
    await writeFile(f.statePath, JSON.stringify({ threads: [{ id: "source-old", cwd: f.workspace, name: "Old history", turns: [] }], calls: [] }));
    const adapter = await f.open();
    const snapshot = await f.snapshot("current-summary", "summary");
    await adapter.startFreshRun(snapshot, async stage => {
      if (stage === "thread") {
        assert.equal(adapter.getRun(snapshot.runId).summaryProgress.mode, "project");
        assert.equal(adapter.getRun(snapshot.runId).summaryProgress.totalRecords, null);
      }
    });
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, true, run.resultError);
    assert.equal(run.summaryInspection?.mode, "current");
    assert.equal(run.summaryInspection?.reportFormat, "handoff");
    assert.ok(run.result.handoff);
    assert.equal(run.summaryHistory, undefined);
    const state = await f.state();
    assert.equal(state.calls.some(c => c.method === "thread/list"), false, "history is fetched only when Codex asks");
    const thread = state.threads.find(th => th.id === run.threadId);
    const tools = thread.dynamicTools.map(tool => tool.name);
    assert.ok(tools.includes("qingdan_inspect_project"));
    assert.ok(tools.includes("qingdan_read_recent_history"));
    assert.ok(!tools.includes("qingdan_read_project_history"));
    const inspections = thread.turns[0].items.filter(i => i.tool === "qingdan_inspect_project");
    assert.ok(inspections.every(i => i.success));
    const listing = JSON.parse(inspections[0].contentItems[0].text);
    assert.ok(listing.entries.some(e => e.path === "deep"));
    assert.ok(!listing.entries.some(e => e.path === "deep/unrelated.md"));
    assert.ok(JSON.parse(inspections[1].contentItems[0].text).nextCursor, "long file remains partially read");
    const logs = f.store.eventsForRunAfter(run.runId, 0).map(r => r.event).filter(e => e.type === "output.delta").map(e => e.payload.text).join("");
    assert.match(logs, /README\.md/);
    assert.equal(run.summaryProgress.mode, "project");
    assert.equal(run.summaryProgress.filesRead, 1);
    assert.equal(run.summaryProgress.totalRecords, null);
    await adapter.close();
    const reopened = await f.open();
    assert.deepEqual(reopened.getRun(run.runId).summaryInspection, run.summaryInspection);
  });

  test("new summaries require handoff fields while saved pre-handoff current runs can still finish", async (t) => {
    const f = await fixture(t, "report-no-handoff");
    let adapter = await f.open();
    const incomplete = await f.snapshot("missing-handoff", "summary");
    await adapter.startFreshRun(incomplete);
    const rejected = await adapter.waitForRun(incomplete.runId, 4000);
    assert.equal(rejected.resultValid, false);
    const report = (await f.state()).threads.find(th => th.id === rejected.threadId).turns[0].items.find(item => item.tool === "qingdan_report_result");
    assert.equal(report.success, false);
    assert.match(report.contentItems[0].text, /handoff/);
    await adapter.close();
    f.store.patchRun(incomplete.runId, { summaryInspection: { ...rejected.summaryInspection, reportFormat: undefined } });
    const oldState = await f.state();
    const oldTool = oldState.threads.find(th => th.id === rejected.threadId).dynamicTools.find(tool => tool.name === "qingdan_report_result");
    delete oldTool.inputSchema.properties.handoff;
    oldTool.inputSchema.required = oldTool.inputSchema.required.filter(name => name !== "handoff");
    await writeFile(f.statePath, JSON.stringify(oldState));
    adapter = await f.open();
    await adapter.continueRun({ requestId: "old-current-retry", runId: incomplete.runId, expectedTurnId: rejected.activeTurnId, mode: "reply", message: "继续旧版按需总结" });
    const recovered = await adapter.waitForRun(incomplete.runId, 4000);
    assert.equal(recovered.resultValid, true, recovered.resultError);
    assert.equal(recovered.result.handoff, undefined);
    const resumedContext = (await f.state()).calls.findLast(call => call.method === "turn/start").params.additionalContext.qingdan_task;
    assert.doesNotMatch(JSON.stringify(resumedContext), /handoff\./);
    assert.match(JSON.stringify(resumedContext), /nextSteps/);
  });

  test("summary cache survives adapter restart and covers reused plus new records", async (t) => {
    const f = await fixture(t, "report");
    let adapter = await f.open();
    const task = await f.snapshot("cache-source");
    await adapter.startFreshRun(task); await adapter.waitForRun(task.runId, 4000);
    const first = await f.snapshot("cache-first", "summary");
    adapter = await legacyHistory(f, first, "report", adapter); await adapter.waitForRun(first.runId, 4000);
    await adapter.close(); adapter = await f.open();
    const nextTask = await f.snapshot("cache-new-source");
    await adapter.startFreshRun(nextTask); await adapter.waitForRun(nextTask.runId, 4000);
    const next = await f.snapshot("cache-second", "summary");
    adapter = await legacyHistory(f, next, "report", adapter);
    const run = await adapter.waitForRun(next.runId, 4000);
    assert.equal(run.resultValid, true, run.resultError);
    assert.equal(run.summaryHistoryCache.sourceRunId, first.runId);
    assert.equal(run.result.coverage.cachedRecords, 1);
    assert.equal(run.result.coverage.deliveredRecords, 2);
    assert.equal(run.result.coverage.totalRecords, 2);
    assert.equal(run.summaryProgress.phase, "summarizing");
    assert.equal(run.summaryProgress.readRecords, 1);
    assert.equal(run.summaryProgress.cachedRecords, 1);
    const state = await f.state();
    const turn = state.threads.find(th => th.id === run.threadId).turns.at(-1);
    const content = turn.items.filter(i => i.tool === "qingdan_read_project_history").map(i => i.contentItems?.[0]?.text).join('');
    assert.match(content, /native:cached-summary/);
    const start = state.calls.filter(c => c.method === "turn/start" && c.params.threadId === run.threadId).at(-1);
    assert.ok(Buffer.byteLength(JSON.stringify(start.params.additionalContext)) < 16000);
  });

  test("legacy history continuations preserve their history-only tool contract", async (t) => {
    const f = await fixture(t, "report");
    let adapter = await f.open();
    const task = await f.snapshot("source-task");
    await adapter.startFreshRun(task);
    await adapter.waitForRun(task.runId, 4000);
    const snapshot = await f.snapshot("history-summary", "summary");
    adapter = await legacyHistory(f, snapshot, "report", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, true);
    assert.equal(run.summaryHistory.records.length, 1);
    assert.equal(run.summaryHistory.records[0].threadId, adapter.getRun(task.runId).threadId);
    assert.equal(run.summaryInspection, undefined);
    const state = await f.state();
    const thread = state.threads.find(thread => thread.id === run.threadId);
    assert.deepEqual(thread.dynamicTools.map(tool => tool.name), ["qingdan_report_result", "qingdan_read_project_history"]);
    const start = state.calls.filter(call => call.method === "turn/start" && call.params.threadId === run.threadId).at(-1);
    assert.equal(JSON.parse(start.params.additionalContext.qingdan_project_evidence.value).mode, "codex_history");
    assert.equal(JSON.parse(start.params.additionalContext.qingdan_project_evidence.value).records, undefined);
    assert.equal(run.summaryHistoryRead.nextCursor, null);
    assert.equal(run.summaryHistoryRead.deliveredRecords, 1);
    assert.match(start.params.additionalContext.qingdan_task.value, /历史|任务总结/);
    assert.doesNotMatch(start.params.additionalContext.qingdan_task.value, /先使用 list|先调用 qingdan_inspect/);
    await adapter.close();
    const reopened = await f.open();
    assert.deepEqual(reopened.getRun(snapshot.runId).summaryHistory, run.summaryHistory);
    assert.deepEqual(reopened.getRun(snapshot.runId).summaryHistoryRead, run.summaryHistoryRead);
  });

  test("history tool delivers long records completely over RPC without a large additional context", async (t) => {
    const f = await fixture(t, "report");
    const text = "项目是离线清单管理。" + "已完成基础编辑，CSV 导出还未实现。😀".repeat(9000) + "末尾新增要求：保留撤销能力";
    await writeFile(f.statePath, JSON.stringify({ threads: [{ id: "source-long", cwd: f.workspace, name: "编辑与导出", turns: [{ id: "source-turn", status: "completed", completedAt: 10, items: [{ type: "agentMessage", id: "source-answer", phase: "final_answer", text }] }] }], calls: [] }));
    let adapter = await f.open();
    const snapshot = await f.snapshot("history-long", "summary");
    adapter = await legacyHistory(f, snapshot, "report", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 20000);
    assert.equal(run.resultValid, true, run.resultError);
    assert.equal(run.summaryHistory.records[0].text, text);
    assert.equal(run.summaryHistoryRead.deliveredRecords, 1);
    assert.ok(run.summaryHistoryRead.pagesRead > 10);
    const state = await f.state();
    const start = state.calls.find(c => c.method === "turn/start");
    assert.ok(Buffer.byteLength(JSON.stringify(start.params.additionalContext)) < 16000);
    const pages = state.threads.find(th => th.id === run.threadId).turns.at(-1).items.filter(i => i.tool === "qingdan_read_project_history");
    assert.equal(pages.length, run.summaryHistoryRead.pagesRead);
    const body = pages.map(p => {
      assert.equal(p.success, true);
      assert.ok(Buffer.byteLength(p.contentItems[0].text) <= 10000);
      return JSON.parse(p.contentItems[0].text).records.map(r => r.content).join("");
    }).join("");
    assert.equal(JSON.parse(body).text, text);
  });

  test("summary refuses a premature report while history pages remain unread", async (t) => {
    const f = await fixture(t, "report-history-unread");
    await writeFile(f.statePath, JSON.stringify({ threads: [{ id: "source", cwd: f.workspace, name: "需求", turns: [{ id: "t", status: "completed", items: [{ type: "agentMessage", id: "a", phase: "final_answer", text: "还有导出待实现" }] }] }], calls: [] }));
    let adapter = await f.open();
    const snapshot = await f.snapshot("history-unread", "summary");
    adapter = await legacyHistory(f, snapshot, "report-history-unread", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, false);
    const responses = (await f.state()).calls.filter(c => c.method === "server-response");
    assert.match(JSON.stringify(responses), /历史尚未读完/);
  });

  test("summary validates native coverage size before acknowledging the result", async (t) => {
    const f = await fixture(t, "report-history-limit");
    let adapter = await f.open();
    const snapshot = await f.snapshot("history-limit", "summary");
    adapter = await legacyHistory(f, snapshot, "report-history-limit", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, false);
    const replies = (await f.state()).calls.filter(c => c.method === "server-response");
    assert.match(JSON.stringify(replies), /报告过长/);
    assert.equal(replies.at(-1).params.result.success, false);
  });

  test("history result requires proof that the last page response was received", async (t) => {
    const f = await fixture(t, "report-history-no-receipt");
    await writeFile(f.statePath, JSON.stringify({ threads: [{ id: "source", cwd: f.workspace, name: "需求", turns: [{ id: "t", status: "completed", items: [{ type: "agentMessage", id: "a", phase: "final_answer", text: "撤销未实现" }] }] }], calls: [] }));
    let adapter = await f.open();
    const snapshot = await f.snapshot("no-history-receipt", "summary");
    adapter = await legacyHistory(f, snapshot, "report-history-no-receipt", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.summaryHistoryRead.nextCursor, null);
    assert.equal(run.resultValid, false);
    assert.match(JSON.stringify((await f.state()).calls), /末页回执/);
  });

  test("stopped summary rejects a later history page without advancing persisted read state", async (t) => {
    const f = await fixture(t, "report-history-unread");
    await writeFile(f.statePath, JSON.stringify({ threads: [{ id: "source", cwd: f.workspace, name: "需求", turns: [{ id: "t", status: "completed", items: [{ type: "agentMessage", id: "a", phase: "final_answer", text: "正文".repeat(16000) }] }] }], calls: [] }));
    let adapter = await f.open();
    const snapshot = await f.snapshot("history-stopped", "summary");
    adapter = await legacyHistory(f, snapshot, "report-history-unread", adapter);
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    const responses = [];
    const respond = adapter.client.respond.bind(adapter.client);
    adapter.client.respond = (_id, response) => responses.push(response);
    try {
      f.store.patchRun(run.runId, { terminal: false, active: true, cancelRequested: false });
      const packet = { id: "lost-page", method: "item/tool/call", params: { threadId: run.threadId, turnId: run.activeTurnId, tool: "qingdan_read_project_history", namespace: null, callId: "lost-page", arguments: {} } };
      adapter.receive(packet);
      assert.equal(responses[0].success, true);
      const saved = adapter.getRun(run.runId).summaryHistoryRead;
      assert.ok(saved.nextCursor);
      f.store.patchRun(run.runId, { cancelRequested: true });
      adapter.receive({ ...packet, id: "after-stop", params: { ...packet.params, callId: "after-stop", arguments: { cursor: saved.nextCursor } } });
      assert.equal(responses[1].success, false);
      assert.deepEqual(adapter.getRun(run.runId).summaryHistoryRead, saved);
    } finally { adapter.client.respond = respond; f.store.patchRun(run.runId, { terminal: true, active: false }); }
  });

  test("legacy summary tools read additional project files and persist their verifiable sources", async (t) => {
    const f = await fixture(t, "report-inspection");
    await mkdir(path.join(f.workspace, "docs/deep"), { recursive: true });
    await writeFile(path.join(f.workspace, "docs/deep/unfinished.ts"), "// TODO: finish Markdown export\n");
    await writeFile(path.join(f.workspace, "README.md"), "Project plan\n");
    const snapshot = await f.snapshot("inspect-summary", "summary");
    const adapter = await legacyInspection(f, snapshot, "report-inspection");
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, true);
    assert.equal(run.result.pending[0].evidenceRef, "docs/deep/unfinished.ts");
    assert.ok(run.summaryInspection.sources.some((source) => source.path === "README.md"));
    assert.ok(run.summaryInspection.sources.some((source) => source.path === "docs/deep/unfinished.ts"));
    const calls = (await f.state()).calls;
    const start = calls.find((call) => call.method === "thread/start").params;
    assert.equal(start.sandbox, "read-only");
    assert.ok((await f.state()).threads.find((thread) => thread.id === run.threadId).dynamicTools.some((tool) => tool.name === "qingdan_inspect_project"));
    const reportSchema = start.dynamicTools.find((tool) => tool.name === "qingdan_report_result").inputSchema;
    assert.ok(reportSchema.properties.pending.items.properties.evidenceRef);
    assert.ok(calls.filter((call) => call.method === "server-response").every((call) => call.params.result?.success));
    await adapter.close();
    const reopened = await f.open();
    assert.deepEqual(reopened.getRun(snapshot.runId).summaryInspection, run.summaryInspection);
  });

  test("disconnect during asynchronous project inspection preserves reconciliation without an unhandled response failure", async (t) => {
    const f = await fixture(t, "report-inspection-disconnect");
    for (let i = 0; i < 150; i++) await writeFile(path.join(f.workspace, `source-${i}.ts`), "export const value = 1;\n");
    const snapshot = await f.snapshot("disconnect-inspection", "summary");
    const adapter = await legacyInspection(f, snapshot, "report-inspection-disconnect");
    for (let i = 0; i < 100 && adapter.available; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(adapter.available, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.getRun(snapshot.runId).status, "reconciliation_required");
    assert.equal(adapter.getRun(snapshot.runId).resultValid, false);
  });

  test("a listed but unread file cannot become verified summary evidence", async (t) => {
    const f = await fixture(t, "report-inspection-unread");
    await mkdir(path.join(f.workspace, "docs/deep"), { recursive: true });
    await writeFile(path.join(f.workspace, "docs/deep/unfinished.ts"), "// TODO: verify me\n");
    const snapshot = await f.snapshot("unread-summary", "summary");
    const adapter = await legacyInspection(f, snapshot, "report-inspection-unread");
    const run = await adapter.waitForRun(snapshot.runId, 4000);
    assert.equal(run.resultValid, false);
    assert.ok((await f.state()).calls.some((call) => call.method === "server-response" && call.params.result?.success === false));
  });

  test("legacy summary continuation keeps evidence-only guidance when its original thread lacks inspection tools", async (t) => {
    const f = await fixture(t, "report");
    const adapter = await f.open();
    const snapshot = await f.snapshot("legacy-summary", "summary");
    await adapter.startFreshRun(snapshot);
    const first = await adapter.waitForRun(snapshot.runId, 4000);
    await adapter.close();
    const state = await f.state();
    state.threads.find((thread) => thread.id === first.threadId).dynamicTools = state.threads.find((thread) => thread.id === first.threadId).dynamicTools.filter((tool) => !["qingdan_inspect_project", "qingdan_read_project_history"].includes(tool.name));
    await writeFile(f.statePath, JSON.stringify(state));
    f.store.patchRun(snapshot.runId, { summaryHistory: undefined, summaryInspection: undefined, summaryEvidence: { cwd: f.workspace, capturedAt: snapshot.capturedAt, gitBaseline: snapshot.context.gitBaseline, files: [], inventory: [], omitted: [] } });
    const legacy = await f.open();
    await legacy.continueRun({ requestId: "legacy-summary-reply", runId: snapshot.runId, expectedTurnId: first.activeTurnId, mode: "reply", message: "根据原资料补充说明。" });
    const result = await legacy.waitForRun(snapshot.runId, 4000);
    assert.equal(result.resultValid, true);
    const calls = (await f.state()).calls;
    const instructions = calls.filter((call) => call.method === "thread/resume").at(-1).params.developerInstructions;
    assert.doesNotMatch(instructions, /qingdan_inspect_project/);
    assert.match(instructions, /资料包/);
    const context = calls.filter((call) => call.method === "turn/start").at(-1).params.additionalContext.qingdan_task.value;
    assert.doesNotMatch(context, /nextCursor|先使用 list/);
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
    assert.match(text, /^请按需读取当前项目/);
    assert.match(text, /项目交接报告/);
    assert.ok(start.additionalContext?.qingdan_task);
    for (const value of [
      "个人网站",
      "首页已有草稿",
      "使用中文文件名",
      "上一项已创建说明文档",
      "nextCursor",
      "历史",
      "待核实",
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

  test("normal standalone completion stops background terminals before another run can use the workspace", async (t) => {
    const f = await fixture(t, "batch-background"), adapter = await f.open();
    await adapter.startFreshRun(await f.snapshot());
    await adapter.waitForRun("run-a", 4000);
    assert.deepEqual((await f.state()).threads[0].terminals, []);
    assert.equal((await adapter.startFreshRun(await f.snapshot("run-b"))).status, "started");
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
