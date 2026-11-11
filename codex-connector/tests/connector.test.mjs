import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadonlyCodex } from "../rpc.mjs";
let Connector;
try {
  ({ Connector } = await import("../connector.mjs"));
} catch {}
test("standalone connection manager exists", () =>
  assert.equal(typeof Connector, "function"));
if (Connector) {
  test("disconnect during configuration save cannot publish ready and schedules recovery", async (t) => {
    const { c } = await setup(t);
    c.options.autoRetry = true;
    const save = c.save.bind(c);
    c.save = async () => {
      const child = c.client.child;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      await save();
    };
    await c.inspect();
    assert.equal(c.status().status, "error");
    assert.equal(c.status().error.code, "CODEX_EXITED");
    assert.equal(
      c.status().checks.some((x) => x.state === "error"),
      true,
    );
    assert.equal(c.status().retryAttempt, 1);
    await assert.rejects(
      () => c.listSessions({}),
      (e) => e.code === "CODEX_NOT_CONNECTED",
    );
    assert.equal(c.status().status, "error");
  });
  async function setup(t, mode = "normal") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qd-connector-manager-"));
    const log = path.join(dir, "calls.jsonl");
    const candidate = {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixture.mjs", import.meta.url))],
      source: "test",
    };
    const c = new Connector({
      stateDir: dir,
      autoRetry: false,
      discover: async () => ({ candidates: [candidate], warnings: [] }),
      createClient: (x) =>
        new ReadonlyCodex(x, {
          env: { ...process.env, TEST_CODEX_MODE: mode, TEST_CODEX_LOG: log },
          timeoutMs: 400,
          shutdownMs: 100,
        }),
    });
    t.after(async () => {
      await c.close();
      await rm(dir, { recursive: true, force: true });
    });
    return { c, dir, log };
  }
  test("concurrent probes share one process and expose separate successful checks", async (t) => {
    const { c, log } = await setup(t, "slow");
    await Promise.all([c.inspect(), c.inspect(), c.inspect()]);
    assert.equal(c.status().status, "ready");
    assert.equal(c.status().sessionCount, 1);
    assert.equal(
      c.status().checks.every((x) => x.state === "ok"),
      true,
    );
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(lines.filter((x) => x.pid).length, 1);
    assert.deepEqual(
      [...new Set(lines.filter((x) => x.method).map((x) => x.method))],
      ["initialize", "initialized", "account/read", "thread/list"],
    );
  });
  test("status identifies each client replacement and a new connector instance", async (t) => {
    const { c } = await setup(t);
    await c.inspect();
    const first = c.status().connection;
    assert.equal(typeof first?.instanceId, "string");
    assert.ok(Number.isSafeInteger(first.generation));
    await c.inspect();
    const second = c.status().connection;
    assert.equal(second.instanceId, first.instanceId);
    assert.ok(second.generation > first.generation);
    const { c: other } = await setup(t);
    await other.inspect();
    assert.notEqual(other.status().connection.instanceId, first.instanceId);
    assert.equal(other.status().connection.generation, first.generation);
    assert.equal(c.status().status, "ready");
    assert.equal(c.status().preferences.manualPath, "");
  });
  test("not logged in is not confused with disconnected and metadata remains readable", async (t) => {
    const { c } = await setup(t, "logged-out");
    await c.inspect();
    assert.equal(c.status().status, "login_required");
    assert.equal((await c.listSessions({})).sessions.length, 1);
  });
  test("diagnostics exclude executable paths, session titles and account details", async (t) => {
    const { c } = await setup(t);
    await c.inspect();
    const d = JSON.stringify(c.diagnostics());
    for (const secret of [
      process.execPath,
      "private@example.com",
      "中文会话",
      "PRIVATE HISTORY BODY",
    ])
      assert.equal(d.includes(secret), false);
    assert.ok(d.includes("0.167.0-alpha.3.2"));
  });
  test("close while connecting cannot resurrect a connection", async (t) => {
    const { c } = await setup(t, "slow");
    const pending = c.inspect();
    await c.close();
    await pending;
    assert.equal(c.status().status, "closed");
  });
  test("corrupt preference file is surfaced and explicit reset recovers", async (t) => {
    const { c, dir } = await setup(t);
    await c.close();
    await writeFile(path.join(dir, "config.json"), "broken");
    const other = new Connector({
      stateDir: dir,
      autoRetry: false,
      discover: async () => ({ candidates: [], warnings: [] }),
    });
    t.after(() => other.close());
    await other.inspect();
    assert.equal(other.status().error.code, "CONFIG_INVALID");
    await other.configure("");
    assert.equal(other.status().error.code, "CODEX_NOT_FOUND");
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"))
        .manualPath,
      "",
    );
  });
}
