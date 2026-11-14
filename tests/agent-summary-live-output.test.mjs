import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dom = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const dir = await mkdtemp(path.resolve("node_modules/.cache/summary-stream-"));
let Component;
try {
  await build({
    entryPoints: [path.resolve("src/agent/SummaryLiveOutput.jsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    outfile: path.join(dir, "ui.mjs"),
    logLevel: "silent",
  });
  Component = (await import(pathToFileURL(path.join(dir, "ui.mjs")))).default;
} catch (error) {
  test("summary live output component exists", () =>
    assert.fail(error.message));
}
test.after(() => rm(dir, { recursive: true, force: true }));
const event = (seq, text, runId = "run") => ({
  eventId: `event-${runId}-${seq}`,
  seq,
  runId,
  type: "output.delta",
  payload: { text },
});
const response = (events, extra = {}) => ({
  result: {
    run: { runId: "run", terminal: false },
    events,
    nextAfterSeq: events.at(-1)?.seq ?? 0,
    hasMore: false,
    ...extra,
  },
});
if (Component) {
  test("a ready project and terminal report cannot hide delayed final output", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = createRoot(document.getElementById("root"));
    t.after(async () => act(() => root.unmount()));
    let first;
    const cursors = [];
    const call = async (_route, options) => {
      cursors.push(options.body.arguments.afterSeq);
      if (cursors.length === 1)
        return new Promise((resolve) => {
          first = resolve;
        });
      if (cursors.length === 2)
        return response([], {
          nextAfterSeq: 1,
          run: {
            runId: "run",
            turnId: "current",
            terminal: true,
            status: "verifying",
          },
        });
      return response(
        [
          event(2, "最后一段总结"),
          {
            seq: 3,
            eventId: "completed",
            runId: "run",
            turnId: "current",
            type: "turn.completed",
            payload: {},
          },
        ],
        {
          run: {
            runId: "run",
            turnId: "current",
            terminal: true,
            status: "verifying",
          },
        },
      );
    };
    await act(async () =>
      root.render(
        React.createElement(Component, {
          bindingId: "bound",
          runId: "run",
          call,
          finished: false,
        }),
      ),
    );
    await act(async () =>
      root.render(
        React.createElement(Component, {
          bindingId: "bound",
          runId: "run",
          call,
          finished: true,
        }),
      ),
    );
    await act(async () =>
      first(
        response([event(1, "部分输出")], {
          run: { runId: "run", turnId: "current", terminal: false },
        }),
      ),
    );
    assert.doesNotMatch(document.body.textContent, /本次输出已结束/);
    await act(async () => t.mock.timers.tick(1000));
    assert.doesNotMatch(document.body.textContent, /本次输出已结束/);
    await act(async () => t.mock.timers.tick(1000));
    assert.match(document.body.textContent, /最后一段总结/);
    assert.match(document.body.textContent, /本次输出已结束/);
    assert.deepEqual(cursors, [0, 1, 1]);
  });
  test("summary displays incremental text before completion and advances cursor without duplicate chunks", async (t) => {
    const root = createRoot(document.getElementById("root"));
    t.after(async () => act(() => root.unmount()));
    let next;
    const cursors = [];
    const call = async (_route, options) => {
      cursors.push(options.body.arguments.afterSeq);
      if (cursors.length === 1)
        return response([event(1, "正在读取 README.md\n")], { hasMore: true });
      return new Promise((resolve) => {
        next = resolve;
      });
    };
    await act(async () => {
      root.render(
        React.createElement(Component, {
          bindingId: "bound",
          runId: "run",
          call,
        }),
      );
    });
    assert.match(document.body.textContent, /正在读取 README.md/);
    assert.deepEqual(cursors, [0, 1]);
    await act(async () =>
      next(
        response(
          [event(1, "正在读取 README.md\n"), event(2, "已完成当前进度总结")],
          { run: { runId: "run", terminal: true, status: "cancelled" } },
        ),
      ),
    );
    assert.equal(
      document.body.textContent.match(/正在读取 README.md/g).length,
      1,
    );
    assert.match(document.body.textContent, /已完成当前进度总结/);
  });
  test("switching projects discards delayed output from the previous run", async (t) => {
    const root = createRoot(document.getElementById("root"));
    t.after(async () => act(() => root.unmount()));
    let oldReply;
    const call = async (_route, options) =>
      options.body.bindingId === "old"
        ? new Promise((resolve) => {
            oldReply = resolve;
          })
        : response([event(1, "新项目输出", "new-run")], {
            run: { runId: "new-run", terminal: true, status: "cancelled" },
          });
    await act(async () =>
      root.render(
        React.createElement(Component, {
          bindingId: "old",
          runId: "run",
          call,
        }),
      ),
    );
    await act(async () =>
      root.render(
        React.createElement(Component, {
          bindingId: "new",
          runId: "new-run",
          call,
        }),
      ),
    );
    await act(async () => oldReply(response([event(1, "旧项目私有输出")])));
    assert.match(document.body.textContent, /新项目输出/);
    assert.doesNotMatch(document.body.textContent, /旧项目私有输出/);
  });
  test("temporary connection errors retry the same cursor and recover the stream", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = createRoot(document.getElementById("root"));
    t.after(async () => act(() => root.unmount()));
    let calls = 0;
    const call = async () => {
      if (++calls === 1) throw Error("暂时断线");
      return response([event(1, "已恢复读取")], {
        run: { runId: "run", terminal: true, status: "cancelled" },
      });
    };
    await act(async () =>
      root.render(
        React.createElement(Component, {
          bindingId: "bound",
          runId: "run",
          call,
        }),
      ),
    );
    assert.match(document.body.textContent, /暂时断线/);
    await act(async () => t.mock.timers.tick(1000));
    assert.match(document.body.textContent, /已恢复读取/);
    assert.doesNotMatch(document.body.textContent, /暂时断线/);
  });
}
