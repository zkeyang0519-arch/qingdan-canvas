import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore } from "../runner/harness/task-store.mjs";
import { TaskRun } from "../runner/harness/coordinator.mjs";
import { HarnessCapabilities } from "../scripts/pi-local/harness-capabilities.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import {
  normalizeEvidence,
  attachEvidenceOrigin,
} from "../runner/harness/evidence.mjs";
import { requirementProof } from "../runner/harness/proofs.mjs";
import {
  estimateTokens,
  packMessages,
  compactControlMessages,
} from "../runner/harness/context-pack.mjs";
import { taskCard } from "../runner/harness/verification.mjs";
import {
  openResponsesFixture,
  callItem,
} from "./fixtures/pi-local-responses.mjs";

const baseScope = {
  accountId: "pi-local",
  bindingId: "pi-local-binding",
  chatId: "efficient",
  userMessageId: "u1",
  visible: [],
  memoryEpoch: 0,
  projectSource: { revision: 1 },
};
const input = (text, taskReply) => ({
  text,
  taskReply,
  history: [],
  memories: [],
});
async function scratch(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "harness-efficient-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), root);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (!fn() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), "等待实际状态转换超时");
}
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function fakeMcp(specs, execute) {
  let revision = 0,
    turns = 0;
  const mcp = {
    readyForTurn: async () => {},
    list: () =>
      [...new Set(specs.map((s) => s.name.split("__")[1]))].map((kind) => ({
        id: kind,
        kind,
        name: kind,
        status: "ready",
        enabled: true,
        serviceRevision: revision,
        selected: specs
          .filter((s) => s.name.split("__")[1] === kind)
          .map((s) => s.name.split("__")[2]),
        tools: specs
          .filter((s) => s.name.split("__")[1] === kind)
          .map((s) => ({ ...s, name: s.name.split("__")[2] })),
      })),
    turn() {
      turns++;
      const grant = revision;
      return {
        specs,
        authorize() {
          if (grant !== revision) throw Error("授权已变化");
        },
        readOnly: (name) => /_get$|_lookup$/.test(name),
        close: async () => {},
        execute: async (...args) => {
          if (grant !== revision) throw Error("授权已变化");
          return execute(...args);
        },
      };
    },
    revoke() {
      revision++;
    },
    get turns() {
      return turns;
    },
  };
  return mcp;
}
const draftName = "mcp__codex__codex",
  createName = "mcp__waao__canvas_apply_changes",
  generateName = "mcp__waao__node_generate",
  statusName = "mcp__waao__task_get";
const imageSpecs = [
  {
    name: draftName,
    description: "撰写提示词",
    parameters: object({ prompt: { type: "string" } }, ["prompt"]),
  },
  {
    name: createName,
    description: "新建图片节点",
    parameters: object(
      {
        canvas_id: { type: "string" },
        changes: { type: "array", items: { type: "object" } },
      },
      ["canvas_id", "changes"],
    ),
  },
  {
    name: generateName,
    description: "提交图片生成",
    parameters: object({ node_id: { type: "string" } }, ["node_id"]),
  },
  {
    name: statusName,
    description: "查询原生成任务",
    parameters: object({ task_id: { type: "string" } }, ["task_id"]),
  },
];
function imagePlan() {
  return {
    goal: "根据真实稿件新建节点并交付图片",
    requirements: [
      {
        id: "draft",
        description: "取得实际提示词稿件",
        check: "tool_result",
        tool: draftName,
        operation: "draft.create",
      },
      {
        id: "node",
        description: "用采用稿新建图片节点",
        check: "tool_result",
        tool: createName,
        operation: "node.create",
      },
      {
        id: "image",
        description: "本次图片生成就绪",
        check: "media_ready",
        tool: generateName,
        operation: "generation.submit",
      },
    ],
    steps: [
      {
        id: "draft",
        title: "撰写提示词",
        description: "取得实际提示词稿件",
        status: "pending",
        requirementIds: ["draft"],
        dependsOn: [],
        execution: { tool: draftName, args: { prompt: "雨夜街道" } },
      },
      {
        id: "node",
        title: "新建图片节点",
        description: "用采用稿新建图片节点",
        status: "pending",
        requirementIds: ["node"],
        dependsOn: ["draft"],
        execution: {
          tool: createName,
          args: {
            canvas_id: "canvas",
            changes: [
              {
                op: "create",
                ref: "image",
                data: { prompt: { $step: "draft", path: ["text"] } },
              },
            ],
          },
        },
      },
      {
        id: "generate",
        title: "提交生成",
        description: "提交图片生成",
        status: "pending",
        operation: "generation.submit",
        requirementIds: ["image"],
        dependsOn: ["node"],
        execution: {
          tool: generateName,
          args: { node_id: { $step: "node", path: ["created", 0, "node_id"] } },
        },
      },
      {
        id: "ready",
        title: "核对图片",
        description: "等待图片就绪",
        status: "pending",
        operation: "generation.status",
        requirementIds: ["image"],
        dependsOn: ["generate"],
        tools: [statusName],
      },
    ],
  };
}
function turn(chat, scope, text, taskReply) {
  return chat.fetch(
    new Request("https://pi.internal/turn", {
      method: "POST",
      body: JSON.stringify({
        jobId: randomUUID(),
        sessionId: randomUUID(),
        scope,
        input: input(text, taskReply),
      }),
    }),
  );
}

