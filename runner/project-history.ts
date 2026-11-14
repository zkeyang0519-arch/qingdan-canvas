import path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectSummary } from "../shared/agent/contracts";
import type { CodexClient } from "./codex-client";
import type { Thread } from "./protocol/v2/Thread";
import type { Turn } from "./protocol/v2/Turn";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse";
import { RunnerError } from "./errors";
import { rootKey } from "./workspace";
import { summarySourceItems } from "../shared/agent/progress";

const directoryKey = (cwd: string) => rootKey(path.resolve(cwd));
export const redactHistoryText = (value: string) =>
  value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
      "[私钥内容已省略]",
    )
    .split("\n")
    .map((line) =>
      /(?:api[_-]?key|(?:access|refresh)[_-]?token|token|private[_-]?key|password|secret|authorization)\s*["']?\s*[:=]|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@|\bbearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
        line,
      )
        ? "[凭据相关行已省略]"
        : line,
    )
    .join("\n");
const redact = redactHistoryText;

export type ProjectHistoryRecord = {
  source: string;
  threadId: string;
  turnId: string;
  title: string;
  completedAt: number | null;
  text: string;
  truncated: boolean;
  request?: string;
  kind?: "result" | "status";
  status?: string;
};
export type ProjectHistory = {
  mode: "codex_history";
  version?: 2;
  cwd: string;
  capturedAt: string;
  records: ProjectHistoryRecord[];
  coverage: {
    threadCount: number;
    summaryCount: number;
    includedCount: number;
    omittedCount: number;
    truncatedCount: number;
    incompleteTurnCount: number;
    missingFinalCount: number;
    duplicateCount: number;
    failedThreadCount: number;
    excludedForkCount: number;
    oldestIncludedAt: number | null;
    newestIncludedAt: number | null;
  };
};
type Options = {
  excludeThreadIds?: string[];
  assertCurrent?: () => void;
  checkpoint?: () => Promise<void>;
};
const failed = (message: string) =>
  new RunnerError("PROJECT_HISTORY_UNAVAILABLE", message);

