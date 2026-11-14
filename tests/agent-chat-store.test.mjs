import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const projectSummary = (overrides = {}) => ({
  bindingId: "p",
  bindingRevision: 1,
  ready: true,
  stale: false,
  sourceRunId: "summary-run-1",
  summaryRevision: 1,
  sourceKind: "codex_history",
  capturedAt: "2026-11-12T00:00:00Z",
  summary: {
    overview: "项目已有登录功能",
    completed: [{ text: "登录已完成" }],
    inProgress: [],
    pending: [{ text: "P1：补充退出功能" }],
    blockers: [],
    verification: [{ text: "历史记录报告测试通过" }],
    uncertainties: [{ text: "未重新检查代码" }],
  },
  ...overrides,
});
const api = (async () => {
  const { outputFiles } = await build({
    stdin: {
      contents:
        "export * from './worker/agent/chat-store'; export * from './worker/agent/chat-context';",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
})();

async function fixture(t, legacyJobs = false) {
  const { ChatStore, buildChatContext } = await api;
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  if (legacyJobs)
    db.exec(`CREATE TABLE agent_chat_jobs(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_message_id TEXT NOT NULL,
      status TEXT NOT NULL,revision INTEGER NOT NULL,memory_epoch INTEGER NOT NULL,lease_until INTEGER,
      assistant_message_id TEXT,error TEXT);
      INSERT INTO agent_chat_jobs VALUES('legacy-job','p','legacy-chat','legacy-message','running',2,0,9007199254740991,NULL,NULL);`);
  const sql = {
    exec(query, ...args) {
      if (/^\s*CREATE TABLE/i.test(query)) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const result = /^\s*(?:SELECT|WITH)\b/i.test(query)
        ? statement.all(...args)
        : (statement.run(...args), []);
      return { toArray: () => result };
    },
  };
  let time = Date.parse("2026-11-05T00:00:00.000Z"),
    n = 0;
  const now = () => new Date(time).toISOString();
  const store = new ChatStore(sql, now);
  const begin = (bindingId, text, chatId) =>
    store.beginMessage({
      requestId: `message-${++n}`,
      bindingId,
      chatId,
      text,
    });
  const claim = (started, lease) =>
    store.claimJob(started.job.id, started.job.revision, lease);
  const context = ({ thread, message }) =>
    buildChatContext(store, {
      bindingId: thread.bindingId,
      chatId: thread.id,
      currentMessageId: message.id,
    });
  const finish = (started, text = "模型回复", memories = []) => {
    const job = claim(started);
    const { provenance } = context(started);
    return store.replyJob({
      jobId: job.id,
      expectedRevision: job.revision,
      provenance,
      reply: { text, tasks: [], memories },
    });
  };
  return {
    store,
    begin,
    claim,
    context,
    finish,
    reload: () => new ChatStore(sql, now),
    advance: (delta) => (time += delta),
  };
}

test("project summaries create a persistent chat message once per source and revision", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.store.publishProjectSummary, "function");
  const project = projectSummary();
  const published = f.store.publishProjectSummary("p", project);
  const first = f.store.readThread("p", published.thread.id);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].role, "assistant");
  assert.equal(first.messages[0].provenance.kind, "project_summary");
  assert.match(first.messages[0].text, /登录已完成/);
  assert.match(first.messages[0].text, /下一步待办/);
  assert.match(first.messages[0].text, /Codex.*任务总结/);
  assert.equal(first.job, null);
  assert.equal(
    f.store.publishProjectSummary("p", project).message.id,
    published.message.id,
  );
  assert.equal(
    f.store.publishProjectSummary("p", project, published.thread.id).message.id,
    published.message.id,
  );
  assert.equal(f.store.readThread("p", published.thread.id).messages.length, 1);
  const next = projectSummary({
    summaryRevision: 2,
    sourceRunId: "summary-run-2",
  });
  f.store.publishProjectSummary("p", next, published.thread.id);
  const messages = f.store.readThread("p", published.thread.id).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, published.message.id);
  assert.equal(messages[1].provenance.project.summaryRevision, 2);
  assert.equal(
    f.store.publishProjectSummary(
      "p",
      { ...next, stale: true },
      published.thread.id,
    ).message.id,
    messages[1].id,
  );
  assert.equal(f.store.readThread("p", published.thread.id).messages.length, 2);
  assert.throws(
    () => f.store.publishProjectSummary("other", next, published.thread.id),
    /项目|绑定/,
  );
  assert.throws(
    () => f.store.publishProjectSummary("p", { ...next, ready: false }),
    /摘要/,
  );
});

