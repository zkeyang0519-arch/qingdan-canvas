import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverCodex } from "./discovery.mjs";
import { ReadonlyCodex } from "./rpc.mjs";
import { ConnectorError, problem, invalid } from "./errors.mjs";
import pin from "./protocol.json" with { type: "json" };
const steps = [
  ["discovery", "发现 Codex"],
  ["protocol", "启动与协议握手"],
  ["account", "检查登录状态"],
  ["sessions", "读取会话"],
];
export class Connector {
  constructor(options) {
    this.options = options;
    this.config = { manualPath: "", cachedPath: "" };
    this.client = null;
    this.connection = { instanceId: randomUUID(), generation: 0 };
    this.closed = false;
    this.probe = null;
    this.configQueue = Promise.resolve();
    this.retryCount = 0;
    this.retryWindow = Date.now();
    this.events = [];
    this.view = {
      status: "idle",
      checks: steps.map(([id, label]) => ({ id, label, state: "pending" })),
      error: null,
      updatedAt: null,
      sessionCount: 0,
      warnings: [],
    };
  }
  status() {
    return structuredClone({
      ...this.view,
      connection: this.connection,
      preferences: { manualPath: this.config.manualPath },
      retryAttempt: this.retryCount,
    });
  }
  record(code) {
    this.events.push({ at: new Date().toISOString(), code });
    this.events = this.events.slice(-40);
  }
  step(id, state) {
    this.view.checks = this.view.checks.map((x) =>
      x.id === id ? { ...x, state } : x,
    );
  }
  async load() {
    if (this.loaded) return;
    await mkdir(this.options.stateDir, { recursive: true });
    try {
      const c = JSON.parse(
        await readFile(path.join(this.options.stateDir, "config.json"), "utf8"),
      );
      if (
        !c ||
        typeof c.manualPath !== "string" ||
        typeof c.cachedPath !== "string"
      )
        throw Error();
      this.config = { manualPath: c.manualPath, cachedPath: c.cachedPath };
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new ConnectorError(
          "CONFIG_INVALID",
          "连接器路径偏好无法读取。",
          "恢复自动发现以重建路径偏好",
        );
    }
    this.loaded = true;
  }
  async save() {
    const target = path.join(this.options.stateDir, "config.json"),
      temp = target + "." + randomUUID();
    await writeFile(temp, JSON.stringify(this.config), { mode: 0o600 });
    await rename(temp, target);
  }
  schedule(error) {
    if (
      this.closed ||
      this.options.autoRetry === false ||
      this.retryTimer ||
      !["CODEX_EXITED", "CODEX_TIMEOUT", "CODEX_START_FAILED"].includes(
        error.code,
      )
    )
      return;
    if (Date.now() - this.retryWindow > 300000) {
      this.retryWindow = Date.now();
      this.retryCount = 0;
    }
    if (this.retryCount >= 3) return;
    const delay = [1000, 3000, 10000][this.retryCount++];
    this.view.retryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.inspect({ automatic: true });
    }, delay);
    this.retryTimer.unref();
  }
  inspect({ automatic = false } = {}) {
    if (this.closed) return Promise.resolve(this.status());
    if (this.probe) return this.probe;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.view.retryAt = null;
    if (!automatic) {
      this.retryCount = 0;
      this.retryWindow = Date.now();
    }
    this.probe = this.runProbe().finally(() => {
      this.probe = null;
    });
    return this.probe;
  }
  async runProbe() {
    let stage = "discovery";
    this.view = {
      ...this.view,
      status: "connecting",
      error: null,
      checks: steps.map(([id, label]) => ({ id, label, state: "pending" })),
    };
    try {
      await this.load();
      if (this.closed) return this.status();
      const old = this.client;
      this.client = null;
      await old?.close();
      if (this.closed) return this.status();
      this.step(stage, "running");
      const found = await (this.options.discover ?? discoverCodex)({
        ...this.config,
      });
      this.view.warnings = found.warnings;
      if (!found.candidates.length)
        throw new ConnectorError(
          "CODEX_NOT_FOUND",
          "没有找到可用的本机 Codex。",
          "安装 Codex 或手动指定程序路径",
        );
      this.step(stage, "ok");
      stage = "protocol";
      this.step(stage, "running");
      let connected, error;
      for (const candidate of found.candidates) {
        if (this.closed) return this.status();
        const c = (this.options.createClient ?? ((x) => new ReadonlyCodex(x)))(
          candidate,
        );
        this.connection.generation++;
        this.client = c;
        this.probeFailure = null;
        c.on("disconnect", (e) => {
          if (this.closed || this.client !== c) return;
          if (this.probe) {
            this.probeFailure = e;
            return;
          }
          this.view.status = "error";
          this.view.error = problem(e);
          this.view.updatedAt = new Date().toISOString();
          this.record(this.view.error.code);
          this.schedule(this.view.error);
        });
        try {
          connected = await c.connect();
          this.view.install = {
            path: candidate.command,
            source: candidate.source,
          };
          this.config.cachedPath = candidate.command;
          break;
        } catch (e) {
          error = e;
          await c.close();
          this.client = null;
          if (this.config.manualPath) break;
        }
      }
      if (this.closed) {
        await this.client?.close();
        return this.status();
      }
      if (!connected)
        throw (
          error ??
          new ConnectorError("CODEX_START_FAILED", "没有可连接的 Codex 安装。")
        );
      this.view.version = connected.version;
      this.step(stage, "ok");
      stage = "account";
      this.step(stage, "running");
      this.view.auth = await this.client.account();
      this.step(
        stage,
        this.view.auth.status === "required" ? "attention" : "ok",
      );
      stage = "sessions";
      this.step(stage, "running");
      const page = await this.client.listSessions({});
      this.step(stage, "ok");
      if (this.closed) return this.status();
      this.view.sessionCount = page.sessions.length;
      await this.save();
      if (this.closed) return this.status();
      if (this.probeFailure || !this.client?.connected)
        throw (
          this.probeFailure ??
          new ConnectorError("CODEX_EXITED", "Codex 连接已断开。", "重新连接")
        );
      this.view.status =
        this.view.auth.status === "required" ? "login_required" : "ready";
      this.view.updatedAt = new Date().toISOString();
      this.record("CONNECTION_VERIFIED");
    } catch (e) {
      if (!this.closed) {
        this.step(stage, "error");
        this.view.status = "error";
        this.view.error = problem(e);
        this.view.updatedAt = new Date().toISOString();
        this.record(this.view.error.code);
        const old = this.client;
        this.client = null;
        await old?.close();
        this.schedule(this.view.error);
      }
    }
    if (this.closed) this.view.status = "closed";
    return this.status();
  }
  configure(manualPath) {
    if (typeof manualPath !== "string" || manualPath.length > 4096)
      return Promise.reject(invalid("程序路径无效。"));
    const next = this.configQueue
      .catch(() => {})
      .then(async () => {
        await this.probe;
        if (this.closed)
          throw new ConnectorError("CONNECTOR_CLOSED", "连接器已退出。");
        try {
          await this.load();
        } catch (e) {
          if (e.code !== "CONFIG_INVALID") throw e;
          const file = path.join(this.options.stateDir, "config.json");
          await rename(file, file + ".backup-" + Date.now()).catch(() => {});
          this.loaded = true;
        }
        this.config = { manualPath: manualPath.trim(), cachedPath: "" };
        await this.save();
        return this.inspect();
      });
    this.configQueue = next;
    return next;
  }
  async read(operation) {
    const c = this.client;
    if (!c?.connected)
      throw new ConnectorError(
        "CODEX_NOT_CONNECTED",
        "请先完成 Codex 连接检查。",
        "重新连接",
      );
    try {
      const result = await operation(c);
      if (c !== this.client || this.closed)
        throw new ConnectorError(
          "CONNECTION_CHANGED",
          "连接已更新，请重新读取。",
        );
      return result;
    } catch (e) {
      if (this.client === c && !this.closed && e.code !== "INVALID_INPUT") {
        this.view.status = "error";
        this.view.error = problem(e);
        this.record(this.view.error.code);
        this.client = null;
        await c.close();
        this.schedule(this.view.error);
      }
      throw e;
    }
  }
  listSessions(query) {
    return this.read((c) => c.listSessions(query));
  }
  async readSession(id) {
    return this.read(async (c) => {
      const value = await c.readSession(id);
      let directoryExists = false;
      try {
        directoryExists = (await stat(value.cwd)).isDirectory();
      } catch {}
      return { ...value, directoryExists };
    });
  }
  diagnostics() {
    return {
      connectorVersion: pin.connectorVersion,
      platform: process.platform,
      node: process.version,
      codexVersion: this.view.version ?? null,
      status: this.view.status,
      authStatus: this.view.auth?.status ?? null,
      checks: this.view.checks.map(({ id, state }) => ({ id, state })),
      errorCode: this.view.error?.code ?? null,
      warnings: this.view.warnings,
      retryAttempt: this.retryCount,
      updatedAt: this.view.updatedAt,
      events: [...this.events],
    };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.view.status = "closed";
    await this.client?.close();
    await this.probe;
    await this.configQueue.catch(() => {});
    await this.client?.close();
    this.client = null;
    this.view.status = "closed";
  }
}
