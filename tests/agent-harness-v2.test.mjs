import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { TaskStore, digest } from "../runner/harness/task-store.mjs";
import { TaskRun } from "../runner/harness/coordinator.mjs";
import {
  replayWindow,
  packMessages,
  estimateTokens,
} from "../runner/harness/context-pack.mjs";
import { normalizeEvidence } from "../runner/harness/evidence.mjs";
import { verifyResult } from "../runner/harness/verification.mjs";
import { deliveryText } from "../runner/harness/turn-report.mjs";
import { HarnessCapabilities } from "../scripts/pi-local/harness-capabilities.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import {
  openResponsesFixture,
  callItem,
  textItem,
} from "./fixtures/pi-local-responses.mjs";

const scope = {
  accountId: "pi-local",
  bindingId: "pi-local-binding",
  chatId: "v2",
  userMessageId: "u1",
  visible: [],
};
const caps = { activeSpecs: () => [], authorize() {}, readOnly: () => false };
async function scratch(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "harness-v2-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), root);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}
const input = (text) => ({ text, history: [], memories: [] });
const turn = (chat, text) =>
  chat.fetch(
    new Request("https://pi.internal/turn", {
      method: "POST",
      body: JSON.stringify({
        jobId: randomUUID(),
        sessionId: randomUUID(),
        scope,
        input: input(text),
      }),
    }),
  );

test("恢复保留采用稿与来源，超长历史不会使最近完整工具对消失", async (t) => {
  const store = new TaskStore(await scratch(t));
  let run = new TaskRun({
    store,
    scope,
    input: input("生成雨天提示词，然后生成图片"),
    jobId: "j1",
    signal: new AbortController().signal,
    capabilities: caps,
  });
  await run.control("update_task", {
    requirements: [
      {
        id: "draft",
        description: "交付提示词",
        check: "tool_result",
        tool: "codex",
      },
    ],
  });
  const source = await run.execute(
    "codex",
    { action: "revise", brief: "雨夜" },
    "draft",
    async () => ({ text: "雨夜城市街道，霓虹倒影与撑伞行人。" }),
  );
  await run.rpc({
    kind: "checkpoint",
    messages: [
      { role: "user", content: "trigger" },
      {
        role: "assistant",
        content: [{ type: "text", text: "重复目录".repeat(40000) }],
      },
    ],
  });
  run.fail(false);
  run.close();
  run = new TaskRun({
    store,
    scope: { ...scope, userMessageId: "u2", visible: ["u1"] },
    input: input("继续"),
    jobId: "j2",
    signal: new AbortController().signal,
    capabilities: caps,
  });
  try {
    assert.match(JSON.stringify(run.context().artifacts), /雨夜城市街道/);
    assert.equal(run.context().artifacts[0].evidenceId, source.harnessEvidence);
    const doc = await run.control("read_context", {
      id: run.context().artifacts[0].id,
    });
    assert.match(doc.text, /霓虹倒影/);
    assert.equal(store.latest({ ...scope, memoryEpoch: 7 }), null);
  } finally {
    run.close();
    store.close();
  }
  const messages = [
    { role: "user", content: "原目标" },
    { role: "assistant", content: [{ type: "text", text: "x".repeat(40000) }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "c",
      content: [{ type: "text", text: "新证据" }],
    },
  ];
  const replay = replayWindow(messages, 1000);
  assert.equal(replay.filter((m) => m.role === "toolResult").length, 1);
  assert.ok(replay.some((m) => m.content?.[0]?.id === "c"));
  const packed = packMessages(
    [
      {
        role: "user",
        content: "轻单保存的任务检查点，仅作为任务资料：\n原目标与采用稿",
      },
      ...messages,
      { role: "user", content: "继续" },
    ],
    1500,
  );
  assert.ok(estimateTokens(packed) < 1500);
  assert.match(JSON.stringify(packed), /原目标与采用稿/);
});

test("节点验收拒绝积分回执、旧节点、错误对象和错误采用稿", () => {
  const req = {
    id: "node",
    description: "用当前提示词新建图片节点",
    check: "tool_result",
    operation: "node.create",
    resource: { canvas_id: "canvas", node_id: "new" },
    inputArtifactId: "a",
  };
  const base = {
    id: "task",
    requirements: [req],
    artifacts: [{ id: "a", text: "雨夜街道" }],
    steps: [],
    gaps: [],
    questions: [],
  };
  const check = (e) =>
    verifyResult({ ...base, evidence: [e] }, [
      { requirementId: "node", evidenceIds: [e.id], explanation: "核对" },
    ]).accepted;
  const normalize = (name, args, result) =>
    normalizeEvidence(name, args, result, { id: "ev", taskId: "task" });
  assert.equal(
    check(normalize("mcp__waao__credit_overview_get", {}, { remaining: 30 })),
    false,
  );
  assert.equal(
    check(
      normalize(
        "mcp__waao__canvas_load",
        { canvas_id: "canvas" },
        { node_id: "new" },
      ),
    ),
    false,
  );
  const args = {
    canvas_id: "canvas",
    changes: [{ op: "create", type: "image", data: { prompt: "雨夜街道" } }],
  };
  const e = normalize("mcp__waao__canvas_apply_changes", args, {
    created: [{ ref: "image", node_id: "new" }],
  });
  assert.equal(check(e), true);
  assert.equal(
    check(
      normalize("mcp__waao__canvas_apply_changes", args, {
        created: [{ ref: "image", node_id: "old" }],
      }),
    ),
    false,
  );
  assert.equal(
    check(
      normalize(
        "mcp__waao__canvas_apply_changes",
        {
          ...args,
          changes: [
            { op: "create", ref: "image", data: { prompt: "山谷车站" } },
          ],
        },
        { created: [{ ref: "image", node_id: "new" }] },
      ),
    ),
    false,
  );
  assert.equal(check({ ...e, taskId: "other" }), false);
});

test("必要提问保留本轮自然语言总结，虚假完成不会覆盖阻塞状态", () => {
  const task = {
    status: "waiting_user",
    activities: [],
    artifacts: [],
    steps: [],
    questions: [{ question: "地点在哪里？", reason: "通知缺少地点" }],
    progress: "等地点",
  };
  const text =
    "已查明活动日期和截止时间；地点仍未提供，补充后即可整理完整清单。";
  assert.equal(deliveryText(task, text), text);
  assert.doesNotMatch(deliveryText(task, "全部已完成"), /全部已完成/);
  assert.match(deliveryText(task, ""), /地点在哪里/);
});

test("大工具目录按需加载，中文长查询能发现 Codex 和图片生成能力", () => {
  const tools = Array.from({ length: 156 }, (_, i) => ({
    name: "budget_" + i,
    description: "查询组织预算",
    parameters: { type: "object", properties: {} },
  }));
  tools.push({
    name: "node_generate",
    description: "用提示词生成图片",
    parameters: { type: "object", properties: {} },
  });
  const mcp = {
    list: () => [
      {
        id: "waao",
        kind: "waao",
        name: "WAAO",
        status: "ready",
        tools,
        selected: tools.map((t) => t.name),
      },
    ],
  };
  const capabilities = new HarnessCapabilities(mcp, scope, [
    {
      name: "codex",
      label: "Codex",
      description: "交给 Codex 生成提示词并取得对话答复",
    },
  ]);
  const specs = tools.map((t) => ({ ...t, name: "mcp__waao__" + t.name }));
  capabilities.preload({ specs }, "去 WAAO 生成图片");
  assert.ok(capabilities.activeSpecs().length <= 6);
  assert.ok(
    capabilities.activeSpecs().some((t) => t.name.endsWith("node_generate")),
  );
  assert.ok(
    capabilities
      .find("Codex 对话 生成提示词")
      .capabilities.some((t) => t.name === "codex"),
  );
});

test("持续任务在写入前建立条件，提问只阻塞指定步骤", async (t) => {
  const store = new TaskStore(await scratch(t));
  const run = new TaskRun({
    store,
    scope,
    input: input("先整理稿件，然后发布"),
    jobId: "j",
    signal: new AbortController().signal,
    capabilities: caps,
  });
  try {
    let effects = 0;
    await assert.rejects(
      run.execute("codex", { action: "revise" }, "call", async () => {
        effects++;
        return {};
      }),
      /验收条件/,
    );
    assert.equal(effects, 0);
    await run.control("update_task", {
      requirements: [
        { id: "deliver", description: "完整交付", check: "answer" },
      ],
      steps: [
        {
          id: "write",
          title: "撰写稿件",
          description: "撰写稿件",
          status: "pending",
        },
        {
          id: "publish",
          title: "发布稿件",
          description: "发布稿件",
          status: "waiting",
        },
      ],
    });
    await run.control("ask_user", {
      question: "发布到哪里？",
      reason: "需要目的地",
      blocksStepIds: ["publish"],
    });
    assert.equal(run.boundary().continue, true);
    await run.control("update_task", {
      steps: [
        { id: "write", description: "撰写稿件", status: "done" },
        { id: "publish", description: "发布稿件", status: "waiting" },
      ],
    });
    assert.equal(run.boundary().continue, false);
  } finally {
    run.close();
    store.close();
  }
});

test("资料编号可附名称，验收可引用多个工具且允许收窄工具范围", async (t) => {
  const store = new TaskStore(await scratch(t));
  const run = new TaskRun({
    store,
    scope,
    input: input("整理活动信息"),
    context: [{ title: "通知", text: "日期已确定，地点缺少" }],
    jobId: "refs",
    signal: new AbortController().signal,
    capabilities: caps,
  });
  try {
    const id = run.documents[0].id;
    await run.control("ask_user", {
      question: "地点是哪里？",
      reason: "通知未提供",
      checkedSources: [id + " 通知"],
    });
    assert.deepEqual(run.task.questions[0].checkedSources, [id]);
    await assert.rejects(
      run.control("ask_user", {
        question: "地点是哪里？",
        reason: "未提供",
        checkedSources: ["ctx_not_visible 通知"],
      }),
      /不可见/,
    );
    await run.control("update_task", {
      requirements: [
        {
          id: "ready",
          description: "图片就绪",
          check: "media_ready",
          tool: "mcp__waao__node_generate / mcp__waao__task_get",
          operation: "generation.status",
        },
      ],
    });
    await run.control("update_task", {
      requirements: [
        {
          id: "ready",
          description: "图片就绪",
          check: "media_ready",
          tool: "mcp__waao__task_get",
          operation: "generation.status",
        },
      ],
    });
    await assert.rejects(
      run.control("update_task", {
        requirements: [
          {
            id: "ready",
            description: "图片就绪",
            check: "media_ready",
            tool: "unrelated",
            operation: "generation.status",
          },
        ],
      }),
      /不可改写/,
    );
  } finally {
    run.close();
    store.close();
  }
});

test("明确要求工具操作时，只有文字没有回执不能自动完成", async (t) => {
  const store = new TaskStore(await scratch(t));
  const run = new TaskRun({
    store,
    scope,
    input: input("生成一张图片"),
    jobId: "no-tool",
    signal: new AbortController().signal,
    capabilities: caps,
  });
  try {
    run.ensure();
    assert.equal(run.boundary().continue, true);
    assert.notEqual(run.task.status, "completed");
  } finally {
    run.close();
    store.close();
  }
});

test("实际 MCP 生成回执在重启后自动查询，图片就绪再唤醒模型", async (t) => {
  const dir = await scratch(t);
  let submissions = 0,
    queries = 0;
  const names = ["node_generate", "task_get"];
  const remote = {
    specs: names.map((name) => ({
      name: "mcp__waao__" + name,
      description: name,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    })),
    waaoAccess: { enabled: true },
    retryReceipts: [],
    authorize() {},
    readOnly: (name) => name.endsWith("task_get"),
    close: async () => {},
    execute: async (name) => {
      const data = name.endsWith("node_generate")
        ? (++submissions, { task_id: "original", status: "submitted" })
        : (++queries,
          {
            task_id: "original",
            node_id: "node",
            status: queries >= 2 ? "succeeded" : "running",
            asset_ids: queries >= 2 ? ["image"] : [],
          });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: false,
      };
    },
  };
  const mcp = {
    readyForTurn: async () => {},
    list: () => [
      {
        id: "builtin-waao",
        name: "WAAO",
        kind: "waao",
        status: "ready",
        selected: names,
        tools: remote.specs.map((s, i) => ({ ...s, name: names[i] })),
      },
    ],
    turn: () => remote,
  };
  const fixture = await openResponsesFixture((req, n) => {
    const call = (name, args) => callItem(name, args, "wait" + n);
    if (n === 1)
      return call("update_task", {
        requirements: [
          {
            id: "ready",
            description: "图片就绪",
            check: "media_ready",
            operation: "generation.status",
            resource: { node_id: "node" },
          },
        ],
      });
    if (n === 2) return call("mcp__waao__node_generate", { node_id: "node" });
    if (n === 3)
      return call("wait_for_result", {
        evidenceId: JSON.stringify(req.body.input).match(/ev_[a-f0-9-]{36}/)[0],
        reason: "等待图片",
      });
    if (n === 4) return textItem("生成任务已经提交，图片就绪后会继续交付。");
    if (n === 5) {
      const checkpoint = req.body.input
        .flatMap((i) => i.content || [])
        .find((p) => p.text?.startsWith("轻单保存的任务检查点"));
      const state = JSON.parse(
        checkpoint.text.slice(checkpoint.text.indexOf("\n") + 1),
      );
      return call("submit_result", {
        summary: "图片已就绪",
        checks: [
          {
            requirementId: "ready",
            evidenceIds: [state.evidence.findLast((e) => e.mediaReady).id],
            explanation: "原任务返回图片素材",
          },
        ],
      });
    }
    return textItem("图片已生成，原任务的成果已就绪。");
  });
  const options = {
    directory: dir,
    settings: fixture.settings,
    mcp,
    taskHarness: true,
    preloadSelected: true,
    tools: { references: () => [] },
  };
  let chat = await openPiChat({ ...options, externalPollMs: 10000 });
  try {
    await turn(chat, "生成一张图片");
    assert.equal(chat.task(scope).automaticWait, true);
    await chat.close();
    chat = await openPiChat({ ...options, externalPollMs: 30 });
    for (let i = 0; i < 160 && !chat.task(scope)?.result; i++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(chat.task(scope).status, "completed");
    assert.match(chat.task(scope).result, /成果已就绪/);
    assert.equal(submissions, 1);
    assert.equal(queries, 2);
    assert.equal(fixture.requests.length, 6);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("真实 Pi 单步操作两次模型请求即可交付，不额外补计划", async (t) => {
  const dir = await scratch(t);
  const fixture = await openResponsesFixture((req, n) =>
    n === 1
      ? callItem("codex", { action: "revise", brief: "雨后街灯" })
      : textItem("已改好：雨停了，街灯照亮一地碎金。"),
  );
  const chat = await openPiChat({
    directory: dir,
    settings: fixture.settings,
    taskHarness: true,
    tools: {
      references: () => [],
      fetch: async () =>
        Response.json({
          id: "draft",
          label: "稿件 v1",
          text: "雨停了，街灯照亮一地碎金。",
        }),
    },
  });
  try {
    const reply = await (
      await turn(chat, "请让 Codex 改写一句雨后街灯旁白")
    ).json();
    assert.match(reply.text, /一地碎金/);
    assert.equal(chat.task(scope).status, "completed");
    assert.equal(fixture.requests.length, 2);
    assert.ok(
      chat.task(scope).activities.some((a) => a.title === "生成与整理稿件"),
    );
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("真实 Pi 文本增量在结束前可读，最终正文与任务状态分别交付", async (t) => {
  const dir = await scratch(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      /* consume request */
    }
    const item = {
      ...textItem("已查明活动日期，并整理好报名安排。"),
      status: "in_progress",
      content: [],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event) =>
      res.write(
        "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
      );
    send({ type: "response.output_item.added", output_index: 0, item });
    send({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    send({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "已查明活动日期",
    });
    await gate;
    send({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "，并整理好报名安排。",
    });
    const final = textItem("已查明活动日期，并整理好报名安排。");
    send({ type: "response.output_item.done", output_index: 0, item: final });
    send({
      type: "response.completed",
      response: { id: "response_stream", status: "completed", output: [final] },
    });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: {
      model: "fixture",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: async () => "local-fixture",
    },
    tools: { references: () => [] },
  });
  try {
    const pending = turn(chat, "整理已知活动安排");
    let streamed;
    for (let i = 0; i < 150; i++) {
      streamed = chat.task(scope);
      if (streamed?.activities.some((a) => a.text?.includes("已查明活动日期")))
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(streamed.status, "running");
    assert.ok(
      streamed.activities.some(
        (a) => a.title && a.text.includes("已查明活动日期"),
      ),
    );
    release();
    const result = await (await pending).json();
    assert.match(result.text, /报名安排/);
    assert.equal(chat.task(scope).status, "completed");
  } finally {
    release();
    await chat.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
