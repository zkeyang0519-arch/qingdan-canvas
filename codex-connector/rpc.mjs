import { EventEmitter } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import pin from "./protocol.json" with { type: "json" };
import { ConnectorError, invalid } from "./errors.mjs";
const exec = promisify(execFile);
const allowed = new Set([
  "initialize",
  "account/read",
  "thread/list",
  "thread/read",
]);
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const protocol = () =>
  new ConnectorError(
    "CODEX_PROTOCOL_ERROR",
    "Codex 返回了无法识别的数据。",
    "检查版本后重新连接",
  );
function session(thread) {
  if (
    !object(thread) ||
    typeof thread.id !== "string" ||
    typeof thread.cwd !== "string" ||
    !thread.cwd ||
    typeof thread.updatedAt !== "number"
  )
    throw protocol();
  return {
    threadId: thread.id,
    title: String(thread.name || thread.preview || "未命名会话").slice(0, 200),
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
  };
}
export class ReadonlyCodex extends EventEmitter {
  constructor(candidate, options = {}) {
    super();
    this.candidate = candidate;
    this.options = options;
    this.pending = new Map();
    this.nextId = 0;
    this.connected = false;
    this.child = null;
    this.closed = false;
  }
  get pid() {
    return this.child?.pid ?? null;
  }
  async connect() {
    if (this.connecting || this.child || this.closed)
      throw new ConnectorError("CLIENT_USED", "请创建新的连接实例。");
    this.connecting = true;
    this.versionAbort = new AbortController();
    try {
      this.versionCheck = exec(
        this.candidate.command,
        [...(this.candidate.args ?? []), "--version"],
        {
          env: this.options.env,
          windowsHide: true,
          timeout: this.options.timeoutMs ?? 10000,
          maxBuffer: 65536,
          signal: this.versionAbort.signal,
        },
      );
      const r = await this.versionCheck;
      if (this.closed) throw new ConnectorError("CODEX_CLOSED", "连接已关闭。");
      const match = r.stdout.trim().match(/^codex-cli ([0-9][\w.+-]{0,80})$/);
      if (!match || !pin.testedVersions.includes(match[1]))
        throw new ConnectorError(
          "CODEX_VERSION_MISMATCH",
          `此连接器支持 Codex ${pin.testedVersions.join("、")}；${match ? `检测到 ${match[1]}` : "未识别到有效版本"}。`,
          "更新连接器或选择兼容的 Codex",
        );
      this.version = match[1];
      const child = spawn(
        this.candidate.command,
        [...(this.candidate.args ?? []), "app-server", "--stdio"],
        {
          env: this.options.env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        },
      );
      this.child = child;
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      child.stdout.on("data", (chunk) => {
        if (this.closed) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 8_000_000) {
          this.fail(protocol());
          return;
        }
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          try {
            this.receive(JSON.parse(line));
          } catch {
            this.fail(protocol());
            break;
          }
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", () =>
        this.fail(
          new ConnectorError(
            "CODEX_START_FAILED",
            "Codex 无法启动。",
            "检查路径和权限",
          ),
        ),
      );
      child.stdin.on("error", () =>
        this.fail(
          new ConnectorError("CODEX_EXITED", "Codex 连接已断开。", "重新连接"),
        ),
      );
      child.once("exit", () =>
        this.fail(
          new ConnectorError(
            "CODEX_EXITED",
            "Codex 子进程已退出。",
            "重新连接",
          ),
        ),
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: "qingdan_connection_check",
          title: "Codex 连接器",
          version: pin.connectorVersion,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      if (!object(initialized) || typeof initialized.userAgent !== "string")
        throw protocol();
      this.write({ method: "initialized", params: {} });
      this.connected = true;
      return { version: this.version };
    } catch (e) {
      const cancelled = this.closed && e?.name === "AbortError";
      await this.close();
      if (e instanceof ConnectorError) throw e;
      if (cancelled) throw new ConnectorError("CODEX_CLOSED", "连接已关闭。");
      throw new ConnectorError(
        e?.killed ? "CODEX_TIMEOUT" : "CODEX_START_FAILED",
        e?.killed ? "Codex 启动检查超时。" : "无法启动指定的 Codex。",
        "检查程序路径后重试",
      );
    }
  }
  write(value) {
    if (this.closed || !this.child?.stdin.writable)
      throw new ConnectorError("CODEX_EXITED", "Codex 连接已断开。");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  receive(packet) {
    if (!object(packet)) throw protocol();
    if (typeof packet.method === "string") {
      if (packet.id !== undefined)
        this.write({
          id: packet.id,
          error: {
            code: -32601,
            message: "This connector only reads account and session metadata.",
          },
        });
      return;
    }
    const p = this.pending.get(packet.id);
    if (!p) return;
    this.pending.delete(packet.id);
    clearTimeout(p.timer);
    if (packet.error)
      p.reject(
        new ConnectorError(
          "CODEX_RPC_ERROR",
          "Codex 未能完成本次读取。",
          "重新读取或检查 Codex 状态",
        ),
      );
    else if ("result" in packet) p.resolve(packet.result);
    else p.reject(protocol());
  }
  request(method, params) {
    if (!allowed.has(method))
      return Promise.reject(
        new ConnectorError(
          "METHOD_NOT_ALLOWED",
          "此程序只允许连接检查和会话读取。",
        ),
      );
    if (!this.connected && method !== "initialize")
      return Promise.reject(
        new ConnectorError("CODEX_EXITED", "Codex 尚未连接。"),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new ConnectorError(
          "CODEX_TIMEOUT",
          "Codex 读取响应超时。",
          "重新连接",
        );
        reject(e);
        this.fail(e);
      }, this.options.timeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  fail(error) {
    const wasActive = !this.closed;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (wasActive) {
      this.emit("disconnect", error);
      void this.close();
    }
  }
  async account() {
    const r = await this.request("account/read", { refreshToken: false });
    if (
      !object(r) ||
      typeof r.requiresOpenaiAuth !== "boolean" ||
      !(
        r.account === null ||
        (object(r.account) && typeof r.account.type === "string")
      )
    )
      throw protocol();
    return {
      status: r.account
        ? "signed_in"
        : r.requiresOpenaiAuth
          ? "required"
          : "not_required",
      type: r.account?.type ?? null,
      plan: typeof r.account?.planType === "string" ? r.account.planType : null,
    };
  }
  async listSessions(query = {}) {
    if (
      typeof query.searchTerm !== "undefined" &&
      (typeof query.searchTerm !== "string" || query.searchTerm.length > 200)
    )
      throw invalid("搜索内容最多 200 字。");
    if (
      query.cursor !== undefined &&
      query.cursor !== null &&
      (typeof query.cursor !== "string" || query.cursor.length > 4096)
    )
      throw invalid("分页标识无效。");
    const r = await this.request("thread/list", {
      cursor: query.cursor || null,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      modelProviders: [],
      archived: false,
      useStateDbOnly: true,
      ...(query.searchTerm ? { searchTerm: query.searchTerm } : {}),
    });
    if (
      !object(r) ||
      !Array.isArray(r.data) ||
      r.data.length > 50 ||
      !(r.nextCursor === null || typeof r.nextCursor === "string")
    )
      throw protocol();
    const sessions = [];
    for (const t of r.data) {
      if (!object(t)) throw protocol();
      if (!t.cwd || t.ephemeral || t.parentThreadId) continue;
      sessions.push(session(t));
    }
    return { sessions, nextCursor: r.nextCursor };
  }
  async readSession(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))
      throw invalid("会话编号无效。");
    const r = await this.request("thread/read", {
      threadId: id,
      includeTurns: false,
    });
    if (
      !object(r) ||
      r.thread?.id !== id ||
      r.thread?.ephemeral ||
      r.thread?.parentThreadId
    )
      throw protocol();
    return session(r.thread);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.connected = false;
    this.versionAbort?.abort();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ConnectorError("CODEX_CLOSED", "连接已关闭。"));
    }
    this.pending.clear();
    this.closing = (async () => {
      await this.versionCheck?.catch(() => {});
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const wait = (ms) =>
        new Promise((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            child.off("exit", done);
            resolve();
          };
          timer = setTimeout(done, ms);
          child.once("exit", done);
        });
      child.stdin.end();
      await wait(this.options.shutdownMs ?? 1200);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await wait(500);
      }
    })();
    return this.closing;
  }
}
