import { z } from "zod";
import type { VerificationResult } from "./contracts";
const id = z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type QueuePhase = "running" | "pause_requested" | "verifying" | "waiting_human" | "finalizing" | "paused" | "blocked" | "completed" | "cancel_requested" | "cancelled";
export interface QueueView {
  managed: true;
  revision: number;
  phase: QueuePhase;
  currentIndex: number;
  turnId: string | null;
  pauseRequested: boolean;
  reason?: string;
  canResume: boolean;
  repairCount: number;
  verification?: { results: VerificationResult[] };
}
export const queueControlSchema = z.strictObject({
  bindingId: id, bindingRevision: revision, runId: id, requestId: id,
  expectedRevision: revision,
  action: z.enum(["pause", "resume", "confirm", "recover"]),
  expectedTurnId: id.optional(),
});
export type QueueControl = z.infer<typeof queueControlSchema>;
export const leaseRecoverySchema = z.strictObject({
  connectionEpoch: revision, runId: id, commandId: id, threadId: id,
  completedTurnId: id, leaseEpoch: revision,
  phase: z.enum(["inspect", "confirm"]), recoveryId: id.optional(),
}).refine(value => value.phase === "inspect" || !!value.recoveryId);
export const batchGateSchema = z.strictObject({
  connectionEpoch: revision, runId: id, commandId: id,
  fromIndex: z.number().int().min(0).max(99), completedTurnId: id,
  reportRevision: revision,
});
export type BatchGateRequest = z.infer<typeof batchGateSchema>;
export interface BatchGateResponse {
  decision: "wait" | "advance" | "finish" | "repair" | "blocked";
  queueRevision: number;
  permitId?: string;
  nextIndex?: number;
  reason?: string;
}
