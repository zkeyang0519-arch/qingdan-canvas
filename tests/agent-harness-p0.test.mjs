import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore, digest } from "../runner/harness/task-store.mjs";
import { TaskRun } from "../runner/harness/coordinator.mjs";
import { assessPlan } from "../runner/harness/feasibility.mjs";
import { requirementProof, reconcileSteps } from "../runner/harness/proofs.mjs";
import {
  normalizeEvidence,
  canonicalRequirement,
} from "../runner/harness/evidence.mjs";
import { deliveryStep } from "../runner/harness/proofs.mjs";
import {
  observeBlockers,
  blockingFor,
  canResolve,
} from "../runner/harness/blockers.mjs";
import { modelIssue, interruptedRun } from "../shared/agent/model-issue.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import { openResponsesFixture } from "./fixtures/pi-local-responses.mjs";

const scope = {
  accountId: "pi-local",
  bindingId: "pi-local-binding",
  chatId: "p0",
  userMessageId: "u1",
  visible: [],
};
async function scratch(t) {
  const base = path.resolve(".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "harness-p0-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), base);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}
const input = (text) => ({ text, history: [], memories: [] });
const baseTask = () => ({
  id: "task",
  schemaVersion: 3,
  requirements: [],
  steps: [],
  questions: [],
  gaps: [],
  evidence: [],
  artifacts: [],
  blockers: [],
  plan: { status: "approved" },
});

test("真实模型误将 Codex 稿件标为生成提交时使用固定工具语义，交付稿件不是再次生成", () => {
  const requirement = canonicalRequirement({
    id: "draft",
    description: "取得 Codex 实际稿件",
    check: "tool_result",
    tool: "mcp__codex__codex",
    operation: "generation.submit",
  });
  assert.equal(requirement.operation, "draft.create");
  const task = baseTask();
  task.requirements = [requirement];
  task.evidence = [
    evidence(
      "mcp__codex__codex",
      { prompt: "雨夜" },
      { text: "雨停了，街灯把一地积水照成碎金。" },
      "draft",
    ),
  ];
  assert.equal(requirementProof(task, requirement, ["draft"]).accepted, true);
  assert.equal(
    deliveryStep({ description: "交付最终符合要求的旁白稿件" }),
    true,
  );
  assert.equal(
    deliveryStep({
      description: "交付最终符合要求的旁白稿件",
      operation: "draft.create",
    }),
    false,
  );
  const media = {
    ...requirement,
    check: "media_ready",
    operation: "generation.status",
  };
  assert.equal(
    requirementProof(task, canonicalRequirement(media), ["draft"]).accepted,
    false,
  );
});
function evidence(tool, args, data, id, readOnly = false) {
  return normalizeEvidence(
    tool,
    args,
    { structuredContent: data },
    { id, taskId: "task", callId: id, readOnly },
  );
}

test("工具目录缺少生成接口时，计划不可确认且不能绕去执行其他写操作", async (t) => {
  const store = new TaskStore(await scratch(t));
  const caps = {
    activeSpecs: () => [],
    assessPlan: (task) =>
      assessPlan(task, [
        { name: "mcp__waao__node_generate_check", state: "ready" },
      ]),
    authorize() {},
    readOnly: () => false,
  };
  let run = new TaskRun({
    store,
    scope,
    input: input("生成图片"),
    jobId: "plan",
    signal: new AbortController().signal,
    capabilities: caps,
    requirePlanConfirmation: true,
  });
  try {
    await run.control("update_task", {
      requirements: [
        {
          id: "image",
          description: "获得生成图片",
          check: "media_ready",
          tool: "mcp__waao__node_generate",
          operation: "generation.submit",
        },
      ],
      steps: [
        {
          id: "image",
          title: "生成图片",
          description: "提交生成图片",
          status: "pending",
        },
      ],
    });
    assert.equal(run.task.status, "blocked");
    assert.equal(run.task.plan.canConfirm, false);
    assert.equal(run.task.blockers[0].code, "CAPABILITY_UNAVAILABLE");
    let writes = 0;
    await assert.rejects(
      run.execute("mcp__waao__macro_create", {}, "unexpected", async () => {
        writes++;
      }),
      /没有经用户确认/,
    );
    assert.equal(writes, 0);
    const reply = { taskId: run.task.id, questionId: run.task.plan.questionId };
    run.close();
    assert.throws(
      () =>
        new TaskRun({
          store,
          scope: { ...scope, userMessageId: "u2", visible: ["u1"] },
          input: { ...input("确认"), taskReply: reply },
          jobId: "wrong-approval",
          signal: new AbortController().signal,
          capabilities: caps,
          requirePlanConfirmation: true,
        }),
      /能力或依赖/,
    );
  } finally {
    run.close();
    store.close();
  }
});

