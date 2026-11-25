import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  adapterContract,
  connectorFailure,
  defaultAdapter,
  protocolDiagnostic,
  validateAdapter,
} from "./connector-policy.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobs = new Map();
const hostVersion = 1;
const maxAttempts = 2;
const repairTimeout = 180000;
const summary = {
  checking: "正在检测协议兼容性",
  repairing: "Pi 正在适配连接器",
  validating: "正在验证适配结果",
  ready: "连接与工具发现已验证",
  rolled_back: "已恢复上一版连接器",
  blocked: "自动适配未通过，请查看诊断后重试",
};

export class ConnectorMaintenance {
  constructor(directory, { propose, timeoutMs = repairTimeout } = {}) {
    this.root = path.resolve(directory, "connectors");
    mkdirSync(this.root, { recursive: true });
    this.propose = propose;
    this.timeoutMs = timeoutMs;
    this.validators = new Map();
    this.closed = false;
    this.controller = new AbortController();
    this.db = new DatabaseSync(path.join(this.root, "registry.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS adapters(
        fingerprint TEXT PRIMARY KEY, version TEXT NOT NULL,
        active TEXT, previous TEXT, revision INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'checking',
        diagnostic TEXT, verified TEXT NOT NULL DEFAULT '[]',
        owner TEXT, lease INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, at INTEGER NOT NULL,
        status TEXT NOT NULL, adapter TEXT, diagnostic TEXT);
    `);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM pragma_table_info('adapters') WHERE name='failureKey'",
        )
        .get()
    )
      this.db.exec("ALTER TABLE adapters ADD COLUMN failureKey TEXT");
  }
  key(fingerprint) {
    return digest({ fingerprint, hostVersion });
  }
  row(fingerprint) {
    return this.db
      .prepare("SELECT * FROM adapters WHERE fingerprint=?")
      .get(this.key(fingerprint));
  }
  remember(fingerprint, version) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO adapters(fingerprint,version) VALUES(?,?)",
      )
      .run(this.key(fingerprint), version);
  }
  read(id) {
    if (!id) return structuredClone(defaultAdapter);
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("连接器版本无效。");
    const value = validateAdapter(
      JSON.parse(readFileSync(path.join(this.root, id + ".json"), "utf8")),
    );
    if (digest(value) !== id) throw Error("连接器校验失败。");
    return value;
  }
  stage(candidate) {
    const value = validateAdapter(candidate),
      id = digest(value);
    const file = path.join(this.root, id + ".json");
    try {
      writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      this.read(id);
    }
    return { id, value };
  }
  status(fingerprint) {
    const row = fingerprint && this.row(fingerprint);
    if (!row) return null;
    return {
      status: row.status,
      message: summary[row.status],
      version: row.version,
      fingerprint: row.fingerprint,
      revision: row.revision,
      attempts: row.attempts,
      adapter: row.active?.slice(0, 12) || "builtin",
      verified: JSON.parse(row.verified),
      diagnostic: row.diagnostic ? JSON.parse(row.diagnostic) : null,
    };
  }
  event(fingerprint, status, diagnostic, adapter) {
    const key = this.key(fingerprint),
      data = diagnostic ? JSON.stringify(diagnostic) : null;
    this.db
      .prepare("UPDATE adapters SET status=?,diagnostic=? WHERE fingerprint=?")
      .run(status, data, key);
    this.db
      .prepare(
        "INSERT INTO events(fingerprint,at,status,adapter,diagnostic) VALUES(?,?,?,?,?)",
      )
      .run(key, Date.now(), status, adapter ?? null, data);
  }
  retry(fingerprint) {
    if (!fingerprint) return;
    this.db
      .prepare(
        "UPDATE adapters SET attempts=0,status='checking',diagnostic=NULL WHERE fingerprint=? AND lease<?",
      )
      .run(this.key(fingerprint), Date.now());
  }
  async verify(open, adapter, signal) {
    const client = await open(adapter, signal);
    try {
      const catalog = await client.listTools({ signal });
      if (
        !Array.isArray(catalog) ||
        !catalog.length ||
        catalog.some(
          (tool) =>
            typeof tool.name !== "string" ||
            !tool.inputSchema ||
            typeof tool.inputSchema !== "object",
        )
      )
        throw Object.assign(Error("连接器未提供有效工具目录。"), {
          code: "CONNECTOR_PROTOCOL",
        });
      const exercised = client.verifiedMethods || [];
      const required = [
        ...Object.keys(adapter.requests),
        ...Object.keys(adapter.responses),
      ].filter(
        (method) =>
          !client.contractMethods || client.contractMethods.includes(method),
      );
      if (required.some((method) => !exercised.includes(method)))
        throw Object.assign(Error("补丁包含尚未通过固定探测的接口。"), {
          code: "CONNECTOR_UNVERIFIED",
        });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  async connect({ fingerprint, version, kind, open, validate = open, signal }) {
    signal = AbortSignal.any([signal, this.controller.signal]);
    signal.throwIfAborted();
    if (this.closed) throw Error("连接维护器已关闭。");
    this.remember(fingerprint, version);
    this.validators.set(this.key(fingerprint) + ":" + kind, {
      open: validate,
      kind,
    });
    const snapshot = this.row(fingerprint);
    try {
      const client = await this.verify(
        open,
        this.read(snapshot.active),
        signal,
      );
      client.validationKey = `${this.key(fingerprint)}:${snapshot.active || "builtin"}`;
      const verified = new Set(JSON.parse(this.row(fingerprint).verified));
      verified.add(kind);
      this.db
        .prepare("UPDATE adapters SET verified=? WHERE fingerprint=?")
        .run(JSON.stringify([...verified]), this.key(fingerprint));
      if (!["repairing", "validating"].includes(this.row(fingerprint).status))
        this.event(fingerprint, "ready");
      return client;
    } catch (error) {
      if (signal.aborted) throw error;
      if (connectorFailure(error) === "network") {
        await delay(250, undefined, { signal });
        const latest = this.row(fingerprint);
        const retried = await this.verify(
          open,
          this.read(latest.active),
          signal,
        );
        retried.validationKey = `${this.key(fingerprint)}:${latest.active || "builtin"}`;
        return retried;
      }
      if (connectorFailure(error) !== "protocol") throw error;
      if (this.row(fingerprint).revision !== snapshot.revision) {
        const latest = this.row(fingerprint);
        const retried = await this.verify(
          open,
          this.read(latest.active),
          signal,
        );
        retried.validationKey = `${this.key(fingerprint)}:${latest.active || "builtin"}`;
        return retried;
      }
      const work = this.repair({
        fingerprint,
        version,
        kind,
        open: validate,
        error,
      });
      let abort;
      try {
        await Promise.race([
          work,
          new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      signal.throwIfAborted();
      const latest = this.row(fingerprint);
      const recovered = await this.verify(
        open,
        this.read(latest.active),
        signal,
      );
      recovered.validationKey = `${this.key(fingerprint)}:${latest.active || "builtin"}`;
      return recovered;
    }
  }
  repair(input) {
    const key = path.join(this.root, this.key(input.fingerprint));
    if (!jobs.has(key))
      jobs.set(
        key,
        this.performRepair(input).finally(() => jobs.delete(key)),
      );
    return jobs.get(key);
  }
  async performRepair({ fingerprint, version, kind, open, error }) {
    const key = this.key(fingerprint),
      owner = randomUUID();
    const failureKey = digest({ kind, diagnostic: protocolDiagnostic(error) });
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    // SQLite owns the lease so two local hosts cannot publish competing fixes.
    while (true) {
      signal.throwIfAborted();
      const row = this.row(fingerprint);
      if (
        row.failureKey === failureKey &&
        row.status === "blocked" &&
        row.attempts >= maxAttempts
      )
        throw Object.assign(Error(summary.blocked), {
          code: "CONNECTOR_REPAIR_BLOCKED",
        });
      const acquired = this.db
        .prepare(
          "UPDATE adapters SET owner=?,lease=? WHERE fingerprint=? AND lease<?",
        )
        .run(owner, Date.now() + this.timeoutMs + 1000, key, Date.now());
      if (acquired.changes) break;
      await delay(150, undefined, { signal });
      const current = this.row(fingerprint);
      if (current.revision !== row.revision) return;
    }
    const baseline = this.row(fingerprint);
    try {
      if (baseline.failureKey !== failureKey) {
        this.db
          .prepare(
            "UPDATE adapters SET failureKey=?,attempts=0 WHERE fingerprint=? AND owner=?",
          )
          .run(failureKey, key, owner);
      }
      // A previously healthy adapter can be rolled back before asking a model.
      if (baseline.active && baseline.previous !== baseline.active) {
        try {
          const restored = await this.verify(
            open,
            this.read(baseline.previous),
            signal,
          );
          await restored.close();
          this.db
            .prepare(
              "UPDATE adapters SET active=previous,previous=NULL,revision=revision+1 WHERE fingerprint=? AND owner=?",
            )
            .run(key, owner);
          this.event(fingerprint, "rolled_back");
          return;
        } catch (failure) {
          if (connectorFailure(failure) !== "protocol") throw failure;
        }
      }
      if (!this.propose)
        throw Object.assign(Error("维护模型尚未配置。"), {
          code: "CONNECTOR_MAINTENANCE_UNAVAILABLE",
        });
      let diagnostic = protocolDiagnostic(error);
      while (this.row(fingerprint).attempts < maxAttempts) {
        signal.throwIfAborted();
        this.db
          .prepare(
            "UPDATE adapters SET attempts=attempts+1 WHERE fingerprint=? AND owner=?",
          )
          .run(key, owner);
        this.event(fingerprint, "repairing", diagnostic);
        try {
          const candidate = await this.propose(
            {
              version,
              kind,
              diagnostic,
              adapter: this.read(baseline.active),
              contract: adapterContract,
            },
            signal,
          );
          const staged = this.stage(candidate);
          this.event(fingerprint, "validating", diagnostic, staged.id);
          const tested = await this.verify(open, staged.value, signal);
          await tested.close();
          // Recheck every already-verified dependent connection with the same patch.
          const verified = new Set([kind]);
          for (const [validatorKey, validator] of this.validators) {
            if (!validatorKey.startsWith(key + ":")) continue;
            if (
              validator.kind === kind ||
              !JSON.parse(baseline.verified).includes(validator.kind)
            )
              continue;
            try {
              const other = await this.verify(
                validator.open,
                staged.value,
                signal,
              );
              await other.close();
              verified.add(validator.kind);
            } catch (failure) {
              if (
                ["authorization", "permission", "installation"].includes(
                  connectorFailure(failure),
                )
              )
                continue;
              throw failure;
            }
          }
          const published = this.db
            .prepare(
              `UPDATE adapters SET previous=active,active=?,revision=revision+1,
            verified=? WHERE fingerprint=? AND owner=? AND revision=? AND lease>?`,
            )
            .run(
              staged.id,
              JSON.stringify([...verified]),
              key,
              owner,
              baseline.revision,
              Date.now(),
            );
          if (!published.changes) throw Error("连接器维护版本已变化。");
          this.event(fingerprint, "ready", null, staged.id);
          return;
        } catch (failure) {
          error = failure;
          diagnostic = protocolDiagnostic(failure);
          if (
            ["authorization", "permission", "network", "cancelled"].includes(
              connectorFailure(failure),
            )
          )
            throw failure;
        }
      }
      throw Object.assign(Error(summary.blocked), {
        code: "CONNECTOR_REPAIR_BLOCKED",
      });
    } catch (failure) {
      this.event(fingerprint, "blocked", protocolDiagnostic(failure));
      throw failure;
    } finally {
      this.db
        .prepare(
          "UPDATE adapters SET owner=NULL,lease=0 WHERE fingerprint=? AND owner=?",
        )
        .run(key, owner);
    }
  }
  cancel() {
    this.closed = true;
    this.controller.abort();
  }
  async close() {
    this.cancel();
    await Promise.allSettled(
      [...jobs.entries()]
        .filter(([key]) => key.startsWith(this.root + path.sep))
        .map(([, job]) => job),
    );
    this.db.close();
  }
}
