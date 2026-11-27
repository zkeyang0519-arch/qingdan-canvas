import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore } from "../runner/harness/task-store.mjs";
import { TaskRun } from "../runner/harness/coordinator.mjs";
import { HarnessCapabilities } from "../scripts/pi-local/harness-capabilities.mjs";
import { validateRecipe } from "../runner/harness/recipes.mjs";
import { verifyResult } from "../runner/harness/verification.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import {
  callItem,
  textItem,
  openResponsesFixture,
} from "./fixtures/pi-local-responses.mjs";

async function scratch(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "task-harness-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), root);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}
const scope = {
  accountId: "pi-local",
  bindingId: "pi-local-binding",
  chatId: "chat",
  userMessageId: "m1",
  visible: [],
};
const input = { text: "整理项目资料并交付稿件", history: [], memories: [] };
const requirement = {
  id: "draft",
  description: "实际交付稿件",
  check: "tool_result",
};
const step = (status) => ({ id: "draft", description: "整理并改稿", status });
const capabilities = {
  activeSpecs: () => [],
  authorize() {},
  readOnly: () => false,
};
function turn(chat, message = "m1", visible = [], text = input.text) {
  return chat.fetch(
    new Request("https://pi.internal/turn", {
      method: "POST",
      body: JSON.stringify({
        jobId: randomUUID(),
        sessionId: randomUUID(),
        scope: { ...scope, userMessageId: message, visible },
        input: { ...input, text },
      }),
    }),
  );
}
function run(store, extra = {}) {
  return new TaskRun({
    store,
    scope,
    input,
    capabilities,
    jobId: randomUUID(),
    signal: new AbortController().signal,
    ...extra,
  });
}

test("验收拒绝缺失与失败证据、阻塞信息、未完成步骤和未播放媒体", () => {
  const task = {
    requirements: [requirement],
    evidence: [],
    gaps: [],
    questions: [],
    steps: [],
  };
  const checks = [
    { requirementId: "draft", evidenceIds: ["fake"], explanation: "完成" },
  ];
  assert.equal(verifyResult(task, checks).accepted, false);
  task.evidence.push({ id: "real", ok: true, kind: "tool" });
  checks[0].evidenceIds = ["real"];
  assert.equal(verifyResult(task, checks).accepted, true);
  task.steps = [step("running")];
  assert.equal(verifyResult(task, checks).accepted, false);
  task.steps = [];
  task.gaps = [{ description: "缺少尺寸", blocking: true, resolved: false }];
  assert.equal(verifyResult(task, checks).accepted, false);
  task.gaps = [];
  task.requirements = [{ ...requirement, check: "media_ready" }];
  assert.equal(verifyResult(task, checks).accepted, false);
  task.evidence[0].mediaReady = true;
  assert.equal(verifyResult(task, checks).accepted, true);
});

test("任务隔离与租约拒绝并行写入，要求不可削减，已保存回执在恢复后复用", async (t) => {
  const dir = await scratch(t);
  let store = new TaskStore(dir);
  let active = run(store);
  try {
    await active.control("update_task", { requirements: [requirement] });
    assert.throws(() => run(store), /已有任务/);
    await assert.rejects(
      active.control("update_task", {
        requirements: [{ ...requirement, check: "answer" }],
      }),
      /不可改写/,
    );
    await active.control("update_task", {
      requirements: [{ id: "extra", description: "补充摘要", check: "answer" }],
    });
    assert.equal(active.task.requirements.length, 2);
    let calls = 0;
    const invoke = async () => {
      calls++;
      return { id: "receipt", text: "真实内容" };
    };
    await active.execute("writer", { text: "a" }, "c1", invoke);
    active.fail(false);
    active.close();
    store.close();
    store = new TaskStore(dir);
    assert.equal(store.latest({ ...scope, chatId: "other" }), null);
    assert.equal(
      store.latest({ ...scope, userMessageId: "m2", visible: [] }),
      null,
    );
    active = run(store, {
      scope: { ...scope, userMessageId: "m2", visible: ["m1"] },
    });
    const result = await active.execute("writer", { text: "a" }, "c2", invoke);
    assert.equal(result.id, "receipt");
    assert.equal(calls, 1);
    await assert.rejects(
      active.execute("writer", { text: "uncertain" }, "c3", async () => {
        throw Error("lost");
      }),
      /lost/,
    );
    await assert.rejects(
      active.execute("writer", { text: "uncertain" }, "c4", invoke),
      /不能重复提交/,
    );
    assert.equal(calls, 1);
  } finally {
    active.close();
    store.close();
  }
});

test("真实 Pi 在提前结束后继续，读取资料并拿到实际证据才完成", async (t) => {
  const dir = await scratch(t);
  let effects = 0;
  const fixture = await openResponsesFixture((req, n) => {
    const call = (name, args) => callItem(name, args, "call_" + n);
    if (n === 1)
      return call("update_task", {
        requirements: [requirement],
        steps: [step("running")],
      });
    if (n === 2) return textItem("提前宣称完成");
    if (n === 3) {
      assert.match(JSON.stringify(req.body.input), /尚未通过验收/);
      return call("search_context", { query: "品牌" });
    }
    if (n === 4) {
      const id = JSON.stringify(req.body.input).match(/ctx_[a-f0-9]{20}/)?.[0];
      assert.ok(id);
      return call("read_context", { id });
    }
    if (n === 5) {
      assert.match(JSON.stringify(req.body.input), /品牌用语/);
      return call("codex", { action: "revise", brief: "按品牌用语改稿" });
    }
    if (n === 6)
      return call("submit_result", {
        summary: "交稿",
        checks: [
          {
            requirementId: "draft",
            evidenceIds: [],
            explanation: "我认为完成",
          },
        ],
      });
    if (n === 7) {
      assert.match(JSON.stringify(req.body.input), /真实工具回执/);
      return call("update_task", { steps: [step("done")] });
    }
    if (n === 8) {
      const ev = JSON.stringify(req.body.input).match(/ev_[a-f0-9-]{36}/)?.[0];
      assert.ok(ev);
      return call("submit_result", {
        summary: "已交稿",
        checks: [
          {
            requirementId: "draft",
            evidenceIds: [ev],
            explanation: "实际稿件内容已收到",
          },
        ],
      });
    }
    assert.equal(n, 9);
    return textItem("已按要求交付稿件。");
  });
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: {
      references: () => [],
      context: () => [{ title: "品牌", text: "品牌用语必须简洁准确" }],
      fetch: async () => {
        effects++;
        return Response.json({
          id: "draft-real",
          text: "真实稿件",
          label: "稿件 v1",
          source: "fixture",
        });
      },
    },
  });
  try {
    const response = await turn(chat);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.text, "已按要求交付稿件。");
    assert.equal(chat.task(scope).status, "completed");
    assert.equal(effects, 1);
    assert.equal(fixture.requests.length, 9);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("真实 Pi 提问后关闭进程，用户补充恢复同一目标与工具上下文", async (t) => {
  const dir = await scratch(t);
  let phase = 0;
  const fixture = await openResponsesFixture((req, n) => {
    const call = (name, args) => callItem(name, args, "call_q" + n);
    if (!phase) {
      if (n === 1)
        return call("update_task", {
          goal: "写一段旁白",
          requirements: [
            { id: "copy", description: "交付旁白", check: "answer" },
          ],
        });
      if (n === 2)
        return call("ask_user", {
          question: "旁白用哪种语气？",
          options: ["温暖", "克制"],
          reason: "语气决定措辞",
        });
      return textItem("等回答");
    }
    assert.match(JSON.stringify(req.body.input), /写一段旁白/);
    assert.match(JSON.stringify(req.body.input), /温暖/);
    if (n === 4)
      return call("submit_result", {
        summary: "已写好旁白",
        checks: [
          {
            requirementId: "copy",
            evidenceIds: [],
            explanation: "提供温暖语气的完整旁白",
          },
        ],
      });
    return textItem("灯火亮起，我们一起回家。");
  });
  const options = {
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: { references: () => [] },
  };
  let chat = await openPiChat(options);
  try {
    const result = await (await turn(chat)).json();
    assert.match(result.text, /旁白用哪种语气/);
    const first = chat.task(scope);
    assert.equal(first.status, "waiting_user");
    await chat.close();
    phase = 1;
    chat = await openPiChat(options);
    const next = await (await turn(chat, "m2", ["m1"], "温暖")).json();
    assert.match(next.text, /灯火/);
    const last = chat.task({ ...scope, userMessageId: "m2", visible: ["m1"] });
    assert.equal(last.id, first.id);
    assert.equal(last.status, "completed");
    assert.equal(last.questions.length, 0);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("真实 Pi 按需加载 MCP，权限撤销后执行前再次校验", async (t) => {
  const dir = await scratch(t);
  let calls = 0;
  const mcp = new McpConnections(dir, {
    codexService: {
      connect: async () => ({
        listTools: async () => [
          {
            name: "query",
            description: "查询资料",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
        callTool: async () => {
          calls++;
          return { content: [{ type: "text", text: "已找到资料" }] };
        },
        close: async () => {},
      }),
    },
  });
  await mcp.initialCheck;
  mcp.setSelection(scope.bindingId, "builtin-codex", ["query"]);
  const fixture = await openResponsesFixture((req, n) => {
    const call = (name, args) => callItem(name, args, "call_d" + n);
    if (n === 1) {
      assert.ok(!req.body.tools.some((t) => t.name === "mcp__codex__query"));
      return call("update_task", { requirements: [requirement] });
    }
    if (n === 2)
      return call("request_capability", { name: "mcp__codex__query" });
    if (n === 3) {
      assert.ok(req.body.tools.some((t) => t.name === "mcp__codex__query"));
      return call("mcp__codex__query", {});
    }
    if (n === 4) {
      mcp.setSelection(scope.bindingId, "builtin-codex", []);
      return call("mcp__codex__query", {});
    }
    if (n === 5) {
      assert.match(JSON.stringify(req.body.input), /已停用/);
      return call("ask_user", {
        question: "需要重新启用资料查询吗？",
        reason: "项目权限已撤销",
        kind: "authorization",
      });
    }
    return textItem("等待授权");
  });
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: { references: () => [] },
    mcp,
  });
  try {
    const result = await (await turn(chat)).json();
    assert.ok(
      result.text,
      JSON.stringify({
        result,
        toolNames: fixture.requests.map((r) => r.body.tools.map((t) => t.name)),
        input: fixture.requests.at(-1)?.body.input,
      }),
    );
    assert.match(result.text, /启用资料查询/);
    assert.equal(calls, 1);
    assert.equal(chat.task(scope).status, "waiting_auth");
  } finally {
    await chat.close();
    await fixture.close();
    await mcp.close();
  }
});

test("没有进展不会无限续跑，也不会把模型的成功文案当作完成", async (t) => {
  const dir = await scratch(t);
  const fixture = await openResponsesFixture((req, n) =>
    n === 1
      ? callItem("update_task", { requirements: [requirement] }, "start")
      : textItem("全部已完成"),
  );
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: { references: () => [] },
  });
  try {
    const result = await (await turn(chat)).json();
    assert.match(result.text, /任务尚未完成/);
    assert.doesNotMatch(result.text, /全部已完成/);
    assert.equal(chat.task(scope).status, "interrupted");
    assert.ok(fixture.requests.length <= 5);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("组合工具结构校验拒绝未知工具、前向引用和危险字段，执行回执可以复用", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const caps = new HarnessCapabilities(null, scope, [
    { name: "writer", label: "写入", description: "写入" },
  ]);
  const active = run(store, { capabilities: caps });
  try {
    const recipe = {
      name: "draft",
      description: "整理后保存",
      inputs: [{ name: "brief", type: "string", description: "内容" }],
      steps: [
        { id: "one", tool: "writer", args: { text: { $input: "brief" } } },
      ],
    };
    assert.throws(
      () =>
        validateRecipe(
          { ...recipe, steps: [{ id: "one", tool: "shell", args: {} }] },
          caps.catalog(),
        ),
      /已授权/,
    );
    assert.throws(
      () =>
        validateRecipe(
          {
            ...recipe,
            steps: [
              { id: "one", tool: "writer", args: { text: { $step: "one" } } },
            ],
          },
          caps.catalog(),
        ),
      /前面步骤/,
    );
    assert.throws(
      () =>
        validateRecipe(
          {
            ...recipe,
            steps: [
              {
                id: "one",
                tool: "writer",
                args: JSON.parse('{"__proto__":{}}'),
              },
            ],
          },
          caps.catalog(),
        ),
      /不允许/,
    );
    assert.equal(
      (await active.control("create_capability", recipe)).status,
      "ready",
    );
    assert.ok(active.specs().some((spec) => spec.name === "qd_recipe_draft"));
    let called = 0;
    const invoke = async (name, args) => {
      called++;
      assert.equal(args.text, "原稿");
      return { text: "成稿" };
    };
    assert.equal(
      (
        await active.execute(
          "qd_recipe_draft",
          { brief: "原稿" },
          "one",
          invoke,
        )
      ).steps.one.text,
      "成稿",
    );
    await active.execute("qd_recipe_draft", { brief: "原稿" }, "two", invoke);
    assert.equal(called, 1);
    assert.equal(store.recipes({ ...scope, chatId: "other" }).length, 0);
  } finally {
    active.close();
    store.close();
  }
});

test("过期回答不能恢复别的任务，回答请求不因网络重试而重复消费", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  let active = run(store);
  try {
    await active.control("update_task", {
      requirements: [{ ...requirement, check: "answer" }],
    });
    const { question } = await active.control("ask_user", {
      question: "请选择语气",
      reason: "决定文案",
    });
    const taskId = active.task.id;
    active.close();
    const nextScope = { ...scope, userMessageId: "m2", visible: ["m1"] };
    assert.throws(
      () =>
        run(store, {
          scope: nextScope,
          input: { ...input, taskReply: { taskId, questionId: "stale" } },
        }),
      /提问已失效/,
    );
    active = run(store, {
      scope: nextScope,
      input: {
        ...input,
        text: "温暖",
        taskReply: { taskId, questionId: question.id },
      },
    });
    assert.equal(active.task.questions[0].answer, "温暖");
    active.close();
    active = run(store, {
      scope: nextScope,
      input: {
        ...input,
        text: "温暖",
        taskReply: { taskId, questionId: question.id },
      },
    });
    assert.equal(active.task.questions.length, 1);
  } finally {
    active.close();
    store.close();
  }
});

test("预算跨恢复累计，取消后不能被结束检查改写为完成", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const limits = { maxRequests: 3, maxRunRequests: 3, maxTokens: 1000 };
  let active = run(store, { limits });
  try {
    await active.control("update_task", { requirements: [requirement] });
    for (let i = 0; i < 3; i++) await active.rpc({ kind: "request" });
    await assert.rejects(active.rpc({ kind: "request" }), /预算用尽/);
    active.close();
    active = run(store, {
      limits,
      scope: { ...scope, userMessageId: "m2", visible: ["m1"] },
      input: { ...input, text: "继续" },
    });
    assert.equal(active.task.budget.requests, 3);
    assert.equal(active.task.budget.maxRequests, 6);
    await active.rpc({ kind: "request" });
    assert.equal(active.task.budget.requests, 4);
    active.fail(true);
    assert.equal(active.boundary().continue, false);
    assert.equal(active.task.status, "cancelled");
  } finally {
    active.close();
    store.close();
  }
});

test("默认预算不限，持续有进展的任务超过原 token、总请求和单轮请求上限仍可推进", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store, {
    capabilities: { ...capabilities, readOnly: () => true },
  });
  try {
    await active.control("update_task", { requirements: [requirement] });
    assert.equal(active.boundary().continue, true);
    for (let i = 0; i < 90; i++) {
      await active.rpc({ kind: "request" });
      await active.execute("reader", { page: i }, `page-${i}`, async () => ({
        page: i,
        text: `新资料 ${i}`,
      }));
      await active.rpc({ kind: "checkpoint", tokens: 60000, messages: [] });
      assert.equal(active.boundary().continue, true);
    }
    assert.equal(active.task.status, "running");
    assert.equal(active.task.budget.requests, 90);
    assert.equal(active.task.budget.tokens, 5400000);
    for (const key of ["maxTokens", "maxRequests", "maxRunRequests"])
      assert.equal(store.get(active.task.id).budget[key], null);
    active.fail(true);
    assert.equal(active.boundary().continue, false);
    assert.equal(active.task.status, "cancelled");
  } finally {
    active.close();
    store.close();
  }
});

