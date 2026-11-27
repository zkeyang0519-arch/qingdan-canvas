import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseConnection(input, keyRequired) {
  const service = input.service?.trim(),
    model = input.model?.trim(),
    key = input.apiKey?.trim();
  if (
    !service ||
    service.length > 60 ||
    !/^[a-z0-9][a-z0-9._:/@+-]{0,159}$/i.test(model ?? "") ||
    (keyRequired && !key) ||
    (key && !/^[!-~]{1,4096}$/.test(key))
  )
    throw Error("请填写服务商、模型 ID 和有效密钥。");
  let url;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw Error("请输入完整的 API 接口地址。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (local && url.protocol === "http:"))
  )
    throw Error(
      "接口地址需使用 HTTPS 或本机 HTTP，且不能包含账号、查询参数或片段。",
    );
  const apiFormat = input.apiFormat || "responses";
  if (!["responses", "chat_completions"].includes(apiFormat))
    throw Error("不支持当前接口类型。");
  return {
    service,
    model,
    key,
    apiFormat,
    baseUrl: url.href
      .replace(/\/+$/, "")
      .replace(/\/(responses|chat\/completions)$/, ""),
  };
}

// Connections have immutable destinations. A queued job can safely pin an ID,
// including when another chat selects a different model or changes the default.
export class ModelCatalog {
  constructor(directory, legacy, credentialFile) {
    this.legacy = legacy;
    this.credentialFile = credentialFile;
    this.db = new DatabaseSync(path.join(directory, "chat-models.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, service TEXT NOT NULL, model TEXT NOT NULL, baseUrl TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences(name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics(job TEXT PRIMARY KEY, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_versions(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,status TEXT NOT NULL,replacement TEXT,apiFormat TEXT NOT NULL DEFAULT 'responses');
    `);
  }
  get defaultId() {
    return (
      this.db
        .prepare("SELECT value FROM preferences WHERE name='default'")
        .get()?.value ?? "xingchi"
    );
  }
  connection(id) {
    if (id === "xingchi") return { ...this.legacy, id, service: "星驰" };
    const row = this.db
      .prepare(
        "SELECT m.*,COALESCE(v.apiFormat,'responses') AS apiFormat FROM models m LEFT JOIN model_versions v ON v.id=m.id WHERE m.id=? AND COALESCE(v.status,'active')!='deleted'",
      )
      .get(id);
    if (!row) throw Error("找不到所选模型连接，请重新选择。");
    return {
      ...row,
      apiKey: async () =>
        (await this.credentialFile(row.id, row.baseUrl).load())?.apiKey,
      setupHint: "请在「管理模型」中配置此连接的密钥。",
    };
  }
  currentId(id) {
    if (typeof id !== "string") return id;
    const version = this.db
      .prepare("SELECT * FROM model_versions WHERE id=?")
      .get(id);
    return version?.status === "retired"
      ? this.db
          .prepare(
            "SELECT id FROM model_versions WHERE root_id=? AND status='active'",
          )
          .get(version.root_id)?.id || id
      : id;
  }
  describe(id) {
    if (typeof id !== "string") return undefined;
    return this.db.prepare("SELECT * FROM models WHERE id=?").get(id);
  }
  lineage(id) {
    const root =
      this.db.prepare("SELECT root_id FROM model_versions WHERE id=?").get(id)
        ?.root_id || id;
    return this.db
      .prepare(
        "SELECT m.id,m.baseUrl FROM models m LEFT JOIN model_versions v ON v.id=m.id WHERE COALESCE(v.root_id,m.id)=?",
      )
      .all(root);
  }
  active(id) {
    const row = this.db
      .prepare(
        "SELECT m.*,COALESCE(v.root_id,m.id) AS rootId FROM models m LEFT JOIN model_versions v ON v.id=m.id WHERE m.id=? AND COALESCE(v.status,'active')='active'",
      )
      .get(id);
    if (!row) throw Error("连接已更新或删除，请刷新模型设置后重试。");
    return row;
  }
  async list() {
    const builtin = await this.legacy.status();
    return {
      defaultId: this.defaultId,
      modelsEndpoint: "/local/models",
      apiFormats: ["responses", "chat_completions"],
      profiles: [
        {
          id: "xingchi",
          service: "星驰",
          model: this.legacy.model,
          configured: builtin.configured,
          baseUrl: this.legacy.baseUrl,
          apiFormat: this.legacy.apiFormat || "responses",
          editable: false,
          removable: false,
        },
        ...this.db
          .prepare(
            "SELECT m.*,COALESCE(v.apiFormat,'responses') AS apiFormat FROM models m LEFT JOIN model_versions v ON v.id=m.id WHERE COALESCE(v.status,'active')='active' ORDER BY m.rowid",
          )
          .all()
          .map((row) => ({
            ...row,
            configured: true,
            editable: true,
            removable: true,
          })),
      ],
    };
  }
  async status(profileId) {
    const list = await this.list();
    const profile = list.profiles.find(
      (p) => p.id === this.currentId(profileId ?? list.defaultId),
    );
    return {
      ...list,
      ...profile,
      configured: !!profile?.configured,
      host: profile ? new URL(profile.baseUrl).host : null,
      format: profile?.apiFormat || "responses",
      runtime: "Pi RPC 1.5.2",
      ...(profile?.configured
        ? {}
        : { setupHint: "请在模型设置中选择可用连接。" }),
    };
  }
  async add(input) {
    const { service, model, key, baseUrl, apiFormat } = parseConnection(
      input,
      true,
    );
    const id = randomUUID();
    const file = this.credentialFile(id, baseUrl);
    await file.save({ apiKey: key });
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare("INSERT INTO models VALUES(?,?,?,?)")
        .run(id, service, model, baseUrl);
      this.db
        .prepare("INSERT INTO model_versions VALUES(?,?,?,NULL,?)")
        .run(id, id, "active", apiFormat);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      await file.clear();
      throw error;
    }
    return id;
  }
  async update(input) {
    const { service, model, key, baseUrl, apiFormat } = parseConnection(
      input,
      false,
    );
    const version = this.db
      .prepare("SELECT * FROM model_versions WHERE id=?")
      .get(input.id);
    if (version?.status === "retired" && version.replacement) {
      const previous = this.describe(input.id),
        current = this.db
          .prepare(
            "SELECT m.*,v.apiFormat FROM models m JOIN model_versions v ON v.id=m.id WHERE m.id=? AND v.status='active'",
          )
          .get(version.replacement);
      if (
        previous &&
        current &&
        current.service === service &&
        current.model === model &&
        current.baseUrl === baseUrl &&
        current.apiFormat === apiFormat
      ) {
        const wanted =
          key ||
          (await this.credentialFile(previous.id, previous.baseUrl).load())
            ?.apiKey;
        const actual = (
          await this.credentialFile(current.id, current.baseUrl).load()
        )?.apiKey;
        if (wanted && wanted === actual)
          return { updated: current.id, replaced: input.id };
      }
    }
    const old = this.active(input.id);
    if (
      !key &&
      new URL(baseUrl).origin !== new URL(old.baseUrl).origin &&
      input.reuseApiKey !== true
    )
      throw Error(
        "接口地址已更换，请填写新密钥或明确选择将现有密钥用于新地址。",
      );
    const apiKey =
      key || (await this.credentialFile(old.id, old.baseUrl).load())?.apiKey;
    if (!apiKey) throw Error("原密钥不可用，请重新填写 API 密钥。");
    const updated = randomUUID(),
      file = this.credentialFile(updated, baseUrl);
    await file.save({ apiKey });
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.active(input.id);
      this.db
        .prepare("INSERT INTO models VALUES(?,?,?,?)")
        .run(updated, service, model, baseUrl);
      this.db
        .prepare("INSERT INTO model_versions VALUES(?,?,?,NULL,?)")
        .run(updated, old.rootId, "active", apiFormat);
      const previousFormat = this.connection(old.id).apiFormat;
      this.db
        .prepare("INSERT OR REPLACE INTO model_versions VALUES(?,?,?,?,?)")
        .run(old.id, old.rootId, "retired", updated, previousFormat);
      if (this.defaultId === old.id)
        this.db
          .prepare("INSERT OR REPLACE INTO preferences VALUES('default',?)")
          .run(updated);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      await file.clear();
      throw error;
    }
    return { updated, replaced: old.id };
  }
  async remove(id) {
    if (id === "xingchi") throw Error("环境连接由本机配置管理。");
    const row = this.describe(id),
      version = this.db
        .prepare("SELECT * FROM model_versions WHERE id=?")
        .get(id);
    if (!row || version?.status === "retired")
      throw Error("连接已更新或删除，请刷新模型设置后重试。");
    const root = version?.root_id || id,
      family = this.lineage(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO model_versions VALUES(?,?,?,NULL,?)")
        .run(id, root, "deleted", version?.apiFormat || "responses");
      this.db
        .prepare("UPDATE model_versions SET status='deleted' WHERE root_id=?")
        .run(root);
      if (this.defaultId === id)
        this.db
          .prepare(
            "INSERT OR REPLACE INTO preferences VALUES('default','unselected')",
          )
          .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      for (const item of family)
        await this.credentialFile(item.id, item.baseUrl).clear();
    } catch {
      throw Error("连接已停用，密钥尚未完全清理，请重试删除。");
    }
    return { deleted: id };
  }
  setDefault(id) {
    if (id !== "xingchi") this.active(id);
    this.connection(id);
    this.db
      .prepare("INSERT OR REPLACE INTO preferences VALUES('default',?)")
      .run(id);
  }
  saveDiagnostic(job, detail) {
    this.db
      .prepare("INSERT OR REPLACE INTO diagnostics VALUES(?,?)")
      .run(job, JSON.stringify(detail));
  }
  diagnostic(job) {
    const row = this.db
      .prepare("SELECT detail FROM diagnostics WHERE job=?")
      .get(job);
    return row ? JSON.parse(row.detail) : null;
  }
  close() {
    this.db.close();
  }
}
