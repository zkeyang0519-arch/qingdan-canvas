import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dir = mkdtempSync(resolve("node_modules/.cache/summary-progress-"));
await build({
  stdin: {
    contents:
      "export {ProjectSummaryCard} from './src/agent/ProjectSummaryPanel.jsx'; export {executionReportSchema} from './shared/agent/execution';",
    resolveDir: resolve("."),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "test.mjs"),
  logLevel: "silent",
});
const api = await import(pathToFileURL(resolve(dir, "test.mjs")));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const progress = {
  phase: "reading",
  totalRecords: 445,
  readRecords: 12,
  cachedRecords: 400,
  pagesRead: 3,
  startedAt: "2026-11-12T08:00:00.000Z",
  updatedAt: "2026-11-12T08:01:00.000Z",
  model: "gpt-6.1-terra",
  effort: "medium",
};
const render = (summaryProgress = progress, status = "running") =>
  renderToStaticMarkup(
    React.createElement(api.ProjectSummaryCard, {
      state: {
        status,
        summary: null,
        ready: false,
        activeRunId: "run",
        summaryProgress,
      },
    }),
  );
test("summary progress displays current reads separately from reused records and elapsed time", () => {
  const html = render();
  assert.match(html, /已读取 12 \/ 45 条/);
  assert.match(html, /复用 400 条/);
  assert.match(html, /第 3 页/);
  assert.match(html, /已用时/);
  assert.match(html, /最近进度/);
  assert.match(html, /<progress[^>]*value="412"[^>]*max="445"/);
});
test("fully read history says report is being organized without claiming completion", () => {
  const html = render({ ...progress, phase: "summarizing", readRecords: 45 });
  assert.match(html, /历史读取完成，正在整理模块报告/);
  assert.doesNotMatch(html, /Codex 已完成总结/);
});
test("loading cached summary does not prematurely show 100 percent", () => {
  const html = render({
    ...progress,
    phase: "reading_cache",
    readRecords: 0,
    cachedRecords: 445,
  });
  assert.match(html, /正在读取上次项目进度/);
  assert.match(html, /<progress[^>]*value="0"[^>]*max="445"/);
});
test("terminal failures hide stale read progress while old runners retain the fallback message", () => {
  assert.doesNotMatch(render(progress, "failed"), /<progress/);
  assert.match(render(null), /正在按需读取当前项目/);
});
test("native report validates progress counters and timestamps", () => {
  const report = {
    connectionEpoch: 1,
    runId: "run",
    commandId: "command",
    revision: 1,
    status: "running",
    threadId: "thread",
    turnId: "turn",
    terminal: false,
    stopConfirmed: false,
    summaryProgress: progress,
  };
  assert.equal(api.executionReportSchema.safeParse(report).success, true);
  for (const patch of [
    { readRecords: 46 },
    { cachedRecords: 446 },
    { totalRecords: null },
    { startedAt: "invalid" },
    { phase: "done" },
  ])
    assert.equal(
      api.executionReportSchema.safeParse({
        ...report,
        summaryProgress: { ...progress, ...patch },
      }).success,
      false,
    );
});

test("on-demand summary shows actual reads without a fake total or completion percentage", () => {
  const current = { ...progress, mode: "project", phase: "reading", totalRecords: null, readRecords: 0, cachedRecords: 0, filesRead: 3, historyReads: 2 };
  const html = render(current);
  assert.match(html, /已查看 3 个文件/);
  assert.match(html, /2 条最近记录/);
  assert.match(html, /Terra/);
  assert.doesNotMatch(html, /<progress|全部历史|条本次历史/);
  assert.equal(api.executionReportSchema.safeParse({ connectionEpoch: 1, runId: "run", commandId: "command", revision: 1, status: "running", threadId: "thread", turnId: "turn", terminal: false, stopConfirmed: false, summaryProgress: current }).success, true);
});
