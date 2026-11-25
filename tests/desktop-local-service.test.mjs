import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createManagedLocalService } from "../desktop/local-service.cjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.resolve(".tmp/local-service-test-"));
  const root = path.join(directory, "bundle"),
    dataDir = path.join(directory, "profile");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "1.1.0", protocol: 1, dataSchema: 1 }),
  );
  const commands = [],
    children = [];
  const flags = { tasks: [], stopConfirmed: true };
  const spawnProcess = (command, args, config) => {
    assert.equal(command, path.join(root, "node.exe"));
    assert.deepEqual(args, [path.join(root, "service.mjs")]);
    assert.equal(config.windowsHide, true);
    const child = new EventEmitter();
    Object.assign(child, { pid: 999998, connected: true, exitCode: null });
    child.kill = () => assert.fail("managed updates never force-kill a child");
    child.send = (message, callback) => {
      commands.push(message.action);
      callback?.();
      setImmediate(() => {
        const result =
          message.action === "activity"
            ? { tasks: flags.tasks, unknown: [] }
            : message.action === "pause"
              ? { paused: true }
              : message.action === "checkpoint"
                ? { ok: true }
                : message.action === "stop"
                  ? { stopped: flags.stopConfirmed }
                  : { resumed: true };
        child.emit("message", { id: message.id, result });
        if (message.action === "stop" && flags.stopConfirmed) {
          child.connected = false;
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }
      });
    };
    children.push(child);
    setImmediate(() =>
      child.emit("message", { type: "ready", protocol: 1, version: "1.1.0" }),
    );
    return child;
  };
  const service = createManagedLocalService({
    root,
    dataDir,
    version: "1.1.0",
    spawnProcess,
    isPortInUse: async () => false,
    environment: {},
    ...options,
  });
  t.after(async () => {
    flags.tasks = [];
    flags.stopConfirmed = true;
    if (children.some((child) => child.connected)) {
      await service.pause();
      await service.stop();
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(".tmp"));
    await rm(directory, { recursive: true, force: true });
  });
  return { root, dataDir, service, flags, commands, children };
}
test("managed service coalesces starts, persists outside the bundle and confirms its own process exit", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.service.start(), f.service.start()]);
  assert.equal(f.children.length, 1);
  assert.equal(f.service.state().status, "online");
  const retained = path.join(f.dataDir, "data", "config.json");
  const config = {
    model: "existing-model",
    mcp: ["existing"],
    receipt: "original-remote-receipt",
  };
  await writeFile(retained, JSON.stringify(config));
  await f.service.pause();
  assert.equal((await f.service.checkpoint()).ok, true);
  await f.service.stop();
  assert.equal(f.service.state().status, "stopped");
  assert.deepEqual(JSON.parse(await readFile(retained, "utf8")), config);
  assert.deepEqual(f.commands.slice(-3), ["pause", "checkpoint", "stop"]);
  assert.equal((await f.service.start()).status, "online");
  assert.equal(f.children.length, 2);
});
test("an independent local service is detected without starting, stopping or replacing it", async (t) => {
  const f = await fixture(t, { isPortInUse: async () => true });
  assert.equal((await f.service.start()).status, "external");
  assert.equal(f.children.length, 0);
  await f.service.pause();
  await f.service.stop();
  assert.deepEqual(f.commands, []);
});
test("incompatible data and bundle versions stop startup without deleting user data", async (t) => {
  const f = await fixture(t);
  await mkdir(f.dataDir, { recursive: true });
  await writeFile(
    path.join(f.dataDir, "storage.json"),
    JSON.stringify({ schema: 2, version: "1.2.0", attempts: 0 }),
  );
  await assert.rejects(f.service.start(), /较新版本|兼容/);
  assert.equal(f.children.length, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(f.dataDir, "storage.json"), "utf8"))
      .schema,
    2,
  );
});
test("a failed process-stop acknowledgment never becomes a successful shutdown", async (t) => {
  const f = await fixture(t);
  await f.service.start();
  f.flags.stopConfirmed = false;
  await f.service.pause();
  await assert.rejects(f.service.stop(), /未确认安全退出/);
  assert.equal(f.children[0].connected, true);
  await f.service.resume();
  assert.equal(f.commands.at(-1), "resume");
});
test("stop from settings refuses running tasks and a stale live owner blocks competing launches", async (t) => {
  const f = await fixture(t);
  await f.service.start();
  f.flags.tasks = [{ id: "run-1", label: "文件修改" }];
  await assert.rejects(f.service.disable(), /运行中/);
  assert.ok(!f.commands.includes("stop"));
  const duplicate = createManagedLocalService({
    root: f.root,
    dataDir: f.dataDir,
    version: "1.1.0",
    isPortInUse: async () => false,
    spawnProcess: () => assert.fail("must not start competing runtime"),
  });
  await assert.rejects(duplicate.start(), /另一项本地服务/);
});
