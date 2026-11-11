import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
let discoverCodex;
try {
  ({ discoverCodex } = await import("../discovery.mjs"));
} catch {}
test("bounded Codex discovery exists", () =>
  assert.equal(typeof discoverCodex, "function"));
if (discoverCodex) {
  async function dir(t) {
    const d = await mkdtemp(path.join(os.tmpdir(), "qd-connect-discovery-"));
    t.after(() => rm(d, { recursive: true, force: true }));
    return d;
  }
  test("finds executables in PATH with spaces and deduplicates cached path", async (t) => {
    const d = await dir(t),
      folder = path.join(d, "with spaces");
    await mkdir(folder);
    const exe = path.join(folder, "codex.exe");
    await writeFile(exe, "test");
    const r = await discoverCodex({
      platform: "win32",
      env: { PATH: folder },
      cachedPath: exe,
      packageLocations: [],
      knownLocations: [],
    });
    assert.deepEqual(
      r.candidates.map((x) => x.command),
      [exe],
    );
  });
  test("expired cached path falls back to PATH", async (t) => {
    const d = await dir(t),
      exe = path.join(d, "codex.exe");
    await writeFile(exe, "test");
    const r = await discoverCodex({
      platform: "win32",
      env: { PATH: d },
      cachedPath: path.join(d, "gone.exe"),
      packageLocations: [],
      knownLocations: [],
    });
    assert.equal(r.candidates[0].command, exe);
  });
  test("invalid manual path never silently switches to PATH", async (t) => {
    const d = await dir(t);
    await writeFile(path.join(d, "codex.exe"), "test");
    await assert.rejects(
      () =>
        discoverCodex({
          manualPath: path.join(d, "gone.exe"),
          platform: "win32",
          env: { PATH: d },
        }),
      (e) => e.code === "CODEX_PATH_INVALID",
    );
  });
  test("rejects shell wrappers and relative manual paths", async () => {
    for (const p of ["codex.exe", "C:\\tools\\codex.cmd"])
      await assert.rejects(
        () => discoverCodex({ manualPath: p, platform: "win32", env: {} }),
        (e) => e.code === "CODEX_PATH_INVALID",
      );
  });
  test("missing installation reports no candidates, not login error", async () => {
    const r = await discoverCodex({
      platform: "win32",
      env: {},
      packageLocations: [],
      knownLocations: [],
    });
    assert.deepEqual(r.candidates, []);
  });
}
