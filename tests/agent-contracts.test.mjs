import test from "node:test";
import assert from "node:assert/strict";
import { projectItems } from "./fixtures/project-execution.mjs";
import {
  loadAgentModules,
  makeTask,
  makeCreatePlan,
  makeRunnerEvent,
  makeOutcome,
  makeCommandEnvelope,
  makeSnapshot,
} from "./fixtures/agent-fixtures.mjs";

let rules;
try {
  rules = await loadAgentModules();
} catch (error) {
  test("Agent task contracts are implemented", () =>
    assert.fail(error.message));
}

if (rules) {
  const {
    parseAgentCommand,
    parseRunnerEvent,
    parseRunOutcome,
    parseCommandEnvelope,
    parseExecutionSnapshot,
    manualIntentSchema,
    executionReportSchema,
  } = rules;

  test("project execution requires source tasks and keeps them separate from sequential batches", () => {
    const request = {
      requestId: "project-request", bindingId: "binding-a", bindingRevision: 1,
      kind: "task", executionMode: "project",
      sourceTasks: projectItems().map(({ source }) => ({ noteId: source.taskRef.noteId, taskId: source.taskRef.taskId, generation: source.generation, specRevision: source.specRevision })),
    };
    assert.equal(manualIntentSchema.parse(request).executionMode, "project");
    for (const invalid of [
      { ...request, kind: "summary" },
      { ...request, sourceTasks: undefined, instruction: "do one thing" },
      { ...request, sourceTasks: undefined, items: [{ instruction: "do one thing" }] },
      { ...request, autoComplete: true },
    ]) assert.equal(manualIntentSchema.safeParse(invalid).success, false);
    const snapshot = makeSnapshot({ executionMode: "project", projectTasks: projectItems("canvas-a") });
    assert.deepEqual(parseExecutionSnapshot(snapshot).projectTasks, snapshot.projectTasks);
    for (const invalid of [
      { ...snapshot, projectTasks: undefined },
      { ...snapshot, executionMode: undefined },
      { ...snapshot, batch: { items: snapshot.projectTasks } },
      { ...snapshot, projectTasks: [{ ...snapshot.projectTasks[0], source: undefined }] },
      { ...snapshot, projectTasks: projectItems("other-canvas") },
      { ...snapshot, projectTasks: [snapshot.projectTasks[0], snapshot.projectTasks[0]] },
    ]) assert.throws(() => parseExecutionSnapshot(invalid), { code: "VALIDATION_ERROR" });
  });

  test("a plan preserves distinct IDs with identical task text and normalizes offset dates", () => {
    const input = makeCreatePlan([
      makeTask("a", { dueAt: "2026-11-03T10:00:00+08:00" }),
      makeTask("b"),
    ]);
    const before = structuredClone(input);
    const result = parseAgentCommand(input);
    assert.deepEqual(
      result.tasks.map((t) => t.taskId),
      ["a", "b"],
    );
    assert.equal(result.tasks[0].dueAt, "2026-11-03T02:00:00.000Z");
    assert.deepEqual(input, before);
  });

  test("a plan accepts 50 tasks and rejects an empty plan or the 51st task", () => {
    assert.equal(
      parseAgentCommand(
        makeCreatePlan(Array.from({ length: 50 }, (_, i) => makeTask(`t${i}`))),
      ).tasks.length,
      50,
    );
    assert.throws(() => parseAgentCommand(makeCreatePlan([])), {
      code: "VALIDATION_ERROR",
    });
    assert.throws(
      () =>
        parseAgentCommand(
          makeCreatePlan(
            Array.from({ length: 51 }, (_, i) => makeTask(`t${i}`)),
          ),
        ),
      { code: "LIMIT_EXCEEDED" },
    );
  });

  test("plans reject duplicate IDs, missing dependencies and dependency cycles before acceptance", () => {
    assert.throws(
      () => parseAgentCommand(makeCreatePlan([makeTask("a"), makeTask("a")])),
      { code: "DUPLICATE_TASK_ID" },
    );
    assert.throws(
      () =>
        parseAgentCommand(
          makeCreatePlan([makeTask("a", { dependsOn: ["missing"] })]),
        ),
      { code: "DEPENDENCY_MISSING" },
    );
    assert.throws(
      () =>
        parseAgentCommand(
          makeCreatePlan([
            makeTask("a", { dependsOn: ["b"] }),
            makeTask("b", { dependsOn: ["a"] }),
          ]),
        ),
      { code: "DEPENDENCY_CYCLE" },
    );
  });

  test("task requirements, required acceptance and unique criterion IDs cannot be omitted", () => {
    for (const changes of [
      { text: " " },
      { instruction: "\n" },
      { acceptance: [] },
      {
        acceptance: [
          {
            id: "check",
            description: "Confirm",
            kind: "human",
            required: false,
          },
        ],
      },
      { acceptance: [makeTask().acceptance[0], makeTask().acceptance[0]] },
      { priority: -1 },
      { priority: 4 },
      { priority: 1.5 },
      { dependsOn: ["b", "b"] },
    ])
      assert.throws(
        () =>
          parseAgentCommand(
            makeCreatePlan([makeTask("a", changes), makeTask("b")]),
          ),
        { code: "VALIDATION_ERROR" },
      );
  });

  test("model input cannot smuggle identity, execution permissions, paths or completion state", () => {
    for (const field of [
      "actor",
      "ownerId",
      "cwd",
      "workspaceId",
      "authEpoch",
      "shell",
      "permission",
    ]) {
      assert.throws(
        () => parseAgentCommand({ ...makeCreatePlan(), [field]: "forged" }),
        { code: "VALIDATION_ERROR" },
      );
      assert.throws(
        () =>
          parseAgentCommand(
            makeCreatePlan([makeTask("a", { [field]: "forged" })]),
          ),
        { code: "VALIDATION_ERROR" },
      );
    }
    assert.throws(
      () => parseAgentCommand(makeCreatePlan([makeTask("a", { done: true })])),
      { code: "VALIDATION_ERROR" },
    );
  });

  test("acceptance supports registered commands, artifacts and human review", () => {
    const acceptance = [
      {
        id: "command",
        kind: "command",
        description: "测试通过",
        required: true,
        checkId: "test",
      },
      {
        id: "exists",
        kind: "artifact",
        description: "报告存在",
        required: true,
        relativePath: "reports/result.md",
        predicate: { type: "exists" },
      },
      {
        id: "json",
        kind: "artifact",
        description: "JSON 结构",
        required: true,
        relativePath: "out/result.json",
        predicate: {
          type: "jsonSchema",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      },
      {
        id: "text",
        kind: "artifact",
        description: "包含结果",
        required: false,
        relativePath: "out/result.txt",
        predicate: { type: "textContains", text: "success" },
      },
      ...makeTask().acceptance,
    ];
    assert.deepEqual(
      parseAgentCommand(makeCreatePlan([makeTask("a", { acceptance })]))
        .tasks[0].acceptance,
      acceptance,
    );
    assert.throws(
      () =>
        parseAgentCommand(
          makeCreatePlan([
            makeTask("a", {
              acceptance: [{ ...acceptance[0], command: "npm test" }],
            }),
          ]),
        ),
      { code: "VALIDATION_ERROR" },
    );
  });

  test("artifact requirements reject absolute paths, traversal and Windows special paths", () => {
    for (const relativePath of [
      "../secret",
      "out/../../secret",
      "out\\..\\secret",
      "D:\\secret",
      "/etc/passwd",
      "\\\\server\\share",
      "out/file:stream",
      "out/NUL.txt",
      "out/file. ",
      "out//file",
      "out/./file",
    ]) {
      assert.throws(
        () =>
          parseAgentCommand(
            makeCreatePlan([
              makeTask("a", {
                acceptance: [
                  {
                    id: "file",
                    kind: "artifact",
                    description: "Check file",
                    required: true,
                    relativePath,
                    predicate: { type: "exists" },
                  },
                ],
              }),
            ]),
          ),
        { code: "VALIDATION_ERROR" },
      );
    }
  });

  test("dates require a real calendar date with a timezone", () => {
    for (const dueAt of [
      "2026-11-03T10:00:00",
      "2026-02-30T00:00:00Z",
      "tomorrow",
      "2026-11-03",
      "2026-11-03T24:00:00Z",
    ]) {
      assert.throws(
        () => parseAgentCommand(makeCreatePlan([makeTask("a", { dueAt })])),
        { code: "VALIDATION_ERROR" },
      );
    }
  });

  test("manual order commands require a revision and reject repeated task IDs", () => {
    const input = {
      type: "reorder_plan",
      requestId: "r",
      planId: "p",
      expectedRevision: 3,
      order: ["b", "a"],
    };
    assert.deepEqual(parseAgentCommand(input), input);
    assert.throws(() => parseAgentCommand({ ...input, expectedRevision: -1 }), {
      code: "VALIDATION_ERROR",
    });
    assert.throws(() => parseAgentCommand({ ...input, order: ["a", "a"] }), {
      code: "VALIDATION_ERROR",
    });
  });

  test("execution envelopes accept only protocol 1 and bind payload identity and validity window", () => {
    assert.deepEqual(
      parseCommandEnvelope(makeCommandEnvelope()),
      makeCommandEnvelope(),
    );
    for (const extra of [
      { protocolVersion: 2 },
      { protocolVersion: "1" },
      { cwd: "D:/secret" },
      { expiresAt: "2026-11-03T01:59:59.000Z" },
      { runId: "other-run" },
      { bindingRevision: 2 },
      { payloadHash: "not-a-hash" },
      { leaseEpoch: 0 },
    ]) {
      assert.throws(() => parseCommandEnvelope(makeCommandEnvelope(extra)), {
        code: "VALIDATION_ERROR",
      });
    }
    const envelope = makeCommandEnvelope();
    assert.throws(
      () =>
        parseCommandEnvelope({
          ...envelope,
          payload: { ...envelope.payload, actor: "forged" },
        }),
      { code: "VALIDATION_ERROR" },
    );
  });

  test("command deduplication hashes and referenced snapshot hashes are independent", () => {
    const envelope = makeCommandEnvelope({ payloadHash: "b".repeat(64) });
    const parsed = parseCommandEnvelope(envelope);
    assert.equal(parsed.payloadHash, "b".repeat(64));
    assert.equal(parsed.payload.payloadHash, "a".repeat(64));
  });

  test("runner events validate event-specific payloads, identities, sequence and protocol", () => {
    assert.deepEqual(parseRunnerEvent(makeRunnerEvent()), makeRunnerEvent());
    for (const extra of [
      { protocolVersion: 0 },
      { seq: 0 },
      { seq: 1.5 },
      { type: "unknown" },
      { turnId: null },
      { threadId: null },
      { runId: "other-run" },
      { payload: { status: "completed", done: true } },
    ]) {
      assert.throws(() => parseRunnerEvent(makeRunnerEvent(extra)), {
        code: "VALIDATION_ERROR",
      });
    }
    assert.throws(
      () =>
        parseRunnerEvent(
          makeRunnerEvent({
            payload: {
              status: "failed",
              outcome: makeOutcome(),
              summary: null,
              error: "failed",
            },
          }),
        ),
      { code: "VALIDATION_ERROR" },
    );
  });

  test("valid runner event variants preserve status rather than inventing success", () => {
    const variants = [
      {
        type: "run.accepted",
        threadId: null,
        turnId: null,
        payload: { status: "queued" },
      },
      { type: "thread.created", turnId: null, payload: {} },
      { type: "turn.started", payload: {} },
      { type: "output.delta", payload: { text: "working" } },
      {
        type: "approval.requested",
        payload: { requestId: "approval-a", description: "需要审批" },
      },
      {
        type: "input.requested",
        payload: {
          requestId: "input-a",
          questions: [{ id: "q", prompt: "选择目标" }],
        },
      },
      {
        type: "turn.completed",
        payload: {
          status: "interrupted",
          outcome: null,
          summary: null,
          error: null,
        },
      },
      {
        type: "verification.completed",
        payload: {
          results: [
            { criterionId: "check-a", status: "needs_input", evidenceRefs: [] },
          ],
        },
      },
      { type: "run.cancelled", payload: { reason: "用户停止" } },
      { type: "heartbeat", payload: { leaseEpoch: 1, connectionEpoch: 1 } },
    ];
    for (const variant of variants)
      assert.equal(
        parseRunnerEvent(makeRunnerEvent(variant)).type,
        variant.type,
      );
  });

  test("run outcomes require structured results and cannot claim done with unresolved issues", () => {
    assert.deepEqual(parseRunOutcome(makeOutcome()), makeOutcome());
    assert.equal(
      parseRunOutcome(
        makeOutcome({ outcome: "blocked", remainingIssues: ["需要配置"] }),
      ).outcome,
      "blocked",
    );
    for (const value of [
      "done",
      { ...makeOutcome(), outcome: "success" },
      { ...makeOutcome(), remainingIssues: ["未完成"] },
      { ...makeOutcome(), changedFiles: ["../escape"] },
      { ...makeOutcome(), ownerId: "forged" },
    ]) {
      assert.throws(() => parseRunOutcome(value), { code: "VALIDATION_ERROR" });
    }
  });

  test("execution snapshots distinguish read-only summaries and ready task specifications", () => {
    const snapshot = makeSnapshot();
    assert.deepEqual(parseExecutionSnapshot(snapshot), snapshot);
    assert.equal(
      parseExecutionSnapshot(makeSnapshot({ kind: "summary", task: null }))
        .task,
      null,
    );
    for (const value of [
      makeSnapshot({ kind: "summary" }),
      makeSnapshot({ task: null }),
      makeSnapshot({ cwd: "D:/secret" }),
      makeSnapshot({ task: { ...snapshot.task, specStatus: "stale" } }),
    ]) {
      assert.throws(() => parseExecutionSnapshot(value), {
        code: "VALIDATION_ERROR",
      });
    }
  });

  test("execution permissions require consistent network access and never elevate summaries", () => {
    for (const profile of ["read_only", "workspace_manual", "workspace_auto", "full_access"]) {
      const executionPermissions = { profile, network: profile === "full_access" };
      assert.deepEqual(parseExecutionSnapshot(makeSnapshot({ executionPermissions })).executionPermissions, executionPermissions);
      assert.throws(() => parseExecutionSnapshot(makeSnapshot({ executionPermissions: { ...executionPermissions, network: !executionPermissions.network } })), { code: "VALIDATION_ERROR" });
      const summary = makeSnapshot({ kind: "summary", task: null, executionPermissions });
      if (profile === "read_only") assert.deepEqual(parseExecutionSnapshot(summary).executionPermissions, executionPermissions);
      else assert.throws(() => parseExecutionSnapshot(summary), { code: "VALIDATION_ERROR" });
    }
    assert.equal(parseExecutionSnapshot(makeSnapshot()).executionPermissions, undefined, "old snapshots must not acquire the new default");
  });

  test("batch snapshots preserve order, bind the first item, and validate all criteria", () => {
    const snapshot = makeSnapshot();
    const { text, instruction, acceptance, taskRef } = snapshot.task;
    const first = { taskId: taskRef.taskId, text, instruction, acceptance };
    const second = { ...first, taskId: "task-b", text: "第二条任务" };
    const batch = (items) => ({ ...snapshot, batch: { items } });

    assert.deepEqual(
      parseExecutionSnapshot(batch([first, second])).batch.items,
      [first, second],
    );
    assert.equal(
      parseExecutionSnapshot(
        batch(
          Array.from({ length: 50 }, (_, i) =>
            i === 0 ? first : { ...second, taskId: `task-${i}` },
          ),
        ),
      ).batch.items.length,
      50,
    );
    for (const invalid of [
      batch([]),
      batch([second, first]),
      batch([first, first]),
      batch([{ ...first, text: "另一个任务" }]),
      batch([{ ...first, instruction: "另一个指令" }]),
      batch([
        {
          ...first,
          acceptance: second.acceptance.map((c) => ({
            ...c,
            description: "另一个验收标准",
          })),
        },
      ]),
      batch([
        first,
        {
          ...second,
          acceptance: [
            {
              ...acceptance[0],
              kind: "command",
              checkId: "unregistered",
            },
          ],
        },
      ]),
      batch([
        first,
        ...Array.from({ length: 50 }, (_, i) => ({
          ...second,
          taskId: `task-${i}`,
        })),
      ]),
      { ...batch([first]), kind: "summary", task: null },
    ]) {
      assert.throws(() => parseExecutionSnapshot(invalid), {
        code: "VALIDATION_ERROR",
      });
    }
  });

  test("checklist intent accepts ordered source revisions and keeps manual inputs separate", () => {
    const sourceTasks = [
      { noteId: "note-b", taskId: "task-b", generation: 2, specRevision: 4 },
      { noteId: "note-a", taskId: "task-a", generation: 1, specRevision: 1 },
    ];
    const request = {
      requestId: "request-a",
      bindingId: "binding-a",
      bindingRevision: 1,
      kind: "task",
      sourceTasks,
      autoComplete: true,
    };
    assert.deepEqual(manualIntentSchema.parse(request), request);
    for (const invalid of [
      { ...request, kind: "summary" },
      { ...request, instruction: "另一个任务" },
      { ...request, items: [{ instruction: "另一个任务" }] },
      { ...request, sourceTasks: undefined, instruction: "单条任务" },
      { ...request, sourceTasks: [sourceTasks[0], sourceTasks[0]] },
      { ...request, sourceTasks: [{ ...sourceTasks[0], generation: 0 }] },
      { ...request, sourceTasks: [{ ...sourceTasks[0], specRevision: 0 }] },
    ]) {
      assert.equal(manualIntentSchema.safeParse(invalid).success, false);
    }
  });

  test("automatic completion snapshots bind each checklist source to its item", () => {
    const snapshot = makeSnapshot();
    const { text, instruction, acceptance, taskRef, specRevision } =
      snapshot.task;
    const item = {
      taskId: taskRef.taskId,
      text,
      instruction,
      acceptance,
      source: { taskRef, generation: 2, specRevision },
    };
    const batch = (...items) => ({
      ...snapshot,
      batch: { items, autoComplete: true },
    });
    assert.deepEqual(
      parseExecutionSnapshot(batch(item)).batch,
      batch(item).batch,
    );
    for (const invalid of [
      batch({ ...item, source: undefined }),
      batch({
        ...item,
        source: { ...item.source, taskRef: { ...taskRef, taskId: "other" } },
      }),
      batch({
        ...item,
        source: { ...item.source, taskRef: { ...taskRef, noteId: "other" } },
      }),
    ]) {
      assert.throws(() => parseExecutionSnapshot(invalid), {
        code: "VALIDATION_ERROR",
      });
    }
  });

  test("Runner may report a completed turn proof but cannot report canvas writeback", () => {
    const item = {
      taskId: "task-a",
      text: "任务",
      status: "done",
      summary: "已完成",
      completedTurnId: "turn-a",
    };
    const report = (item) => ({
      connectionEpoch: 1,
      runId: "run-a",
      commandId: "command-a",
      revision: 1,
      status: "verifying",
      threadId: "thread-a",
      turnId: "turn-a",
      terminal: true,
      stopConfirmed: true,
      batch: { currentIndex: 0, items: [item] },
    });
    assert.deepEqual(executionReportSchema.parse(report(item)), report(item));
    assert.equal(
      executionReportSchema.safeParse(report({ ...item, status: "failed" }))
        .success,
      false,
    );
    assert.equal(
      executionReportSchema.safeParse(
        report({ ...item, writeback: { status: "applied" } }),
      ).success,
      false,
    );
  });
}
