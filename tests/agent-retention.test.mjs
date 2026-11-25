import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { completedTaskReport } from "../runner/harness/retention.mjs";
const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './worker/agent/retention-store'; export * from './worker/agent/chat-store'; export * from './shared/agent/retention';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const report = () => ({
  taskId: "task-1",
  jobId: "job-1",
  finalRevision: 5,
  status: "completed",
  goal: "修复连接",
  summary: "修复并验证",
  messageIds: ["u1"],
  verifiedEvidenceIds: ["ev1"],
  evidence: [
    {
      id: "ev1",
      label: "connection.check",
      kind: "tool",
      ok: true,
      text: "查询接口返回连接已恢复",
    },
  ],
});
const method = (overrides = {}) => ({
  kind: "method",
  scope: "project",
  key: "核验实时连接",
  value: "先查询实时连接与工具注册，再依据回执定位问题。",
  whenApplicable: "历史摘要称工具不可用时",
  basis: "verified_result",
  evidenceRefs: ["ev1"],
  ...overrides,
});
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...args) {
      if (/^\s*CREATE TABLE/i.test(query)) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)\b/i.test(query)
        ? statement.all(...args)
        : (statement.run(...args), []);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
      };
    },
  };
  const store = new api.ChatStore(sql),
    retention = new api.RetentionStore(sql);
  const enqueue = (overrides = {}) =>
    retention.enqueue({
      bindingId: "project-1",
      chatId: "chat-1",
      sourceJobId: "job-1",
      modelProfileId: "existing",
      memoryEpoch: store.getMemoryEpoch(),
      report: report(),
      users: [{ id: "u1", text: "请修复连接" }],
      ...overrides,
    });
  const transaction = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { db, sql, store, retention, enqueue, transaction };
}
test("one completed task produces one durable review across reopening", (t) => {
  const f = fixture(t),
    first = f.enqueue();
  const reopened = new api.RetentionStore(f.sql);
  assert.equal(reopened.enqueue({ ...first, report: report() }).id, first.id);
  assert.equal(reopened.pending().length, 1);
  const other = f.enqueue({ bindingId: "another-project" });
  assert.notEqual(other.id, first.id);
});
test("only actual accepted tool evidence can activate an operation method", (t) => {
  const { store, retention, enqueue, transaction } = fixture(t),
    job = enqueue();
  retention.prepare(
    job,
    [method(), method({ key: "猜测", evidenceRefs: ["made-up"] })],
    store,
  );
  transaction(() => retention.commit(job, store));
  const memories = retention.decorate(store.listMemories("project-1"));
  assert.equal(memories.length, 1);
  assert.equal(memories[0].retention.kind, "method");
  assert.equal(job.candidates[1].status, "suggested");
});
test("global preferences need an explicit cross-project user statement", () => {
  const candidate = method({
    kind: "preference",
    scope: "personal",
    basis: "explicit_user",
    evidenceRefs: [],
    userMessageId: "u1",
    userQuote: "以后所有项目都用中文回复。",
  });
  assert.equal(
    api.retentionCanActivate(candidate, report(), [
      { id: "u1", text: candidate.userQuote },
    ]),
    true,
  );
  assert.equal(
    api.retentionCanActivate(candidate, report(), [
      { id: "u1", text: "> " + candidate.userQuote },
    ]),
    false,
  );
  assert.equal(
    api.retentionCanActivate(
      { ...candidate, userQuote: "以后这个项目用中文回复。" },
      report(),
      [{ id: "u1", text: "以后这个项目用中文回复。" }],
    ),
    false,
  );
});
test("duplicate content is merged; a conflicting rule never overwrites memory", (t) => {
  const { store, retention, enqueue, transaction } = fixture(t),
    job = enqueue();
  const existing = store.saveMemory({
    requestId: "seed",
    scope: "project",
    bindingId: "project-1",
    key: method().key,
    value: method().value,
  });
  retention.prepare(job, [method()], store);
  transaction(() => retention.commit(job, store));
  assert.equal(job.candidates[0].status, "merged");
  const conflict = enqueue({ report: { ...report(), taskId: "task-2" } });
  retention.prepare(conflict, [method({ value: "直接相信旧摘要" })], store);
  transaction(() => retention.commit(conflict, store));
  assert.equal(conflict.candidates[0].status, "conflict");
  assert.equal(store.listMemories("project-1")[0].revision, existing.revision);
});
test("undo suppresses old evidence and request replay does not delete twice", (t) => {
  const { store, retention, enqueue, transaction } = fixture(t),
    job = enqueue();
  retention.prepare(job, [method()], store);
  transaction(() => retention.commit(job, store));
  const undo = () =>
    transaction(() =>
      retention.receipt("undo-1", { job: job.id, index: 0 }, () =>
        retention.dismiss(job, 0, store, true),
      ),
    );
  undo();
  const epoch = store.getMemoryEpoch();
  undo();
  assert.equal(store.getMemoryEpoch(), epoch);
  assert.equal(store.listMemories("project-1").length, 0);
  const replay = enqueue({ report: { ...report(), taskId: "task-2" } });
  retention.prepare(replay, [method()], store);
  assert.equal(replay.status, "skipped");
});
test("suggest-only never activates a method and off cancels queued reviews", (t) => {
  const { store, retention, enqueue, transaction } = fixture(t);
  retention.updateSettings("suggest", 1);
  const job = enqueue();
  retention.prepare(job, [method()], store);
  transaction(() => retention.commit(job, store));
  assert.equal(store.listMemories("project-1").length, 0);
  const pending = enqueue({ report: { ...report(), taskId: "task-2" } });
  retention.updateSettings("off", 2);
  assert.equal(retention.get(pending.id).status, "skipped");
  assert.throws(() => retention.updateSettings("auto", 2), /已变化/);
});

