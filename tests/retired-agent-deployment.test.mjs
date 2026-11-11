import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { parseDeployConfig } from "../scripts/deploy-config.mjs";

test("撤下 Agent 后仍兼容线上已应用的 v3 迁移，不删除已有命名空间", async () => {
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
      ["ROOMS"],
      "Agent namespace must not be exposed to application routes",
    );
});

test("部署入口继续导出线上已有的 DO 类名", async () => {
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
});

for (const name of ["RunnerHub", "AgentChatRouter"]) {
  test(`停用的 ${name} 拒绝请求、结束连接，且不访问已有数据或执行任务`, async () => {
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