test("提交和完成查询可以共同证明同一图片，不能使用旧任务或无提交来源的结果", () => {
  const task = baseTask();
  const submit = evidence(
    "mcp__waao__node_generate",
    { node_id: "node-a" },
    { task_id: "job-a", node_id: "node-a", status: "submitted" },
    "submit",
  );
  const ready = evidence(
    "mcp__waao__task_get",
    { task_id: "job-a" },
    {
      task_id: "job-a",
      node_id: "node-a",
      status: "succeeded",
      asset_ids: ["image-a"],
    },
    "ready",
    true,
  );
  ready.sourceEvidenceId = submit.id;
  task.evidence = [submit, ready];
  const req = {
    id: "image",
    description: "拿到本次图片",
    check: "media_ready",
    tool: submit.label,
    operation: "generation.submit",
    resource: { node_id: "node-a" },
  };
  assert.equal(requirementProof(task, req, [ready.id]).accepted, true);
  ready.resource.task_id = "older-job";
  assert.equal(requirementProof(task, req, [ready.id]).accepted, false);
  ready.resource.task_id = "job-a";
  delete ready.sourceEvidenceId;
  assert.equal(requirementProof(task, req, [ready.id]).accepted, false);
});

test("等价宏路径仍需本次节点和真实生成快照，宏成功或积分成功不能证明图片完成", () => {
  const task = baseTask();
  const created = evidence(
    "mcp__waao__canvas_apply_changes",
    {
      canvas_id: "canvas",
      changes: [{ op: "create", ref: "image", data: { prompt: "采用稿" } }],
    },
    { created: [{ ref: "image", node_id: "node" }] },
    "created",
  );
  const ready = evidence(
    "mcp__waao__generation_get",
    { generation_id: "generation" },
    {
      generation_id: "generation",
      node_id: "node",
      status: "succeeded",
      asset_id: "image",
      prompt: "采用稿",
    },
    "ready",
    true,
  );
  task.evidence = [created, ready];
  task.artifacts = [{ id: "draft", text: "采用稿" }];
  task.steps = [
    {
      id: "image",
      requirementIds: ["image"],
      tools: ["mcp__waao__macro_run", "mcp__waao__generation_get"],
    },
  ];
  const req = {
    id: "image",
    description: "获得本次图片",
    check: "media_ready",
    tool: "mcp__waao__node_generate",
    operation: "generation.submit",
    resource: { node_id: "node" },
    inputArtifactId: "draft",
  };
  assert.equal(requirementProof(task, req, ["ready"]).accepted, true);
  ready.inputHash = digest("错误稿件");
  assert.equal(requirementProof(task, req, ["ready"]).accepted, false);
  const macro = evidence(
    "mcp__waao__macro_run_get",
    {},
    { status: "completed", run_id: "run", asset_id: "pretend" },
    "macro",
    true,
  );
  task.evidence.push(macro);
  assert.equal(requirementProof(task, req, ["macro"]).accepted, false);
});