test("summary publishing preserves an existing conversation and does not duplicate background context", async (t) => {
  const f = await fixture(t);
  const existing = f.begin("p", "先前讨论");
  const published = f.store.publishProjectSummary("p", projectSummary());
  assert.equal(published.thread.id, existing.thread.id);
  const data = f.store.readThread("p", existing.thread.id);
  assert.equal(data.messages[0].text, "先前讨论");
  assert.equal(data.job.id, existing.job.id);
  f.finish(existing);
  const next = f.begin("p", "继续整理待办", existing.thread.id);
  const { buildChatContext } = await api;
  const context = buildChatContext(f.store, {
    bindingId: "p",
    chatId: next.thread.id,
    currentMessageId: next.message.id,
    project: projectSummary(),
  });
  assert.equal(
    context.provenance.messageIds.includes(published.message.id),
    false,
  );
});

test("requests replay without duplicating jobs; projects cannot read each other's chats", async (t) => {
  const f = await fixture(t);
  const input = {
    requestId: "request",
    bindingId: "project-a",
    text: " 原样输入 ",
  };
  const started = f.store.beginMessage(input);
  assert.deepEqual(f.store.beginMessage(input), started);
  assert.throws(() => f.store.beginMessage({ ...input, text: "改了" }), {
    status: 409,
  });
  assert.throws(() => f.begin("project-a", "同会话暂时忙", started.thread.id), {
    status: 409,
  });
  const elsewhere = f.begin("project-b", "另一个项目");
  assert.notEqual(elsewhere.thread.id, started.thread.id);
  assert.throws(() => f.store.readThread("project-b", started.thread.id), {
    status: 404,
  });
  assert.deepEqual(
    f.store.listThreads("project-a").map(({ id }) => id),
    [started.thread.id],
  );
  assert.equal(
    f.store.readThread("project-a", started.thread.id).messages[0].text,
    input.text,
  );
  assert.equal(f.claim(started).status, "running");
  assert.equal(f.claim(started), null);
});

test("partial replies survive reload without creating adoptable suggestions", async (t) => {
  const f = await fixture(t);
  const started = f.begin("p", "帮我整理");
  const active = f.claim(started);
  assert.equal(active.partialText, "");
  const updated = f.store.updatePartialText({
    jobId: active.id,
    expectedRevision: active.revision,
    partialText: "正在整理第一项",
  });
  assert.equal(updated.revision, active.revision);
  const data = f.reload().readThread("p", started.thread.id);
  assert.equal(data.job.partialText, "正在整理第一项");
  assert.equal(data.job.status, "running");
  assert.equal(data.messages.length, 1);
  assert.deepEqual(data.messages[0].tasks, []);
  assert.deepEqual(data.messages[0].memories, []);
  assert.equal(
    f.store.updatePartialText({
      jobId: active.id,
      expectedRevision: active.revision - 1,
      partialText: "晚到的文本",
    }),
    null,
  );
  f.advance(60_001);
  assert.equal(
    f.store.updatePartialText({
      jobId: active.id,
      expectedRevision: active.revision,
      partialText: "正在整理第一项但已过期",
    }),
    null,
  );
});

test("existing chat databases gain partial storage without losing running jobs", async (t) => {
  const f = await fixture(t, true);
  const legacy = f.store.getJob("legacy-job");
  assert.equal(legacy.status, "running");
  assert.equal(legacy.partialText, "");
  f.store.updatePartialText({
    jobId: legacy.id,
    expectedRevision: legacy.revision,
    partialText: "迁移后仍可继续",
  });
  assert.equal(f.reload().getJob(legacy.id).partialText, "迁移后仍可继续");
  assert.equal(f.begin("p", "迁移之后的新消息").job.partialText, "");
});

