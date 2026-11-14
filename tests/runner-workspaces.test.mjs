import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const dir = await mkdtemp(path.join(root, ".tmp/workspaces-test-"));
let api;
try {
  await build({
    stdin: {
      contents:
        "export * from './runner/workspaces.ts'; export * from './runner/device-store.ts';",
      resolveDir: root,
    },
    outfile: path.join(dir, "api.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  api = await import(pathToFileURL(path.join(dir, "api.mjs")));
} catch (error) {
  test("workspace authorization implementation exists", () =>
    assert.fail(error.message));
}
test.after(() => rm(dir, { recursive: true, force: true }));
if (api) {
  async function fixture(t) {
    const base = await mkdtemp(path.join(dir, "case-"));
    const project = path.join(base, "project");
    await mkdir(project);
    const store = new api.DeviceStore(path.join(base, "device.sqlite"));
    const registry = new api.WorkspaceRegistry(store, {
      locksDir: path.join(base, "global-locks"),
    });
    t.after(() => store.close());
    return { base, project, store, registry };
  }
  test("registry authorizes only explicit roots and registered check IDs", async (t) => {
    const f = await fixture(t);
    const w = await f.registry.register({
      root: f.project,
      checks: [{ checkId: "test", label: "Tests" }],
    });
    assert.equal((await f.registry.resolve(w.workspaceId)).root, f.project);
    assert.equal(
      await f.registry.resolvePath(w.workspaceId, "file.txt"),
      path.join(f.project, "file.txt"),
    );
    await assert.rejects(
      f.registry.resolvePath(w.workspaceId, "../project-evil/file"),
    );
    await assert.rejects(f.registry.resolvePath(w.workspaceId, "x/../file"));
    assert.equal(f.registry.assertCheck(w.workspaceId, "test").checkId, "test");
    assert.throws(() => f.registry.assertCheck(w.workspaceId, "shell"));
    await assert.rejects(f.registry.resolve("unknown"));
  });
  test("Git subdirectories preserve narrow permission roots and share the worktree lock", async (t) => {
    const f = await fixture(t);
    assert.equal(
      spawnSync("git", ["init", f.project], { windowsHide: true }).status,
      0,
    );
    const nested = path.join(f.project, "nested");
    await mkdir(nested);
    const a = await f.registry.register({ root: nested });
    const b = await f.registry.register({ root: f.project });
    assert.notEqual(a.workspaceId, b.workspaceId);
    assert.equal(a.displayPath, nested);
    await f.registry.acquire(a.workspaceId, "nested-run");
    await assert.rejects(
      f.registry.acquire(b.workspaceId, "parent-run"),
      /occupied|busy/i,
    );
    await f.registry.release(a.workspaceId, "nested-run", true);
  });
  test("junction escape and replacement of registered directory are rejected", async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.base, "outside");
    await mkdir(outside);
    const w = await f.registry.register({ root: f.project });
    await symlink(
      outside,
      path.join(f.project, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      f.registry.resolvePath(w.workspaceId, "escape/new.txt"),
    );
    await rename(f.project, f.project + "-old");
    await mkdir(f.project);
    await assert.rejects(
      f.registry.resolve(w.workspaceId),
      /changed|replaced|retarget/i,
    );
  });
  test("global logical locks span stores and survive owner restart until confirmed stop", async (t) => {
    const f = await fixture(t);
    const second = new api.DeviceStore(path.join(f.base, "other.sqlite"));
    t.after(() => second.close());
    const reg2 = new api.WorkspaceRegistry(second, {
      locksDir: path.join(f.base, "global-locks"),
    });
    const a = await f.registry.register({ root: f.project });
    const b = await reg2.register({ root: f.project });
    await f.registry.acquire(a.workspaceId, "run-a");
    await assert.rejects(
      reg2.acquire(b.workspaceId, "run-b"),
      /occupied|busy/i,
    );
    await assert.rejects(
      f.registry.release(a.workspaceId, "run-a", false),
      /confirmed/i,
    );
    await f.registry.release(a.workspaceId, "run-a", true);
    await reg2.acquire(b.workspaceId, "run-b");
    const restarted = new api.WorkspaceRegistry(f.store, {
      locksDir: path.join(f.base, "global-locks"),
    });
    await assert.rejects(
      restarted.acquire(a.workspaceId, "run-c"),
      /occupied|busy/i,
    );
    await reg2.release(b.workspaceId, "run-b", true);
    await f.registry.acquire(a.workspaceId, "crashed-run");
    const recovered = new api.WorkspaceRegistry(f.store, {
      locksDir: path.join(f.base, "global-locks"),
    });
    await assert.rejects(
      recovered.acquire(a.workspaceId, "replacement-run"),
      /occupied|busy/i,
    );
    await recovered.release(a.workspaceId, "crashed-run", true);
    await recovered.acquire(a.workspaceId, "replacement-run");
    await recovered.release(a.workspaceId, "replacement-run", true);
  });
  test("another Node process cannot acquire the same root with another state directory", async (t) => {
    const f = await fixture(t);
    const w = await f.registry.register({ root: f.project });
    await f.registry.acquire(w.workspaceId, "parent-run");
    const source = `import {DeviceStore,WorkspaceRegistry} from ${JSON.stringify(pathToFileURL(path.join(dir, "api.mjs")).href)};const s=new DeviceStore(${JSON.stringify(path.join(f.base, "child.sqlite"))});const r=new WorkspaceRegistry(s,{locksDir:${JSON.stringify(path.join(f.base, "global-locks"))}});const w=await r.register({root:${JSON.stringify(f.project)}});try{await r.acquire(w.workspaceId,'child-run');process.exitCode=1}catch{process.stdout.write('BUSY')}s.close();`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "BUSY");
    await f.registry.release(w.workspaceId, "parent-run", true);
  });
  test("workspace names and checks honor Worker bounds before any persistence", async (t) => {
    const f = await fixture(t);
    const cases = [
      { name: "N".repeat(101) },
      {
        checks: Array.from({ length: 51 }, (_, i) => ({
          checkId: `check_${i}`,
          label: "Check",
        })),
      },
      { checks: [{ checkId: "test", label: "L".repeat(101) }] },
      { checks: [{ checkId: "x".repeat(101), label: "Check" }] },
      { checks: [{ checkId: "invalid.id", label: "Check" }] },
    ];
    for (const extra of cases) {
      await assert.rejects(
        f.registry.register({ root: f.project, ...extra }),
        (error) => error.code === "VALIDATION_ERROR",
      );
      assert.equal(f.registry.list().length, 0);
    }
    await assert.rejects(
      f.registry.register({
        root: path.join(f.project, "x".repeat(1100)),
        name: "Root",
      }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.equal(f.registry.list().length, 0);
    const valid = await f.registry.register({
      root: f.project,
      name: "N".repeat(100),
      checks: Array.from({ length: 50 }, (_, i) => ({
        checkId: i === 0 ? "x".repeat(100) : `check_${i}`,
        label: "L".repeat(100),
      })),
    });
    assert.equal(valid.name.length, 100);
    assert.equal(valid.checks.length, 50);
    assert.equal(f.registry.list().length, 1);
  });
  test("100 workspace limit preserves the first 100 records and rejects the 101st", async (t) => {
    const f = await fixture(t);
    const first = await f.registry.register({ root: f.project, name: "First" });
    const original = f.store.workspace(first.workspaceId);
    for (let i = 1; i < 99; i++) {
      const rootPath = f.project + `-registered-${i}`;
      f.store.saveWorkspace(
        {
          ...original,
          workspaceId: `workspace_${i}`,
          root: rootPath,
          registeredPath: rootPath,
          displayPath: rootPath,
        },
        process.platform === "win32" ? rootPath.toLowerCase() : rootPath,
      );
    }
    const hundredth = path.join(f.base, "hundredth");
    const overflow = path.join(f.base, "overflow");
    await mkdir(hundredth);
    await mkdir(overflow);
    await f.registry.register({ root: hundredth, name: "One hundred" });
    assert.equal(f.registry.list().length, 100);
    await assert.rejects(
      f.registry.register({ root: overflow, name: "One hundred one" }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.equal(f.registry.list().length, 100);
    assert.equal(
      (await f.registry.register({ root: f.project })).workspaceId,
      first.workspaceId,
    );
  });
}
