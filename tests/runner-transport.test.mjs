import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const dir = await mkdtemp(path.join(root, ".tmp/transport-test-"));
let api;
try {
  await build({
    stdin: {
      contents:
        "export * from './runner/device-store.ts';export * from './runner/transport.ts';export * from './runner/credentials.ts';export * from './runner/device-controller.ts';export {digest} from './runner/store.ts';",
      resolveDir: root,
    },
    outfile: path.join(dir, "api.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  api = await import(pathToFileURL(path.join(dir, "api.mjs")));
} catch (error) {
  test("native runner transport implementation exists", () =>
    assert.fail(error.message));
}
test.after(() => rm(dir, { recursive: true, force: true }));
if (api) {
  class Clock {
    time = 1700000000000;
    timers = new Map();
    next = 0;
    now = () => this.time;
    setTimeout = (fn, ms) => {
      const id = ++this.next;
      this.timers.set(id, { fn, at: this.time + ms });
      return id;
    };
    clearTimeout = (id) => this.timers.delete(id);
    async advance(ms) {
      const end = this.time + ms;
      for (let n = 0; n < 1000; n++) {
        let entry = [...this.timers]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        this.time = entry[1].at;
        this.timers.delete(entry[0]);
        entry[1].fn();
        await tick();
      }
      this.time = end;
      await tick();
    }
  }
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.emit("close", 1000);
    }
    packet(value) {
      this.emit(
        "message",
        Buffer.from(JSON.stringify({ protocolVersion: 1, ...value })),
      );
    }
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  async function fixture(t) {
    const base = await mkdtemp(path.join(dir, "case-"));
    const store = new api.DeviceStore(path.join(base, "device.sqlite"));
    const clock = new Clock();
    const sockets = [];
    let tokenRequests = 0;
    const transport = new api.RunnerTransport({
      store,
      runnerId: "runner-a",
      ownerId: "owner-a",
      authEpoch: 1,
      serverOrigin: "http://127.0.0.1:8788",
      secret: async () => "secret-only-in-memory",
      workspaces: () => [],
      clock,
      fetch: async () => {
        tokenRequests++;
        return new Response(
          JSON.stringify({
            token: "opaque",
            expiresAt: new Date(clock.now() + 900000).toISOString(),
            runnerId: "runner-a",
            ownerId: "owner-a",
            authEpoch: 1,
          }),
        );
      },
      socketFactory: (url, options) => {
        assert.equal(options.headers.Authorization, "Bearer opaque");
        assert.equal(options.headers.Origin, undefined);
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    t.after(() => {
      transport.close();
      store.close();
    });
    await transport.start();
    await tick();
    const welcome = (epoch = 1) =>
      sockets.at(-1).packet({
        type: "welcome",
        runnerId: "runner-a",
        connectionEpoch: epoch,
        authEpoch: 1,
        heartbeatMs: 15000,
        leaseMs: 60000,
        serverTime: clock.now(),
      });
    welcome();
    await tick();
    return {
      base,
      store,
      clock,
      sockets,
      transport,
      welcome,
      tokenRequests: () => tokenRequests,
    };
  }
  function envelope(f, patch = {}) {
    const payload = {
      type: "cancel_run",
      requestId: "request-a",
      runId: "run-a",
    };
    return {
      protocolVersion: 1,
      commandId: "command-a",
      runId: "run-a",
      bindingRevision: 1,
      authEpoch: 1,
      leaseEpoch: 1,
      payloadHash: api.digest(payload),
      issuedAt: new Date(f.clock.now() - 100).toISOString(),
      expiresAt: new Date(f.clock.now() + 60000).toISOString(),
      payload,
      ...patch,
    };
  }
  test("vault targets are narrowly scoped and secrets travel only over stdin", async () => {
    assert.throws(() =>
      api.credentialTarget("http://evil.example", "runner-a"),
    );
    const target = api.credentialTarget(
      "http://127.0.0.1:8788",
      "12345678-1234-4234-8234-123456789abc",
    );
    assert.match(target, /^QingdanRunner\/v1\//);
    const calls = [];
    const vault = new api.WindowsCredentialManager({
      platform: "win32",
      invoke: async (request) => {
        calls.push(request);
        return request.operation === "read" ? "secret-value" : null;
      },
    });
    await vault.write(target, "secret-value");
    assert.equal(await vault.read(target), "secret-value");
    await vault.delete(target);
    assert.equal(calls[0].secret, "secret-value");
    assert.throws(() => vault.validateTarget("other-app/credential"));
    const source = await readFile(
      path.join(root, "runner/credential-helper.ps1"),
      "utf8",
    );
    assert.match(source, /CredWriteW/);
    assert.match(source, /CredReadW/);
    assert.match(source, /\[Console\]::In\.ReadToEnd/);
    assert.doesNotMatch(source, /CredEnumerate/);
  });
  test("durable event ACK survives restart and command receipts deduplicate exact hashes", async (t) => {
    const f = await fixture(t);
    f.store.saveLease({
      workspaceId: "workspace-a",
      runId: "run-a",
      leaseEpoch: 1,
      expiresAt: f.clock.now() + 60000,
    });
    const e = envelope(f);
    const s = f.sockets[0];
    s.packet({ type: "command", connectionEpoch: 1, envelope: e });
    await tick();
    assert.equal(s.sent.at(-1).receipt.status, "stored");
    s.packet({ type: "command", connectionEpoch: 1, envelope: e });
    await tick();
    assert.equal(f.store.commands().length, 1);
    s.packet({
      type: "command",
      connectionEpoch: 1,
      envelope: { ...e, payload: { ...e.payload, requestId: "changed" } },
    });
    await tick();
    assert.equal(s.sent.at(-1).receipt.status, "rejected");
    const event = {
      protocolVersion: 1,
      eventId: "event-a",
      runnerId: "runner-a",
      runId: "run-a",
      threadId: null,
      turnId: null,
      seq: 1,
      type: "run.accepted",
      occurredAt: new Date(f.clock.now()).toISOString(),
      payload: { status: "queued" },
    };
    f.transport.publish(event);
    assert.equal(f.store.pendingEvents().length, 1);
    s.packet({ type: "event_ack", connectionEpoch: 1, eventId: "event-a" });
    await tick();
    assert.equal(f.store.pendingEvents().length, 0);
    const sentBefore = s.sent.length;
    f.transport.publish(event);
    assert.equal(s.sent.length, sentBefore);
    assert.throws(
      () => f.transport.publish({ ...event, payload: { status: "preparing" } }),
      /different|reused/i,
    );
    const replay = { ...event, eventId: "event-b", seq: 2 };
    f.transport.publish(replay);
    f.transport.reconnect();
    await tick();
    f.welcome(2);
    await tick();
    assert.deepEqual(
      f.sockets
        .at(-1)
        .sent.filter((p) => p.type === "event")
        .map((p) => p.event.eventId),
      ["event-b"],
    );
  });
  test("stale epochs, expired auth and expired leases never reach the inbox", async (t) => {
    const f = await fixture(t);
    const s = f.sockets[0];
    const e = envelope(f);
    s.packet({ type: "command", connectionEpoch: 0, envelope: e });
    await tick();
    assert.equal(f.store.commands().length, 0);
    s.packet({ type: "command", connectionEpoch: 1, envelope: e });
    await tick();
    assert.equal(s.sent.at(-1).receipt.status, "rejected");
    f.store.saveLease({
      workspaceId: "workspace-a",
      runId: "run-a",
      leaseEpoch: 1,
      expiresAt: f.clock.now() + 60000,
    });
    s.packet({
      type: "command",
      connectionEpoch: 1,
      envelope: { ...e, commandId: "auth-bad", authEpoch: 2 },
    });
    await tick();
    assert.equal(s.sent.at(-1).receipt.status, "rejected");
    s.packet({
      type: "command",
      connectionEpoch: 1,
      envelope: {
        ...e,
        commandId: "expired",
        expiresAt: new Date(f.clock.now() - 1).toISOString(),
      },
    });
    await tick();
    assert.equal(s.sent.at(-1).receipt.status, "rejected");
  });
  test("15s heartbeat, 45s offline, bounded retry and revocation stop", async (t) => {
    const f = await fixture(t);
    await f.clock.advance(15000);
    assert.equal(
      f.sockets[0].sent.filter((p) => p.type === "heartbeat").length,
      1,
    );
    await f.clock.advance(30000);
    assert.equal(f.transport.status.connectionStatus, "offline");
    await f.clock.advance(1000);
    assert.equal(f.sockets.length, 2);
    f.welcome(2);
    await tick();
    f.sockets[1].packet({ type: "revoked", reason: "revoked" });
    await tick();
    const n = f.tokenRequests();
    await f.clock.advance(300000);
    assert.equal(f.tokenRequests(), n);
    assert.equal(f.transport.status.connectionStatus, "revoked");
  });
  test("unacknowledged events persist across SQLite reopen and acknowledged events do not replay", async (t) => {
    const filename = path.join(dir, `reopen-${Date.now()}.sqlite`);
    let store = new api.DeviceStore(filename);
    const event = {
      protocolVersion: 1,
      eventId: "persistent",
      runnerId: "r",
      runId: "x",
      threadId: null,
      turnId: null,
      seq: 1,
      type: "run.accepted",
      occurredAt: new Date().toISOString(),
      payload: { status: "queued" },
    };
    store.enqueueEvent(event);
    store.close();
    store = new api.DeviceStore(filename);
    assert.equal(store.pendingEvents().length, 1);
    store.ackEvent(event.eventId);
    store.close();
    store = new api.DeviceStore(filename);
    assert.equal(store.pendingEvents().length, 0);
    store.close();
  });
  test("controller recovers ambiguous pairing with the saved identity without writing plaintext secrets", async (t) => {
    const base = await mkdtemp(path.join(dir, "controller-"));
    const vault = new api.MemoryCredentialStore();
    let paired;
    let pairCalls = 0;
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/pair")) {
        pairCalls++;
        paired = body;
        throw new Error("response dropped after commit");
      }
      return new Response(
        JSON.stringify({
          token: "opaque",
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          runnerId: body.runnerId,
          ownerId: "owner-a",
          authEpoch: 1,
        }),
      );
    };
    const transportFactory = () => ({
      status: {
        connectionStatus: "online",
        connectionEpoch: 1,
        lastHeartbeatAt: null,
        error: null,
      },
      start: async () => {},
      close() {},
      reconnect() {},
      updateWorkspaces: async () => {},
    });
    let controller = new api.RunnerDeviceController({
      stateDir: base,
      serverOrigin: "http://127.0.0.1:8788",
      credentials: vault,
      fetch: fakeFetch,
      transportFactory,
    });
    await controller.start();
    const view = await controller.pair({
      ownerId: "owner-a",
      pairingCode: "code",
      deviceName: "PC",
    });
    assert.equal(view.paired, true);
    assert.equal(view.runnerId, paired.runnerId);
    assert.equal(pairCalls, 1);
    assert.throws(() => controller.status("other"), /owner|account/i);
    await controller.close();
    controller = new api.RunnerDeviceController({
      stateDir: base,
      serverOrigin: "http://127.0.0.1:8788",
      credentials: vault,
      fetch: fakeFetch,
      transportFactory,
    });
    await controller.start();
    assert.equal(controller.status("owner-a").runnerId, paired.runnerId);
    await assert.rejects(controller.forget("owner-a"), /revok/i);
    await controller.close();
    const bytes = await readFile(path.join(base, "device.sqlite"));
    for (const secret of vault.values.values())
      assert.equal(bytes.includes(Buffer.from(secret)), false);
  });
  test("token renewal uses a fresh opaque token before 15m expiry", async (t) => {
    const f = await fixture(t);
    for (let n = 0; n < 55; n++) {
      await f.clock.advance(15000);
      f.sockets.at(-1).packet({
        type: "heartbeat_ack",
        connectionEpoch: 1,
        serverTime: f.clock.now(),
        leases: [],
      });
      await tick();
    }
    assert.equal(f.tokenRequests(), 1);
    await f.clock.advance(15000);
    assert.equal(f.tokenRequests(), 2);
    assert.equal(f.sockets.length, 2);
    f.welcome(2);
    await tick();
    assert.equal(f.transport.status.connectionStatus, "online");
  });
  test("close during token fetch prevents late sockets and retry timers", async (t) => {
    const base = await mkdtemp(path.join(dir, "close-race-"));
    const store = new api.DeviceStore(path.join(base, "device.sqlite"));
    t.after(() => store.close());
    const clock = new Clock();
    let finish;
    let sockets = 0;
    const transport = new api.RunnerTransport({
      store,
      runnerId: "runner-a",
      ownerId: "owner-a",
      authEpoch: 1,
      serverOrigin: "http://127.0.0.1:8788",
      secret: async () => "memory",
      workspaces: () => [],
      clock,
      fetch: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      socketFactory: () => {
        sockets++;
        return new Socket();
      },
    });
    await transport.start();
    await tick();
    transport.close();
    assert.equal(clock.timers.size, 0);
    finish(
      new Response(
        JSON.stringify({
          token: "opaque",
          expiresAt: new Date(clock.now() + 900000).toISOString(),
          runnerId: "runner-a",
          ownerId: "owner-a",
          authEpoch: 1,
        }),
      ),
    );
    await tick();
    await clock.advance(1000000);
    assert.equal(sockets, 0);
    assert.equal(clock.timers.size, 0);
  });
  test("stale command validation cannot persist after the socket generation changes", async (t) => {
    const f = await fixture(t);
    let finish;
    f.transport.close();
    const socket = new Socket();
    const transport = new api.RunnerTransport({
      store: f.store,
      runnerId: "runner-a",
      ownerId: "owner-a",
      authEpoch: 1,
      serverOrigin: "http://127.0.0.1:8788",
      secret: async () => "memory",
      workspaces: () => [],
      clock: f.clock,
      fetch: async () =>
        new Response(
          JSON.stringify({
            token: "opaque",
            expiresAt: new Date(f.clock.now() + 900000).toISOString(),
            runnerId: "runner-a",
            ownerId: "owner-a",
            authEpoch: 1,
          }),
        ),
      socketFactory: () => socket,
      validateWorkspace: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    t.after(() => transport.close());
    await transport.start();
    await tick();
    socket.packet({
      type: "welcome",
      runnerId: "runner-a",
      connectionEpoch: 2,
      authEpoch: 1,
      heartbeatMs: 15000,
      leaseMs: 60000,
      serverTime: f.clock.now(),
    });
    await tick();
    f.store.saveLease({
      workspaceId: "workspace-a",
      runId: "run-a",
      leaseEpoch: 1,
      expiresAt: f.clock.now() + 60000,
    });
    socket.packet({
      type: "command",
      connectionEpoch: 2,
      envelope: envelope(f),
    });
    await tick();
    transport.close();
    assert.equal(f.clock.timers.size, 0);
    finish();
    await tick();
    assert.equal(f.store.commands().length, 0);
  });

  test("real native WebSocket authenticates with a Bearer header and no browser Origin", async (t) => {
    const base = await mkdtemp(path.join(dir, "native-"));
    const store = new api.DeviceStore(path.join(base, "device.sqlite"));
    const server = createServer(async (req, res) => {
      assert.equal(req.url, "/api/runner/token");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      assert.deepEqual(JSON.parse(raw), {
        runnerId: "runner-a",
        secret: "memory-secret",
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          token: "opaque-native",
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          runnerId: "runner-a",
          ownerId: "owner-a",
          authEpoch: 1,
        }),
      );
    });
    const ws = new WebSocketServer({ noServer: true });
    let authorization;
    let origin;
    server.on("upgrade", (req, socket, head) => {
      authorization = req.headers.authorization;
      origin = req.headers.origin;
      assert.equal(req.url, "/api/runner/connect");
      ws.handleUpgrade(req, socket, head, (client) =>
        ws.emit("connection", client),
      );
    });
    ws.on("connection", (client) =>
      client.send(
        JSON.stringify({
          protocolVersion: 1,
          type: "welcome",
          runnerId: "runner-a",
          connectionEpoch: 1,
          authEpoch: 1,
          heartbeatMs: 15000,
          leaseMs: 60000,
          serverTime: Date.now(),
        }),
      ),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const transport = new api.RunnerTransport({
      store,
      runnerId: "runner-a",
      ownerId: "owner-a",
      authEpoch: 1,
      serverOrigin: `http://127.0.0.1:${server.address().port}`,
      secret: async () => "memory-secret",
      workspaces: () => [],
    });
    t.after(async () => {
      transport.close();
      for (const client of ws.clients) client.terminate();
      await new Promise((resolve) => ws.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      store.close();
    });
    await transport.start();
    for (
      let n = 0;
      n < 100 && transport.status.connectionStatus !== "online";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(transport.status.connectionStatus, "online");
    assert.equal(authorization, "Bearer opaque-native");
    assert.equal(origin, undefined);
  });
  test("60s lease expiry rejects commands and retains logical ownership", async (t) => {
    const f = await fixture(t);
    f.store.saveLease({
      workspaceId: "workspace-a",
      runId: "run-a",
      leaseEpoch: 1,
      expiresAt: f.clock.now() + 60000,
    });
    for (let n = 0; n < 4; n++) {
      await f.clock.advance(15000);
      f.sockets[0].packet({
        type: "heartbeat_ack",
        connectionEpoch: 1,
        serverTime: f.clock.now(),
        leases: [],
      });
      await tick();
    }
    f.sockets[0].packet({
      type: "command",
      connectionEpoch: 1,
      envelope: envelope(f),
    });
    await tick();
    assert.deepEqual(f.sockets[0].sent.at(-1).receipt, {
      status: "rejected",
      reason: "LEASE_EXPIRED",
    });
    assert.throws(
      () =>
        f.store.saveLease({
          workspaceId: "workspace-a",
          runId: "replacement-run",
          leaseEpoch: 2,
          expiresAt: f.clock.now() + 60000,
        }),
      /unconfirmed/i,
    );
    assert.equal(f.store.lease("run-a").runId, "run-a");
  });
  test("restart after a >60s outage retains expired occupancy but heartbeats omit expired renewals", async (t) => {
    const f = await fixture(t);
    f.store.saveLease({
      workspaceId: "expired-workspace",
      runId: "expired-run",
      leaseEpoch: 1,
      expiresAt: f.clock.now() + 60000,
    });
    f.transport.close();
    await f.clock.advance(61000);
    f.transport.reconnect();
    await tick();
    f.welcome(2);
    await tick();
    f.store.saveLease({
      workspaceId: "live-workspace",
      runId: "live-run",
      leaseEpoch: 2,
      expiresAt: f.clock.now() + 60000,
    });
    for (let n = 0; n < 5; n++) {
      await f.clock.advance(15000);
      const heartbeat = f.sockets.at(-1).sent.at(-1);
      assert.equal(heartbeat.type, "heartbeat");
      assert.deepEqual(heartbeat.leases, [
        { workspaceId: "live-workspace", runId: "live-run", leaseEpoch: 2 },
      ]);
      f.sockets.at(-1).packet({
        type: "heartbeat_ack",
        connectionEpoch: 2,
        serverTime: f.clock.now(),
        leases: [
          {
            workspaceId: "live-workspace",
            runId: "live-run",
            leaseEpoch: 2,
            expiresAt: f.clock.now() + 60000,
          },
        ],
      });
      await tick();
    }
    assert.equal(f.transport.status.connectionStatus, "online");
    assert.equal(f.sockets.length, 2);
    f.sockets
      .at(-1)
      .packet({
        type: "heartbeat_ack",
        connectionEpoch: 2,
        serverTime: f.clock.now(),
        leases: [
          {
            workspaceId: "expired-workspace",
            runId: "expired-run",
            leaseEpoch: 1,
            expiresAt: f.clock.now() + 60000,
          },
        ],
      });
    await tick();
    assert.equal(f.store.lease("expired-run").expiresAt, 1700000060000);
    assert.throws(
      () =>
        f.store.saveLease({
          workspaceId: "expired-workspace",
          runId: "replacement",
          leaseEpoch: 2,
          expiresAt: f.clock.now() + 60000,
        }),
      /unconfirmed/i,
    );
  });
  test("epoch-free Hub error rejects immediately; old sockets cannot reject current requests", async (t) => {
    const f = await fixture(t);
    let result;
    const rejected = f.transport.updateWorkspaces().then(
      () => {
        result = "resolved";
      },
      (error) => {
        result = error.code;
      },
    );
    const request = f.sockets[0].sent.at(-1);
    f.sockets[0].packet({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Project occupied",
      requestId: request.requestId,
    });
    await tick();
    assert.equal(result, "INVALID_MESSAGE");
    await rejected;
    f.transport.reconnect();
    await tick();
    f.welcome(2);
    await tick();
    result = "pending";
    const current = f.transport.updateWorkspaces().then(
      () => {
        result = "resolved";
      },
      (error) => {
        result = error.code;
      },
    );
    const currentRequest = f.sockets[1].sent.at(-1);
    f.sockets[0].packet({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "old socket",
      requestId: currentRequest.requestId,
    });
    await tick();
    assert.equal(result, "pending");
    f.sockets[1].packet({
      type: "workspaces_ack",
      connectionEpoch: 2,
      requestId: currentRequest.requestId,
    });
    await current;
    assert.equal(result, "resolved");
    f.sockets[1].packet({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Registration metadata invalid",
    });
    await tick();
    assert.match(f.transport.status.error, /Registration metadata invalid/);
  });
  test("device name 101 is rejected before credentials/config; 100 pairs without poisoned state", async (t) => {
    const base = await mkdtemp(path.join(dir, "metadata-"));
    const vault = new api.MemoryCredentialStore();
    let requests = 0;
    const fakeFetch = async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          runnerId: body.runnerId,
          ownerId: "owner-a",
          authEpoch: 1,
        }),
      );
    };
    const controller = new api.RunnerDeviceController({
      stateDir: base,
      serverOrigin: "http://127.0.0.1:8788",
      credentials: vault,
      fetch: fakeFetch,
      transportFactory: () => ({
        status: {
          connectionStatus: "online",
          connectionEpoch: 1,
          lastHeartbeatAt: null,
          error: null,
        },
        start: async () => {},
        close() {},
        reconnect() {},
        updateWorkspaces: async () => {},
      }),
    });
    t.after(() => controller.close());
    await assert.rejects(
      controller.pair({
        ownerId: "owner-a",
        pairingCode: "code",
        deviceName: "N".repeat(101),
      }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.equal(vault.values.size, 0);
    assert.equal(requests, 0);
    assert.equal(controller.status("owner-a").runnerId, null);
    const persisted = new api.DeviceStore(path.join(base, "device.sqlite"));
    assert.equal(persisted.config(), null);
    persisted.close();
    const result = await controller.pair({
      ownerId: "owner-a",
      pairingCode: "code",
      deviceName: "N".repeat(100),
    });
    assert.equal(result.paired, true);
    assert.equal(result.deviceName.length, 100);
    assert.equal(vault.values.size, 1);
    assert.equal(requests, 1);
  });
  test("corrected name recovers a legacy invalid pending identity without replacing its credential", async (t) => {
    const base = await mkdtemp(path.join(dir, "legacy-pending-"));
    const vault = new api.MemoryCredentialStore();
    const runnerId = "12345678-1234-4234-8234-123456789abc";
    const target = api.credentialTarget("http://127.0.0.1:8788", runnerId);
    await vault.write(target, "existing-memory-secret");
    const store = new api.DeviceStore(path.join(base, "device.sqlite"));
    store.saveConfig({
      runnerId,
      ownerId: "owner-a",
      deviceName: "x".repeat(101),
      serverOrigin: "http://127.0.0.1:8788",
      authEpoch: 1,
      enabled: true,
      pairingPending: true,
    });
    store.close();
    let claimed;
    const controller = new api.RunnerDeviceController({
      stateDir: base,
      serverOrigin: "http://127.0.0.1:8788",
      credentials: vault,
      fetch: async (url, init) => {
        if (url.endsWith("/token")) return new Response("{}", { status: 401 });
        claimed = JSON.parse(init.body);
        assert.equal(claimed.deviceName, "Corrected");
        return new Response(
          JSON.stringify({ runnerId, ownerId: "owner-a", authEpoch: 1 }),
        );
      },
      transportFactory: () => ({
        status: {
          connectionStatus: "online",
          connectionEpoch: 1,
          lastHeartbeatAt: null,
          error: null,
        },
        start: async () => {},
        close() {},
        reconnect() {},
        updateWorkspaces: async () => {},
      }),
    });
    t.after(() => controller.close());
    const view = await controller.pair({
      ownerId: "owner-a",
      pairingCode: "new-code",
      deviceName: "Corrected",
    });
    assert.equal(view.deviceName, "Corrected");
    assert.equal(claimed.runnerId, runnerId);
    assert.equal(await vault.read(target), "existing-memory-secret");
    assert.equal(vault.values.size, 1);
  });
}