test(
  "真实 Pi 只规划一次，确认后宿主执行固定步骤并轮询交付，累计预算仍不限",
  { timeout: 25000 },
  async (t) => {
    const dir = await scratch(t);
    const prompt = '雨后街灯，中文、引号 " 与换行\n均按原稿采用。';
    const calls = [];
    let polls = 0;
    const mcp = fakeMcp(imageSpecs, async (name, args) => {
      calls.push({ name, args });
      if (name === draftName) return { structuredContent: { text: prompt } };
      if (name === createName) {
        assert.equal(args.changes[0].data.prompt, prompt);
        return {
          structuredContent: {
            created: [{ ref: "image", node_id: "new-node" }],
          },
        };
      }
      if (name === generateName)
        return {
          structuredContent: {
            task_id: "one-job",
            node_id: args.node_id,
            status: "queued",
          },
        };
      assert.equal(args.task_id, "one-job");
      return {
        structuredContent: {
          task_id: "one-job",
          node_id: "new-node",
          status: ++polls >= 3 ? "succeeded" : "running",
          ...(polls >= 3 && {
            asset_id: "image",
            media_url: "https://example.test/result.png",
          }),
        },
      };
    });
    const fixture = await openResponsesFixture((_request, n) => {
      assert.equal(n, 1, "固定执行与等待不应请求主模型");
      return callItem("update_task", imagePlan());
    });
    const chat = await openPiChat({
      directory: dir,
      settings: fixture.settings,
      mcp,
      tools: { references: () => [] },
      taskHarness: true,
      requirePlanConfirmation: true,
      preloadSelected: true,
      externalPollMs: 30,
    });
    try {
      assert.equal((await turn(chat, baseScope, "生成雨夜图片")).status, 200);
      const planned = chat.task(baseScope);
      assert.equal(planned.plan.canConfirm, true);
      assert.equal(calls.length, 0);
      const scope = { ...baseScope, userMessageId: "u2", visible: ["u1"] };
      const response = await turn(chat, scope, "确认并开始", {
        taskId: planned.id,
        questionId: planned.plan.questionId,
      });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      await until(() => chat.task(scope).status === "completed");
      const card = chat.task(scope);
      assert.equal(fixture.requests.length, 1);
      assert.equal(calls.filter((c) => c.name === generateName).length, 1);
      assert.equal(polls, 3);
      assert.ok(card.steps.every((s) => s.status === "done"));
      assert.equal(card.budget.maxRequests, null);
      assert.equal(card.budget.maxTokens, null);
      assert.match(card.result, /result\.png/);
      assert.match(card.result, /雨后街灯/);
      assert.equal(
        card.steps.some((s) => s.execution),
        false,
        "任务卡不重复传输内部参数",
      );
    } finally {
      await chat.close();
      await fixture.close();
    }
  },
);

