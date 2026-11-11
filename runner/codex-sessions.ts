import path from "node:path";
import { CodexClient } from "./codex-client";
import type { ProcessOptions } from "./supervisor";
import type { Thread } from "./protocol/v2/Thread";
import { RunnerError } from "./errors";

type Options = ProcessOptions & { requestTimeoutMs?: number };
export type SessionQuery = { cursor?: string; searchTerm?: string };

function sessionView(thread: Thread) {
  if (!thread?.id || !thread.cwd || thread.ephemeral || thread.parentThreadId)
    throw new RunnerError("VALIDATION_ERROR", "此会话没有可关联的本机项目。");
  return {
    threadId: thread.id,
    title: (thread.name || thread.preview || "未命名会话").slice(0, 200),
    cwd: thread.cwd,
    projectName: path.basename(thread.cwd) || thread.cwd,
    updatedAt: thread.updatedAt,
  };
}

// This client only reads metadata. It never attaches to, resumes, or runs a thread.
async function inspect<T>(
  options: Options,
  read: (client: CodexClient) => Promise<T>,
) {
  const client = new CodexClient(options);
  try {
    await client.connect();
    return await read(client);
  } finally {
    await client.close();
  }
}

export function listCodexSessions(options: Options, query: SessionQuery) {
  return inspect(options, async (client) => {
    const page = await client.request("thread/list", {
      cursor: query.cursor || null,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      modelProviders: [],
      archived: false,
      useStateDbOnly: true,
      ...(query.searchTerm ? { searchTerm: query.searchTerm } : {}),
    });
    return {
      sessions: page.data
        .filter(
          (thread) => thread.cwd && !thread.ephemeral && !thread.parentThreadId,
        )
        .map(sessionView),
      nextCursor: page.nextCursor,
    };
  });
}

export function readCodexSession(options: Options, threadId: string) {
  return inspect(options, async (client) => {
    const { thread } = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (thread.id !== threadId)
      throw new RunnerError(
        "CODEX_PROTOCOL_ERROR",
        "会话编号不匹配，请刷新列表。",
      );
    return sessionView(thread);
  });
}
