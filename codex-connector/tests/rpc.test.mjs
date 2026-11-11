import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let ReadonlyCodex;
try {
  ({ ReadonlyCodex } = await import("../rpc.mjs"));
} catch {}
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const candidate = {
  command: process.execPath,
  args: [fixture],
  source: "test",
};
test("read-only Codex transport exists", () =>
  assert.equal(typeof ReadonlyCodex, "function"));
if (ReadonlyCodex) {
  test("closing during version discovery never spawns a later app-server", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "qd-rpc-cancel-version-"));
    const signal = path.join(dir, "version.pid");
    const log = path.join(dir, "app-server.jsonl");
    const c = new ReadonlyCodex(candidate, {
      env: { ...process.env, TEST_VERSION_SIGNAL: signal, TEST_CODEX_LOG: log },
      timeoutMs: 2000,
      shutdownMs: 100,
    });
    t.after(async () => {
      await c.close();
      if (c.child?.exitCode === null) {
        c.child.kill();
        await new Promise((r) => c.child.once("exit", r));
      }
      await rm(dir, { recursive: true, force: true });
    });
    const outcome = c.connect().then(
      () => null,
      (e) => e,
    );
    let versionPid;
    for (let i = 0; i < 100; i++) {
      try {
        versionPid = Number(await readFile(signal, "utf8"));
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      versionPid,
      "version process must actually be running before cancellation",
    );
    await c.close();
    assert.ok(await outcome, "cancelled connect must reject");
    assert.equal(c.pid, null, "cancelled discovery must not spawn app-server");
    assert.throws(
      () => process.kill(versionPid, 0),
      "version check must also be stopped",
    );
    await assert.rejects(
      () => readFile(log, "utf8"),
      (e) => e.code === "ENOENT",
    );
  });
  const client = (t, mode = "normal") => {
    const c = new ReadonlyCodex(candidate, {
      env: { ...process.env, TEST_CODEX_MODE: mode },
      timeoutMs: 350,
      shutdownMs: 100,
    });
    t.after(() => c.close());
    return c;
  };
  test("connects, checks account, reads metadata and paginates without executing", async (t) => {
    const c = client(t);
    await c.connect();
    assert.equal((await c.account()).status, "signed_in");
    const page = await c.listSessions({});
    assert.equal(page.sessions[0].title, "中文会话");
    assert.equal(page.nextCursor, "page-2");
    assert.equal(
      (await c.listSessions({ cursor: page.nextCursor })).sessions[0].threadId,
      "thread-2",
    );
    assert.equal((await c.readSession("thread-1")).threadId, "thread-1");
    assert.equal("preview" in page.sessions[0], false);
    assert.equal("turns" in page.sessions[0], false);
    await assert.rejects(
      () => c.request("turn/start", {}),
      (e) => e.code === "METHOD_NOT_ALLOWED",
    );
    const pid = c.pid;
    await c.close();
    assert.equal(c.connected, false);
    assert.throws(() => process.kill(pid, 0));
  });
  test("decodes fragmented UTF-8 frames", async (t) => {
    const c = client(t, "fragment");
    await c.connect();
    assert.equal((await c.listSessions({})).sessions[0].title, "中文会话");
  });
  test("logged out and no sessions are valid distinct states", async (t) => {
    const a = client(t, "logged-out");
    await a.connect();
    assert.equal((await a.account()).status, "required");
    const b = client(t, "empty");
    await b.connect();
    assert.deepEqual((await b.listSessions({})).sessions, []);
  });
  for (const [mode, code] of [
    ["hang", "CODEX_TIMEOUT"],
    ["malformed", "CODEX_PROTOCOL_ERROR"],
    ["version", "CODEX_VERSION_MISMATCH"],
  ])
    test(`classifies ${mode} and closes owned child`, async (t) => {
      const c = client(t, mode);
      await assert.rejects(
        () => c.connect(),
        (e) => e.code === code,
      );
      await c.close();
      assert.equal(c.connected, false);
    });
  test("rejects invalid account schema", async (t) => {
    const c = client(t, "invalid");
    await c.connect();
    await assert.rejects(
      () => c.account(),
      (e) => e.code === "CODEX_PROTOCOL_ERROR",
    );
  });
  test("classifies subprocess exit during request", async (t) => {
    const c = client(t, "crash");
    await c.connect();
    await assert.rejects(
      () => c.listSessions({}),
      (e) => e.code === "CODEX_EXITED",
    );
    assert.equal(c.connected, false);
  });
  test("does not accept another thread as the selected project", async (t) => {
    const c = client(t, "wrong-id");
    await c.connect();
    await assert.rejects(
      () => c.readSession("thread-1"),
      (e) => e.code === "CODEX_PROTOCOL_ERROR",
    );
  });
}
