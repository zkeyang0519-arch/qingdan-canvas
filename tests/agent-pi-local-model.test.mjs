import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { VERSION as piVersion } from "qingdan-pi-cli";
import { chatInput } from "../scripts/pi-local/chat-input.mjs";
import { openModelSettings } from "../scripts/pi-local/model-settings.mjs";
import { ModelCatalog } from "../scripts/pi-local/model-catalog.mjs";
import { readModelReply } from "../scripts/pi-local/model-turn.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import {
  callItem,
  openResponsesFixture,
  textItem,
} from "./fixtures/pi-local-responses.mjs";

const nativePiUserAgent = `pi/${piVersion} (${process.platform}; node/${process.version}; ${process.arch})`;

async function scratch(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "pi-rpc-test-"));
  t.after(() => {
    assert.equal(path.dirname(dir), root);
    return rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

test("503 原文和请求 ID 属于失败作业，备用模型使用自己的地址、ID 和密钥", async (t) => {
  const dir = await scratch(t);
  const primary = await openResponsesFixture(() => ({
    httpStatus: 503,
    code: "upstream_busy",
    message: "fixture overloaded local-fixture-only",
    headers: { "x-request-id": "req-fixture" },
  }));
  const backup = await openResponsesFixture(() => textItem("备用回答"));
  const secrets = new Map();
  const credential = (id) => ({
    load: async () => secrets.get(id),
    save: async (v) => secrets.set(id, v),
    clear: async () => secrets.delete(id),
  });
  let catalog = new ModelCatalog(dir, primary.settings, credential);
  const id = await catalog.add({
    service: "备用",
    baseUrl: backup.settings.baseUrl,
    model: "model-b",
    apiKey: "fixture-b",
  });
  catalog.setDefault(id);
  catalog.close();
  catalog = new ModelCatalog(dir, primary.settings, credential);
  const chat = await openPiChat({
    directory: dir,
    settings: primary.settings,
    catalog,
    tools: { references: () => [] },
  });
  try {
    assert.equal(catalog.defaultId, id);
    assert.doesNotMatch(
      JSON.stringify(await catalog.list()),
      /fixture-b|local-fixture-only/,
    );
    const input = { text: "同一条消息", history: [], memories: [] };
    const run = (jobId, modelProfileId) =>
      chat.fetch(
        new Request("https://pi.internal/turn", {
          method: "POST",
          body: JSON.stringify({
            jobId,
            sessionId: randomUUID(),
            modelProfileId,
            input,
            scope: {
              accountId: "pi-local",
              bindingId: "pi-local-binding",
              chatId: "chat",
              userMessageId: "msg",
              visible: [],
            },
          }),
        }),
      );
    const [failure, success] = await Promise.all([
      run("first", "xingchi"),
      run("second", id),
    ]);
    assert.match((await failure.json()).error, /503/);
    assert.equal((await success.json()).text, "备用回答");
    const detail = catalog.diagnostic("first");
    assert.equal(detail.requestId, "req-fixture");
    assert.equal(detail.status, 503);
    assert.match(detail.body, /upstream_busy/);
    assert.doesNotMatch(detail.body, /local-fixture-only/);
    assert.equal(catalog.diagnostic("second"), null);
    assert.deepEqual(
      primary.requests.map((r) => [r.body.model, r.headers.authorization]),
      [["gpt-6.1-sol", "Bearer local-fixture-only"]],
    );
    assert.deepEqual(
      backup.requests.map((r) => [r.body.model, r.headers.authorization]),
      [["model-b", "Bearer fixture-b"]],
    );
  } finally {
    await chat.close();
    catalog.close();
    await primary.close();
    await backup.close();
  }
});

test("本机聊天只从星驰配置读取密钥，热加载后试用状态和 Pi 配置不包含密钥", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, ".dev.vars.pi");
  const settings = await openModelSettings(file, {
    DEEPSEEK_API_KEY: "old",
    OPENAI_API_KEY: "old",
  });
  const template = await readFile(file, "utf8");
  assert.equal(settings.baseUrl, "https://api.xingchiapi.com/v1");
  assert.equal((await settings.status()).configured, false);
  await writeFile(
    file,
    template.replace('XINGCHI_API_KEY=""', 'XINGCHI_API_KEY="private-fixture"'),
  );
  assert.equal(await settings.apiKey(), "private-fixture");
  assert.equal((await settings.status()).runtime, "Pi RPC 1.5.2");
  assert.doesNotMatch(
    JSON.stringify(await settings.status()),
    /private-fixture/,
  );
  const chat = await openPiChat({ directory: dir, settings, tools: {} });
  const profile = await readFile(path.join(dir, "pi-rpc/models.json"), "utf8");
  assert.doesNotMatch(profile, /private-fixture/);
  const provider = JSON.parse(profile).providers.xingchi;
  assert.equal(provider.apiKey, "$XINGCHI_API_KEY");
  assert.equal(new Headers(provider.headers).has("user-agent"), false);
  await chat.close();
  await openModelSettings(file, {});
  assert.equal(await settings.apiKey(), "private-fixture");
  await writeFile(file, template);
  assert.equal((await settings.status()).configured, false);
});

