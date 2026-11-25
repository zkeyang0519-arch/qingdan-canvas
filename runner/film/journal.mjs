import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function stableId(...parts) {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}
export class FilmJournal {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.db = new DatabaseSync(join(dir, "film.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get(key) {
    const row = this.db
      .prepare("SELECT value FROM records WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : null;
  }
  put(key, value) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
    return value;
  }
  close() {
    this.db.close();
  }
}
export class StageFailure extends Error {
  constructor(message, flags = {}) {
    super(message);
    Object.assign(this, flags);
  }
}
export function configured(env = process.env, codex = {}) {
  const target = {
    team: env.QINGDAN_WAAO_TEAM || "",
    project: env.QINGDAN_WAAO_PROJECT || "",
    canvas: env.QINGDAN_WAAO_CANVAS || "",
    model: env.QINGDAN_WAAO_MODEL || "",
    billing: env.QINGDAN_WAAO_BILLING || "",
  };
  return {
    protocol: 2,
    services: {
      deepseek: !!env.DEEPSEEK_API_KEY,
      codexText: !!codex.codexText,
      codexImage: !!codex.codexImage,
      director: !!(env.QINGDAN_DIRECTOR_API_KEY || env.DEEPSEEK_API_KEY),
      gpt: !!(
        (env.QINGDAN_GPT_API_KEY || env.OPENAI_API_KEY) &&
        env.QINGDAN_GPT_MODEL
      ),
      gemini: !!(env.GEMINI_API_KEY && env.QINGDAN_GEMINI_IMAGE_MODEL),
      waao: !!(
        env.QINGDAN_WAAO_MCP_TOKEN &&
        target.project &&
        target.canvas &&
        target.model &&
        (target.billing === "personal" ||
          (target.team && ["org", "team"].includes(target.billing)))
      ),
    },
    target,
  };
}
export function artifact(ctx, kind, title, text, source, extras = {}) {
  return {
    id: stableId(ctx.key, "artifact"),
    kind,
    title: title.slice(0, 160),
    text,
    source,
    parents: [],
    details: {},
    ...extras,
  };
}
export function inputText(input) {
  return [
    input.brief,
    input.character && "角色设定　" + input.character,
    input.dialogue && "固定对白　" + input.dialogue,
    input.style && "风格　" + input.style,
    input.context && "采用的项目背景　" + input.context,
    "时长　30 秒",
    "画幅　" + input.ratio,
  ]
    .filter(Boolean)
    .join("\n");
}