test("长时间轮询始终绑定原提交，其他服务和旧任务不能借用这份来源", () => {
  const task = {
    id: "t",
    schemaVersion: 3,
    steps: [],
    artifacts: [],
    evidence: [],
    requirements: [],
  };
  const add = (name, args, data, id) => {
    const e = normalizeEvidence(
      name,
      args,
      { structuredContent: data },
      { id, taskId: "t", readOnly: true },
    );
    attachEvidenceOrigin(task, e);
    task.evidence.push(e);
    return e;
  };
  add(
    generateName,
    { node_id: "n" },
    { task_id: "job", node_id: "n" },
    "submit",
  );
  let ready;
  for (let i = 0; i < 150; i++)
    ready = add(
      statusName,
      { task_id: "job" },
      {
        task_id: "job",
        status: i === 149 ? "succeeded" : "running",
        ...(i === 149 && { asset_id: "image" }),
      },
      "poll-" + i,
    );
  assert.equal(ready.sourceEvidenceId, "submit");
  const requirement = {
    id: "image",
    check: "media_ready",
    tool: generateName,
    description: "本次图片",
  };
  assert.ok(requirementProof(task, requirement, [ready.id]).accepted);
  const wrong = add(
    "mcp__foreign__task_get",
    { task_id: "job" },
    { task_id: "job", status: "succeeded", asset_id: "image" },
    "foreign",
  );
  assert.equal(wrong.sourceEvidenceId, undefined);
  assert.equal(requirementProof(task, requirement, [wrong.id]).accepted, false);
  const old = add(
    statusName,
    { task_id: "old-job" },
    {
      task_id: "old-job",
      node_id: "n",
      status: "succeeded",
      asset_id: "old-image",
    },
    "old",
  );
  assert.equal(requirementProof(task, requirement, [old.id]).accepted, false);
});

test("发现即加载、工具定义按小批次复用，缓存句柄不能绕过撤销", async (t) => {
  const specs = Array.from({ length: 156 }, (_, i) => ({
    name: "mcp__waao__tool_" + i,
    description: "图片工具 " + i,
    parameters: object({
      value: { type: "string", description: "参数说明".repeat(200) },
    }),
  }));
  let calls = 0;
  const mcp = fakeMcp(specs, async () => {
    calls++;
    return {};
  });
  const caps = new HarnessCapabilities(mcp, baseScope, []);
  try {
    const found = await caps.discover("tool_0");
    assert.ok(found.capabilities.some((c) => c.loaded));
    const loaded = found.capabilities.find((c) => c.loaded).name;
    const turns = mcp.turns;
    await caps.request(loaded);
    await caps.request(loaded);
    assert.equal(mcp.turns, turns);
    for (let i = 0; i < specs.length; i++) await caps.request(specs[i].name);
    assert.ok(caps.activeSpecs().length <= 8);
    assert.ok(estimateTokens(caps.activeSpecs()) <= caps.maxSchemaTokens);
    assert.ok(estimateTokens(caps.activeSpecs()) < estimateTokens(specs) * 0.1);
    t.diagnostic(
      `156 项模拟目录定义：${estimateTokens(specs)} → ${estimateTokens(caps.activeSpecs())} 估算 token`,
    );
    mcp.revoke();
    await assert.rejects(
      caps.execute(
        specs.at(-1).name,
        {},
        "stale",
        new AbortController().signal,
      ),
      /授权已变化/,
    );
    assert.equal(calls, 0);
  } finally {
    await caps.close();
  }
});

