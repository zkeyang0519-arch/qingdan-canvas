import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { makeSnapshot } from "./fixtures/agent-fixtures.mjs";
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './runner/project-history';",
    resolveDir: path.resolve("."),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const root = path.resolve(".tmp/cache-project");
const snapshot = () =>
  makeSnapshot({ kind: "summary", runId: "next", snapshotId: "next-snapshot" });
const record = (n, extra = {}) => ({
  source: `codex:thread/turn-${n}/answer`,
  threadId: "thread",
  turnId: `turn-${n}`,
  title: "导出",
  completedAt: n,
  text: `完成 JSON 导出 ${n}`,
  request: "需要离线清单",
  kind: "result",
  status: "completed",
  truncated: false,
  ...extra,
});
const history = (records) => ({
  mode: "codex_history",
  version: 2,
  cwd: root,
  capturedAt: "2026-11-12T08:00:00.000Z",
  records,
  coverage: {
    threadCount: 1,
    summaryCount: records.length,
    includedCount: records.length,
    omittedCount: 0,
    truncatedCount: 0,
    incompleteTurnCount: 0,
    missingFinalCount: 0,
    duplicateCount: 0,
    failedThreadCount: 0,
    excludedForkCount: 0,
    oldestIncludedAt: 1,
    newestIncludedAt: records.length,
  },
});
const report = (source) => ({
  overview: "清单导出已有实现",
  background: {
    name: "离线清单",
    purpose: "管理个人待办",
    stage: "导出完善中",
  },
  modules: [
    {
      name: "导出",
      status: "partial",
      current: [{ text: "已完成 JSON", evidenceRef: source }],
      remaining: [],
      nextSteps: [],
    },
  ],
  completed: [],
  inProgress: [],
  pending: [],
  blockers: [],
  verification: [],
  uncertainties: [],
});
function prior(h = history([record(1)])) {
  let read = api.initialHistoryRead(h);
  while (read.nextCursor)
    read = api.readHistoryPage(h, read, { cursor: read.nextCursor }).state;
  return {
    runId: "previous",
    snapshot: { ...snapshot(), runId: "previous" },
    root,
    active: false,
    terminal: true,
    resultValid: true,
    cancelRequested: false,
    status: "verifying",
    summaryHistory: h,
    summaryHistoryRead: read,
    result: report(h.records[0].source),
  };
}

test("unchanged records reuse the last valid report while new history is fully paged", () => {
  const old = history(
    Array.from({ length: 100 }, (_, i) =>
      record(i + 1, { text: "旧记录".repeat(3000) }),
    ),
  );
  const next = history([
    ...old.records,
    record(101, { text: "新增中文😀".repeat(4000) + "末尾更正：先撤销" }),
  ]);
  const cache = api.selectHistoryCache(next, snapshot(), root, [prior(old)]);
  assert.equal(cache.reusedSources.length, 100);
  assert.equal(cache.sourceRunId, "previous");
  const input = api.historyReadInput(next, cache);
  assert.equal(input.records.length, 2);
  assert.equal(input.records[0].source, "native:cached-summary");
  assert.equal(input.records[1].source, record(101).source);
  let read = api.initialHistoryRead(input),
    body = "";
  while (read.nextCursor) {
    const p = api.readHistoryPage(input, read, { cursor: read.nextCursor });
    assert.ok(Buffer.byteLength(JSON.stringify(p.output)) <= 10000);
    body += p.output.records.map((r) => r.content).join("");
    read = p.state;
  }
  assert.match(body, /末尾更正：先撤销/);
  assert.doesNotMatch(body, /旧记录旧记录/);
  assert.equal(next.records.length, 101);
  assert.deepEqual(
    api.historyReadInput(next, JSON.parse(JSON.stringify(cache))),
    input,
  );
});

test("cache cannot cross owner, binding revision, workspace, memory epoch or directory", () => {
  const h = history([record(1)]),
    old = prior(h);
  for (const [key, value] of [
    ["ownerId", "other"],
    ["bindingId", "other"],
    ["bindingRevision", 99],
    ["workspaceId", "other"],
    ["memoryEpoch", 99],
  ]) {
    assert.equal(
      api.selectHistoryCache(h, { ...snapshot(), [key]: value }, root, [old]),
      undefined,
      key,
    );
  }
  assert.equal(
    api.selectHistoryCache(h, snapshot(), root + "-other", [old]),
    undefined,
  );
});

