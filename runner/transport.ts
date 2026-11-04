import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  parseCommandEnvelope,
  parseRunnerEvent,
} from "../shared/agent/schemas";
import type { RunnerEvent, CommandEnvelope } from "../shared/agent/contracts";
import {
  DeviceStore,
  type WorkspaceView,
  type StoredReceipt,
  type LeaseRecord,
} from "./device-store";
import { validateServerOrigin } from "./credentials";
import { digest } from "./store";
import { RunnerError } from "./errors";
const require = createRequire(import.meta.url);
export type TransportStatus = {
  connectionStatus: "connecting" | "online" | "offline" | "revoked" | "error";
  lastHeartbeatAt: string | null;
  connectionEpoch: number;
  error: string | null;
};
export interface RunnerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(id: any): void;
}
interface Socket {
  readyState: number;
  on(name: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}
export type TransportOptions = {
  store: DeviceStore;
  runnerId: string;
  ownerId: string;
  authEpoch: number;
  serverOrigin: string;
  secret: () => Promise<string | null>;
  workspaces: () => WorkspaceView[];
  clock?: RunnerClock;
  fetch?: typeof fetch;
  socketFactory?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Socket;
  onStatus?: (status: TransportStatus) => void;
  validateWorkspace?: (workspaceId: string) => Promise<unknown>;
};
type Request = {
  resolve: (packet: any) => void;
  reject: (error: Error) => void;
  timer: any;
};
export type ExecutionAction = "context" | "poll" | "ack" | "events" | "report";
/** Native-only outbound connection. The device credential stays in this transport. */
export class RunnerTransport {
  readonly status: TransportStatus = {
    connectionStatus: "offline",
    lastHeartbeatAt: null,
    connectionEpoch: 0,
    error: null,
  };
  private clock: RunnerClock;
  private http: typeof fetch;
  private socket?: Socket;
  private generation = 0;
  private running = false;
  private revoked = false;
  private timer: any;
  private heartbeat: any;
  private renew: any;
  private attempt = 0;
  private lastSeen = 0;
  private tokenExpires = 0;
  #executionToken?: string;
  private executionAbort = new AbortController();
  private authEpoch: number;
  private requestMap = new Map<string, Request>();
  private abort?: AbortController;
  private authTimeout: any;
  constructor(private options: TransportOptions) {
    validateServerOrigin(options.serverOrigin);
    this.clock = options.clock ?? {
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    this.http = options.fetch ?? fetch;
    this.authEpoch = options.authEpoch;
  }
  private state(value: Partial<TransportStatus>) {
    Object.assign(this.status, value);
    this.options.onStatus?.({ ...this.status });
  }
  async start() {
    if (this.running || this.revoked) return;
    this.running = true;
    void this.connect();
  }
  private clearTimers() {
    for (const id of [this.timer, this.heartbeat, this.renew, this.authTimeout])
      if (id !== undefined) this.clock.clearTimeout(id);
    this.timer = this.heartbeat = this.renew = this.authTimeout = undefined;
  }
  private drop() {
    this.clearTimers();
    this.abort?.abort();
    this.abort = undefined;
    this.#executionToken = undefined;
    this.executionAbort.abort();
    this.executionAbort = new AbortController();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    for (const request of this.requestMap.values()) {
      this.clock.clearTimeout(request.timer);
      request.reject(
        new RunnerError("CONNECTION_LOST", "Runner connection closed."),
      );
    }
    this.requestMap.clear();
  }
  close() {
    this.running = false;
    ++this.generation;
    this.drop();
    if (!this.revoked) this.state({ connectionStatus: "offline" });
  }
  reconnect() {
    if (this.revoked) return;
    this.running = true;
    ++this.generation;
    this.drop();
    this.attempt = 0;
    void this.connect();
  }
  private stopRevoked() {
    this.revoked = true;
    this.running = false;
    ++this.generation;
    this.drop();
    this.state({
      connectionStatus: "revoked",
      error: "Device authorization was revoked.",
    });
  }
  private fail(generation: number, reason = "Runner server is unavailable.") {
    if (generation !== this.generation || !this.running || this.revoked) return;
    ++this.generation;
    this.drop();
    this.state({ connectionStatus: "offline", error: reason });
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }
  private async connect() {
    if (!this.running || this.revoked) return;
    const generation = ++this.generation;
    this.state({ connectionStatus: "connecting", error: null });
    const abort = new AbortController();
    this.abort = abort;
    const timeout = this.clock.setTimeout(() => abort.abort(), 10000);
    this.authTimeout = timeout;
    try {
      const secret = await this.options.secret();
      if (generation !== this.generation) return;
      if (!secret)
        throw new RunnerError(
          "CREDENTIAL_MISSING",
          "Runner credential is unavailable.",
        );
      const response = await this.http(
        `${this.options.serverOrigin}/api/runner/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runnerId: this.options.runnerId, secret }),
          signal: abort.signal,
          redirect: "error",
        },
      );
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.stopRevoked();
        return;
      }
      if (!response.ok) throw new Error("authentication unavailable");
      const token = (await response.json()) as any;
      if (generation !== this.generation) return;
      const expiresAt =
        typeof token.expiresAt === "number"
          ? token.expiresAt
          : Date.parse(token.expiresAt);
      if (
        typeof token.token !== "string" ||
        !token.token ||
        token.runnerId !== this.options.runnerId ||
        token.ownerId !== this.options.ownerId ||
        token.authEpoch !== this.authEpoch ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= this.clock.now()
      )
        throw new RunnerError("AUTH_INVALID", "Invalid device authorization.");
      this.tokenExpires = expiresAt;
      this.#executionToken = token.token;
      const url = new URL("/api/runner/connect", this.options.serverOrigin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = this.options.socketFactory
        ? this.options.socketFactory(url.href, {
            headers: { Authorization: `Bearer ${token.token}` },
          })
        : new (require("ws"))(url.href, {
            headers: { Authorization: `Bearer ${token.token}` },
            handshakeTimeout: 10000,
            maxPayload: 2_000_000,
          });
      if (generation !== this.generation) {
        socket.close();
        return;
      }
      this.socket = socket;
      socket.on("message", (data: any) => {
        if (generation !== this.generation || socket !== this.socket) return;
        void this.receive(data, generation).catch(() =>
          this.fail(generation, "Runner protocol rejected an invalid message."),
        );
      });
      socket.on("close", () => this.fail(generation));
      socket.on("error", () => this.fail(generation));
      socket.on("unexpected-response", (_request: any, res: any) => {
        if (generation !== this.generation) return;
        if (res.statusCode === 401 || res.statusCode === 403)
          this.stopRevoked();
        else this.fail(generation);
      });
      this.timer = this.clock.setTimeout(
        () => this.fail(generation, "Runner welcome timed out."),
        10000,
      );
      this.renew = this.clock.setTimeout(
        () => this.reconnect(),
        Math.max(1000, expiresAt - this.clock.now() - 60000),
      );
    } catch (error) {
      if (generation === this.generation && this.running)
        this.fail(
          generation,
          (error as { code?: string }).code === "CREDENTIAL_MISSING"
            ? "Runner credential is unavailable."
            : undefined,
        );
    } finally {
      this.clock.clearTimeout(timeout);
      if (this.authTimeout === timeout) this.authTimeout = undefined;
    }
  }
  private send(packet: Record<string, unknown>) {
    if (
      this.socket?.readyState === 1 &&
      this.status.connectionStatus === "online"
    )
      this.socket.send(
        JSON.stringify({
          protocolVersion: 1,
          connectionEpoch: this.status.connectionEpoch,
          ...packet,
        }),
      );
  }
  private scheduleHeartbeat(generation: number) {
    this.heartbeat = this.clock.setTimeout(() => {
      if (generation !== this.generation || !this.running) return;
      if (this.clock.now() - this.lastSeen >= 45000) {
        this.fail(generation, "Runner heartbeat timed out.");
        return;
      }
      if (this.clock.now() >= this.tokenExpires) {
        this.reconnect();
        return;
      }
      this.send({
        type: "heartbeat",
        leases: this.options.store
          .leases()
          .filter((lease) => lease.expiresAt > this.clock.now())
          .map(({ workspaceId, runId, leaseEpoch }) => ({
            workspaceId,
            runId,
            leaseEpoch,
          })),
      });
      this.scheduleHeartbeat(generation);
    }, 15000);
  }
  private async receive(data: any, generation: number) {
    if (Buffer.byteLength(data) > 2_000_000) throw new Error("large packet");
    const packet = JSON.parse(data.toString());
    if (packet.protocolVersion !== 1) return;
    if (packet.type === "revoked") {
      this.stopRevoked();
      return;
    }
    if (packet.type === "welcome") {
      if (
        this.status.connectionStatus !== "connecting" ||
        packet.runnerId !== this.options.runnerId ||
        packet.authEpoch !== this.authEpoch ||
        !Number.isSafeInteger(packet.connectionEpoch) ||
        packet.connectionEpoch <= this.status.connectionEpoch
      )
        throw new Error("invalid welcome");
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
      this.lastSeen = this.clock.now();
      this.attempt = 0;
      this.state({
        connectionStatus: "online",
        connectionEpoch: packet.connectionEpoch,
        lastHeartbeatAt: new Date(this.lastSeen).toISOString(),
        error: null,
      });
      this.send({
        type: "register_workspaces",
        requestId: randomUUID(),
        workspaces: this.options.workspaces(),
      });
      for (const event of this.options.store.pendingEvents())
        this.send({ type: "event", event });
      this.scheduleHeartbeat(generation);
      return;
    }
    // Hub errors intentionally have no connectionEpoch. The active-socket
    // generation guard is applied before receive(), including for these packets.
    if (packet.type === "error") {
      if (
        packet.connectionEpoch !== undefined &&
        packet.connectionEpoch !== this.status.connectionEpoch
      )
        return;
      if (
        ["REVOKED", "AUTH_REVOKED", "DEVICE_REVOKED", "UNAUTHORIZED"].includes(
          packet.code,
        )
      ) {
        this.stopRevoked();
        return;
      }
      const message =
        typeof packet.message === "string"
          ? packet.message.slice(0, 1000)
          : "Runner server rejected the request.";
      const request = this.requestMap.get(packet.requestId);
      if (request) {
        this.clock.clearTimeout(request.timer);
        this.requestMap.delete(packet.requestId);
        request.reject(
          new RunnerError(
            typeof packet.code === "string" ? packet.code : "SERVER_ERROR",
            message,
          ),
        );
      } else this.state({ error: message });
      return;
    }
    if (
      packet.connectionEpoch !== this.status.connectionEpoch ||
      this.status.connectionStatus !== "online"
    )
      return;
    if (packet.type === "heartbeat_ack") {
      this.lastSeen = this.clock.now();
      this.state({ lastHeartbeatAt: new Date(this.lastSeen).toISOString() });
      for (const lease of packet.leases ?? []) {
        const prior = this.options.store.lease(lease.runId);
        if (
          prior &&
          prior.expiresAt > this.clock.now() &&
          prior.workspaceId === lease.workspaceId &&
          prior.leaseEpoch === lease.leaseEpoch &&
          Number.isFinite(lease.expiresAt) &&
          lease.expiresAt > this.clock.now()
        )
          this.options.store.saveLease(lease);
      }
      return;
    }
    if (packet.type === "event_ack") {
      if (typeof packet.eventId === "string")
        this.options.store.ackEvent(packet.eventId);
      return;
    }
    if (packet.type === "command") {
      const receipt = await this.accept(packet.envelope, generation);
      if (receipt && generation === this.generation)
        this.send({
          type: "command_ack",
          commandId: packet.envelope?.commandId,
          receipt,
        });
      return;
    }
    const request = this.requestMap.get(packet.requestId);
    if (request) {
      this.clock.clearTimeout(request.timer);
      this.requestMap.delete(packet.requestId);
      request.resolve(packet);
    }
  }
  private async accept(
    value: unknown,
    generation: number,
  ): Promise<StoredReceipt | null> {
    try {
      const envelope = parseCommandEnvelope(value);
      const prior = this.options.store.command(envelope.commandId);
      if (prior) {
        if (prior.hash !== digest(envelope))
          return { status: "rejected", reason: "IDEMPOTENCY_KEY_REUSED" };
        return prior.receipt;
      }
      let reason: string | undefined;
      if (envelope.payloadHash !== digest(envelope.payload))
        reason = "PAYLOAD_HASH_MISMATCH";
      else if (
        envelope.authEpoch !== this.authEpoch ||
        this.clock.now() >= this.tokenExpires
      )
        reason = "AUTH_EXPIRED";
      else if (
        Date.parse(envelope.expiresAt) <= this.clock.now() ||
        Date.parse(envelope.issuedAt) > this.clock.now() + 30000
      )
        reason = "COMMAND_EXPIRED";
      else {
        const lease = this.options.store.lease(envelope.runId);
        if (
          !lease ||
          lease.leaseEpoch !== envelope.leaseEpoch ||
          lease.expiresAt <= this.clock.now()
        )
          reason = "LEASE_EXPIRED";
        else if (this.options.validateWorkspace)
          try {
            await this.options.validateWorkspace(lease.workspaceId);
          } catch {
            reason = "WORKSPACE_CHANGED";
          }
      }
      if (generation !== this.generation || !this.running) return null;
      return this.options.store.receiveCommand(
        envelope,
        reason ? { status: "rejected", reason } : { status: "stored" },
      );
    } catch (error) {
      return {
        status: "rejected",
        reason: (error as { code?: string }).code ?? "VALIDATION_ERROR",
      };
    }
  }
  async acceptExecutionEnvelope(
    envelope: CommandEnvelope,
  ): Promise<StoredReceipt | null> {
    if (this.status.connectionStatus !== "online") return null;
    return this.accept(envelope, this.generation);
  }
  async executionRequest(
    action: ExecutionAction,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (!["context", "poll", "ack", "events", "report"].includes(action))
      throw new RunnerError("VALIDATION_ERROR", "Invalid execution operation.");
    if (
      this.status.connectionStatus !== "online" ||
      !this.#executionToken ||
      this.clock.now() >= this.tokenExpires
    )
      throw new RunnerError("RUNNER_OFFLINE", "Runner is offline.");
    const generation = this.generation;
    const response = await this.http(
      new URL(`/api/runner/execution/${action}`, this.options.serverOrigin),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#executionToken}`,
        },
        body: JSON.stringify({
          ...body,
          connectionEpoch: this.status.connectionEpoch,
        }),
        signal: AbortSignal.any([
          this.executionAbort.signal,
          AbortSignal.timeout(5000),
        ]),
        redirect: "error",
      },
    );
    if (generation !== this.generation)
      throw new RunnerError("CONNECTION_LOST", "Runner connection changed.");
    if (response.status === 401) {
      // Refresh the bearer; a failed exchange will transition to revoked.
      this.reconnect();
      throw new RunnerError("AUTH_EXPIRED", "Runner authorization expired.");
    }
    if (!response.ok)
      throw new RunnerError(
        response.status === 403
          ? "EXECUTION_REVOKED"
          : response.status === 404
            ? "EXECUTION_DISABLED"
            : `EXECUTION_HTTP_${response.status}`,
        "Runner execution request was rejected.",
      );
    const result = await response.json();
    if (generation !== this.generation)
      throw new RunnerError("CONNECTION_LOST", "Runner connection changed.");
    return result;
  }
  publish(value: RunnerEvent) {
    const event = parseRunnerEvent(value);
    if (event.runnerId !== this.options.runnerId)
      throw new RunnerError(
        "ACCESS_DENIED",
        "Event belongs to another Runner.",
      );
    if (this.options.store.enqueueEvent(event))
      this.send({ type: "event", event });
  }
  private request(type: string, body: Record<string, unknown>): Promise<any> {
    if (this.status.connectionStatus !== "online")
      return Promise.reject(
        new RunnerError("RUNNER_OFFLINE", "Runner is offline."),
      );
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.requestMap.delete(requestId);
        reject(
          new RunnerError(
            "REQUEST_TIMEOUT",
            "Runner server response timed out.",
          ),
        );
      }, 10000);
      this.requestMap.set(requestId, { resolve, reject, timer });
      this.send({ type, requestId, ...body });
    });
  }
  async updateWorkspaces() {
    if (this.status.connectionStatus !== "online") return;
    const packet = await this.request("register_workspaces", {
      workspaces: this.options.workspaces(),
    });
    if (packet.type !== "workspaces_ack")
      throw new RunnerError(
        "PROTOCOL_ERROR",
        "Invalid workspace acknowledgement.",
      );
  }
  async claimLease(
    workspaceId: string,
    runId: string,
    options?: { recoverExpired?: boolean },
  ): Promise<LeaseRecord> {
    await this.options.validateWorkspace?.(workspaceId);
    const packet = await this.request("lease_claim", { workspaceId, runId });
    if (
      packet.type !== "lease_granted" ||
      packet.workspaceId !== workspaceId ||
      packet.runId !== runId ||
      !Number.isSafeInteger(packet.leaseEpoch) ||
      packet.leaseEpoch < 1 ||
      !Number.isFinite(packet.expiresAt) ||
      (!options?.recoverExpired && packet.expiresAt <= this.clock.now())
    )
      throw new RunnerError("PROTOCOL_ERROR", "Invalid workspace lease.");
    const lease = {
      workspaceId,
      runId,
      leaseEpoch: packet.leaseEpoch,
      expiresAt: packet.expiresAt,
    };
    this.options.store.saveLease(lease);
    return lease;
  }
  async releaseLease(
    workspaceId: string,
    runId: string,
    confirmedStopped: true,
  ) {
    if (confirmedStopped !== true)
      throw new RunnerError(
        "CONFIRMATION_REQUIRED",
        "Run stop must be confirmed.",
      );
    const lease = this.options.store.lease(runId);
    if (!lease || lease.workspaceId !== workspaceId)
      throw new RunnerError("ACCESS_DENIED", "Workspace lease not found.");
    const packet = await this.request("lease_release", {
      workspaceId,
      runId,
      leaseEpoch: lease.leaseEpoch,
      confirmedStopped: true,
    });
    if (packet.type !== "lease_released")
      throw new RunnerError(
        "PROTOCOL_ERROR",
        "Invalid lease release acknowledgement.",
      );
    // The workspace may have been claimed again while this release was pending.
    const current = this.options.store.lease(runId);
    if (
      current?.workspaceId === workspaceId &&
      current.leaseEpoch === lease.leaseEpoch
    )
      this.options.store.removeLease(workspaceId);
  }
}