test("editing and deleting retained memory suppresses both original and edited content", (t) => {
  const { store, retention, enqueue, transaction } = fixture(t),
    job = enqueue();
  retention.prepare(job, [method()], store);
  transaction(() => retention.commit(job, store));
  const original = store.listMemories("project-1")[0];
  const edited = store.saveMemory({
    requestId: "edit",
    id: original.id,
    expectedRevision: original.revision,
    scope: "project",
    bindingId: "project-1",
    key: original.key,
    value: "只检查当前项目的连接状态。",
  });
  assert.equal(
    retention.view("project-1", "chat-1").jobs[0].candidates[0].status,
    "changed",
  );
  transaction(() => {
    retention.suppress(edited);
    store.deleteMemory({
      requestId: "delete",
      id: edited.id,
      expectedRevision: edited.revision,
      bindingId: "project-1",
    });
  });
  assert.equal(
    retention.view("project-1", "chat-1").jobs[0].candidates[0].status,
    "deleted",
  );
  const next = enqueue({ report: { ...report(), taskId: "task-2" } });
  retention.prepare(next, [method(), method({ value: edited.value })], store);
  assert.equal(next.candidates.length, 0);
});
test("retention prompt has a bounded input and receipts exclude credentials", () => {
  const r = report();
  r.goal = "目标".repeat(4000);
  r.summary = "结果".repeat(4000);
  r.evidence = Array.from({ length: 32 }, (_, i) => ({
    ...r.evidence[0],
    id: "ev" + i,
    text: "结果".repeat(1500),
  }));
  const context = api.retentionContext(
    r,
    Array.from({ length: 64 }, (_, i) => ({
      id: "u" + i,
      text: "用户".repeat(6000),
    })),
    Array.from({ length: 200 }, (_, i) => ({
      id: "m" + i,
      scope: "project",
      key: "名称".repeat(50),
      value: "内容".repeat(500),
    })),
  );
  assert.ok(JSON.stringify(context).length <= 24000);
  const task = {
    id: "t",
    status: "completed",
    completedRevision: 4,
    revision: 8,
    verification: { accepted: true, checks: [{ evidenceIds: ["ev"] }] },
    goal: "验证连接",
    messageIds: ["u"],
    evidence: [
      {
        id: "ev",
        label: "test",
        kind: "tool",
        ok: true,
        result: { token: "do-not-copy", text: "ready" },
      },
    ],
  };
  const value = completedTaskReport(task, "job");
  assert.equal(value.finalRevision, 4);
  assert.doesNotMatch(JSON.stringify(value), /do-not-copy/);
  assert.equal(
    completedTaskReport({ ...task, status: "interrupted" }, "job"),
    null,
  );
  assert.equal(
    completedTaskReport({ ...task, verification: { accepted: false } }, "job"),
    null,
  );
});
test("JSON and natural-language credentials are excluded while harmless security preferences stay usable", () => {
  for (const text of [
    '{"token":"a-sensitive-value"}',
    "以后密码是secret-value",
    "password is secret-value",
    "https://example.com/file?sig=private-signature",
  ])
    assert.equal(api.retentionHasSecrets(text), true, text);
  assert.equal(
    api.retentionHasSecrets(
      JSON.stringify({ text: '{"api_key":"private-value"}' }),
    ),
    true,
  );
  assert.equal(api.retentionHasSecrets("不要把密码写到日志里。"), false);
});