test("工作上下文缩小但保留当前输入、完整工具对，完整原文仍可按任务读取", async (t) => {
  const store = new TaskStore(await scratch(t)),
    owner = "archive";
  store.claim(baseScope, owner);
  try {
    const state = store.create(baseScope, owner, "不要丢失原文", {
      maxRequests: null,
      maxTokens: null,
    });
    const messages = [
      {
        role: "user",
        content: "轻单保存的任务检查点：稿件在 artifact_draft，按编号读取。",
      },
    ];
    for (let n = 0; n < 20; n++)
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call" + n,
              name: "request_capability",
              arguments: { name: "tool" + n },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call" + n,
          toolName: "request_capability",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "ready",
                name: "tool" + n,
                parameters: { description: "长工具定义".repeat(400) },
              }),
            },
          ],
        },
      );
    const original = "精确原稿".repeat(12000);
    messages.push(
      { role: "user", content: "请沿用原稿，改为竖图。" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "last",
            name: "read_context",
            arguments: { id: "draft" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "last",
        toolName: "read_context",
        content: [{ type: "text", text: "已采用原稿，artifact_draft" }],
      },
    );
    store.archive(baseScope, owner, state.id, "u1", [
      ...messages,
      { role: "toolResult", content: [{ type: "text", text: original }] },
    ]);
    const packed = packMessages(compactControlMessages(messages), 64000, 12000);
    assert.ok(estimateTokens(packed) < estimateTokens(messages) * 0.2);
    assert.ok(JSON.stringify(packed).includes("请沿用原稿，改为竖图"));
    assert.ok(packed.some((m) => m.toolCallId === "last"));
    const row = store.archived(state.id, "精确原稿")[0];
    assert.equal(
      JSON.parse(store.readArchived(state.id, row.id)).content[0].text,
      original,
    );
    assert.equal(store.readArchived("different-task", row.id), null);
    const longInput = [{ role: "user", content: "重要输入".repeat(3500) }];
    assert.deepEqual(
      packMessages(longInput, 64000, 12000),
      longInput,
      "软目标不能裁掉可容纳的关键输入",
    );
    t.diagnostic(
      `重复定义模拟上下文：${estimateTokens(messages)} → ${estimateTokens(packed)} 估算 token，原文完整归档`,
    );
  } finally {
    store.release(baseScope, owner);
    store.close();
  }
});

test("用户改目标后不自动执行旧计划，未知投递与已成功的写操作不重发", async (t) => {
  const store = new TaskStore(await scratch(t));
  const mcp = fakeMcp(imageSpecs, async () => ({}));
  let caps = new HarnessCapabilities(mcp, baseScope, []);
  let run = new TaskRun({
    store,
    scope: baseScope,
    input: input("生成图片"),
    jobId: "first",
    signal: new AbortController().signal,
    capabilities: caps,
    requirePlanConfirmation: true,
  });
  try {
    await run.control("update_task", imagePlan());
    const reply = { taskId: run.task.id, questionId: run.task.plan.questionId };
    run.close();
    await caps.close();
    const scope = { ...baseScope, userMessageId: "u2", visible: ["u1"] };
    caps = new HarnessCapabilities(mcp, scope, []);
    run = new TaskRun({
      store,
      scope,
      input: input("确认", reply),
      jobId: "approved",
      signal: new AbortController().signal,
      capabilities: caps,
      requirePlanConfirmation: true,
    });
    await caps.request(draftName);
    let writes = 0;
    await run.execute(
      draftName,
      { prompt: "雨夜街道" },
      "first-write",
      async () => {
        writes++;
        return { structuredContent: { text: "实际稿件" } };
      },
    );
    await run.execute(
      draftName,
      { prompt: "雨夜街道" },
      "repeat-write",
      async () => {
        writes++;
      },
    );
    assert.equal(writes, 1);
    await caps.request(createName);
    const nodeArgs = {
      canvas_id: "canvas",
      changes: [{ op: "create", ref: "image", data: { prompt: "实际稿件" } }],
    };
    await assert.rejects(
      run.execute(createName, nodeArgs, "uncertain", async () => {
        writes++;
        throw Error("网络在写入后中断");
      }),
      /中断/,
    );
    await assert.rejects(
      run.execute(createName, nodeArgs, "uncertain-again", async () => {
        writes++;
      }),
      /投递结果尚未确认/,
    );
    assert.equal(writes, 2);
    run.close();
    await caps.close();
    const changed = {
      ...baseScope,
      userMessageId: "u3",
      visible: ["u1", "u2"],
    };
    caps = new HarnessCapabilities(mcp, changed, []);
    run = new TaskRun({
      store,
      scope: changed,
      input: input("改成白天，不要采用刚才的提示词"),
      jobId: "amend",
      signal: new AbortController().signal,
      capabilities: caps,
      requirePlanConfirmation: true,
    });
    assert.equal(
      await run.runPrepared(async () => {
        writes++;
      }),
      0,
    );
    assert.equal(writes, 2);
    assert.equal(run.task.budget.maxTokens, null);
  } finally {
    run.close();
    await caps.close();
    store.close();
  }
});

