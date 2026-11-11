import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as manager from "../scripts/lib/agent-install.mjs";
import * as bridge from "../scripts/lib/agent-install-bridge.mjs";

async function fixture(t) {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/lifecycle-control-"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "qingdan-canvas",
      scripts: { "dev:agent": "node scripts/dev-agent.mjs" },
    }),
  );
  t.after(async () => {
    await manager
      .stop({
        root,
        stateDir: path.join(root, ".tmp/agent-install-test"),
        interruptActive: true,
      })
      .catch(() => {});
    assert.ok(root.startsWith(path.resolve(".tmp") + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    stateDir: path.join(root, ".tmp/agent-install-test"),
    checkDependencies: false,
    probePort: async () => true,
    probeReady: async () => false,
    startupTimeoutMs: 300,
  };
}
test("source recovery uses authenticated local control without an installed manifest or backend session", async (t) => {
  assert.equal(
    typeof bridge.openSourceControl,
    "function",
    "source HMAC lifecycle control is missing",
  );
  assert.equal(
    typeof manager.recoverWeb,
    "function",
    "manual web recovery is missing",
  );
  const f = await fixture(t);
  let recovered = 0;
  const control = await bridge.openSourceControl(
    { root: f.root },
    {
      status: () => ({ phase: "recovery_required" }),
      recoverWeb: () => ({ accepted: true, sequence: ++recovered }),
    },
  );
  t.after(() => control.close());
  const options = { ...f, stateDir: undefined, source: true };
  assert.equal((await manager.recoverWeb(options)).sequence, 1);
  const key = path.join(f.root, ".tmp/agent-install-source/control.key"),
    original = await readFile(key, "utf8");
  await writeFile(key, "0".repeat(64));
  try {
    await assert.rejects(manager.recoverWeb(options), /identity|verified/);
  } finally {
    await writeFile(key, original);
  }
  assert.equal(
    recovered,
    1,
    "unverified requests must not restart the web child",
  );
  assert.equal((await manager.diagnose(options)).status, "recovery_required");
  await control.close();
});

test("installed HMAC recovery preserves the running launcher instance", async (t) => {
  assert.equal(
    typeof manager.recoverWeb,
    "function",
    "manual web recovery is missing",
  );
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, "scripts/dev-agent.mjs"),
    `
    import { setLifecycleHooks } from ${JSON.stringify(new URL("../scripts/lib/agent-install-bridge.mjs", import.meta.url).href)};
    let sequence = 0;
    setLifecycleHooks({ status: () => ({phase:'recovery_required'}), recoverWeb: () => ({accepted:true, sequence:++sequence}) });
    setInterval(() => {}, 1000);
    process.once('SIGTERM', () => process.exit(0));
  `,
  );
  await manager.install(f);
  t.after(() => manager.stop({ ...f, interruptActive: true }).catch(() => {}));
  const first = await manager.start(f);
  assert.equal((await manager.recoverWeb(f)).sequence, 1);
  const after = await manager.diagnose(f);
  assert.equal(after.pid, first.pid);
  assert.equal(after.instanceId, first.instanceId);
  assert.equal(after.status, "recovery_required");
  await manager.stop(f);
});

test("a stopped source launcher can use a new Node executable without replacing its control identity", async (t) => {
  const f = await fixture(t);
  const first = await bridge.openSourceControl({ root: f.root });
  await first.close();
  const file = path.join(f.root, ".tmp/agent-install-source/source.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...manifest,
      nodePath: path.join(f.root, "removed-node.exe"),
    }),
  );
  const next = await bridge.openSourceControl({ root: f.root });
  try {
    assert.equal(next.manifest.installationId, manifest.installationId);
  } finally {
    await next.close();
  }
});
