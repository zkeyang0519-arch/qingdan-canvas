import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { parseDeployConfig } from "../scripts/deploy-config.mjs";

test("Agent 开发分支保留线上 v3 迁移和完整 Agent 绑定", async () => {
  const config = parseDeployConfig(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["CanvasRoom"] },
    { tag: "v2", new_sqlite_classes: ["RunnerHub"] },
    { tag: "v3", new_sqlite_classes: ["AgentChatRouter"] },
  ]);
  for (const environment of [config, config.previews])
    assert.deepEqual(
      environment.durable_objects.bindings.map((binding) => binding.name),
      ["ROOMS", "RUNNER_HUBS", "AGENT_CHATS"],
      "The local Agent development branch needs its active namespace bindings",
    );
});

test("Agent 开发分支导出真实执行和对话实现，保留全部既有 DO 类名", async () => {
  const result = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const exports = Object.values(result.metafile.outputs)[0].exports;
  for (const name of ["CanvasRoom", "RunnerHub", "AgentChatRouter"])
    assert.ok(exports.includes(name), `${name} must remain deployable`);
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes("worker/execution/hub.ts"));
  assert.ok(inputs.includes("worker/agent/chat-router.ts"));
  assert.ok(!inputs.includes("worker/retired-agent.ts"));
});

for (const name of ["RunnerHub", "AgentChatRouter"]) {
  test(`生产停用兼容类 ${name} 拒绝请求、结束连接，且不访问已有数据或执行任务`, async () => {
    const module = await import("../worker/retired-agent.ts");
    const forbidden = new Proxy(
      {},
      {
        get(_target, key) {
          assert.fail(
            `retired Agent accessed runtime dependency: ${String(key)}`,
          );
        },
      },
    );
    const actor = new module[name](forbidden, forbidden);
    for (const method of ["GET", "POST"]) {
      const response = await actor.fetch(
        new Request("https://retired.invalid/", { method }),
      );
      assert.equal(response.status, 410);
      assert.equal(
        (await response.json()).error,
        "Agent functionality is disabled.",
      );
    }
    await actor.alarm();
    const closed = [];
    const socket = { close: (code) => closed.push(code) };
    actor.webSocketMessage(socket, "do not execute this task");
    actor.webSocketError(socket, new Error("disconnected"));
    actor.webSocketClose(socket, 1000, "", true);
    assert.deepEqual(closed, [1001, 1001]);
  });
}