test("cancellation is durable, scoped and idempotent while fencing late output and final proposals", async (t) => {
  const f = await fixture(t);
  const started = f.begin("p", "整理后可以停止");
  const active = f.claim(started);
  f.store.updatePartialText({
    jobId: active.id,
    expectedRevision: active.revision,
    partialText: "保留这些字",
  });
  const input = {
    requestId: "cancel-1",
    bindingId: "p",
    bindingRevision: 1,
    chatId: started.thread.id,
    jobId: active.id,
  };
  assert.throws(() => f.store.cancelJob({ ...input, bindingId: "other" }), {
    status: 404,
  });
  const cancelled = f.store.cancelJob(input);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.partialText, "保留这些字");
  assert.equal(cancelled.leaseUntil, null);
  assert.equal(cancelled.revision, active.revision + 1);
  assert.deepEqual(f.reload().cancelJob(input), cancelled);
  assert.deepEqual(
    f.store.cancelJob({ ...input, requestId: "cancel-2" }),
    cancelled,
  );
  assert.throws(() => f.store.cancelJob({ ...input, bindingRevision: 2 }), {
    status: 409,
  });
  assert.equal(
    f.store.updatePartialText({
      jobId: active.id,
      expectedRevision: active.revision,
      partialText: "保留这些字但不能再加",
    }),
    null,
  );
  assert.equal(
    f.store.replyJob({
      jobId: active.id,
      expectedRevision: active.revision,
      provenance: f.context(started).provenance,
      reply: {
        text: "晚到结果",
        tasks: [
          { text: "不要采用", instruction: "不应执行", acceptance: "不会出现" },
        ],
        memories: [],
      },
    }),
    null,
  );
  assert.equal(
    f.store.failJob({
      jobId: active.id,
      expectedRevision: active.revision,
      error: "晚到错误",
    }),
    null,
  );
  const stoppedMessages = f
    .reload()
    .readThread("p", started.thread.id).messages;
  assert.equal(stoppedMessages.length, 2);
  assert.equal(stoppedMessages[1].id, cancelled.assistantMessageId);
  assert.equal(stoppedMessages[1].text, "保留这些字");
  assert.equal(stoppedMessages[1].provenance.kind, "cancelled_reply");
  assert.deepEqual(stoppedMessages[1].tasks, []);
  assert.deepEqual(stoppedMessages[1].memories, []);
  assert.equal(
    f.store.contextMessage("p", started.thread.id, stoppedMessages[1].id),
    null,
  );
  assert.deepEqual(f.store.listPendingJobs(), []);
  const next = f.begin("p", "取消之后可以再发", started.thread.id);
  assert.equal(next.job.status, "queued");
  assert.deepEqual(
    f
      .reload()
      .readThread("p", started.thread.id)
      .messages.map((message) => message.text),
    ["整理后可以停止", "保留这些字", "取消之后可以再发"],
  );
  assert.ok(!JSON.stringify(f.context(next).messages).includes("保留这些字"));
});

test("queued jobs cancel without being claimed and completed replies are not rewritten", async (t) => {
  const f = await fixture(t);
  const queued = f.begin("p", "尚未开始");
  const cancel = (started, requestId) =>
    f.store.cancelJob({
      requestId,
      bindingId: "p",
      bindingRevision: 1,
      chatId: started.thread.id,
      jobId: started.job.id,
    });
  assert.equal(cancel(queued, "cancel-queued").status, "cancelled");
  assert.equal(f.claim(queued), null);
  const completed = f.begin("p", "已经完成", queued.thread.id);
  const result = f.finish(completed);
  assert.deepEqual(cancel(completed, "cancel-completed"), result);
});