test("旧预算暂停任务在用户续跑时转为不限，保留累计用量、任务身份和已收回执", async (t) => {
  const dir = await scratch(t);
  let store = new TaskStore(dir);
  let active = run(store, {
    limits: { maxRequests: 80, maxTokens: 250000, maxRunRequests: 24 },
  });
  let calls = 0;
  const execute = async () => {
    calls++;
    return { id: "original-remote-task", text: "原回执" };
  };
  try {
    const receipt = await active.execute(
      "writer",
      { prompt: "fixture" },
      "first",
      execute,
    );
    const id = active.task.id;
    active.task.budget.requests = 9;
    active.task.budget.tokens = 260703;
    active.save("checkpoint");
    await assert.rejects(active.rpc({ kind: "request" }), /预算用尽/);
    active.close();
    store.close();
    store = new TaskStore(dir);
    assert.equal(store.get(id).status, "paused_budget");
    active = run(store, {
      scope: { ...scope, userMessageId: "m2", visible: ["m1"] },
      input: { ...input, text: "继续" },
    });
    assert.equal(active.task.id, id);
    assert.equal(active.task.budget.tokens, 260703);
    assert.equal(active.task.budget.requests, 9);
    for (const key of ["maxTokens", "maxRequests", "maxRunRequests"])
      assert.equal(active.task.budget[key], null);
    const recovered = await active.execute(
      "writer",
      { prompt: "fixture" },
      "second",
      execute,
    );
    assert.deepEqual(recovered, receipt);
    assert.equal(calls, 1);
    await active.rpc({ kind: "request" });
    await active.rpc({ kind: "checkpoint", tokens: 60000, messages: [] });
    assert.equal(active.task.budget.requests, 10);
    assert.equal(active.task.budget.tokens, 320703);
    assert.equal(active.boundary().continue, true);
  } finally {
    active.close();
    store.close();
  }
});

