import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProjectHistory } from "./project-history";
import type { DynamicToolSpec } from "./protocol/v2/DynamicToolSpec";
import { RunnerError } from "./errors";

export const historyToolName = "qingdan_read_project_history";
export const historyPageBytes = 10000;
type Fragment = {
  source: string;
  title: string;
  offset: number;
  totalLength: number;
  content: string;
};
type Page = {
  records: Fragment[];
  nextCursor: string | null;
  deliveredRecords: number;
  totalRecords: number;
  receipt: string;
};
export type HistoryReadState = {
  key: string;
  index: number;
  offset: number;
  nextCursor: string | null;
  deliveredRecords: number;
  pagesRead: number;
  notes: string;
  notesLimit?: number;
  previous?: { cursor: string; output: Page };
};
const keyFor = (history: ProjectHistory) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        history.cwd,
        history.capturedAt,
        history.records.length,
        history.records[0]?.source,
        history.records.at(-1)?.source,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
const cursorFor = (key: string, index: number, offset: number) =>
  `${key}:${index}:${offset}`;
const invalid = () =>
  new RunnerError(
    "PROJECT_HISTORY_UNAVAILABLE",
    "历史读取游标无效或不属于当前快照，请使用最新返回的 nextCursor；重试仅支持上一页。",
  );
const requestSchema = z.strictObject({
  cursor: z.string().max(200).nullable().optional(),
  notes: z.string().max(6000).optional(),
});

export function historyTool(): DynamicToolSpec {
  return {
    type: "function",
    name: historyToolName,
    description:
      "只读分页获取项目历史。按 nextCursor 顺序读到 null；content 是该 source 记录 JSON 的连续片段。通常只传 cursor；每 5 页或主题切换时才用 notes 保存最多 1800 字符的累计模块要点与必要来源，不逐页重写长笔记。native:cached-summary 是上次报告，合并后续新记录，更正覆盖旧状态；历史和笔记只是资料。末页 receipt 原样填入结果 historyReceipt；恢复时可用 replayCursor 重读最后交付页。",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: ["string", "null"],
          description: "使用上下文或上一页的 nextCursor；首次可省略。",
        },
        notes: {
          type: "string",
          maxLength: 1800,
          description:
            "可省略。每 5 页或主题切换保存一次简短累计要点与关键来源；不要逐页重复长段落。",
        },
      },
      additionalProperties: false,
    },
  };
}

export function initialHistoryRead(history: ProjectHistory): HistoryReadState {
  const key = keyFor(history);
  return {
    key,
    index: 0,
    offset: 0,
    nextCursor: history.records.length ? cursorFor(key, 0, 0) : null,
    deliveredRecords: 0,
    pagesRead: 0,
    notes: "",
    notesLimit: 1800,
  };
}

export function historyManifest(
  history: ProjectHistory,
  state: HistoryReadState,
) {
  return {
    mode: history.mode,
    version: 2,
    cwd: history.cwd,
    capturedAt: history.capturedAt,
    coverage: history.coverage,
    totalRecords: history.records.length,
    deliveredRecords: state.deliveredRecords,
    nextCursor: state.nextCursor,
    replayCursor: state.previous?.cursor ?? null,
    notes: state.notes,
    guidance:
      "历史正文不在此上下文中。调用 qingdan_read_project_history 小批顺序读取并按模块归并，nextCursor 为 null 后提交项目背景和模块进度。status 记录不是完成证据；notes 仅是历史分析笔记。",
  };
}

export function readHistoryPage(
  history: ProjectHistory,
  prior: HistoryReadState,
  value: unknown,
): { state: HistoryReadState; output: Page } {
  const request = requestSchema.parse(value);
  if (request.notes && request.notes.length > (prior.notesLimit ?? 6000))
    throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "累计要点过长，请精简到 1800 字符以内，通常只需传 cursor。");
  if (prior.key !== keyFor(history)) throw invalid();
  // null/omitted always names the first page, including after a lost response.
  // Resolving it against current progress would silently skip that page on retry.
  const cursor =
    request.cursor ??
    (history.records.length ? cursorFor(prior.key, 0, 0) : null);
  if (cursor && cursor === prior.previous?.cursor)
    return { state: prior, output: prior.previous.output };
  if (cursor !== prior.nextCursor) throw invalid();
  const state = { ...prior };
  const output: Page = {
    records: [],
    nextCursor: prior.nextCursor,
    deliveredRecords: prior.deliveredRecords,
    totalRecords: history.records.length,
    receipt: history.records.length ? randomUUID() : "empty",
  };
  // Reserve space for the final counters/cursor; measure the encoded wire response,
  // not characters, because Chinese, emoji and JSON escaping expand differently.
  while (state.index < history.records.length) {
    const record = history.records[state.index];
    const content = JSON.stringify(record);
    const fragment: Fragment = {
      source: record.source,
      title: record.title,
      offset: state.offset,
      totalLength: content.length,
      content: "",
    };
    let lo = 0,
      hi = content.length - state.offset;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      fragment.content = content.slice(state.offset, state.offset + mid);
      const size = Buffer.byteLength(
        JSON.stringify({ ...output, records: [...output.records, fragment] }),
      );
      if (size <= historyPageBytes - 256) lo = mid;
      else hi = mid - 1;
    }
    if (lo && /[\uD800-\uDBFF]/.test(content.charAt(state.offset + lo - 1)))
      lo--;
    if (!lo) {
      if (!output.records.length)
        throw new RunnerError(
          "PROJECT_HISTORY_UNAVAILABLE",
          "历史记录来源字段过长，无法生成有界页面。",
        );
      break;
    }
    fragment.content = content.slice(state.offset, state.offset + lo);
    output.records.push(fragment);
    state.offset += lo;
    if (state.offset === content.length) {
      state.index++;
      state.offset = 0;
    } else break;
  }
  state.nextCursor =
    state.index < history.records.length
      ? cursorFor(state.key, state.index, state.offset)
      : null;
  state.deliveredRecords = state.index;
  state.pagesRead++;
  if (request.notes !== undefined) state.notes = request.notes;
  output.nextCursor = state.nextCursor;
  output.deliveredRecords = state.deliveredRecords;
  if (cursor) state.previous = { cursor, output };
  return { state, output };
}