test("failed, unfinished, unread, legacy or partial snapshots are never cache sources", () => {
  const h = history([record(1)]),
    old = prior(h);
  for (const patch of [
    { active: true },
    { terminal: false },
    { resultValid: false },
    { cancelRequested: true },
    { status: "failed" },
    { summaryHistoryRead: { ...old.summaryHistoryRead, nextCursor: "unread" } },
    { summaryHistory: { ...h, version: undefined } },
    {
      summaryHistory: {
        ...h,
        coverage: { ...h.coverage, failedThreadCount: 1 },
      },
    },
  ])
    assert.equal(
      api.selectHistoryCache(h, snapshot(), root, [{ ...old, ...patch }]),
      undefined,
    );
  assert.equal(
    api.selectHistoryCache(
      { ...h, coverage: { ...h.coverage, failedThreadCount: 1 } },
      snapshot(),
      root,
      [old],
    ),
    undefined,
  );
});

test("edited or deleted completed evidence forces a complete rebuild", () => {
  const h = history([record(1), record(2)]),
    old = prior(h);
  assert.equal(
    api.selectHistoryCache(
      history([record(1, { text: "撤回先前完成声明" }), record(2)]),
      snapshot(),
      root,
      [old],
    ),
    undefined,
  );
  assert.equal(
    api.selectHistoryCache(history([record(2)]), snapshot(), root, [old]),
    undefined,
  );
});

test("changed unfinished states rebuild from current evidence without stale cached facts", () => {
  const pending = record(2, {
    source: "codex:thread/turn-2/status",
    kind: "status",
    status: "inProgress",
    text: "OLD_PENDING",
  });
  const h = history([record(1), pending]),
    old = prior(h);
  old.result.modules[0].remaining = [
    { text: "OLD_PENDING", evidenceRef: pending.source },
  ];
  old.result.overview = "OLD_PENDING";
  old.result.background.stage = "OLD_PENDING";
  const next = history([
    record(1),
    { ...pending, text: "现在被取消", status: "interrupted" },
  ]);
  const cache = api.selectHistoryCache(next, snapshot(), root, [old]);
  assert.equal(cache, undefined);
  const input = api.historyReadInput(next, cache);
  assert.doesNotMatch(JSON.stringify(input), /OLD_PENDING/);
  assert.match(JSON.stringify(input), /现在被取消/);
  assert.equal(input.records[0].text, record(1).text);
});

test("unchanged histories use only bounded cached summary pages and reject foreign references", () => {
  const h = history([record(1)]),
    old = prior(h);
  const cache = api.selectHistoryCache(h, snapshot(), root, [old]);
  assert.equal(api.historyReadInput(h, cache).records.length, 1);
  old.result.modules[0].current[0].evidenceRef = "codex:foreign/turn/answer";
  assert.equal(api.selectHistoryCache(h, snapshot(), root, [old]), undefined);
});

test("new history notes are bounded but prior long-note runs remain resumable", () => {
  const h = history([record(1)]),
    read = api.initialHistoryRead(h);
  assert.throws(() =>
    api.readHistoryPage(h, read, { notes: "字".repeat(1801) }),
  );
  const legacy = { ...read };
  delete legacy.notesLimit;
  assert.equal(
    api.readHistoryPage(h, legacy, { notes: "字".repeat(2000) }).state.notes
      .length,
    2000,
  );
});

test("status changes cannot discard stable facts with aggregate or missing provenance", () => {
  for (const evidenceRef of ["native:history", undefined]) {
    const pending = record(2, {
      source: "codex:thread/turn-2/status",
      kind: "status",
      status: "inProgress",
    });
    const h = history([record(1), pending]),
      old = prior(h);
    old.result.modules[0].current = [
      { text: "稳定功能不可丢失", ...(evidenceRef ? { evidenceRef } : {}) },
    ];
    const next = history([record(1), { ...pending, text: "状态已有变化" }]);
    assert.equal(
      api.selectHistoryCache(next, snapshot(), root, [old]),
      undefined,
    );
    assert.equal(api.historyReadInput(next).records[0].text, record(1).text);
  }
});

test("deleting status evidence cannot retain its unsupported project background", () => {
  const pending = record(2, {
    source: "codex:thread/turn-2/status",
    kind: "status",
    status: "inProgress",
    request: "项目改为团队协作",
  });
  const old = prior(history([record(1), pending]));
  old.result.background.purpose = "团队协作";
  const next = history([record(1)]);
  assert.equal(
    api.selectHistoryCache(next, snapshot(), root, [old]),
    undefined,
  );
  assert.doesNotMatch(JSON.stringify(api.historyReadInput(next)), /团队协作/);
});
