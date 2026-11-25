import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { openMainPi } from "../scripts/pi-main/server.mjs";
import {
  callItem,
  textItem,
  openResponsesFixture,
} from "./fixtures/pi-local-responses.mjs";

const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test(
  "主聊天沿用账号、会话、两种模型接口和已选 MCP，校验身份且不落盘模型密钥",
  { timeout: 60000 },
  async (t) => {
    const workspace = process.cwd(),
      rootDir = path.resolve(".tmp");
    await mkdir(rootDir, { recursive: true });
    const root = await mkdtemp(path.join(rootDir, "main-pi-"));
    let mf, bridge;
    const errors = [],
      transports = [];
    const completions = [];
    const second = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      completions.push({
        body: JSON.parse(raw),
        path: req.url,
        auth: req.headers.authorization,
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            id: "chat-2",
            object: "chat.completion.chunk",
            model: "model-b",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "第二个模型的回复" },
                finish_reason: null,
              },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "chat-2",
            object: "chat.completion.chunk",
            model: "model-b",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
    const primary = await openResponsesFixture((request, n) => {
      assert.equal(request.body.model, "model-a");
      assert.equal(request.headers.authorization, "Bearer fake-primary-key");
      assert.ok(
        request.body.tools.some((tool) => tool.name === "mcp__codex__query"),
      );
      assert.doesNotMatch(
        JSON.stringify(request.body.input),
        /没有读取代码或执行任务的工具/,
      );
      const call = (name, args) => callItem(name, args, "main_" + n);
      if (n === 1)
        return call("update_task", {
          requirements: [
            { id: "query", description: "查询真实能力", check: "tool_result" },
          ],
        });
      if (n === 2) return call("mcp__codex__query", {});
      if (n === 3)
        return call("propose_reply", {
          tasks: [
            {
              text: "检查接口",
              instruction: "检查接口回执",
              acceptance: "回执可核对",
            },
          ],
        });
      if (n === 4)
        return call("submit_result", {
          summary: "已查询",
          checks: [
            {
              requirementId: "query",
              evidenceIds: [
                JSON.stringify(request.body.input).match(/ev_[a-f0-9-]{36}/)[0],
              ],
              explanation: "实际目录查询成功",
            },
          ],
        });
      return textItem("主聊天已取得工具回执。");
    });
    t.after(async () => {
      await bridge?.close();
      await mf?.dispose();
      await primary.close();
      second.closeAllConnections();
      await new Promise((resolve) => second.close(resolve));
      assert.equal(path.dirname(root), rootDir);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const legacy = path.join(root, ".tmp/pi-local/live");
    await mkdir(legacy, { recursive: true });
    const old = new DatabaseSync(path.join(legacy, "mcp-connections.sqlite"));
    old.exec(`CREATE TABLE servers(id TEXT PRIMARY KEY,name TEXT,url TEXT,authMode TEXT,status TEXT,catalog TEXT);
    CREATE TABLE selections(binding TEXT,server TEXT,tools TEXT);
    INSERT INTO servers VALUES('builtin-codex','Codex','stdio:codex','local','ready','[]');
    INSERT INTO selections VALUES('pi-local-binding','builtin-codex','["query"]');`);
    old.close();
    let mcpCalls = 0;
    const noTools = {
      connect: async () => ({
        listTools: async () => [],
        close: async () => {},
      }),
      statusOfConnection: () => ({ connected: false }),
    };
    const toolModule = {
      openTools: () => ({
        references: () => [],
        context: () => [],
        decorate: (x) => x,
        close() {},
      }),
      mcpCredentialFile: () => ({ load: async () => ({}) }),
    };
    bridge = await openMainPi({
      root,
      profile: {
        ownerId: "alice",
        mappings: [{ from: "pi-local-binding", to: "binding" }],
      },
      environment: {},
      toolModule,
      onError: (error) => errors.push(error.message),
      services: {
        login: {},
        waao: noTools,
        codex: {
          connect: async () => ({
            listTools: async () => [
              {
                name: "query",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
            callTool: async () => {
              mcpCalls++;
              return { content: [{ type: "text", text: "实时工具可用" }] };
            },
            close: async () => {},
          }),
        },
      },
      fetchImpl: async (url, init) => {
        const response = await mf.dispatchFetch(
          "https://app.test" + new URL(url).pathname,
          init,
        );
        if (!response.ok) return response;
        const context = await response.json();
        assert.equal(
          context.model.baseUrl,
          context.model.model === "model-a"
            ? "https://primary.example/v1"
            : "https://secondary.example/v1",
        );
        context.model.baseUrl =
          context.model.model === "model-a"
            ? primary.settings.baseUrl
            : `http://127.0.0.1:${second.address().port}/v1`;
        return Response.json(context);
      },
    });
    assert.equal(
      (await fetch(bridge.url + "/state", { method: "POST", body: "{}" }))
        .status,
      403,
    );
    await build({
      stdin: {
        resolveDir: workspace,
        contents: `
    export {default} from './worker/index';
    export {AgentChatRouter as Chat} from './worker/agent-runtime';
  `,
      },
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "browser"],
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: path.join(root, "worker.mjs"),
      logLevel: "silent",
    });
    const options = convertV4MiniflareOptions({
      name: "main-pi",
      scriptPath: path.join(root, "worker.mjs"),
      modules: true,
      port: 0,
      inspectorPort: 0,
      cf: false,
      log: new Log(LogLevel.ERROR),
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      durableObjects: { AGENT_CHATS: { className: "Chat", useSQLite: true } },
      bindings: {
        APP_ENV: "test",
        CHAT_ENABLED: "true",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        LOCAL_PI_URL: bridge.url,
        LOCAL_PI_SECRET: bridge.secret,
        LOCAL_PI_OWNER: "alice",
        FIXTURE_A: primary.settings.baseUrl,
        FIXTURE_B: `http://127.0.0.1:${second.address().port}/v1`,
      },
      outboundService: async (request) => {
        transports.push({ incoming: request.url });
        if (
          new URL(request.url).hostname === "primary.example" ||
          new URL(request.url).hostname === "secondary.example"
        ) {
          const input = await request.json();
          transports.push({
            retentionModel: input.model,
            retentionLimit:
              input.max_output_tokens || input.max_completion_tokens,
          });
          return Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      text: JSON.stringify({ candidates: [] }),
                      tasks: [],
                      memories: [],
                    }),
                  },
                ],
              },
            ],
          });
        }
        try {
          const response = await fetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            ...(request.method === "GET" || request.method === "HEAD"
              ? {}
              : { body: await request.arrayBuffer() }),
            redirect: "manual",
          });
          transports.push({ url: request.url, status: response.status });
          return response;
        } catch (error) {
          transports.push({
            error: error.message,
            cause: error.cause?.message,
          });
          throw error;
        }
      },
    });
    Object.assign(options, {
      isolatedResourcePersistencePath: path.join(root, "isolated"),
      resourcePersistencePath: path.join(root, "state"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(root, "registry"),
    });
    mf = new Miniflare(options);
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.batch(
        (await readFile(path.join("migrations", file), "utf8"))
          .replace(/^--.*$/gm, "")
          .split(";")
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
      );
    const tokens = { alice: "a".repeat(64), bob: "b".repeat(64) };
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026'),('bob','bob','Bob','hash','2026')",
      ),
      ...Object.entries(tokens).map(([id, token]) =>
        db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(
            createHash("sha256").update(token).digest("hex"),
            id,
            Date.now() + 3600000,
          ),
      ),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
      ),
      db.prepare("INSERT INTO members VALUES('canvas','alice','owner','2026')"),
      db
        .prepare(
          "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json) VALUES('runner','alice','Device','secret',?)",
        )
        .bind(
          JSON.stringify([
            {
              workspaceId: "workspace",
              name: "Test",
              displayPath: "D:/test",
              revision: 1,
              checks: [],
            },
          ]),
        ),
      db.prepare(
        "INSERT INTO agent_bindings VALUES('binding','alice','canvas','ungrouped','runner','workspace',1,1)",
      ),
    ]);
    async function call(route, input, user = "alice") {
      const response = await mf.dispatchFetch("https://app.test" + route, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Origin: "https://app.test",
          Cookie: "qd_session=" + tokens[user],
          "X-QD-Account": user,
          "Content-Type": "application/json",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, ...(await response.json()) };
    }
    const a = await call("/api/agent/chat/models", {
      action: "add",
      service: "Primary",
      model: "model-a",
      baseUrl: "https://primary.example/v1",
      apiKey: "fake-primary-key",
      apiFormat: "responses",
    });
    const b = await call("/api/agent/chat/models", {
      action: "add",
      service: "Secondary",
      model: "model-b",
      baseUrl: "https://secondary.example/v1",
      apiKey: "fake-secondary-key",
      apiFormat: "chat_completions",
    });
    const thread = await call("/api/agent/chat/new", {
      requestId: "new-main",
      bindingId: "binding",
      bindingRevision: 1,
    });
    assert.equal(thread.modelProfileId, a.added);
    const state = () =>
      call(`/api/agent/chat/state?bindingId=binding&chatId=${thread.id}`);
    const before = await state();
    assert.equal(before.provider.runtime, "Pi harness");
    assert.equal(
      before.mcpAvailable,
      true,
      JSON.stringify({ before, errors, transports }),
    );
    const tools = await call("/local/mcp?bindingId=binding");
    assert.deepEqual(
      tools.servers.find((s) => s.id === "builtin-codex").selected,
      ["query"],
    );
    assert.equal(
      (await call("/local/mcp?bindingId=binding", undefined, "bob")).status,
      503,
    );
    assert.equal((await call("/local/mcp?bindingId=foreign")).status, 403);
    assert.equal(
      (await call("/api/internal/pi/context", { jobId: "fake" })).status,
      403,
    );
    async function settle() {
      for (let n = 0; n < 150; n++) {
        const value = await state();
        if (["succeeded", "failed"].includes(value.job?.status)) return value;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.fail("主聊天未结束");
    }
    await call("/api/agent/chat/send", {
      requestId: "first-main",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "查询当前工具能力并给我一个待办",
    });
    const first = await settle();
    assert.equal(first.job.status, "succeeded", JSON.stringify(first.job));
    assert.equal(first.harnessTask.status, "completed");
    assert.equal(mcpCalls, 1);
    assert.equal(first.messages.at(-1).tasks.length, 1);
    for (let n = 0; n < 100; n++) {
      const current = await state();
      if (current.retention?.jobs?.some((job) => job.status === "skipped"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      transports.some(
        (call) =>
          call.retentionModel === "model-a" && call.retentionLimit === 2400,
      ),
      "completed Pi task uses the original existing model for one bounded review",
    );
    assert.equal((await state()).retention.jobs[0].status, "skipped");
    await call("/api/agent/chat/models", { action: "default", id: b.added });
    assert.equal((await state()).thread.modelProfileId, a.added);
    await call("/api/agent/chat/select-model", {
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      modelProfileId: b.added,
    });
    await call("/api/agent/chat/send", {
      requestId: "second-main",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "你好",
    });
    const after = await settle();
    assert.equal(after.job.status, "succeeded", JSON.stringify(after.job));
    assert.equal(after.thread.id, thread.id);
    assert.equal(after.thread.modelProfileId, b.added);
    assert.equal(completions[0].path, "/v1/chat/completions");
    assert.equal(completions[0].body.model, "model-b");
    assert.equal(completions[0].auth, "Bearer fake-secondary-key");
    assert.doesNotMatch(
      JSON.stringify(after),
      /fake-primary-key|fake-secondary-key|LOCAL_PI_SECRET/,
    );
    const checkpoint = await readFile(
      path.join(bridge.directory, "task-harness.sqlite"),
    );
    assert.equal(checkpoint.includes(Buffer.from("fake-primary-key")), false);
    const wrongScope = await fetch(bridge.url + "/state", {
      method: "POST",
      headers: { Authorization: "Bearer " + bridge.secret },
      body: JSON.stringify({ accountId: "alice", scope: { accountId: "bob" } }),
    });
    assert.equal(wrongScope.status, 403);
    await bridge.close();
    await call("/api/agent/chat/send", {
      requestId: "offline-main",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "再次核对",
    });
    const offline = await settle();
    assert.equal(offline.job.status, "failed");
    assert.match(offline.harnessUnavailable, /暂时不可用/);
    assert.equal(
      completions.length,
      1,
      "Pi 故障不能退回直接调用模型的无工具路径",
    );
  },
);
