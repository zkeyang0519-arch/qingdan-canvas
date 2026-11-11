import { check } from "../http";
import { canonicalJson } from "../mcp/room-storage";
import { CHAT_INPUT_LIMIT, type AgentReply } from "../../shared/agent/chat";
export type { AgentReply } from "../../shared/agent/chat";
export type ChatThread = {
  id: string;
  bindingId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
export type ChatMessage = {
  id: string;
  bindingId: string;
  chatId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  tasks: AgentReply["tasks"];
  memories: AgentReply["memories"];
  replyTo: string | null;
  provenance: ChatProvenance;
  invalidated: boolean;
};
export type ChatProvenance = {
  messageIds: string[];
  memories: { id: string; revision: number }[];
  project?: {
    bindingRevision: number;
    summaryRevision: number;
    sourceRunId: string;
    stale: boolean;
  };
};
export type ChatJob = {
  id: string;
  bindingId: string;
  chatId: string;
  userMessageId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "stale";
  revision: number;
  memoryEpoch: number;
  leaseUntil: number | null;
  assistantMessageId: string | null;
  error: string | null;
};
export type ChatMemory = {
  id: string;
  bindingId: string | null;
  scope: "personal" | "project";
  key: string;
  value: string;
  sourceMessageId: string | null;
  revision: number;
  status: "active" | "deleted";
  updatedAt: string;
};
type RequestIdentity = { requestId: string; bindingId: string };
type SaveMemory = Omit<
  ChatMemory,
  "id" | "bindingId" | "revision" | "status" | "updatedAt" | "sourceMessageId"
> & {
  requestId: string;
  id?: string;
  expectedRevision?: number;
  bindingId?: string;
  sourceMessageId?: string;
};
type DeleteMemory = {
  requestId: string;
  id: string;
  expectedRevision: number;
  bindingId?: string;
};
const visible = `WITH RECURSIVE hidden(id) AS (
  SELECT t.id FROM agent_chat_tombstones t JOIN agent_chat_messages m ON m.id=t.id
    WHERE t.kind='message' AND m.chat_id=?1
  UNION
  SELECT m.id FROM agent_chat_messages m, json_each(m.provenance,'$.memories') p
    JOIN agent_chat_tombstones t ON t.kind='memory' AND t.id=json_extract(p.value,'$.id') AND t.revision=json_extract(p.value,'$.revision')
    WHERE m.chat_id=?1
  UNION
  SELECT m.id FROM agent_chat_messages m, json_each(m.provenance,'$.messageIds') p
    JOIN hidden h ON h.id=p.value WHERE m.chat_id=?1
)`;
const sqlThread =
  "id,binding_id AS bindingId,title,created_at AS createdAt,updated_at AS updatedAt";
const sqlJob =
  "id,binding_id AS bindingId,chat_id AS chatId,user_message_id AS userMessageId,status,revision,memory_epoch AS memoryEpoch,lease_until AS leaseUntil,assistant_message_id AS assistantMessageId,error";
const sqlMessage =
  "id,binding_id AS bindingId,chat_id AS chatId,sequence,role,text,created_at AS createdAt,tasks,memories,reply_to AS replyTo,provenance";
const sqlMemory =
  "id,binding_id AS bindingId,scope,key,value,source_message_id AS sourceMessageId,revision,status,updated_at AS updatedAt";
type MessageRow = Omit<
  ChatMessage,
  "tasks" | "memories" | "provenance" | "invalidated"
> & {
  tasks: string;
  memories: string;
  provenance: string;
  invalidated?: number;
};
const message = (row: MessageRow): ChatMessage => ({
  ...row,
  tasks: JSON.parse(row.tasks),
  memories: JSON.parse(row.memories),
  provenance: JSON.parse(row.provenance),
  invalidated: !!row.invalidated,
});

// The owning account DO supplies transactionSync around each mutation, and
// around claim+context. A provider call never holds a SQLite transaction open.
export class ChatStore {
  constructor(
    private sql: SqlStorage,
    private now = () => new Date().toISOString(),
  ) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_chat_threads(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_chat_thread_binding ON agent_chat_threads(binding_id,updated_at);
    CREATE TABLE IF NOT EXISTS agent_chat_messages(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,chat_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      role TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,tasks TEXT NOT NULL,memories TEXT NOT NULL,
      provenance TEXT NOT NULL,reply_to TEXT,UNIQUE(chat_id,sequence));
    CREATE TABLE IF NOT EXISTS agent_chat_jobs(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_message_id TEXT NOT NULL,
      status TEXT NOT NULL,revision INTEGER NOT NULL,memory_epoch INTEGER NOT NULL,lease_until INTEGER,
      assistant_message_id TEXT,error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_chat_one_active_job ON agent_chat_jobs(chat_id) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS agent_chat_job_thread ON agent_chat_jobs(chat_id);
    CREATE INDEX IF NOT EXISTS agent_chat_job_assistant ON agent_chat_jobs(assistant_message_id) WHERE assistant_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_chat_memories(
      id TEXT PRIMARY KEY,binding_id TEXT,scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,
      source_message_id TEXT,revision INTEGER NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_chat_deleted_key ON agent_chat_memories(scope,binding_id,key,epoch) WHERE status='deleted';
    CREATE TABLE IF NOT EXISTS agent_chat_tombstones(
      kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(kind,id,revision));
    CREATE TABLE IF NOT EXISTS agent_chat_receipts(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL,value TEXT NOT NULL);`);
  }
  private receipt<T>(requestId: string, payload: unknown): T | null {
    const stored = this.sql
      .exec<{ payload: string; value: string }>(
        "SELECT payload,value FROM agent_chat_receipts WHERE request_id=?",
        requestId,
      )
      .toArray()[0];
    if (!stored) return null;
    check(
      stored.payload === canonicalJson(payload),
      "请求编号已用于不同内容。",
      409,
    );
    return JSON.parse(stored.value) as T;
  }
  private rememberReceipt(requestId: string, payload: unknown, value: unknown) {
    this.sql.exec(
      "INSERT INTO agent_chat_receipts VALUES(?,?,?)",
      requestId,
      canonicalJson(payload),
      JSON.stringify(value),
    );
  }
  private thread(bindingId: string, chatId: string) {
    const row = this.sql
      .exec<ChatThread>(
        `SELECT ${sqlThread} FROM agent_chat_threads WHERE binding_id=? AND id=?`,
        bindingId,
        chatId,
      )
      .toArray()[0];
    check(row, "当前项目中找不到该聊天。", 404);
    return row;
  }
  private makeThread(bindingId: string, title: string) {
    const now = this.now();
    const row: ChatThread = {
      id: crypto.randomUUID(),
      bindingId,
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.sql.exec(
      "INSERT INTO agent_chat_threads VALUES(?,?,?,?,?)",
      row.id,
      bindingId,
      title,
      now,
      now,
    );
    return row;
  }
  createThread({ requestId, bindingId }: RequestIdentity) {
    const payload = { action: "createThread", bindingId };
    const prior = this.receipt<ChatThread>(requestId, payload);
    if (prior) return prior;
    const thread = this.makeThread(bindingId, "新聊天");
    this.rememberReceipt(requestId, payload, thread);
    return thread;
  }
  listThreads(bindingId: string) {
    return this.sql
      .exec<ChatThread>(
        `SELECT ${sqlThread} FROM agent_chat_threads WHERE binding_id=? ORDER BY updated_at DESC,rowid DESC`,
        bindingId,
      )
      .toArray();
  }
  readThread(
    bindingId: string,
    chatId: string,
    options?: { beforeSequence?: number; limit?: number },
  ) {
    const thread = this.thread(bindingId, chatId);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    const recent = this.sql
      .exec<MessageRow>(
        `${visible} SELECT ${sqlMessage}, id IN (SELECT id FROM hidden) AS invalidated
      FROM agent_chat_messages WHERE chat_id=?1 AND sequence<?2 ORDER BY sequence DESC LIMIT ?3`,
        chatId,
        options?.beforeSequence ?? Number.MAX_SAFE_INTEGER,
        limit + 1,
      )
      .toArray();
    const messages = recent.slice(0, limit).reverse().map(message);
    const job =
      this.sql
        .exec<ChatJob>(
          `SELECT ${sqlJob} FROM agent_chat_jobs WHERE chat_id=? ORDER BY rowid DESC LIMIT 1`,
          chatId,
        )
        .toArray()[0] ?? null;
    return {
      thread,
      messages,
      job,
      ...(recent.length > limit
        ? { beforeSequence: messages[0].sequence }
        : {}),
    };
  }
  private messageRow(id: string) {
    return this.sql
      .exec<MessageRow>(
        `SELECT ${sqlMessage} FROM agent_chat_messages WHERE id=?`,
        id,
      )
      .toArray()[0];
  }
  readMessage(bindingId: string, chatId: string, id: string) {
    const row = this.messageRow(id);
    return row?.bindingId === bindingId && row.chatId === chatId
      ? { ...message(row), invalidated: !this.isMessageUsable(id) }
      : null;
  }
  isMessageUsable(messageId: string) {
    const row = this.messageRow(messageId);
    return !!row && !!this.contextMessage(row.bindingId, row.chatId, messageId);
  }
  canAdoptMemoryCandidate(
    bindingId: string,
    assistantMessageId: string,
    scope: ChatMemory["scope"],
    key: string,
  ): boolean {
    const row = this.messageRow(assistantMessageId);
    if (row?.bindingId !== bindingId || row.role !== "assistant") return false;
    const normalizedKey = key.trim();
    const usable = this.contextMessage(
      bindingId,
      row.chatId,
      assistantMessageId,
    );
    if (
      !usable?.memories.some(
        (item) => item.scope === scope && item.key.trim() === normalizedKey,
      )
    )
      return false;
    return !!this.sql
      .exec(
        `SELECT 1 FROM agent_chat_jobs j
       WHERE j.assistant_message_id=? AND j.binding_id=? AND j.status='succeeded'
       AND NOT EXISTS (SELECT 1 FROM agent_chat_memories m
         WHERE m.status='deleted' AND m.scope=? AND m.binding_id IS ? AND m.key=? AND m.epoch>j.memory_epoch)
       LIMIT 1`,
        assistantMessageId,
        bindingId,
        scope,
        scope === "personal" ? null : bindingId,
        normalizedKey,
      )
      .toArray()[0];
  }
  private appendMessage(
    thread: ChatThread,
    role: ChatMessage["role"],
    text: string,
    reply?: AgentReply,
    provenance: ChatProvenance = { messageIds: [], memories: [] },
    replyTo: string | null = null,
  ) {
    const sequence = this.sql
      .exec<{ next: number }>(
        "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_chat_messages WHERE chat_id=?",
        thread.id,
      )
      .toArray()[0].next;
    const id = crypto.randomUUID(),
      now = this.now();
    const tasks = reply?.tasks ?? [],
      memories = reply?.memories ?? [];
    this.sql.exec(
      "INSERT INTO agent_chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      thread.bindingId,
      thread.id,
      sequence,
      role,
      text,
      now,
      JSON.stringify(tasks),
      JSON.stringify(memories),
      JSON.stringify(provenance),
      replyTo,
    );
    this.sql.exec(
      "UPDATE agent_chat_threads SET updated_at=? WHERE id=?",
      now,
      thread.id,
    );
    return {
      id,
      bindingId: thread.bindingId,
      chatId: thread.id,
      sequence,
      role,
      text,
      createdAt: now,
      tasks,
      memories,
      provenance,
      replyTo,
      invalidated: false,
    } satisfies ChatMessage;
  }
  beginMessage({
    requestId,
    bindingId,
    chatId,
    text,
    project,
  }: RequestIdentity & {
    chatId?: string;
    text: string;
    project?: ChatProvenance["project"];
  }) {
    check(
      typeof text === "string" &&
        text.trim().length &&
        text.length <= CHAT_INPUT_LIMIT,
      `聊天消息不能为空或超过 ${CHAT_INPUT_LIMIT} 字符。`,
    );
    const payload = {
      action: "beginMessage",
      bindingId,
      chatId: chatId ?? null,
      text,
    };
    const old = this.receipt<{ jobId: string }>(requestId, payload);
    if (old) {
      const job = this.getJob(old.jobId)!;
      return {
        thread: this.thread(bindingId, job.chatId),
        message: this.readMessage(bindingId, job.chatId, job.userMessageId)!,
        job,
      };
    }
    const title = Array.from(text.trim().replace(/\s+/gu, " "))
      .slice(0, 36)
      .join("");
    const thread = chatId
      ? this.thread(bindingId, chatId)
      : this.makeThread(bindingId, title);
    check(
      !this.sql
        .exec(
          "SELECT id FROM agent_chat_jobs WHERE chat_id=? AND status IN ('queued','running')",
          thread.id,
        )
        .toArray().length,
      "这条聊天还有一条消息正在处理。",
      409,
    );
    const user = this.appendMessage(thread, "user", text, undefined, {
      messageIds: [],
      memories: [],
      ...(project ? { project } : {}),
    });
    if (thread.title === "新聊天" && user.sequence === 1)
      this.sql.exec(
        "UPDATE agent_chat_threads SET title=? WHERE id=?",
        title,
        thread.id,
      );
    const job: ChatJob = {
      id: crypto.randomUUID(),
      bindingId,
      chatId: thread.id,
      userMessageId: user.id,
      status: "queued",
      revision: 1,
      memoryEpoch: this.getMemoryEpoch(),
      leaseUntil: null,
      assistantMessageId: null,
      error: null,
    };
    this.sql.exec(
      "INSERT INTO agent_chat_jobs VALUES(?,?,?,?,?,?,?,?,?,?)",
      job.id,
      bindingId,
      thread.id,
      user.id,
      job.status,
      job.revision,
      job.memoryEpoch,
      null,
      null,
      null,
    );
    this.rememberReceipt(requestId, payload, { jobId: job.id });
    return { thread: this.thread(bindingId, thread.id), message: user, job };
  }
  readSendRequest(bindingId: string, requestId: string) {
    const receipt = this.sql
      .exec<{ payload: string; value: string }>(
        "SELECT payload,value FROM agent_chat_receipts WHERE request_id=?",
        requestId,
      )
      .toArray()[0];
    if (!receipt) return null;
    const payload = JSON.parse(receipt.payload);
    check(payload.action === "beginMessage", "请求编号不属于发送消息。", 409);
    check(payload.bindingId === bindingId, "请求不属于当前项目。", 403);
    const job = this.getJob(JSON.parse(receipt.value).jobId);
    check(job?.bindingId === bindingId, "原聊天任务不可用。", 409);
    const message = this.readMessage(bindingId, job.chatId, job.userMessageId);
    check(message?.role === "user", "原聊天消息不可用。", 409);
    return { thread: this.thread(bindingId, job.chatId), message, job };
  }
  getJob(jobId: string) {
    const row = this.sql
      .exec<ChatJob>(`SELECT ${sqlJob} FROM agent_chat_jobs WHERE id=?`, jobId)
      .toArray()[0];
    return row ? { ...row } : null;
  }
  listPendingJobs() {
    return this.sql
      .exec<ChatJob>(
        `SELECT ${sqlJob} FROM agent_chat_jobs WHERE status IN ('queued','running') ORDER BY rowid`,
      )
      .toArray();
  }
  claimJob(jobId: string, expectedRevision: number, leaseMs = 60000) {
    const job = this.getJob(jobId),
      now = Date.parse(this.now());
    if (!job || job.revision !== expectedRevision || job.status !== "queued")
      return null;
    if (!this.contextMessage(job.bindingId, job.chatId, job.userMessageId)) {
      this.finishJob(job, "stale", null, "记忆已更改，请重新发送消息。");
      return null;
    }
    check(
      Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 600_000,
      "任务租约无效。",
    );
    this.sql.exec(
      "UPDATE agent_chat_jobs SET status='running',revision=revision+1,memory_epoch=?,lease_until=? WHERE id=?",
      this.getMemoryEpoch(),
      now + leaseMs,
      jobId,
    );
    return this.getJob(jobId);
  }
  private finishJob(
    job: ChatJob,
    status: "succeeded" | "failed" | "stale",
    assistantMessageId: string | null,
    error: string | null,
  ) {
    this.sql.exec(
      "UPDATE agent_chat_jobs SET status=?,revision=revision+1,lease_until=NULL,assistant_message_id=?,error=? WHERE id=?",
      status,
      assistantMessageId,
      error,
      job.id,
    );
    return this.getJob(job.id);
  }
  replyJob({
    jobId,
    expectedRevision,
    reply,
    provenance,
  }: {
    jobId: string;
    expectedRevision: number;
    reply: AgentReply;
    provenance: ChatProvenance;
  }) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "running" || job.revision !== expectedRevision)
      return null;
    if (job.memoryEpoch !== this.getMemoryEpoch())
      return this.finishJob(job, "stale", null, "记忆已更改，请重新发送消息。");
    if (job.leaseUntil === null || job.leaseUntil <= Date.parse(this.now()))
      return null;
    const thread = this.thread(job.bindingId, job.chatId);
    const row = this.appendMessage(
      thread,
      "assistant",
      reply.text,
      reply,
      {
        messageIds: [...new Set([job.userMessageId, ...provenance.messageIds])],
        memories: provenance.memories,
        ...(provenance.project ? { project: provenance.project } : {}),
      },
      job.userMessageId,
    );
    return this.finishJob(job, "succeeded", row.id, null);
  }
  failJob({
    jobId,
    expectedRevision,
    error,
  }: {
    jobId: string;
    expectedRevision: number;
    error: string;
  }) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "running" || job.revision !== expectedRevision)
      return null;
    if (job.memoryEpoch !== this.getMemoryEpoch())
      return this.finishJob(job, "stale", null, "记忆已更改，请重新发送消息。");
    return this.finishJob(job, "failed", null, error.slice(0, 1000));
  }

  getMemoryEpoch() {
    return this.sql
      .exec<{ epoch: number }>(
        "SELECT COALESCE(MAX(epoch),0) AS epoch FROM agent_chat_memories",
      )
      .toArray()[0].epoch;
  }
  listMemories(bindingId: string) {
    return this.sql
      .exec<ChatMemory>(
        `SELECT ${sqlMemory} FROM agent_chat_memories WHERE status='active' AND (binding_id IS NULL OR binding_id=?) ORDER BY epoch DESC`,
        bindingId,
      )
      .toArray();
  }
  contextMemories(bindingId: string, limit: number) {
    return this.sql
      .exec<ChatMemory>(
        `SELECT ${sqlMemory} FROM agent_chat_memories m
      WHERE status='active' AND (binding_id IS NULL OR binding_id=?)
      AND NOT EXISTS (SELECT 1 FROM agent_chat_tombstones t
        WHERE t.kind='memory' AND t.id=m.id AND t.revision=m.revision)
      ORDER BY epoch DESC LIMIT ?`,
        bindingId,
        limit,
      )
      .toArray();
  }
  private getMemory(id: string) {
    return this.sql
      .exec<ChatMemory>(
        `SELECT ${sqlMemory} FROM agent_chat_memories WHERE id=?`,
        id,
      )
      .toArray()[0];
  }
  private invalidate(memory: ChatMemory, epoch: number) {
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_chat_tombstones VALUES('memory',?,?,?)",
      memory.id,
      memory.revision,
      epoch,
    );
    if (memory.sourceMessageId)
      this.sql.exec(
        "INSERT OR IGNORE INTO agent_chat_tombstones VALUES('message',?,0,?)",
        memory.sourceMessageId,
        epoch,
      );
    else
      this.sql.exec(
        `INSERT OR IGNORE INTO agent_chat_tombstones(kind,id,revision,epoch)
        SELECT 'message',id,0,? FROM agent_chat_messages WHERE (? IS NULL OR binding_id=?) AND instr(text,?)>0`,
        epoch,
        memory.bindingId,
        memory.bindingId,
        memory.value,
      );
  }
  saveMemory(input: SaveMemory) {
    const {
      requestId,
      id,
      expectedRevision,
      bindingId,
      scope,
      sourceMessageId,
    } = input;
    const key = input.key.trim(),
      value = input.value.trim();
    check(
      key.length && key.length <= 100 && value.length && value.length <= 1000,
      "记忆名称或内容不符合长度限制。",
    );
    check(
      scope === "personal" || (scope === "project" && bindingId),
      "项目记忆需要当前项目。",
    );
    const payload = {
      action: "saveMemory",
      id: id ?? null,
      expectedRevision: expectedRevision ?? null,
      bindingId: bindingId ?? null,
      scope,
      key,
      value,
      sourceMessageId: sourceMessageId ?? null,
    };
    const receipt = this.receipt<ChatMemory>(requestId, payload);
    if (receipt) return receipt;
    const old = id ? this.getMemory(id) : undefined;
    if (id) {
      check(
        old &&
          old.scope === scope &&
          (old.bindingId === null || old.bindingId === bindingId),
        "当前项目中找不到该记忆。",
        404,
      );
      check(
        old.status === "active" && expectedRevision === old.revision,
        "记忆版本已变化。",
        409,
      );
    } else {
      check(expectedRevision === undefined, "新记忆不应提供旧版本。");
      check(
        this.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM agent_chat_memories WHERE status='active'",
          )
          .toArray()[0].n < 200,
        "已保存 200 条记忆，请先删除不再使用的条目。",
        409,
      );
    }
    const storedBindingId = scope === "personal" ? null : bindingId!;
    if (!old || old.key !== key) {
      const duplicate = this.sql
        .exec(
          "SELECT id FROM agent_chat_memories WHERE status='active' AND scope=? AND binding_id IS ? AND key=? LIMIT 1",
          scope,
          storedBindingId,
          key,
        )
        .toArray()[0];
      check(!duplicate, "已有同名记忆，请编辑原条目。", 409);
    }
    if (sourceMessageId) {
      const source = this.messageRow(sourceMessageId);
      check(
        bindingId &&
          source?.role === "user" &&
          source.bindingId === bindingId &&
          this.contextMessage(bindingId, source.chatId, sourceMessageId),
        "来源消息不属于当前项目、不是用户消息或已从上下文排除。",
        409,
      );
    }
    const epoch = this.getMemoryEpoch() + 1,
      now = this.now(),
      memoryId = old?.id ?? crypto.randomUUID();
    if (old) this.invalidate(old, epoch);
    this.sql.exec(
      `INSERT INTO agent_chat_memories VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET key=excluded.key,value=excluded.value,source_message_id=excluded.source_message_id,
      revision=excluded.revision,epoch=excluded.epoch,updated_at=excluded.updated_at`,
      memoryId,
      storedBindingId,
      scope,
      key,
      value,
      sourceMessageId ?? null,
      (old?.revision ?? 0) + 1,
      epoch,
      "active",
      now,
    );
    const saved = this.getMemory(memoryId);
    this.rememberReceipt(requestId, payload, saved);
    return saved;
  }
  deleteMemory({ requestId, id, expectedRevision, bindingId }: DeleteMemory) {
    const payload = {
      action: "deleteMemory",
      id,
      expectedRevision,
      bindingId: bindingId ?? null,
    };
    const prior = this.receipt<ChatMemory>(requestId, payload);
    if (prior) return prior;
    const old = this.getMemory(id);
    check(
      old && (old.bindingId === null || old.bindingId === bindingId),
      "当前项目中找不到该记忆。",
      404,
    );
    check(
      old.status === "active" && expectedRevision === old.revision,
      "记忆版本已变化。",
      409,
    );
    const epoch = this.getMemoryEpoch() + 1;
    this.invalidate(old, epoch);
    this.sql.exec(
      "UPDATE agent_chat_memories SET status='deleted',revision=revision+1,epoch=?,updated_at=? WHERE id=?",
      epoch,
      this.now(),
      id,
    );
    const deleted = this.getMemory(id);
    this.rememberReceipt(requestId, payload, deleted);
    return deleted;
  }

  contextMessage(bindingId: string, chatId: string, id: string) {
    const row = this.sql
      .exec<MessageRow>(
        `${visible} SELECT ${sqlMessage} FROM agent_chat_messages
      WHERE chat_id=?1 AND binding_id=?2 AND id=?3 AND id NOT IN (SELECT id FROM hidden)`,
        chatId,
        bindingId,
        id,
      )
      .toArray()[0];
    return row ? message(row) : null;
  }
  recentContextMessages(
    bindingId: string,
    chatId: string,
    beforeSequence: number,
    limit: number,
  ) {
    return this.sql
      .exec<MessageRow>(
        `${visible} SELECT ${sqlMessage} FROM agent_chat_messages
      WHERE chat_id=?1 AND binding_id=?2 AND sequence<?3 AND id NOT IN (SELECT id FROM hidden)
      ORDER BY sequence DESC LIMIT ?4`,
        chatId,
        bindingId,
        beforeSequence,
        limit,
      )
      .toArray()
      .map(message);
  }
}
