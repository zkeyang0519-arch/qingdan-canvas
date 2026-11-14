import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(path.resolve(".tmp/recent-history-test-"));
let api;
try {
  await build({
    entryPoints: ["runner/project-recent-history.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(dir, "api.mjs"),
    logLevel: "silent",
  });
  api = await import(pathToFileURL(path.join(dir, "api.mjs")));
} catch (error) {
  test("recent project history reader is available", () =>
    assert.fail(error.message));
}
test.after(() => rm(dir, { recursive: true, force: true }));

if (api) {
  const root = path.resolve(".tmp/selected-project");
  const thread = {
    id: "selected",
    cwd: root,
    name: "Recent work",
    updatedAt: 12,
    turns: [],
  };
  test("recent lookup returns one metadata page and excludes unrelated, forked and summary threads", async () => {
    const calls = [];
    const client = {
      request: async (method, args) => {
        calls.push([method, args]);
        assert.equal(method, "thread/list");
        return {
          data: [
            thread,
            { ...thread, id: "foreign", cwd: path.resolve("other") },
            { ...thread, id: "fork", forkedFromId: "elsewhere" },
            { ...thread, id: "summary", name: "轻单 · 项目总结" },
            { ...thread, id: "self" },
          ],
          nextCursor: "more",
        };
      },
    };
    const result = await api.readRecentHistory(
      client,
      root,
      { action: "list" },
      { excludeThreadIds: ["self"] },
    );
    assert.deepEqual(
      result.output.threads.map((t) => t.threadId),
      ["selected"],
    );
    assert.equal(result.output.nextCursor, "more");
    assert.equal(calls.length, 1, "must not exhaust history before returning");
    assert.deepEqual(result.sources, []);
  });
  test("recent read validates project before loading turns and never resumes source chats", async () => {
    const calls = [];
    const client = {
      request: async (method) => {
        calls.push(method);
        return { thread: { ...thread, cwd: path.resolve("other") } };
      },
    };
    await assert.rejects(
      api.readRecentHistory(client, root, {
        action: "read",
        threadId: "selected",
      }),
      /项目/,
    );
    assert.deepEqual(calls, ["thread/read"]);
  });
  test("recent read bounds long messages, preserves latest correction and redacts credentials", async () => {
    const calls = [];
    const client = {
      request: async (method, args) => {
        calls.push(method);
        if (method === "thread/read") return { thread };
        assert.equal(method, "thread/turns/list");
        assert.equal(args.sortDirection, "desc");
        return {
          data: [
            {
              id: "last",
              status: "completed",
              completedAt: 12,
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text:
                        "最初需求\n" +
                        "旧背景".repeat(4000) +
                        "\n最后更正：优先撤销",
                    },
                  ],
                },
                {
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "已实现基础编辑\napi_key=secret-value\n撤销待完成",
                },
              ],
            },
          ],
          nextCursor: "older",
        };
      },
    };
    const result = await api.readRecentHistory(client, root, {
      action: "read",
      threadId: "selected",
    });
    assert.equal(result.output.records.length, 1);
    assert.equal(result.output.records[0].truncated, true);
    assert.match(result.output.records[0].request, /最后更正：优先撤销/);
    assert.doesNotMatch(JSON.stringify(result.output), /secret-value/);
    assert.ok(JSON.stringify(result.output).length < 12000);
    assert.equal(result.output.nextCursor, "older");
    assert.deepEqual(result.sources, ["codex:selected:last"]);
    assert.deepEqual(calls, ["thread/read", "thread/turns/list"]);
  });
  test("cancellation between metadata and content prevents further reads", async () => {
    let cancelled = false;
    const client = {
      request: async () => {
        cancelled = true;
        return { thread };
      },
    };
    await assert.rejects(
      api.readRecentHistory(
        client,
        root,
        { action: "read", threadId: "selected" },
        {
          assertCurrent: () => {
            if (cancelled) throw Error("cancelled");
          },
        },
      ),
      /cancelled/,
    );
  });
}