// Read through app-server; never resume or write a source conversation. The
// server's summary items view retains final answers without tool/command logs.
export async function collectProjectHistory(
  client: Pick<CodexClient, "request">,
  root: string,
  options: Options = {},
): Promise<ProjectHistory> {
  const project = directoryKey(root);
  let checkpointError: unknown;
  const checkpoint = async () => {
    try {
      await options.checkpoint?.();
    } catch (error) {
      checkpointError = error;
      throw error;
    }
  };
  const excluded = new Set(options.excludeThreadIds ?? []);
  const threads = new Map<string, Thread>();
  const records: ProjectHistoryRecord[] = [];
  const identities = new Set<string>();
  const coverage: ProjectHistory["coverage"] = {
    threadCount: 0,
    summaryCount: 0,
    includedCount: 0,
    omittedCount: 0,
    truncatedCount: 0,
    incompleteTurnCount: 0,
    missingFinalCount: 0,
    duplicateCount: 0,
    failedThreadCount: 0,
    excludedForkCount: 0,
    oldestIncludedAt: null,
    newestIncludedAt: null,
  };
  const eligible = (thread: Thread) =>
    !!thread?.id &&
    !!thread.cwd &&
    directoryKey(thread.cwd) === project &&
    !thread.parentThreadId &&
    !thread.ephemeral &&
    !excluded.has(thread.id) &&
    !/^轻单\s*·\s*项目总结(?:\s|$)/u.test(thread.name ?? "");
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      options.assertCurrent?.();
      await checkpoint();
      const page: ThreadListResponse = await client.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
        modelProviders: [],
        archived,
        useStateDbOnly: true,
      });
      options.assertCurrent?.();
      // Match canonical directory identity locally: Windows persisted history
      // can spell the same cwd with different slash/case/trailing separators.
      for (const thread of page.data)
        if (eligible(thread)) threads.set(thread.id, thread);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw failed("Codex 会话分页没有前进，请重试获取项目记录。");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  coverage.threadCount = threads.size;
  const metadata = new Map<string, Thread>();
  const readMetadata = async (threadId: string) => {
    options.assertCurrent?.();
    await checkpoint();
    const cached = metadata.get(threadId);
    if (cached) return cached;
    const { thread } = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    options.assertCurrent?.();
    if (thread.id !== threadId) throw failed("会话编号不匹配。");
    metadata.set(threadId, thread);
    return thread;
  };
  const sameProjectAncestry = async (thread: Thread) => {
    const seen = new Set([thread.id]);
    let current = thread;
    while (current.forkedFromId) {
      if (seen.has(current.forkedFromId)) return false;
      seen.add(current.forkedFromId);
      current = await readMetadata(current.forkedFromId);
      // Forks copy history and may override cwd. Without per-turn provenance,
      // conservatively omit this thread, including its new turns, and disclose it.
      if (!eligible(current)) return false;
    }
    return true;
  };
  for (const listed of threads.values()) {
    options.assertCurrent?.();
    try {
      const thread = await readMetadata(listed.id);
      options.assertCurrent?.();
      if (thread.id !== listed.id || !eligible(thread))
        throw failed("会话项目已变化。");
      if (!(await sameProjectAncestry(thread))) {
        coverage.excludedForkCount++;
        continue;
      }
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        options.assertCurrent?.();
        await checkpoint();
        const page: { data: Turn[]; nextCursor: string | null } =
          await client.request("thread/turns/list", {
            threadId: thread.id,
            cursor,
            limit: 50,
            sortDirection: "desc",
            itemsView: "summary",
          });
        options.assertCurrent?.();
        for (const turn of page.data) {
          const completed = turn.status === "completed";
          if (!completed) coverage.incompleteTurnCount++;
          const request = redact(
            turn.items
              .flatMap((item) =>
                item.type === "userMessage"
                  ? item.content.flatMap((input) =>
                      input.type === "text" ? [input.text] : [],
                    )
                  : [],
              )
              .join("\n\n"),
          );
          const answers = turn.items.filter(
            (item) =>
              item.type === "agentMessage" &&
              item.phase !== "commentary" &&
              item.text.trim(),
          );
          const answer =
            answers.findLast(
              (item) =>
                item.type === "agentMessage" && item.phase === "final_answer",
            ) ?? answers.at(-1);
          if (completed && (!answer || answer.type !== "agentMessage")) {
            coverage.missingFinalCount++;
            if (!request) continue;
          }
          const statusMessage = turn.items.findLast(
            (item) => item.type === "agentMessage" && item.text.trim(),
          );
          const text = redact(
            (completed
              ? answer?.type === "agentMessage"
                ? answer.text
                : ""
              : statusMessage?.type === "agentMessage"
                ? statusMessage.text
                : ""
            ).trim(),
          );
          const identity = createHash("sha256")
            .update(JSON.stringify([turn.id, request, turn.status, text]))
            .digest("hex");
          if (identities.has(identity)) {
            coverage.duplicateCount++;
            continue;
          }
          identities.add(identity);
          if (completed && answer) coverage.summaryCount++;
          const record: ProjectHistoryRecord = {
            source: `codex:${thread.id}/${turn.id}/${completed && answer ? answer.id : "status"}`,
            threadId: thread.id,
            turnId: turn.id,
            title: redact(thread.name || thread.preview || "未命名会话").slice(
              0,
              200,
            ),
            completedAt: turn.completedAt ?? turn.startedAt ?? null,
            text,
            request,
            kind: completed && answer ? "result" : "status",
            status: turn.status,
            truncated: false,
          };
          records.push(record);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw failed("Codex 轮次分页没有前进。");
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (error) {
      // Cancellation/lease loss must escape, not become a partial success.
      options.assertCurrent?.();
      if (checkpointError) throw checkpointError;
      coverage.failedThreadCount++;
    }
  }
  options.assertCurrent?.();
  if (
    coverage.threadCount &&
    coverage.failedThreadCount === coverage.threadCount &&
    !records.length
  )
    throw failed("未能读取所选项目的 Codex 任务记录，请检查 Codex 后重试。");
  const history: ProjectHistory = {
    mode: "codex_history",
    version: 2,
    cwd: root,
    capturedAt: new Date().toISOString(),
    records,
    coverage,
  };
  // Chronological delivery keeps requirements and their later changes together.
  records.sort(
    (a, b) =>
      (a.completedAt ?? 0) - (b.completedAt ?? 0) ||
      a.source.localeCompare(b.source),
  );
  coverage.includedCount = records.length;
  const dates = records.flatMap((record) =>
    record.completedAt === null ? [] : [record.completedAt],
  );
  coverage.oldestIncludedAt = dates.length ? Math.min(...dates) : null;
  coverage.newestIncludedAt = dates.length ? Math.max(...dates) : null;
  return history;
}

export {
  initialHistoryRead,
  historyManifest,
  readHistoryPage,
  historyPageBytes,
} from "./project-history-pages";
export { selectHistoryCache, historyReadInput } from "./summary-cache";

export function validateHistoryReferences(
  summary: ProjectSummary,
  history: ProjectHistory,
) {
  const sources = new Set([
    "native:history",
    ...history.records.map((record) => record.source),
  ]);
  for (const item of summarySourceItems(summary))
    if (item.evidenceRef && !sources.has(item.evidenceRef))
      throw failed("总结引用了本轮未提供的 Codex 记录来源。");
  return summary;
}
