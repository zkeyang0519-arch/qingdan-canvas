import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    const row = this.db.prepare("SELECT * FROM models WHERE id=?").get(id);
    if (!row) throw Error("找不到所选模型连接，请重新选择。");
    return {
      ...row,
      apiKey: async () =>
        (await this.credentialFile(row.id, row.baseUrl).load()).apiKey,
      setupHint: "请在「管理模型」中配置此连接的密钥。",
    };
  }
  async list() {
    const builtin = await this.legacy.status();
    return {
      defaultId: this.defaultId,
      modelsEndpoint: "/local/models",
      apiFormats: ["responses"],
      profiles: [
        {
          id: "xingchi",
          service: "星驰",
          model: this.legacy.model,
          configured: builtin.configured,
          baseUrl: this.legacy.baseUrl,
        },
        ...this.db
          .prepare("SELECT * FROM models ORDER BY rowid")
          .all()
          .map((row) => ({ ...row, configured: true })),
      ],
    };
  }
  async status(profileId) {
    const list = await this.list();
    const profile = list.profiles.find(
      (p) => p.id === (profileId ?? list.defaultId),
    );
    return {
      ...list,
      ...profile,
      host: new URL(profile.baseUrl).host,
      format: "responses",
      runtime: "Pi RPC 1.5.2",
      ...(profile.configured ? {} : { setupHint: this.legacy.setupHint }),
    };
  }
  async add(input) {
    const service = input.service?.trim(),
      model = input.model?.trim(),
      key = input.apiKey?.trim();
    if (
      !service ||
      service.length > 60 ||
      !/^[a-z0-9][a-z0-9._:/@+-]{0,159}$/i.test(model ?? "") ||
      !key ||
      !/^[!-~]{1,4096}$/.test(key)
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
    const baseUrl = url.href.replace(/\/+$/, "").replace(/\/responses$/, "");
    const id = randomUUID();
    const file = this.credentialFile(id, baseUrl);
    await file.save({ apiKey: key });
    try {
      this.db
        .prepare("INSERT INTO models VALUES(?,?,?,?)")
        .run(id, service, model, baseUrl);
    } catch (error) {
      await file.clear();
      throw error;
    }
    return id;
  }
  setDefault(id) {
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
