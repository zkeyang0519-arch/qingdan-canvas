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
async function fixture(t) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const out = await mkdtemp(path.join(root, ".tmp/checklist-recovery-"));
  const scriptPath = path.join(out, "worker.mjs");
  await build({
    stdin: {
      resolveDir: root,
      contents: `
    import { CanvasRoom } from './worker/room';
    export class TestRoom extends CanvasRoom {
      constructor(ctx,env){super(ctx,env);this.audit=ctx;this.instance=crypto.randomUUID();}
      async fetch(request){
        if(new URL(request.url).pathname==='/fixture'){
          const {sql}=await request.json();
          if(sql)this.audit.storage.sql.exec(sql);
          return Response.json({instance:this.instance,rows:this.rows(),sequence:this.sequence(),
            specs:this.audit.storage.sql.exec('SELECT * FROM agent_task_specs ORDER BY note_id,task_id').toArray(),
            versions:this.audit.storage.sql.exec('SELECT * FROM agent_task_versions ORDER BY note_id,task_id').toArray(),
            receipts:this.audit.storage.sql.exec('SELECT * FROM agent_checklist_receipts ORDER BY request_id').toArray()});
        }
        return super.fetch(request);
      }
    }
    export default {fetch(request,env){const url=new URL(request.url);return env.ROOMS.get(env.ROOMS.idFromName('canvas')).fetch(new Request('https://canvas.internal/'+(url.pathname==='/fixture'?'fixture':'internal/agent-checklist'),request));}};
  `,
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
    name: "checklist-recovery",
    port: 0,
    scriptPath,
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: { ROOMS: { className: "TestRoom", useSQLite: true } },
  });
  Object.assign(options, {
    isolatedResourcePersistencePath: path.join(out, "isolated"),
    resourcePersistencePath: path.join(out, "state"),
    unsafeEnableSharedStorage: true,
    unsafeDevRegistryPath: path.join(out, "registry"),
  });
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(out, { recursive: true, force: true });
  });
  const db = await mf.getD1Database("DB");
  await db.batch(
    [
      "CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT,avatar_version TEXT)",
      "CREATE TABLE rooms(id TEXT PRIMARY KEY,owner_id TEXT)",
      "CREATE TABLE members(room_id TEXT,user_id TEXT,role TEXT)",
      "CREATE TABLE agent_bindings(binding_id TEXT,owner_id TEXT,canvas_id TEXT,section_id TEXT,runner_id TEXT,workspace_id TEXT,revision INTEGER,enabled INTEGER)",
      "CREATE TABLE agent_devices(runner_id TEXT,owner_id TEXT,auth_epoch INTEGER,revoked_at INTEGER,workspaces_json TEXT)",
      "INSERT INTO accounts VALUES('owner','测试',NULL),('other','其他',NULL)",
      "INSERT INTO rooms VALUES('canvas','owner')",
      "INSERT INTO members VALUES('canvas','owner','owner')",
      "INSERT INTO agent_bindings VALUES('binding','owner','canvas','ungrouped','offline-runner','workspace',1,1),('missing','owner','canvas','deleted-section','offline-runner','workspace',1,1)",
      `INSERT INTO agent_devices VALUES('offline-runner','owner',1,NULL,'[{"workspaceId":"workspace","checks":[]}]')`,
    ].map((s) => db.prepare(s)),
  );
  const principal = {
    ownerId: "owner",
    runnerId: "offline-runner",
    bindingId: "binding",
    bindingRevision: 1,
    authEpoch: 1,
  };
  const post = async (route, value) => {
    const response = await mf.dispatchFetch(`https://test.local/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call: (input, p = principal) => post("checklist", { principal: p, input }),
    inspect: async () => (await post("fixture", {})).body,
    sql: async (sql) => {
      assert.equal((await post("fixture", { sql })).status, 200);
    },
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(options);
    },
    principal,
  };
}
const create = {
  action: "create",
  requestId: "original",
  tasks: [{ text: "真实任务", instruction: "做", acceptance: "核对" }],
};

test("receipt inspection is read-only on an empty room and absent does not seal a late commit", async (t) => {
  const f = await fixture(t),
    before = await f.inspect();
  assert.deepEqual(await f.call({ action: "receipt", request: create }), {
    status: 200,
    body: { status: "absent" },
  });
  assert.deepEqual(await f.inspect(), before);
  const saved = await f.call(create);
  assert.equal(saved.status, 200);
  const after = await f.inspect();
  assert.equal(
    (await f.call({ action: "receipt", request: create })).body.operationId,
    saved.body.operationId,
  );
  assert.deepEqual(await f.inspect(), after);
  assert.equal(
    (
      await f.call(
        { action: "receipt", request: create },
        { ...f.principal, ownerId: "other" },
      )
    ).status,
    403,
  );
  assert.deepEqual(
    (
      await f.call(
        { action: "receipt", request: create },
        { ...f.principal, bindingId: "missing" },
      )
    ).body,
    { status: "absent" },
  );
});

test("abandon then submit stays sealed across DO restart; submit then abandon returns the original success", async (t) => {
  const f = await fixture(t),
    before = await f.inspect();
  assert.deepEqual(
    (await f.call({ action: "abandon_request", request: create })).body,
    { status: "sealed" },
  );
  assert.equal((await f.call(create)).status, 409);
  const sealed = await f.inspect();
  assert.deepEqual(sealed, before);
  await f.restart();
  const fresh = await f.inspect();
  assert.notEqual(fresh.instance, before.instance);
  assert.deepEqual(
    (await f.call({ action: "abandon_request", request: create })).body,
    { status: "sealed" },
  );
  assert.equal((await f.call(create)).status, 409);
  assert.equal((await f.inspect()).rows.length, 0);
  const live = { ...create, requestId: "committed" },
    saved = await f.call(live);
  assert.equal(saved.status, 200);
  assert.equal(
    (await f.call({ action: "abandon_request", request: live })).body
      .operationId,
    saved.body.operationId,
  );
  assert.equal((await f.call(live)).body.operationId, saved.body.operationId);
  assert.equal((await f.call({ action: "list" })).body.tasks.length, 1);
  assert.equal(
    (
      await f.call({
        action: "receipt",
        request: {
          ...create,
          tasks: [{ ...create.tasks[0], text: "different" }],
        },
      })
    ).status,
    409,
  );
});

test("a receipt write failure rolls back objects/specs/versions and permits safe sealing", async (t) => {
  const f = await fixture(t);
  await f.call({ action: "list" });
  const before = await f.inspect();
  await f.sql(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_checklist_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
  );
  assert.equal((await f.call(create)).status, 500);
  assert.deepEqual(await f.inspect(), before);
  assert.deepEqual(
    (await f.call({ action: "receipt", request: create })).body,
    { status: "absent" },
  );
  assert.deepEqual(
    (await f.call({ action: "abandon_request", request: create })).body,
    { status: "sealed" },
  );
  await f.sql("DROP TRIGGER fail_receipt");
  assert.equal((await f.call(create)).status, 409);
  assert.deepEqual(await f.inspect(), before);
});

test("a committed receipt remains readable after the whole bound group is deleted without recreating content", async (t) => {
  const f = await fixture(t),
    now = new Date().toISOString();
  assert.equal((await f.call({ action: "list" })).status, 200);
  const frame = {
    id: "deleted-section",
    revision: 1,
    deleted: false,
    data: {
      id: "deleted-section",
      type: "frame",
      boardId: "canvas",
      parentId: null,
      x: 0,
      y: 0,
      width: 600,
      height: 600,
      zIndex: 1,
      title: "group",
      locked: false,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
    },
  };
  await f.sql(
    `INSERT INTO objects(id,value) VALUES('deleted-section','${JSON.stringify(frame)}')`,
  );
  const principal = { ...f.principal, bindingId: "missing" };
  const saved = await f.call(create, principal);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await f.sql("DELETE FROM objects");
  const before = await f.inspect();
  assert.equal(
    (await f.call({ action: "receipt", request: create }, principal)).body
      .operationId,
    saved.body.operationId,
  );
  assert.equal(
    (await f.call({ action: "abandon_request", request: create }, principal))
      .body.operationId,
    saved.body.operationId,
  );
  assert.deepEqual(await f.inspect(), before);
  assert.equal(before.rows.length, 0);
});

test("an interrupted tombstone write leaves absence unknown and never blocks a later successful submit", async (t) => {
  const f = await fixture(t),
    before = await f.inspect();
  await f.sql(
    "CREATE TRIGGER fail_seal BEFORE INSERT ON agent_checklist_seals BEGIN SELECT RAISE(ABORT,'injected seal failure'); END",
  );
  assert.equal(
    (await f.call({ action: "abandon_request", request: create })).status,
    500,
  );
  assert.deepEqual(
    (await f.call({ action: "receipt", request: create })).body,
    { status: "absent" },
  );
  assert.deepEqual(await f.inspect(), before);
  await f.sql("DROP TRIGGER fail_seal");
  assert.equal((await f.call(create)).status, 200);
  assert.equal(
    (await f.call({ action: "receipt", request: create })).body.status,
    "committed",
  );
});
