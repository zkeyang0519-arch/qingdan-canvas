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
  type RunnerClock,
} from "./transport";
import { withDeviceResetSafety } from "./device-reset-safety";
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
  clock?: RunnerClock;
};
export type DeviceResetTarget = Pick<
  DeviceConfig,
  "runnerId" | "ownerId" | "serverOrigin" | "authEpoch"
>;
export type RevocationEvidence = DeviceResetTarget & { status: "revoked" };
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
  private lifecycle = new AbortController();
  private pendingTimer: any;
  private pendingAttempt = 0;
  private clock: RunnerClock;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly serverOrigin: string;
  constructor(private options: DeviceControllerOptions) {
    this.serverOrigin = validateServerOrigin(options.serverOrigin);
    this.credentials = options.credentials ?? new WindowsCredentialManager();
    this.http = options.fetch ?? fetch;
    this.clock = options.clock ?? {
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
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
      void this.exclusive(() => this.recoverPending(generation)).catch(
        () => {},
      );
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
  private invalidateIdentity() {
    ++this.generation;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.clock.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingAttempt = 0;
    return this.generation;
  }
  private assertIdentity(config: DeviceConfig, generation: number) {
    this.checkOpen();
    if (
      generation !== this.generation ||
      this.config?.runnerId !== config.runnerId ||
      this.config.ownerId !== config.ownerId
    )
      throw new RunnerError(
        "CONNECTION_CHANGED",
        "电脑连接已变化，请重新核对。",
      );
  }
  private schedulePending(generation: number) {
    if (
      this.closed ||
      generation !== this.generation ||
      !this.config?.pairingPending ||
      this.pendingTimer !== undefined
    )
      return;
    const delay = Math.min(
      30000,
      1000 * 2 ** Math.min(this.pendingAttempt++, 5),
    );
    // Keep an independent pending controller alive until recovery or close.
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = undefined;
      void this.exclusive(() => this.recoverPending(generation)).catch(
        () => {},
      );
    }, delay);
  }
  private async recoverPending(generation: number) {
    if (
      this.closed ||
      generation !== this.generation ||
      !this.config?.pairingPending
    )
      return;
    try {
      if (await this.recoverPair({ ...this.config }, generation))
        this.startTransport();
      else this.error = "配对尚未完成，请重新连接或重试配对。";
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const code = (error as { code?: string }).code;
      this.error =
        code === "CREDENTIAL_MISSING"
          ? "设备凭据已丢失，请撤销旧设备后核对并重置本机绑定。"
          : "配对恢复正在等待设备服务，请稍后重试。";
      if (!["CREDENTIAL_MISSING", "ACCESS_DENIED"].includes(code ?? ""))
        this.schedulePending(generation);
    }
  }
  private async post(route: string, body: unknown) {
    const signal = AbortSignal.any([
      this.lifecycle.signal,
      AbortSignal.timeout(10000),
    ]);
    const request = this.http(`${this.serverOrigin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    let abort!: () => void;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new RunnerError("CONNECTION_CHANGED", "设备请求已取消或超时。"),
            );
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async recoverPair(
    config: DeviceConfig,
    generation = this.generation,
  ): Promise<boolean> {
    const secret = await this.credentials.read(
      credentialTarget(this.serverOrigin, config.runnerId),
    );
    this.assertIdentity(config, generation);
    if (!secret)
      throw new RunnerError(
        "CREDENTIAL_MISSING",
        "Saved Runner credential is unavailable.",
      );
    const response = await this.post("/api/runner/token", {
      runnerId: config.runnerId,
      secret,
    });
    this.assertIdentity(config, generation);
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok)
      throw new RunnerError("PAIRING_UNAVAILABLE", "配对服务暂时不可用。");
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
    this.assertIdentity(config, generation);
    this.config = {
      ...config,
      authEpoch: token.authEpoch,
      pairingPending: false,
    };
    this.clock.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingAttempt = 0;
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
    const transport = this.transport;
    executor?.start();
    void transport.start().catch(() => {
      if (
        !this.closed &&
        this.transport === transport &&
        this.config?.runnerId === config.runnerId &&
        this.config.ownerId === config.ownerId
      )
        this.error = "Unable to start Runner connection.";
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
  async pair(input: {
    ownerId: string;
    pairingCode: string;
    deviceName: string;
  }) {
    this.owner(input.ownerId);
    const generation = this.invalidateIdentity();
    return this.exclusive(async () => {
      this.owner(input.ownerId);
      if (generation !== this.generation)
        throw new RunnerError("CONNECTION_CHANGED", "设备配对请求已失效。");
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
        try {
          if (await this.recoverPair({ ...config }, generation)) {
            this.startTransport();
            return this.status(input.ownerId);
          }
        } catch (error) {
          if (
            !this.closed &&
            generation === this.generation &&
            !["CREDENTIAL_MISSING", "ACCESS_DENIED"].includes(
              (error as { code?: string }).code ?? "",
            )
          ) {
            this.error = "配对恢复正在等待设备服务，请稍后重试。";
            this.schedulePending(generation);
          }
          throw error;
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
        if (generation !== this.generation)
          throw new RunnerError("CONNECTION_CHANGED", "设备配对请求已失效。");
        this.config = config;
        this.save();
      }
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
            response.status >= 500 || response.status === 429
              ? "PAIRING_UNAVAILABLE"
              : typeof error.code === "string"
                ? error.code
                : "PAIRING_FAILED",
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
        if (this.closed || generation !== this.generation) throw error;
        let recovered = false;
        let retry = (error as { code?: string }).code === "PAIRING_UNAVAILABLE";
        try {
          recovered = await this.recoverPair({ ...config }, generation);
        } catch (recoveryError) {
          retry = !["CREDENTIAL_MISSING", "ACCESS_DENIED"].includes(
            (recoveryError as { code?: string }).code ?? "",
          );
        }
        if (!recovered) {
          if (this.closed || generation !== this.generation) throw error;
          this.error = "Pairing is pending; retry with this device identity.";
          if (retry) this.schedulePending(generation);
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
  async reconnect(ownerId: string) {
    this.owner(ownerId);
    const generation = this.config?.pairingPending
      ? this.invalidateIdentity()
      : this.generation;
    return this.exclusive(async () => {
      this.owner(ownerId);
      if (generation !== this.generation)
        throw new RunnerError("CONNECTION_CHANGED", "设备连接已变化。");
      if (this.config?.pairingPending) {
        await this.recoverPending(generation);
        return this.status(ownerId);
      }
      this.requirePaired();
      if (this.config!.enabled) {
        if (this.transport) this.transport.reconnect();
        else this.startTransport();
        this.execution?.executor.requestReconciliation();
      }
      return this.status(ownerId);
    });
  }
  async forget(
    ownerId: string,
    authorized?: {
      expectedRunnerId: string;
      revokeAndVerify: (
        target: DeviceResetTarget,
      ) => Promise<RevocationEvidence>;
    },
  ) {
    // Only an explicitly targeted, session-authorized caller may revoke remotely.
    // The legacy call still verifies an already-revoked device with its secret.
    if (authorized)
      return this.reset(
        ownerId,
        authorized.expectedRunnerId,
        authorized.revokeAndVerify,
      );
    this.owner(ownerId);
    const generation = this.invalidateIdentity();
    return this.exclusive(async () => {
      this.owner(ownerId);
      if (!this.config) return this.status(ownerId);
      if (this.store.leases().length || this.execution?.executor.hasHold)
        throw new RunnerError(
          "WORKSPACE_BUSY",
          "Confirm all local runs are stopped before forgetting this device.",
        );
      const config = this.config;
      this.assertIdentity(config, generation);
      await this.withResetSafety(config, async (check) => {
        const target = credentialTarget(this.serverOrigin, config.runnerId);
        const secret = await this.credentials.read(target);
        this.assertIdentity(config, generation);
        if (!secret)
          throw new RunnerError(
            "CREDENTIAL_MISSING",
            "Cannot verify remote revocation without the saved credential.",
          );
        const response = await this.post("/api/runner/token", {
          runnerId: config.runnerId,
          secret,
        });
        this.assertIdentity(config, generation);
        if (response.status !== 401 && response.status !== 403)
          throw new RunnerError(
            "REVOCATION_REQUIRED",
            "Device must be remotely revoked before forgetting its credential.",
          );
        await check();
        this.assertIdentity(config, generation);
        this.transport?.close();
        this.transport = undefined;
        await this.credentials.delete(target);
        this.assertIdentity(config, generation);
        await check();
        this.assertIdentity(config, generation);
        this.store.clear();
        this.config = null;
        this.error = null;
      });
      await this.closeExecutor();
      return this.status(ownerId);
    });
  }
  private withResetSafety<T>(
    config: DeviceConfig,
    work: (check: () => Promise<void>) => Promise<T>,
  ) {
    const guarded = () =>
      withDeviceResetSafety(
        {
          executionDir: path.join(
            this.options.stateDir,
            "execution",
            digest([config.ownerId, config.runnerId]),
          ),
          device: this.store,
          registry: this.registry,
          consumerOwned: !!this.execution,
        },
        work,
      );
    return this.execution
      ? this.execution.executor.withDeviceResetGuard(guarded)
      : guarded();
  }
  async reset(
    ownerId: string,
    expectedRunnerId: string,
    verifyRevocation: (
      target: DeviceResetTarget,
    ) => Promise<RevocationEvidence>,
  ) {
    this.owner(ownerId);
    if (!expectedRunnerId || typeof expectedRunnerId !== "string")
      throw new RunnerError("VALIDATION_ERROR", "缺少原设备身份。");
    if (this.config && this.config.runnerId !== expectedRunnerId)
      throw new RunnerError("STALE_DEVICE", "电脑已重新绑定，请刷新后重试。");
    // A completed receipt is read-only. Replaying it must not cancel a new
    // pairing that is still writing its credential before saving its config.
    const generation = this.config
      ? this.invalidateIdentity()
      : this.generation;
    return this.exclusive(async () => {
      this.owner(ownerId);
      if (!this.config) {
        const receipt = this.store.resetReceipt();
        if (receipt?.ownerId !== ownerId)
          throw new RunnerError("OWNER_MISMATCH", "重置回执不属于当前账号。");
        if (
          receipt.runnerId !== expectedRunnerId ||
          receipt.serverOrigin !== this.serverOrigin
        )
          throw new RunnerError("STALE_DEVICE", "找不到对应的本机重置回执。");
        return this.status(ownerId);
      }
      const config = { ...this.config };
      if (config.runnerId !== expectedRunnerId)
        throw new RunnerError("STALE_DEVICE", "电脑已重新绑定，请刷新后重试。");
      this.assertIdentity(config, generation);
      await this.withResetSafety(config, async (check) => {
        const evidence = await verifyRevocation({
          runnerId: config.runnerId,
          ownerId,
          serverOrigin: this.serverOrigin,
          authEpoch: config.authEpoch,
        });
        this.assertIdentity(config, generation);
        if (
          !evidence ||
          evidence.runnerId !== config.runnerId ||
          evidence.ownerId !== ownerId ||
          evidence.serverOrigin !== this.serverOrigin ||
          evidence.status !== "revoked" ||
          !Number.isSafeInteger(evidence.authEpoch) ||
          evidence.authEpoch <= config.authEpoch
        )
          throw new RunnerError(
            "REVOCATION_REQUIRED",
            "尚未核实当前账号已撤销原设备，请联网核对后重试。",
          );
        await check();
        this.assertIdentity(config, generation);
        this.transport?.close();
        this.transport = undefined;
        await this.credentials.delete(
          credentialTarget(this.serverOrigin, config.runnerId),
        );
        this.assertIdentity(config, generation);
        await check();
        this.assertIdentity(config, generation);
        this.store.clearForReset(config, {
          ownerId,
          runnerId: config.runnerId,
          serverOrigin: this.serverOrigin,
          revokedAuthEpoch: evidence.authEpoch,
          completedAt: new Date(this.clock.now()).toISOString(),
        });
        this.config = null;
        this.error = null;
      });
      await this.closeExecutor();
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
    this.invalidateIdentity();
    await this.queue;
    await this.closeExecutor();
    this.transport?.close();
    this.transport = undefined;
    this.store.close();
  }
}
