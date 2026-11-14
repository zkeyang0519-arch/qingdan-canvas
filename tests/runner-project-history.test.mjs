import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";

let api;
try {
  const { outputFiles } = await build({
    stdin: {
      contents: "export * from './runner/project-history.ts'",
      resolveDir: path.resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  api = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
} catch (error) {
  test("project history collector is available", () =>
    assert.fail(error.message));
}

const root = path.resolve(".tmp/history-project");
const assistant = (id, text, phase = "final_answer") => ({
  type: "agentMessage",
  id,
  text,
  phase,
});
const turn = (id, text, extra = {}) => ({
  id,
  status: "completed",
  completedAt: 100,
  startedAt: 90,
  itemsView: "full",
  items: [assistant(id + "-final", text)],
  ...extra,
});
const thread = (id, turns, extra = {}) => ({
  id,
  cwd: root,
  name: "开发记录 " + id,
  updatedAt: 100,
  turns,
  ...extra,
});
function fixture(threads, override) {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (override) {
        const result = await override(method, params);
        if (result !== undefined) return result;
      }
      if (method === "thread/list") {
        const entries = threads.filter((t) => !!t.archived === params.archived);
        const offset = Number(params.cursor || 0);
        return {
          data: entries.slice(offset, offset + 1),
          nextCursor: offset + 1 < entries.length ? String(offset + 1) : null,
        };
      }
      const t = threads.find((t) => t.id === params.threadId);
      assert.ok(t, params.threadId);
      if (method === "thread/read") return { thread: t };
      if (method === "thread/turns/list") {
        const entries = [...t.turns].reverse(),
          offset = Number(params.cursor || 0);
        return {
          data: entries.slice(offset, offset + 1),
          nextCursor: offset + 1 < entries.length ? String(offset + 1) : null,
        };
      }
      assert.fail("Unexpected mutation or RPC " + method);
    },
  };
  return { client, calls };
}
const summary = (evidenceRef) => ({
  overview: "进度",
  completed: [{ text: "已实现", evidenceRef }],
  inProgress: [],
  pending: [],
  blockers: [],
  verification: [],
  uncertainties: [],
});

if (api) {
  test(
    "Windows directory casing and separators match the selected project exactly",
    { skip: process.platform !== "win32" },
    async () => {
      const f = fixture([
        thread("windows", [turn("one", "当前项目")], {
          cwd: root.toLowerCase().replaceAll("\\", "/") + "/",
        }),
      ]);
      const history = await api.collectProjectHistory(f.client, root);
      assert.equal(history.records.length, 1);
    },
  );
  test("an asynchronous authority checkpoint aborts collection instead of becoming a partial success", async () => {
    const f = fixture([
      thread("a", [turn("a1", "完成")]),
      thread("b", [turn("b1", "完成")]),
    ]);
    await assert.rejects(
      api.collectProjectHistory(f.client, root, {
        checkpoint: async () => {
          if (f.calls.some((call) => call.method === "thread/read"))
            throw Error("authority cancelled");
        },
      }),
      /authority cancelled/,
    );
    assert.ok(!f.calls.some((call) => call.method === "thread/turns/list"));
  });

  test("cross-project fork ancestry is excluded without reading foreign turn content", async () => {
    const foreign = thread(
      "foreign",
      [turn("foreign-turn", "其他项目的内容")],
      { cwd: root + "-other" },
    );
    const fork = thread(
      "forked",
      [turn("foreign-turn", "其他项目的内容"), turn("new-turn", "新项目内容")],
      { forkedFromId: "foreign" },
    );
    const second = thread("second-fork", fork.turns, {
      forkedFromId: "forked",
    });
    const f = fixture([
      foreign,
      fork,
      second,
      thread("safe", [turn("safe-turn", "当前项目内容")]),
    ]);
    const history = await api.collectProjectHistory(f.client, root);
    assert.deepEqual(
      history.records.map((r) => r.text),
      ["当前项目内容"],
    );
    assert.equal(history.coverage.excludedForkCount, 2);
    assert.ok(
      !f.calls.some(
        (c) =>
          c.method === "thread/turns/list" &&
          ["foreign", "forked", "second-fork"].includes(c.params.threadId),
      ),
    );
    assert.ok(
      f.calls
        .filter((c) => c.method === "thread/read")
        .every((c) => c.params.includeTurns === false),
    );
  });

  test("private key blocks are removed including incomplete PEM blocks", async () => {
    const f = fixture([
      thread("keys", [
        turn(
          "pem",
          "说明\n-----BEGIN OPENSSH PRIVATE KEY-----\nSENSITIVE_BASE64_BLOCK\n-----END OPENSSH PRIVATE KEY-----\n仍需完成的工作",
        ),
        turn("broken-key", "-----BEGIN RSA PRIVATE KEY-----\nTRUNCATED_SECRET"),
      ]),
    ]);
    const history = await api.collectProjectHistory(f.client, root);
    assert.doesNotMatch(
      JSON.stringify(history),
      /SENSITIVE_BASE64_BLOCK|TRUNCATED_SECRET|BEGIN .*PRIVATE KEY/,
    );
    assert.match(JSON.stringify(history), /仍需完成的工作/);
  });

  test("collects all pages and archived project finals without reading other projects or summary threads", async () => {
    const f = fixture([
      thread("a", [turn("a1", "完成登录"), turn("a2", "完成删除")]),
      thread("other", [turn("x", "别的项目秘密")], { cwd: root + "-other" }),
      thread("nested", [turn("n", "子目录另一个项目")], {
        cwd: path.join(root, "nested"),
      }),
      thread("generated", [turn("g", "旧汇总")], { name: "轻单 · 项目总结" }),
      thread("current", [turn("c", "本轮")]),
      thread("child", [turn("s", "子 agent")], { parentThreadId: "a" }),
      thread("temporary", [turn("e", "临时")], { ephemeral: true }),
      thread("archived", [turn("old", "最初实现")], { archived: true }),
    ]);
    const history = await api.collectProjectHistory(f.client, root, {
      excludeThreadIds: ["current"],
    });
    assert.deepEqual(
      history.records.map((r) => r.text).sort(),
      ["完成删除", "完成登录", "最初实现"].sort(),
    );
    assert.equal(history.coverage.threadCount, 2);
    assert.equal(history.coverage.summaryCount, 3);
    assert.equal(history.coverage.omittedCount, 0);
    assert.equal(history.mode, "codex_history");
    assert.ok(
      !f.calls.some(
        (c) =>
          c.params.threadId &&
          [
            "other",
            "nested",
            "generated",
            "current",
            "child",
            "temporary",
          ].includes(c.params.threadId),
      ),
    );
    assert.ok(
      f.calls.some((c) => c.method === "thread/list" && c.params.archived),
    );
    for (const record of history.records)
      assert.equal(
        api.validateHistoryReferences(summary(record.source), history).overview,
        "进度",
      );
    assert.throws(
      () => api.validateHistoryReferences(summary("README.md"), history),
      /来源|记录/,
    );
  });

  test("completed finals remain distinct from unfinished status; legacy phase and copied turns are handled", async () => {
    const shared = turn("shared", "最终结果", {
      items: [
        assistant("comment", "正在处理", "commentary"),
        assistant("final", "最终结果"),
      ],
    });
    const f = fixture([
      thread("a", [
        shared,
        turn("running", "未完成", { status: "inProgress" }),
        turn("failed", "失败输出", { status: "failed" }),
        turn("legacy", "", {
          items: [
            assistant("old", "旧进展", null),
            assistant("legacy-final", "旧版最终答复", null),
          ],
        }),
        turn("no-final", "", {
          items: [assistant("comment-only", "仍在检查", "commentary")],
        }),
      ]),
      thread("fork", [shared], { forkedFromId: "a" }),
    ]);
    const history = await api.collectProjectHistory(f.client, root);
    assert.deepEqual(
      history.records.filter((r) => r.kind !== "status").map((r) => r.text).sort(),
      ["最终结果", "旧版最终答复"].sort(),
    );
    assert.equal(history.coverage.incompleteTurnCount, 2);
    assert.equal(history.coverage.missingFinalCount, 1);
    assert.equal(history.coverage.duplicateCount, 1);
    assert.deepEqual(history.records.filter((r) => r.kind === "status").map(r => r.status).sort(), ["failed", "inProgress"]);
  });

  test("large history retains every record and long tail while redacting credentials", async () => {
    const turns = Array.from({ length: 14 }, (_, i) =>
      turn(
        "t" + i,
        `记录${i}\npassword = hidden-value\n${"内容".repeat(10000)}`,
        { completedAt: 100 + i },
      ),
    );
    const history = await api.collectProjectHistory(
      fixture([thread("large", turns)]).client,
      root,
    );
    assert.equal(history.coverage.summaryCount, 14);
    assert.equal(history.coverage.omittedCount, 0);
    assert.equal(history.coverage.truncatedCount, 0);
    assert.ok(JSON.stringify(history).length > 120000);
    assert.equal(history.records.length, 14);
    assert.ok(history.records.some((r) => r.turnId === "t13"));
    assert.ok(!JSON.stringify(history).includes("hidden-value"));
    assert.ok(history.records.every((r) => r.text.length > 16000));
    assert.equal(
      api.validateHistoryReferences(summary("native:history"), history)
        .overview,
      "进度",
    );
  });

  test("preserves user requirements and later corrections with each result", async () => {
    const history = await api.collectProjectHistory(fixture([thread("requirements", [turn("req", "已增加导出", {
      items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "项目用于离线清单管理，需要 JSON 和 CSV 导出" }] },
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "CSV 留到下一版\npassword = SECRET" }] },
        assistant("done", "已增加 JSON 导出，CSV 尚未实现"),
      ],
    })])]).client, root);
    assert.match(history.records[0].request, /离线清单管理/);
    assert.match(history.records[0].request, /CSV 留到下一版/);
    assert.doesNotMatch(JSON.stringify(history), /SECRET/);
  });

  test("bounded pages reconstruct all history including escaped text and emoji without input injection", async () => {
    const history = await api.collectProjectHistory(fixture([thread("long", Array.from({ length: 23 }, (_, i) => turn(`t${i}`, `开头${i}\n${'中文😀\\"\n'.repeat(1900)}尾部${i}`, { completedAt: i }))) ]).client, root);
    let state = api.initialHistoryRead(history);
    const manifest = api.historyManifest(history, state);
    assert.equal(manifest.records, undefined);
    assert.ok(JSON.stringify(manifest).length < 5000);
    const reconstructed = new Map();
    let pages = 0;
    while (state.nextCursor !== null) {
      const before = structuredClone(state);
      const result = api.readHistoryPage(history, state, { cursor: state.nextCursor, notes: "模块导出仍待核对" });
      assert.ok(Buffer.byteLength(JSON.stringify(result.output)) <= api.historyPageBytes);
      assert.deepEqual(state, before, "reader must not mutate caller state");
      for (const part of result.output.records) {
        const prior = reconstructed.get(part.source) ?? "";
        assert.equal(part.offset, prior.length);
        reconstructed.set(part.source, prior + part.content);
      }
      const retry = api.readHistoryPage(history, result.state, { cursor: state.nextCursor });
      assert.deepEqual(retry.output, result.output);
      assert.deepEqual(retry.state, result.state);
      state = JSON.parse(JSON.stringify(result.state));
      assert.ok(++pages < 1000);
    }
    assert.ok(pages > 20);
    assert.equal(state.deliveredRecords, history.records.length);
    assert.equal(reconstructed.size, history.records.length);
    for (const record of history.records) assert.deepEqual(JSON.parse(reconstructed.get(record.source)), record);
    assert.equal(state.notes, "模块导出仍待核对");
    assert.equal(api.historyManifest(history, state).nextCursor, null);
    assert.throws(() => api.readHistoryPage(history, state, { cursor: "bogus" }), /游标/);
    const other = { ...history, capturedAt: "other-snapshot" };
    assert.throws(() => api.readHistoryPage(other, api.initialHistoryRead(other), { cursor: api.initialHistoryRead(history).nextCursor }), /游标/);
  });

  test("initial request replay after a lost response and restart never skips the first page", async () => {
    const history = await api.collectProjectHistory(fixture([thread("retry", [turn("long", "正文".repeat(18000))])]).client, root);
    const first = api.readHistoryPage(history, api.initialHistoryRead(history), {});
    const restored = JSON.parse(JSON.stringify(first.state));
    for (const request of [{}, { cursor: null }]) {
      const replay = api.readHistoryPage(history, restored, request);
      assert.deepEqual(replay.output, first.output);
      assert.deepEqual(replay.state, restored);
      assert.equal(replay.output.records[0].offset, 0);
    }
    assert.equal(restored.deliveredRecords, 0);
    assert.equal(api.historyManifest(history, restored).replayCursor, restored.previous.cursor);
    assert.ok(first.output.receipt);
  });

  test("empty history is explicit, unreadable threads are disclosed, and total failure is not empty success", async () => {
    const empty = await api.collectProjectHistory(fixture([]).client, root);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.coverage.threadCount, 0);
    const entries = [thread("good", [turn("ok", "完成")]), thread("bad", [])];
    const override = (method, p) => {
      if (method === "thread/read" && p.threadId === "bad")
        throw Error("unavailable");
    };
    const partial = await api.collectProjectHistory(
      fixture(entries, override).client,
      root,
    );
    assert.equal(partial.records.length, 1);
    assert.equal(partial.coverage.failedThreadCount, 1);
    await assert.rejects(
      api.collectProjectHistory(fixture([entries[1]], override).client, root),
      /读取|记录/,
    );
  });

  test("mismatched metadata and stalled pagination never leak another project or claim full coverage", async () => {
    const f = fixture(
      [thread("moved", [turn("leak", "不可发送")])],
      (method, p) =>
        method === "thread/read"
          ? { thread: thread("moved", [], { cwd: root + "-elsewhere" }) }
          : undefined,
    );
    await assert.rejects(
      api.collectProjectHistory(f.client, root),
      /读取|记录/,
    );
    assert.ok(!f.calls.some((c) => c.method === "thread/turns/list"));
    const looping = fixture([], (method) =>
      method === "thread/list" ? { data: [], nextCursor: "same" } : undefined,
    );
    await assert.rejects(
      api.collectProjectHistory(looping.client, root),
      /分页/,
    );
  });

  test("cancellation guard stops further history reads", async () => {
    const f = fixture([thread("a", [turn("one", "完成")])]);
    let checks = 0;
    await assert.rejects(
      api.collectProjectHistory(f.client, root, {
        assertCurrent() {
          if (++checks > 2) throw Error("cancelled");
        },
      }),
      /cancelled/,
    );
    assert.ok(f.calls.length <= 2);
  });
}
