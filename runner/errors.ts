export class RunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}
export class RpcError extends RunnerError {
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super("CODEX_RPC_ERROR", message);
  }
}