test("调用方显式设置 token 预算时仍执行限额，null 不会被当成零", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store, { limits: { maxTokens: 1000 } });
  try {
    await active.control("update_task", { requirements: [requirement] });
    assert.equal(active.boundary().continue, true);
    await active.rpc({ kind: "request" });
    await active.rpc({ kind: "checkpoint", tokens: 1001, messages: [] });
    await assert.rejects(active.rpc({ kind: "request" }), /预算用尽/);
    assert.equal(active.task.status, "paused_budget");
    assert.equal(active.task.budget.requests, 1);
  } finally {
    active.close();
    store.close();
  }
});

test("相同只读结果的新回执编号不算进展，未结束的工具循环仍会保存检查点并暂停", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store, {
    capabilities: { ...capabilities, readOnly: () => true },
  });
  try {
    await active.control("update_task", { requirements: [requirement] });
    for (let i = 0; i < 4; i++) {
      await active.rpc({ kind: "request" });
      await active.execute("reader", {}, `read-${i}`, async () => ({
        text: "同样的信息",
      }));
    }
    assert.equal(new Set(active.task.evidence.map((e) => e.id)).size, 4);
    await assert.rejects(active.rpc({ kind: "request" }), /没有新进展/);
    assert.equal(active.task.status, "interrupted");
    assert.equal(active.halted, true);
    assert.match(active.finish("已完成"), /没有获得新信息/);
    await assert.rejects(
      active.execute("writer", {}, "too-late", async () => {
        assert.fail("暂停后不得执行新操作");
      }),
      /没有新进展/,
    );
  } finally {
    active.close();
    store.close();
  }
});

