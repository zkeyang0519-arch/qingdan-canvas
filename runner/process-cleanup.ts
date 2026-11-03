import type { CodexClient } from "./codex-client";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse";
import { RunnerError } from "./errors";

async function terminalIds(client: CodexClient, threadId: string) {
  const ids = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ThreadBackgroundTerminalsListResponse = await client.request(
      "thread/backgroundTerminals/list",
      { threadId, cursor, limit: 100 },
    );
    for (const terminal of page.data) ids.add(terminal.processId);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 1000))
      throw new RunnerError(
        "CODEX_PROTOCOL_ERROR",
        "Invalid terminal pagination",
      );
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return ids;
}

export async function stopThreadTerminals(
  client: CodexClient,
  threadId: string,
): Promise<void> {
  // IDs are obtained only from the mapped task's thread. Never use OS process
  // names, arbitrary model-provided PIDs, or another Codex client's threads.
  for (const processId of await terminalIds(client, threadId)) {
    await client.request("thread/backgroundTerminals/terminate", {
      threadId,
      processId,
    });
  }
  if ((await terminalIds(client, threadId)).size)
    throw new RunnerError(
      "RECONCILIATION_REQUIRED",
      "后台进程尚未确认停止，保留目录占用并等待核实。",
    );
}
