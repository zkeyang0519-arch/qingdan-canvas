import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
const root = path.resolve(".");
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './runner/summary-evidence.ts';",
    resolveDir: root,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { readSummaryEvidence, validateSummaryReferences } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);
test("summary references must name actual provided evidence, not merely listed files", () => {
  const summary = {
    overview: "项目",
    completed: [],
    inProgress: [],
    pending: [],
    blockers: [],
    verification: [{ text: "看过的文件", evidenceRef: "README.md" }],
    uncertainties: [],
  };
  const evidence = {
    files: [{ path: "README.md" }],
    inventory: ["README.md", "unread.ts"],
  };
  assert.doesNotThrow(() => validateSummaryReferences(summary, evidence));
  assert.throws(
    () =>
      validateSummaryReferences(
        {
          ...summary,
          verification: [{ text: "未读文件", evidenceRef: "unread.ts" }],
        },
        evidence,
      ),
    { code: "INVALID_SUMMARY_EVIDENCE" },
  );
  assert.doesNotThrow(() =>
    validateSummaryReferences(
      {
        ...summary,
        verification: [
          { text: "Git元数据", evidenceRef: "native:git" },
          { text: "目录列表", evidenceRef: "native:inventory" },
        ],
      },
      evidence,
    ),
  );
});
async function fixture(t) {
  const base = await mkdtemp(path.join(root, ".tmp/summary-evidence-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project);
  return { base, project };
}
test("summary evidence includes bounded source data with native hashes but excludes secrets and dependencies", async (t) => {
  const { project } = await fixture(t);
  await mkdir(path.join(project, "src"));
  await mkdir(path.join(project, "node_modules"));
  await writeFile(
    path.join(project, "README.md"),
    "# Project\nSupported file evidence.",
  );
  await writeFile(path.join(project, "AGENTS.md"), "Project constraints.");
  await writeFile(
    path.join(project, "src", "main.ts"),
    "export const app = 1;",
  );
  await writeFile(path.join(project, ".env"), "API_KEY=secret-value");
  await writeFile(path.join(project, "credentials.txt"), "secret-value");
  await writeFile(path.join(project, "token.txt"), "hidden-token-value");
  await writeFile(path.join(project, "src", "env.ts"), "hidden-env-value");
  await writeFile(
    path.join(project, "node_modules", "README.md"),
    "dependency data",
  );
  await writeFile(
    path.join(project, "config.md"),
    'ROUTER_API_KEY="private-value"\ntoken = "hidden-generic-value"\nBearer abcdefghijklmnopqrstuvwxyz\nNormal info',
  );
  const evidence = await readSummaryEvidence(project, {
    commit: null,
    branch: null,
    dirty: true,
  });
  assert.ok(evidence.files.some((f) => f.path === "README.md"));
  assert.ok(evidence.files.some((f) => f.path === "src/main.ts"));
  assert.ok(evidence.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(!JSON.stringify(evidence).includes("secret-value"));
  assert.ok(!JSON.stringify(evidence).includes("private-value"));
  for (const secret of [
    "hidden-token-value",
    "hidden-env-value",
    "hidden-generic-value",
    "abcdefghijklmnopqrstuvwxyz",
  ])
    assert.ok(!JSON.stringify(evidence).includes(secret));
  assert.ok(!JSON.stringify(evidence).includes("dependency data"));
  assert.equal(evidence.gitBaseline.dirty, true);
});
test("summary evidence refuses directory junctions, hardlinks, binary and oversized files", async (t) => {
  const { base, project } = await fixture(t),
    outside = path.join(base, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "README.md"), "outside secret");
  await symlink(outside, path.join(project, "linked"), "junction");
  await link(
    path.join(outside, "README.md"),
    path.join(project, "linked-file.md"),
  );
  await writeFile(path.join(project, "huge.md"), "x".repeat(10000));
  await writeFile(path.join(project, "binary.txt"), Buffer.from([1, 0, 2]));
  await writeFile(path.join(project, "README.md"), "Only safe file");
  const evidence = await readSummaryEvidence(project, {
    commit: null,
    branch: null,
    dirty: false,
  });
  assert.deepEqual(
    evidence.files.map((f) => f.path),
    ["README.md"],
  );
  assert.ok(!JSON.stringify(evidence).includes("outside secret"));
  assert.ok(evidence.omitted.some((x) => x.path === "linked"));
  assert.ok(evidence.omitted.some((x) => x.path === "linked-file.md"));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 49152);
});
