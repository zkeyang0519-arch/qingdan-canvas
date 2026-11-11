import { spawn as spawnProcess } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stopOwnedChild } from "./stop-child.mjs";
import { DatabaseSync } from "node:sqlite";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const smokeScript = path.join(projectRoot, "scripts/agent-codex-smoke.mjs");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const validRequestId = (value) =>
  typeof value === "string" && uuid.test(value);
function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// This local experience harness runs the already-verified smoke program. It is
// deliberately not a cloud Runner, pairing endpoint, or arbitrary execution API.
export class ExperienceService {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot || projectRoot);
    this.stateDir = path.resolve(
      options.stateDir || path.join(this.projectRoot, ".tmp/agent-experience"),
    );
    this.spawn = options.spawn || spawnProcess;
    this.children = new Map();
    this.closed = false;
    mkdirSync(this.stateDir, { recursive: true });
    this.filename = path.join(this.stateDir, "sessions.json");
    this.ledger = readJson(this.filename) || {
      version: 1,
      currentId: null,
      sessions: {},
    };
    if (
      this.ledger.version !== 1 ||
      !this.ledger.sessions ||
      typeof this.ledger.sessions !== "object"
    )
      throw Error("本机体验记录无法读取，请保留文件后检查。");
    for (const [id, entry] of Object.entries(this.ledger.sessions)) {
      if (
        !validRequestId(id) ||
        entry.id !== id ||
        entry.workspace !== this.workspace(id)
      )
        throw Error("本机体验记录的目录不匹配。");
      if (entry.status === "running") {
        entry.status = "needs_review";
        entry.error = "服务曾中断，请先核对原来的会话。";
      }
    }
    this.save();
  }
  workspace(id) {
    return path.join(this.stateDir, "projects", id);
  }
  save() {
    const temp = `${this.filename}.tmp`;
    writeFileSync(temp, JSON.stringify(this.ledger, null, 2));
    renameSync(temp, this.filename);
  }
  confirmedStopped(entry) {
    const filename = path.join(`${entry.workspace}.runner`, "runner.sqlite");
    if (!existsSync(filename)) return false;
    let db;
    try {
      db = new DatabaseSync(filename, { readOnly: true });
      const runs = db
        .prepare("SELECT data FROM runs")
        .all()
        .map((row) => JSON.parse(row.data));
      // No accepted run, or all accepted runs have confirmed terminal states.
      // An unknown launch/turn keeps active=true and must still be reconciled.
      return runs.every((run) => run.terminal === true && run.active === false);
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }
  resultStatus(entry, report) {
    if (report?.passed && report.finishedAt) return "passed";
    return report?.finishedAt && this.confirmedStopped(entry)
      ? "failed"
      : "needs_review";
  }
  view(entry) {
    if (!entry) return null;
    const report = readJson(
      path.join(`${entry.workspace}.runner`, "report.json"),
    );
    // A new reconciliation process may still be replacing the previous report.
    const recent =
      report &&
      Date.parse(report.startedAt || report.finishedAt) >=
        Date.parse(entry.attemptAt);
    if (!this.children.has(entry.id) && recent && report.finishedAt) {
      const status = this.resultStatus(entry, report);
      const error =
        status === "passed" ? null : report.error || "请核对本机测试结果。";
      if (entry.status !== status || entry.error !== error) {
        entry.status = status;
        entry.error = error;
        this.save();
      }
    }
    return { ...entry, report: recent ? report : null };
  }
  async status() {
    return { current: this.view(this.ledger.sessions[this.ledger.currentId]) };
  }
  async start(id) {
    if (this.closed) throw Error("本机服务正在关闭。");
    if (!validRequestId(id)) throw Error("测试请求编号无效。");
    if (this.ledger.sessions[id]) return this.view(this.ledger.sessions[id]);
    const current = this.view(this.ledger.sessions[this.ledger.currentId]);
    if (["running", "needs_review"].includes(current?.status))
      throw Error("已有测试正在运行或需要核对，请先处理上次测试。");
    const entry = {
      id,
      workspace: this.workspace(id),
      status: "running",
      startedAt: new Date().toISOString(),
      attemptAt: new Date().toISOString(),
      progress: [],
      error: null,
    };
    this.ledger.sessions[id] = entry;
    this.ledger.currentId = id;
    // Persist the identity before spawning. A retry can only resume this path.
    this.save();
    this.launch(entry);
    return this.view(entry);
  }
  async reconcile(id) {
    if (this.closed) throw Error("本机服务正在关闭。");
    const entry = this.ledger.sessions[id];
    if (!entry || id !== this.ledger.currentId)
      throw Error("找不到当前测试，请刷新状态。");
    const latest = this.view(entry);
    if (latest.status === "passed" || this.children.has(id)) return latest;
    entry.status = "running";
    entry.error = null;
    entry.attemptAt = new Date().toISOString();
    this.save();
    this.launch(entry);
    return this.view(entry);
  }
  launch(entry) {
    let child;
    try {
      child = this.spawn(
        process.execPath,
        [smokeScript, "--workspace", entry.workspace, "--mode", "new-threads"],
        {
          cwd: this.projectRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      entry.status = "failed";
      entry.error = "未能启动本机测试进程。";
      this.save();
      return;
    }
    this.children.set(entry.id, child);
    // Never forward CLI stderr or account data to the page or persistent ledger.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 8192) return;
      try {
        const event = JSON.parse(line);
        if (!["capabilities", "started", "verified"].includes(event.phase))
          return;
        entry.progress.push({
          phase: event.phase,
          ...(["summary", "a", "b"].includes(event.key)
            ? { key: event.key }
            : {}),
          ...(typeof event.threadId === "string"
            ? { threadId: event.threadId }
            : {}),
        });
        entry.progress = entry.progress.slice(-12);
        this.save();
      } catch {
        /* Non-protocol output is not part of the UI contract. */
      }
    });
    let settled = false;
    const finish = (spawnFailed = false) => {
      if (settled) return;
      settled = true;
      lines.close();
      this.children.delete(entry.id);
      try {
        const report = this.view(entry).report;
        entry.status = spawnFailed
          ? "failed"
          : this.resultStatus(entry, report);
        entry.error = report?.passed
          ? null
          : report?.error || "本机测试未确认完成，请核对原会话后重试。";
      } catch {
        entry.status = "needs_review";
        entry.error = "测试结果未完整写入，请核对原会话。";
      }
      this.save();
    };
    child.once("error", () => finish(true));
    child.once("exit", () => finish());
  }
  async inspect(work) {
    if (this.closed) throw Error("本机服务正在关闭。");
    const { CodexAdapter, RunnerStore } =
      await import("../../runner/dist/index.js");
    const workspaces = [{ workspaceId: "project", root: this.projectRoot }];
    const current = this.ledger.sessions[this.ledger.currentId];
    if (current && existsSync(current.workspace))
      workspaces.push({ workspaceId: "test", root: current.workspace });
    const store = new RunnerStore(":memory:");
    const adapter = new CodexAdapter({
      store,
      runnerId: "local-experience-inspector",
      workspaces,
      command: process.env.QINGDAN_CODEX_BIN || "codex",
    });
    try {
      await adapter.connect();
      return await work(adapter, workspaces);
    } finally {
      await adapter.close();
      store.close();
    }
  }
  async connection() {
    return this.inspect(async (adapter) => {
      const account = await adapter.account();
      const projects = await adapter.listProjects();
      const { codexVersion: version } = readJson(
        path.join(projectRoot, "runner/protocol-version.json"),
      );
      return {
        authenticated: account.account !== null || !account.requiresOpenaiAuth,
        version,
        projects: projects.map((p) => ({
          ...p,
          threads: p.threads.slice(0, 100),
        })),
      };
    });
  }
  async thread(workspaceId, threadId) {
    if (!["project", "test"].includes(workspaceId) || !validRequestId(threadId))
      throw Error("会话或项目编号无效。");
    return this.inspect(async (adapter, roots) => {
      if (!roots.some((r) => r.workspaceId === workspaceId))
        throw Error("项目尚未注册。");
      const history = await adapter.readThread(threadId, workspaceId);
      const messages = history.turns.flatMap((turn) =>
        turn.items.flatMap((item) => {
          if (item.type === "agentMessage")
            return [{ role: "assistant", text: item.text }];
          if (item.type === "userMessage")
            return [
              {
                role: "user",
                text: item.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n"),
              },
            ];
          return [];
        }),
      );
      return { title: history.thread.name || "会话内容", messages };
    });
  }
  async close() {
    this.closed = true;
    // Stop only the owned smoke process and descendants. Windows kill(SIGTERM)
    // does not run Node signal handlers, so tree cleanup is explicit there.
    const waiting = [];
    for (const [id, child] of this.children) {
      const entry = this.ledger.sessions[id];
      entry.status = "needs_review";
      entry.error = "本机服务已停止，请重新启动后核对。";
      waiting.push(
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 4000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
      );
      waiting.push(stopOwnedChild(child));
    }
    this.save();
    await Promise.all(waiting);
  }
}