test("Pi RPC 只接收可见对话和工具资料，原生进程发起问答、改词和旧图号的后续调用", async (t) => {
  const dir = await scratch(t);
  const fixture = await openResponsesFixture(
    (_request, count) =>
      [
        textItem("这是普通回答"),
        callItem(
          "codex",
          { action: "revise", brief: "修改第一句" },
          "call_revise_1",
        ),
        textItem("改稿已交付"),
        callItem(
          "waao",
          {
            action: "submit",
            draftId: "adopted",
            assetId: "prior-second",
          },
          "call_submit_2",
        ),
        textItem("拿到了回执"),
      ][count - 1],
  );
  t.after(() => fixture.close());
  const privateBase = {
    accountId: "pi-local",
    bindingId: "pi-local-binding",
    chatId: "local-chat-private",
    visible: ["private-prior"],
  };
  const calls = [];
  const tools = {
    references: (scope) =>
      scope.visible.length
        ? [
            { id: "prior-second", label: "第 1 组 · 图 2" },
            { id: "adopted", label: "稿件 v1" },
          ]
        : [],
    async fetch(req) {
      const { name, args, scope } = await req.json();
      assert.equal(scope.chatId, privateBase.chatId);
      calls.push({ name, args });
      return Response.json(
        name === "codex"
          ? {
              id: "adopted",
              label: "稿件 v1",
              text: "正式改词",
              source: "Codex",
              origin: { threadId: "private-native-thread" },
            }
          : {
              id: "video-task",
              status: "submitted",
              sha256: "private-image-digest",
              target: { team: "private-platform-account" },
            },
      );
    },
  };
  const chat = await openPiChat({
    directory: dir,
    settings: fixture.settings,
    tools,
  });
  t.after(() => chat.close());
  const sessionId = randomUUID();
  async function run(text, history = [], visible = []) {
    const background = {
      recentMessages: history,
      memories: [
        {
          scope: "personal",
          key: "文风",
          value: "简短",
          id: "private-memory-id",
        },
      ],
      project: {
        cwd: "D:/private-project",
        sourceRunId: "private-run",
        stale: false,
        summary: { overview: "短片项目" },
      },
      accountId: "private-acct",
      layout: "private-layout",
    };
    const res = await chat.fetch(
      new Request("https://pi.internal/turn", {
        method: "POST",
        body: JSON.stringify({
          jobId: randomUUID(),
          sessionId,
          scope: { ...privateBase, visible, userMessageId: "private-msg" },
          input: chatInput(text, background),
        }),
      }),
    );
    const result = await res.json();
    assert.equal(res.status, 200, JSON.stringify(result));
    return result.text;
  }
  assert.equal(await run("普通问题"), "这是普通回答");
  const revisionText = "/写旁白\n请改词，保留“红伞”。";
  assert.equal(
    await run(revisionText, [
      { role: "user", text: "普通问题" },
      { role: "assistant", text: "这是普通回答" },
      { role: "system", text: "private-unknown-role" },
    ]),
    "改稿已交付",
  );
  assert.equal(await run("用第二张出片", [], ["private-prior"]), "拿到了回执");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["codex", "waao"],
  );
  assert.equal(calls[1].args.assetId, "prior-second");
  assert.equal(fixture.requests.length, 5);
  const wire = JSON.stringify(fixture.requests.map((r) => [r.headers, r.body]));
  for (const forbidden of [
    "pi-local-binding",
    "local-chat-private",
    "private-prior",
    "private-msg",
    "private-memory-id",
    "private-run",
    "private-layout",
    "private-acct",
    "D:/private-project",
    "private-native-thread",
    "private-platform-account",
    "private-image-digest",
    "private-unknown-role",
    "处理轻单本轮聊天",
    dir.replaceAll("\\", "/"),
    dir,
  ])
    assert.ok(!wire.includes(forbidden), forbidden);
  for (const req of fixture.requests) {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/responses");
    assert.match(req.headers["content-type"], /^application\/json\b/);
    assert.equal(req.headers["user-agent"], nativePiUserAgent);
    assert.equal(req.headers["x-qd-client"], "Qingdan-Agent");
    assert.equal(req.headers.authorization, "Bearer local-fixture-only");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.body.model, "gpt-6.1-sol");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.store, false);
    assert.ok(Array.isArray(req.body.input));
    for (const tool of req.body.tools) {
      assert.equal(tool.type, "function");
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.required.includes("action"));
    }
    assert.deepEqual(req.body.tools.map((t) => t.name).sort(), [
      "codex",
      "waao",
    ]);
  }
  const conversation = fixture.requests[1].body.input.slice(-3);
  assert.deepEqual(
    conversation.map((item) => [
      item.role,
      item.content[0].type,
      item.content[0].text,
    ]),
    [
      ["user", "input_text", "普通问题"],
      ["assistant", "output_text", "这是普通回答"],
      ["user", "input_text", revisionText],
    ],
  );
  for (const [index, name, callId, result] of [
    [2, "codex", "call_revise_1", "正式改词"],
    [4, "waao", "call_submit_2", "video-task"],
  ]) {
    const input = fixture.requests[index].body.input;
    const [call] = input.filter((item) => item.type === "function_call");
    const [receipt] = input.filter(
      (item) => item.type === "function_call_output",
    );
    assert.equal(call.name, name);
    assert.equal(call.call_id, callId);
    assert.equal(receipt.call_id, call.call_id);
    assert.deepEqual(
      JSON.parse(call.arguments),
      calls.find((c) => c.name === name).args,
    );
    assert.ok(JSON.stringify(receipt.output).includes(result));
  }
  assert.match(JSON.stringify(fixture.requests[3].body.input), /prior-second/);
  assert.match(JSON.stringify(fixture.requests[4].body.input), /video-task/);
});

