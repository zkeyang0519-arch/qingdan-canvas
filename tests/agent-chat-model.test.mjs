import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = path.join(root, ".tmp");
await mkdir(tmp, { recursive: true });
const dir = await mkdtemp(path.join(tmp, "chat-model-tests-"));
test.after(() => rm(dir, { recursive: true, force: true }));
const outfile = path.join(dir, "chat-model.mjs");
await build({
  entryPoints: [path.join(root, "worker/agent/chat-model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const { chatModelStatus, generateChatReply, ChatModelError } = await import(
  pathToFileURL(outfile)
);

const env = { ROUTER_API_KEY: "fake-test-key", ROUTER_MODEL: "fixture-model" };
const context = {
  instructions: "按项目记忆使用简体中文回复。",
  messages: [
    { role: "user", content: "上次说到哪里？" },
    { role: "assistant", content: "已经整理过报告。" },
    { role: "user", content: "列出后续待办。" },
  ],
};
const reply = {
  text: "建议先核对报告。",
  tasks: [
    {
      text: "核对报告",
      instruction: "核对报告中的日期。",
      acceptance: "日期一致。",
    },
  ],
  memories: [{ scope: "project", key: "报告语言", value: "简体中文" }],
};
const responseEnvelope = (value = JSON.stringify(reply)) => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: value }],
    },
  ],
  usage: { input_tokens: 28, output_tokens: 15 },
});
const completionsEnvelope = (value = JSON.stringify(reply)) => ({
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: value, refusal: null },
    },
  ],
  usage: { prompt_tokens: 31, completion_tokens: 12 },
});

test("Workerd sends the model request and rejects redirects without forwarding credentials", async (t) => {
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    new URL("../node_modules/wrangler/package.json", import.meta.url),
  )("miniflare");
  const workerPath = path.join(dir, "workerd-model.mjs");
  await build({
    stdin: {
      contents: `
        import { generateChatReply } from "./worker/agent/chat-model";
        export default {
          async fetch(request, env) {
            try {
              const result = await generateChatReply(env, {
                instructions: "Return JSON.",
                messages: [{ role: "user", content: new URL(request.url).pathname }],
              });
              return Response.json(result);
            } catch (error) {
              return Response.json({ code: error.code }, { status: 502 });
            }
          },
        };
      `,
      resolveDir: root,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "browser"],
    outfile: workerPath,
  });
  const outbound = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "chat-model-fetch-test",
      modules: true,
      scriptPath: workerPath,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ...env,
        ROUTER_BASE_URL: "https://model.example",
        ROUTER_API_FORMAT: "chat_completions",
      },
      outboundService: async (request) => {
        outbound.push({
          url: request.url,
          authorized:
            request.headers.get("authorization") === "Bearer fake-test-key",
        });
        if (new URL(request.url).hostname !== "model.example")
          return new Response("unexpected redirect target");
        const body = await request.json();
        if (body.messages.at(-1).content === "/redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://redirected.example/" },
          });
        return Response.json(completionsEnvelope());
      },
    }),
  );
  t.after(() => mf.dispose());
  const ok = await mf.dispatchFetch("https://worker.example/success");
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).reply, reply);
  const redirect = await mf.dispatchFetch("https://worker.example/redirect");
  assert.equal(redirect.status, 502);
  assert.deepEqual(await redirect.json(), { code: "MODEL_UNAVAILABLE" });
  assert.deepEqual(outbound, [
    { url: "https://model.example/chat/completions", authorized: true },
    { url: "https://model.example/chat/completions", authorized: true },
  ]);
});

test("Responses sends instructions and chronological messages in one bounded request", async () => {
  let calls = 0;
  const result = await generateChatReply(env, context, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer fake-test-key",
    );
    const body = JSON.parse(init.body);
    assert.equal(body.model, "fixture-model");
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 8192);
    assert.equal(body.instructions, context.instructions);
    assert.deepEqual(body.input, context.messages);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(
      new Set(body.text.format.schema.required),
      new Set(["text", "tasks", "memories"]),
    );
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.ok(!init.body.includes(env.ROUTER_API_KEY));
    return Response.json(responseEnvelope());
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    reply,
    usage: { inputTokens: 28, outputTokens: 15 },
  });
});

test("Chat Completions compatible endpoint receives JSON instructions with its base path intact", async () => {
  const config = {
    ...env,
    ROUTER_BASE_URL: "https://model.example/api/v1/",
    ROUTER_API_FORMAT: "chat_completions",
  };
  const result = await generateChatReply(config, context, async (url, init) => {
    assert.equal(String(url), "https://model.example/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, "system");
    assert.ok(body.messages[0].content.includes(context.instructions));
    assert.match(body.messages[0].content, /JSON/u);
    assert.deepEqual(body.messages.slice(1), context.messages);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.max_completion_tokens, 8192);
    assert.equal(body.tools, undefined);
    assert.ok(!String(url).includes(env.ROUTER_API_KEY));
    return Response.json(completionsEnvelope());
  });
  assert.deepEqual(result, {
    reply,
    usage: { inputTokens: 31, outputTokens: 12 },
  });
});

