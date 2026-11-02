export type BusinessErrorCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "LOCKED"
  | "ARCHIVED"
  | "REVISION_CONFLICT"
  | "STALE_CURSOR"
  | "IDEMPOTENCY_KEY_REUSED"
  | "VALIDATION_ERROR"
  | "LIMIT_EXCEEDED";

export class McpBusinessError extends Error {
  constructor(
    public readonly code: BusinessErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpBusinessError";
  }
}

export function businessErrorResult(error: McpBusinessError) {
  const structuredContent = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
  };
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}