test("原版 Pi 收到客户端拒绝后结束本轮，保留拒绝原因，不切换客户端或派发工具", async (t) => {
  const dir = await scratch(t);
  const fixture = await openResponsesFixture(() => ({
    httpStatus: 403,
    code: "client_not_allowed",
    message: "本站仅支持编程客户端使用",
  }));
  t.after(() => fixture.close());
  const chat = await openPiChat({
    directory: dir,
    settings: fixture.settings,
    tools: {
      references: () => [],
      fetch: () => assert.fail("unexpected tool"),
    },
  });
  t.after(() => chat.close());
  const res = await chat.fetch(
    new Request("https://pi.internal/turn", {
      method: "POST",
      body: JSON.stringify({
        jobId: "job",
        sessionId: randomUUID(),
        scope: {
          accountId: "pi-local",
          bindingId: "pi-local-binding",
          chatId: "chat",
          userMessageId: "msg",
          visible: [],
        },
        input: { text: "请改词", history: [], memories: [] },
      }),
    }),
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /client_not_allowed/);
  assert.deepEqual(
    fixture.requests.map((r) => r.headers["user-agent"]),
    [nativePiUserAgent],
  );
  for (const [message, expected] of [
    ["401 invalid credential", /401.*XINGCHI_API_KEY/],
    ["403 model forbidden", /403.*分组/],
    [
      "xingchi API error (503): Service temporarily unavailable",
      /模型服务暂时不可用（503）/,
    ],
    ["404 model_not_found", /未找到模型/],
  ]) {
    assert.throws(
      () =>
        readModelReply(
          { role: "assistant", stopReason: "error", errorMessage: message },
          "gpt-6.1-sol",
        ),
      expected,
    );
  }
});

test(
  "同一作业只启动一次，取消会中止 Pi，并且其他地址收不到重定向的对话或密钥",
  { timeout: 35000 },
  async (t) => {
    const dir = await scratch(t);
    const sink = await openResponsesFixture(() => textItem("不应被访问"));
    t.after(() => sink.close());
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let redirect = false;
    const fixture = await openResponsesFixture(async () => {
      if (redirect)
        return {
          httpStatus: 307,
          headers: { Location: sink.settings.baseUrl + "/responses" },
        };
      entered.resolve();
      await release.promise;
      return textItem("延迟返回");
    });
    t.after(() => fixture.close());
    const chat = await openPiChat({
      directory: dir,
      settings: fixture.settings,
      tools: { references: () => [] },
    });
    t.after(() => chat.close());
    const sessionId = randomUUID();
    const request = (jobId) =>
      new Request("https://pi.internal/turn", {
        method: "POST",
        body: JSON.stringify({
          jobId,
          sessionId,
          scope: {
            accountId: "pi-local",
            bindingId: "pi-local-binding",
            chatId: "chat",
            userMessageId: jobId,
            visible: [],
          },
          input: { text: "测试", history: [], memories: [] },
        }),
      });
    const first = chat.fetch(request("cancel"));
    await entered.promise;
    const replay = chat.fetch(request("cancel"));
    chat.cancel("cancel");
    try {
      for (const response of await Promise.all([first, replay]))
        assert.match((await response.json()).error, /已停止/);
      assert.equal(fixture.requests.length, 1);
    } finally {
      release.resolve();
    }
    redirect = true;
    assert.equal((await chat.fetch(request("redirect"))).status, 502);
    assert.equal(sink.requests.length, 0);
  },
);
