import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const scopeKey = (scope) =>
  digest([scope.accountId, scope.bindingId, scope.chatId]);
const statuses = new Set([
  "running",
  "waiting_user",
  "waiting_auth",
  "waiting_external",
  "paused_budget",
  "interrupted",
  "completed",
  "cancelled",
]);

export class TaskStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "task-harness.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_scope ON tasks(scope,updated);
      CREATE TABLE IF NOT EXISTS task_events(sequence INTEGER PRIMARY KEY, task TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_leases(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_effects(task TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(task,key));
      CREATE TABLE IF NOT EXISTS task_capabilities(scope TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,name));`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS task_retention_outbox(task TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    for (const row of this.db
      .prepare("SELECT scope,pid FROM task_leases")
      .all()) {
      try {
        process.kill(row.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH")
          this.db
            .prepare("DELETE FROM task_leases WHERE scope=? AND pid=?")
            .run(row.scope, row.pid);
      }
    }
  }
  claim(scope, owner, now = Date.now()) {
    const key = scopeKey(scope);
    const result = this.db
      .prepare(
        `INSERT INTO task_leases VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
      owner=excluded.owner,pid=excluded.pid,expires=excluded.expires WHERE task_leases.expires<? OR task_leases.owner=?`,
      )
      .run(key, owner, process.pid, now + 600000, now, owner);
    if (!result.changes)
      throw Error("这段对话已有任务正在运行，请等待或停止后再继续。");
  }
  assertLease(scope, owner) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM task_leases WHERE scope=? AND owner=? AND expires>?",
        )
        .get(scopeKey(scope), owner, Date.now())
    )
      throw Error("任务运行租约已失效，旧执行已停止。");
  }
  release(scope, owner) {
    this.db
      .prepare("DELETE FROM task_leases WHERE scope=? AND owner=?")
      .run(scopeKey(scope), owner);
  }
  visible(scope, state) {
    const visible = new Set([
      ...(scope.authorizedMessages || scope.visible || []),
      scope.userMessageId,
    ]);
    return (
      state.memoryEpoch === scope.memoryEpoch &&
      (scope.projectSource === undefined ||
        (state.projectSourceDigest ??
          digest(state.resume?.scope?.projectSource ?? null)) ===
          digest(scope.projectSource)) &&
      state.messageIds.every((id) => visible.has(id))
    );
  }
  latest(scope, resumable = false) {
    for (const row of this.db
      .prepare(
        "SELECT state FROM tasks WHERE scope=? ORDER BY updated DESC,rowid DESC LIMIT 30",
      )
      .all(scopeKey(scope))) {
      const state = JSON.parse(row.state);
      if (
        this.visible(scope, state) &&
        (!resumable || !["completed", "cancelled"].includes(state.status))
      )
        return state;
    }
    return null;
  }
  get(id) {
    const row = this.db.prepare("SELECT state FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(row.state) : null;
  }
  waiting() {
    return this.db
      .prepare(
        "SELECT state FROM tasks WHERE json_extract(state,'$.status')='waiting_external'",
      )
      .all()
      .map((row) => JSON.parse(row.state));
  }
  create(scope, owner, goal, limits) {
    this.assertLease(scope, owner);
    const state = {
      id: randomUUID(),
      revision: 0,
      goal,
      originalGoal: goal,
      status: "running",
      memoryEpoch: scope.memoryEpoch,
      projectSourceDigest: digest(scope.projectSource ?? null),
      messageIds: [scope.userMessageId],
      requirements: [],
      steps: [],
      gaps: [],
      evidence: [],
      questions: [],
      transcript: [],
      progress: "正在梳理任务",
      budget: { requests: 0, tokens: 0, ...limits },
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?)")
      .run(state.id, scopeKey(scope), 0, JSON.stringify(state), Date.now());
    return state;
  }
  save(scope, owner, state, kind) {
    this.assertLease(scope, owner);
    if (!statuses.has(state.status)) throw Error("无效的任务状态。");
    const next = {
      ...state,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      ...(state.status === "completed" && !state.completedRevision
        ? { completedRevision: state.revision + 1 }
        : {}),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE tasks SET state=?,revision=?,updated=? WHERE id=? AND scope=? AND revision=?",
        )
        .run(
          JSON.stringify(next),
          next.revision,
          next.updatedAt,
          state.id,
          scopeKey(scope),
          state.revision,
        );
      if (!result.changes) throw Error("任务状态已变化，请重新读取后继续。");
      this.db
        .prepare(
          "INSERT INTO task_events(task,revision,kind,at) VALUES(?,?,?,?)",
        )
        .run(state.id, next.revision, kind, next.updatedAt);
      this.db.exec("COMMIT");
      Object.assign(state, next);
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  effect(task, key) {
    const row = this.db
      .prepare("SELECT state FROM task_effects WHERE task=? AND key=?")
      .get(task, key);
    return row ? JSON.parse(row.state) : null;
  }
  putEffect(scope, owner, task, key, state) {
    this.assertLease(scope, owner);
    this.db
      .prepare(
        "INSERT INTO task_effects VALUES(?,?,?) ON CONFLICT(task,key) DO UPDATE SET state=excluded.state",
      )
      .run(task, key, JSON.stringify(state));
  }
  close() {
    this.db.close();
  }
  queueRetention(report) {
    this.db
      .prepare("INSERT OR IGNORE INTO task_retention_outbox VALUES(?,?)")
      .run(report.taskId, JSON.stringify(report));
  }
  pendingRetentions() {
    return this.db
      .prepare(
        "SELECT value FROM task_retention_outbox ORDER BY rowid LIMIT 10",
      )
      .all()
      .map((row) => JSON.parse(row.value));
  }
  acknowledgeRetention(taskId) {
    this.db
      .prepare("DELETE FROM task_retention_outbox WHERE task=?")
      .run(taskId);
  }
  hasResumableContext(memoryEpoch) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE json_extract(state,'$.status') NOT IN ('completed','cancelled') AND json_extract(state,'$.memoryEpoch')=? LIMIT 1",
      )
      .get(memoryEpoch);
  }
  recipes(scope) {
    const visible = new Set([...(scope.visible || []), scope.userMessageId]);
    return this.db
      .prepare("SELECT value FROM task_capabilities WHERE scope=?")
      .all(scopeKey(scope))
      .map((row) => JSON.parse(row.value))
      .filter((recipe) => visible.has(recipe.sourceMessageId));
  }
  putRecipe(scope, owner, recipe) {
    this.assertLease(scope, owner);
    const old = this.db
      .prepare("SELECT value FROM task_capabilities WHERE scope=? AND name=?")
      .get(scopeKey(scope), recipe.name);
    if (old && JSON.parse(old.value).version !== recipe.version)
      throw Error("同名能力已存在，请用新名称保存不同的组合。");
    this.db
      .prepare(
        "INSERT INTO task_capabilities VALUES(?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value",
      )
      .run(scopeKey(scope), recipe.name, JSON.stringify(recipe));
  }
}
