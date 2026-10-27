import { z } from "zod";
import { McpBusinessError } from "./errors";
export const recoveryLifetime = 30 * 86400000;
export function initializeMcpStorage(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS room_metadata(id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
 INSERT OR IGNORE INTO room_metadata(id,sequence) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS mcp_receipts(grant_id TEXT NOT NULL,request_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL,client_id TEXT NOT NULL,payload TEXT NOT NULL,command TEXT NOT NULL,created_at INTEGER NOT NULL,value TEXT NOT NULL,rows TEXT NOT NULL,expires_at INTEGER,PRIMARY KEY(grant_id,request_id));
 CREATE INDEX IF NOT EXISTS mcp_receipts_actor ON mcp_receipts(account_id,created_at,operation_id);
 CREATE TABLE IF NOT EXISTS mcp_deleted_blocks(operation_id TEXT NOT NULL,task_id TEXT NOT NULL,snapshot TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(operation_id,task_id));
 CREATE INDEX IF NOT EXISTS mcp_deleted_expiry ON mcp_deleted_blocks(expires_at);
 CREATE TABLE IF NOT EXISTS mcp_restore_receipts(operation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,value TEXT NOT NULL,rows TEXT NOT NULL);`);
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const auditInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({
    action: z.literal("restore"),
    operation_id: z.string().min(1).max(256),
  }),
]);
export function parseAuditInput(input: unknown) {
  const p = auditInput.safeParse(input);
  if (!p.success)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Invalid operation request.",
    );
  return p.data;
}
export interface McpReceipt extends Record<string, SqlStorageValue> {
  grant_id: string;
  request_id: string;
  operation_id: string;
  account_id: string;
  client_id: string;
  payload: string;
  command: string;
  created_at: number;
  value: string;
  rows: string;
  expires_at: number | null;
}
export function auditCursor(
  cursor: string | undefined,
  canvasId: string,
  accountId: string,
): { time: number; id: string } {
  if (!cursor) return { time: 0, id: "" };
  try {
    const p = JSON.parse(atob(cursor));
    if (
      p.v !== 1 ||
      p.canvas !== canvasId ||
      p.actor !== accountId ||
      !Number.isSafeInteger(p.time) ||
      p.time < 0 ||
      typeof p.id !== "string" ||
      p.id.length > 256 ||
      btoa(JSON.stringify(p)) !== cursor
    )
      throw Error();
    return { time: p.time, id: p.id };
  } catch {
    throw new McpBusinessError("VALIDATION_ERROR", "Invalid operation cursor.");
  }
}
export function nextAuditCursor(
  canvasId: string,
  accountId: string,
  row: McpReceipt,
) {
  return btoa(
    JSON.stringify({
      v: 1,
      canvas: canvasId,
      actor: accountId,
      time: row.created_at,
      id: row.operation_id,
    }),
  );
}
