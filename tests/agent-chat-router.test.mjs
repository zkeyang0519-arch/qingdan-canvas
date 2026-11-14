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
  "real chat routes persist proposals and memories with account isolation and in-flight forget fencing",
  { timeout: 60000 },
  async (t) => {
    const root = path.resolve(".");
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const out = await mkdtemp(path.join(root, ".tmp/chat-router-test-"));
    const script = `import app from './worker/index'; import {CanvasRoom} from './worker/room'; import {AgentChatRouter} from './worker/agent/chat-router'; import {generateChatReply} from './worker/agent/chat-model'; import {DurableObject} from 'cloudflare:workers';
 export class ModelGate extends DurableObject {calls=[]; hold=false; failCanvas=false; waiting=[]; async fetch(request){const route=new URL(request.url).pathname;
 if(route==='/fail-canvas'){this.failCanvas=true;return Response.json({ok:true});}
 if(route==='/allow-canvas'){this.failCanvas=false;return Response.json({ok:true});}
 if(route==='/canvas-failure')return Response.json({fail:this.failCanvas});
 if(route==='/calls')return Response.json(this.calls);
 if(route==='/hold'){this.hold=true;return Response.json({ok:true});}
 if(route==='/release'){this.hold=false;for(const r of this.waiting.splice(0))r();return Response.json({ok:true});}
 const context=await request.json();this.calls.push(context);if(this.hold)await new Promise(resolve=>this.waiting.push(resolve));
 const text=context.messages.at(-1).content;const reply={text:'已收到',tasks:[],memories:[]};
 if(text.includes('整理待办')){reply.text='已整理待办建议，等待你保存。';reply.tasks=[{text:'第一条建议',instruction:'完成第一条',acceptance:'第一条可核对'},{text:'第二条建议',instruction:'完成第二条',acceptance:'第二条可核对'}];}
 else if(text.includes('记住'))reply.memories=[{scope:'personal',key:'记忆候选测试',value:'候选短句偏好'}];
 else reply.text=JSON.stringify(context.messages);
 return Response.json({reply,usage:{inputTokens:10,outputTokens:10}});}}
 export class TestCanvasRoom extends CanvasRoom {async fetch(request){const input=await request.clone().json().catch(()=>null);if(input?.input?.action==='create'){const state=await(await this.env.MODEL_GATE.get(this.env.MODEL_GATE.idFromName('gate')).fetch('https://model/canvas-failure')).json();if(state.fail)return Response.json({error:'temporary canvas failure'},{status:503});}return super.fetch(request);}}
 export class TestAgentChat extends AgentChatRouter {
 streaming={calls:0,aborted:false,cancelled:false};
 async fetch(request){const route=new URL(request.url).pathname;if(route==='/stream-state')return Response.json({...this.streaming,running:this.running.size});if(route==='/lost-receipt'){const {messageId}=await request.json();this.ctx.storage.sql.exec("UPDATE agent_chat_task_proposals SET status='saving',receipt=NULL WHERE message_id=?",messageId);return Response.json({ok:true});}return super.fetch(request);}
 async generate(context,options){
 if(context.messages.at(-1).content.includes('流式取消'))return generateChatReply(this.env,context,async(_,init)=>{
 this.streaming.calls++;init.signal.addEventListener('abort',()=>{this.streaming.aborted=true;},{once:true});
 return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'{"text":"先看到的回复'},finish_reason:null}]})+'\\n\\n'));},cancel:()=>{this.streaming.cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
 },options);
 return (await this.env.MODEL_GATE.get(this.env.MODEL_GATE.idFromName('gate')).fetch('https://model/generate',{method:'POST',body:JSON.stringify(context)})).json();}}
 export default {fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/fixture/chat-stream-state')return env.AGENT_CHATS.get(env.AGENT_CHATS.idFromName('alice')).fetch('https://agent.internal/stream-state');if(url.pathname==='/fixture/lost-receipt')return env.AGENT_CHATS.get(env.AGENT_CHATS.idFromName('alice')).fetch(new Request('https://agent.internal/lost-receipt',request));if(url.pathname.startsWith('/fixture/'))return env.MODEL_GATE.get(env.MODEL_GATE.idFromName('gate')).fetch(new Request('https://model/'+url.pathname.slice('/fixture/'.length),request));return app.fetch(request,env,ctx);}};`;
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
      name: "chat-router-test",
      scriptPath: path.join(out, "worker.mjs"),
      modules: true,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      durableObjects: {
        ROOMS: { className: "TestCanvasRoom", useSQLite: true },
        AGENT_CHATS: { className: "TestAgentChat", useSQLite: true },
        MODEL_GATE: { className: "ModelGate", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        CHAT_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        RUNNER_ENABLED: "true",
        ROUTER_API_KEY: "private-test-key",
        ROUTER_MODEL: "fixture",
        ROUTER_BASE_URL: "https://api.deepseek.com",
        ROUTER_API_FORMAT: "chat_completions",
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
    const raw = "a".repeat(64),
      bob = "b".repeat(64);
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','2026'),('bob','bob','Bob','hash','2026')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(raw), "alice", Date.now() + 3600000),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(sha(bob), "bob", Date.now() + 3600000),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas-a','Canvas A','alice','invite-a','2026'),('canvas-b','Canvas B','alice','invite-b','2026')",
      ),
      db.prepare(
        "INSERT INTO members VALUES('canvas-a','alice','owner','2026'),('canvas-b','alice','owner','2026')",
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
        "INSERT INTO agent_bindings VALUES('binding-a','alice','canvas-a','ungrouped','runner','workspace',1,1),('binding-b','alice','canvas-b','ungrouped','runner','workspace',1,1)",
      ),
    ]);
    const call = async (route, input, user = "alice") => {
      if (input?.bindingId && route.startsWith("/api/agent/chat/"))
        input = { bindingRevision: 1, ...input };
      const r = await mf.dispatchFetch("https://app.test" + route, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Cookie: "qd_session=" + (user === "alice" ? raw : bob),
          "X-QD-Account": user,
          "Content-Type": "application/json",
          Origin: "https://app.test",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { http: r.status, ...(await r.json()) };
    };
    const state = (binding = "binding-a", chat) =>
      call(
        "/api/agent/chat/state?bindingId=" +
          binding +
          (chat ? "&chatId=" + chat : ""),
      );
    const until = async (check) => {
      for (let i = 0; i < 80; i++) {
        const value = await check();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.fail("chat state did not settle");
    };
    const settled = (chat) =>
      until(async () => {
        const v = await state("binding-a", chat);
        return ["succeeded", "failed", "stale"].includes(v.job?.status)
          ? v
          : null;
      });
    const provider = await state();
    assert.equal(provider.http, 200);
    assert.equal(provider.provider.configured, true);
    assert.ok(!JSON.stringify(provider).includes("private-test-key"));
    const personal = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "mem-personal",
        scope: "personal",
        key: "偏好",
        value: "旧偏好标记",
      })
    ).memory;
    const project = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "mem-project",
        bindingId: "binding-a",
        scope: "project",
        key: "配色",
        value: "仅项目A青灰",
      })
    ).memory;
    assert.equal((await state("binding-b")).memories.length, 1);
    assert.equal(
      (await call("/api/agent/chat/state", undefined, "bob")).memories.length,
      0,
    );
    assert.equal(
      (
        await call(
          "/api/agent/chat/state?bindingId=binding-a",
          undefined,
          "bob",
        )
      ).http,
      403,
    );
    const sent = await call("/api/agent/chat/send", {
      requestId: "send-plan",
      bindingId: "binding-a",
      text: "请整理待办。",
    });
    assert.equal(sent.http, 202);
    const planState = await settled(sent.thread.id);
    assert.equal(planState.job.status, "succeeded");
    const reply = planState.messages.find((m) => m.role === "assistant");
    assert.equal(reply.tasks.length, 2);
    const duplicate = await call("/api/agent/chat/send", {
      requestId: "send-plan",
      bindingId: "binding-a",
      text: "请整理待办。",
    });
    assert.equal(duplicate.job.id, sent.job.id);
    const tasks = reply.tasks.map((task, i) => ({
      ...task,
      text: i ? "第二条建议" : "用户编辑后的第一条",
    }));
    const adopt = {
      requestId: "save-plan",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      messageId: reply.id,
      tasks,
    };
    const saved = await call("/api/agent/chat/save-tasks", adopt);
    assert.equal(saved.http, 200, JSON.stringify(saved));
    assert.equal(saved.taskIds.length, 2);
    assert.deepEqual(await call("/api/agent/chat/save-tasks", adopt), saved);
    const checklist = await call("/api/agent/execution/checklist", {
      bindingId: "binding-a",
      action: "list",
    });
    assert.equal(checklist.tasks.length, 2);
    assert.equal(checklist.tasks[0].text, "用户编辑后的第一条");
    assert.ok(checklist.tasks.every((t) => !t.done));
    const previousCandidate = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "seed-candidate-key",
        scope: "personal",
        key: "记忆候选测试",
        value: "待替换的旧值",
      })
    ).memory;
    const candidateJob = await call("/api/agent/chat/send", {
      requestId: "send-memory",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      text: "请记住我偏好短句。",
    });
    const candidateState = await settled(candidateJob.thread.id);
    const candidate = candidateState.messages.find(
      (m) => m.id === candidateState.job.assistantMessageId,
    );
    const remember = {
      requestId: "remember",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      messageId: candidate.id,
      index: 0,
      expectedMemoryId: previousCandidate.id,
      expectedRevision: previousCandidate.revision,
    };
    const remembered = await call("/api/agent/chat/remember", remember);
    assert.equal(remembered.http, 200);
    assert.equal(remembered.id, previousCandidate.id);
    assert.equal(remembered.revision, previousCandidate.revision + 1);
    assert.equal(
      (await state("binding-a", sent.thread.id)).messages.find(
        (m) => m.id === candidate.id,
      ).invalidated,
      true,
    );
    assert.deepEqual(
      await call("/api/agent/chat/remember", remember),
      remembered,
    );
    await call("/api/agent/chat/memory", {
      action: "save",
      requestId: "edit-personal",
      id: personal.id,
      expectedRevision: personal.revision,
      scope: "personal",
      key: "偏好",
      value: "新偏好标记",
    });
    await call("/api/agent/chat/send", {
      requestId: "recall",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      text: "说说已保存的偏好。",
    });
    await settled(sent.thread.id);
    const calls = await (
      await mf.dispatchFetch("https://app.test/fixture/calls")
    ).json();
    assert.ok(JSON.stringify(calls.at(-1)).includes("新偏好标记"));
    assert.ok(!JSON.stringify(calls.at(-1)).includes("旧偏好标记"));
    await call("/api/agent/chat/memory", {
      action: "delete",
      requestId: "delete-candidate",
      bindingId: "binding-a",
      id: remembered.id,
      expectedRevision: remembered.revision,
    });
    assert.equal((await call("/api/agent/chat/remember", remember)).http, 409);
    await mf.dispatchFetch("https://app.test/fixture/hold");
    const before = calls.length;
    await call("/api/agent/chat/send", {
      requestId: "held",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      text: "请查看当前记忆。",
    });
    await until(async () => {
      const list = await (
        await mf.dispatchFetch("https://app.test/fixture/calls")
      ).json();
      return list.length > before;
    });
    await call("/api/agent/chat/memory", {
      action: "delete",
      requestId: "delete-project",
      bindingId: "binding-a",
      id: project.id,
      expectedRevision: project.revision,
    });
    await mf.dispatchFetch("https://app.test/fixture/release");
    assert.equal((await settled(sent.thread.id)).job.status, "stale");
    const dependency = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "save-dependency",
        bindingId: "binding-a",
        scope: "project",
        key: "保存约束",
        value: "待删除的约束",
      })
    ).memory;
    await call("/api/agent/chat/send", {
      requestId: "failed-plan-message",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      text: "请重新整理待办。",
    });
    const planned = await settled(sent.thread.id),
      plannedReply = planned.messages.find(
        (m) => m.id === planned.job.assistantMessageId,
      );
    const pendingTasks = plannedReply.tasks.map((t) => ({
      ...t,
      text: "已编辑的 " + t.text,
    }));
    const pendingSave = {
      requestId: "failed-plan-save",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      messageId: plannedReply.id,
      tasks: pendingTasks,
    };
    await mf.dispatchFetch("https://app.test/fixture/fail-canvas");
    assert.equal(
      (await call("/api/agent/chat/save-tasks", pendingSave)).http,
      503,
    );
    const pendingState = await state("binding-a", sent.thread.id);
    assert.deepEqual(
      pendingState.messages.find((m) => m.id === plannedReply.id).taskProposal
        .tasks,
      pendingTasks,
      "pending proposal retains exact accepted edits for retry",
    );
    await mf.dispatchFetch("https://app.test/fixture/allow-canvas");
    await call("/api/agent/chat/memory", {
      action: "delete",
      requestId: "delete-dependency",
      bindingId: "binding-a",
      id: dependency.id,
      expectedRevision: dependency.revision,
    });
    assert.equal(
      (await call("/api/agent/chat/save-tasks", pendingSave)).http,
      409,
      "forget forbids a new write from a failed old proposal",
    );
    assert.equal(
      (
        await call("/api/agent/execution/checklist", {
          bindingId: "binding-a",
          action: "list",
        })
      ).tasks.length,
      2,
    );
    // A real Canvas commit can still be discovered after forgetting, but lookup
    // must not create anything or replace the already approved edited payload.
    await call("/fixture/lost-receipt", { messageId: reply.id });
    const recovered = await call("/api/agent/chat/save-tasks", adopt);
    assert.deepEqual(recovered.taskIds, saved.taskIds);
    assert.equal(
      (
        await call("/api/agent/execution/checklist", {
          bindingId: "binding-a",
          action: "list",
        })
      ).tasks.length,
      2,
    );

    const unresolved = (await state("binding-a", sent.thread.id)).messages.find(
      (m) => m.id === plannedReply.id,
    );
    assert.equal(
      unresolved.taskProposal.status,
      "saving",
      "an absent receipt remains queryable after source invalidation",
    );
    assert.equal(unresolved.invalidated, true);
    // Simulate the original approved write committing after the first receipt
    // lookup returned empty, with its response lost before the chat stored it.
    const late = await call("/api/agent/execution/checklist", {
      bindingId: "binding-a",
      action: "create",
      requestId: `chat-plan-${plannedReply.id}`,
      tasks: pendingTasks,
    });
    assert.equal(late.http, 200);
    const lateRecovered = await call("/api/agent/chat/save-tasks", pendingSave);
    assert.equal(lateRecovered.http, 200);
    assert.equal(lateRecovered.taskIds.length, 2);
    assert.equal(
      (
        await call("/api/agent/execution/checklist", {
          bindingId: "binding-a",
          action: "list",
        })
      ).tasks.length,
      4,
    );
    assert.equal(
      (await state("binding-a", sent.thread.id)).messages.find(
        (m) => m.id === plannedReply.id,
      ).taskProposal.status,
      "saved",
    );

    await call("/api/agent/chat/send", {
      requestId: "independent-candidate",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      text: "请记住新的短句偏好。",
    });
    const independentState = await settled(sent.thread.id),
      independent = independentState.messages.find(
        (m) => m.id === independentState.job.assistantMessageId,
      );
    const oldKey = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "concurrent-key",
        scope: "personal",
        key: "记忆候选测试",
        value: "并发值A",
      })
    ).memory;
    await call("/api/agent/chat/memory", {
      action: "delete",
      requestId: "delete-concurrent-key",
      id: oldKey.id,
      expectedRevision: oldKey.revision,
    });
    const newKey = (
      await call("/api/agent/chat/memory", {
        action: "save",
        requestId: "replace-key",
        scope: "personal",
        key: "记忆候选测试",
        value: "并发值B",
      })
    ).memory;
    const staleRemember = {
      requestId: "stale-remember",
      bindingId: "binding-a",
      chatId: sent.thread.id,
      messageId: independent.id,
      index: 0,
      expectedMemoryId: oldKey.id,
      expectedRevision: oldKey.revision,
    };
    assert.equal(
      (await call("/api/agent/chat/remember", staleRemember)).http,
      409,
    );
    assert.equal(
      (await state()).memories.find((m) => m.id === newKey.id).value,
      "并发值B",
    );
    await call("/api/agent/chat/memory", {
      action: "delete",
      requestId: "delete-replaced-key",
      id: newKey.id,
      expectedRevision: newKey.revision,
    });
    assert.equal(
      (
        await call("/api/agent/chat/remember", {
          ...staleRemember,
          requestId: "stale-absent",
        })
      ).http,
      409,
    );
    const { expectedMemoryId, expectedRevision, ...refreshedRemember } =
      staleRemember;
    assert.equal(
      (
        await call("/api/agent/chat/remember", {
          ...refreshedRemember,
          requestId: "stale-refreshed",
        })
      ).http,
      409,
      "refresh cannot resurrect a key deleted after candidate generation",
    );
    assert.equal(
      (await state("binding-a", sent.thread.id)).messages.find(
        (m) => m.id === independent.id,
      ).memoryStates[0],
      "stale",
    );
    const streamingInput = {
      requestId: "streaming-cancel",
      bindingId: "binding-a",
      text: "流式取消测试",
    };
    const streamingSent = await call("/api/agent/chat/send", streamingInput);
    const streamingState = await until(async () => {
      const value = await state("binding-a", streamingSent.thread.id);
      return value.job.partialText === "先看到的回复" ? value : null;
    });
    assert.equal(streamingState.job.status, "running");
    assert.equal(streamingState.messages.length, 1);
    const cancellation = {
      requestId: "stop-stream",
      bindingId: "binding-a",
      bindingRevision: 1,
      chatId: streamingSent.thread.id,
      jobId: streamingSent.job.id,
    };
    assert.equal(
      (await call("/api/agent/chat/cancel", cancellation, "bob")).http,
      403,
    );
    assert.equal(
      (
        await call("/api/agent/chat/cancel", {
          ...cancellation,
          bindingId: "binding-b",
        })
      ).http,
      404,
    );
    assert.equal(
      (
        await call("/api/agent/chat/cancel", {
          ...cancellation,
          chatId: sent.thread.id,
        })
      ).http,
      404,
    );
    assert.equal(
      (
        await call("/api/agent/chat/cancel", {
          ...cancellation,
          bindingRevision: 99,
        })
      ).http,
      409,
    );
    const stopped = await call("/api/agent/chat/cancel", cancellation);
    assert.equal(stopped.http, 200);
    assert.equal(stopped.job.status, "cancelled");
    assert.equal(stopped.job.partialText, "先看到的回复");
    assert.deepEqual(
      await call("/api/agent/chat/cancel", cancellation),
      stopped,
    );
    const transport = await until(async () => {
      const value = await call("/fixture/chat-stream-state");
      return value.aborted && value.cancelled && value.running === 0
        ? value
        : null;
    });
    assert.equal(transport.calls, 1);
    assert.equal(
      (await call("/api/agent/chat/send", streamingInput)).job.status,
      "cancelled",
    );
    const cancelledState = await state("binding-a", streamingSent.thread.id);
    assert.equal(cancelledState.job.partialText, "先看到的回复");
    assert.equal(cancelledState.messages.length, 2);
    const stoppedMessage = cancelledState.messages[1];
    assert.equal(stoppedMessage.id, stopped.job.assistantMessageId);
    assert.equal(stoppedMessage.text, "先看到的回复");
    assert.equal(stoppedMessage.provenance.kind, "cancelled_reply");
    assert.equal(stoppedMessage.tasks.length, 0);
    assert.equal(stoppedMessage.memories.length, 0);
    await call("/api/agent/chat/send", {
      requestId: "send-after-cancel",
      bindingId: "binding-a",
      chatId: streamingSent.thread.id,
      text: "取消之后继续讨论",
    });
    const afterCancel = await settled(streamingSent.thread.id);
    assert.equal(afterCancel.job.status, "succeeded");
    assert.equal(
      afterCancel.messages.find((message) => message.id === stoppedMessage.id)
        .text,
      "先看到的回复",
    );

    // A provider that ignores abort must still be unable to publish a late result.
    await call("/fixture/hold", {});
    const lateCancelled = await call("/api/agent/chat/send", {
      requestId: "cancel-late-provider",
      bindingId: "binding-a",
      text: "整理待办，晚到回复",
    });
    await until(
      async () =>
        (await state("binding-a", lateCancelled.thread.id)).job.status ===
        "running",
    );
    await call("/api/agent/chat/cancel", {
      ...cancellation,
      requestId: "stop-late-provider",
      chatId: lateCancelled.thread.id,
      jobId: lateCancelled.job.id,
    });
    await call("/fixture/release", {});
    await until(
      async () => (await call("/fixture/chat-stream-state")).running === 0,
    );
    const lateCancelledState = await state(
      "binding-a",
      lateCancelled.thread.id,
    );
    assert.equal(lateCancelledState.job.status, "cancelled");
    assert.equal(lateCancelledState.messages.length, 1);
    assert.equal((await call("/fixture/chat-stream-state")).calls, 1);
    await db
      .prepare(
        "UPDATE agent_bindings SET revision=2 WHERE binding_id='binding-a'",
      )
      .run();
    assert.equal(
      (
        await call("/api/agent/chat/send", {
          requestId: "stale-binding",
          bindingId: "binding-a",
          bindingRevision: 1,
          text: "旧标签页消息",
        })
      ).http,
      409,
    );
  },
);
