import type { SummaryReadProgress } from "../shared/agent/contracts";
import type { RunRecord } from "./types";
export function summaryReadProgress(
  run: RunRecord,
  now = new Date().toISOString(),
): SummaryReadProgress {
  if (run.summaryInspection?.mode === "current") return {
    mode: "project", phase: run.reportedResult ? "summarizing" : "reading",
    totalRecords: null, readRecords: 0, cachedRecords: 0,
    filesRead: new Set(run.summaryInspection.sources.filter(s => s.kind === "read" || s.kind === "search").map(s => s.path)).size,
    historyReads: run.summaryInspection.historySources?.length ?? 0,
    pagesRead: run.summaryProgress?.pagesRead ?? 0,
    startedAt: run.summaryProgress?.startedAt ?? now, updatedAt: now,
    model: run.summarySettings?.model ?? "gpt-6.1-terra", effort: run.summarySettings?.effort ?? "medium",
  };
  const history = run.summaryHistory,
    read = run.summaryHistoryRead,
    cache = run.summaryHistoryCache;
  return {
    phase:
      !history || !read
        ? "collecting"
        : cache && read.index === 0
          ? "reading_cache"
          : read.nextCursor
            ? "reading"
            : "summarizing",
    totalRecords: history?.records.length ?? null,
    readRecords: Math.max(0, (read?.deliveredRecords ?? 0) - (cache ? 1 : 0)),
    cachedRecords: cache?.reusedSources.length ?? 0,
    pagesRead: read?.pagesRead ?? 0,
    startedAt: run.summaryProgress?.startedAt ?? now,
    updatedAt: now,
    model: run.summarySettings?.model ?? "gpt-6.1-terra",
    effort: run.summarySettings?.effort ?? "medium",
  };
}
