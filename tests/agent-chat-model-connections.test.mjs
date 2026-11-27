import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test(
  "full workspace BYOK connections are private, durable and used by the selected chat model",
  { timeout: 60000 },
  async (t) => {
    const root = process.cwd(),
      tmp = path.resolve(".tmp");
    await mkdir(tmp, { recursive: true });
    const dir = await mkdtemp(path.join(tmp, "byok-full-"));
    let mf, releaseModel;
    let holdNextModel = false;
    t.after(async () => {
      releaseModel?.();
      await mf?.dispose();
      assert.equal(path.dirname(dir), tmp);
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    });
    await build({
      stdin: {
        contents:
          "export {default} from './worker/index'; export {AgentChatRouter} from './worker/agent/chat-router';",
        resolveDir: root,
      },
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "browser"],
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: path.join(dir, "worker.mjs"),
      logLevel: "silent",
    });
    const calls = [];
    const options = convertV4MiniflareOptions({
      name: "byok-full",
      scriptPath: path.join(dir, "worker.mjs"),
      modules: true,
      port: 0,
      inspectorPort: 0,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: {
        AGENT_CHATS: { className: "AgentChatRouter", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        CHAT_ENABLED: "true",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
      },
      outboundService: async (request) => {
        const body = await request.json();
        calls.push({
          url: request.url,
          key: request.headers.get("authorization"),
          body,
        });
        if (holdNextModel) {
          holdNextModel = false;
          await new Promise((resolve) => {
            releaseModel = resolve;
          });
        }
        const content = JSON.stringify({
          text: "独立连接回复",
          tasks: [],
          memories: [],
        });
        return Response.json(
          request.url.endsWith("/responses")
            ? {
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: content }],
                  },
                ],
              }
            : {
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                  },
                ],
              },
        );
      },
    });
    Object.assign(options, {
      isolatedResourcePersistencePath: path.join(dir, "isolated"),
      resourcePersistencePath: path.join(dir, "state"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(dir, "registry"),
    });
    mf = new Miniflare(options);
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const statements = (await readFile(path.join("migrations", file), "utf8"))
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((s) => s.trim());
      await db.batch(statements.map((s) => db.prepare(s)));
    }
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
    const call = async (action, input, user = "alice", headers = {}) => {
      const response = await mf.dispatchFetch(
        "https://app.test/api/agent/chat/" + action,
        {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Cookie: "qd_session=" + tokens[user],
            "X-QD-Account": user,
            "Content-Type": "application/json",
            Origin: "https://app.test",
            ...headers,
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
      );
      return { status: response.status, ...(await response.json()) };
    };
    const primary = {
      action: "add",
      service: "我的接口",
      model: "byok-one",
      baseUrl: "https://models.example.com/v1/responses",
      apiKey: "fake-byok-key-one",
      apiFormat: "responses",
    };
    const added = await call("models", primary);
    assert.equal(added.status, 200);
    assert.equal(added.defaultId, added.added);
    assert.equal(
      added.profiles.find((p) => p.id === added.added).baseUrl,
      "https://models.example.com/v1",
    );
    assert.doesNotMatch(JSON.stringify(added), /fake-byok-key|apiKey/);
    assert.equal(
      calls.length,
      0,
      "creating a connection must not call a paid model",
    );
    const foreign = await call("models", undefined, "bob");
    assert.equal(foreign.profiles.length, 1);
    assert.equal(
      (await call("models", { action: "default", id: added.added }, "bob"))
        .status,
      404,
    );
    assert.equal(
      (await call("models", undefined, "alice", { "X-QD-Account": "bob" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("models", primary, "alice", {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    for (const url of [
      "http://models.example.com",
      "https://127.0.0.1/v1",
      "https://localhost/v1",
      "https://localhost./v1",
      "https://user:secret@models.example.com/v1",
      "https://models.example.com/?key=secret",
    ]) {
      const rejected = await call("models", { ...primary, baseUrl: url });
      assert.equal(rejected.status, 400, url);
      assert.doesNotMatch(
        JSON.stringify(rejected),
        /fake-byok-key|user:secret|key=secret/,
      );
    }
    const thread = await call("new", {
      requestId: "new-one",
      bindingId: "binding",
      bindingRevision: 1,
      defaultProfileId: "foreign-id",
    });
    assert.equal(thread.modelProfileId, added.added);
    const state = () => call("state?bindingId=binding&chatId=" + thread.id);
    const settle = async () => {
      for (let n = 0; n < 100; n++) {
        const value = await state();
        if (["succeeded", "failed"].includes(value.job?.status)) return value;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.fail("reply did not settle");
    };
    await call("send", {
      requestId: "send-one",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "你好",
    });
    assert.equal((await settle()).job.status, "succeeded");
    assert.equal(calls[0].key, "Bearer fake-byok-key-one");
    assert.equal(calls[0].body.model, "byok-one");
    const second = await call("models", {
      ...primary,
      service: "第二接口",
      model: "byok-two",
      baseUrl: "https://backup.example.com/v1",
      apiKey: "fake-byok-key-two",
      apiFormat: "chat_completions",
    });
    await call("models", { action: "default", id: second.added });
    assert.equal((await state()).thread.modelProfileId, added.added);
    assert.equal(
      (
        await call("select-model", {
          bindingId: "binding",
          bindingRevision: 1,
          chatId: thread.id,
          modelProfileId: "foreign-id",
        })
      ).status,
      404,
    );
    await call("select-model", {
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      modelProfileId: second.added,
    });
    await call("send", {
      requestId: "send-two",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "继续",
    });
    const after = await settle();
    assert.equal(after.job.status, "succeeded");
    assert.equal(calls[1].key, "Bearer fake-byok-key-two");
    assert.equal(calls[1].body.model, "byok-two");
    assert.equal(
      calls[1].url,
      "https://backup.example.com/v1/chat/completions",
    );
    assert.doesNotMatch(JSON.stringify(after), /fake-byok-key|apiKey/);
    await mf.dispose();
    mf = new Miniflare(options);
    const restored = await call("models");
    assert.equal(restored.defaultId, second.added);
    assert.equal(restored.profiles.length, 3);
    assert.equal((await state()).thread.modelProfileId, second.added);
    holdNextModel = true;
    await call("send", {
      requestId: "before-edit",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "编辑前启动",
    });
    const deadline = Date.now() + 10000;
    while (calls.length < 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 3);
    const edit = {
      action: "update",
      id: second.added,
      service: "修改后的接口",
      model: "byok-three",
      baseUrl: "https://revised.example.com/api/v3",
      apiFormat: "responses",
      apiKey: "",
    };
    assert.equal(
      (await call("models", edit)).status,
      400,
      "新域名不能默默沿用密钥",
    );
    assert.equal(
      (await call("models", { ...edit, reuseApiKey: true }, "bob")).status,
      404,
    );
    const updated = await call("models", { ...edit, reuseApiKey: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.replaced, second.added);
    assert.equal(
      (await call("models", { ...edit, reuseApiKey: true })).updated,
      updated.updated,
      "丢失保存回执后重试复用同一版本",
    );
    assert.notEqual(updated.updated, second.added);
    assert.equal(updated.defaultId, updated.updated);
    assert.equal(updated.profiles.length, 3);
    assert.equal(
      updated.profiles.some((p) => p.id === second.added),
      false,
    );
    assert.equal((await state()).thread.modelProfileId, updated.updated);
    assert.equal(
      (await call("models", { action: "delete", id: updated.updated })).status,
      409,
      "旧设置仍有任务运行时不能删除整个连接",
    );
    releaseModel();
    assert.equal((await settle()).job.status, "succeeded");
    assert.equal(calls[2].body.model, "byok-two");
    assert.equal(calls[2].key, "Bearer fake-byok-key-two");
    await call("send", {
      requestId: "after-edit",
      bindingId: "binding",
      bindingRevision: 1,
      chatId: thread.id,
      text: "编辑后启动",
    });
    const newest = await settle();
    assert.equal(newest.job.status, "succeeded");
    assert.equal(calls[3].body.model, "byok-three");
    assert.equal(calls[3].url, "https://revised.example.com/api/v3/responses");
    assert.equal(
      calls[3].key,
      "Bearer fake-byok-key-two",
      "密钥留空保留现有值",
    );
    assert.equal(
      (
        await call("select-model", {
          bindingId: "binding",
          bindingRevision: 1,
          chatId: thread.id,
          modelProfileId: second.added,
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("models", { action: "delete", id: added.added }, "bob"))
        .status,
      404,
    );
    const removed = await call("models", {
      action: "delete",
      id: updated.updated,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.deleted, updated.updated);
    assert.equal(
      (await call("models", { action: "delete", id: updated.updated })).deleted,
      updated.updated,
    );
    assert.equal(removed.defaultId, "unselected");
    const afterDelete = await state();
    assert.equal(afterDelete.provider.configured, false);
    assert.equal(afterDelete.messages.length, newest.messages.length);
    assert.equal(
      (
        await call("send", {
          requestId: "deleted-model",
          bindingId: "binding",
          bindingRevision: 1,
          chatId: thread.id,
          text: "不可使用已删除连接",
        })
      ).status,
      404,
    );
    assert.equal(calls.length, 4);
    assert.doesNotMatch(
      JSON.stringify({ updated, removed, afterDelete }),
      /fake-byok-key|apiKey/,
    );
    assert.equal(
      (await call("models", { action: "delete", id: "xingchi" })).status,
      400,
    );
    await mf.dispose();
    mf = new Miniflare(options);
    const deletedRestart = await call("models");
    assert.equal(deletedRestart.profiles.length, 2);
    assert.equal(deletedRestart.defaultId, "unselected");
    assert.equal((await state()).provider.configured, false);
  },
);
