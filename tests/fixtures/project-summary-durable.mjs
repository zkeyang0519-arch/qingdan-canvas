import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
export async function fixture(t) {
  const root = process.cwd();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const out = await mkdtemp(path.join(root, ".tmp/project-summary-durable-"));
  await build({
    entryPoints: ["tests/fixtures/project-summary-durable-worker.ts"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    mainFields: ["module", "main"],
    conditions: ["workerd", "browser"],
    external: ["node:*", "cloudflare:*"],
    outfile: path.join(out, "worker.mjs"),
    logLevel: "silent",
  });
  const options = convertV4MiniflareOptions({
    name: "summary-recovery",
    port: 0,
    scriptPath: path.join(out, "worker.mjs"),
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: {
      RUNNER_HUBS: { className: "SummaryHub", useSQLite: true },
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
  let mf = new Miniflare(options),
    db = await mf.getD1Database("DB");
  t.after(async () => {
    await mf.dispose();
    await rm(out, { recursive: true, force: true });
  });
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
  await db.batch([
    db.prepare(
      "CREATE TABLE fixture_barrier(id TEXT PRIMARY KEY,released INTEGER)",
    ),
    db.prepare(
      "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('audit-owner','audit-owner','Audit','unused','2026')",
    ),
    db.prepare(
      "INSERT INTO rooms VALUES('canvas','Audit','audit-owner','unused','2026')",
    ),
    db
      .prepare(
        "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json,connection_epoch,last_seen_at) VALUES('runner','audit-owner','Audit','unused',?,1,?)",
      )
      .bind(
        JSON.stringify([
          {
            workspaceId: "workspace",
            name: "Audit",
            displayPath: "synthetic",
            revision: 1,
            checks: [],
          },
        ]),
        Date.now(),
      ),
    db.prepare(
      "INSERT INTO agent_bindings VALUES('binding','audit-owner','canvas','section','runner','workspace',1,1)",
    ),
  ]);
  const call = async (input) => {
    const response = await mf.dispatchFetch("https://audit.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return { http: response.status, ...(await response.json()) };
  };
  await call({ op: "seed" });
  return {
    call,
    project: (action, input = {}) => call({ op: "project", action, input }),
    tool: (name, input, hold = false) =>
      call({ op: "tool", name, input, hold }),
    rows: () => call({ op: "rows" }),
    inject: (fault) => call({ op: "inject", fault }),
    async held() {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await db
            .prepare("SELECT * FROM fixture_barrier WHERE id='race'")
            .first()
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error("DO did not enter the held gate");
    },
    async release() {
      await db
        .prepare("UPDATE fixture_barrier SET released=1 WHERE id='race'")
        .run();
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
    },
    async dispatch(runId) {
      await db
        .prepare(
          "INSERT INTO agent_workspace_leases(runner_id,workspace_id,run_id,lease_epoch,expires_at) VALUES('runner','workspace',?,1,?)",
        )
        .bind(runId, Date.now() + 60000)
        .run();
      return call({ op: "native", action: "poll", input: {} });
    },
  };
}
