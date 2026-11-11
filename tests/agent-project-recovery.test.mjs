import test from "node:test";
import assert from "node:assert/strict";
import { fixture, init, p } from "./fixtures/project-summary.mjs";

function failPut(f, matches) {
  const put = f.storage.put.bind(f.storage);
  let armed = true;
  f.storage.put = async (key, value) => {
    const entries =
      typeof key === "string" ? [[key, value]] : Object.entries(key);
    if (armed && matches(entries)) {
      armed = false;
      throw Error("injected write failure");
    }
    return put(key, value);
  };
}
const runCount = (f) =>
  [...f.rows.keys()].filter((k) => k.startsWith("exec:run:")).length;
async function prepared(f) {
  await f.seed();
  failPut(f, (entries) => entries.some(([k]) => k.startsWith("exec:run:")));
  await assert.rejects(f.call("project-initialize", init()), /injected/);
  const state = await f.call("project-state", { inspectOnly: true });
  assert.ok(state.activeRunId, "planned identity survives before run commit");
  assert.equal(runCount(f), 0);
  return state;
}

test("state recovers a committed launch after coordinator failure without the original browser request", async () => {
  const f = fixture();
  await f.seed();
  failPut(
    f,
    (entries) =>
      runCount(f) > 0 &&
      entries.some(([k]) => /^project:state:[a-f0-9]+$/.test(k)),
  );
  await assert.rejects(f.call("project-initialize", init()), /injected/);
  assert.equal(runCount(f), 1);
  f.restart();
  const recovered = await f.call("project-state");
  assert.ok(recovered.activeRunId);
  assert.equal(recovered.status, "queued");
  await assert.rejects(
    f.call("project-refresh", init("new-browser")),
    (e) => e.status === 409,
  );
  assert.equal(runCount(f), 1);
});

test("inspect never commits pending launch; cancellation seals it and rejects late direct create after restart", async () => {
  const f = fixture(),
    state = await prepared(f);
  const launch = f.rows.get("project:launch:" + state.activeRunId);
  assert.equal(launch.phase, "prepared");
  const cancel = { requestId: "cancel-prepared", runId: state.activeRunId };
  const receipt = await f.tool("codex_cancel_run", cancel);
  assert.equal(receipt.sealedLaunch.runId, state.activeRunId);
  assert.equal(
    receipt.stopConfirmed,
    undefined,
    "seal is not native stop proof",
  );
  assert.equal(runCount(f), 0);
  assert.equal(
    [...f.rows.keys()].some((k) => k.startsWith("exec:pending:")),
    false,
  );
  f.restart();
  assert.deepEqual(await f.tool("codex_cancel_run", cancel), receipt);
  await assert.rejects(
    f.tool("codex_create_run", launch.input),
    (e) => e.status === 409,
  );
  const sealed = await f.call("project-state");
  assert.equal(sealed.status, "failed");
  assert.equal(sealed.sealedLaunch.runId, state.activeRunId);
  const next = await f.call("project-refresh", init("after-seal"));
  await f.tool("codex_cancel_run", {
    ...cancel,
    requestId: "another-cancel-id",
  });
  assert.equal((await f.call("project-state")).activeRunId, next.activeRunId);
});

test("failed seal write is not acknowledged and cannot be inferred from run absence", async () => {
  const f = fixture(),
    state = await prepared(f);
  await assert.rejects(
    f.tool("codex_cancel_run", { requestId: "unknown", runId: "missing" }),
    (e) => e.status === 403,
  );
  failPut(f, (entries) =>
    entries.some(
      ([k, v]) => k.startsWith("project:launch:") && v.phase === "sealed",
    ),
  );
  const input = { requestId: "stop", runId: state.activeRunId };
  await assert.rejects(f.tool("codex_cancel_run", input), /injected/);
  assert.equal(
    f.rows.get("project:launch:" + state.activeRunId).phase,
    "prepared",
  );
  assert.ok((await f.tool("codex_cancel_run", input)).sealedLaunch);
});

test("reconciliation preserves control and rejects replacement; fresh chat joins the active summary", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  const run = f.rows.get("exec:run:" + a.activeRunId);
  run.view.status = "reconciliation_required";
  await f.storage.put("exec:run:" + a.activeRunId, run);
  assert.equal(
    (await f.call("project-state")).status,
    "reconciliation_required",
  );
  await assert.rejects(
    f.call("project-refresh", init("refresh")),
    (e) => e.status === 409,
  );
  assert.equal(
    (await f.call("project-initialize", init("new-chat", "chat-two")))
      .activeRunId,
    a.activeRunId,
  );
  assert.equal(runCount(f), 1);
});

test("CAS rejects stale tabs after completion, replay precedes CAS and legacy refresh remains accepted", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  await f.finish(a.activeRunId);
  const input = {
    ...init("cas"),
    expectedActiveRunId: a.activeRunId,
    expectedSummaryRevision: 1,
  };
  const b = await f.call("project-refresh", input);
  await f.finish(b.activeRunId);
  assert.equal((await f.call("project-refresh", input)).summaryRevision, 2);
  await assert.rejects(
    f.call("project-refresh", { ...input, requestId: "stale-tab" }),
    (e) => e.status === 409,
  );
  assert.ok((await f.call("project-refresh", init("legacy"))).activeRunId);
});

test("unlinked legacy summary blocks automatic initialization and is exposed for manual recovery", async () => {
  const f = fixture();
  await f.seed();
  const a = await f.call("project-initialize", init());
  for (const key of [...f.rows.keys()])
    if (key.startsWith("project:")) f.rows.delete(key);
  const s = await f.call("project-state", { inspectOnly: true });
  assert.equal(s.recoveryRuns[0].runId, a.activeRunId);
  await assert.rejects(
    f.call("project-initialize", init("new-id")),
    (e) => e.status === 409,
  );
  assert.equal(runCount(f), 1);
});

test("directory revision change cannot recover a pending intent from the old authorization scope", async () => {
  const f = fixture();
  const state = await prepared(f);
  const workspaces = JSON.parse(f.device.workspaces_json);
  workspaces[0].revision = 2;
  f.device.workspaces_json = JSON.stringify(workspaces);
  const next = await f.call("project-state", { inspectOnly: true });
  assert.equal(next.status, "uninitialized");
  assert.equal(next.activeRunId, null);
  await assert.rejects(
    f.call("project-initialize", init()),
    (e) => e.status === 409,
    "the old browser request must not become a new-directory authorization",
  );
  await assert.rejects(
    f.tool("codex_cancel_run", {
      requestId: "stale-stop",
      runId: state.activeRunId,
    }),
    (e) => e.status === 409,
  );
  assert.equal(runCount(f), 0);
});