test("project context is bounded data and old summary-derived history is excluded", async (t) => {
  const f = await fixture(t),
    { buildChatContext } = await api;
  const project = {
    bindingId: "p",
    bindingRevision: 1,
    ready: true,
    stale: false,
    summaryRevision: 1,
    sourceRunId: "run-a",
    capturedAt: "2026-11-05T00:00:00Z",
    cwd: "D:/demo",
    summary: {
      overview: "项目事实甲",
      completed: [],
      inProgress: [],
      pending: [],
      blockers: [],
      verification: [],
      uncertainties: [],
    },
  };
  const first = f.store.beginMessage({
    requestId: "project-first",
    bindingId: "p",
    text: "旧项目的问题",
    project: { bindingRevision: 1, summaryRevision: 1, sourceRunId: "run-a" },
  });
  const job = f.claim(first),
    context = buildChatContext(f.store, {
      bindingId: "p",
      chatId: first.thread.id,
      currentMessageId: first.message.id,
      project,
    });
  assert.ok(context.messages[0].content.includes("项目事实甲"));
  assert.equal(context.provenance.project.sourceRunId, "run-a");
  f.store.replyJob({
    jobId: job.id,
    expectedRevision: job.revision,
    reply: { text: "旧摘要衍生回答", tasks: [], memories: [] },
    provenance: context.provenance,
  });
  const next = f.begin("p", "新项目的问题", first.thread.id);
  const latest = {
    ...project,
    summaryRevision: 2,
    sourceRunId: "run-b",
    summary: { ...project.summary, overview: "新事实乙" },
  };
  const fresh = buildChatContext(f.store, {
    bindingId: "p",
    chatId: first.thread.id,
    currentMessageId: next.message.id,
    project: latest,
  });
  const text = JSON.stringify(fresh.messages);
  assert.ok(text.includes("新事实乙"));
  assert.ok(!text.includes("旧摘要衍生回答"));
  assert.ok(
    text.includes("旧项目的问题"),
    "independent raw user requirements survive summary refresh",
  );
  assert.throws(
    () =>
      buildChatContext(f.store, {
        bindingId: "p",
        chatId: first.thread.id,
        currentMessageId: next.message.id,
        project: {
          ...latest,
          summary: { ...latest.summary, overview: "长".repeat(44000) },
        },
      }),
    { status: 413 },
  );
});

test("expired calls cannot be resubmitted automatically or write late replies", async (t) => {
  const f = await fixture(t);
  const started = f.begin("p", "完成任务");
  const first = f.claim(started, 1000);
  const { provenance } = f.context(started);
  f.advance(1001);
  assert.equal(f.store.claimJob(first.id, first.revision, 1000), null);
  const reply = (job, text) =>
    f.store.replyJob({
      jobId: job.id,
      expectedRevision: job.revision,
      provenance,
      reply: { text, tasks: [], memories: [] },
    });
  assert.equal(reply(first, "已失效的回复"), null);
  assert.equal(
    f.store.failJob({
      jobId: first.id,
      expectedRevision: first.revision,
      error: "超时",
    }).status,
    "failed",
  );
  const manuallyResent = f.begin("p", "手动重新发送", started.thread.id);
  assert.equal(f.finish(manuallyResent, "有效回复").status, "succeeded");
  assert.deepEqual(
    f.store.readThread("p", started.thread.id).messages.map(({ text }) => text),
    ["完成任务", "手动重新发送", "有效回复"],
  );
});

