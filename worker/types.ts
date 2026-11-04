import type { CanvasRoom } from "./room";
import type { RunnerHub } from "./execution/hub";
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ROOMS: DurableObjectNamespace<CanvasRoom>;
  RUNNER_HUBS: DurableObjectNamespace<RunnerHub>;
  RUNNER_ENABLED?: string;
  EXECUTION_ENABLED?: string;
  ASSETS: Fetcher;
  APP_ENV: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_CODE_SECRET?: string;
  PUBLIC_ORIGIN?: string;
  MCP_ENABLED?: string;
  MCP_ALLOWED_ORIGINS?: string;
  OAUTH_KV?: KVNamespace;
}
export interface Session {
  id: string;
  name: string;
  username: string;
  avatar_version?: string | null;
  token_hash: string;
  expires_at: number;
}
export interface Room {
  id: string;
  name: string;
  owner_id: string;
  invite_hash: string;
  created_at: string;
  role?: string;
}
export interface Asset {
  id: string;
  mime: string;
  byte_length: number;
  name: string;
}
export interface CanvasData {
  id: string;
  type: "note" | "image" | "frame" | "collection";
  boardId: string;
  parentId: string | null;
  assetId?: string;
  assetMetadata?: { id: string; mime: string; byteLength: number };
  [key: string]: unknown;
}
export interface Row {
  id: string;
  revision: number;
  deleted: boolean;
  data: CanvasData | null;
}
export interface Change {
  id: string;
  expectedRevision: number;
  data: CanvasData | null;
}
export interface Commit {
  type: "commit";
  opId: string;
  changes: Change[];
}
