import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const raw = "a".repeat(64);
test(
  "pairing, device auth and durable RunnerHub protocol in isolated workerd",
  { timeout: 60000 },
  async (t) => {
    await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
    const out = await mkdtemp(
      new URL("../.tmp/agent-pairing-", import.meta.url),
    );
    await build({
      entryPoints: [
        new URL("../worker/index.ts", import.meta.url).pathname.replace(
          /^\/([A-Z]:)/,
          "$1",
        ),
      ],
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "browser"],
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: path.join(out, "worker.mjs"),
      logLevel: "silent",
    });
    const options = convertV4MiniflareOptions({
      name: "agent-pairing",
      scriptPath: path.join(out, "worker.mjs"),
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: {
        ROOMS: { className: "CanvasRoom", useSQLite: true },
        RUNNER_HUBS: { className: "RunnerHub", useSQLite: true },
      },
      bindings: { APP_ENV: "test", RUNNER_ENABLED: "true" },
    });
    options.isolatedResourcePersistencePath = path.join(out, "isolated");
    options.resourcePersistencePath = path.join(out, "state");
    options.unsafeEnableSharedStorage = true;
    options.unsafeDevRegistryPath = path.join(out, "registry");
    const mf = new Miniflare(options);
    t.after(async () => {
      await mf.dispose();
      await rm(out, { recursive: true, force: true });
    });
    const db = await mf.getD1Database("DB");
    for (const f of (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = (
        await readFile(new URL("../migrations/" + f, import.meta.url), "utf8")
      ).replace(/^--.*$/gm, "");
      await db.batch(
        sql
          .split(";")
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
      );
    }
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026'),('bob','bob','Bob','hash','2026')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(raw), "alice", Date.now() + 3600000),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha("b".repeat(64)), "bob", Date.now() + 3600000),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
      ),
    ]);
    const call = async (route, data, headers = {}) => {
      const r = await mf.dispatchFetch("https://app.test" + route, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Cookie: "qd_session=" + raw,
          "X-QD-Account": "alice",
          "Content-Type": "application/json",
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: r.status, ...(await r.json()) };
    };
    const native = (route, data, headers = {}) =>
      call(route, data, { Cookie: "", "X-QD-Account": "", ...headers });
    const pairing = await call("/api/agent/devices/pairings", {});
    assert.equal(pairing.status, 200, JSON.stringify(pairing));
    assert.match(pairing.pairingCode, /^[a-f0-9]{32}$/);
    assert.equal(
      (await call("/api/agent/devices/pairings", {}, { "X-QD-Account": "bob" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("/api/agent/devices", undefined, {
          Origin: "https://evil.test",
        })
      ).status,
      403,
    );
    const runnerId = randomUUID(),
      secret = "s".repeat(64),
      pair = {
        pairingCode: pairing.pairingCode,
        runnerId,
        deviceName: "Windows",
        secretHash: sha(secret),
        expectedOwnerId: "alice",
      };
    assert.equal(
      (await native("/api/runner/pair", { ...pair, expectedOwnerId: "bob" }))
        .status,
      403,
    );
    assert.equal(
      (await native("/api/runner/pair", pair, { Origin: "https://app.test" }))
        .status,
      403,
    );
    const results = await Promise.all([
      native("/api/runner/pair", pair),
      native("/api/runner/pair", pair),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const stored = await db
      .prepare("SELECT * FROM agent_pairings WHERE pairing_id=?")
      .bind(pairing.pairingId)
      .first();
    assert.equal(stored.code_hash, sha(pairing.pairingCode));
    assert.equal(JSON.stringify(stored).includes(pairing.pairingCode), false);
    assert.equal(
      (await native("/api/runner/token", { runnerId, secret: "wrong" })).status,
      401,
    );
    const expiredAuth = await native("/api/runner/token", { runnerId, secret });
    await db
      .prepare(
        "UPDATE agent_connection_tokens SET expires_at=0 WHERE token_hash=?",
      )
      .bind(sha(expiredAuth.token))
      .run();
    const expiredUpgrade = await mf.dispatchFetch(
      "https://app.test/api/runner/connect",
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + expiredAuth.token,
        },
      },
    );
    assert.equal(expiredUpgrade.status, 401);
    const auth = await native("/api/runner/token", { runnerId, secret });
    assert.equal(auth.status, 200);
    assert.equal(auth.ownerId, "alice");
    const tokenRow = await db
      .prepare("SELECT * FROM agent_connection_tokens WHERE token_hash=?")
      .bind(sha(auth.token))
      .first();
    assert.equal(tokenRow.audience, "runner-connect");
    assert.equal(JSON.stringify(tokenRow).includes(auth.token), false);
    assert.equal(
      (await call("/api/agent/devices", undefined, { "X-QD-Account": "" }))
        .status,
      401,
    );
    const bobHeaders = {
      Cookie: "qd_session=" + "b".repeat(64),
      "X-QD-Account": "bob",
    };
    assert.equal(
      (await call("/api/agent/devices/" + runnerId + "/revoke", {}, bobHeaders))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          "/api/agent/bindings?canvasId=canvas&sectionId=ungrouped",
          undefined,
          bobHeaders,
        )
      ).status,
      403,
    );
    const connect = async () => {
      const r = await mf.dispatchFetch("https://app.test/api/runner/connect", {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + auth.token,
        },
      });
      assert.equal(r.status, 101);
      const s = r.webSocket;
      s.accept();
      const queue = [];
      s.addEventListener("message", (e) => queue.push(JSON.parse(e.data)));
      const next = async () => {
        for (let i = 0; i < 200; i++) {
          if (queue.length) return queue.shift();
          await new Promise((r) => setTimeout(r, 5));
        }
        throw Error("No packet");
      };
      return {
        s,
        next,
        send: (x) => s.send(JSON.stringify({ protocolVersion: 1, ...x })),
      };
    };
    const c = await connect(),
      welcome = await c.next();
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.heartbeatMs, 15000);
    const epoch = welcome.connectionEpoch;
    c.send({ type: "heartbeat", connectionEpoch: epoch });
    assert.equal((await c.next()).type, "heartbeat_ack");
    const workspace = {
      workspaceId: "ws1",
      name: "Project",
      displayPath: "D:\\Project",
      revision: 1,
      checks: [{ checkId: "test", label: "Test" }],
    };
    c.send({
      type: "register_workspaces",
      connectionEpoch: epoch,
      requestId: "reg",
      workspaces: [workspace],
    });
    assert.equal((await c.next()).type, "workspaces_ack");
    const devices = await call("/api/agent/devices");
    assert.equal(devices.devices[0].status, "online");
    assert.deepEqual(devices.devices[0].workspaces, [workspace]);
    const binding = await call("/api/agent/bindings", {
      canvasId: "canvas",
      sectionId: "ungrouped",
      runnerId,
      workspaceId: "ws1",
      expectedRevision: null,
    });
    assert.equal(binding.status, 200);
    assert.equal(binding.binding.revision, 1);
    assert.equal(
      (
        await call("/api/agent/bindings", {
          canvasId: "canvas",
          sectionId: "ungrouped",
          runnerId,
          workspaceId: "ws1",
          expectedRevision: null,
        })
      ).status,
      409,
    );
    c.send({
      type: "lease_claim",
      connectionEpoch: epoch,
      requestId: "claim",
      workspaceId: "ws1",
      runId: "run1",
    });
    const lease = await c.next();
    assert.equal(lease.type, "lease_granted");
    assert.ok(lease.expiresAt > Date.now() + 59000);
    c.send({
      type: "heartbeat",
      connectionEpoch: epoch,
      leases: [
        { workspaceId: "ws1", runId: "run1", leaseEpoch: lease.leaseEpoch },
      ],
    });
    assert.equal((await c.next()).leases[0].leaseEpoch, lease.leaseEpoch);
    await db
      .prepare(
        "UPDATE agent_workspace_leases SET expires_at=0 WHERE runner_id=?",
      )
      .bind(runnerId)
      .run();
    c.send({
      type: "heartbeat",
      connectionEpoch: epoch,
      leases: [
        { workspaceId: "ws1", runId: "run1", leaseEpoch: lease.leaseEpoch },
      ],
    });
    assert.equal((await c.next()).type, "error");
    c.send({
      type: "lease_claim",
      connectionEpoch: epoch,
      requestId: "claim2",
      workspaceId: "ws1",
      runId: "run2",
    });
    assert.equal((await c.next()).type, "error");
    assert.equal(
      (
        await call("/api/agent/bindings", {
          canvasId: "canvas",
          sectionId: "ungrouped",
          runnerId,
          workspaceId: "ws1",
          expectedRevision: 1,
        })
      ).status,
      409,
    );
    c.send({
      type: "register_workspaces",
      connectionEpoch: epoch,
      requestId: "remove",
      workspaces: [],
    });
    assert.equal((await c.next()).type, "error");
    const event = {
      protocolVersion: 1,
      eventId: "e1",
      runnerId,
      runId: "run1",
      threadId: null,
      turnId: null,
      seq: 1,
      type: "run.accepted",
      occurredAt: new Date().toISOString(),
      payload: { status: "queued" },
    };
    c.send({
      type: "event",
      connectionEpoch: epoch,
      event: { eventId: "invalid" },
    });
    assert.equal((await c.next()).type, "error");
    c.send({ type: "event", connectionEpoch: epoch, event });
    assert.equal((await c.next()).type, "event_ack");

    c.send({ type: "event", connectionEpoch: epoch, event });
    assert.equal((await c.next()).type, "event_ack");
    c.send({
      type: "event",
      connectionEpoch: epoch,
      event: { ...event, payload: { status: "preparing" } },
    });
    assert.equal((await c.next()).code, "EVENT_CONFLICT");
    await mf.unsafeEvictDurableObject("agent-pairing", "RunnerHub", {
      name: runnerId,
      webSockets: "hibernate",
    });
    c.send({ type: "event", connectionEpoch: epoch, event });
    assert.equal((await c.next()).type, "event_ack");
    let c2 = await connect(),
      w2 = await c2.next();
    assert.equal(w2.connectionEpoch, epoch + 1);
    c2.send({ type: "heartbeat", connectionEpoch: epoch });
    assert.equal((await c2.next()).code, "STALE_CONNECTION");

    // Exercise the real native transport against workerd rather than synthesizing
    // successful heartbeat ACKs. Both stores retain the old, expired occupancy.
    const nativeRuntimePath = path.join(out, "native-runtime.mjs");
    await build({
      stdin: {
        contents:
          "export {RunnerTransport} from './runner/transport'; export {DeviceStore} from './runner/device-store';",
        resolveDir: path.resolve(""),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: nativeRuntimePath,
      logLevel: "silent",
    });
    const { RunnerTransport, DeviceStore } = await import(
      pathToFileURL(nativeRuntimePath).href
    );
    const deviceStorePath = path.join(out, "outage-device.sqlite");
    let deviceStore = new DeviceStore(deviceStorePath);
    let clockNow = Date.now() - 61000,
      nextTimer = 0;
    const timers = new Map();
    const clock = {
      now: () => clockNow,
      setTimeout(fn, ms) {
        const id = ++nextTimer;
        timers.set(id, { fn, at: clockNow + ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    };
    const advance = (ms) => {
      clockNow += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= clockNow) {
          timers.delete(id);
          timer.fn();
        }
    };
    deviceStore.saveLease({ ...lease, expiresAt: clockNow + 60000 });
    advance(61000); // Persisted lease survived an outage exceeding its 60s validity.
    deviceStore.close();
    deviceStore = new DeviceStore(deviceStorePath);
    const nativePackets = [];
    const settle = async (predicate, label) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail(label);
    };
    const sockets = [];
    let holdReleaseAck = false;
    let heldReleaseAck;
    const socketFactory = (_url, options) => {
      const emitter = new EventEmitter();
      emitter.readyState = 0;
      emitter.send = (raw) => {
        nativePackets.push(JSON.parse(raw));
        emitter.ws.send(raw);
      };
      emitter.close = () => {
        if (emitter.readyState === 3) return;
        emitter.readyState = 3;
        emitter.ws?.close();
      };
      void mf
        .dispatchFetch("https://app.test/api/runner/connect", {
          headers: { Upgrade: "websocket", ...options.headers },
        })
        .then((response) => {
          assert.equal(response.status, 101);
          const socket = response.webSocket;
          emitter.ws = socket;
          socket.addEventListener("message", (event) => {
            if (
              holdReleaseAck &&
              JSON.parse(event.data).type === "lease_released"
            ) {
              holdReleaseAck = false;
              heldReleaseAck = () => emitter.emit("message", event.data);
              return;
            }
            emitter.emit("message", event.data);
          });
          socket.addEventListener("close", () => {
            emitter.readyState = 3;
            emitter.emit("close");
          });
          socket.addEventListener("error", (error) =>
            emitter.emit("error", error),
          );
          socket.accept();
          emitter.readyState = 1;
          emitter.emit("open");
        });
      sockets.push(emitter);
      return emitter;
    };
    let localWorkspaces = [workspace];
    const createTransport = () =>
      new RunnerTransport({
        store: deviceStore,
        runnerId,
        ownerId: "alice",
        authEpoch: 1,
        serverOrigin: "http://127.0.0.1:8788",
        secret: async () => secret,
        workspaces: () => localWorkspaces,
        clock,
        socketFactory,
        fetch: (url, init) =>
          mf.dispatchFetch("https://app.test" + new URL(url).pathname, init),
      });
    const remoteLease = () =>
      db
        .prepare(
          "SELECT run_id,lease_epoch FROM agent_workspace_leases WHERE runner_id=? AND workspace_id=?",
        )
        .bind(runnerId, "ws1")
        .first();
    let transport = createTransport();
    let newerLease;
    try {
      await transport.start();
      await settle(
        () => transport.status.connectionStatus === "online",
        "native transport reconnects",
      );
      const reconnectEpoch = transport.status.connectionEpoch;
      for (let i = 0; i < 4; i++) {
        const before = transport.status.lastHeartbeatAt;
        advance(15000);
        await settle(
          () => transport.status.lastHeartbeatAt !== before,
          "real Hub ACK refreshes native heartbeat after lease outage",
        );
        assert.equal(transport.status.connectionStatus, "online");
        assert.equal(transport.status.connectionEpoch, reconnectEpoch);
        assert.deepEqual(
          nativePackets.filter((p) => p.type === "heartbeat").at(-1).leases,
          [],
        );
      }
      assert.equal(deviceStore.leases().length, 1);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT expires_at FROM agent_workspace_leases WHERE runner_id=? AND workspace_id=?",
            )
            .bind(runnerId, "ws1")
            .first()
        ).expires_at,
        0,
      );
      localWorkspaces = [];
      const rejection = transport.updateWorkspaces().then(
        () => ({ ok: true }),
        (error) => ({ code: error.code }),
      );
      const result = await Promise.race([
        rejection,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "NO_IMMEDIATE_REJECTION" }), 1000),
        ),
      ]);
      assert.deepEqual(result, { code: "INVALID_MESSAGE" });
      assert.equal(transport.status.connectionStatus, "online");
      assert.equal(
        (
          await call("/api/agent/bindings", {
            canvasId: "canvas",
            sectionId: "ungrouped",
            runnerId,
            workspaceId: "ws1",
            expectedRevision: 1,
          })
        ).status,
        409,
      );

      // A recorded confirmation still needs to finish a failed D1 deletion.
      await db
        .prepare(
          "CREATE TRIGGER fail_release BEFORE DELETE ON agent_workspace_leases BEGIN SELECT RAISE(ABORT, 'release interrupted'); END",
        )
        .run();
      await assert.rejects(transport.releaseLease("ws1", "run1", true));
      assert.equal((await remoteLease()).lease_epoch, lease.leaseEpoch);
      assert.equal(deviceStore.lease("run1").leaseEpoch, lease.leaseEpoch);
      await db.prepare("DROP TRIGGER fail_release").run();

      // The Hub commits the release, but the native connection closes before its ACK.
      holdReleaseAck = true;
      const interruptedRelease = assert.rejects(
        transport.releaseLease("ws1", "run1", true),
        { code: "CONNECTION_LOST" },
      );
      await settle(() => heldReleaseAck, "Hub released the lease");
      heldReleaseAck = undefined;
      assert.equal(await remoteLease(), null);
      transport.close();
      await interruptedRelease;
      deviceStore.close();

      // Both the persisted local lease and the Hub's release receipt survive restart.
      deviceStore = new DeviceStore(deviceStorePath);
      assert.equal(deviceStore.lease("run1").leaseEpoch, lease.leaseEpoch);
      await mf.unsafeEvictDurableObject("agent-pairing", "RunnerHub", {
        name: runnerId,
        webSockets: "hibernate",
      });
      localWorkspaces = [workspace];
      transport = createTransport();
      await transport.start();
      await settle(
        () => transport.status.connectionStatus === "online",
        "native transport reconnects after lost release ACK",
      );
      await transport.releaseLease("ws1", "run1", true);
      assert.deepEqual(deviceStore.leases(), []);
      assert.equal(await remoteLease(), null);

      // A delayed acknowledgement for an earlier epoch must leave its replacement intact.
      const releasedLease = await transport.claimLease("ws1", "run1");
      holdReleaseAck = true;
      const delayedRelease = transport.releaseLease("ws1", "run1", true).then(
        () => ({ ok: true }),
        (error) => ({ code: error.code }),
      );
      await settle(() => heldReleaseAck, "Hub acknowledged the next release");
      newerLease = await transport.claimLease("ws1", "run1");
      assert.ok(newerLease.leaseEpoch > releasedLease.leaseEpoch);
      heldReleaseAck();
      assert.deepEqual(await delayedRelease, { ok: true });
      assert.deepEqual(deviceStore.lease("run1"), newerLease);
    } finally {
      transport.close();
      deviceStore.close();
      for (const socket of sockets) socket.close();
    }
    c2 = await connect();
    w2 = await c2.next();
    const release = (overrides = {}) =>
      c2.send({
        type: "lease_release",
        connectionEpoch: w2.connectionEpoch,
        requestId: randomUUID(),
        workspaceId: "ws1",
        runId: "run1",
        leaseEpoch: lease.leaseEpoch,
        confirmedStopped: true,
        ...overrides,
      });
    for (const invalid of [
      { confirmedStopped: false },
      { workspaceId: "unknown" },
      { runId: "unknown" },
      { leaseEpoch: newerLease.leaseEpoch + 1 },
    ]) {
      release(invalid);
      assert.equal((await c2.next()).code, "INVALID_MESSAGE");
    }
    release();
    assert.equal((await c2.next()).type, "lease_released");
    assert.deepEqual(await remoteLease(), {
      run_id: "run1",
      lease_epoch: newerLease.leaseEpoch,
    });
    release({ leaseEpoch: newerLease.leaseEpoch });
    assert.equal((await c2.next()).type, "lease_released");
    c2.send({
      type: "register_workspaces",
      connectionEpoch: w2.connectionEpoch,
      requestId: "remove2",
      workspaces: [],
    });
    assert.equal((await c2.next()).type, "workspaces_ack");
    assert.equal(
      (await call("/api/agent/bindings?canvasId=canvas&sectionId=ungrouped"))
        .binding.enabled,
      false,
    );
    assert.equal(
      (await call("/api/agent/devices/" + runnerId + "/revoke", {})).status,
      200,
    );
    assert.equal((await c2.next()).type, "revoked");
    assert.equal(
      (await native("/api/runner/token", { runnerId, secret })).status,
      401,
    );
    const rejected = await mf.dispatchFetch(
      "https://app.test/api/runner/connect",
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + auth.token,
        },
      },
    );
    assert.equal(rejected.status, 401);
    const expired = await call("/api/agent/devices/pairings", {});
    await db
      .prepare("UPDATE agent_pairings SET expires_at=0 WHERE pairing_id=?")
      .bind(expired.pairingId)
      .run();
    assert.equal(
      (
        await native("/api/runner/pair", {
          ...pair,
          runnerId: randomUUID(),
          pairingCode: expired.pairingCode,
        })
      ).status,
      409,
    );
  },
);
