import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

async function fixture(t, environment) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/agent-release-gate-"));
  const probes = `
    import app, {RunnerHub, AgentChatRouter} from './worker/index';
    const probe = Base => class extends Base {
      async fetch(request) {
        const action = new URL(request.url).pathname;
        if (action === '/alarm') { await this.alarm(); return Response.json({ok:true}); }
        if (action === '/tables') return Response.json([...this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'")]);
        if (action === '/socket') {
          const closed = [], socket = {close: code => closed.push(code)};
          await this.webSocketMessage(socket, '{}'); await this.webSocketError(socket); await this.webSocketClose(socket);
          return Response.json(closed);
        }
        return super.fetch(request);
      }
    };
    export class ProbeRunner extends probe(RunnerHub) {}
    export class ProbeChat extends probe(AgentChatRouter) {}
    export default {fetch(request, env, ctx) {
      const match = new URL(request.url).pathname.match(/^\\/__probe\\/(hub|chat)\\/(.+)$/);
      if (match) { const ns=match[1]==='hub'?env.RUNNER_HUBS:env.AGENT_CHATS;return ns.get(ns.idFromName('probe')).fetch('https://actor/'+match[2]); }
      return app.fetch(request,env,ctx);
    }};
  `;
  await build({
    stdin: { contents: probes, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "browser"],
    format: "esm",
    external: ["node:*", "cloudflare:*"],
    outfile: path.join(directory, "worker.mjs"),
    logLevel: "silent",
  });
  const options = convertV4MiniflareOptions({
    name: "agent-release-gate",
    port: 0,
    inspectorPort: 0,
    scriptPath: path.join(directory, "worker.mjs"),
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: {
      RUNNER_HUBS: { className: "ProbeRunner", useSQLite: true },
      AGENT_CHATS: { className: "ProbeChat", useSQLite: true },
    },
    bindings: {
      APP_ENV: environment,
      RUNNER_ENABLED: "true",
      CHAT_ENABLED: "true",
      EXECUTION_ENABLED: "true",
      PROJECT_SUMMARY_ENABLED: "true",
      BATCH_QUEUE_ENABLED: "true",
    },
    outboundService: () =>
      new Response("External network disabled", { status: 503 }),
  });
  Object.assign(options, {
    isolatedResourcePersistencePath: path.join(directory, "isolated"),
    resourcePersistencePath: path.join(directory, "state"),
    unsafeEnableSharedStorage: true,
    unsafeDevRegistryPath: path.join(directory, "registry"),
  });
  const mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return (pathname, init) =>
    mf.dispatchFetch("https://release.invalid" + pathname, init);
}

for (const environment of ["production", "preview"])
  test(
    `${environment} rejects every Agent entry even when old flags are enabled`,
    { timeout: 45000 },
    async (t) => {
      const request = await fixture(t, environment);
      for (const pathname of [
        "/api/agent",
        "/api/agent/devices",
        "/api/agent/chat/send",
        "/api/agent/project/summary",
        "/api/agent/execution/tools",
        "/api/runner/connect",
        "/api/runner/execution/complete",
        "/executor-mcp",
      ]) {
        for (const method of ["GET", "POST"]) {
          const response = await request(pathname + "?agent=enabled", {
            method,
          });
          assert.equal(response.status, 503, `${method} ${pathname}`);
          assert.match((await response.json()).error, /正在开发中/);
        }
      }
      const session = await (await request("/api/session")).json();
      assert.equal(session.features.agent, false);
    },
  );

test(
  "production Agent namespaces remain inert for requests, alarms and old sockets",
  { timeout: 45000 },
  async (t) => {
    const request = await fixture(t, "production");
    for (const actor of ["hub", "chat"]) {
      assert.equal((await request(`/__probe/${actor}/request`)).status, 503);
      assert.equal((await request(`/__probe/${actor}/alarm`)).status, 200);
      assert.deepEqual(
        await (await request(`/__probe/${actor}/tables`)).json(),
        [],
      );
    }
    assert.deepEqual(
      await (await request("/__probe/hub/socket")).json(),
      [1001, 1001],
    );
  },
);

test(
  "local development advertises Agent and retains authenticated routes and active namespace implementations",
  { timeout: 45000 },
  async (t) => {
    const request = await fixture(t, "local");
    const session = await (await request("/api/session")).json();
    assert.equal(session.features.agent, true);
    assert.equal((await request("/api/agent/devices")).status, 401);
    assert.ok(
      (await (await request("/__probe/chat/tables")).json()).length > 0,
    );
  },
);