test("DeepSeek uses its Chat Completions token limit, non-thinking mode, and a JSON example", async () => {
  for (const basePath of ["", "/v1"]) {
    const config = {
      ...env,
      ROUTER_MODEL: "deepseek-flash",
      ROUTER_BASE_URL: `https://api.deepseek.com${basePath}`,
      ROUTER_API_FORMAT: "chat_completions",
    };
    const result = await generateChatReply(
      config,
      context,
      async (url, init) => {
        assert.equal(
          String(url),
          `https://api.deepseek.com${basePath}/chat/completions`,
        );
        const body = JSON.parse(init.body);
        assert.equal(body.model, "deepseek-flash");
        assert.equal(body.max_tokens, 8192);
        assert.equal(body.max_completion_tokens, undefined);
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.match(body.messages[0].content, /示例[^\n]*\n\{"text":/u);
        return Response.json(completionsEnvelope());
      },
    );
    assert.deepEqual(result.reply, reply);
  }
});

test("invalid configuration never dispatches a model request or exposes credentials", async () => {
  assert.deepEqual(chatModelStatus(env), {
    configured: true,
    model: "fixture-model",
    format: "responses",
    host: "api.openai.com",
  });
  for (const config of [
    {},
    { ...env, ROUTER_MODEL: " " },
    { ...env, ROUTER_API_FORMAT: "invalid-secret" },
    { ...env, ROUTER_BASE_URL: "http://model.example/v1" },
    { ...env, ROUTER_BASE_URL: "https://user:secret@model.example/v1" },
    { ...env, ROUTER_BASE_URL: "https://model.example/v1?key=secret" },
    { ...env, ROUTER_BASE_URL: "https://model.example/v1#secret" },
  ]) {
    const status = chatModelStatus(config);
    assert.equal(status.configured, false);
    assert.doesNotMatch(JSON.stringify(status), /secret|fake-test-key/u);
    let calls = 0;
    await assert.rejects(
      generateChatReply(config, context, async () => {
        calls++;
        return Response.json(responseEnvelope());
      }),
      { code: "MODEL_NOT_CONFIGURED" },
    );
    assert.equal(calls, 0);
  }
});

test("provider failures use safe codes and do not retry or echo response bodies", async () => {
  for (const [status, code] of [
    [401, "MODEL_AUTH_FAILED"],
    [429, "MODEL_RATE_LIMITED"],
    [503, "MODEL_UNAVAILABLE"],
  ]) {
    let calls = 0;
    await assert.rejects(
      generateChatReply(env, context, async () => {
        calls++;
        return new Response("raw provider error fake-test-key", { status });
      }),
      (error) =>
        error instanceof ChatModelError &&
        error.code === code &&
        !/raw provider error|fake-test-key/u.test(error.message),
    );
    assert.equal(calls, 1);
  }
});

test("both response formats reject incomplete, refused, and invalid suggestions", async () => {
  for (const [format, body, code] of [
    [
      "responses",
      { ...responseEnvelope(), status: "incomplete" },
      "MODEL_INCOMPLETE",
    ],
    [
      "responses",
      {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "private provider data" }],
          },
        ],
      },
      "MODEL_REFUSED",
    ],
    ["responses", responseEnvelope("{"), "MODEL_INVALID_RESPONSE"],
    [
      "responses",
      responseEnvelope(JSON.stringify({ ...reply, execute: true })),
      "MODEL_INVALID_RESPONSE",
    ],
    [
      "chat_completions",
      {
        choices: [
          { ...completionsEnvelope().choices[0], finish_reason: "length" },
        ],
      },
      "MODEL_INCOMPLETE",
    ],
    [
      "chat_completions",
      {
        choices: [
          {
            finish_reason: "stop",
            message: { refusal: "private provider data" },
          },
        ],
      },
      "MODEL_REFUSED",
    ],
    [
      "chat_completions",
      completionsEnvelope('{"text":"missing arrays"}'),
      "MODEL_INVALID_RESPONSE",
    ],
  ]) {
    await assert.rejects(
      generateChatReply(
        { ...env, ROUTER_API_FORMAT: format },
        context,
        async () => Response.json(body),
      ),
      (error) =>
        error instanceof ChatModelError &&
        error.code === code &&
        !error.message.includes("private provider data"),
    );
  }
});

test("response byte cap applies to streams without Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    generateChatReply(env, context, async () => new Response(body)),
    { code: "MODEL_RESPONSE_TOO_LARGE" },
  );
  assert.equal(cancelled, true);
});

test("a provider response reporting more than the requested token budget is rejected", async () => {
  const body = responseEnvelope();
  body.usage.output_tokens = 8193;
  await assert.rejects(
    generateChatReply(env, context, async () => Response.json(body)),
    { code: "MODEL_RESPONSE_TOO_LARGE" },
  );
});

test("the 45 second timeout covers a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = generateChatReply(env, context, async (_, init) => {
    signal = init.signal;
    return new Response(new ReadableStream());
  });
  const timedOut = assert.rejects(pending, { code: "MODEL_TIMEOUT" });
  await Promise.resolve();
  t.mock.timers.tick(44_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await timedOut;
  assert.equal(signal.aborted, true);
});
