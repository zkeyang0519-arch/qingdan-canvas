import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

test("smoke reports a blocked native task before checking an artifact it could not create", async t => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".tmp/codex-smoke-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "scripts"));
  await mkdir(path.join(dir, "runner/dist"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await copyFile(path.join(root, "scripts/agent-codex-smoke.mjs"), path.join(dir, "scripts/agent-codex-smoke.mjs"));
  // Replace only the external native boundary; execute the actual smoke script,
  // including its report, isolated project creation and artifact validation.
  await writeFile(path.join(dir, "runner/dist/index.js"), `
    export class RunnerStore { close() {} }
    export const readGitBaseline = async () => ({ commit: null, dirty: false });
    export class CodexAdapter {
      runs = new Map();
      async connect() { return { platformOs: 'windows' }; }
      async account() { return { account: null, requiresOpenaiAuth: false }; }
      async listProjects() { return []; }
      async startFreshRun(snapshot) {
        const result = snapshot.kind === 'summary' ? { overview: 'fixture', completed: [], inProgress: [], pending: [], blockers: [], verification: [], uncertainties: [] } : { outcome: 'blocked', summary: 'native launch could not start', changedFiles: [], evidenceRefs: [], remainingIssues: ['registered Core launch requires an installed app'], nextTaskNotes: [] };
        this.runs.set(snapshot.runId, { runId: snapshot.runId, threadId: 'thread-' + snapshot.kind, activeTurnId: 'turn-1', terminal: true, resultValid: true, result });
        return { status: 'started' };
      }
      getRun(id) { return this.runs.get(id); }
      async readThread() { return { thread: { cwd: ${JSON.stringify(path.join(dir, 'project'))} }, turns: [{ id: 'turn-1', status: 'completed' }] }; }
      async close() {}
    }
  `);
  await assert.rejects(exec(process.execPath, [path.join(dir, "scripts/agent-codex-smoke.mjs"), "--workspace", path.join(dir, "project"), "--mode", "new-threads"], { env: { ...process.env, QINGDAN_CODEX_BIN: process.execPath }, windowsHide: true }), error => error.code === 1);
  const report = JSON.parse(await readFile(path.join(dir, "project.runner/report.json"), "utf8"));
  assert.equal(report.passed, false);
  assert.match(report.error, /blocked/);
  assert.match(report.error, /registered Core launch requires an installed app/);
  assert.doesNotMatch(report.error, /ENOENT/);
});
