import { check } from "../http";
import { canonicalJson } from "../mcp/room-storage";
import {
  retentionCanActivate,
  retentionHasSecrets,
  normalizeRetention,
  normalizeRetentionValue,
  type RetentionCandidate,
  type RetentionMode,
  type RetentionReport,
} from "../../shared/agent/retention";
import type { ChatMemory, ChatStore } from "./chat-store";
import type { ExecutionPrincipal } from "../execution/execution-auth";

type Candidate = RetentionCandidate & {
  status: "suggested" | "saved" | "merged" | "ignored" | "conflict";
  memoryId?: string;
  memoryRevision?: number;
  fingerprint: string;
};
export type RetentionJob = {
  origin?: { kind: "execution"; principal: ExecutionPrincipal };
  id: string;
  bindingId: string;
  chatId: string;
  sourceJobId: string;
  modelProfileId: string;
  memoryEpoch: number;
  mode: RetentionMode;
  report: RetentionReport;
  users: { id: string; text: string }[];
  status:
    | "queued"
    | "reviewing"
    | "awaiting_commit"
    | "retained"
    | "suggested"
    | "skipped"
    | "failed";
  attempts: number;
  candidates: Candidate[];
  error?: string;
  updatedAt: string;
};
const parse = (row: { value: string } | undefined) =>
  row ? JSON.parse(row.value) : null;