test("步骤打勾由匹配的证据决定，模型的 done 和无关成功回执不足以完成节点创建", () => {
  const task = baseTask();
  task.requirements = [
    {
      id: "node",
      description: "新建节点并写入采用稿",
      check: "tool_result",
      operation: "node.create",
      tool: "mcp__waao__canvas_apply_changes",
      inputArtifactId: "draft",
    },
  ];
  task.steps = [
    {
      id: "node",
      description: "新建节点",
      status: "done",
      requirementIds: ["node"],
    },
  ];
  task.artifacts = [{ id: "draft", text: "采用稿" }];
  reconcileSteps(task);
  assert.equal(task.steps[0].status, "pending");
  const credit = evidence(
    "mcp__waao__credit_overview_get",
    {},
    { remaining: 100 },
    "credit",
    true,
  );
  credit.stepId = "node";
  task.evidence.push(credit);
  task.steps[0].status = "done";
  reconcileSteps(task);
  assert.notEqual(task.steps[0].status, "done");
  const created = evidence(
    "mcp__waao__canvas_apply_changes",
    { changes: [{ op: "create", ref: "n", data: { prompt: "采用稿" } }] },
    { created: [{ ref: "n", node_id: "node" }] },
    "node-result",
  );
  created.stepId = "node";
  task.evidence.push(created);
  reconcileSteps(task);
  assert.equal(task.steps[0].status, "done");
});

test("宏改版后阻塞依赖步骤，只有同一宏的已启用回执解除等待", () => {
  const task = baseTask();
  task.steps = [
    { id: "macro", status: "running" },
    { id: "image", status: "pending", dependsOn: ["macro"] },
    { id: "independent", status: "pending", dependsOn: [] },
  ];
  observeBlockers(
    task,
    "mcp__waao__macro_update",
    { macro_id: "m" },
    { structuredContent: { macro_id: "m", status: "pending", version: 2 } },
    "macro",
  );
  assert.ok(blockingFor(task, "image").length);
  assert.equal(blockingFor(task, "independent").length, 0);
  const block = task.blockers[0];
  assert.equal(
    canResolve(block, "mcp__waao__macro_run", { macro_id: "m" }, false),
    false,
  );
  assert.equal(
    canResolve(block, "mcp__waao__macro_get", { macro_id: "other" }, true),
    false,
  );
  observeBlockers(
    task,
    "mcp__waao__macro_get",
    { macro_id: "m" },
    { structuredContent: { macro_id: "m", status: "enabled", version: 1 } },
    "macro",
  );
  assert.equal(block.resolved, false);
  observeBlockers(
    task,
    "mcp__waao__macro_get",
    { macro_id: "m" },
    {
      structuredContent: {
        macro_id: "m",
        status: "enabled",
        version: 2,
        agent_runnable: true,
      },
    },
    "macro",
  );
  assert.equal(block.resolved, true);
});

test("模型余额、限流、上下文问题和运行超时有独立原因", () => {
  const balance = modelIssue(
    {
      status: 402,
      body: '{"message":"Insufficient Balance","api_key":"secret"}',
    },
    { service: "DeepSeek", model: "test" },
  );
  assert.equal(balance.code, "MODEL_BALANCE_INSUFFICIENT");
  assert.equal(balance.retryable, false);
  assert.doesNotMatch(JSON.stringify(balance), /secret/);
  assert.equal(modelIssue({ status: 429 }).retryable, true);
  assert.equal(
    modelIssue({ message: "maximum context length exceeded" }).code,
    "MODEL_CONTEXT_TOO_LARGE",
  );
  assert.equal(
    interruptedRun({ reason: { name: "TimeoutError" } }).code,
    "RUN_TIMEOUT",
  );
});

test("真实 Pi 收到 402 后只发一次模型请求，任务卡保留准确错误而非完整回复提示", async (t) => {
  const dir = await scratch(t);
  const server = await openResponsesFixture(() => ({
    httpStatus: 402,
    message: "Insufficient Balance",
    code: "insufficient_balance_error",
  }));
  let pi;
  try {
    pi = await openPiChat({
      directory: dir,
      settings: server.settings,
      tools: { references: () => [] },
      taskHarness: true,
      requirePlanConfirmation: true,
    });
    const res = await pi.fetch(
      new Request("https://pi.internal/turn", {
        method: "POST",
        body: JSON.stringify({
          jobId: randomUUID(),
          sessionId: randomUUID(),
          scope,
          input: input("你好"),
        }),
      }),
    );
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.match(data.error, /余额不足/);
    assert.equal(server.requests.length, 1);
    assert.equal(pi.task(scope).status, "waiting_model");
    assert.equal(pi.task(scope).failure.code, "MODEL_BALANCE_INSUFFICIENT");
  } finally {
    await pi?.close();
    await server.close();
  }
});
