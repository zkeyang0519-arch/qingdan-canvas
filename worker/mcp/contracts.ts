import type { CanvasData, Change } from "../types";
import type { ToolInput, WriteToolName, QueryToolName } from "./schemas";

export interface McpPrincipal {
  accountId: string;
  clientId: string;
  grantId: string;
  resource: string;
  scopes: string[];
}
export interface TaskRun {
  type: "text" | "ref";
  text?: string;
  targetId?: string;
  label?: string;
}
export interface TaskBlock {
  id: string;
  runs: TaskRun[];
  done: boolean;
  createdAt: string;
  completedAt: string | null;
  dueAt?: string | null;
  dueStartAt?: string | null;
  remark?: { text: string; updatedAt: string };
  createdByUserId?: string;
  createdByName?: string;
  arrangedOrder?: number;
}
export interface NoteData extends CanvasData {
  type: "note";
  blocks: TaskBlock[];
  blockOrder?: string[];
}
export interface CommandContext {
  canvasId: string;
  accountId: string;
  accountName: string;
  now: string;
  makeId: (prefix: string) => string;
}
// Audit identity and recovery expiry are attached by the transaction adapter.
export interface DeletionSnapshot {
  noteId: string;
  taskId: string;
  block: TaskBlock;
  previousTaskId: string | null;
  nextTaskId: string | null;
}
export interface CommandPlan {
  changes: Change[];
  deletionSnapshots: DeletionSnapshot[];
  result: Record<string, unknown>;
}
export type CanvasCommand = {
  [N in WriteToolName]: { name: N; input: ToolInput<N> };
}[WriteToolName];
export type CanvasQuery = {
  [N in QueryToolName]: { name: N; input: ToolInput<N> };
}[QueryToolName];
export interface QueryContext {
  canvasId: string;
  canvasName: string;
  sequence: number;
}
