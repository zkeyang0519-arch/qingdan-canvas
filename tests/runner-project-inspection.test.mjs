import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const buildDir = await mkdtemp(
  path.resolve(".tmp/project-inspection-test-build-"),
);
test.after(() => rm(buildDir, { recursive: true, force: true }));
await build({
  stdin: {
    contents:
      "export * from './runner/project-inspection.ts'; export { projectSummarySchema } from './shared/agent/schemas.ts';",
    resolveDir: path.resolve("."),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: path.join(buildDir, "inspection.mjs"),
  logLevel: "silent",
});
const {
  inspectProject,
  mergeInspectionSources,
  validateInspectionReferences,
  projectInspectionTool,
  projectSummarySchema,
} = await import(pathToFileURL(path.join(buildDir, "inspection.mjs")));
async function fixture(t) {
  const base = await mkdtemp(path.resolve(".tmp/project-inspection-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  await mkdir(root);
  return { base, root };
}
const summary = (ref) => ({
  overview: "项目进度",
  completed: [],
  inProgress: [],
  pending: [{ text: "完成导出并补充边界测试", evidenceRef: ref }],
  blockers: [],
  verification: [],
  uncertainties: [],
});

test("project inspection traverses more than 16 files and deep modules with explicit pagination", async (t) => {
  const { root } = await fixture(t);
  const deep = path.join(root, "src/modules/export/formatters");
  await mkdir(deep, { recursive: true });
  for (let i = 0; i < 123; i++)
    await writeFile(
      path.join(root, `source-${String(i).padStart(3, "0")}.ts`),
      `export const n = ${i};`,
    );
  await writeFile(
    path.join(deep, "todo.ts"),
    "// TODO: implement Markdown export\n",
  );
  let cursor = null;
  const entries = [];
  do {
    const result = await inspectProject(root, {
      action: "list",
      path: ".",
      cursor,
    });
    entries.push(...result.output.entries);
    cursor = result.output.nextCursor;
  } while (cursor);
  assert.equal(entries.filter((e) => e.kind === "file").length, 124);
  assert.ok(
    entries.some((e) => e.path === "src/modules/export/formatters/todo.ts"),
  );
  const read = await inspectProject(root, {
    action: "read",
    path: "src/modules/export/formatters/todo.ts",
  });
  assert.match(read.output.content, /implement Markdown export/);
  assert.equal(read.sources[0].path, "src/modules/export/formatters/todo.ts");
  assert.equal(projectInspectionTool().name, "qingdan_inspect_project");
});

test("large file reads and searches continue past the old byte cap without losing the tail", async (t) => {
  const { root } = await fixture(t);
  const content =
    Array.from(
      { length: 4500 },
      (_, i) => `export const line${i} = ${i};\n`,
    ).join("") + "// TODO: finish rare export case\n";
  await writeFile(path.join(root, "large.ts"), content);
  let cursor = null,
    text = "",
    reads = [];
  do {
    const result = await inspectProject(root, {
      action: "read",
      path: "large.ts",
      cursor,
    });
    text += result.output.content;
    reads.push(...result.sources);
    cursor = result.output.nextCursor;
    assert.ok(Buffer.byteLength(JSON.stringify(result.output)) < 50000);
  } while (cursor);
  assert.equal(text, content);
  let found = [];
  do {
    const result = await inspectProject(root, {
      action: "search",
      path: ".",
      query: "TODO",
      cursor,
    });
    found.push(...result.output.matches);
    cursor = result.output.nextCursor;
  } while (cursor);
  assert.ok(
    found.some((m) => m.path === "large.ts" && m.text.includes("rare export")),
  );
  const sources = mergeInspectionSources([], reads);
  assert.doesNotThrow(() =>
    validateInspectionReferences(summary("large.ts"), sources),
  );
  assert.throws(
    () => validateInspectionReferences(summary("never-read.ts"), sources),
    { code: "INVALID_SUMMARY_EVIDENCE" },
  );
});

test("inspection reads stay inside the project, omit secrets and dependencies, and redact sensitive lines", async (t) => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside-secret");
  await symlink(outside, path.join(root, "linked"), "junction");
  await link(path.join(outside, "secret.txt"), path.join(root, "hard.txt"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "lib.ts"), "dependency");
  await writeFile(path.join(root, ".env"), "TOKEN=private-secret");
  await writeFile(
    path.join(root, ".git-credentials"),
    "https://alice:hidden-password@example.test/repo",
  );
  await writeFile(
    path.join(root, "config.md"),
    "Normal documentation\nAPI_KEY=private-secret\nremote=https://alice:hidden-password@example.test/repo\ndependency=git+https://example-access-token@example.test/repo.git\n",
  );
  await writeFile(path.join(root, "binary.txt"), Buffer.from([1, 0, 2]));
  for (const p of [
    "../outside/secret.txt",
    "linked/secret.txt",
    "hard.txt",
    ".env",
    ".git-credentials",
    "node_modules/lib.ts",
    "binary.txt",
    path.join(outside, "secret.txt"),
    "config.md:stream",
  ]) {
    await assert.rejects(
      inspectProject(root, { action: "read", path: p }),
      undefined,
      p,
    );
  }
  const safe = await inspectProject(root, {
    action: "read",
    path: "config.md",
  });
  assert.match(safe.output.content, /Normal documentation/);
  assert.ok(!JSON.stringify(safe).includes("private-secret"));
  assert.ok(!JSON.stringify(safe).includes("hidden-password"));
  assert.ok(!JSON.stringify(safe).includes("example-access-token"));
  const list = await inspectProject(root, { action: "list", path: "." });
  assert.ok(list.output.entries.some((e) => e.path === "linked" && e.excluded));
  assert.ok(!list.output.entries.some((e) => e.path === "linked/secret.txt"));
  await assert.rejects(
    inspectProject(root, {
      action: "list",
      path: ".",
      cursor: "invalid-cursor",
    }),
  );
});

test("inspection references require returned contents and merging concurrent source receipts preserves both", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "a.ts"), "first module\n");
  await writeFile(path.join(root, "b.ts"), "second module\n");
  const list = await inspectProject(root, { action: "list", path: "." });
  assert.throws(() =>
    validateInspectionReferences(summary("a.ts"), list.sources),
  );
  const [a, b] = await Promise.all(
    ["a.ts", "b.ts"].map((p) =>
      inspectProject(root, { action: "read", path: p }),
    ),
  );
  const receipts = mergeInspectionSources(
    mergeInspectionSources([], a.sources),
    b.sources,
  );
  assert.doesNotThrow(() =>
    validateInspectionReferences(summary("a.ts"), receipts),
  );
  assert.doesNotThrow(() =>
    validateInspectionReferences(summary("b.ts"), receipts),
  );
  assert.equal(mergeInspectionSources(receipts, a.sources).length, 2);
});

