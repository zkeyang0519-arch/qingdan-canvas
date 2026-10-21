import type { CanvasRoom } from "./room";
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ROOMS: DurableObjectNamespace<CanvasRoom>;
  ASSETS: Fetcher;
  APP_ENV: string;
}
export interface Session {
  id: string;
  name: string;
  username: string;
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