test("逐页读取新资料属于有效进展，不被工具空转检查误停", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store, {
    context: [{ title: "长资料", text: "资料".repeat(40000) }],
  });
  try {
    await active.control("update_task", { requirements: [requirement] });
    for (let i = 0; i < 8; i++) {
      await active.rpc({ kind: "request" });
      await active.control("read_context", {
        id: active.documents[0].id,
        offset: i * 8000,
      });
    }
    await active.rpc({ kind: "request" });
    assert.equal(active.task.status, "running");
    assert.equal(active.halted, false);
  } finally {
    active.close();
    store.close();
  }
});

test("新的验收反馈与成功验收属于进展，不会在交付前被空转检测拦截", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store);
  try {
    await active.control("update_task", { requirements: [requirement] });
    const result = await active.execute(
      "codex",
      { action: "revise" },
      "real",
      async () => ({
        text: "实际稿件",
      }),
    );
    const submit = (evidenceIds) =>
      active.control("submit_result", {
        summary: "交付稿件",
        checks: [
          { requirementId: "draft", evidenceIds, explanation: "核对稿件回执" },
        ],
      });
    for (let i = 0; i < 3; i++) {
      await active.rpc({ kind: "request" });
      assert.equal((await submit([])).accepted, false);
    }
    await active.rpc({ kind: "request" });
    assert.equal((await submit([result.harnessEvidence])).accepted, true);
    await active.rpc({ kind: "request" });
    assert.equal(active.boundary().continue, false);
    assert.equal(active.task.status, "completed");
  } finally {
    active.close();
    store.close();
  }
});

