import { z } from "zod";
import type { SummaryReadProgress } from "./contracts";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const summaryReadProgressSchema = z
  .strictObject({
    mode: z.literal("project").optional(),
    filesRead: count.optional(),
    historyReads: count.optional(),
    phase: z.enum(["collecting", "reading_cache", "reading", "summarizing"]),
    totalRecords: count.nullable(),
    readRecords: count,
    cachedRecords: count,
    pagesRead: count,
    startedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    model: z.string().min(1).max(100),
    effort: z.string().min(1).max(20),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (v.mode === "project") {
      if (v.totalRecords !== null || v.readRecords || v.cachedRecords ||
        !["reading", "summarizing"].includes(v.phase)) issue("On-demand project reads have no history total");
      return;
    }
    if (v.totalRecords === null) {
      if (v.phase !== "collecting" || v.readRecords || v.cachedRecords)
        issue("Collection totals are not known yet");
    } else if (v.readRecords + v.cachedRecords > v.totalRecords)
      issue("Read progress exceeds history total");
    if (
      v.phase === "summarizing" &&
      (v.totalRecords === null ||
        v.readRecords + v.cachedRecords !== v.totalRecords)
    )
      issue("Report synthesis requires complete history");
  }) satisfies z.ZodType<SummaryReadProgress>;
