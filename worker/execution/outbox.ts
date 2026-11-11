import type {
  CommandEnvelope,
  RunnerCommand,
} from "../../shared/agent/contracts";
import type {
  ExecutionAck,
  ExecutionReceipt,
} from "../../shared/agent/execution";
import { digest } from "../auth";
export const canonical = (value: unknown): string =>
  JSON.stringify(normalize(value));
function normalize(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(normalize)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, normalize(x)]),
        )
      : v;
}
export const hash = (v: unknown) => digest(canonical(v));
export interface StoredCommand {
  payload: RunnerCommand;
  receipt: ExecutionReceipt;
  envelope: CommandEnvelope | null;
  ack: Omit<ExecutionAck, "connectionEpoch"> | null;
  sequence: number;
  eventFloor: number;
  settled?: boolean;
  afterLeaseEpoch?: number;
}
export async function materialize(
  command: StoredCommand,
  bindingRevision: number,
  authEpoch: number,
  leaseEpoch: number,
) {
  if (!command.envelope)
    command.envelope = {
      protocolVersion: 1,
      commandId: command.receipt.commandId,
      runId: command.payload.runId,
      bindingRevision,
      authEpoch,
      leaseEpoch,
      payloadHash: await hash(command.payload),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      payload: command.payload,
    };
  return command.envelope;
}
