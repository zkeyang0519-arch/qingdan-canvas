import { DurableObject } from "cloudflare:workers";
import { HttpError } from "../../worker/http";
import { chatInput } from "./chat-input.mjs";
import app from "../../worker/index";
import { AgentChatRouter } from "../../worker/agent/chat-router";

export default app;

// The pilot gets its own test project. A real device binding is never borrowed.
export class Project extends DurableObject {
  async fetch(request) {
    const { principal } = await request.json();
    if (!new URL(request.url).pathname.endsWith("/project-state"))
      return Response.json({ ok: true });
    return Response.json({
      bindingId: principal.bindingId,
      bindingRevision: principal.bindingRevision,
      status: "ready",
      ready: true,
      stale: false,
      summaryRevision: 1,
      sourceRunId: "pi-local",
      capturedAt: "2026-11-19T00:00:00Z",
      cwd: "本机试用项目",
      activeRunId: null,
      error: null,
      summary: {
        overview: "本机独立的短片测试项目。",
        completed: [],
        inProgress: [],
        pending: [],
        blockers: [],
        verification: [],
        uncertainties: [],
      },
    });
  }
}

export class Chat extends AgentChatRouter {
  get externalModelCatalog() {
    return true;
  }
  get chatLeaseMs() {
    return 600000;
  }
  get supportsModelSelection() {
    return true;
  }

  readState(...args) {
    const state = super.readState(...args);
    if (state.thread)
      state.harnessMessageIds = this.store.taskMessageIds(
        state.thread.bindingId,
        state.thread.id,
      );
    const replies = state.messages.filter(
      (m) => m.role === "assistant" && m.replyTo && !m.invalidated,
    );
    if (!replies.length) return state;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT j.assistant_message_id AS reply, j.model_profile_id AS profile, j.retry_of AS retryOf,
      old.model_profile_id AS previousProfile, old.error AS previousError FROM agent_chat_jobs j LEFT JOIN agent_chat_jobs old ON old.id=j.retry_of
      WHERE j.status='succeeded' AND j.assistant_message_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(replies.map((m) => m.id)),
      )
      .toArray();
    const jobs = new Map(rows.map((row) => [row.reply, row]));
    for (const message of replies) {
      const job = jobs.get(message.id);
      if (job?.profile) message.modelProfileId = job.profile;
      if (job?.retryOf)
        message.previousAttempt = {
          id: job.retryOf,
          profile: job.previousProfile ?? "xingchi",
          error: job.previousError,
        };
    }
    return state;
  }

  async generate(context, options, { job, accountId, messageIds, background }) {
    const { id, chatId, bindingId, userMessageId } = job;
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pi_rpc_chats (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL)",
    );
    sql.exec(
      "INSERT OR IGNORE INTO pi_rpc_chats VALUES(?,?)",
      chatId,
      crypto.randomUUID(),
    );
    const sessionId = sql
      .exec("SELECT session_id FROM pi_rpc_chats WHERE chat_id=?", chatId)
      .one().session_id;
    const visible = sql
      .exec(
        "SELECT reply_to FROM agent_chat_messages WHERE chat_id=? AND binding_id=? AND role='assistant' AND reply_to IS NOT NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence",
        chatId,
        bindingId,
        JSON.stringify(messageIds),
      )
      .toArray()
      .map((row) => row.reply_to);
    visible.push(
      ...sql
        .exec(
          "SELECT id FROM agent_chat_messages WHERE chat_id=? AND binding_id=? AND role='user' AND id IN (SELECT value FROM json_each(?))",
          chatId,
          bindingId,
          JSON.stringify(messageIds),
        )
        .toArray()
        .map((row) => row.id),
    );
    const authorization = sql
      .exec(
        "SELECT value FROM agent_chat_authorizations WHERE user_message_id=?",
        userMessageId,
      )
      .toArray()[0];
    const taskReply = authorization
      ? JSON.parse(authorization.value).taskReply
      : undefined;
    // This service binding is private to the local worker. Scope is used to
    // authorize tools on the host; it is never passed to the Pi subprocess.
    const response = await this.env.PI_CHAT.fetch("https://pi.internal/turn", {
      method: "POST",
      body: JSON.stringify({
        jobId: id,
        sessionId,
        modelProfileId: job.modelProfileId ?? "xingchi",
        scope: {
          accountId,
          bindingId,
          chatId,
          userMessageId,
          visible,
          authorizedMessages: this.store.taskMessageIds(bindingId, chatId),
          memoryEpoch: job.memoryEpoch,
          retry: !!job.retryOf,
        },
        input: {
          ...chatInput(context.messages.at(-1).content, background),
          ...(taskReply ? { taskReply } : {}),
        },
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(575000)]),
    });
    const result = await response.json();
    if (!response.ok)
      throw new HttpError(502, result.error || "本机 Pi 会话未完成。");
    return {
      reply: {
        text: result.text,
        tasks: result.tasks || [],
        memories: result.memories || [],
      },
    };
  }
}
