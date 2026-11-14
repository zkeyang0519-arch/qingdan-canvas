import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createLaunchControl } from "../desktop/launch-control.cjs";
import { requestDesktopExit } from "../scripts/lib/desktop-installation.mjs";

async function fixture(t, prepareExit = async () => () => {}) {
  await fs.mkdir(".tmp", { recursive: true });
  const profile = await fs.mkdtemp(path.resolve(".tmp/desktop-control-"));
  let quits = 0;
  const control = await createLaunchControl({
    profile,
    version: "0.3.1",
    prepareExit,
    quit: () => {
      quits++;
    },
  });
  t.after(async () => {
    control.close();
    await fs.rm(profile, { recursive: true, force: true });
  });
  const record = JSON.parse(
    await fs.readFile(path.join(profile, "launch-control.json"), "utf8"),
  );
  return { profile, record, quits: () => quits, control };
}
test("native safe shutdown rejects browser requests and missing capability", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    {},
    {
      Authorization: `Bearer ${f.record.nonce}`,
      Origin: "https://todo.zky.lol",
    },
  ]) {
    assert.equal(
      (
        await fetch(f.record.endpoint + "/prepare-update", {
          method: "POST",
          headers,
        })
      ).status,
      403,
    );
  }
  assert.equal(f.quits(), 0);
});
test("external shutdown is acknowledged only after durable preparation and commits exactly once", async (t) => {
  let prepared = false,
    committed = false;
  const f = await fixture(t, async () => {
    prepared = true;
    return () => {
      committed = true;
    };
  });
  await requestDesktopExit(f.profile, { running: [process.pid] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, true);
  assert.equal(committed, true);
  assert.equal(f.quits(), 1);
});
test("failed persistence leaves the window running and allows a later retry", async (t) => {
  let failed = true;
  const f = await fixture(t, async () => {
    if (failed) throw Error("disk full");
    return () => {};
  });
  await assert.rejects(
    requestDesktopExit(f.profile, { running: [process.pid] }),
    /尚未完成保存/,
  );
  assert.equal(f.quits(), 0);
  failed = false;
  await requestDesktopExit(f.profile, { running: [process.pid] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.quits(), 1);
});
test("a stale control record belonging to another PID cannot authorize closing a running app", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    requestDesktopExit(f.profile, { running: [process.pid + 1] }),
    /旧版轻岛/,
  );
  assert.equal(f.quits(), 0);
});
