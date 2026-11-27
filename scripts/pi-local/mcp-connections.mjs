import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  createMcpToolName,
  limitMcpContent,
  normalizeMcpInputSchema,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { authRequired, mcpUrl, openMcpRemote } from "./mcp-remote.mjs";
import { codexConnectionIssue, codexMcpId } from "./codex-mcp.mjs";
import { connectorFailure } from "./connector-policy.mjs";
import { waaoAccessIssue } from "../../shared/agent/waao-access.mjs";
import {
  waaoMcpId,
  waaoMcpUrl,
  waaoProjectsUrl,
} from "../../shared/agent/waao-endpoint.mjs";

const unauthorized =
  "此工具已停用或发生变更，请在当前项目的「工具」中重新选择。";
const loginNeeded = "服务需要授权，请打开「工具」重新连接。";
const serviceFailed = "MCP 服务暂时不可用，请检查服务地址或稍后重新测试。";
const waaoLoginNeeded = "请点击「连接 WAAO」，在官网授权后读取可用工具。";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const requestDigest = (tool, args) =>
  createHash("sha256")
    .update(JSON.stringify([tool, canonical(args)]))
    .digest("hex");

function toolCatalog(tools) {
  return tools
    .map((tool) => ({
      name: tool.name,
      label: tool.title || tool.name,
      description: tool.description || tool.name,
      parameters: normalizeMcpInputSchema(tool.inputSchema),
      readOnly: tool.annotations?.readOnlyHint === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resultLinks(result, content) {
  const urls = new Set();
  function add(value) {
    try {
      const url = new URL(value);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        urls.add(url.href);
    } catch {
      /* The resource may use a private URI scheme. */
    }
  }
  for (const block of result.content || []) {
    if (block.type === "resource_link") add(block.uri);
    if (block.type === "resource") add(block.resource?.uri);
  }
  for (const block of content) {
    if (block.type !== "text" || urls.size >= 3) continue;
    for (const match of block.text.matchAll(/https?:\/\/[^\s<>"'\\)\]]+/g)) {
      add(match[0].replace(/[.,;:，。；]+$/u, ""));
      if (urls.size >= 3) break;
    }
  }
  return [...urls].slice(0, 3);
}

export class McpConnections {
  constructor(
    directory,
    { origin, credentialFile, fetchImpl, codexService, waaoService },
  ) {
    this.origin = origin;
    this.credentialFile = credentialFile;
    this.fetchImpl = fetchImpl;
    this.builtins = new Map();
    this.checks = new Map();
    this.remotes = new Map();
    this.management = new Map();
    this.probeControllers = new Set();
    this.closing = false;
    this.db = new DatabaseSync(path.join(directory, "mcp-connections.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS servers(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, authMode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline', catalog TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS selections(
        binding TEXT NOT NULL, server TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        tools TEXT NOT NULL, PRIMARY KEY(binding,server));
      CREATE TABLE IF NOT EXISTS service_policies(
        binding TEXT NOT NULL, server TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(binding,server));
      CREATE TABLE IF NOT EXISTS calls(
        binding TEXT NOT NULL, chat TEXT NOT NULL, message TEXT NOT NULL, callId TEXT NOT NULL,
        service TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
        PRIMARY KEY(binding,chat,message,callId));
      CREATE TABLE IF NOT EXISTS connector_preferences(server TEXT PRIMARY KEY, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_metadata(server TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_answers(
        requestId TEXT PRIMARY KEY, binding TEXT NOT NULL, question TEXT NOT NULL,
        service TEXT NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL,
        state TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL);
    `);
    // Existing WAAO choices become one project-level service preference.
    // Explicitly disabled projects stay disabled; unrelated MCP choices remain.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO service_policies(binding,server,enabled,revision)
      SELECT binding,server,CASE WHEN json_array_length(tools)>0 THEN 1 ELSE 0 END,1
      FROM selections WHERE server=?`,
      )
      .run(waaoMcpId);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM pragma_table_info('calls') WHERE name='details'",
        )
        .get()
    )
      this.db.exec(
        "ALTER TABLE calls ADD COLUMN details TEXT NOT NULL DEFAULT '{}'",
      );
    for (const [name, definition] of [
      ["delivery", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["requestHash", "TEXT"],
      ["result", "TEXT"],
    ]) {
      if (
        !this.db
          .prepare("SELECT 1 FROM pragma_table_info('calls') WHERE name=?")
          .get(name)
      )
        this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${definition}`);
    }
    for (const [id, name, url, authMode, kind, service] of [
      [codexMcpId, "Codex", "stdio:codex", "local", "codex", codexService],
      [waaoMcpId, "WAAO", waaoMcpUrl, "auto", "waao", waaoService],
    ]) {
      if (!service) continue;
      this.builtins.set(id, { kind, service, diagnostic: "" });
      const preferred = this.db
        .prepare("SELECT source FROM connector_preferences WHERE server=?")
        .get(id);
      if (id === waaoMcpId) {
        // Retire the old delegated connection and its project grants together.
        // Calls have no server FK, so historical receipts remain available.
        if (preferred?.source === "codex") {
          this.db.exec("BEGIN IMMEDIATE");
          try {
            this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
            this.db
              .prepare("DELETE FROM connector_preferences WHERE server=?")
              .run(id);
            this.db.exec("COMMIT");
          } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
          }
        }
        const direct = service.statusOfConnection?.();
        if (
          preferred?.source !== "web" &&
          !(direct?.configured ?? direct?.connected)
        ) {
          this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
          continue;
        }
        this.db
          .prepare(
            "INSERT OR REPLACE INTO connector_preferences(server,source) VALUES(?,'web')",
          )
          .run(id);
      }
      this.db
        .prepare(
          "INSERT INTO servers(id,name,url,authMode,status) VALUES(?,?,?,?,'checking') ON CONFLICT(id) DO UPDATE SET status='checking'",
        )
        .run(id, name, url, authMode);
      this.checks.set(
        id,
        this.manage(id, () => this.probe(id)),
      );
    }
    for (const row of this.db
      .prepare(
        "SELECT id FROM servers s WHERE EXISTS (SELECT 1 FROM selections p WHERE p.server=s.id AND json_array_length(p.tools)>0)",
      )
      .all()) {
      if (this.builtins.has(row.id)) continue;
      this.db
        .prepare("UPDATE servers SET status='checking' WHERE id=?")
        .run(row.id);
      this.checks.set(
        row.id,
        this.manage(row.id, () => this.probe(row.id)),
      );
    }
    this.initialCheck = Promise.all(this.checks.values());
  }
  server(id) {
    const row = this.db.prepare("SELECT * FROM servers WHERE id=?").get(id);
    if (!row) throw Error("该 MCP 连接已移除。");
    return row;
  }
  registerWaao() {
    if (!this.builtins.has(waaoMcpId))
      throw Error("当前服务不支持 WAAO 连接。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO servers(id,name,url,authMode) VALUES(?,'WAAO',?,'auto')",
        )
        .run(waaoMcpId, waaoMcpUrl);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO connector_preferences(server,source) VALUES(?,'web')",
        )
        .run(waaoMcpId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  remote(row) {
    const builtin = this.builtins.get(row.id);
    if (builtin) return builtin.service;
    if (!this.remotes.has(row.id)) {
      const file = this.credentialFile(row.id, row.url);
      this.remotes.set(
        row.id,
        openMcpRemote(row, this.origin, file, this.fetchImpl),
      );
    }
    return this.remotes.get(row.id);
  }
  // Serialize a service's settings, OAuth handshake and removal. Calls recheck
  // their current grant independently at dispatch, even during an active turn.
  async manage(id, action) {
    const next = (this.management.get(id) || Promise.resolve())
      .catch(() => {})
      .then(action);
    this.management.set(id, next);
    try {
      return await next;
    } finally {
      if (this.management.get(id) === next) this.management.delete(id);
    }
  }
  list(binding) {
    return this.db
      .prepare(
        `SELECT s.*,p.tools AS selected FROM servers s
      LEFT JOIN selections p ON p.server=s.id AND p.binding=? ORDER BY s.rowid`,
      )
      .all(binding)
      .map(({ catalog, selected, ...server }) => ({
        ...server,
        integrationKind:
          this.builtins.get(server.id)?.kind === "codex"
            ? "agent"
            : this.db
                .prepare("SELECT kind FROM integration_metadata WHERE server=?")
                .get(server.id)?.kind || "tool",
        ...(this.builtins.has(server.id) && {
          kind: this.builtins.get(server.id).kind,
          diagnostic: this.builtins.get(server.id).diagnostic,
          maintenance: this.builtins
            .get(server.id)
            .service.maintenanceStatus?.(),
          ...(server.id === waaoMcpId && {
            selectionMode: "service",
            serviceRevision: this.servicePolicy(binding, server.id).revision,
            authorization: this.builtins.get(server.id).authorization || null,
            accessIssue: this.latestAccessIssue(binding, server.id),
            connectionSource: this.builtins
              .get(server.id)
              .service.connectionSource?.(),
          }),
        }),
        selected: this.selectedTools(binding, { ...server, catalog, selected }),
        enabled:
          server.id === waaoMcpId
            ? this.servicePolicy(binding, server.id).enabled
            : JSON.parse(selected || "[]").length > 0,
        verification: this.verification(binding, server),
        tools: JSON.parse(catalog).map(({ name, label, description }) => ({
          name,
          label,
          description,
        })),
      }));
  }
  servicePolicy(binding, id) {
    const row = this.db
      .prepare(
        "SELECT enabled,revision FROM service_policies WHERE binding=? AND server=?",
      )
      .get(binding, id);
    return { enabled: row?.enabled === 1, revision: row?.revision || 0 };
  }
  latestAccessIssue(binding, id) {
    const row = this.db
      .prepare(
        "SELECT tool,status,details FROM calls WHERE binding=? AND json_extract(details,'$.serverId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(binding, id);
    if (!row || row.status !== "error") return null;
    const details = JSON.parse(row.details);
    const identity = this.builtins.get(id)?.authorization?.fingerprint;
    if (!identity || details.validationKey !== identity) return null;
    return details.accessIssue
      ? { ...details.accessIssue, tool: row.tool }
      : null;
  }
  selectedTools(binding, row) {
    if (row.id === waaoMcpId)
      return this.servicePolicy(binding, row.id).enabled
        ? JSON.parse(row.catalog).map((t) => t.name)
        : [];
    return JSON.parse(row.selected || "[]");
  }
  setServiceEnabled(binding, id, enabled) {
    const row = this.server(id);
    if (
      id !== waaoMcpId ||
      typeof enabled !== "boolean" ||
      typeof binding !== "string" ||
      !binding
    )
      throw Error("请选择当前项目的 WAAO 服务开关。");
    if (enabled && row.status !== "ready")
      throw Error("请先完成 WAAO 官网授权并验证连接，再开启当前项目服务。");
    const before = this.servicePolicy(binding, id);
    if (before.revision && before.enabled === enabled) return;
    this.db
      .prepare(
        `INSERT INTO service_policies(binding,server,enabled,revision) VALUES(?,?,?,1)
      ON CONFLICT(binding,server) DO UPDATE SET enabled=excluded.enabled,revision=service_policies.revision+1`,
      )
      .run(binding, id, enabled ? 1 : 0);
  }
  verification(binding, server) {
    const builtin = this.builtins.get(server.id);
    const key =
      builtin?.verificationKey ||
      builtin?.service.connectionSource?.() ||
      server.url;
    const query = `SELECT tool FROM calls WHERE binding=? AND json_extract(details,'$.serverId')=?
      AND json_extract(details,'$.validationKey')=? AND status='done'`;
    const tools = new Set(
      this.db
        .prepare(query)
        .all(binding, server.id, key)
        .map((row) => row.tool),
    );
    return {
      connection: server.status === "ready",
      catalog: server.status === "ready",
      read: [
        "project_list",
        "project_get",
        "project_resolve",
        "canvas_list",
        "canvas_get",
        "task_get",
      ].some((name) => tools.has(name)),
      execution: ["codex", "codex-reply", "node_generate"].some((name) =>
        tools.has(name),
      ),
    };
  }
  questions(binding) {
    const pending = new Map(
      this.db
        .prepare(
          "SELECT * FROM connector_answers WHERE binding=? AND state='pending' ORDER BY createdAt",
        )
        .all(binding)
        .map((answer) => [answer.service, answer]),
    );
    return this.list(binding)
      .filter(
        (server) =>
          server.selected.length &&
          (server.status === "authorization" ||
            server.status === "offline" ||
            pending.has(server.id)),
      )
      .map((server) => {
        const id =
          pending.get(server.id)?.question ||
          requestDigest(server.id, {
            binding,
            status: server.status,
            fingerprint: server.maintenance?.fingerprint,
            revision: server.maintenance?.revision,
            attempts: server.maintenance?.attempts,
            diagnostic: server.diagnostic,
          });
        const answer = this.db
          .prepare(
            "SELECT decision,note,state FROM connector_answers WHERE binding=? AND question=? ORDER BY createdAt DESC,rowid DESC LIMIT 1",
          )
          .get(binding, id);
        return {
          id,
          serviceId: server.id,
          service: server.name,
          kind: "connector",
          status: server.status,
          title: `${server.name} 需要你处理`,
          description:
            server.status === "authorization"
              ? "连接需要重新授权，接下来怎么处理？"
              : server.maintenance?.status === "blocked"
                ? "自动适配未通过，接下来怎么处理？"
                : "连接尚未恢复，接下来怎么处理？",
          diagnostic: server.diagnostic,
          attempts: server.maintenance?.attempts || 0,
          processing: pending.has(server.id),
          answerRequestId: pending.get(server.id)?.requestId,
          canRepair: server.maintenance?.status === "blocked",
          deferred: answer?.state === "deferred",
          note: answer?.note || "",
        };
      });
  }
  async answerQuestion(binding, input) {
    if (
      !/^[\w-]{8,100}$/.test(input.requestId || "") ||
      !/^[a-f0-9]{64}$/.test(input.id || "") ||
      !["retry", "defer", "disable"].includes(input.decision) ||
      typeof input.note !== "string" ||
      input.note.length > 2000
    )
      throw Error("提问回答格式无效。");
    const prior = this.db
      .prepare("SELECT * FROM connector_answers WHERE requestId=?")
      .get(input.requestId);
    if (prior) {
      if (
        prior.binding !== binding ||
        prior.question !== input.id ||
        prior.decision !== input.decision ||
        prior.note !== input.note
      )
        throw Error("这次回答的内容已变化，请重新确认。");
      return {
        status: prior.state,
        error: prior.error,
        questions: this.questions(binding),
      };
    }
    const question = this.questions(binding).find(
      (item) => item.id === input.id,
    );
    if (!question) throw Error("连接状态已变化，请刷新后查看当前请求。");
    this.db
      .prepare("INSERT INTO connector_answers VALUES(?,?,?,?,?,?,?,NULL,?)")
      .run(
        input.requestId,
        binding,
        question.id,
        question.serviceId,
        input.decision,
        input.note,
        "pending",
        Date.now(),
      );
    let status = "done",
      error = null;
    try {
      if (input.decision === "defer") status = "deferred";
      else if (input.decision === "disable")
        this.setSelection(binding, question.serviceId, []);
      else {
        const result = await this.action(binding, {
          id: question.serviceId,
          action: question.canRepair ? "retry-maintenance" : "test",
        });
        if (result.status !== "ready") {
          status = "failed";
          error = result.error || "连接仍未恢复，请查看诊断。";
        }
      }
    } catch (failure) {
      status = "failed";
      error = /[\u3400-\u9fff]/.test(failure.message)
        ? failure.message
        : "暂时未完成处理，请核对连接状态。";
    }
    this.db
      .prepare("UPDATE connector_answers SET state=?,error=? WHERE requestId=?")
      .run(status, error, input.requestId);
    return { status, error, questions: this.questions(binding) };
  }
  questionReceipt(binding, requestId) {
    const row = this.db
      .prepare(
        "SELECT * FROM connector_answers WHERE binding=? AND requestId=?",
      )
      .get(binding, requestId);
    if (!row) return { found: false };
    if (row.state === "pending" && !this.management.has(row.service)) {
      const ready = this.server(row.service).status === "ready";
      const disabled =
        this.db
          .prepare("SELECT tools FROM selections WHERE binding=? AND server=?")
          .get(binding, row.service)?.tools === "[]";
      const status =
        row.decision === "defer"
          ? "deferred"
          : (row.decision === "disable" ? disabled : ready)
            ? "done"
            : "failed";
      this.db
        .prepare(
          "UPDATE connector_answers SET state=?,error=? WHERE requestId=?",
        )
        .run(
          status,
          status === "failed" ? "上次处理未完成，请重新确认。" : null,
          row.requestId,
        );
      row.state = status;
      row.error = status === "failed" ? "上次处理未完成，请重新确认。" : null;
    }
    return {
      found: true,
      status: row.state,
      error: row.error,
      questions: this.questions(binding),
    };
  }
  async probe(id) {
    if (this.closing) return { status: "offline", error: "连接正在关闭。" };
    const row = this.server(id);
    const builtin = this.builtins.get(id);
    if (builtin) builtin.authorization = null;
    const control = new AbortController();
    this.probeControllers.add(control);
    let client;
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(190000),
        control.signal,
      ]);
      client = await this.remote(row).connect(signal);
      const catalog = toolCatalog(await client.listTools({ signal }));
      if (builtin) {
        builtin.authorization =
          (await builtin.service.verifyAuthorization?.(
            client,
            catalog,
            signal,
          )) || null;
        builtin.diagnostic = "";
        builtin.verificationKey =
          builtin.authorization?.fingerprint ||
          client.validationKey ||
          builtin.service.connectionSource?.() ||
          row.url;
      }
      this.db
        .prepare("UPDATE servers SET status='ready', catalog=? WHERE id=?")
        .run(JSON.stringify(catalog), id);
      // Withdrawn tools lose their grants even if the remote later reuses their name.
      this.db
        .prepare(
          `UPDATE selections SET tools=(SELECT json_group_array(value)
        FROM json_each(selections.tools) WHERE value IN (SELECT json_extract(value,'$.name') FROM json_each(?)))
        WHERE server=?`,
        )
        .run(JSON.stringify(catalog), id);
      return { status: "ready" };
    } catch (error) {
      const login =
        id === codexMcpId
          ? error.code === "CODEX_LOGIN_REQUIRED"
          : authRequired(error);
      const status = login ? "authorization" : "offline";
      const reason =
        id === codexMcpId
          ? error.message
          : id === waaoMcpId
            ? ["WAAO_AUTH_UNVERIFIED", "WAAO_CLIENT_MISMATCH"].includes(
                error.code,
              )
              ? error.message
              : login
                ? waaoLoginNeeded
                : "暂时无法读取 WAAO 官网工具，请稍后测试连接。"
            : login
              ? loginNeeded
              : serviceFailed;
      if (builtin) builtin.diagnostic = reason;
      this.db.prepare("UPDATE servers SET status=? WHERE id=?").run(status, id);
      return { status, error: reason, failureKind: connectorFailure(error) };
    } finally {
      this.probeControllers.delete(control);
      await client?.close().catch(() => {});
    }
  }
  async add({ name, url, authMode = "auto", token, integrationKind = "tool" }) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
      throw Error("请填写 1 至 80 字的连接名称。");
    if (!["auto", "token"].includes(authMode)) throw Error("认证方式无效。");
    if (!["tool", "agent"].includes(integrationKind))
      throw Error("服务分类无效。");
    let endpoint = mcpUrl(url);
    if (
      this.builtins.has(waaoMcpId) &&
      [waaoProjectsUrl, waaoMcpUrl].includes(endpoint.replace(/\/$/, ""))
    ) {
      if (authMode === "auto")
        return this.manage(waaoMcpId, async () => {
          this.registerWaao();
          return { id: waaoMcpId, ...(await this.probe(waaoMcpId)) };
        });
      endpoint = waaoMcpUrl;
    }
    const id = randomUUID();
    const row = { id, name: name.trim(), url: endpoint, authMode };
    if (authMode === "token") await this.remote(row).setToken(token);
    this.db
      .prepare("INSERT INTO servers(id,name,url,authMode) VALUES(?,?,?,?)")
      .run(id, row.name, row.url, authMode);
    this.db
      .prepare("INSERT INTO integration_metadata VALUES(?,?)")
      .run(id, integrationKind);
    return this.manage(id, async () => ({ id, ...(await this.probe(id)) }));
  }
  setSelection(binding, id, names) {
    const row = this.server(id);
    const known = new Set(JSON.parse(row.catalog).map((tool) => tool.name));
    if (!Array.isArray(names) || names.some((name) => !known.has(name)))
      throw Error(unauthorized);
    // Compatibility for older clients: WAAO now has one service preference.
    if (id === waaoMcpId)
      return this.setServiceEnabled(binding, id, names.length > 0);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO selections(binding,server,tools) VALUES(?,?,?)",
      )
      .run(binding, id, JSON.stringify([...new Set(names)]));
  }
  async action(binding, input) {
    if (input.action === "add") return this.add(input);
    const { id } = input;
    if (typeof id !== "string") throw Error("请选择连接。");
    if (input.action === "service") {
      this.setServiceEnabled(binding, id, input.enabled);
      return { servers: this.list(binding) };
    }
    if (input.action === "category") {
      this.server(id);
      if (this.builtins.has(id) || !["agent", "tool"].includes(input.kind))
        throw Error("不能更改这个服务的分类。");
      this.db
        .prepare(
          "INSERT INTO integration_metadata VALUES(?,?) ON CONFLICT(server) DO UPDATE SET kind=excluded.kind",
        )
        .run(id, input.kind);
      return { servers: this.list(binding) };
    }
    if (input.action === "retry-maintenance") {
      const service = this.builtins.get(id)?.service;
      if (!service?.retryMaintenance) throw Error("此服务没有自动维护记录。");
      return this.manage(id, async () => {
        service.retryMaintenance();
        return this.probe(id);
      });
    }
    if (input.action === "select" || input.action === "enable") {
      let names = input.tools;
      if (input.action === "enable" && id !== waaoMcpId) {
        if (!Array.isArray(names)) throw Error(unauthorized);
        const prior = this.db
          .prepare("SELECT tools FROM selections WHERE binding=? AND server=?")
          .get(binding, id);
        names = [...JSON.parse(prior?.tools || "[]"), ...names];
      }
      this.setSelection(binding, id, names);
      return {};
    }
    if (id === codexMcpId && input.action !== "test")
      throw Error("Codex 使用本机登录，可通过项目工具勾选项启用或停用。");
    if (id === waaoMcpId && !["test", "login"].includes(input.action))
      throw Error("WAAO 仅使用轻单自己的授权，可以在当前项目中停用。");
    return this.manage(id, async () => {
      if (id === waaoMcpId && input.action === "login") this.registerWaao();
      const row = this.server(id);
      const remote = this.remote(row);
      switch (input.action) {
        case "test":
          return this.probe(id);
        case "token":
          await remote.setToken(input.token);
          return this.probe(id);
        case "login": {
          let result;
          try {
            result = await remote.login(input.returnTo);
          } catch {
            throw Error(
              "此服务暂未能发起 OAuth 登录，请检查它支持的认证方式。",
            );
          }
          return result.url ? result : this.probe(id);
        }
        case "remove":
          this.db
            .prepare("UPDATE servers SET status='removing' WHERE id=?")
            .run(id);
          await remote.clear();
          this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
          this.remotes.delete(id);
          return {};
        default:
          throw Error("未知的 MCP 操作。");
      }
    });
  }
  finish(id, params) {
    return this.manage(id, async () => {
      const completed = await this.remote(this.server(id)).finish(params);
      return {
        ...(await this.probe(id)),
        ...(completed?.returnTo && { returnTo: completed.returnTo }),
      };
    });
  }
  async readyForTurn(bindingId) {
    const selected = this.list(bindingId)
      .filter((server) => server.enabled)
      .map((server) => ({ server: server.id }));
    await Promise.all(
      selected.map(async (row) => {
        await this.checks.get(row.server);
        if (["offline", "checking"].includes(this.server(row.server)?.status))
          await this.manage(row.server, () => this.probe(row.server));
      }),
    );
  }
  turn(scope) {
    const entries = new Map();
    const sql = `SELECT s.*,p.tools AS selected FROM servers s LEFT JOIN selections p ON s.id=p.server AND p.binding=?
      WHERE s.status='ready'`;
    const used = new Set();
    for (const row of this.db.prepare(sql).all(scope.bindingId)) {
      const selected = new Set(this.selectedTools(scope.bindingId, row));
      for (const tool of JSON.parse(row.catalog)) {
        const name = createMcpToolName(
          this.builtins.get(row.id)?.kind ||
            "s" + row.id.replaceAll("-", "").slice(0, 12),
          tool.name,
          (n) => used.has(n),
        );
        used.add(name);
        if (selected.has(tool.name))
          entries.set(name, {
            id: row.id,
            service: row.name,
            tool,
            source: this.builtins.get(row.id)?.service.connectionSource?.(),
            identityKey: this.builtins.get(row.id)?.authorization?.fingerprint,
            serviceRevision:
              row.id === waaoMcpId
                ? this.servicePolicy(scope.bindingId, row.id).revision
                : null,
          });
      }
    }
    const clients = new Map();
    const inFlight = new Set();
    const guard = (entry) => {
      const current = this.db
        .prepare(sql + " AND s.id=?")
        .get(scope.bindingId, entry.id);
      if (entry.id === waaoMcpId) {
        const policy = this.servicePolicy(scope.bindingId, entry.id);
        if (!policy.enabled || policy.revision !== entry.serviceRevision)
          throw Object.assign(
            Error(
              "当前项目已停用 WAAO 或服务设置发生变更，请重新读取当前项目的服务状态。",
            ),
            { code: "WAAO_SERVICE_DISABLED" },
          );
      }
      const version =
        current &&
        JSON.parse(current.catalog).find(
          (tool) => tool.name === entry.tool.name,
        );
      if (
        !version ||
        entry.source !==
          this.builtins.get(entry.id)?.service.connectionSource?.() ||
        entry.identityKey !==
          this.builtins.get(entry.id)?.authorization?.fingerprint ||
        !this.selectedTools(scope.bindingId, current).includes(
          entry.tool.name,
        ) ||
        JSON.stringify(version) !== JSON.stringify(entry.tool)
      )
        throw Error(unauthorized);
    };
    const byService = new Map();
    for (const entry of entries.values()) {
      if (!byService.has(entry.id)) byService.set(entry.id, new Map());
      byService.get(entry.id).set(entry.tool.name, entry);
    }
    const previous = new Map();
    if (scope.retry) {
      const calls = this.db
        .prepare(
          "SELECT callId,tool,status,summary,details,delivery,requestHash,result FROM calls WHERE binding=? AND chat=? AND message=? ORDER BY rowid",
        )
        .all(scope.bindingId, scope.chatId, scope.userMessageId);
      for (const call of calls) {
        const {
          serverId,
          links = [],
          connectionSource,
        } = JSON.parse(call.details);
        const entry = byService.get(serverId)?.get(call.tool);
        if (!entry) continue;
        const receipts = previous.get(entry) ?? [];
        receipts.push({
          service: entry.service,
          tool: call.tool,
          status: call.status,
          summary: call.summary,
          links,
          callId: call.callId,
          delivery: call.delivery,
          requestHash: call.requestHash,
          result: call.result,
          connectionSource,
        });
        previous.set(entry, receipts);
      }
    }
    function checkDispatch(id, message) {
      if (message.method !== "tools/call") return;
      const entry = byService.get(id)?.get(message.params?.name);
      if (!entry) throw Error(unauthorized);
      guard(entry);
    }
    const waaoAccess = this.builtins.has(waaoMcpId)
      ? {
          enabled: byService.has(waaoMcpId),
          allows: (name) => !!byService.get(waaoMcpId)?.has(name),
          beforeDispatch: (message) => checkDispatch(waaoMcpId, message),
        }
      : undefined;
    return {
      waaoAccess,
      authorize(name) {
        const entry = entries.get(name);
        if (!entry) throw Error(unauthorized);
        guard(entry);
      },
      readOnly: (name) => entries.get(name)?.tool.readOnly === true,
      delivery: (callId) =>
        this.db
          .prepare(
            "SELECT delivery FROM calls WHERE binding=? AND chat=? AND message=? AND callId=?",
          )
          .get(scope.bindingId, scope.chatId, scope.userMessageId, callId)
          ?.delivery,
      retryReceipts: [...previous.values()]
        .flat()
        .map(({ result, requestHash, callId, ...receipt }) => receipt),
      specs: [...entries].map(([name, { service, tool }]) => ({
        name,
        label: service + " · " + tool.label,
        description: service + " · " + tool.description,
        parameters: tool.parameters,
      })),
      execute: async (name, args, callId, signal, onProgress) => {
        const entry = entries.get(name);
        if (!entry) throw Error(unauthorized);
        const requestHash = requestDigest(entry.tool.name, args);
        let retryCall;
        if (previous.has(entry)) {
          guard(entry);
          const receipts = previous.get(entry);
          if (
            entry.id === waaoMcpId &&
            receipts.some((item) => item.connectionSource === "codex")
          )
            throw Error(
              "原调用使用已移除的转接连接，请在 WAAO 官网核对原任务。",
            );
          const matching = receipts.filter(
            (item) => item.requestHash === requestHash,
          );
          const completed = matching.find(
            (item) => item.result && item.delivery === "received",
          );
          if (completed) return JSON.parse(completed.result);
          retryCall = matching.find(
            (item) => item.delivery === "not_sent" && item.status === "error",
          );
          if (!retryCall) {
            const shown = receipts.map(
              ({ result, requestHash, callId, ...item }) => item,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(shown) }],
              isError:
                !matching.length ||
                receipts.some((item) => item.status !== "done"),
            };
          }
        }
        if (inFlight.has(entry.id))
          throw Error("此服务正在处理上一条调用，请等待回执。");
        const { bindingId, chatId, userMessageId } = scope;
        const key = [
          bindingId,
          chatId,
          userMessageId,
          retryCall?.callId || callId,
        ];
        // Reserve before external I/O. A restart or lost response must not
        // silently issue the same external operation twice.
        const reserved = retryCall
          ? this.db
              .prepare(
                "UPDATE calls SET status='pending',summary='连接恢复后继续原请求' WHERE binding=? AND chat=? AND message=? AND callId=? AND delivery='not_sent' AND status='error' AND requestHash=?",
              )
              .run(...key, requestHash)
          : this.db
              .prepare(
                `INSERT OR IGNORE INTO calls(binding,chat,message,callId,
          service,tool,status,summary,details,delivery,requestHash) VALUES(?,?,?,?,?,?,'pending','等待服务回执',?,'not_sent',?)`,
              )
              .run(
                ...key,
                entry.service,
                entry.tool.name,
                JSON.stringify({
                  serverId: entry.id,
                  connectionSource: entry.source,
                }),
                requestHash,
              );
        if (!reserved.changes)
          throw Error("本轮已有这次工具调用，请查看调用记录。");
        inFlight.add(entry.id);
        const save = (status, summary, links = [], accessIssue = null) =>
          this.db
            .prepare(
              `UPDATE calls SET status=?,summary=?,details=?
          WHERE binding=? AND chat=? AND message=? AND callId=?`,
            )
            .run(
              status,
              summary,
              JSON.stringify({
                serverId: entry.id,
                links,
                ...(accessIssue && { accessIssue }),
                validationKey:
                  this.builtins.get(entry.id)?.authorization?.fingerprint ||
                  clients.get(entry.id)?.validationKey ||
                  entry.source ||
                  this.server(entry.id).url,
                ...(entry.id === waaoMcpId && {
                  connectionSource:
                    clients.get(entry.id)?.source ||
                    this.builtins.get(entry.id)?.service.connectionSource?.(),
                }),
              }),
              ...key,
            );
        try {
          guard(entry);
          if (!clients.has(entry.id)) {
            const client = await this.remote(this.server(entry.id)).connect(
              signal,
              (message) => checkDispatch(entry.id, message),
              scope,
            );
            clients.set(entry.id, client);
          }
          signal.throwIfAborted();
          guard(entry);
          // Persist before entering the transport. A lost response is unknown,
          // never evidence that a generation can be repeated.
          this.db
            .prepare(
              "UPDATE calls SET delivery='sent' WHERE binding=? AND chat=? AND message=? AND callId=?",
            )
            .run(...key);
          const result = await clients
            .get(entry.id)
            .callTool(entry.tool.name, args, {
              signal,
              onProgress,
              onprogress: onProgress,
            });
          const { content } = await limitMcpContent(toLlmContent(result));
          const accessIssue =
            entry.id === waaoMcpId && result.isError
              ? waaoAccessIssue(result)
              : null;
          const summary =
            accessIssue?.message ||
            content
              .find((block) => block.type === "text")
              ?.text?.slice(0, 500) ||
            (result.isError ? "服务返回执行错误。" : "已收到服务结果。");
          save(
            result.isError ? "error" : "done",
            summary,
            resultLinks(result, content),
            accessIssue,
          );
          const output = {
            content,
            isError: !!result.isError,
            ...(accessIssue && { accessIssue }),
          };
          this.db
            .prepare(
              "UPDATE calls SET delivery='received',result=? WHERE binding=? AND chat=? AND message=? AND callId=?",
            )
            .run(JSON.stringify(output), ...key);
          previous.delete(entry);
          return output;
        } catch (error) {
          const nativeIssue =
            entry.id === codexMcpId && codexConnectionIssue(error);
          if (nativeIssue) {
            this.builtins.get(codexMcpId).diagnostic = nativeIssue;
            this.db
              .prepare("UPDATE servers SET status=? WHERE id=?")
              .run(
                error.code === "CODEX_LOGIN_REQUIRED"
                  ? "authorization"
                  : "offline",
                entry.id,
              );
            save("error", nativeIssue);
            throw Error(nativeIssue);
          }
          const auth = authRequired(error);
          if (auth)
            this.db
              .prepare("UPDATE servers SET status='authorization' WHERE id=?")
              .run(entry.id);
          const reason = auth
            ? entry.id === waaoMcpId
              ? waaoLoginNeeded
              : loginNeeded
            : error.message === unauthorized ||
                error.code === "WAAO_SERVICE_DISABLED"
              ? error.message
              : signal.aborted
                ? "本轮工具调用已停止。"
                : "未取得 MCP 工具回执，请检查服务状态。";
          if (auth && this.builtins.has(entry.id)) {
            this.builtins.get(entry.id).diagnostic = reason;
            this.builtins.get(entry.id).authorization = null;
          }
          save("error", reason);
          throw Error(reason);
        } finally {
          this.db
            .prepare(
              "UPDATE calls SET delivery='unknown' WHERE binding=? AND chat=? AND message=? AND callId=? AND delivery='sent'",
            )
            .run(...key);
          inFlight.delete(entry.id);
        }
      },
      close: () =>
        Promise.allSettled(
          [...clients.values()].map((client) => client.close()),
        ),
    };
  }
  decorate(message) {
    if (
      message.role !== "assistant" ||
      !message.replyTo ||
      message.invalidated ||
      message.provenance?.kind === "cancelled_reply"
    )
      return message;
    const calls = this.db
      .prepare(
        `SELECT service,tool,status,summary,details FROM calls
      WHERE binding=? AND chat=? AND message=? ORDER BY rowid`,
      )
      .all(message.bindingId, message.chatId, message.replyTo)
      .map(({ details, ...call }) => ({ ...call, ...JSON.parse(details) }));
    return calls.length ? { ...message, mcpCalls: calls } : message;
  }
  async close() {
    this.closing = true;
    for (const control of this.probeControllers) control.abort();
    await Promise.allSettled(this.management.values());
    this.db.close();
  }
}
