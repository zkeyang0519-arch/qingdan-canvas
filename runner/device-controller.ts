import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DeviceStore,
  type DeviceConfig,
  type WorkspaceView,
} from "./device-store";
import { WorkspaceRegistry } from "./workspaces";
import {
  WindowsCredentialManager,
  credentialTarget,
  validateServerOrigin,
  type CredentialStore,
} from "./credentials";
import {
  RunnerTransport,
  type TransportOptions,
  type TransportStatus,
} from "./transport";
import { RunnerError } from "./errors";
import { validDeviceName, WORKSPACE_NAME_MAX } from "./metadata";
import { ExecutionStore } from "./execution-store";
import { RunnerExecutor, type ExecutionTransport } from "./executor";
import { digest, RunnerStore } from "./store";
import type { AdapterOptions } from "./codex-adapter";
import {
  listCodexSessions,
  readCodexSession,
  type SessionQuery,
} from "./codex-sessions";
export type LocalDeviceView = {
  paired: boolean;
  runnerId: string | null;
  ownerId: string | null;
  deviceName: string;
  serverOrigin: string;
  enabled: boolean;
  connectionStatus:
    "unpaired" | "connecting" | "online" | "offline" | "revoked" | "error";
  lastHeartbeatAt: string | null;
  connectionEpoch: number;
  workspaces: WorkspaceView[];
  error: string | null;
  credentialStorage: "windows-credential-manager";
};
type ManagedTransport = Partial<ExecutionTransport> & {
  status: TransportStatus;
  start(): Promise<void>;
  close(): void;
  reconnect(): void;
  updateWorkspaces(): Promise<void>;
};
export type DeviceControllerOptions = {
  stateDir: string;
  serverOrigin: string;
  credentials?: CredentialStore;
  fetch?: typeof fetch;
  transportFactory?: (options: TransportOptions) => ManagedTransport;
  locksDir?: string;
  executionEnabled?: boolean;
  executionCodex?: Omit<AdapterOptions, "runnerId" | "store" | "workspaces">;
};
export class RunnerDeviceController {
  private store: DeviceStore;
  private registry: WorkspaceRegistry;
  private credentials: CredentialStore;
  private transport?: ManagedTransport;
  private execution?: {
    executor: RunnerExecutor;
    journal: ExecutionStore;
    runs: RunnerStore;
  };
  private config: DeviceConfig | null;
  private http: typeof fetch;
  private closed = false;
  private started = false;
  private generation = 0;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly serverOrigin: string;
  constructor(private options: DeviceControllerOptions) {
    this.serverOrigin = validateServerOrigin(options.serverOrigin);
    this.credentials = options.credentials ?? new WindowsCredentialManager();
    this.http = options.fetch ?? fetch;
    this.store = new DeviceStore(path.join(options.stateDir, "device.sqlite"));
    this.registry = new WorkspaceRegistry(this.store, {
      locksDir: options.locksDir,
    });
    this.config = this.store.config();
    if (this.config && this.config.serverOrigin !== this.serverOrigin) {
      this.store.close();
      throw new RunnerError(
        "ACCESS_DENIED",
        "Saved device belongs to a different Runner server.",
      );
    }
  }
  async start() {
    this.checkOpen();
    if (this.started) return;
    this.started = true;
    if (!this.config) return;
    if (this.config.pairingPending) {
      const generation = this.generation;
      void this.recoverPair(this.config)
        .then((ok) => {
          if (ok && !this.closed && generation === this.generation)
            this.startTransport();
        })
        .catch(() => {
          if (!this.closed)
            this.error = "Pairing recovery is waiting for the Runner server.";
        });
    } else if (this.config.enabled) this.startTransport();
    else await this.ensureExecutor()?.suspend();
  }
  private checkOpen() {
    if (this.closed)
      throw new RunnerError(
        "CONTROLLER_CLOSED",
        "Runner controller is closed.",
      );
  }
  private owner(ownerId: string) {
    this.checkOpen();
    if (!ownerId || typeof ownerId !== "string")
      throw new RunnerError(
        "ACCESS_DENIED",
        "A signed-in account is required.",
      );
    if (this.config && this.config.ownerId !== ownerId)
      throw new RunnerError(
        "OWNER_MISMATCH",
        "这台电脑已绑定其他轻单账号。请先在原账号解除绑定，再使用当前账号连接。",
      );
  }
  status(ownerId: string): LocalDeviceView {
    this.owner(ownerId);
    const config = this.config;
    const transport = this.transport?.status;
    return {
      paired: !!config && !config.pairingPending,
      runnerId: config?.runnerId ?? null,
      ownerId: config?.ownerId ?? null,
      deviceName: config?.deviceName ?? "",
      serverOrigin: this.serverOrigin,
      enabled: config?.enabled ?? false,
      connectionStatus: !config
        ? "unpaired"
        : config.pairingPending
          ? "error"
          : !config.enabled
            ? "offline"
            : (transport?.connectionStatus ?? "offline"),
      lastHeartbeatAt: transport?.lastHeartbeatAt ?? null,
      connectionEpoch: transport?.connectionEpoch ?? 0,
      workspaces: this.registry.list(),
      error: this.error ?? transport?.error ?? null,
      credentialStorage: "windows-credential-manager",
    };
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn, fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  private save() {
    this.checkOpen();
    if (this.config) this.store.saveConfig(this.config);
  }
  private async post(route: string, body: unknown) {
    return this.http(`${this.serverOrigin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  }
  private async recoverPair(config: DeviceConfig): Promise<boolean> {
    const generation = this.generation;
    const secret = await this.credentials.read(
      credentialTarget(this.serverOrigin, config.runnerId),
    );
    if (!secret)
      throw new RunnerError(
        "CREDENTIAL_MISSING",
        "Saved Runner credential is unavailable.",
      );
    const response = await this.post("/api/runner/token", {
      runnerId: config.runnerId,
      secret,
    });
    if (!response.ok) return false;
    const token = (await response.json()) as any;
    if (
      token.runnerId !== config.runnerId ||
      token.ownerId !== config.ownerId ||
      !Number.isSafeInteger(token.authEpoch) ||
      token.authEpoch < 1
    )
      throw new RunnerError(
        "ACCESS_DENIED",
        "Pairing recovered a different account or device.",
      );
    if (this.closed || generation !== this.generation) return false;
    config.authEpoch = token.authEpoch;
    config.pairingPending = false;
    this.config = config;
    this.error = null;
    this.save();
    return true;
  }
  private startTransport() {
    if (
      this.closed ||
      !this.config ||
      this.config.pairingPending ||
      !this.config.enabled ||
      this.transport
    )
      return;
    const config = this.config;
    const options: TransportOptions = {
      store: this.store,
      serverOrigin: this.serverOrigin,
      runnerId: config.runnerId,
      ownerId: config.ownerId,
      authEpoch: config.authEpoch,
      secret: () =>
        this.credentials.read(
          credentialTarget(this.serverOrigin, config.runnerId),
        ),
      workspaces: () => this.registry.list(),
      fetch: this.http,
      validateWorkspace: (id) => this.registry.resolve(id),
    };
    const executor = this.ensureExecutor();
    this.transport =
      this.options.transportFactory?.(options) ?? new RunnerTransport(options);
    executor?.start();
    void this.transport.start().catch(() => {
      if (!this.closed) this.error = "Unable to start Runner connection.";
    });
  }
  private ensureExecutor() {
    if (
      !this.options.executionEnabled ||
      !this.config ||
      this.config.pairingPending
    )
      return undefined;
    if (this.execution) return this.execution.executor;
    const config = this.config;
    const dir = path.join(
      this.options.stateDir,
      "execution",
      digest([config.ownerId, config.runnerId]),
    );
    const journal = new ExecutionStore(path.join(dir, "execution.sqlite"));
    let runs: RunnerStore | undefined;
    try {
      runs = new RunnerStore(path.join(dir, "adapter.sqlite"));
      this.execution = {
        journal,
        runs,
        executor: new RunnerExecutor({
          store: journal,
          runs,
          device: this.store,
          registry: this.registry,
          transport: () => {
            const t = this.transport;
            return t?.executionRequest &&
              t.acceptExecutionEnvelope &&
              t.claimLease &&
              t.releaseLease
              ? (t as ExecutionTransport)
              : undefined;
          },
          runnerId: config.runnerId,
          ownerId: config.ownerId,
          authEpoch: config.authEpoch,
          enabled: () => !this.closed && this.config?.enabled === true,
          codex: this.options.executionCodex,
        }),
      };
    } catch (error) {
      runs?.close();
      journal.close();
      throw error;
    }
    return this.execution.executor;
  }
  async executionContext(ownerId: string, workspaceId: string) {
    this.owner(ownerId);
    this.requirePaired();
    if (!this.options.executionEnabled || !this.config!.enabled)
      throw new RunnerError(
        "EXECUTION_DISABLED",
        "Runner execution is disabled.",
      );
    await this.registry.resolve(workspaceId);
    return this.ensureExecutor()!.context(workspaceId);
  }
  private async closeExecutor() {
    if (!this.execution) return;
    await this.execution.executor.close();
    this.execution.journal.close();
    this.execution.runs.close();
    this.execution = undefined;
  }
  pair(input: { ownerId: string; pairingCode: string; deviceName: string }) {
    return this.exclusive(async () => {
      this.owner(input.ownerId);
      if (
        typeof input.pairingCode !== "string" ||
        !input.pairingCode.trim() ||
        !validDeviceName(input.deviceName)
      )
        throw new RunnerError(
          "VALIDATION_ERROR",
          "Pairing code and device name are required.",
        );
      if (this.config && !this.config.pairingPending)
        throw new RunnerError("ALREADY_PAIRED", "Runner is already paired.");
      let config = this.config;
      let secret: string | null;
      if (config) {
        secret = await this.credentials.read(
          credentialTarget(this.serverOrigin, config.runnerId),
        );
        if (!secret)
          throw new RunnerError(
            "CREDENTIAL_MISSING",
            "Saved Runner credential is unavailable.",
          );
        if (await this.recoverPair(config)) {
          this.startTransport();
          return this.status(input.ownerId);
        }
        // A legacy invalid pending name can be corrected without replacing the
        // identity/credential reserved for an ambiguous successful claim.
        config.deviceName = input.deviceName.trim();
        this.save();
      } else {
        config = {
          runnerId: randomUUID(),
          ownerId: input.ownerId,
          deviceName: input.deviceName.trim(),
          serverOrigin: this.serverOrigin,
          authEpoch: 1,
          enabled: true,
          pairingPending: true,
        };
        secret = randomBytes(32).toString("base64url");
        await this.credentials.write(
          credentialTarget(this.serverOrigin, config.runnerId),
          secret,
        );
        this.checkOpen();
        this.config = config;
        this.save();
      }
      const generation = this.generation;
      try {
        const response = await this.post("/api/runner/pair", {
          pairingCode: input.pairingCode,
          runnerId: config.runnerId,
          deviceName: config.deviceName,
          secretHash: createHash("sha256").update(secret).digest("hex"),
          expectedOwnerId: config.ownerId,
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as any;
          throw new RunnerError(
            typeof error.code === "string" ? error.code : "PAIRING_FAILED",
            "Pairing code could not be accepted.",
          );
        }
        const result = (await response.json()) as any;
        if (
          result.runnerId !== config.runnerId ||
          result.ownerId !== config.ownerId ||
          !Number.isSafeInteger(result.authEpoch) ||
          result.authEpoch < 1
        )
          throw new RunnerError(
            "ACCESS_DENIED",
            "Pairing response does not match this device and account.",
          );
        if (this.closed || generation !== this.generation)
          throw new RunnerError(
            "CONTROLLER_CLOSED",
            "Runner controller closed during pairing.",
          );
        config.authEpoch = result.authEpoch;
        config.pairingPending = false;
        this.save();
      } catch (error) {
        if (this.closed) throw error;
        let recovered = false;
        try {
          recovered = await this.recoverPair(config);
        } catch {
          /* Retain pending identity and credential for an explicit retry. */
        }
        if (!recovered) {
          this.error = "Pairing is pending; retry with this device identity.";
          throw error instanceof RunnerError
            ? error
            : new RunnerError(
                "PAIRING_PENDING",
                "Pairing response is uncertain; retry to recover the saved device.",
              );
        }
      }
      this.error = null;
      this.startTransport();
      return this.status(input.ownerId);
    });
  }
  registerWorkspace(ownerId: string, input: { root: string; name?: string }) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      this.requirePaired();
      await this.registry.register(input);
      await this.transport?.updateWorkspaces();
      return this.status(ownerId);
    });
  }
  async listCodexSessions(ownerId: string, query: SessionQuery) {
    this.owner(ownerId);
    const generation = this.generation;
    const result = await listCodexSessions(
      {
        command: process.env.QINGDAN_CODEX_BIN || "codex",
        ...this.options.executionCodex,
      },
      query,
    );
    this.owner(ownerId);
    if (generation !== this.generation)
      throw new RunnerError(
        "ACCESS_DENIED",
        "电脑连接已变化，请重新读取会话。",
      );
    return result;
  }
  selectCodexSession(ownerId: string, threadId: string) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      this.requirePaired();
      const generation = this.generation;
      const session = await readCodexSession(
        {
          command: process.env.QINGDAN_CODEX_BIN || "codex",
          ...this.options.executionCodex,
        },
        threadId,
      );
      this.owner(ownerId);
      if (generation !== this.generation)
        throw new RunnerError(
          "ACCESS_DENIED",
          "电脑连接已变化，请重新选择会话。",
        );
      const workspace = await this.registry.register({
        root: session.cwd,
        name: session.projectName.slice(0, WORKSPACE_NAME_MAX),
      });
      await this.transport?.updateWorkspaces();
      this.owner(ownerId);
      return { runnerId: this.config!.runnerId, workspace, session };
    });
  }
  removeWorkspace(ownerId: string, workspaceId: string) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      this.requirePaired();
      const previous = this.store.workspace(workspaceId);
      await this.registry.remove(workspaceId);
      try {
        await this.transport?.updateWorkspaces();
      } catch (error) {
        if (previous)
          this.store.saveWorkspace(
            previous,
            process.platform === "win32"
              ? previous.root.toLowerCase()
              : previous.root,
          );
        throw error;
      }
      return this.status(ownerId);
    });
  }
  setEnabled(ownerId: string, enabled: boolean) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      this.requirePaired();
      if (typeof enabled !== "boolean")
        throw new RunnerError("VALIDATION_ERROR", "Enabled must be boolean.");
      this.config!.enabled = enabled;
      this.save();
      if (enabled) this.startTransport();
      else {
        await this.execution?.executor.suspend();
        this.transport?.close();
        this.transport = undefined;
      }
      return this.status(ownerId);
    });
  }
  reconnect(ownerId: string) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      this.requirePaired();
      if (this.config!.enabled) {
        if (this.transport) this.transport.reconnect();
        else this.startTransport();
      }
      return this.status(ownerId);
    });
  }
  forget(ownerId: string) {
    return this.exclusive(async () => {
      this.owner(ownerId);
      if (!this.config) return this.status(ownerId);
      if (this.store.leases().length || this.execution?.executor.hasHold)
        throw new RunnerError(
          "WORKSPACE_BUSY",
          "Confirm all local runs are stopped before forgetting this device.",
        );
      const config = this.config;
      const target = credentialTarget(this.serverOrigin, config.runnerId);
      const secret = await this.credentials.read(target);
      if (!secret)
        throw new RunnerError(
          "CREDENTIAL_MISSING",
          "Cannot verify remote revocation without the saved credential.",
        );
      const response = await this.post("/api/runner/token", {
        runnerId: config.runnerId,
        secret,
      });
      if (response.status !== 401 && response.status !== 403)
        throw new RunnerError(
          "REVOCATION_REQUIRED",
          "Device must be remotely revoked before forgetting its credential.",
        );
      await this.closeExecutor();
      this.transport?.close();
      this.transport = undefined;
      await this.credentials.delete(target);
      this.checkOpen();
      this.store.clear();
      this.config = null;
      this.error = null;
      return this.status(ownerId);
    });
  }
  private requirePaired() {
    if (!this.config || this.config.pairingPending)
      throw new RunnerError("NOT_PAIRED", "Pair this Runner first.");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    await this.queue;
    await this.closeExecutor();
    this.transport?.close();
    this.transport = undefined;
    this.store.close();
  }
}
