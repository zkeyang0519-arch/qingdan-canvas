import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test(
  "CanvasRoom checks owner and section, broadcasts real changes and tracks browser edits",
  { timeout: 30000 },
  async (t) => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const out = await mkdtemp(path.join(root, ".tmp/agent-checklist-room-"));
    let mf, socket;
    t.after(async () => {
      socket?.close();
      await mf?.dispose();
      await rm(out, { recursive: true, force: true });
    });
    const scriptPath = path.join(out, "worker.mjs");
    await build({
      stdin: {
        contents: `export {CanvasRoom} from './worker/room';
      export default {fetch(request,env){const url = new URL(request.url);
        const [,room,route] = url.pathname.split('/');
        return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request('https://canvas.internal/' +
          (route === 'socket' ? 'socket' : 'internal/agent-checklist'), request));
      }};`,
        resolveDir: root,
      },
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "browser"],
      format: "esm",
      external: ["node:*", "cloudflare:*"],
      outfile: scriptPath,
      logLevel: "silent",
    });
    const options = convertV4MiniflareOptions({
      name: "agent-checklist-room",
      scriptPath,
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
    });
    Object.assign(options, {
      isolatedResourcePersistencePath: path.join(out, "isolated"),
      resourcePersistencePath: path.join(out, "state"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(out, "registry"),
    });
    mf = new Miniflare(options);
    const db = await mf.getD1Database("DB");
    await db.batch(
      [
        "CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT,avatar_version TEXT)",
        "CREATE TABLE account_sessions(token_hash TEXT,account_id TEXT,expires_at INTEGER)",
        "CREATE TABLE rooms(id TEXT PRIMARY KEY,owner_id TEXT)",
        "CREATE TABLE members(room_id TEXT,user_id TEXT,role TEXT)",
        "CREATE TABLE agent_bindings(binding_id TEXT,owner_id TEXT,canvas_id TEXT,section_id TEXT,runner_id TEXT,workspace_id TEXT,revision INTEGER,enabled INTEGER)",
        "CREATE TABLE agent_devices(runner_id TEXT,owner_id TEXT,auth_epoch INTEGER,revoked_at INTEGER,workspaces_json TEXT)",
        "INSERT INTO accounts VALUES('owner','用户',NULL),('guest','协作者',NULL)",
        "INSERT INTO rooms VALUES('canvas','owner')",
        "INSERT INTO members VALUES('canvas','owner','owner'),('canvas','guest','member')",
        "INSERT INTO agent_bindings VALUES('binding','owner','canvas','ungrouped','runner','workspace',1,1),('trial','owner','canvas','trial-demo','runner','workspace',1,1)",
        `INSERT INTO agent_devices VALUES('runner','owner',1,NULL,'[{"workspaceId":"workspace","checks":[]}]')`,
        `INSERT INTO account_sessions VALUES('session','owner',${Date.now() + 60000})`,
      ].map((statement) => db.prepare(statement)),
    );
    const principal = {
      ownerId: "owner",
      runnerId: "runner",
      bindingId: "binding",
      bindingRevision: 1,
      authEpoch: 1,
    };
    const call = async (input, p = principal, room = "canvas") => {
      const response = await mf.dispatchFetch(
        `https://fixture.test/${room}/checklist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principal: p, input }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const list = { action: "list" };
    assert.equal(
      (await call(list, { ...principal, ownerId: "guest" })).status,
      403,
    );
    assert.equal(
      (await call(list, { ...principal, authEpoch: 2 })).status,
      403,
    );
    assert.equal((await call(list, principal, "another-canvas")).status, 403);
    assert.equal(
      (await call(list, { ...principal, bindingId: "trial" })).status,
      409,
    );
    const tasks = [
      { text: "真实待办", instruction: "执行", acceptance: "确认" },
    ];
    const receipt = { action: "create_receipt", requestId: "create", tasks };
    assert.deepEqual(await call(receipt), {
      status: 200,
      body: { found: false },
    });

    const response = await mf.dispatchFetch(
      "https://fixture.test/canvas/socket",
      {
        headers: {
          Upgrade: "websocket",
          "X-QD-Room": "canvas",
          "X-QD-User": "owner",
          "X-QD-Expires": String(Date.now() + 60000),
          "X-QD-Session": "session",
          "X-QD-Task-Authors": "1",
        },
      },
    );
    assert.equal(response.status, 101);
    socket = response.webSocket;
    const nextPacket = (type) =>
      new Promise((resolve) => {
        const onMessage = ({ data }) => {
          const packet = JSON.parse(data);
          if (packet.type !== type) return;
          socket.removeEventListener("message", onMessage);
          resolve(packet);
        };
        socket.addEventListener("message", onMessage);
      });
    socket.accept();
    const broadcast = nextPacket("changes");
    const created = await call({
      action: "create",
      requestId: "create",
      tasks,
    });
    assert.equal(created.status, 200);
    assert.equal(
      (await call({ ...receipt, tasks: [{ ...tasks[0], acceptance: "冒名" }] }))
        .status,
      409,
    );
    assert.deepEqual(await call(receipt), {
      status: 200,
      body: {
        found: true,
        operationId: created.body.operationId,
        createdTasks: created.body.createdTasks,
      },
    });
    assert.deepEqual(
      await call(receipt, { ...principal, bindingId: "trial" }),
      { status: 200, body: { found: false } },
    );
    const [row] = (await broadcast).rows;
    const [{ noteId, taskId, generation, specRevision }] = created.body.tasks;
    assert.equal(row.id, noteId);
    assert.equal(row.data.blocks[0].id, taskId);
    assert.equal(row.data.blocks[0].createdByUserId, "owner");
    const snap = await call({
      action: "snapshot",
      tasks: [{ noteId, taskId, generation, specRevision }],
    });
    assert.equal(snap.status, 200);

    const ack = nextPacket("ack");
    row.data.blocks[0].runs[0].text = "网页编辑后的待办";
    socket.send(
      JSON.stringify({
        type: "commit",
        opId: "edit",
        changes: [
          { id: noteId, expectedRevision: row.revision, data: row.data },
        ],
      }),
    );
    await ack;
    const changed = (await call(list)).body.tasks[0];
    assert.equal(changed.text, "网页编辑后的待办");
    assert.equal(changed.generation, generation + 1);
    assert.equal(changed.specStatus, "stale");
    const final = await call({
      action: "finalize",
      requestId: "finish",
      runId: "run",
      completedTurnId: "turn",
      source: snap.body.items[0].source,
    });
    assert.equal(final.body.status, "conflict");
    assert.equal((await call(list)).body.tasks[0].done, false);
  },
);