test("changed directory pagination fails explicitly instead of silently skipping unseen files", async (t) => {
  const { root } = await fixture(t);
  for (let i = 0; i < 101; i++)
    await writeFile(
      path.join(root, `f${String(i).padStart(3, "0")}.ts`),
      "unchanged module\n",
    );
  const list = await inspectProject(root, { action: "list", path: "." });
  const search = await inspectProject(root, {
    action: "search",
    path: ".",
    query: "TODO",
  });
  await rm(path.join(root, "f000.ts"));
  for (const [action, result, query] of [
    ["list", list],
    ["search", search, "TODO"],
  ]) {
    await assert.rejects(
      inspectProject(root, {
        action,
        path: ".",
        cursor: result.output.nextCursor,
        ...(query ? { query } : {}),
      }),
      /目录.*变化/,
    );
  }
});

test("long nested file names can use their returned continuation cursor", async (t) => {
  const { root } = await fixture(t);
  const relative =
    Array.from({ length: 16 }, (_, i) => `module-${i}-${"x".repeat(90)}`).join(
      "/",
    ) + "/large.ts";
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(
    path.join(root, relative),
    "export const value = 1;\n".repeat(2000),
  );
  const first = await inspectProject(root, { action: "read", path: relative });
  assert.ok(first.output.nextCursor.length > 2048);
  const next = await inspectProject(root, {
    action: "read",
    path: relative,
    cursor: first.output.nextCursor,
  });
  assert.ok(next.output.content.length > 0);
  assert.doesNotThrow(() => projectSummarySchema.parse(summary(relative)));
  assert.throws(() => projectSummarySchema.parse(summary("a".repeat(4097))));
});
