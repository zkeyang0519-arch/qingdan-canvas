import { z } from "zod";
import type { Env } from "../types";
import { check } from "../http";
import { chatModelStatus } from "./chat-model";

const connectionId = z.string().min(1).max(256);
export const modelSettingsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("default"), id: connectionId }),
  z.strictObject({
    action: z.literal("add"),
    service: z.string().trim().min(1).max(60),
    model: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._:/@+-]{0,159}$/i),
    baseUrl: z.string().trim().min(1).max(2048),
    apiKey: z
      .string()
      .trim()
      .regex(/^[!-~]{1,4096}$/),
    apiFormat: z.enum(["responses", "chat_completions"]).default("responses"),
  }),
]);
type Connection = {
  id: string;
  service: string;
  model: string;
  baseUrl: string;
  apiFormat: "responses" | "chat_completions";
  apiKey: string;
};

function connectionUrl(value: string) {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    /* Report a public, credential-free error. */
  }
  check(
    url &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443"),
    "请输入不含账号或查询参数的 HTTPS API 地址。",
  );
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  check(
    !host.startsWith("[") &&
      !/^[\d.]+$/.test(host) &&
      host.includes(".") &&
      !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host),
    "请使用模型服务商的公开 HTTPS 域名。",
  );
  return url.href
    .replace(/\/+$/, "")
    .replace(/\/(responses|chat\/completions)$/, "");
}

// This store lives inside the authenticated account's private Chat DO. Keys are
// never copied into chat messages, request receipts, provider metadata or logs.
export class ChatModelConnections {
  constructor(
    private sql: SqlStorage,
    private env: Env,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_model_connections (
      id TEXT PRIMARY KEY, service TEXT NOT NULL, model TEXT NOT NULL,
      base_url TEXT NOT NULL, api_format TEXT NOT NULL, api_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_model_preferences (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get defaultId() {
    return (
      this.sql
        .exec<{ value: string }>(
          "SELECT value FROM agent_model_preferences WHERE name='default'",
        )
        .toArray()[0]?.value ?? "xingchi"
    );
  }
  list() {
    const legacy = chatModelStatus(this.env);
    const profiles = this.sql
      .exec<Omit<Connection, "apiKey">>(
        "SELECT id,service,model,base_url AS baseUrl,api_format AS apiFormat FROM agent_model_connections ORDER BY rowid",
      )
      .toArray()
      .map((profile) => ({ ...profile, configured: true }));
    return {
      defaultId: this.defaultId,
      modelsEndpoint: "/api/agent/chat/models",
      apiFormats: ["responses", "chat_completions"],
      profiles: [
        {
          id: "xingchi",
          service: "现有连接",
          model: legacy.model || "尚未配置",
          configured: legacy.configured,
          baseUrl: legacy.host
            ? `https://${legacy.host}`
            : "https://api.openai.com/v1",
          apiFormat: legacy.format,
        },
        ...profiles,
      ],
    };
  }
  status(id = this.defaultId) {
    const catalog = this.list();
    const profile = catalog.profiles.find((item) => item.id === id);
    return {
      ...catalog,
      configured: !!profile?.configured,
      model: profile?.model ?? null,
      format: profile?.apiFormat ?? "responses",
      host: profile ? new URL(profile.baseUrl).host : null,
    };
  }
  configuration(id = "xingchi") {
    if (id === "xingchi") return this.env;
    const row = this.sql
      .exec<Connection>(
        "SELECT id,service,model,base_url AS baseUrl,api_format AS apiFormat,api_key AS apiKey FROM agent_model_connections WHERE id=?",
        id,
      )
      .toArray()[0];
    check(row, "找不到当前账号的模型连接，请在设置中重新选择。", 404);
    return {
      ROUTER_MODEL: row.model,
      ROUTER_BASE_URL: row.baseUrl,
      ROUTER_API_KEY: row.apiKey,
      ROUTER_API_FORMAT: row.apiFormat,
    };
  }
  requireConfigured(id: string) {
    check(
      chatModelStatus(this.configuration(id)).configured,
      "请先在设置中新建模型连接并填写 API 密钥。",
      409,
    );
  }
  change(input: z.infer<typeof modelSettingsSchema>) {
    if (input.action === "list") return this.list();
    if (input.action === "default") {
      this.requireConfigured(input.id);
      this.sql.exec(
        "INSERT OR REPLACE INTO agent_model_preferences VALUES('default',?)",
        input.id,
      );
      return this.list();
    }
    check(this.list().profiles.length < 65, "模型连接已达上限。", 409);
    const baseUrl = connectionUrl(input.baseUrl);
    const useAsDefault = !this.status().configured;
    const added = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO agent_model_connections VALUES(?,?,?,?,?,?)",
      added,
      input.service,
      input.model,
      baseUrl,
      input.apiFormat,
      input.apiKey,
    );
    if (useAsDefault)
      this.sql.exec(
        "INSERT OR REPLACE INTO agent_model_preferences VALUES('default',?)",
        added,
      );
    return { ...this.list(), added };
  }
}
