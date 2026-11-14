import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createLocalRunnerApi } from "../scripts/lib/local-runner-api.mjs";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";

await mkdir(path.resolve(".tmp"), { recursive: true });
const dir = await mkdtemp(path.resolve(".tmp/device-recovery-"));
await build({
  stdin: {
    contents:
      "export * from './runner/device-controller'; export * from './runner/device-store'; export * from './runner/credentials'; export * from './runner/execution-store'; export * from './runner/executor'; export * from './runner/workspaces'; export {RunnerStore,digest} from './runner/store';",
    resolveDir: process.cwd(),
  },
  outfile: path.join(dir, "api.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const apiUrl = pathToFileURL(path.join(dir, "api.mjs")).href;
const api = await import(apiUrl);
test.after(() => rm(dir, { recursive: true, force: true }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const origin = "https://device-audit.invalid";
class Clock {
  time = 0;
  next = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = ++this.next;
    this.timers.set(id, { fn, at: this.time + ms });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await tick();
    }
    this.time = end;
    await tick();
  }
}
const token = (id) =>
  new Response(
    JSON.stringify({ runnerId: id, ownerId: "alice", authEpoch: 1 }),
  );
const proof = (target) =>
  Promise.resolve({
    ...target,
    status: "revoked",
    authEpoch: target.authEpoch + 1,
  });
const transportFactory = () => ({
  status: {
    connectionStatus: "online",
    connectionEpoch: 1,
    lastHeartbeatAt: null,
    error: null,
  },
  async start() {},
  close() {},
  reconnect() {},
  async updateWorkspaces() {},
});
async function fixture(
  t,
  { pending = false, missing = false, ...options } = {},
) {
  const base = await mkdtemp(path.join(dir, "case-"));
  const config = {
    runnerId: randomUUID(),
    ownerId: "alice",
    deviceName: "Test PC",
    serverOrigin: options.serverOrigin ?? origin,
    authEpoch: 1,
    enabled: true,
    pairingPending: pending,
  };
  const store = new api.DeviceStore(path.join(base, "device.sqlite"));
  store.saveConfig(config);
  store.close();
  const credentials = new api.MemoryCredentialStore();
  if (!missing)
    await credentials.write(
      api.credentialTarget(config.serverOrigin, config.runnerId),
      "synthetic-device-secret-only-in-memory",
    );
  const settings = {
    stateDir: base,
    serverOrigin: origin,
    locksDir: path.join(base, "locks"),
    credentials,
    transportFactory,
    fetch: async () => new Response("{}", { status: 401 }),
    ...options,
  };
  const controller = new api.RunnerDeviceController(settings);
  t.after(() => controller.close());
  return {
    base,
    config,
    credentials,
    controller,
    settings,
    executionDir: path.join(
      base,
      "execution",
      api.digest([config.ownerId, config.runnerId]),
    ),
  };
}
function persisted(f) {
  const store = new api.DeviceStore(path.join(f.base, "device.sqlite"));
  try {
    return store.config();
  } finally {
    store.close();
  }
}

test("pending pairing backs off at 1/2/4/8/16/30s and recovers the same identity", async (t) => {
  const clock = new Clock();
  const calls = [];
  let online = false;
  const f = await fixture(t, {
    pending: true,
    clock,
    fetch: async (_url, init) => {
      calls.push(clock.now());
      return online
        ? token(JSON.parse(init.body).runnerId)
        : new Response("{}", { status: 503 });
    },
  });
  await f.controller.start();
  await tick();
  assert.ok(
    f.controller.status("alice").error,
    "503 must explain that recovery is waiting",
  );
  await clock.advance(91000);
  assert.deepEqual(calls, [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
  online = true;
  await clock.advance(30000);
  assert.equal(f.controller.status("alice").paired, true);
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  assert.equal(clock.timers.size, 0);
});

test("manual reconnect immediately recovers pending pairing and rejects another account", async (t) => {
  let available = false;
  let calls = 0;
  const clock = new Clock();
  const f = await fixture(t, {
    pending: true,
    clock,
    fetch: async (_url, init) => {
      calls++;
      return available
        ? token(JSON.parse(init.body).runnerId)
        : new Response("{}", { status: 503 });
    },
  });
  await f.controller.start();
  await tick();
  available = true;
  await assert.rejects(f.controller.reconnect("bob"), {
    code: "OWNER_MISMATCH",
  });
  const state = await f.controller.reconnect("alice");
  assert.equal(state.paired, true);
  assert.equal(calls, 2);
  assert.equal(clock.timers.size, 0);
});

test("manual pair during a pending outage does not disable automatic recovery", async (t) => {
  const clock = new Clock();
  let online = false;
  const f = await fixture(t, {
    pending: true,
    clock,
    fetch: async (_url, init) =>
      online
        ? token(JSON.parse(init.body).runnerId)
        : new Response("{}", { status: 503 }),
  });
  await f.controller.start();
  await tick();
  await assert.rejects(
    f.controller.pair({
      ownerId: "alice",
      pairingCode: "retry",
      deviceName: "PC",
    }),
  );
  online = true;
  await clock.advance(30000);
  assert.equal(f.controller.status("alice").paired, true);
});

for (const operation of [
  "reset GET503",
  "legacy forget busy",
  "pair credential read failure",
])
  test(
    "identity failure restores pending recovery: " + operation,
    async (t) => {
      const clock = new Clock();
      const calls = [];
      let online = false;
      const f = await fixture(t, {
        pending: true,
        clock,
        fetch: async (_url, init) => {
          calls.push(clock.now());
          return online
            ? token(JSON.parse(init.body).runnerId)
            : new Response("{}", { status: 503 });
        },
      });
      await f.controller.start();
      await tick();
      assert.equal(clock.timers.size, 1);
      const original = Object.assign(Error(operation), { status: 503 });
      if (operation === "reset GET503") {
        await assert.rejects(
          f.controller.reset("alice", f.config.runnerId, async () => {
            throw original;
          }),
          (error) => error === original,
        );
      } else if (operation === "legacy forget busy") {
        const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
        device.saveLease({
          workspaceId: "workspace",
          runId: "unknown",
          leaseEpoch: 1,
          expiresAt: 1,
        });
        try {
          await assert.rejects(f.controller.forget("alice"), {
            code: "WORKSPACE_BUSY",
          });
          assert.equal(device.leases().length, 1);
        } finally {
          device.close();
        }
      } else {
        const read = f.credentials.read.bind(f.credentials);
        f.credentials.read = async () => {
          throw original;
        };
        await assert.rejects(
          f.controller.pair({
            ownerId: "alice",
            pairingCode: "retry",
            deviceName: "PC",
          }),
          (error) => error === original,
        );
        f.credentials.read = read;
      }
      assert.equal(persisted(f).runnerId, f.config.runnerId);
      assert.equal(persisted(f).pairingPending, true);
      assert.equal(f.credentials.values.size, 1);
      assert.equal(
        clock.timers.size,
        1,
        "the retained identity must keep its automatic recovery",
      );
      await clock.advance(91000);
      assert.deepEqual(
        calls,
        [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000],
      );
      online = true;
      await clock.advance(30000);
      assert.equal(f.controller.status("alice").paired, true);
      assert.equal(clock.timers.size, 0);
    },
  );

test("identity failure from invalid pair input preserves the existing timer and generation", async (t) => {
  const clock = new Clock();
  let online = false;
  const f = await fixture(t, {
    pending: true,
    clock,
    fetch: async (_url, init) =>
      online
        ? token(JSON.parse(init.body).runnerId)
        : new Response("{}", { status: 503 }),
  });
  await f.controller.start();
  await tick();
  const generation = f.controller.generation;
  const timers = [...clock.timers];
  await clock.advance(500);
  for (const input of [
    { pairingCode: " ", deviceName: "PC" },
    { pairingCode: "retry", deviceName: "" },
  ])
    await assert.rejects(f.controller.pair({ ownerId: "alice", ...input }), {
      code: "VALIDATION_ERROR",
    });
  assert.equal(f.controller.generation, generation);
  assert.deepEqual([...clock.timers], timers);
  online = true;
  await clock.advance(500);
  assert.equal(f.controller.status("alice").paired, true);
});

for (const successor of ["close", "new generation"])
  test(
    "identity failure does not revive pending recovery after " + successor,
    async (t) => {
      const clock = new Clock();
      let calls = 0,
        finishToken,
        failEvidence;
      const f = await fixture(t, {
        pending: true,
        clock,
        fetch: (_url, init) => {
          calls++;
          return calls === 1
            ? Promise.resolve(new Response("{}", { status: 503 }))
            : new Promise((resolve) => {
                finishToken = () =>
                  resolve(token(JSON.parse(init.body).runnerId));
              });
        },
      });
      await f.controller.start();
      await tick();
      assert.equal(clock.timers.size, 1);
      const original = Object.assign(Error("GET503"), { status: 503 });
      const failed = f.controller.reset(
        "alice",
        f.config.runnerId,
        () =>
          new Promise((_, reject) => {
            failEvidence = () => reject(original);
          }),
      );
      const rejected = assert.rejects(failed, (error) => error === original);
      for (let n = 0; n < 30 && !failEvidence; n++) await tick();
      assert.ok(failEvidence);
      const next =
        successor === "close"
          ? f.controller.close()
          : f.controller.reconnect("alice");
      failEvidence();
      await rejected;
      if (successor === "new generation") {
        for (let n = 0; n < 30 && !finishToken; n++) await tick();
        assert.ok(finishToken);
      }
      assert.equal(
        clock.timers.size,
        0,
        "old failure must not arm a timer during its successor",
      );
      await clock.advance(60000);
      assert.equal(calls, successor === "close" ? 1 : 2);
      finishToken?.();
      await next;
      assert.equal(clock.timers.size, 0);
      assert.equal(persisted(f).pairingPending, successor === "close");
    },
  );

test("legacy forget also refuses unknown native execution before an executor is created", async (t) => {
  const f = await fixture(t);
  const journal = new api.ExecutionStore(
    path.join(f.executionDir, "execution.sqlite"),
  );
  const runs = new api.RunnerStore(path.join(f.executionDir, "adapter.sqlite"));
  const db = new DatabaseSync(path.join(f.executionDir, "adapter.sqlite"));
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
    "run-a",
    null,
    f.base,
    1,
    JSON.stringify({
      runId: "run-a",
      active: true,
      terminal: false,
      status: "reconciliation_required",
    }),
  );
  db.close();
  runs.close();
  journal.close();
  await assert.rejects(f.controller.forget("alice"), {
    code: "WORKSPACE_BUSY",
  });
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  assert.equal(f.credentials.values.size, 1);
});

test("authenticated forget checks local safety before revoking and supports missing credentials", async (t) => {
  const f = await fixture(t, { missing: true });
  let revocations = 0;
  const revokeAndVerify = async (target) => {
    revocations++;
    return proof(target);
  };
  const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
  device.saveLease({
    workspaceId: "workspace",
    runId: "unknown",
    leaseEpoch: 1,
    expiresAt: 1,
  });
  await assert.rejects(
    f.controller.forget("alice", {
      expectedRunnerId: f.config.runnerId,
      revokeAndVerify,
    }),
    { code: "WORKSPACE_BUSY" },
  );
  assert.equal(revocations, 0);
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  device.removeLease("workspace");
  device.close();
  assert.equal(
    (
      await f.controller.forget("alice", {
        expectedRunnerId: f.config.runnerId,
        revokeAndVerify,
      })
    ).paired,
    false,
  );
  assert.equal(revocations, 1);
});

test("target-bound HTTP forget preserves evidence after revoke ACK and GET loss, then retries safely", async (t) => {
  let revoked = false,
    drop = true;
  const calls = [];
  let f;
  const worker = createServer((req, res) => {
    if (req.url === "/api/session")
      return res.end(JSON.stringify({ user: { id: "alice" } }));
    assert.equal(req.headers.cookie, "qd_session=synthetic");
    assert.equal(req.headers["x-qd-account"], "alice");
    calls.push(req.method + " " + req.url);
    if (req.method === "POST" && req.url.endsWith("/revoke")) {
      revoked = true;
      if (drop) return req.socket.destroy();
      return res.end("{}");
    }
    if (drop) return req.socket.destroy();
    res.end(
      JSON.stringify({
        devices: [
          {
            runnerId: f.config.runnerId,
            ownerId: "alice",
            status: revoked ? "revoked" : "online",
            authEpoch: revoked ? 2 : 1,
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const upstream = "http://127.0.0.1:" + worker.address().port;
  f = await fixture(t, { serverOrigin: upstream });
  const server = createExperienceServer({
    service: {},
    upstream,
    runnerApi: createLocalRunnerApi({
      upstream,
      getController: () => f.controller,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  });
  const localOrigin = "http://127.0.0.1:" + server.address().port;
  const request = (body) =>
    fetch(localOrigin + "/api/local-runner/forget", {
      method: "POST",
      headers: {
        origin: localOrigin,
        "content-type": "application/json",
        "x-qingdan-local": "1",
        "x-qd-account": "alice",
        cookie: "qd_session=synthetic",
      },
      body: JSON.stringify(body),
    });
  const body = { expectedRunnerId: f.config.runnerId };
  const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
  device.saveLease({
    workspaceId: "workspace",
    runId: "active",
    leaseEpoch: 1,
    expiresAt: 1,
  });
  assert.equal((await request(body)).status, 409);
  assert.deepEqual(calls, []);
  assert.equal(revoked, false);
  assert.equal(f.credentials.values.size, 1);
  device.removeLease("workspace");
  device.close();
  assert.equal((await request(body)).status, 503);
  assert.equal(revoked, true);
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  assert.equal(f.credentials.values.size, 1);
  assert.deepEqual(calls, [
    "POST /api/agent/devices/" + f.config.runnerId + "/revoke",
    "GET /api/agent/devices",
  ]);
  drop = false;
  assert.equal((await request(body)).status, 200);
  assert.equal(persisted(f), null);
  assert.equal(f.credentials.values.size, 0);
  const after = calls.length;
  assert.equal((await request(body)).status, 200);
  assert.equal(calls.length, after);
  f.controller.http = async (_url, init) =>
    token(JSON.parse(init.body).runnerId);
  const paired = await f.controller.pair({
    ownerId: "alice",
    pairingCode: "new-code",
    deviceName: "New PC",
  });
  assert.equal((await request(body)).status, 409);
  assert.equal(calls.length, after);
  // The old empty-body endpoint cannot acquire the power to revoke this new identity.
  assert.equal((await request({})).status, 409);
  assert.equal(calls.length, after);
  assert.equal(f.controller.status("alice").runnerId, paired.runnerId);
});

test("forget invalidates an ignored-abort startup token response before clearing the identity", async (t) => {
  let finish;
  let calls = 0;
  const f = await fixture(t, {
    pending: true,
    fetch: async () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : new Response("{}", { status: 401 }),
  });
  await f.controller.start();
  await tick();
  const forgotten = await f.controller.forget("alice");
  assert.equal(forgotten.paired, false);
  finish(token(f.config.runnerId));
  await tick();
  assert.equal(f.controller.status("alice").paired, false);
  assert.equal(persisted(f), null);
  assert.equal(f.credentials.values.size, 0);
});

test("close invalidates delayed pairing and cancels pending recovery timers", async (t) => {
  let finish;
  const clock = new Clock();
  const f = await fixture(t, {
    pending: true,
    clock,
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await f.controller.start();
  await tick();
  await f.controller.close();
  finish(token(f.config.runnerId));
  await tick();
  assert.equal(persisted(f).pairingPending, true);
  assert.equal(clock.timers.size, 0);
});

test("late old transport startup errors cannot pollute a newly paired device", async (t) => {
  let fail;
  let starts = 0;
  const f = await fixture(t, {
    transportFactory: () => ({
      ...transportFactory(),
      start: () =>
        ++starts === 1
          ? new Promise((_, reject) => {
              fail = reject;
            })
          : Promise.resolve(),
    }),
  });
  await f.controller.start();
  await f.controller.forget("alice");
  f.controller.http = async (_url, init) =>
    token(JSON.parse(init.body).runnerId);
  const current = await f.controller.pair({
    ownerId: "alice",
    pairingCode: "new-code",
    deviceName: "New PC",
  });
  fail(Error("old start failed"));
  await tick();
  assert.notEqual(current.runnerId, f.config.runnerId);
  assert.equal(f.controller.status("alice").error, null);
});

test("a rejected forget keeps errors from the still-current transport visible", async (t) => {
  let fail;
  const f = await fixture(t, {
    transportFactory: () => ({
      ...transportFactory(),
      start: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    }),
  });
  await f.controller.start();
  const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
  device.saveLease({
    workspaceId: "workspace",
    runId: "unknown",
    leaseEpoch: 1,
    expiresAt: 1,
  });
  device.close();
  await assert.rejects(f.controller.forget("alice"), {
    code: "WORKSPACE_BUSY",
  });
  fail(Error("current start failed"));
  await tick();
  assert.equal(
    f.controller.status("alice").error,
    "Unable to start Runner connection.",
  );
});

test("missing credential reset persists a receipt across restart and fences a newly paired identity", async (t) => {
  const f = await fixture(t, { missing: true });
  assert.equal(
    typeof f.controller.reset,
    "function",
    "a controlled reset is available",
  );
  const project = path.join(f.base, "project");
  await mkdir(project);
  await f.controller.registerWorkspace("alice", { root: project });
  const state = await f.controller.reset("alice", f.config.runnerId, proof);
  assert.equal(state.paired, false);
  assert.deepEqual(state.workspaces, []);
  await f.controller.close();
  const restarted = new api.RunnerDeviceController(f.settings);
  t.after(() => restarted.close());
  const replay = await restarted.reset("alice", f.config.runnerId, () =>
    assert.fail("committed receipt does not require another remote request"),
  );
  assert.equal(replay.paired, false);
  await assert.rejects(restarted.reset("bob", f.config.runnerId, proof), {
    code: "OWNER_MISMATCH",
  });
  restarted.http = async (_url, init) => token(JSON.parse(init.body).runnerId);
  const paired = await restarted.pair({
    ownerId: "alice",
    pairingCode: "new-code",
    deviceName: "New PC",
  });
  assert.notEqual(paired.runnerId, f.config.runnerId);
  await assert.rejects(restarted.reset("alice", f.config.runnerId, proof), {
    code: "STALE_DEVICE",
  });
  assert.equal(restarted.status("alice").runnerId, paired.runnerId);
});

test("reset rejects wrong owner/runner/origin/status/epoch and unavailable evidence", async (t) => {
  const f = await fixture(t, { missing: true });
  assert.equal(typeof f.controller.reset, "function");
  await assert.rejects(f.controller.reset("bob", f.config.runnerId, proof), {
    code: "OWNER_MISMATCH",
  });
  await assert.rejects(f.controller.reset("alice", randomUUID(), proof), {
    code: "STALE_DEVICE",
  });
  for (const patch of [
    { ownerId: "bob" },
    { runnerId: randomUUID() },
    { serverOrigin: "https://foreign.invalid" },
    { status: "offline" },
    { status: undefined, revoked: true },
    { authEpoch: 1 },
    { authEpoch: NaN },
  ]) {
    await assert.rejects(
      f.controller.reset("alice", f.config.runnerId, async (target) => ({
        ...(await proof(target)),
        ...patch,
      })),
      { code: "REVOCATION_REQUIRED" },
    );
    assert.equal(persisted(f).runnerId, f.config.runnerId);
  }
  await assert.rejects(
    f.controller.reset("alice", f.config.runnerId, async () => {
      throw Error("503");
    }),
    /503/,
  );
  assert.equal(persisted(f).runnerId, f.config.runnerId);
});

test("a delayed old reset receipt cannot cancel a new pairing before its credential write completes", async (t) => {
  const f = await fixture(t);
  await f.controller.reset("alice", f.config.runnerId, proof);
  const write = f.credentials.write.bind(f.credentials);
  let finish;
  f.credentials.write = async (...args) => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    return write(...args);
  };
  f.controller.http = async (_url, init) =>
    token(JSON.parse(init.body).runnerId);
  const pairing = f.controller.pair({
    ownerId: "alice",
    pairingCode: "new-code",
    deviceName: "New PC",
  });
  for (let n = 0; n < 30 && !finish; n++) await tick();
  assert.ok(finish);
  const retry = f.controller.reset("alice", f.config.runnerId, proof);
  const stale = assert.rejects(retry, { code: "STALE_DEVICE" });
  finish();
  const [paired] = await Promise.all([pairing, stale]);
  assert.notEqual(paired.runnerId, f.config.runnerId);
  assert.equal(paired.paired, true);
});

test("reset refuses non-file execution journals instead of treating them as absent", async (t) => {
  const f = await fixture(t, { missing: true });
  await mkdir(path.join(f.executionDir, "execution.sqlite"), {
    recursive: true,
  });
  await mkdir(path.join(f.executionDir, "adapter.sqlite"));
  let verified = false;
  await assert.rejects(
    f.controller.reset("alice", f.config.runnerId, (target) => {
      verified = true;
      return proof(target);
    }),
    { code: "RESET_STATE_UNKNOWN" },
  );
  assert.equal(verified, false);
  assert.equal(persisted(f).runnerId, f.config.runnerId);
});

test("reset keeps completed native history and retries a credential deletion followed by an interrupted commit", async (t) => {
  const f = await fixture(t);
  const journal = new api.ExecutionStore(
    path.join(f.executionDir, "execution.sqlite"),
  );
  const runs = new api.RunnerStore(path.join(f.executionDir, "adapter.sqlite"));
  const db = new DatabaseSync(path.join(f.executionDir, "adapter.sqlite"));
  const history = JSON.stringify({
    runId: "finished",
    active: false,
    terminal: true,
    status: "cancelled",
    threadId: "original-thread",
    activeTurnId: "original-turn",
  });
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
    "finished",
    "original-thread",
    f.base,
    0,
    history,
  );
  db.close();
  runs.close();
  journal.close();
  const device = new DatabaseSync(path.join(f.base, "device.sqlite"));
  device.exec(
    "CREATE TRIGGER interrupt_reset BEFORE DELETE ON metadata BEGIN SELECT RAISE(ABORT,'reset interrupted'); END",
  );
  await assert.rejects(
    f.controller.reset("alice", f.config.runnerId, proof),
    /reset interrupted/,
  );
  assert.equal(f.credentials.values.size, 0);
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  device.exec("DROP TRIGGER interrupt_reset");
  device.close();
  assert.equal(
    (await f.controller.reset("alice", f.config.runnerId, proof)).paired,
    false,
  );
  const preserved = new DatabaseSync(
    path.join(f.executionDir, "adapter.sqlite"),
    { readOnly: true },
  );
  assert.equal(
    preserved.prepare("SELECT data FROM runs WHERE run_id='finished'").get()
      .data,
    history,
  );
  preserved.close();
});

test("close while reset evidence is delayed preserves the identity and credential", async (t) => {
  const f = await fixture(t);
  let finish;
  const operation = f.controller.reset(
    "alice",
    f.config.runnerId,
    (target) =>
      new Promise((resolve) => {
        finish = () => resolve({ ...target, status: "revoked", authEpoch: 2 });
      }),
  );
  const rejected = assert.rejects(operation, { code: "CONTROLLER_CLOSED" });
  for (let n = 0; n < 30 && !finish; n++) await tick();
  assert.ok(finish);
  const closed = f.controller.close();
  finish();
  await rejected;
  await closed;
  assert.equal(persisted(f).runnerId, f.config.runnerId);
  assert.equal(f.credentials.values.size, 1);
});

test("reset is excluded by another process holding the execution consumer", async (t) => {
  const f = await fixture(t, { missing: true });
  const file = path.join(f.executionDir, "execution.sqlite");
  const source =
    "import {ExecutionStore,RunnerStore} from " +
    JSON.stringify(apiUrl) +
    ";const j=new ExecutionStore(" +
    JSON.stringify(file) +
    ");const r=new RunnerStore(" +
    JSON.stringify(path.join(f.executionDir, "adapter.sqlite")) +
    ");const release=j.acquireConsumer();process.stdout.write('LOCKED\\n');process.stdin.once('data',()=>{release();r.close();j.close();process.stdin.destroy();});";
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const ended = new Promise((resolve) => child.once("exit", resolve));
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error(err)));
    });
    await assert.rejects(
      f.controller.reset("alice", f.config.runnerId, proof),
      { code: "EXECUTOR_BUSY" },
    );
    assert.equal(persisted(f).runnerId, f.config.runnerId);
    child.stdin.end("release");
    assert.equal(await ended, 0, err);
    assert.equal(
      (await f.controller.reset("alice", f.config.runnerId, proof)).paired,
      false,
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await ended;
  }
});

test("executor reset guard drains independent reconciliation and retains its consumer lock", async (t) => {
  const f = await fixture(t);
  const journal = new api.ExecutionStore(
    path.join(f.executionDir, "execution.sqlite"),
  );
  const runs = new api.RunnerStore(path.join(f.executionDir, "adapter.sqlite"));
  const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
  const executor = new api.RunnerExecutor({
    store: journal,
    runs,
    device,
    registry: new api.WorkspaceRegistry(device, {
      locksDir: f.settings.locksDir,
    }),
    transport: () => undefined,
    runnerId: f.config.runnerId,
    ownerId: "alice",
    authEpoch: 1,
    enabled: () => false,
  });
  t.after(async () => {
    await executor.close({ stop: false });
    runs.close();
    journal.close();
    device.close();
  });
  // A reconciliation may have cleared its hold before its asynchronous caller
  // has finished. Exercise that separate lifetime, not just the polling loop.
  let finish;
  executor.reconciling = new Promise((resolve) => {
    finish = resolve;
  });
  let entered = false;
  const guarded = executor.withDeviceResetGuard(async () => {
    entered = true;
    assert.throws(() => journal.acquireConsumer(), { code: "EXECUTOR_BUSY" });
    const active = journal.reserve("new-claim", "workspace");
    journal.bindClaim(active, 2);
    journal.updateHold(journal.held(), "claimed");
    executor.requestReconciliation();
    assert.equal(journal.reconciliationRequested(journal.held()), false);
    journal.clearHold(journal.held());
  });
  await tick();
  assert.equal(entered, false);
  finish();
  await guarded;
  assert.equal(entered, true);
});

test("a native reconciliation must release its local hold before authenticated unbind can preserve its history", async (t) => {
  const f = await recoveryHarness(t, {
    mode: "exit-thread-start",
    runnerId: randomUUID(),
  });
  await f.create();
  await f.until(() => f.journal.latest(f.runId)?.phase === "uncertain");
  let deletes = 0,
    revocations = 0;
  f.controller.credentials = {
    read: async () => "synthetic",
    delete: async () => {
      deletes++;
    },
  };
  const authorized = {
    expectedRunnerId: f.principal.runnerId,
    revokeAndVerify: async (target) => {
      revocations++;
      return proof(target);
    },
  };
  await assert.rejects(f.controller.forget(f.principal.ownerId, authorized), {
    code: "WORKSPACE_BUSY",
  });
  assert.equal(deletes, 0);
  assert.equal(revocations, 0);
  assert.equal(
    (await f.nativeState()).calls.filter((call) => call.method === "turn/start")
      .length,
    0,
  );
  f.setMode("normal");
  await f.restart();
  await f.reconnect();
  await f.until(() => !f.executor.hasHold);
  assert.equal(f.controller.store.leases().length, 0);
  const entry = f.journal.latest(f.runId);
  const run = f.runs.getRun(f.runId);
  assert.equal(run.active, false);
  assert.equal(run.terminal, true);
  f.controller.credentials = {
    read: async () => "synthetic",
    delete: async () => {
      deletes++;
    },
  };
  assert.equal(
    (await f.controller.forget(f.principal.ownerId, authorized)).paired,
    false,
  );
  assert.equal(deletes, 1);
  assert.equal(revocations, 1);
  const journal = new DatabaseSync(f.journalPath, { readOnly: true });
  assert.deepEqual(
    JSON.parse(
      journal
        .prepare("SELECT data FROM commands WHERE key=?")
        .get(entry.envelope.commandId).data,
    ),
    entry,
  );
  journal.close();
  const runs = new DatabaseSync(
    path.join(path.dirname(f.journalPath), "adapter.sqlite"),
    { readOnly: true },
  );
  assert.deepEqual(
    JSON.parse(
      runs.prepare("SELECT data FROM runs WHERE run_id=?").get(f.runId).data,
    ),
    run,
  );
  runs.close();
});

for (const kind of [
  "expired lease",
  "held settled",
  "active native",
  "unknown native",
  "unreceived native command",
  "directory lock",
  "corrupt journal",
  "missing companion",
])
  test(
    "reset preserves " + kind + " after restart with execution disabled",
    async (t) => {
      const f = await fixture(t, { missing: true });
      assert.equal(typeof f.controller.reset, "function");
      const project = path.join(f.base, "project");
      await mkdir(project);
      await f.controller.registerWorkspace("alice", { root: project });
      const workspace = f.controller.status("alice").workspaces[0];
      const device = new api.DeviceStore(path.join(f.base, "device.sqlite"));
      const journal = new api.ExecutionStore(
        path.join(f.executionDir, "execution.sqlite"),
      );
      const runs = new api.RunnerStore(
        path.join(f.executionDir, "adapter.sqlite"),
      );
      if (kind === "expired lease")
        device.saveLease({
          workspaceId: workspace.workspaceId,
          runId: "run-a",
          leaseEpoch: 1,
          expiresAt: 1,
        });
      if (kind === "held settled") {
        const held = journal.reserve("run-a", workspace.workspaceId);
        journal.bindClaim(held, 1);
        const db = new DatabaseSync(
          path.join(f.executionDir, "execution.sqlite"),
        );
        db.prepare("INSERT INTO state VALUES (?,?)").run(
          "reconciliation:run-a",
          JSON.stringify({ claim: { ...held, leaseEpoch: 1 }, settled: true }),
        );
        db.close();
      }
      if (kind === "active native" || kind === "unknown native") {
        const db = new DatabaseSync(
          path.join(f.executionDir, "adapter.sqlite"),
        );
        db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
          "run-a",
          null,
          project,
          1,
          JSON.stringify({
            runId: "run-a",
            active: true,
            terminal: false,
            status:
              kind === "active native" ? "running" : "reconciliation_required",
          }),
        );
        db.close();
      }
      if (kind === "unreceived native command")
        device.receiveCommand(
          { commandId: "cmd-a", runId: "run-a", payload: {} },
          { status: "stored" },
        );
      if (kind === "directory lock")
        await new api.WorkspaceRegistry(device, {
          locksDir: f.settings.locksDir,
        }).acquire(workspace.workspaceId, "run-a");
      runs.close();
      journal.close();
      device.close();
      await f.controller.close();
      if (kind === "corrupt journal")
        await writeFile(
          path.join(f.executionDir, "execution.sqlite"),
          "invalid sqlite",
        );
      if (kind === "missing companion")
        await rm(path.join(f.executionDir, "adapter.sqlite"));
      const restarted = new api.RunnerDeviceController(f.settings);
      t.after(() => restarted.close());
      await assert.rejects(
        restarted.reset("alice", f.config.runnerId, proof),
        (error) =>
          ["WORKSPACE_BUSY", "RESET_STATE_UNKNOWN"].includes(error.code),
      );
      assert.equal(restarted.status("alice").runnerId, f.config.runnerId);
    },
  );

test("pending retries keep an independent process alive until recovery and explicit close", async (t) => {
  const f = await fixture(t, { pending: true });
  await f.controller.close();
  const source = [
    "import {RunnerDeviceController,MemoryCredentialStore,credentialTarget} from " +
      JSON.stringify(apiUrl) +
      ";",
    "const credentials=new MemoryCredentialStore();",
    "await credentials.write(credentialTarget(" +
      JSON.stringify(origin) +
      "," +
      JSON.stringify(f.config.runnerId) +
      "),'synthetic-secret');",
    "let count=0;const c=new RunnerDeviceController({stateDir:" +
      JSON.stringify(f.base) +
      ",serverOrigin:" +
      JSON.stringify(origin) +
      ",credentials,locksDir:" +
      JSON.stringify(f.settings.locksDir) +
      ",",
    "fetch:async()=>++count===1?new Response('{}',{status:503}):new Response(" +
      JSON.stringify(
        JSON.stringify({
          runnerId: f.config.runnerId,
          ownerId: "alice",
          authEpoch: 1,
        }),
      ) +
      "),",
    "transportFactory:()=>({status:{connectionStatus:'online',connectionEpoch:1,lastHeartbeatAt:null,error:null},async start(){process.stdout.write('RECOVERED'); void c.close();},close(){},reconnect(){},async updateWorkspaces(){}})});await c.start();",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, err);
  assert.equal(out, "RECOVERED");
  assert.equal(persisted(f).pairingPending, false);
});
