import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const sha = (s) => createHash("sha256").update(s).digest("hex");
test(
  "public project summary routes enforce session, same-origin, owner and binding revision in Workerd",
  { timeout: 60000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = path.resolve("."),
      out = await mkdtemp(path.join(root, ".tmp/project-route-test-"));
    await build({
      stdin: {
        contents: `import {projectSummaryRoute} from './worker/execution/project-summary-route';import {executionRoute} from './worker/execution/execution-router';import {failure} from './worker/http';export {RunnerHub} from './worker/execution/hub';export default {async fetch(request,env,ctx){try{return await projectSummaryRoute(request,env)||await executionRoute(request,env,ctx)||new Response('',{status:404});}catch(e){return failure(e);}}};`,
        resolveDir: root,
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
      name: "project-route-test",
      scriptPath: path.join(out, "worker.mjs"),
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: {
        RUNNER_HUBS: { className: "RunnerHub", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        PROJECT_SUMMARY_ENABLED: "true",
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
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = (
        await readFile(path.join("migrations", file), "utf8")
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
      ...["alice", "bob"].map((u, i) =>
        db
          .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
          .bind(sha((i ? "b" : "a").repeat(64)), u, Date.now() + 3600000),
      ),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
      ),
      db
        .prepare(
          "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json) VALUES('runner','alice','Device','secret',?)",
        )
        .bind(
          JSON.stringify([
            {
              workspaceId: "workspace",
              name: "Demo",
              displayPath: "D:/demo",
              revision: 1,
              checks: [],
            },
          ]),
        ),
      db.prepare(
        "INSERT INTO agent_bindings VALUES('binding','alice','canvas','ungrouped','runner','workspace',1,1)",
      ),
    ]);
    const call = async (route, body, extra = {}) => {
      const r = await mf.dispatchFetch(
        "https://app.test/api/agent/project/" + route,
        {
          method: body ? "POST" : "GET",
          headers: {
            Origin: "https://app.test",
            Cookie: "qd_session=" + "a".repeat(64),
            "X-QD-Account": "alice",
            "Content-Type": "application/json",
            ...extra,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { http: r.status, ...(await r.json()) };
    };
    assert.equal(
      (await call("state?bindingId=binding&bindingRevision=1")).status,
      "uninitialized",
    );
    assert.equal(
      (await call("state?bindingId=binding", undefined, { Cookie: "" })).http,
      401,
    );
    assert.equal(
      (
        await call("state?bindingId=binding", undefined, {
          "X-QD-Account": "bob",
        })
      ).http,
      401,
    );
    assert.equal(
      (
        await call("state?bindingId=binding", undefined, {
          Origin: "https://evil.test",
        })
      ).http,
      403,
    );
    assert.equal(
      (
        await call("state?bindingId=binding", undefined, {
          Cookie: "qd_session=" + "b".repeat(64),
          "X-QD-Account": "bob",
        })
      ).http,
      403,
    );
    assert.equal(
      (
        await call("initialize", {
          requestId: "init",
          bindingId: "binding",
          bindingRevision: 2,
        })
      ).http,
      409,
    );
    assert.equal(
      (
        await call("initialize", {
          requestId: "init",
          bindingId: "binding",
          bindingRevision: 1,
        })
      ).http,
      409,
      "missing native context fails clearly instead of claiming ready",
    );
    assert.equal(
      (await call("state?bindingId=binding")).status,
      "uninitialized",
    );
    const respond=async(extra={})=>mf.dispatchFetch("https://app.test/api/agent/execution/respond",{method:"POST",headers:{Origin:"https://app.test",Cookie:"qd_session="+"a".repeat(64),"X-QD-Account":"alice","Content-Type":"application/json",...extra},body:JSON.stringify({bindingId:"binding",bindingRevision:1,runId:"missing-run",requestId:"approval-test",expectedTurnId:"turn",pendingRequestId:"request",response:{decision:"decline"}})});
    assert.equal((await respond({Cookie:""})).status,401);
    assert.equal((await respond({Origin:"https://evil.test"})).status,403);
    assert.equal((await respond({"X-QD-Account":"bob"})).status,401);
    assert.equal((await respond({Cookie:"qd_session="+"b".repeat(64),"X-QD-Account":"bob"})).status,403);
    assert.equal((await respond()).status,403,"authenticated route still rejects an unknown run before native delivery");
  },
);
