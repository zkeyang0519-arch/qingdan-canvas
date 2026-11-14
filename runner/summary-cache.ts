import { createHash } from "node:crypto";
import type {
  ExecutionSnapshot,
  ProjectSummary,
} from "../shared/agent/contracts";
import { projectSummarySchema } from "../shared/agent/schemas";
import { summarySourceItems } from "../shared/agent/progress";
import type { ProjectHistory, ProjectHistoryRecord } from "./project-history";
import type { RunRecord } from "./types";
import { rootKey } from "./workspace";

export type SummaryHistoryCache = {
  version: 1;
  sourceRunId: string;
  capturedAt: string;
  reusedSources: string[];
  report: ProjectSummary;
};
const fingerprint = (r: ProjectHistoryRecord) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        r.source,
        r.threadId,
        r.turnId,
        r.title,
        r.completedAt,
        r.request ?? "",
        r.text,
        r.kind ?? "result",
        r.status ?? "completed",
        r.truncated,
      ]),
    )
    .digest("hex");
const completeCapture = (h: ProjectHistory) =>
  h.version === 2 &&
  !h.coverage.failedThreadCount &&
  !h.coverage.omittedCount &&
  !h.coverage.truncatedCount &&
  !h.coverage.excludedForkCount &&
  h.coverage.includedCount === h.records.length;

export function selectHistoryCache(
  history: ProjectHistory,
  snapshot: ExecutionSnapshot,
  root: string,
  runs: RunRecord[],
): SummaryHistoryCache | undefined {
  if (!completeCapture(history) || snapshot.kind !== "summary") return;
  const current = new Map(
    history.records.map((r) => [r.source, fingerprint(r)]),
  );
  if (current.size !== history.records.length) return;
  const candidates = runs
    .toReversed()
    .sort((a, b) =>
      (b.summaryHistory?.capturedAt ?? "").localeCompare(
        a.summaryHistory?.capturedAt ?? "",
      ),
    );
  for (const old of candidates) {
    const previous = old.summaryHistory;
    if (
      old.runId === snapshot.runId ||
      old.snapshot.kind !== "summary" ||
      old.active ||
      !old.terminal ||
      !old.resultValid ||
      old.cancelRequested ||
      old.status !== "verifying" ||
      !previous ||
      !completeCapture(previous) ||
      !old.summaryHistoryRead ||
      old.summaryHistoryRead.nextCursor !== null ||
      old.summaryHistoryRead.deliveredRecords !==
        historyReadInput(previous, old.summaryHistoryCache).records.length ||
      rootKey(old.root) !== rootKey(root) ||
      rootKey(previous.cwd) !== rootKey(history.cwd) ||
      (
        [
          "ownerId",
          "bindingId",
          "bindingRevision",
          "workspaceId",
          "memoryEpoch",
        ] as const
      ).some((k) => old.snapshot[k] !== snapshot[k])
    )
      continue;
    const parsed = projectSummarySchema.safeParse(old.result);
    if (!parsed.success || !parsed.data.background || !parsed.data.modules)
      continue;
    const known = new Set(previous.records.map((r) => r.source));
    if (
      known.size !== previous.records.length ||
      summarySourceItems(parsed.data).some(
        (i) =>
          i.evidenceRef &&
          i.evidenceRef !== "native:history" &&
          !known.has(i.evidenceRef),
      )
    )
      continue;
    const reusedSources: string[] = [];
    let invalid = false;
    for (const record of previous.records) {
      if (current.get(record.source) === fingerprint(record))
        reusedSources.push(record.source);
      else {
        invalid = true;
        break;
      }
    }
    // Summary/background fields do not have complete fact-level provenance.
    // Any changed/deleted input requires rebuilding instead of guessing which
    // claims can be kept or silently dropping uncited/aggregate facts.
    if (invalid) return;
    if (!reusedSources.length) continue;
    const report = structuredClone(parsed.data);
    delete report.coverage;
    return {
      version: 1,
      sourceRunId: old.runId,
      capturedAt: previous.capturedAt,
      reusedSources,
      report,
    };
  }
}

// Even a large cached report is delivered through the same bounded page tool.
// Full current history remains stored separately for source validation/auditing.
export function historyReadInput(
  history: ProjectHistory,
  cache?: SummaryHistoryCache,
): ProjectHistory {
  if (!cache) return history;
  const reused = new Set(cache.reusedSources);
  return {
    ...history,
    records: [
      {
        source: "native:cached-summary",
        threadId: "cache",
        turnId: cache.sourceRunId,
        title: "已完成的历史项目进度（缓存）",
        completedAt: null,
        kind: "result",
        status: "completed",
        truncated: false,
        text: JSON.stringify({
          capturedAt: cache.capturedAt,
          report: cache.report,
        }),
      },
      ...history.records.filter((r) => !reused.has(r.source)),
    ],
  };
}
