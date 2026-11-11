import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWorkspaceRequests,
  workspaceScope,
} from "../src/agent/workspace-state.js";
import { browserLocks } from "./fixtures/browser-locks.mjs";
const dom = new JSDOM("", { url: "https://recovery.test" });
Object.assign(globalThis, { window: dom.window });
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
await mkdir(resolve(".tmp"), { recursive: true });
const out = await mkdtemp(resolve(".tmp/checklist-legacy-"));
await build({
  entryPoints: [resolve("src/agent/checklist-recovery.js")],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: resolve(out, "recovery.mjs"),
  logLevel: "silent",
});
const { migrateChecklistRequests, inspectChecklistRequest, legacyScope } =
  await import(pathToFileURL(resolve(out, "recovery.mjs")));
test.after(() => rm(out, { recursive: true, force: true }));
test.beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  navigator.locks = browserLocks();
});
const binding = {
  bindingId: "binding",
  revision: 1,
  runnerId: "runner",
  workspaceId: "workspace",
};
const context = {
  userId: "alice",
  roomId: "canvas",
  pageId: "section",
  binding,
};
const oldKey = `qingdan.agent-checklist-requests:${JSON.stringify(["alice", "canvas", "section", JSON.stringify(["binding", 1, "runner", "workspace"])])}`;
const store = () =>
  createWorkspaceRequests(
    workspaceScope({
      accountId: "alice",
      canvasId: "canvas",
      sectionId: "section",
      binding,
    }),
  );
const item = {
  text: "original",
  instruction: "requirement",
  acceptance: "check",
};
const target = {
  bindingId: "binding",
  bindingRevision: 1,
  kind: "task",
  sourceTasks: [
    { noteId: "note", taskId: "task", generation: 3, specRevision: 4 },
  ],
  autoComplete: false,
  executionPermissions: { profile: "workspace_manual" },
};
const input = {
  requestId: "dispatch",
  runId: "run",
  bindingId: "binding",
  bindingRevision: 1,
  kind: "task",
  snapshotId: "snapshot",
  payloadHash: "a".repeat(64),
};
const entry = (action, payload, requestId, input = null) => [
  JSON.stringify([action, payload]),
  { requestId, input },
];

test("legacy migration keeps exact create/save/reorder/intent/stop identities and original CAS", async () => {
  const entries = [
    entry("create", { tasks: [item] }, "create"),
    entry(
      "save",
      {
        noteId: "note",
        taskId: "task",
        expectedGeneration: 3,
        expectedSpecRevision: 4,
        text: "old text",
        instruction: "old requirement",
        acceptance: "old check",
      },
      "save",
    ),
    entry(
      "reorder",
      { expectedSequence: 27, order: [{ noteId: "note", taskId: "task" }] },
      "sort",
    ),
    entry("dispatch", target, "dispatch", input),
    entry("stop", "original-run", "stop"),
  ];
  window.sessionStorage.setItem(oldKey, JSON.stringify(entries));
  const requests = store();
  const result = await migrateChecklistRequests(requests, context);
  assert.deepEqual(result.quarantined, []);
  assert.equal(window.sessionStorage.getItem(oldKey), null);
  const records = requests.getSnapshot().records;
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((r) => r.requestId),
    ["create", "save", "sort", "dispatch", "stop"],
  );
  assert.equal(records[1].request.body.expectedGeneration, 3);
  assert.equal(records[2].request.body.expectedSequence, 27);
  assert.deepEqual(records[3].request.body, {
    requestId: "dispatch",
    ...target,
  });
  assert.deepEqual(records[3].checkpoint.nextRequest.body.arguments, input);
  assert.deepEqual(records[4].request.body.arguments, {
    runId: "original-run",
    requestId: "stop",
  });
});

test("a contradictory duplicate identity quarantines all variants before adopting any", async () => {
  const entries = [
    entry("create", { tasks: [item] }, "collision"),
    entry("create", { tasks: [item] }, "collision"),
    entry("create", { tasks: [{ ...item, text: "different" }] }, "collision"),
  ];
  window.sessionStorage.setItem(oldKey, JSON.stringify(entries));
  const requests = store();
  const result = await migrateChecklistRequests(requests, context);
  assert.equal(result.quarantined.length, 3);
  assert.equal(requests.getSnapshot().records.length, 0);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(oldKey)), entries);
});

test("malformed payloads and contradictory intent facts are read-only; other scopes remain untouched", async () => {
  const entries = [
    entry("create", {}, "missing"),
    entry("dispatch", { ...target, bindingRevision: 2 }, "wrong"),
    entry("dispatch", target, "dispatch", { ...input, requestId: "other" }),
    entry("stop", {}, "bad-stop"),
  ];
  window.sessionStorage.setItem(oldKey, JSON.stringify(entries));
  const otherKey = `qingdan.agent-checklist-requests:${legacyScope({ ...context, userId: "other" })}`;
  window.sessionStorage.setItem(
    otherKey,
    JSON.stringify([entry("create", { tasks: [item] }, "other")]),
  );
  const requests = store(),
    result = await migrateChecklistRequests(requests, context);
  assert.equal(result.quarantined.length, 4);
  assert.equal(requests.getSnapshot().records.length, 0);
  assert.ok(window.sessionStorage.getItem(otherKey));
  assert.ok(window.sessionStorage.getItem(oldKey));
});

test("legacy stop stays in session on volatile adoption and migrates only after durable confirmation", async () => {
  navigator.locks = undefined;
  const saved = JSON.stringify([entry("stop", "original-run", "old-stop")]);
  window.sessionStorage.setItem(oldKey, saved);
  const requests = store();
  await migrateChecklistRequests(requests, context);
  assert.equal(requests.getSnapshot().durable, false);
  assert.equal(window.sessionStorage.getItem(oldKey), saved);
  assert.equal(requests.getSnapshot().records[0].requestId, "old-stop");
  navigator.locks = browserLocks();
  await migrateChecklistRequests(requests, context);
  assert.equal(requests.getSnapshot().durable, true);
  assert.equal(window.sessionStorage.getItem(oldKey), null);
  assert.equal(requests.getSnapshot().records[0].requestId, "old-stop");
});

test("persisted execution checkpoints cannot redirect a retry to different content", () => {
  const record = {
    requestId: "dispatch",
    request: {
      path: "/api/agent/execution/intents",
      method: "POST",
      body: { requestId: "dispatch", ...target },
    },
    checkpoint: {
      result: { input },
      nextRequest: {
        path: "/api/agent/execution/tools",
        method: "POST",
        body: {
          bindingId: "binding",
          name: "codex_create_run",
          arguments: { ...input, runId: "substitute" },
        },
      },
    },
  };
  assert.throws(() => inspectChecklistRequest(record, binding), /只读|不符/);
});
