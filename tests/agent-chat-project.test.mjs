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
  "chat requires and consumes a ready project summary; refresh invalidates old facts and in-flight replies",
  { timeout: 60000 },
  async (t) => {
    const root = path.resolve(".");
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const out = await mkdtemp(path.join(root, ".tmp/chat-project-test-"));
    const script = `import app from './worker/index';import {AgentChatRouter} from './worker/agent/chat-router';import {DurableObject} from 'cloudflare:workers';
 export class Gate extends DurableObject {calls=[];hold=false;waiting=[];async fetch(r){const route=new URL(r.url).pathname;if(route==='/calls')return Response.json(this.calls);if(route==='/count')return Response.json({count:this.calls.length});if(route==='/hold'){this.hold=true;return Response.json({ok:true});}if(route==='/release'){this.hold=false;this.waiting.splice(0).forEach(f=>f());return Response.json({ok:true});}const context=await r.json();this.calls.push(context);if(this.hold)await new Promise(resolve=>this.waiting.push(resolve));return Response.json({reply:{text:JSON.stringify(context.messages),tasks:[],memories:[]}});}}
 export class ProjectHub extends DurableObject {state={status:'uninitialized',ready:false,stale:false,summaryRevision:0,summary:null,sourceRunId:null,capturedAt:null,cwd:null};initializations=new Set();async fetch(r){const url=new URL(r.url);if(url.pathname==='/set'){this.state={...this.state,...await r.json()};return Response.json({ok:true});}if(url.pathname==='/count')return Response.json({count:this.initializations.size});const {principal:p,input}=await r.json();if(url.pathname.endsWith('project-initialize')){this.initializations.add(input.chatId??'initial');this.state={...this.state,status:'queued',ready:false};}return Response.json({...this.state,bindingId:p.bindingId,bindingRevision:p.bindingRevision});}}
 export class Chat extends AgentChatRouter {async generate(context){return (await this.env.GATE.get(this.env.GATE.idFromName('gate')).fetch('https://gate/generate',{method:'POST',body:JSON.stringify(context)})).json();}}
 export default {fetch(r,env,ctx){const p=new URL(r.url).pathname;if(p.startsWith('/fixture/project/'))return env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName('runner')).fetch(new Request('https://project/'+p.slice('/fixture/project/'.length),r));if(p.startsWith('/fixture/model/'))return env.GATE.get(env.GATE.idFromName('gate')).fetch(new Request('https://model/'+p.slice('/fixture/model/'.length),r));return app.fetch(r,env,ctx);}};`;
    await build({
      stdin: { contents: script, resolveDir: root },
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
      name: "chat-project-test",
      scriptPath: path.join(out, "worker.mjs"),
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: {
        AGENT_CHATS: { className: "Chat", useSQLite: true },
        RUNNER_HUBS: { className: "ProjectHub", useSQLite: true },
        GATE: { className: "Gate", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        CHAT_ENABLED: "true",
        PROJECT_SUMMARY_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        RUNNER_ENABLED: "true",
        ROUTER_API_KEY: "fake-key",
        ROUTER_MODEL: "fixture",
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
    const token = "a".repeat(64);
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(token), "alice", Date.now() + 3600000),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','Canvas','alice','invite','2026')",
      ),
      db.prepare("INSERT INTO members VALUES('canvas','alice','owner','2026')"),
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
    const call = async (route, input) => {
      const res = await mf.dispatchFetch("https://app.test" + route, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Cookie: "qd_session=" + token,
          "X-QD-Account": "alice",
          "Content-Type": "application/json",
          Origin: "https://app.test",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { http: res.status, ...(await res.json()) };
    };
    const bound = (data) => ({
      bindingId: "binding",
      bindingRevision: 1,
      ...data,
    });
    const state = (chatId) =>
      call(
        "/api/agent/chat/state?bindingId=binding" +
          (chatId ? "&chatId=" + chatId : ""),
      );
    const until = async (fn) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("timed out");
    };
    const settled = (chatId) =>
      until(async () => {
        const s = await state(chatId);
        return s.job && !["queued", "running"].includes(s.job.status)
          ? s
          : false;
      });
    assert.equal((await state()).project.ready, false);
    assert.equal(
      (
        await call(
          "/api/agent/chat/send",
          bound({ requestId: "early", text: "项目现在怎样？" }),
        )
      ).http,
      409,
    );
    assert.equal((await state()).messages.length, 0);
    const chat = await call("/api/agent/chat/new", bound({ requestId: "new" }));
    assert.equal(chat.http, 200);
    assert.equal(
      (await call("/api/agent/chat/new", bound({ requestId: "new" }))).id,
      chat.id,
    );
    assert.equal((await call("/fixture/project/count")).count, 1);
    await state(chat.id);
    await state(chat.id);
    assert.equal((await call("/fixture/project/count")).count, 1);
    const summary = (overview) => ({
      overview,
      completed: [],
      inProgress: [],
      pending: [],
      blockers: [],
      verification: [],
      uncertainties: [],
    });
    const ready = {
      status: "ready",
      ready: true,
      summaryRevision: 1,
      sourceRunId: "run-a",
      capturedAt: "2026-11-05T00:00:00Z",
      cwd: "D:/demo",
      summary: summary("只读检查事实甲"),
    };
    await call("/fixture/project/set", ready);
    const send = bound({
      requestId: "one",
      chatId: chat.id,
      text: "项目目前的情况？",
    });
    assert.equal((await call("/api/agent/chat/send", send)).http, 202);
    let s = await settled(chat.id);
    assert.equal(s.job.status, "succeeded");
    assert.ok(s.messages.at(-1).text.includes("只读检查事实甲"));
    assert.equal(
      s.messages.at(-1).invalidated,
      false,
      "a fresh reply must remain available to save tasks or memories",
    );
    assert.equal(s.messages.at(-1).provenance.project.summaryRevision, 1);
    assert.equal(
      (await call("/api/agent/chat/send", send)).job.status,
      "succeeded",
    );
    assert.equal((await call("/fixture/model/count")).count, 1);
    await call("/fixture/project/set", {
      ...ready,
      summaryRevision: 2,
      sourceRunId: "run-b",
      summary: summary("更新事实乙"),
    });
    s = await state(chat.id);
    assert.equal(s.messages.at(-1).invalidated, true);
    assert.equal(
      (
        await call(
          "/api/agent/chat/send",
          bound({ requestId: "two", chatId: chat.id, text: "现在呢？" }),
        )
      ).http,
      202,
    );
    s = await settled(chat.id);
    assert.equal(s.job.status, "succeeded");
    assert.ok(s.messages.at(-1).text.includes("更新事实乙"));
    assert.equal(
      s.messages.at(-1).invalidated,
      false,
      "a new reply uses the updated summary, while prior replies stay invalidated",
    );
    assert.equal(s.messages.at(-1).provenance.project.sourceRunId, "run-b");
    assert.ok(!s.messages.at(-1).text.includes("只读检查事实甲"));
    await call("/fixture/model/hold");
    await call(
      "/api/agent/chat/send",
      bound({ requestId: "held", chatId: chat.id, text: "等待时更新摘要" }),
    );
    await until(async () => {
      const s = await state(chat.id);
      return s.job?.status === "running";
    });
    await call("/fixture/project/set", {
      ...ready,
      summaryRevision: 3,
      sourceRunId: "run-c",
    });
    await call("/fixture/model/release");
    s = await settled(chat.id);
    assert.equal(s.job.status, "failed");
    assert.match(s.job.error, /项目摘要/);
    await call("/fixture/project/set", {
      ready: false,
      status: "failed",
      stale: true,
      error: "总结失败",
    });
    assert.equal(
      (
        await call(
          "/api/agent/chat/send",
          bound({
            requestId: "stale",
            chatId: chat.id,
            text: "不能默用旧摘要",
          }),
        )
      ).http,
      409,
    );
    await call("/fixture/project/set", { ready: true, status: "ready" });
    assert.equal(
      (
        await call(
          "/api/agent/chat/send",
          bound({
            requestId: "accepted-old",
            chatId: chat.id,
            text: "已明确采用上次摘要",
          }),
        )
      ).http,
      202,
    );
    s = await settled(chat.id);
    assert.equal(s.job.status, "succeeded");
    assert.ok(s.messages.at(-1).text.includes("stale"));
  },
);
