export type AgentErrorCode =
  | "VALIDATION_ERROR"
  | "LIMIT_EXCEEDED"
  | "DUPLICATE_TASK_ID"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_ORDER"
  | "MANUAL_ORDER_INVALID"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "ACCESS_DENIED"
  | "RECONCILIATION_REQUIRED";

export class AgentValidationError extends Error {
  readonly retryable = false;
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentValidationError";
  }
}
