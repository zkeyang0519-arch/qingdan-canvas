import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";

test("人工连接请求按项目持久化，稍后回答可恢复，同一回答只处理一次", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "human-questions-"));
  let ready = true,
    probes = 0;
  const service = {
    connect: async () => {
      probes++;
      if (!ready)
        throw Object.assign(Error("请先登录 Codex。"), {
          code: "CODEX_LOGIN_REQUIRED",
        });
      return {
        listTools: async () => [
          { name: "codex", inputSchema: { type: "object" } },
        ],
        close: async () => {},
      };
    },
  };
  let manager = new McpConnections(dir, { codexService: service });
  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await manager.initialCheck;
  manager.setSelection("project", "builtin-codex", ["codex"]);
  ready = false;
  await manager.action("project", { id: "builtin-codex", action: "test" });
  const [question] = manager.questions("project");
  assert.ok(question);
  assert.deepEqual(manager.questions("other"), []);
  const deferred = await manager.answerQuestion("project", {
    id: question.id,
    requestId: "answer-defer-1",
    decision: "defer",
    note: "晚点处理",
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.questions[0].deferred, true);
  await manager.close();
  manager = new McpConnections(dir, { codexService: service });
  await manager.initialCheck;
  assert.equal(manager.questions("project")[0].note, "晚点处理");
  ready = true;
  const before = probes;
  const answer = {
    id: question.id,
    requestId: "answer-retry-1",
    decision: "retry",
    note: "已经登录",
  };
  assert.equal(
    (await manager.answerQuestion("project", answer)).status,
    "done",
  );
  assert.equal(
    (await manager.answerQuestion("project", answer)).status,
    "done",
  );
  assert.equal(probes, before + 1);
  assert.deepEqual(manager.questions("project"), []);
  await assert.rejects(manager.answerQuestion("other", answer), /内容已变化/);
  assert.equal(
    manager.questionReceipt("project", answer.requestId).status,
    "done",
  );
});

test("过期提问不能改变工具选择，停用只影响当前项目", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "human-stale-"));
  let ready = true;
  const manager = new McpConnections(dir, {
    codexService: {
      connect: async () => {
        if (!ready)
          throw Object.assign(Error("请先登录"), {
            code: "CODEX_LOGIN_REQUIRED",
          });
        return {
          listTools: async () => [
            { name: "codex", inputSchema: { type: "object" } },
          ],
          close: async () => {},
        };
      },
    },
  });
  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await manager.initialCheck;
  for (const project of ["one", "two"])
    manager.setSelection(project, "builtin-codex", ["codex"]);
  ready = false;
  await manager.probe("builtin-codex");
  const [old] = manager.questions("one");
  ready = true;
  await manager.probe("builtin-codex");
  await assert.rejects(
    manager.answerQuestion("one", {
      id: old.id,
      requestId: "stale-request",
      decision: "disable",
      note: "",
    }),
    /状态已变化/,
  );
  ready = false;
  await manager.probe("builtin-codex");
  const [current] = manager.questions("one");
  await manager.answerQuestion("one", {
    id: current.id,
    requestId: "disable-request",
    decision: "disable",
    note: "",
  });
  assert.deepEqual(manager.list("one")[0].selected, []);
  assert.deepEqual(manager.list("two")[0].selected, ["codex"]);
});