test("真实 Pi 连续重复调用缓存操作会暂停并说明原因，不重复执行外部副作用", async (t) => {
  const dir = await scratch(t);
  let effects = 0;
  const fixture = await openResponsesFixture((_, n) =>
    n === 1
      ? callItem("update_task", { requirements: [requirement] }, "start-loop")
      : callItem("codex", { action: "revise", brief: "同一任务" }, `loop-${n}`),
  );
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: {
      references: () => [],
      fetch: async () => {
        effects++;
        return Response.json({
          id: "one-receipt",
          text: "同一结果",
          source: "fixture",
        });
      },
    },
  });
  try {
    const response = await turn(chat);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.match(result.text, /没有获得新信息/);
    assert.equal(chat.task(scope).status, "interrupted");
    assert.equal(effects, 1);
    assert.ok(fixture.requests.length <= 6);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("外部等待在宿主重启后查询原回执，只在结果就绪时唤醒 Pi 验收", async (t) => {
  const dir = await scratch(t);
  let submitted = 0,
    queried = 0;
  const fixture = await openResponsesFixture((req, n) => {
    const call = (name, args) => callItem(name, args, "external_" + n);
    if (n === 1)
      return call("update_task", {
        requirements: [
          { id: "video", description: "交付可播放成片", check: "media_ready" },
        ],
      });
    if (n === 2)
      return call("waao", {
        action: "submit",
        draftId: "draft",
        assetId: "image",
      });
    if (n === 3)
      return call("wait_for_result", {
        evidenceId: JSON.stringify(req.body.input).match(/ev_[a-f0-9-]{36}/)[0],
        reason: "等待成片",
      });
    if (n === 4) return textItem("平台已受理");
    if (n === 5) {
      const checkpoint = req.body.input
        .flatMap((item) => item.content || [])
        .find((part) => part.text?.includes("轻单保存的任务检查点"));
      const task = JSON.parse(
        checkpoint.text.slice(checkpoint.text.indexOf("\n") + 1),
      );
      const evidence = task.evidence.findLast((e) => e.mediaReady);
      assert.ok(evidence);
      return call("submit_result", {
        summary: "成片已就绪",
        checks: [
          {
            requirementId: "video",
            evidenceIds: [evidence.id],
            explanation: "查询原任务得到可播放媒体",
          },
        ],
      });
    }
    assert.equal(n, 6);
    return textItem("成片已就绪，可以播放。");
  });
  const options = {
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    externalPollMs: 10000,
    tools: {
      references: () => [],
      fetch: async (request) => {
        const { args } = await request.json();
        if (args.action === "submit") {
          submitted++;
          return Response.json({
            id: "original-task",
            status: "running",
            playable: false,
          });
        }
        assert.equal(args.receiptId, "original-task");
        queried++;
        return Response.json({
          id: "original-task",
          status: queried >= 2 ? "succeeded" : "running",
          playable: queried >= 2,
        });
      },
    },
  };
  let chat = await openPiChat(options);
  try {
    assert.match((await (await turn(chat)).json()).text, /尚未完成/);
    assert.equal(chat.task(scope).status, "waiting_external");
    assert.equal(fixture.requests.length, 4);
    await chat.close();
    chat = await openPiChat({ ...options, externalPollMs: 30 });
    for (let i = 0; i < 120 && !chat.task(scope)?.result; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      chat.task(scope).status,
      "completed",
      JSON.stringify(chat.task(scope)),
    );
    assert.match(chat.task(scope).result, /可以播放/);
    assert.equal(submitted, 1);
    assert.equal(queried, 2);
    assert.equal(fixture.requests.length, 6);
  } finally {
    await chat.close();
    await fixture.close();
  }
});

test("记忆版本变化不会把旧检查点和旧证据重新交给模型", async (t) => {
  const dir = await scratch(t);
  const store = new TaskStore(dir);
  const active = run(store, {
    scope: { ...scope, memoryEpoch: 1, projectSource: { summaryRevision: 1 } },
  });
  try {
    await active.control("update_task", { requirements: [requirement] });
    assert.equal(store.latest({ ...scope, memoryEpoch: 2 }), null);
    assert.ok(store.latest({ ...scope, memoryEpoch: 1 }));
    assert.equal(
      store.latest({
        ...scope,
        memoryEpoch: 1,
        projectSource: { summaryRevision: 2 },
      }),
      null,
    );
    assert.ok(
      store.latest({
        ...scope,
        memoryEpoch: 1,
        projectSource: { summaryRevision: 1 },
      }),
    );
  } finally {
    active.close();
    store.close();
  }
});

test("服务关闭保存中断检查点，不伪装为用户取消", async (t) => {
  const dir = await scratch(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const fixture = await openResponsesFixture(async (request, n) => {
    if (n === 1)
      return callItem(
        "update_task",
        { requirements: [requirement] },
        "starting",
      );
    entered.resolve();
    await release.promise;
    return textItem("未核实的结果");
  });
  const chat = await openPiChat({
    directory: dir,
    taskHarness: true,
    settings: fixture.settings,
    tools: { references: () => [] },
  });
  try {
    const pending = turn(chat);
    await entered.promise;
    await chat.close();
    assert.equal((await pending).status, 502);
    const store = new TaskStore(dir);
    try {
      assert.equal(store.latest(scope, true).status, "interrupted");
    } finally {
      store.close();
    }
  } finally {
    release.resolve();
    await fixture.close();
  }
});
