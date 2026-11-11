import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "../connector.mjs";
import { ReadonlyCodex } from "../rpc.mjs";

const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("Recovery condition did not settle");
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function manager(t, mode = () => "normal", created = () => {}) {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "qd-connector-recovery-"),
  );
  const c = new Connector({
    stateDir,
    discover: async () => ({
      candidates: [
        { command: process.execPath, args: [fixture], source: "test" },
      ],
      warnings: [],
    }),
    createClient: (candidate) => {
      created();
      return new ReadonlyCodex(candidate, {
        env: { ...process.env, TEST_CODEX_MODE: mode() },
        timeoutMs: 2000,
        shutdownMs: 100,
      });
    },
  });
  t.after(async () => {
    await c.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return c;
}

test("an owned app-server crash automatically reconnects with a new identity", async (t) => {
  const c = await manager(t);
  assert.equal((await c.inspect()).status, "ready");
  const before = c.status().connection,
    pid = c.client.pid;
  c.client.child.kill();
  await until(() => c.status().status === "error");
  assert.equal(c.status().error.code, "CODEX_EXITED");
  await until(() => c.status().status === "ready" && c.client.pid !== pid);
  const after = c.status().connection;
  assert.equal(after.instanceId, before.instanceId);
  assert.ok(after.generation > before.generation);
  assert.equal(alive(pid), false);
  assert.equal(c.status().retryAttempt, 1);
});

test(
  "three automatic retries are bounded and manual reconnect resets the budget",
  { timeout: 30000 },
  async (t) => {
    let mode = "crash",
      attempts = 0;
    const c = await manager(
      t,
      () => mode,
      () => attempts++,
    );
    await c.inspect();
    await until(
      () => attempts === 4 && !c.probe && c.status().status === "error",
      22000,
    );
    assert.equal(c.status().retryAttempt, 3);
    assert.equal(c.retryTimer, null);
    assert.equal(c.status().retryAt, null);
    mode = "normal";
    assert.equal((await c.inspect()).status, "ready");
    assert.equal(attempts, 5);
    assert.equal(c.status().retryAttempt, 0);
  },
);

test(
  "isolated launch reuses an instance and survives restart with preferences and clean exit",
  { skip: process.platform !== "win32", timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qd-connector-launch-"));
    const stateDir = path.join(root, "state"),
      log = path.join(root, "calls.jsonl");
    const children = [];
    const childPids = async () => {
      try {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse)
          .filter((x) => x.pid)
          .map((x) => x.pid);
      } catch {
        return [];
      }
    };
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await until(
            () => child.exitCode !== null || child.signalCode !== null,
          );
        }
      }
      for (const pid of await childPids()) await until(() => !alive(pid));
      await rm(root, { recursive: true, force: true });
    });
    const start = () => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./launch-fixture.mjs", import.meta.url)),
          stateDir,
          log,
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.output = "";
      child.errors = "";
      child.stdout.on("data", (chunk) => (child.output += chunk.toString()));
      child.stderr.on("data", (chunk) => (child.errors += chunk.toString()));
      return child;
    };
    const ready = (child) =>
      until(() => {
        assert.equal(child.errors, "", child.errors);
        const newline = child.output.indexOf("\n");
        return newline >= 0 && JSON.parse(child.output.slice(0, newline));
      });
    const runtime = () =>
      readFile(path.join(stateDir, "runtime.json"), "utf8").then(JSON.parse);
    const api = async (instance, route, body) => {
      const res = await fetch(instance.url + route, {
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: "Bearer " + instance.token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const first = start();
    assert.equal((await ready(first)).reused, false);
    const r1 = await runtime();
    const s1 = await until(async () => {
      const s = await api(r1, "/api/status");
      return s.status === "ready" && s;
    });
    const duplicate = start();
    assert.equal((await ready(duplicate)).reused, true);
    await until(() => duplicate.exitCode === 0);
    const manualPath = path.join(root, "synthetic-codex.exe");
    assert.equal(
      (await api(r1, "/api/config", { manualPath })).status,
      "ready",
    );
    const beforeRestartPids = await childPids();
    first.kill();
    await until(() => first.exitCode !== null || first.signalCode !== null);
    for (const pid of beforeRestartPids) await until(() => !alive(pid));
    const restarted = start();
    assert.equal((await ready(restarted)).reused, false);
    const r2 = await runtime();
    const s2 = await until(async () => {
      const s = await api(r2, "/api/status");
      return s.status === "ready" && s;
    });
    assert.notEqual(s2.connection.instanceId, s1.connection.instanceId);
    assert.notEqual(r2.token, r1.token);
    assert.notEqual(r2.instanceId, r1.instanceId);
    assert.equal(s2.preferences.manualPath, manualPath);
    await api(r2, "/api/quit", {});
    await until(() => restarted.exitCode === 0);
    await assert.rejects(runtime, (e) => e.code === "ENOENT");
    assert.ok((await childPids()).every((pid) => !alive(pid)));
  },
);
