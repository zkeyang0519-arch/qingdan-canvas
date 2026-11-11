import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

// Only the external model and the separate summary node are substituted.
// Chat HTTP authorization, SQL transactions, receipts and alarms are production code.
export async function chatRecoveryServer(t) {
  const root = process.cwd();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".tmp/chat-recovery-"));
  await build({
    stdin: {
      resolveDir: root,
      contents: `import app from './worker/index';
import {AgentChatRouter} from './worker/agent/chat-router';
import {DurableObject} from 'cloudflare:workers';
export class Project extends DurableObject {
 async fetch(r) {
  const url=new URL(r.url);
  if(url.pathname==='/fail') {await this.ctx.storage.put('fail',(await r.json()).fail);return Response.json({ok:true});}
  if(await this.ctx.storage.get('fail'))return Response.json({error:'fixture summary unavailable'},{status:503});
  const {principal:p}=await r.json();
  return Response.json({bindingId:p.bindingId,bindingRevision:p.bindingRevision,status:'ready',ready:true,stale:false,summaryRevision:1,sourceRunId:'fixture-summary',capturedAt:'2026-11-11T00:00:00Z',cwd:'D:/fixture',threadId:'summary-thread',turnId:'summary-turn',gitBaseline:null,error:null,activeRunId:null,summary:{overview:'fixture project',completed:[],inProgress:[],pending:[],blockers:[],verification:[],uncertainties:[]}});
 }
}
export class Chat extends AgentChatRouter {
 async generate(context){await this.ctx.storage.put('calls',(await this.ctx.storage.get('calls')||0)+1);if(context.messages.at(-1).content==='model failure')throw Error('fixture model failed');return {reply:{text:'fixture assistant reply',tasks:[],memories:[{scope:'personal',key:'fixture candidate',value:'short replies'}]}};}
 async fetch(r){const p=new URL(r.url).pathname;if(p==='/count')return Response.json({count:await this.ctx.storage.get('calls')||0});if(p==='/expire'){const {jobId}=await r.json();this.ctx.storage.sql.exec("UPDATE agent_chat_jobs SET status='running',revision=revision+1,lease_until=? WHERE id=?",Date.now()-1,jobId);return Response.json({ok:true});}if(p==='/alarm'){await this.alarm();return Response.json({ok:true});}return super.fetch(r);}
}
export default {fetch(r,env,ctx){const p=new URL(r.url).pathname;if(p==='/fixture/summary')return env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName('runner')).fetch(new Request('https://fixture/fail',r));if(p.startsWith('/fixture/chat/'))return env.AGENT_CHATS.get(env.AGENT_CHATS.idFromName('alice')).fetch(new Request('https://fixture/'+p.slice('/fixture/chat/'.length),r));return app.fetch(r,env,ctx);}};`,
    },
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "browser"],
    format: "esm",
    external: ["node:*", "cloudflare:*"],
    outfile: path.join(dir, "worker.mjs"),
    logLevel: "silent",
  });
  const options = convertV4MiniflareOptions({
    name: "chat-recovery",
    port: 0,
    inspectorPort: 0,
    scriptPath: path.join(dir, "worker.mjs"),
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: {
      AGENT_CHATS: { className: "Chat", useSQLite: true },
      RUNNER_HUBS: { className: "Project", useSQLite: true },
    },
    bindings: {
      APP_ENV: "test",
      CHAT_ENABLED: "true",
      PROJECT_SUMMARY_ENABLED: "true",
      RUNNER_ENABLED: "true",
      EXECUTION_ENABLED: "true",
      ROUTER_API_KEY: "fake-key",
      ROUTER_MODEL: "fixture",
    },
    outboundService: () =>
      new Response("external network disabled", { status: 503 }),
  });
  Object.assign(options, {
    isolatedResourcePersistencePath: path.join(dir, "isolated"),
    resourcePersistencePath: path.join(dir, "state"),
    unsafeEnableSharedStorage: true,
    unsafeDevRegistryPath: path.join(dir, "registry"),
  });
  let mf = new Miniflare(options);
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = (await readFile(path.join("migrations", file), "utf8")).replace(
      /^--.*$/gm,
      "",
    );
    await db.batch(
      sql
        .split(";")
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }
  const tokens = { alice: "a".repeat(64), bob: "b".repeat(64) };
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  await db.batch([
    db.prepare(
      "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026'),('bob','bob','Bob','hash','2026')",
    ),
    ...Object.entries(tokens).map(([id, token]) =>
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(token), id, Date.now() + 3600000),
    ),
    db.prepare(
      "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
    ),
    db.prepare("INSERT INTO members VALUES('canvas','alice','owner','2026')"),
    db
      .prepare(
        "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json) VALUES('runner','alice','Fixture','fake-secret',?)",
      )
      .bind(
        JSON.stringify([
          {
            workspaceId: "workspace",
            name: "Fixture",
            displayPath: "D:/fixture",
            revision: 1,
            checks: [],
          },
        ]),
      ),
    db.prepare(
      "INSERT INTO agent_bindings VALUES('binding','alice','canvas','ungrouped','runner','workspace',1,1),('other-binding','alice','canvas','other','runner','workspace',1,1)",
    ),
  ]);
  let drop = null;
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({
        path: req.url,
        method: req.method,
        body: body ? JSON.parse(body) : null,
      });
      const dropping = req.url === "/api/agent/chat/send" ? drop : null;
      if (dropping) drop = null;
      if (dropping === "before") {
        res.destroy();
        return;
      }
      // Local HTTP fault proxy represents the worker's same-origin HTTPS edge.
      const response = await mf.dispatchFetch(
        new URL(req.url, "https://chat.test"),
        {
          method: req.method,
          headers: {
            ...req.headers,
            origin: "https://chat.test",
            host: "chat.test",
          },
          ...(body ? { body } : {}),
        },
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      // The server has committed the real request and produced its HTTP response.
      if (dropping === "after") {
        res.destroy();
        return;
      }
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(bytes);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (route, body, account = "alice") => {
    const response = await fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: "qd_session=" + tokens[account],
        "X-QD-Account": account,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { http: response.status, ...(await response.json()) };
  };
  return {
    origin,
    requests,
    call,
    requestCloud: async (route, options = {}) => {
      const result = await call(
        route,
        options.body,
        options.accountId || "alice",
      );
      if (result.http >= 400)
        throw Object.assign(Error(result.error), { status: result.http });
      return result;
    },
    dropSend(when) {
      drop = when;
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(options);
    },
    async rebind() {
      await (
        await mf.getD1Database("DB")
      )
        .prepare(
          "UPDATE agent_bindings SET revision=2 WHERE binding_id='binding'",
        )
        .run();
    },
  };
}