test(
  "真实 Pi 执行独立步骤时可接收问题回答，下一次上下文包含回答且不重启已完成操作",
  { timeout: 25000 },
  async (t) => {
    const dir = await scratch(t),
      lookup = "mcp__waao__account_get";
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let lookups = 0;
    const mcp = fakeMcp(
      [{ name: lookup, description: "查询资料", parameters: object() }],
      async () => {
        lookups++;
        await gate;
        return { structuredContent: { name: "测试活动" } };
      },
    );
    const plan = {
      goal: "查询活动资料并写文案",
      requirements: [
        {
          id: "read",
          description: "读取活动资料",
          check: "tool_result",
          tool: lookup,
          operation: "resource.read",
        },
        { id: "copy", description: "提供实际活动文案", check: "answer" },
      ],
      steps: [
        {
          id: "read",
          title: "读取资料",
          description: "读取活动资料",
          status: "pending",
          requirementIds: ["read"],
          dependsOn: [],
        },
        {
          id: "copy",
          title: "撰写活动文案",
          description: "提供实际活动文案",
          status: "pending",
          requirementIds: ["copy"],
          dependsOn: [],
        },
      ],
    };
    const fixture = await openResponsesFixture((req, n) => {
      if (n === 1) return callItem("update_task", plan, "plan");
      if (n === 2)
        return callItem(
          "ask_user",
          {
            question: "采用什么语气？",
            options: ["温暖", "克制"],
            reason: "影响文案表达",
            blocksStepIds: ["copy"],
          },
          "ask",
        );
      if (n === 3) return callItem(lookup, {}, "lookup");
      assert.equal(n, 4);
      const checkpoint = req.body.input
        .flatMap((i) => i.content || [])
        .find((p) => p.text?.startsWith("轻单保存的任务检查点"));
      const state = JSON.parse(
        checkpoint.text.slice(checkpoint.text.indexOf("\n") + 1),
      );
      assert.match(JSON.stringify(state.amendments), /温暖/);
      assert.equal(state.questions.length, 0);
      return callItem(
        "submit_result",
        {
          summary: "文案：灯光亮起，欢迎一起出发。",
          answer: "灯光亮起，欢迎一起出发。",
          checks: [
            {
              requirementId: "read",
              evidenceIds: state.evidence.filter((e) => e.ok).map((e) => e.id),
              explanation: "取得活动资料",
            },
            {
              requirementId: "copy",
              evidenceIds: [],
              explanation: "交付温暖文案",
            },
          ],
        },
        "deliver",
      );
    });
    const chat = await openPiChat({
      directory: dir,
      settings: fixture.settings,
      mcp,
      tools: { references: () => [] },
      taskHarness: true,
      requirePlanConfirmation: true,
      preloadSelected: true,
    });
    try {
      await turn(chat, baseScope, "查询活动资料并写文案");
      const planned = chat.task(baseScope),
        scope = { ...baseScope, userMessageId: "u2", visible: ["u1"] };
      const work = turn(chat, scope, "确认", {
        taskId: planned.id,
        questionId: planned.plan.questionId,
      });
      await until(() => lookups === 1);
      const question = chat
        .task(scope)
        .questions.find((q) => q.kind !== "plan_confirmation");
      const answer = {
        requestId: randomUUID(),
        taskId: planned.id,
        questionId: question.id,
        text: "温暖",
      };
      const queueScope = { ...scope, projectSource: undefined };
      const first = await chat.queueAnswer(queueScope, answer);
      assert.equal(first.accepted, true);
      assert.equal(
        (await chat.queueAnswer(queueScope, answer)).requestId,
        first.requestId,
      );
      assert.equal(chat.task(scope).questions[0].pendingAnswer.text, "温暖");
      await assert.rejects(
        () =>
          chat.queueAnswer(
            { ...scope, chatId: "wrong" },
            { ...answer, requestId: randomUUID() },
          ),
        /失效/,
      );
      release();
      const response = await work;
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      await until(() => chat.task(scope).status === "completed");
      assert.equal(lookups, 1);
      assert.equal(fixture.requests.length, 4);
      assert.equal(chat.task(scope).answerEvents[0].answer, "温暖");
      assert.deepEqual(
        chat.task(scope).messageIds,
        ["u1", "u2"],
        "队列回答不伪造云端消息编号",
      );
    } finally {
      release();
      await chat.close();
      await fixture.close();
    }
  },
);

