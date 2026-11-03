import test from "node:test";
import assert from "node:assert/strict";
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
  } = rules;

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
}
