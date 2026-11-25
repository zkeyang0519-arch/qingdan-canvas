import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { codexMcpId, localCodexMcp } from "../scripts/pi-local/codex-mcp.mjs";

async function fixture(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "pi-codex-mcp-"));
  await build({
    entryPoints: ["scripts/pi-local/codex-mcp-server.mjs"],
    outfile: path.join(dir, "codex-mcp-server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const codexService = localCodexMcp(dir, {
    command: process.execPath,
    args: [path.resolve("tests/fixtures/codex-mcp-app-server.mjs"), dir],
  });
  let manager = new McpConnections(dir, { codexService });
  await manager.initialCheck;
  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    codexService,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.close();
      manager = new McpConnections(dir, { codexService });
      await manager.initialCheck;
    },
    async events() {
      return (
        await readFile(path.join(dir, "events.jsonl"), "utf8").catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    },
  };
}
const scope = {
  accountId: "pi-local",
  bindingId: "project-a",
  chatId: "chat-a",
  userMessageId: "first",
  visible: [],
};
const fresh = "mcp__codex__codex",
  reply = "mcp__codex__codex_reply";
async function call(manager, context, name, args) {
  const turn = manager.turn(context);
  try {
    return await turn.execute(
      name,
      args,
      randomUUID(),
      AbortSignal.timeout(15000),
    );
  } finally {
    await turn.close();
  }
}

test("Codex 新版本按实际握手检测，非 Codex 版本输出仍拒绝", async (t) => {
  const app = await fixture(t);
  assert.equal(app.manager.list(scope.bindingId)[0].status, "ready");
  const versionFile = path.join(app.dir, "codex-version.txt");
  await writeFile(versionFile, "0.171.0-alpha.13");
  assert.equal(
    (
      await app.manager.action(scope.bindingId, {
        id: codexMcpId,
        action: "test",
      })
    ).status,
    "ready",
  );
  await writeFile(versionFile, "0.171.0-alpha.13.3");
  const updated = await app.codexService.connect(AbortSignal.timeout(15000));
  await updated.close();
  await writeFile(versionFile, "0.172.0-alpha.1");
  await writeFile(path.join(app.dir, "listen-only"), "true");
  const transportUpdated = await app.codexService.connect(
    AbortSignal.timeout(15000),
  );
  await transportUpdated.close();
  await rm(path.join(app.dir, "listen-only"));
  await writeFile(versionFile, "invalid-program");
  await assert.rejects(app.codexService.connect(AbortSignal.timeout(15000)), {
    code: "CODEX_VERSION_MISMATCH",
  });
  await writeFile(versionFile, "0.171.0-alpha.13.2");
  assert.equal(
    (
      await app.manager.action(scope.bindingId, {
        id: codexMcpId,
        action: "test",
      })
    ).status,
    "ready",
  );
});

test("Codex 是真实 stdio MCP，授权隔离，跨 Pi 进程续聊且不能指定别人的原生线程", async (t) => {
  const app = await fixture(t);
  const [service] = app.manager.list(scope.bindingId);
  assert.equal(service.kind, "codex");
  assert.equal(service.status, "ready", service.diagnostic);
  assert.deepEqual(
    service.tools.map((t) => t.name),
    ["codex", "codex-reply"],
  );
  assert.deepEqual(service.selected, []);
  await app.manager.action(scope.bindingId, {
    id: codexMcpId,
    action: "select",
    tools: ["codex", "codex-reply"],
  });
  assert.deepEqual(
    app.manager.turn({ ...scope, bindingId: "project-b" }).specs,
    [],
  );
  const first = await call(app.manager, scope, fresh, { prompt: "松果" });
  assert.equal(first.isError, false);
  assert.equal(first.content[0].text, "松果");
  await app.restart();
  const next = { ...scope, userMessageId: "second", visible: ["first"] };
  const second = await call(app.manager, next, reply, { prompt: "接上" });
  assert.equal(second.isError, false);
  assert.equal(second.content[0].text, "松果，接上");
  const hidden = await call(
    app.manager,
    { ...next, userMessageId: "third", visible: [] },
    reply,
    { prompt: "继续" },
  );
  assert.equal(hidden.isError, true);
  const other = await call(app.manager, { ...next, chatId: "other" }, reply, {
    prompt: "继续",
  });
  assert.equal(other.isError, true);
  const foreign = await call(app.manager, next, reply, {
    prompt: "继续",
    threadId: "another-thread",
    cwd: "/other",
  });
  assert.equal(foreign.isError, true);
  const events = await app.events();
  assert.deepEqual(
    events.map((e) => e.method),
    ["thread/start", "turn/start", "thread/resume", "turn/start"],
  );
  assert.equal(events[0].thread, events[2].thread);
  const turn = app.manager.turn(next);
  app.manager.setSelection(scope.bindingId, codexMcpId, []);
  await assert.rejects(
    turn.execute(
      fresh,
      { prompt: "no" },
      randomUUID(),
      AbortSignal.timeout(5000),
    ),
    /停用/,
  );
  await turn.close();
  assert.equal((await app.events()).length, 4);
  await assert.rejects(
    app.manager.action(scope.bindingId, { id: codexMcpId, action: "login" }),
    /本机登录/,
  );
});

test("本机登录诊断、恢复和取消都作用于实际的 Codex 子进程", async (t) => {
  const app = await fixture(t);
  await writeFile(path.join(app.dir, "logged-out"), "yes");
  assert.equal(
    (
      await app.manager.action(scope.bindingId, {
        id: codexMcpId,
        action: "test",
      })
    ).status,
    "authorization",
  );
  assert.match(app.manager.list(scope.bindingId)[0].diagnostic, /登录 Codex/);
  await rm(path.join(app.dir, "logged-out"));
  assert.equal(
    (
      await app.manager.action(scope.bindingId, {
        id: codexMcpId,
        action: "test",
      })
    ).status,
    "ready",
  );
  const controller = new AbortController();
  const client = await app.codexService.connect(
    AbortSignal.timeout(20000),
    () => {},
    scope,
  );
  try {
    const pending = client.callTool(
      "codex",
      { prompt: "等我取消" },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending);
    for (
      let i = 0;
      i < 150 && !(await app.events()).some((e) => e.method === "turn/start");
      i++
    )
      await delay(30);
    assert.ok((await app.events()).some((e) => e.method === "turn/start"));
    controller.abort();
    await rejected;
    for (
      let i = 0;
      i < 100 &&
      !(await app.events()).some((e) => e.method === "turn/interrupt");
      i++
    )
      await delay(30);
    assert.ok((await app.events()).some((e) => e.method === "turn/interrupt"));
  } finally {
    await client.close();
  }
});