test("回答队列持久保存、隔离记忆版本，旧计划确认不能批准修改后的计划", async (t) => {
  const dir = await scratch(t);
  let store = new TaskStore(dir);
  const mcp = fakeMcp(imageSpecs, async () => ({}));
  let caps = new HarnessCapabilities(mcp, baseScope, []);
  let run = new TaskRun({
    store,
    scope: baseScope,
    input: input("生成图片"),
    jobId: "plan",
    signal: new AbortController().signal,
    capabilities: caps,
    requirePlanConfirmation: true,
  });
  try {
    await run.control("update_task", imagePlan());
    const taskId = run.task.id;
    store.queueAnswer(baseScope, {
      requestId: "q",
      taskId,
      questionId: run.task.plan.questionId,
      text: "确认",
    });
    await run.control("update_task", {
      steps: imagePlan().steps.map((s) =>
        s.id === "draft" ? { ...s, title: "撰写新版本提示词" } : s,
      ),
    });
    run.close();
    await caps.close();
    store.close();
    store = new TaskStore(dir);
    assert.equal(store.pendingAnswers(taskId).length, 1);
    caps = new HarnessCapabilities(mcp, baseScope, []);
    run = new TaskRun({
      store,
      scope: baseScope,
      input: input("生成图片"),
      jobId: "recover",
      signal: new AbortController().signal,
      capabilities: caps,
      requirePlanConfirmation: true,
    });
    run.consumeAnswers();
    assert.equal(run.task.plan.status, "pending");
    assert.equal(store.pendingAnswers(taskId).length, 0);
    assert.throws(
      () =>
        store.queueAnswer(
          { ...baseScope, memoryEpoch: 1 },
          {
            requestId: "new",
            taskId,
            questionId: run.task.plan.questionId,
            text: "确认",
          },
        ),
      /失效/,
    );
    store.queueAnswer(baseScope, {
      requestId: "current",
      taskId,
      questionId: run.task.plan.questionId,
      text: "确认",
    });
    run.task.status = "cancelled";
    run.save("cancelled");
    run.consumeAnswers();
    assert.equal(run.task.plan.status, "pending", "停止后不能由旧回答重新启动");
  } finally {
    run.close();
    await caps.close();
    store.close();
  }
});

test("重复查询中的时间与追踪编号不计新进展；步骤定义改变后旧成果不能直接打勾", async (t) => {
  const store = new TaskStore(await scratch(t));
  const caps = new HarnessCapabilities(
    fakeMcp(imageSpecs, async () => ({})),
    baseScope,
    [],
  );
  const run = new TaskRun({
    store,
    scope: baseScope,
    input: input("生成图片"),
    jobId: "progress",
    signal: new AbortController().signal,
    capabilities: caps,
    requirePlanConfirmation: true,
  });
  try {
    await run.control("update_task", imagePlan());
    run.task.evidence = [
      {
        id: "one",
        label: statusName,
        kind: "tool",
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "running",
                request_id: "one",
                updated_at: "today",
              }),
            },
          ],
        },
      },
    ];
    const signature = run.progressSignature();
    run.task.evidence.push({
      ...run.task.evidence[0],
      id: "two",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "running",
              request_id: "two",
              updated_at: "tomorrow",
            }),
          },
        ],
      },
    });
    assert.equal(run.progressSignature(), signature);
    const evidence = normalizeEvidence(
      draftName,
      { prompt: "雨夜街道" },
      { structuredContent: { text: "实际稿件" } },
      { id: "draft-ev", taskId: run.task.id },
    );
    evidence.stepId = "draft";
    run.task.evidence.push(evidence);
    await run.control("update_task", {
      steps: imagePlan().steps.map((s) =>
        s.id === "draft"
          ? {
              ...s,
              status: "done",
              execution: { tool: draftName, args: { prompt: "晴天" } },
            }
          : s,
      ),
    });
    assert.notEqual(run.task.steps[0].status, "done");
    assert.equal(taskCard(run.task).plan.status, "pending");
  } finally {
    run.close();
    await caps.close();
    store.close();
  }
});

