import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import {
  CodexAdapter,
  RunnerStore,
  readGitBaseline,
} from "../runner/dist/index.js";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    mode: { type: "string", default: "capabilities" },
    "timeout-ms": { type: "string", default: "300000" },
    model: { type: "string" },
  },
});
if (!values.workspace || !path.isAbsolute(values.workspace))
  throw Error("Provide an explicit absolute --workspace path.");
if (!["capabilities", "new-threads"].includes(values.mode))
  throw Error("Use --mode capabilities or new-threads.");
const workspace = path.resolve(values.workspace);
const stateDir = `${workspace}.runner`;
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)
  throw Error("Invalid timeout.");
await mkdir(workspace, { recursive: true });
await mkdir(stateDir, { recursive: true });
const reportPath = path.join(stateDir, "report.json");
const ledgerPath = path.join(stateDir, "smoke.json");
const command = process.env.QINGDAN_CODEX_BIN ?? "codex";
const version = execFileSync(command, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const store = new RunnerStore(path.join(stateDir, "runner.sqlite"));
const adapter = new CodexAdapter({
  store,
  command,
  runnerId: "local-smoke-runner",
  workspaces: [{ workspaceId: "smoke-workspace", root: workspace }],
  ...(values.model ? { model: values.model } : {}),
  effort: "low",
});
const report = {
  startedAt: new Date().toISOString(),
  mode: values.mode,
  workspace,
  node: process.version,
  codex: version,
  passed: false,
  runs: [],
};
const sha = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const exec = promisify(execFile);
const saveReport = async () => {
  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
  await rename(`${reportPath}.tmp`, reportPath);
};
let ledger;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  void adapter.close();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function snapshot(key) {
  const filename = path.join(stateDir, `${key}.snapshot.json`);
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const task =
    key === "summary"
      ? null
      : {
          taskRef: {
            canvasId: "smoke-canvas",
            noteId: "smoke-note",
            taskId: `smoke-${key}`,
          },
          planId: "smoke-plan",
          text: `Codex 接入验证：任务 ${key.toUpperCase()}`,
          instruction:
            key === "a"
              ? `读取 README.md 中的 fixtureToken，创建 task-a.txt，只写 A:${ledger.token} 和一个换行。读取验证后返回结构化任务结果。`
              : `先读取 task-a.txt，确认其内容为 A:${ledger.token}。创建 task-b.txt，只写 B:${ledger.token} 和一个换行。读取验证后返回结构化任务结果。`,
          acceptance: [
            {
              id: `artifact-${key}`,
              kind: "artifact",
              description: "测试文件内容匹配",
              required: true,
              relativePath: `task-${key}.txt`,
              predicate: {
                type: "textContains",
                text: `${key.toUpperCase()}:${ledger.token}`,
              },
            },
          ],
          dependsOn: key === "b" ? ["smoke-a"] : [],
          priority: 2,
          dueAt: null,
          sourceTextHash: sha(`smoke-${key}`),
          specRevision: 1,
          specHash: sha({ key, token: ledger.token }),
          specStatus: "ready",
          createdByMessageId: "explicit-local-smoke",
        };
  const value = {
    snapshotId: randomUUID(),
    runId: ledger.runIds[key],
    kind: key === "summary" ? "summary" : "task",
    ownerId: "local-smoke-owner",
    bindingId: "local-smoke-binding",
    bindingRevision: 1,
    workspaceId: "smoke-workspace",
    summaryRevision: key === "summary" ? 0 : 1,
    memoryEpoch: 0,
    sourceRefs: [],
    capturedAt: new Date().toISOString(),
    allowedCheckIds: [],
    context: {
      projectSummary:
        report.runs.find((run) => run.kind === "summary")?.result ?? null,
      decisions: [
        "本次只验证轻单对本地 Codex 的接入；操作范围是当前临时测试目录。",
      ],
      previousTaskNotes:
        key === "b" ? ["前项已经通过宿主校验：task-a.txt 内容正确。"] : [],
      gitBaseline: await readGitBaseline(workspace),
    },
    task,
  };
  const result = { ...value, payloadHash: sha(value) };
  await writeFile(filename, JSON.stringify(result, null, 2));
  return result;
}

try {
  const info = await adapter.connect();
  const account = await adapter.account();
  report.authenticated =
    account.account !== null || !account.requiresOpenaiAuth;
  report.accountType = account.account?.type ?? null;
  report.platform = info?.platformOs;
  report.discoveredProjects = (await adapter.listProjects()).map((project) => ({
    workspaceId: project.workspaceId,
    threadCount: project.threads.length,
  }));
  console.log(
    JSON.stringify({
      phase: "capabilities",
      codex: version,
      authenticated: report.authenticated,
      accountType: report.accountType,
      platform: report.platform,
    }),
  );
  if (values.mode === "new-threads") {
    if (!report.authenticated)
      throw Error(
        "Codex 当前 Windows 账号未登录；请在该账号运行 codex login。",
      );
    if (!ledger) {
      if ((await readdir(workspace)).length)
        throw Error("新建 smoke 只接受空目录，防止覆盖已有项目。");
      ledger = {
        token: randomUUID(),
        runIds: { summary: randomUUID(), a: randomUUID(), b: randomUUID() },
      };
      await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
      await writeFile(
        path.join(workspace, "README.md"),
        `# 轻单本机接入测试\nfixtureToken: ${ledger.token}\n本项目只用于总结、任务 A 和任务 B 的独立会话验收。\n`,
      );
      await writeFile(
        path.join(workspace, "AGENTS.md"),
        "本目录是独立自动化接入验收项目。只处理当前消息指定的简单任务，直接执行，无需扩展设计。只可创建 task-a.txt 或 task-b.txt；其他文件只读。使用轻单提供的回执工具记录结果，最终用自然语言回复。\n",
      );
      const git = (args) =>
        exec("git", ["-C", workspace, ...args], { windowsHide: true });
      await git(["init", "--initial-branch=codex-smoke"]);
      await git(["add", "--", "README.md", "AGENTS.md"]);
      await git([
        "-c",
        "user.name=Qingdan Smoke",
        "-c",
        "user.email=smoke@localhost",
        "commit",
        "-m",
        "Initialize isolated Codex smoke fixture",
      ]);
    }
    for (const key of ["summary", "a", "b"]) {
      if (interrupted) throw Error("本机测试已中断，请核对原会话后恢复。");
      const value = await snapshot(key);
      const launch = await adapter.startFreshRun(value);
      if (launch.status === "reconciliation_required") {
        const reconciled = await adapter.reconcileRun(value.runId);
        if (reconciled.status === "reconciliation_required")
          throw Error(`运行 ${value.runId} 需要人工核实，未重复派发。`);
      }
      console.log(
        JSON.stringify({
          phase: "started",
          key,
          runId: value.runId,
          threadId: adapter.getRun(value.runId).threadId,
        }),
      );
      const deadline = Date.now() + timeoutMs;
      let run;
      while (Date.now() < deadline) {
        if (interrupted) throw Error("本机测试已中断，请核对原会话后恢复。");
        run = adapter.getRun(value.runId);
        if (run.terminal) break;
        if (run.status === "reconciliation_required")
          throw Error(run.resultError);
        if (adapter.pendingRequests(value.runId).length)
          throw Error(
            `运行 ${value.runId} 正在等待审批或输入，测试没有自动批准。`,
          );
        await adapter
          .waitForRun(value.runId, Math.min(3000, deadline - Date.now()))
          .catch((error) => {
            if (error.code !== "WAIT_TIMEOUT") throw error;
          });
      }
      run = adapter.getRun(value.runId);
      if (!run.terminal || !run.resultValid)
        throw Error(run.resultError ?? `运行 ${value.runId} 未在限时内完成。`);
      if (key !== "summary") {
        const contents = (
          await readFile(path.join(workspace, `task-${key}.txt`), "utf8")
        ).replaceAll("\r\n", "\n");
        if (contents !== `${key.toUpperCase()}:${ledger.token}\n`)
          throw Error(`task-${key}.txt 内容验收失败。`);
        if (run.result.outcome !== "done")
          throw Error(`任务返回 ${run.result.outcome}`);
      }
      const history = await adapter.readThread(run.threadId, "smoke-workspace");
      report.runs.push({
        key,
        kind: value.kind,
        runId: value.runId,
        threadId: run.threadId,
        turnId: run.activeTurnId,
        cwd: history.thread.cwd,
        observedTurnStatus: history.turns.find(
          (turn) => turn.id === run.activeTurnId,
        )?.status,
        result: run.result,
        artifactVerified: key !== "summary",
      });
      await saveReport();
      console.log(
        JSON.stringify({
          phase: "verified",
          key,
          threadId: run.threadId,
          turnId: run.activeTurnId,
        }),
      );
    }
    if (
      new Set(report.runs.map((run) => run.threadId)).size !== 3 ||
      report.runs.some((run) => run.observedTurnStatus !== "completed")
    )
      throw Error("会话独立性或历史终态验收失败。");
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await adapter.close();
  store.close();
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(
    JSON.stringify({
      passed: report.passed,
      reportPath,
      ...(report.error ? { error: report.error } : {}),
    }),
  );
}
