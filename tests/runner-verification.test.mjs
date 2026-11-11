import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
let verify;
try {
  const { outputFiles } = await build({
    stdin: {
      contents: "export * from './runner/verification.ts';",
      resolveDir: path.resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  ({ verifyAcceptance: verify } = await import(
    "data:text/javascript;base64," +
      Buffer.from(outputFiles[0].text).toString("base64")
  ));
} catch {}
const check = (predicate, relativePath = "result.txt") => ({
  id: "artifact",
  kind: "artifact",
  description: "Check actual artifact",
  required: true,
  relativePath,
  predicate,
});
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/native-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    typeof verify,
    "function",
    "native acceptance verifier is required",
  );
  return root;
}
test("native artifact verification reads real files, hashes evidence and does not trust a done receipt", async (t) => {
  const root = await fixture(t);
  let [r] = await verify(root, [check({ type: "exists" })]);
  assert.equal(r.status, "failed");
  assert.equal(r.failureKind, "predicate");
  await writeFile(path.join(root, "result.txt"), "hello, light list");
  [r] = await verify(root, [
    check({ type: "textContains", text: "light list" }),
  ]);
  assert.equal(r.status, "passed");
  assert.match(r.outputHash, /^[a-f0-9]{64}$/);
  assert.ok(r.evidenceRefs.length);
  [r] = await verify(root, [
    check({ type: "textContains", text: "missing text" }),
  ]);
  assert.equal(r.failureKind, "predicate");
  assert.equal(r.status, "failed");
});
test("native verifier supports a strict JSON Schema subset and fails closed for unsupported schemas, commands and human checks", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify({ title: "done", count: 3, tags: ["ok"] }),
  );
  const schema = {
    type: "object",
    required: ["title", "count"],
    properties: {
      title: { type: "string", const: "done" },
      count: { type: "integer", minimum: 2 },
      tags: { type: "array", items: { enum: ["ok"] }, minItems: 1 },
    },
    additionalProperties: false,
  };
  let [r] = await verify(root, [
    check({ type: "jsonSchema", schema }, "result.json"),
  ]);
  assert.equal(r.status, "passed");
  [r] = await verify(root, [
    check(
      { type: "jsonSchema", schema: { ...schema, required: ["missing"] } },
      "result.json",
    ),
  ]);
  assert.equal(r.status, "failed");
  assert.equal(r.failureKind, "predicate");
  [r] = await verify(root, [
    check(
      { type: "jsonSchema", schema: { $ref: "https://example.test/schema" } },
      "result.json",
    ),
  ]);
  assert.equal(r.status, "needs_input");
  assert.equal(r.failureKind, "unsupported");
  const pending = await verify(root, [
    { id: "human", kind: "human", required: true, description: "review" },
    {
      id: "command",
      kind: "command",
      checkId: "test",
      required: true,
      description: "test",
    },
  ]);
  assert.deepEqual(
    pending.map((r) => r.status),
    ["needs_input", "needs_input"],
  );
  assert.equal(pending[1].failureKind, "unsupported");
});
test("native verification denies traversal and symlinks and bounds content before reading", async (t) => {
  const root = await fixture(t),
    outside = await mkdtemp(path.resolve(".tmp/verification-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "result.txt"), "secret");
  await symlink(outside, path.join(root, "linked"), "junction");
  for (const name of ["../result.txt", "linked/result.txt"]) {
    const [r] = await verify(root, [check({ type: "exists" }, name)]);
    assert.equal(r.status, "needs_input");
    assert.equal(r.failureKind, "access_denied");
  }
  await writeFile(path.join(root, "large.txt"), "a".repeat(1024 * 1024 + 1));
  const [r] = await verify(root, [
    check({ type: "textContains", text: "a" }, "large.txt"),
  ]);
  assert.equal(r.status, "needs_input");
  assert.equal(r.failureKind, "unsupported");
});
