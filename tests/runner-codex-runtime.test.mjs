import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();
const dir = await mkdtemp(path.join(root, ".tmp/codex-runtime-test-"));
await build({
  entryPoints: ["runner/codex-runtime.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(dir, "runtime.mjs"),
  logLevel: "silent",
});
const { resolveCodexProcess } = await import(
  pathToFileURL(path.join(dir, "runtime.mjs"))
);
test.after(async () => {
  assert.equal(path.dirname(dir), path.join(root, ".tmp"));
  await rm(dir, { recursive: true, force: true });
});

test("default execution uses the pinned official package even without PATH or shell aliases", async () => {
  const runtime = resolveCodexProcess({ command: "codex", env: { PATH: "" } });
  assert.equal(runtime.command, process.execPath);
  assert.ok(path.isAbsolute(runtime.args[0]));
  assert.match(
    runtime.args[0].replaceAll("\\", "/"),
    /@openai\/codex\/bin\/codex\.js$/,
  );
  const require = createRequire(import.meta.url);
  const installed = JSON.parse(
    await readFile(require.resolve("@openai/codex/package.json"), "utf8"),
  );
  const pin = JSON.parse(
    await readFile("runner/protocol-version.json", "utf8"),
  );
  assert.equal(installed.version, pin.codexVersion);
});

test("explicit executable and configured environment paths retain their own arguments", () => {
  const resolve = () => {
    throw Error("must not replace explicit configuration");
  };
  assert.deepEqual(
    resolveCodexProcess(
      {
        command: "/own/codex",
        args: ["--custom"],
        env: { QINGDAN_CODEX_BIN: "/env/codex" },
      },
      resolve,
    ),
    { command: "/own/codex", args: ["--custom"] },
  );
  assert.deepEqual(
    resolveCodexProcess(
      { command: "codex", env: { QINGDAN_CODEX_BIN: "/env/codex" } },
      resolve,
    ),
    { command: "/env/codex", args: [] },
  );
});

test("an incomplete install fails with a repairable dependency error", () => {
  assert.throws(
    () =>
      resolveCodexProcess({ env: {} }, () => {
        throw Error("missing");
      }),
    { code: "CODEX_UNAVAILABLE" },
  );
});
