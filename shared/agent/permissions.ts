import { z } from "zod";
const id = z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const permissionProfileSchema = z.enum(["read_only", "workspace_manual", "workspace_auto", "full_access"]);
export const permissionSelectionSchema = z.strictObject({profile:permissionProfileSchema});
export const executionPermissionsSchema = z.discriminatedUnion("profile", [
  z.strictObject({profile:z.enum(["read_only", "workspace_manual", "workspace_auto"]),network:z.literal(false)}),
  z.strictObject({profile:z.literal("full_access"),network:z.literal(true)}),
]);
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;
export type ExecutionPermissions = z.infer<typeof executionPermissionsSchema>;
export const DEFAULT_EXECUTION_PERMISSION: PermissionProfile = "full_access";
// Only new submissions receive the default. Persisted snapshots keep their permissions.
export function resolveExecutionPermissions(kind: "summary" | "task", profile: PermissionProfile = DEFAULT_EXECUTION_PERMISSION): ExecutionPermissions {
  if (kind === "summary") return {profile:"read_only",network:false};
  return profile === "full_access" ? {profile,network:true} : {profile,network:false};
}
export const approvalDetailsSchema = z.strictObject({
  method:z.enum(["item/commandExecution/requestApproval","item/fileChange/requestApproval"]),
  command:z.string().max(8000).optional(),cwd:z.string().max(2000).optional(),
  files:z.array(z.string().max(2000)).max(30).optional(),
  allowedDecisions:z.array(z.enum(["accept","decline","cancel"])).min(1).max(3).refine(v=>new Set(v).size===v.length).optional(),
});
export type ApprovalDetails = z.infer<typeof approvalDetailsSchema>;
export const inputQuestionSchema = z.strictObject({
  id:z.string().min(1).max(256),prompt:z.string().min(1).max(8000),
  options:z.array(z.strictObject({label:z.string().min(1).max(500),description:z.string().max(2000)})).max(20).optional(),
  isOther:z.boolean().optional(),isSecret:z.boolean().optional(),
});
export type InputQuestion = z.infer<typeof inputQuestionSchema>;
export const requestResponseSchema = z.union([
  z.strictObject({decision:z.enum(["accept","decline","cancel"])}),
  z.strictObject({answers:z.record(z.string().min(1).max(256),z.strictObject({answers:z.array(z.string().min(1).max(8000)).min(1).max(20)})).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=20)}),
]);
export type RequestResponse = z.infer<typeof requestResponseSchema>;
export const executionRespondSchema = z.strictObject({
  bindingId:id,bindingRevision:revision,runId:id,requestId:id,expectedTurnId:id,pendingRequestId:id,response:requestResponseSchema,
});
export type ExecutionRespond = z.infer<typeof executionRespondSchema>;
export interface PendingExecutionRequest {
  requestId:string;runId:string;threadId:string;turnId:string;
  kind:"approval"|"input";description?:string;details?:ApprovalDetails;
  questions?:InputQuestion[];responseStatus:"pending"|"queued";
}
export interface ExecutionResponseReceipt {
  responseId:string;pendingRequestId:string;status:"queued"|"applied"|"expired"|"cancelled";
}
export interface NativeRequestResponse {
  responseId:string;pendingRequestId:string;runId:string;threadId:string;turnId:string;response:RequestResponse;
}
export const nativeResponsesSchema = z.strictObject({connectionEpoch:revision,runId:id});
export const nativeResponseAckSchema = nativeResponsesSchema.extend({responseId:id,status:z.enum(["applied","expired","cancelled"]),reason:z.string().max(1000).optional()});
export type NativeResponseAck = z.infer<typeof nativeResponseAckSchema>;
export type NativeResponsesResult = {responses:NativeRequestResponse[]};