export class RetentionStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_retention_settings(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_retention_jobs(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,task_id TEXT NOT NULL,final_revision INTEGER NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(binding_id,task_id,final_revision));
      CREATE INDEX IF NOT EXISTS agent_retention_pending ON agent_retention_jobs(status);
      CREATE TABLE IF NOT EXISTS agent_retention_suppressed(fingerprint TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS agent_memory_metadata(memory_id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_retention_receipts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,value TEXT NOT NULL);`);
  }
  settings(): { mode: RetentionMode; revision: number } {
    return (
      parse(
        this.sql
          .exec<{ value: string }>(
            "SELECT value FROM agent_retention_settings WHERE id=1",
          )
          .toArray()[0],
      ) || { mode: "auto", revision: 1 }
    );
  }
  updateSettings(mode: RetentionMode, revision: number) {
    const current = this.settings();
    check(current.revision === revision, "沉淀设置已变化，请刷新后重试。", 409);
    const next = { mode, revision: revision + 1 };
    this.sql.exec(
      "INSERT INTO agent_retention_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      JSON.stringify(next),
    );
    if (mode === "off")
      for (const job of this.pending()) {
        job.status = "skipped";
        this.save(job);
      }
    return next;
  }
  get(id: string): RetentionJob | null {
    return parse(
      this.sql
        .exec<{ value: string }>(
          "SELECT value FROM agent_retention_jobs WHERE id=?",
          id,
        )
        .toArray()[0],
    );
  }
  pending() {
    return this.sql
      .exec<{ value: string }>(
        "SELECT value FROM agent_retention_jobs WHERE status IN ('queued','reviewing','awaiting_commit') ORDER BY rowid LIMIT 100",
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as RetentionJob);
  }
  save(job: RetentionJob) {
    job.updatedAt = new Date().toISOString();
    this.sql.exec(
      "UPDATE agent_retention_jobs SET status=?,value=? WHERE id=?",
      job.status,
      JSON.stringify(job),
      job.id,
    );
    return job;
  }
  enqueue(
    input: Omit<
      RetentionJob,
      "id" | "status" | "attempts" | "candidates" | "updatedAt" | "mode"
    >,
  ) {
    const prior = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM agent_retention_jobs WHERE binding_id=? AND task_id=? AND final_revision=?",
        input.bindingId,
        input.report.taskId,
        input.report.finalRevision,
      )
      .toArray()[0];
    if (prior) return JSON.parse(prior.value) as RetentionJob;
    const mode = this.settings().mode;
    const job: RetentionJob = {
      ...input,
      id: crypto.randomUUID(),
      status: mode === "off" ? "skipped" : "queued",
      mode,
      attempts: 0,
      candidates: [],
      updatedAt: new Date().toISOString(),
    };
    this.sql.exec(
      "INSERT INTO agent_retention_jobs VALUES(?,?,?,?,?,?)",
      job.id,
      job.bindingId,
      job.report.taskId,
      job.report.finalRevision,
      job.status,
      JSON.stringify(job),
    );
    return job;
  }
  decorate(memories: ChatMemory[]) {
    return memories.map((memory) => {
      const retention = parse(
        this.sql
          .exec<{ value: string }>(
            "SELECT value FROM agent_memory_metadata WHERE memory_id=?",
            memory.id,
          )
          .toArray()[0],
      );
      return retention ? { ...memory, retention } : memory;
    });
  }
  view(bindingId?: string, chatId?: string) {
    const rows = bindingId
      ? this.sql
          .exec<{ value: string }>(
            "SELECT value FROM agent_retention_jobs WHERE binding_id=? ORDER BY rowid DESC LIMIT 30",
            bindingId,
          )
          .toArray()
      : [];
    return {
      settings: this.settings(),
      jobs: rows
        .map((row) => JSON.parse(row.value) as RetentionJob)
        .filter((job) => !chatId || !job.chatId || job.chatId === chatId)
        .map((job) => ({
          id: job.id,
          taskId: job.report.taskId,
          sourceJobId: job.sourceJobId,
          status: job.status,
          goal: job.report.goal,
          updatedAt: job.updatedAt,
          error: job.error,
          candidates: job.candidates.map(({ fingerprint, ...candidate }) => {
            const memory = candidate.memoryId
              ? this.sql
                  .exec<{ status: string; revision: number }>(
                    "SELECT status,revision FROM agent_chat_memories WHERE id=?",
                    candidate.memoryId,
                  )
                  .toArray()[0]
              : null;
            const status = ["saved", "merged"].includes(candidate.status)
              ? !memory || memory.status !== "active"
                ? "deleted"
                : memory.revision !== candidate.memoryRevision
                  ? "changed"
                  : candidate.status
              : candidate.status;
            return {
              ...candidate,
              status,
              evidence: job.report.evidence
                .filter((e) => candidate.evidenceRefs.includes(e.id))
                .map(({ text, ...e }) => e),
            };
          }),
        })),
    };
  }
  private fingerprint(
    bindingId: string,
    c: Pick<RetentionCandidate, "scope" | "key" | "value">,
  ) {
    return canonicalJson([
      c.scope === "project" ? bindingId : "personal",
      normalizeRetention(c.key),
      normalizeRetentionValue(c.value),
    ]);
  }
  suppress(memory: ChatMemory) {
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_retention_suppressed VALUES(?)",
      this.fingerprint(memory.bindingId || "", memory),
    );
    const metadata = parse(
      this.sql
        .exec<{ value: string }>(
          "SELECT value FROM agent_memory_metadata WHERE memory_id=?",
          memory.id,
        )
        .toArray()[0],
    );
    if (metadata?.fingerprint)
      this.sql.exec(
        "INSERT OR IGNORE INTO agent_retention_suppressed VALUES(?)",
        metadata.fingerprint,
      );
  }
  private suppressed(fingerprint: string) {
    return (
      this.sql
        .exec(
          "SELECT fingerprint FROM agent_retention_suppressed WHERE fingerprint=?",
          fingerprint,
        )
        .toArray().length > 0
    );
  }
  prepare(
    job: RetentionJob,
    candidates: RetentionCandidate[],
    store: ChatStore,
  ) {
    const unique = new Set<string>();
    job.candidates = candidates.flatMap((candidate) => {
      const fingerprint = this.fingerprint(job.bindingId, candidate);
      if (
        unique.has(fingerprint) ||
        this.suppressed(fingerprint) ||
        retentionHasSecrets(JSON.stringify(candidate))
      )
        return [];
      unique.add(fingerprint);
      const memories = store.listMemories(job.bindingId);
      const same = memories.find(
        (m) =>
          m.scope === candidate.scope &&
          normalizeRetention(m.key) === normalizeRetention(candidate.key),
      );
      return [
        {
          ...candidate,
          fingerprint,
          status:
            same &&
            normalizeRetentionValue(same.value) !==
              normalizeRetentionValue(candidate.value)
              ? ("conflict" as const)
              : ("suggested" as const),
        },
      ];
    });
    job.status = job.candidates.length ? "awaiting_commit" : "skipped";
    return this.save(job);
  }
  commit(job: RetentionJob, store: ChatStore) {
    if (this.settings().mode === "off") {
      job.status = "skipped";
      return this.save(job);
    }
    for (const [i, candidate] of job.candidates.entries()) {
      if (candidate.status !== "suggested") continue;
      const same = store
        .listMemories(job.bindingId)
        .find(
          (m) =>
            m.scope === candidate.scope &&
            normalizeRetention(m.key) === normalizeRetention(candidate.key),
        );
      if (same) {
        candidate.status =
          normalizeRetentionValue(same.value) ===
          normalizeRetentionValue(candidate.value)
            ? "merged"
            : "conflict";
        candidate.memoryId = same.id;
        candidate.memoryRevision = same.revision;
      } else if (
        job.mode === "auto" &&
        this.settings().mode === "auto" &&
        retentionCanActivate(candidate, job.report, job.users)
      )
        this.adopt(job, i, store);
    }
    job.status = job.candidates.some((c) =>
      ["suggested", "conflict"].includes(c.status),
    )
      ? "suggested"
      : job.candidates.some((c) => c.status === "saved")
        ? "retained"
        : "skipped";
    return this.save(job);
  }
  adopt(
    job: RetentionJob,
    index: number,
    store: ChatStore,
    edited?: {
      scope: "personal" | "project";
      key: string;
      value: string;
      expectedMemoryId?: string;
      expectedRevision?: number;
    },
  ) {
    const candidate = job.candidates[index];
    check(
      candidate && !["ignored", "saved", "merged"].includes(candidate.status),
      "这条沉淀建议已处理。",
      409,
    );
    const value = { ...candidate, ...edited };
    check(!retentionHasSecrets(value.value), "请移除凭据后再保存。", 400);
    const same = store
      .listMemories(job.bindingId)
      .find(
        (m) =>
          m.scope === value.scope &&
          normalizeRetention(m.key) === normalizeRetention(value.key),
      );
    check(
      !same ||
        (edited?.expectedMemoryId === same.id &&
          edited.expectedRevision === same.revision),
      "已有同名内容，请先查看差异再编辑原条目。",
      409,
    );
    const memory = store.saveMemory({
      requestId: `retention:${job.id}:${index}`,
      ...(same ? { id: same.id, expectedRevision: same.revision } : {}),
      scope: value.scope,
      ...(value.scope === "project" ? { bindingId: job.bindingId } : {}),
      key: value.key,
      value: value.value,
    });
    Object.assign(candidate, {
      scope: value.scope,
      key: value.key,
      value: value.value,
      status: "saved",
      memoryId: memory.id,
      memoryRevision: memory.revision,
    });
    this.sql.exec(
      "INSERT INTO agent_memory_metadata VALUES(?,?) ON CONFLICT(memory_id) DO UPDATE SET value=excluded.value",
      memory.id,
      JSON.stringify({
        jobId: job.id,
        fingerprint: candidate.fingerprint,
        sourceTaskId: job.report.taskId,
        kind: candidate.kind,
        whenApplicable: candidate.whenApplicable,
        evidence: job.report.evidence
          .filter((e) => candidate.evidenceRefs.includes(e.id))
          .map(({ text, ...e }) => e),
      }),
    );
    this.save(job);
    return memory;
  }
  dismiss(job: RetentionJob, index: number, store: ChatStore, undo = false) {
    const candidate = job.candidates[index];
    check(candidate, "沉淀记录不存在。", 404);
    if (undo) {
      check(
        candidate.status === "saved" && candidate.memoryId,
        "这条记录不能撤销。",
        409,
      );
      store.deleteMemory({
        requestId: `retention-undo:${job.id}:${index}`,
        id: candidate.memoryId,
        expectedRevision: candidate.memoryRevision!,
        ...(candidate.scope === "project" ? { bindingId: job.bindingId } : {}),
      });
    } else
      check(
        ["suggested", "conflict", "ignored"].includes(candidate.status),
        "已保存的记录请使用撤销。",
        409,
      );
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_retention_suppressed VALUES(?)",
      candidate.fingerprint,
    );
    candidate.status = "ignored";
    return this.save(job);
  }
  receipt<T>(id: string, payload: unknown, work: () => T): T {
    const key = canonicalJson(payload);
    const old = this.sql
      .exec<{ payload: string; value: string }>(
        "SELECT payload,value FROM agent_retention_receipts WHERE id=?",
        id,
      )
      .toArray()[0];
    if (old) {
      check(old.payload === key, "沉淀请求编号已用于不同操作。", 409);
      return JSON.parse(old.value);
    }
    const result = work();
    this.sql.exec(
      "INSERT INTO agent_retention_receipts VALUES(?,?,?)",
      id,
      key,
      JSON.stringify(result),
    );
    return result;
  }
}
