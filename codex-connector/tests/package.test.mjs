import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let packageWindows;
try {
  ({ packageWindows } = await import("../package-windows.mjs"));
} catch {}
test("standalone Windows packager exists", () =>
  assert.equal(typeof packageWindows, "function"));
if (packageWindows)
  test("refuses existing package directories without copying or deleting user state", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qd-package-existing-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, "portable");
    await mkdir(path.join(target, "data"), { recursive: true });
    const sentinel = path.join(target, "data", "runtime.json");
    await writeFile(sentinel, "PRIVATE-LOCAL-CREDENTIAL");
    await assert.rejects(
      () => packageWindows(target),
      (e) => e.code === "PACKAGE_DESTINATION_EXISTS",
    );
    assert.equal(await readFile(sentinel, "utf8"), "PRIVATE-LOCAL-CREDENTIAL");
    assert.deepEqual(await readdir(target), ["data"]);
  });
if (packageWindows)
  test("package is self contained and excludes source-account state", async (t) => {
    const d = await mkdtemp(path.join(os.tmpdir(), "qd-connector-package-"));
    t.after(() => rm(d, { recursive: true, force: true }));
    await packageWindows(path.join(d, "portable"), {
      runtimePath: process.execPath,
    });
    const files = await readdir(path.join(d, "portable"));
    assert.ok(files.includes("node.exe"));
    assert.ok(files.includes("启动 Codex 连接器.vbs"));
    assert.ok(files.includes("README.txt"));
    assert.equal(files.includes("data"), false);
    assert.equal(files.includes("node_modules"), false);
    const manifest = JSON.parse(
      await readFile(path.join(d, "portable", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.runtime, process.version);
    assert.ok(
      manifest.files.every(
        (x) => !/config\.json|runtime\.json|auth\.json|verification/.test(x),
      ),
    );
    assert.ok(
      (
        await readFile(path.join(d, "portable", "app", "main.mjs"), "utf8")
      ).includes("Connector"),
    );
  });