test("forgetting invalidates source messages, dependent replies and pending provider results", async (t) => {
  const f = await fixture(t);
  const one = f.begin("p", "我偏好旧选项 ZZ-BEFORE");
  const firstReply = f.finish(one, "好的，使用旧选项");
  const memory = f.store.saveMemory({
    requestId: "remember",
    scope: "project",
    bindingId: "p",
    key: "选项",
    value: "ZZ-BEFORE",
    sourceMessageId: one.message.id,
  });
  assert.equal(f.store.isMessageUsable(firstReply.assistantMessageId), true);
  const two = f.begin("p", "下一轮", one.thread.id);
  assert.match(JSON.stringify(f.context(two).messages), /ZZ-BEFORE/);
  f.finish(two, "直接依赖旧记忆的回答");
  // Select enough recent memories to push the old memory out of context while
  // retaining the previous assistant reply as a transitive dependency.
  for (let i = 0; i < 12; i++) {
    f.advance(1);
    f.store.saveMemory({
      requestId: `new-${i}`,
      scope: "project",
      bindingId: "p",
      key: `fresh-${i}`,
      value: `fresh-${i}`,
    });
  }
  const three = f.begin("p", "再次继续", one.thread.id);
  assert.ok(
    !f.context(three).provenance.memories.some((m) => m.id === memory.id),
  );
  const transitive = f.finish(three, "间接依赖旧记忆的回答");
  const four = f.begin("p", "执行中的请求", one.thread.id);
  const active = f.claim(four);
  const { provenance } = f.context(four);
  const deletion = {
    requestId: "forget",
    id: memory.id,
    expectedRevision: memory.revision,
    bindingId: "p",
  };
  f.store.deleteMemory(deletion);
  const epoch = f.store.getMemoryEpoch();
  f.store.deleteMemory(deletion);
  assert.equal(f.store.getMemoryEpoch(), epoch);
  const late = f.store.replyJob({
    jobId: active.id,
    expectedRevision: active.revision,
    provenance,
    reply: {
      text: "应丢弃",
      tasks: [{ text: "坏任务", instruction: "不执行", acceptance: "无" }],
      memories: [{ scope: "project", key: "选项", value: "ZZ-BEFORE" }],
    },
  });
  assert.equal(late.status, "stale");
  const after = f.begin("p", "新的明确输入", one.thread.id);
  const safe = JSON.stringify(f.context(after).messages);
  assert.doesNotMatch(safe, /ZZ-BEFORE|直接依赖|间接依赖|应丢弃/);
  const transcript = f.store.readThread("p", one.thread.id).messages;
  const preserved = transcript.find(
    (message) => message.id === transitive.assistantMessageId,
  );
  assert.equal(preserved.text, "间接依赖旧记忆的回答");
  assert.equal(preserved.replyTo, three.message.id);
  assert.equal(preserved.invalidated, true);
  assert.ok(preserved.provenance.messageIds.includes(two.message.id));
  assert.equal(f.store.isMessageUsable(preserved.id), false);
  assert.throws(
    () =>
      f.store.saveMemory({
        requestId: "repeat-old",
        scope: "project",
        bindingId: "p",
        key: "选项",
        value: "ZZ-BEFORE",
        sourceMessageId: one.message.id,
      }),
    { status: 409 },
  );
});

test("manual memory edits remove old values from context and respect the binding", async (t) => {
  const f = await fixture(t);
  const seeded = f.begin("p", "早期的聊天提到了 ALPHA-OLD");
  f.finish(seeded, "已看到 ALPHA-OLD");
  const value = {
    requestId: "new",
    scope: "project",
    bindingId: "p",
    key: "方案",
    value: "ALPHA-OLD",
  };
  const memory = f.store.saveMemory(value);
  f.store.saveMemory({
    requestId: "personal",
    scope: "personal",
    key: "个人习惯",
    value: "SHARED-PREFERENCE",
  });
  const edit = {
    ...value,
    requestId: "edit",
    id: memory.id,
    expectedRevision: memory.revision,
    value: "BETA-NEW",
  };
  assert.throws(() => f.store.saveMemory({ ...edit, bindingId: "other" }), {
    status: 404,
  });
  f.store.saveMemory(edit);
  assert.throws(
    () => f.store.saveMemory({ ...edit, requestId: "stale-edit" }),
    { status: 409 },
  );
  const current = f.begin("p", "继续", seeded.thread.id);
  const here = JSON.stringify(f.context(current).messages);
  assert.doesNotMatch(here, /ALPHA-OLD/);
  assert.match(here, /BETA-NEW|SHARED-PREFERENCE/);
  const other = f.begin("other", "另一个项目");
  const isolated = JSON.stringify(f.context(other).messages);
  assert.doesNotMatch(isolated, /ALPHA-OLD|BETA-NEW/);
  assert.match(isolated, /SHARED-PREFERENCE/);
});

