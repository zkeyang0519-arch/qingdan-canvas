import path from "node:path";
import { z } from "zod";
import type { CodexClient } from "./codex-client";
import type { Thread } from "./protocol/v2/Thread";
import type { Turn } from "./protocol/v2/Turn";
import type { DynamicToolSpec } from "./protocol/v2/DynamicToolSpec";
import { rootKey } from "./workspace";
import { RunnerError } from "./errors";
import { redactHistoryText } from "./project-history";

export const recentHistoryToolName = "qingdan_read_recent_history";
const requestSchema = z.strictObject({
  action: z.enum(["list", "read"]),
  threadId: z.string().min(1).max(256).optional(),
  cursor: z.string().max(32768).nullable().optional(),
  archived: z.boolean().optional(),
});
const fail = () =>
  new RunnerError(
    "PROJECT_HISTORY_UNAVAILABLE",
    "只能读取当前项目的独立开发会话；该会话不属于可读取范围。",
  );
const excerpt = (value: string) => {
  const text = redactHistoryText(value);
  return text.length > 3000
    ? {
        text:
          text.slice(0, 1500) +
          "\n[中间内容省略，不能据此声称完整覆盖]\n" +
          text.slice(-1500),
        truncated: true,
      }
    : { text, truncated: false };
};

// Each request returns one bounded page. Only the model decides whether to ask
// for another; neither launch nor report submission depends on exhausting it.
export async function readRecentHistory(
  client: Pick<CodexClient, "request">,
  root: string,
  input: unknown,
  options: { excludeThreadIds?: string[]; assertCurrent?: () => void } = {},
): Promise<{ output: Record<string, any>; sources: string[] }> {
  const request = requestSchema.parse(input);
  const excluded = new Set(options.excludeThreadIds ?? []);
  const eligible = (thread: Thread) =>
    !!thread?.id &&
    !!thread.cwd &&
    rootKey(path.resolve(thread.cwd)) === rootKey(path.resolve(root)) &&
    !thread.parentThreadId &&
    !thread.forkedFromId &&
    !thread.ephemeral &&
    !excluded.has(thread.id) &&
    !/^轻单\s*·\s*项目总结(?:\s|$)/u.test(thread.name ?? "");
  const read = async <T extends object>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    options.assertCurrent?.();
    const result = await operation();
    options.assertCurrent?.();
    if (
      request.cursor &&
      "nextCursor" in result &&
      result.nextCursor === request.cursor
    )
      throw new RunnerError(
        "PROJECT_HISTORY_UNAVAILABLE",
        "历史游标没有前进，请从最近一页重新读取。",
      );
    return result;
  };
  if (request.action === "list") {
    // Filter canonical Windows directory identities locally. Server cwd filters
    // compare strings exactly and can miss the same directory with another case.
    const page = await read(() =>
      client.request("thread/list", {
        cursor: request.cursor ?? null,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: request.archived ?? false,
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
        modelProviders: [],
        useStateDbOnly: true,
      }),
    );
    return {
      output: {
        threads: (page.data as Thread[]).filter(eligible).map((thread) => ({
          threadId: thread.id,
          title: redactHistoryText(thread.name ?? "未命名会话").slice(0, 160),
          updatedAt: thread.updatedAt,
        })),
        nextCursor: page.nextCursor,
        scope:
          "仅当前项目；按需继续，不要求读完历史。来源不明分叉及项目总结已排除。",
      },
      sources: [],
    };
  }
  if (!request.threadId) throw fail();
  const { thread } = await read(() =>
    client.request("thread/read", {
      threadId: request.threadId!,
      includeTurns: false,
    }),
  );
  if (thread.id !== request.threadId || !eligible(thread)) throw fail();
  const page = await read(() =>
    client.request("thread/turns/list", {
      threadId: thread.id,
      cursor: request.cursor ?? null,
      limit: 3,
      sortDirection: "desc",
      itemsView: "summary",
    }),
  );
  const records = (page.data as Turn[]).map((turn) => {
    const requestText = excerpt(
      turn.items
        .flatMap((item) =>
          item.type === "userMessage"
            ? item.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
            : [],
        )
        .join("\n\n"),
    );
    const finals = turn.items.filter(
      (item) => item.type === "agentMessage" && item.phase !== "commentary",
    );
    const answer =
      finals.findLast(
        (item) => item.type === "agentMessage" && item.phase === "final_answer",
      ) ?? finals.at(-1);
    const text = excerpt(answer?.type === "agentMessage" ? answer.text : "");
    return {
      source: `codex:${thread.id}:${turn.id}`,
      status: turn.status,
      completedAt: turn.completedAt,
      request: requestText.text,
      text: text.text,
      truncated: requestText.truncated || text.truncated,
    };
  });
  return {
    output: {
      records,
      nextCursor: page.nextCursor,
      scope:
        "最近会话记录仅供背景核对，完成声明不是本轮验收；长记录保留开头和末尾并标明省略。",
    },
    sources: records.map((record) => record.source),
  };
}

export function recentHistoryTool(): DynamicToolSpec {
  return {
    type: "function",
    name: recentHistoryToolName,
    description:
      "按需查看当前项目最近会话。list 只列一页会话目录；read 读取指定会话最近三轮需求及答复。nextCursor 可继续查更旧内容，但不要求读完。默认不含归档；需要时 list 可传 archived=true。只读且不恢复、续写来源会话。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"] },
        threadId: {
          type: "string",
          description: "read 必填，使用 list 返回的 threadId。",
        },
        cursor: {
          type: ["string", "null"],
          description:
            "可选，保持 action/threadId/archived 相同并传回 nextCursor。",
        },
        archived: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}
