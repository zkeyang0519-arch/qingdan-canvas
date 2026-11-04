import test from "node:test";
import assert from "node:assert/strict";
import { startExperience } from "../scripts/lib/agent-experience-launcher.mjs";

test("stopping during runner build does not initialize or start the worker afterward", async () => {
  let stopped = false,
    built,
    calls = 0,
    ready = false;
  const completion = startExperience({
    root: "D:/project",
    isClosing: () => stopped,
    onReady: () => {
      ready = true;
    },
    run: async () => {
      calls++;
      await new Promise((resolve) => {
        built = resolve;
      });
    },
  });
  stopped = true;
  built();
  await completion;
  assert.equal(calls, 1);
  assert.equal(ready, false);
});

test("an already-stopped launcher creates no subprocess", async () => {
  await startExperience({
    root: "D:/project",
    isClosing: () => true,
    run: () => assert.fail("must not run"),
    onReady: () => assert.fail("must not initialize"),
  });
});

test("async Runner initialization is awaited and shutdown prevents a late worker launch", async () => {
  let stopped = false,
    finish;
  const calls = [];
  const completion = startExperience({
    root: "D:/project",
    isClosing: () => stopped,
    run: async (script) => calls.push(script),
    onReady: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  stopped = true;
  finish();
  await completion;
  assert.equal(calls.length, 1);
});