test("forgetting one fact hides the mixed source but keeps another explicitly saved fact", async (t) => {
  const f = await fixture(t);
  const source = f.begin(
    "p",
    "MIXED-ORIGINAL：项目用 OLD-COLOR，回复风格为 CONCISE-STYLE",
  );
  const originalReply = f.finish(source, "已记录这两个事实");
  const first = f.store.saveMemory({
    requestId: "first",
    scope: "project",
    bindingId: "p",
    key: "one",
    value: "OLD-COLOR",
    sourceMessageId: source.message.id,
  });
  f.store.saveMemory({
    requestId: "also",
    scope: "personal",
    bindingId: "p",
    key: "two",
    value: "CONCISE-STYLE",
    sourceMessageId: source.message.id,
  });
  const otherChat = f.begin("other", "接着讨论");
  assert.match(JSON.stringify(f.context(otherChat).messages), /CONCISE-STYLE/);
  const reply = f.finish(otherChat, "这条其他会话的回答用了个人记忆");

  f.store.deleteMemory({
    requestId: "forget",
    id: first.id,
    expectedRevision: first.revision,
    bindingId: "p",
  });
  const next = f.begin("p", "现在继续", source.thread.id);
  const project = JSON.stringify(f.context(next).messages);
  assert.match(project, /CONCISE-STYLE/);
  assert.doesNotMatch(project, /OLD-COLOR|MIXED-ORIGINAL|已记录这两个事实/);
  assert.equal(
    f.store.isMessageUsable(originalReply.assistantMessageId),
    false,
  );
  const elsewhere = f.begin("other", "现在继续", otherChat.thread.id);
  const other = JSON.stringify(f.context(elsewhere).messages);
  assert.match(other, /CONCISE-STYLE/);
  assert.match(other, /用了个人记忆/);
  assert.equal(f.store.isMessageUsable(reply.assistantMessageId), true);
});

test("one active memory key is allowed per scope and binding", async (t) => {
  const f = await fixture(t);
  const project = {
    requestId: "save",
    scope: "project",
    bindingId: "p",
    key: "样式",
    value: "值",
  };
  const first = f.store.saveMemory(project);
  assert.deepEqual(f.store.saveMemory(project), { ...first });
  assert.throws(
    () =>
      f.store.saveMemory({ ...project, requestId: "duplicate", key: " 样式 " }),
    { status: 409 },
  );
  const renamed = f.store.saveMemory({
    ...project,
    requestId: "other",
    key: "另一个键",
  });
  assert.throws(
    () =>
      f.store.saveMemory({
        ...project,
        requestId: "rename-to-duplicate",
        id: renamed.id,
        expectedRevision: renamed.revision,
      }),
    { status: 409 },
  );
  assert.equal(
    f.store.saveMemory({
      ...project,
      requestId: "other-project",
      bindingId: "other",
    }).key,
    "样式",
  );
  const personal = f.store.saveMemory({
    ...project,
    requestId: "personal",
    scope: "personal",
  });
  assert.throws(
    () =>
      f.store.saveMemory({
        ...project,
        requestId: "personal-duplicate",
        scope: "personal",
        bindingId: "other",
      }),
    { status: 409 },
  );
  f.store.deleteMemory({
    requestId: "delete",
    id: first.id,
    expectedRevision: first.revision,
    bindingId: "p",
  });
  assert.notEqual(
    f.store.saveMemory({ ...project, requestId: "explicit-new" }).id,
    first.id,
  );
  assert.equal(
    f.store.listMemories("p").filter((memory) => memory.key === "样式").length,
    2,
  );
  assert.equal(personal.bindingId, null);
});

test("editing a sourced memory without a source detaches the old message", async (t) => {
  const f = await fixture(t);
  const source = f.begin("p", "OLD-PREFERENCE");
  f.finish(source);
  const input = { scope: "personal", bindingId: "p", key: "偏好" };
  const original = f.store.saveMemory({
    ...input,
    requestId: "save",
    value: "OLD-PREFERENCE",
    sourceMessageId: source.message.id,
  });
  const edited = f.store.saveMemory({
    ...input,
    requestId: "edit",
    id: original.id,
    expectedRevision: original.revision,
    value: "NEW-PREFERENCE",
  });
  assert.equal(edited.sourceMessageId, null);
  assert.equal(f.store.isMessageUsable(source.message.id), false);
  const next = f.begin("p", "继续", source.thread.id);
  const context = JSON.stringify(f.context(next).messages);
  assert.match(context, /NEW-PREFERENCE/);
  assert.doesNotMatch(context, /OLD-PREFERENCE/);
});