for (const code of ["forbidden", "approval_required"])
  test(`官网 ${code}：明确未受理的权限拒绝可由用户重试，待批准操作沿用原回执`, async (t) => {
    const store = new TaskStore(await scratch(t));
    const mcp = fakeMcp(imageSpecs, async () => ({}));
    let caps = new HarnessCapabilities(mcp, baseScope, []),
      run;
    let calls = 0;
    const create = (scope, text, reply) =>
      new TaskRun({
        store,
        scope,
        input: input(text, reply),
        jobId: randomUUID(),
        signal: new AbortController().signal,
        capabilities: caps,
        requirePlanConfirmation: true,
      });
    const invoke = async () =>
      ++calls === 1
        ? {
            isError: true,
            structuredContent: { error: { code, message: "请在官网处理权限" } },
          }
        : {
            structuredContent: { created: [{ ref: "image", node_id: "new" }] },
          };
    try {
      run = create(baseScope, "新建图片节点");
      await run.control("update_task", {
        requirements: [
          {
            id: "node",
            description: "新建节点",
            check: "tool_result",
            tool: createName,
            operation: "node.create",
          },
        ],
        steps: [
          {
            id: "node",
            description: "新建节点",
            status: "pending",
            requirementIds: ["node"],
            execution: {
              tool: createName,
              args: {
                canvas_id: "canvas",
                changes: [{ op: "create", ref: "image" }],
              },
            },
          },
        ],
      });
      const reply = {
        taskId: run.task.id,
        questionId: run.task.plan.questionId,
      };
      run.close();
      await caps.close();
      const approved = { ...baseScope, userMessageId: "u2", visible: ["u1"] };
      caps = new HarnessCapabilities(mcp, approved, []);
      run = create(approved, "确认", reply);
      await run.runPrepared(invoke);
      assert.equal(run.task.status, "blocked");
      assert.equal(await run.runPrepared(invoke), 0);
      run.close();
      await caps.close();
      const retry = {
        ...baseScope,
        userMessageId: "u3",
        visible: ["u1", "u2"],
      };
      caps = new HarnessCapabilities(mcp, retry, []);
      run = create(retry, "继续");
      await run.runPrepared(invoke);
      assert.equal(calls, code === "forbidden" ? 2 : 1);
      assert.equal(run.task.steps[0].status === "done", code === "forbidden");
    } finally {
      run?.close();
      await caps.close();
      store.close();
    }
  });

test("宏尚待官网启用时查询不会重置等待起点或计数", async (t) => {
  const store = new TaskStore(await scratch(t));
  const name = "mcp__waao__macro_update",
    read = "mcp__waao__macro_get";
  const mcp = fakeMcp(
    [name, read].map((name) => ({
      name,
      parameters: object({ macro_id: { type: "string" } }, ["macro_id"]),
    })),
    async () => ({}),
  );
  let caps = new HarnessCapabilities(mcp, baseScope, []);
  let run = new TaskRun({
    store,
    scope: baseScope,
    input: input("配置宏"),
    jobId: "macro",
    signal: new AbortController().signal,
    capabilities: caps,
    requirePlanConfirmation: true,
  });
  try {
    await run.control("update_task", {
      requirements: [
        {
          id: "macro",
          description: "配置宏",
          check: "tool_result",
          tool: name,
        },
      ],
      steps: [
        {
          id: "macro",
          description: "配置宏",
          status: "pending",
          requirementIds: ["macro"],
          execution: { tool: name, args: { macro_id: "macro" } },
        },
      ],
    });
    const reply = { taskId: run.task.id, questionId: run.task.plan.questionId };
    run.close();
    await caps.close();
    const scope = { ...baseScope, userMessageId: "u2", visible: ["u1"] };
    caps = new HarnessCapabilities(mcp, scope, []);
    run = new TaskRun({
      store,
      scope,
      input: input("确认", reply),
      jobId: "macro-confirm",
      signal: new AbortController().signal,
      capabilities: caps,
      requirePlanConfirmation: true,
    });
    const pending = async () => ({
      structuredContent: {
        macro_id: "macro",
        status: "pending",
        version: 2,
        agent_runnable: false,
      },
    });
    await run.runPrepared(pending);
    assert.equal(run.task.status, "waiting_external");
    const since = (run.task.external.since = Date.now() - 10000);
    await caps.request(read);
    for (let n = 0; n < 4; n++) {
      await run.execute(read, { macro_id: "macro" }, "poll" + n, pending);
      assert.equal(run.task.external.checks, n);
      assert.equal(run.task.external.since, since);
      run.task.external.checks++;
    }
  } finally {
    run.close();
    await caps.close();
    store.close();
  }
});
