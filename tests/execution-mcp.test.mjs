import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const sha = (s) => createHash("sha256").update(s).digest("hex");
test(
  "execution transport, immutable intents, durable commands and stop confirmation",
  { timeout: 60000 },
  async (t) => {
    await mkdir(new URL("../.tmp/", import.meta.url), { recursive: true });
    const out = await mkdtemp(
      new URL("../.tmp/execution-test-", import.meta.url),
    );
    const fixture = `import app from './worker/index';export {CanvasRoom,RunnerHub} from './worker/index';import {DurableObject} from 'cloudflare:workers';import {Lifecycle} from 'agents/lifecycle';import {MCPClientManager} from 'agents/mcp/client';
  export class ManagerFixture extends DurableObject {constructor(ctx,env){super(ctx,env);this.manager=new MCPClientManager('test-manager','1');this.lifecycle=new Lifecycle(this);this.lifecycle.use(this.manager);}async fetch(request){await this.lifecycle.start();const input=await request.json();const requests=[];try{const connected=await this.manager.connect('https://app.test/executor-mcp',{transport:{type:'streamable-http',fetch:async(url,init)=>{const req=new Request(url,init);req.headers.set('Host','app.test');req.headers.set('Authorization','Bearer '+input.token);requests.push({method:req.method,path:new URL(req.url).pathname});return app.fetch(req,this.env,this.ctx);}}});return Response.json({tools:this.manager.listTools(),result:await this.manager.callTool({serverId:connected.id,name:'codex_list_projects',arguments:{runnerId:'runner-a'}}),requests});}finally{await this.manager.closeAllConnections();}}}
  export default {fetch(request,env,ctx){if(new URL(request.url).pathname==='/fixture/manager')return env.MANAGER.get(env.MANAGER.idFromName('test')).fetch(request);return app.fetch(request,env,ctx);}};`;
    await build({
      stdin: {
        contents: fixture,
        resolveDir: new URL("../", import.meta.url).pathname.replace(
          /^\/([A-Z]:)/,
          "$1",
        ),
      },
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
      name: "execution-test",
      scriptPath: path.join(out, "worker.mjs"),
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        ROOMS: { className: "CanvasRoom", useSQLite: true },
        RUNNER_HUBS: { className: "RunnerHub", useSQLite: true },
        MANAGER: { className: "ManagerFixture", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        MCP_ENABLED: "true",
        PUBLIC_ORIGIN: "https://app.test",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
      },
    });
    Object.assign(options, {
      isolatedResourcePersistencePath: path.join(out, "isolated"),
      resourcePersistencePath: path.join(out, "state"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(out, "registry"),
    });
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
    const raw = "a".repeat(64),
      bearer = "b".repeat(64),
      runner = "runner-a";
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026'),('bob','bob','Bob','hash','2026')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(raw), "alice", Date.now() + 3600000),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
      ),
      db
        .prepare(
          "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json) VALUES(?,?,?,?,?)",
        )
        .bind(
          runner,
          "alice",
          "Device",
          "secret",
          JSON.stringify([
            {
              workspaceId: "workspace-a",
              name: "Demo",
              displayPath: "D:/demo",
              revision: 1,
              checks: [],
            },
          ]),
        ),
      db
        .prepare(
          "INSERT INTO agent_bindings VALUES('binding-a','alice','canvas','section',?,'workspace-a',1,1)",
        )
        .bind(runner),
      db
        .prepare(
          "INSERT INTO agent_connection_tokens VALUES(?,?,'runner-connect',1,?)",
        )
        .bind(sha(bearer), runner, Date.now() + 3600000),
    ]);
    const call = async (p, data, headers = {}) => {
      const r = await mf.dispatchFetch("https://app.test" + p, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Cookie: "qd_session=" + raw,
          "X-QD-Account": "alice",
          "Content-Type": "application/json",
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { http: r.status, ...(await r.json()) };
    };
    const native = (p, data) =>
      call("/api/runner/execution/" + p, data, {
        Cookie: "",
        "X-QD-Account": "",
        Authorization: "Bearer " + bearer,
      });
    const executionToken = "c".repeat(64);
    await db
      .prepare(
        "INSERT INTO agent_execution_tokens VALUES(?,'alice','runner-a','binding-a',1,1,'/executor-mcp','manual-trial',?)",
      )
      .bind(sha(executionToken), Date.now() + 3600000)
      .run();
    const manager = await call("/fixture/manager", { token: executionToken });
    assert.equal(manager.http, 200, JSON.stringify(manager));
    assert.deepEqual(
      manager.tools.map((t) => t.name).sort(),
      [
        "codex_list_projects",
        "codex_create_run",
        "codex_get_run",
        "codex_continue_run",
        "codex_cancel_run",
      ].sort(),
    );
    assert.equal(
      manager.result.structuredContent.projects[0].workspaceId,
      "workspace-a",
    );
    assert.ok(manager.requests.length >= 3);
    assert.ok(manager.requests.every((r) => r.path === "/executor-mcp"));
    const rpc = async (headers = {}) =>
      mf.dispatchFetch("https://app.test/executor-mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
    assert.equal((await rpc()).status, 401);
    assert.equal(
      (await rpc({ Authorization: "Bearer " + bearer })).status,
      401,
    );
    for (const [column, bad, good] of [
      ["audience", "/mcp", "/executor-mcp"],
      ["owner_id", "bob", "alice"],
      ["binding_id", "other", "binding-a"],
      ["auth_epoch", 2, 1],
      ["binding_revision", 2, 1],
    ]) {
      await db
        .prepare(
          "UPDATE agent_execution_tokens SET " +
            column +
            "=? WHERE token_hash=?",
        )
        .bind(bad, sha(executionToken))
        .run();
      assert.ok(
        [401, 403].includes(
          (await rpc({ Authorization: "Bearer " + executionToken })).status,
        ),
      );
      await db
        .prepare(
          "UPDATE agent_execution_tokens SET " +
            column +
            "=? WHERE token_hash=?",
        )
        .bind(good, sha(executionToken))
        .run();
    }
    assert.equal(
      (
        await mf.dispatchFetch("https://app.test/mcp", {
          headers: { Authorization: "Bearer " + executionToken },
        })
      ).status,
      401,
    );
    const intent = {
      requestId: "intent-a",
      bindingId: "binding-a",
      bindingRevision: 1,
      kind: "task",
      instruction: "Inspect demo",
      acceptance: "Human review",
    };
    assert.equal(
      (await call("/api/agent/execution/intents", intent)).http,
      409,
    );
    const socketResponse = await mf.dispatchFetch(
      "https://app.test/api/runner/connect",
      { headers: { Upgrade: "websocket", Authorization: "Bearer " + bearer } },
    );
    const socket = socketResponse.webSocket;
    socket.accept();
    const packet = () =>
      new Promise((resolve) => {
        const fn = (e) => {
          socket.removeEventListener("message", fn);
          resolve(JSON.parse(e.data));
        };
        socket.addEventListener("message", fn);
      });
    const welcome = await packet();
    assert.equal(welcome.connectionEpoch, 1);
    assert.equal(
      (
        await native("context", {
          connectionEpoch: 1,
          contexts: [
            {
              workspaceId: "workspace-a",
              capturedAt: new Date().toISOString(),
              gitBaseline: { commit: null, branch: null, dirty: false },
              threads: [],
            },
          ],
        })
      ).http,
      200,
    );
    const authIntent = await call("/api/agent/execution/intents", intent);
    assert.equal(authIntent.http, 200, JSON.stringify(authIntent));
    assert.equal(
      (
        await call("/api/agent/execution/intents", {
          ...intent,
          requestId: "stale-intent",
          bindingRevision: 2,
        })
      ).http,
      409,
      "a stale UI binding cannot authorize the current target",
    );
    assert.equal(
      (
        await call("/api/agent/execution/intents", {
          ...intent,
          actor: "alice",
        })
      ).http,
      400,
    );
    assert.equal(
      (
        await call("/api/agent/execution/intents", intent, {
          "X-QD-Account": "bob",
        })
      ).http,
      401,
    );
    assert.equal(
      (
        await call("/api/agent/execution/intents", intent, {
          Origin: "https://evil.test",
        })
      ).http,
      403,
    );
    assert.deepEqual(
      (await call("/api/agent/execution/intents", intent)).input,
      authIntent.input,
    );
    assert.equal(
      (
        await call("/api/agent/execution/intents", {
          ...intent,
          instruction: "different",
        })
      ).http,
      409,
    );
    const tool = (name, args) =>
      call("/api/agent/execution/tools", {
        bindingId: "binding-a",
        name,
        arguments: args,
      });
    assert.equal(
      (await tool("codex_create_run", { ...authIntent.input, snapshot: {} }))
        .http,
      400,
    );
    const created = await tool("codex_create_run", authIntent.input);
    assert.equal(created.http, 200, JSON.stringify(created));
    assert.equal(created.transport, "streamable-http");
    assert.deepEqual(
      (await tool("codex_create_run", authIntent.input)).result,
      created.result,
    );
    const runId = authIntent.input.runId;
    let poll = await native("poll", { connectionEpoch: 1 });
    assert.equal(poll.offers[0].runId, runId);
    assert.deepEqual(poll.deliveries, []);
    const granted = packet();
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "lease_claim",
        connectionEpoch: 1,
        workspaceId: "workspace-a",
        runId,
        requestId: "lease",
      }),
    );
    await granted;
    poll = await native("poll", { connectionEpoch: 1 });
    assert.equal(poll.deliveries.length, 1);
    const delivery = poll.deliveries[0];
    assert.equal(delivery.envelope.leaseEpoch, 1);
    assert.deepEqual(
      (await native("poll", { connectionEpoch: 1 })).deliveries,
      [delivery],
    );
    assert.equal(
      (
        await native("ack", {
          connectionEpoch: 1,
          commandId: delivery.envelope.commandId,
          status: "stored",
        })
      ).http,
      200,
    );
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "queued",
    );
    assert.equal(
      (
        await native("ack", {
          connectionEpoch: 1,
          commandId: delivery.envelope.commandId,
          status: "applied",
        })
      ).http,
      200,
    );
    assert.equal(
      (
        await native("ack", {
          connectionEpoch: 1,
          commandId: delivery.envelope.commandId,
          status: "stored",
        })
      ).http,
      200,
      "earlier exact ACK retries remain idempotent after progression",
    );
    const report = {
      connectionEpoch: 1,
      runId,
      commandId: delivery.envelope.commandId,
      revision: 1,
      status: "running",
      threadId: "thread-a",
      turnId: "turn-a",
      terminal: false,
      stopConfirmed: false,
    };
    assert.equal((await native("report", report)).http, 200);
    const ev = {
      protocolVersion: 1,
      eventId: "event-a",
      runnerId: runner,
      runId,
      threadId: "thread-a",
      turnId: "turn-a",
      seq: 1,
      occurredAt: new Date().toISOString(),
      type: "output.delta",
      payload: { text: "Hello" },
    };
    assert.deepEqual(
      (await native("events", { connectionEpoch: 1, events: [ev] })).eventIds,
      ["event-a"],
    );
    assert.equal(
      (await native("events", { connectionEpoch: 1, events: [ev] })).http,
      200,
    );
    assert.equal(
      (
        await native("events", {
          connectionEpoch: 1,
          events: [{ ...ev, payload: { text: "Changed" } }],
        })
      ).http,
      409,
    );
    const cancel = await tool("codex_cancel_run", {
      requestId: "cancel-a",
      runId,
    });
    assert.equal(cancel.http, 200);
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "cancel_requested",
    );
    poll = await native("poll", { connectionEpoch: 1 });
    const cancellation = poll.deliveries[0];
    assert.equal(cancellation.envelope.payload.type, "cancel_run");
    assert.equal(
      (
        await native("report", {
          ...report,
          commandId: cancellation.envelope.commandId,
          revision: 2,
          status: "cancelled",
          terminal: true,
          stopConfirmed: false,
        })
      ).http,
      400,
    );
    assert.equal(
      (
        await native("report", {
          ...report,
          commandId: cancellation.envelope.commandId,
          revision: 2,
          status: "cancelled",
          terminal: true,
          stopConfirmed: true,
        })
      ).http,
      200,
    );
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "cancelled",
    );
    assert.equal(
      (
        await native("report", {
          ...report,
          commandId: cancellation.envelope.commandId,
          revision: 2,
          status: "failed",
          terminal: true,
          stopConfirmed: true,
        })
      ).http,
      409,
    );
    assert.equal(
      (await tool("codex_get_run", { runId, afterSeq: 0 })).result.events[0]
        .payload.text,
      "Hello",
    );
    assert.deepEqual(
      (await tool("codex_get_run", { runId, afterSeq: 1 })).result.events,
      [],
    );
    assert.equal(
      (await call("/api/agent/execution/runs?bindingId=binding-a")).runs[0]
        .runId,
      runId,
    );
    assert.equal((await native("poll", { connectionEpoch: 2 })).http, 409);
    // A new reply remains in the original chat, and old-command reports cannot regress it.
    const resumed = await tool("codex_continue_run", {
      requestId: "reply-a",
      runId,
      expectedTurnId: "turn-a",
      mode: "reply",
      message: "Continue",
    });
    assert.equal(resumed.http, 200, JSON.stringify(resumed));
    assert.deepEqual(
      (await native("poll", { connectionEpoch: 1 })).deliveries,
      [],
      "reply cannot reuse the terminal turn's lease",
    );
    const released = packet();
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "lease_release",
        connectionEpoch: 1,
        workspaceId: "workspace-a",
        runId,
        leaseEpoch: 1,
        confirmedStopped: true,
      }),
    );
    await released;
    assert.equal(
      (await native("poll", { connectionEpoch: 1 })).offers[0].runId,
      runId,
    );
    const regranted = packet();
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "lease_claim",
        connectionEpoch: 1,
        workspaceId: "workspace-a",
        runId,
        requestId: "resume-lease",
      }),
    );
    assert.equal((await regranted).leaseEpoch, 2);
    const replyDelivery = (await native("poll", { connectionEpoch: 1 }))
      .deliveries[0];
    assert.equal(replyDelivery.envelope.payload.type, "continue_run");
    assert.equal(replyDelivery.envelope.leaseEpoch, 2);
    assert.equal(
      (
        await native("report", {
          ...report,
          commandId: cancellation.envelope.commandId,
          revision: 3,
          status: "cancelled",
          terminal: true,
          stopConfirmed: true,
        })
      ).ignored,
      true,
    );
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "queued",
    );
    assert.equal(
      (
        await native("ack", {
          connectionEpoch: 1,
          commandId: replyDelivery.envelope.commandId,
          status: "uncertain",
          reason: "Interrupted after journal",
        })
      ).http,
      200,
    );
    assert.deepEqual(
      (await native("poll", { connectionEpoch: 1 })).deliveries,
      [],
    );
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "reconciliation_required",
    );
    assert.equal(
      (
        await tool("codex_cancel_run", {
          requestId: "cancel-after-uncertain",
          runId,
        })
      ).http,
      200,
    );
    assert.equal(
      (
        await native("report", {
          ...report,
          commandId: replyDelivery.envelope.commandId,
          revision: 3,
          status: "verifying",
          terminal: true,
          stopConfirmed: true,
        })
      ).http,
      200,
    );
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "cancelled",
      "a confirmed prior turn stop settles pending cancels without starting anything",
    );
    // Output is bounded, explicitly truncated, paged and still exactly replay-deduplicated.
    const deltas = Array.from({ length: 35 }, (_, i) => ({
      ...ev,
      eventId: "delta-" + i,
      seq: i + 2,
      payload: { text: "x".repeat(32000) },
    }));
    assert.equal(
      (await native("events", { connectionEpoch: 1, events: deltas })).http,
      200,
    );
    assert.equal(
      (await native("events", { connectionEpoch: 1, events: [deltas.at(-1)] }))
        .http,
      200,
    );
    const outputPage = (
      await tool("codex_get_run", { runId, afterSeq: 1, limit: 50 })
    ).result;
    assert.equal(outputPage.truncated, true);
    assert.equal(outputPage.hasMore, true);
    assert.ok(JSON.stringify(outputPage.events).length <= 200000);
    assert.ok(outputPage.nextAfterSeq > 1);
    // Live binding revocation blocks both the existing token and pending delivery.
    await db
      .prepare(
        "UPDATE agent_bindings SET enabled=0 WHERE binding_id='binding-a'",
      )
      .run();
    assert.equal(
      (await rpc({ Authorization: "Bearer " + executionToken })).status,
      403,
    );
    assert.deepEqual(
      (await native("poll", { connectionEpoch: 1 })).deliveries,
      [],
    );
    assert.equal((await tool("codex_get_run", { runId })).http, 403);
    await db
      .prepare(
        "UPDATE agent_bindings SET enabled=1 WHERE binding_id='binding-a'",
      )
      .run();
    // An offline submission uses the cached context and stays queued; no fabricated completion.
    await db
      .prepare(
        "UPDATE agent_devices SET last_seen_at=NULL WHERE runner_id='runner-a'",
      )
      .run();
    const offlineIntent = await call("/api/agent/execution/intents", {
      ...intent,
      requestId: "offline",
    });
    assert.equal(
      (await tool("codex_create_run", offlineIntent.input)).http,
      200,
    );
    assert.equal(
      (
        await tool("codex_cancel_run", {
          requestId: "offline-cancel",
          runId: offlineIntent.input.runId,
        })
      ).http,
      200,
    );
    assert.equal(
      (await tool("codex_get_run", { runId: offlineIntent.input.runId })).result
        .run.status,
      "cancelled",
    );
    assert.equal((await native("report", report)).http, 409);
    assert.equal(
      (await tool("codex_get_run", { runId })).result.run.status,
      "cancelled",
    );
    socket.close();
  },
);