test("a deletion retires older same-key suggestions even when they never saw the deleted memory", async (t) => {
  const f = await fixture(t);
  const proposal = [
    { scope: "project", key: "配色", value: "候选颜色" },
    { scope: "project", key: "布局", value: "候选布局" },
    { scope: "personal", key: "配色", value: "个人颜色" },
  ];
  const started = f.begin("p", "请提出三条建议");
  const old = f.finish(started, "这是之前的建议", proposal).assistantMessageId;
  const canAdopt = (messageId, scope, key, binding = "p") =>
    f.store.canAdoptMemoryCandidate(binding, messageId, scope, key);
  assert.equal(canAdopt(old, "project", " 配色 "), true);
  assert.equal(canAdopt(old, "project", "配色", "other"), false);
  assert.equal(canAdopt(started.message.id, "project", "配色"), false);
  assert.equal(canAdopt(old, "project", "并未建议"), false);

  const manual = f.store.saveMemory({
    requestId: "manual-save",
    bindingId: "p",
    scope: "project",
    key: "配色",
    value: "人工设置后又删除",
  });
  f.store.deleteMemory({
    requestId: "manual-delete",
    bindingId: "p",
    id: manual.id,
    expectedRevision: manual.revision,
  });
  assert.equal(
    f.store.isMessageUsable(old),
    true,
    "the assistant never saw the later manual entry",
  );
  assert.equal(canAdopt(old, "project", "配色"), false);
  assert.equal(canAdopt(old, "project", "布局"), true);
  assert.equal(canAdopt(old, "personal", "配色"), true);

  const followup = f.begin("p", "重新提出建议", started.thread.id);
  const fresh = f.finish(
    followup,
    "重新生成的建议",
    proposal,
  ).assistantMessageId;
  assert.equal(canAdopt(fresh, "project", "配色"), true);
  assert.ok(
    f.store.saveMemory({
      requestId: "manual-readd",
      bindingId: "p",
      scope: "project",
      key: "配色",
      value: "用户主动重新建立",
    }).id,
  );
});

test("forgetting before a queued request is claimed prevents sending its old input", async (t) => {
  const f = await fixture(t);
  const memory = f.store.saveMemory({
    requestId: "save",
    scope: "personal",
    key: "方案",
    value: "QUEUED-OLD",
  });
  const queued = f.begin("p", "先说 QUEUED-OLD");
  f.store.deleteMemory({
    requestId: "forget",
    id: memory.id,
    expectedRevision: memory.revision,
  });
  assert.equal(f.claim(queued), null);
  assert.equal(f.store.getJob(queued.job.id).status, "stale");
  assert.equal(f.store.listPendingJobs().length, 0);
  assert.throws(() => f.context(queued), { status: 409 });
});

test("context budgets keep the exact input and active memory is capped", async (t) => {
  const f = await fixture(t);
  const first = f.begin("p", "x".repeat(8500));
  f.finish(first, "早期回答");
  const second = f.begin("p", "y".repeat(12000), first.thread.id);
  f.finish(second, "较近回答");
  for (let i = 0; i < 200; i++)
    f.store.saveMemory({
      requestId: `memory-${i}`,
      scope: "personal",
      key: `key-${i}`,
      value: "例".repeat(1000),
    });
  assert.throws(
    () =>
      f.store.saveMemory({
        requestId: "over-limit",
        scope: "personal",
        key: "last",
        value: "多一条",
      }),
    { status: 409 },
  );
  const input = " 当" + "前".repeat(11996) + " ";
  const current = f.begin("p", input, first.thread.id);
  const pack = f.context(current);
  assert.equal(pack.messages.at(-1).content, input);
  assert.ok(
    pack.messages.reduce((sum, m) => sum + m.content.length, 0) <= 44000,
  );
  assert.equal(pack.provenance.memories.length, 12);
  assert.doesNotMatch(pack.messages.map((m) => m.content).join("\n"), /x{100}/);
  assert.match(pack.messages.map((m) => m.content).join("\n"), /y{100}/);
});
