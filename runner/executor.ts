import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  CommandEnvelope,
  ExecutionSnapshot,
  RunnerEvent,
} from "../shared/agent/contracts";
import {
  commandEnvelopeSchema,
  executionSnapshotSchema,
} from "../shared/agent/schemas";
import { projectContextSchema, nativeStopProofSchema, type NativeStopProof, type ExecutionReconcileTicket } from "../shared/agent/execution";
import {
  CodexAdapter,
  parseApprovalsReviewer,
  type AdapterOptions,
  type NativeOperationGuard,
} from "./codex-adapter";
import type { DeviceStore } from "./device-store";
import { RunnerError } from "./errors";
import {
  ExecutionStore,
  sameExecutionClaim,
  type HeldRun,
  type JournalEntry,
  type NativeAck,
  type NativeReport,
  type NativeReconciliation,
} from "./execution-store";
import { digest, RunnerStore } from "./store";
import type { RunnerTransport } from "./transport";
import type { RunRecord } from "./types";
import { readGitBaseline, rootKey } from "./workspace";
import { WorkspaceRegistry } from "./workspaces";
import { verifyAcceptance } from "./verification";
import { currentSnapshot } from "./batch";
import { requestResponseSchema } from "../shared/agent/permissions";

export type ExecutionTransport = Pick<
  RunnerTransport,
  | "status"
  | "executionRequest"
  | "acceptExecutionEnvelope"
  | "claimLease"
  | "releaseLease"
>;
type Options = {
  store: ExecutionStore;
  runs: RunnerStore;
  device: DeviceStore;
  registry: WorkspaceRegistry;
  transport: () => ExecutionTransport | undefined;
  runnerId: string;
  ownerId: string;
  authEpoch: number;
  codex?: Omit<AdapterOptions, "runnerId" | "store" | "workspaces">;
  enabled?: () => boolean;
  now?: () => number;
};
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x20\x7f]+$/);
const pollResult = z
  .strictObject({
    offers: z.array(z.strictObject({ runId: id, workspaceId: id })).max(1),
    deliveries: z
      .array(z.strictObject({ envelope: z.unknown(), snapshot: z.unknown() }))
      .max(1),
  })
  .refine((v) => v.offers.length + v.deliveries.length <= 1);
const result = z.strictObject({
  ok: z.literal(true),
  ignored: z.literal(true).optional(),
  superseded: z.literal(true).optional(),
  settled: z.literal(true).optional(),
});
const eventResult = z.strictObject({ eventIds: z.array(id).max(50) });
const responsesResult = z.strictObject({
  responses: z
    .array(
      z.strictObject({
        responseId: id,
        pendingRequestId: id,
        runId: id,
        threadId: id,
        turnId: id,
        response: requestResponseSchema,
      }),
    )
    .max(20),
});
const batchGateResult = z.strictObject({
  decision: z.enum(["wait", "advance", "finish", "repair", "blocked"]),
  queueRevision: z.number().int().min(1),
  permitId: id.optional(),
  nextIndex: z.number().int().min(0).max(99).optional(),
  reason: z.string().max(2000).optional(),
});
const leaseRecoveryResult = z.discriminatedUnion("decision",[
  z.strictObject({decision:z.literal("wait")}),
  z.strictObject({decision:z.literal("cancel")}),
  z.strictObject({decision:z.literal("inspect"),recoveryId:id}),
  z.strictObject({decision:z.literal("recovered"),recoveryId:id,lease:z.strictObject({workspaceId:id,runId:id,leaseEpoch:z.number().int().positive(),expiresAt:z.number().int().positive()})}),
]);
const reconcileIdentity = { runId: id, workspaceId: id, leaseEpoch: z.number().int().positive() };
const reconcileResult = z.union([
  z.strictObject({ decision: z.literal("inspect"), ticket: z.strictObject({
    ...reconcileIdentity, recoveryId: id, originalCommandId: id, currentCommandId: id,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), reportRevision: z.number().int().nonnegative(),
    threadId: id.nullable(), turnId: id.nullable(), action: z.enum(["inspect_only", "stop"]),
  }) }),
  z.strictObject({ decision: z.literal("settled"), ...reconcileIdentity }),
  z.strictObject({ ok: z.literal(true), settled: z.literal(true), ...reconcileIdentity,
    recoveryId: id, reportRevision: z.number().int().positive() }),
]);
// Only these pre-recovery versions' safety-stop messages may migrate their
// nonterminal checkpoint. User cancellation and lifecycle stop remain final.
const legacyCheckpointStop = new Set(["批次后续待办的执行授权已失效。","运行租约已过期。"]);
const errorCode = (error: unknown) => (error as { code?: string })?.code;
const denied = (error: unknown) =>
  ["EXECUTION_REVOKED", "EXECUTION_DISABLED"].includes(errorCode(error) ?? "");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const shorten = (value: string, max: number) => value.slice(0, max);

// Keep the event identity/sequence and terminal facts intact even if Codex
// produced a larger display payload than the server can accept.
function wireEvent(event: RunnerEvent): RunnerEvent {
  if (bytes(event) <= 110_000) return event;
  switch (event.type) {
    case "output.delta":
      return {
        ...event,
        payload: {
          text: shorten(event.payload.text, 16_000) + "\n[output truncated]",
        },
      };
    case "input.requested":
      return {
        ...event,
        payload: {
          ...event.payload,
          questions: event.payload.questions.map(({ id, prompt }) => ({
            id,
            prompt: shorten(prompt, 650) + "…",
          })),
        },
      };
    case "turn.completed":
      return {
        ...event,
        payload: { ...event.payload, summary: null, outcome: null },
      };
    default:
      return event;
  }
}
const terminal = (run?: RunRecord | null) => !!run?.terminal && !run.active;

/** Single device consumer. A persisted dispatch marker fences every Codex mutation. */
export class RunnerExecutor {
  private now: () => number;
  private adapter?: CodexAdapter;
  private connecting?: Promise<CodexAdapter>;
  private attached = new Set<string>();
  private working?: Promise<void>;
  private reconciling?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private paused = false;
  private deviceResetGuard = false;
  private closed = false;
  private lastAuthCheck?: { at: number; epoch: number; commandId: string };
  private capturedAt = 0;
  private contextQueue: Promise<unknown> = Promise.resolve();
  private releaseConsumer: () => void;
  private interruptAttempts = new Map<string, { key: string; adapter: CodexAdapter }>();

  constructor(private o: Options) {
    this.now = o.now ?? Date.now;
    this.releaseConsumer = o.store.acquireConsumer();
  }
  private get disabled() {
    return this.deviceResetGuard || this.paused || this.closed || this.o.enabled?.() === false;
  }
  start() {
    if (this.closed || this.deviceResetGuard) return;
    this.paused = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 750);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.closed || this.deviceResetGuard) return Promise.resolve();
    if (this.working) return this.working;
    this.working = this.step()
      .catch(() => {
        // Transient operations leave their exact durable stage for the next tick.
      })
      .finally(() => {
        this.working = undefined;
      });
    return this.working;
  }
  requestReconciliation() {
    if (this.deviceResetGuard) return;
    const held = this.boundHold();
    if (!held || held.phase !== "claimed" || this.closed) return;
    // User reconnect may return before the socket comes online. Keep the
    // intent durable and fence late sends until the consumer handles it.
    this.o.store.requestReconciliation(held);
    void this.tick();
  }
  async withDeviceResetGuard<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.deviceResetGuard)
      throw new RunnerError("EXECUTOR_BUSY", "设备运行器正在关闭或核对重置。");
    // Reject existing occupancy without stopping it as a side effect of reset.
    if (this.hasHold) throw new RunnerError("WORKSPACE_BUSY", "请先停止并核对本地运行。");
    const resume = this.timer !== undefined;
    this.deviceResetGuard = true;
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.working;
      await this.reconciling;
      await this.contextQueue;
      if (this.closed || this.hasHold)
        throw new RunnerError("WORKSPACE_BUSY", "本地执行状态已变化，不能重置设备。");
      return await work();
    } finally {
      this.deviceResetGuard = false;
      if (resume && !this.closed && this.o.enabled?.() !== false) this.start();
    }
  }
  async suspend() {
    this.paused = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.working;
    const held = this.o.store.held();
    if (held) {
      await this.stop(held, "运行器已暂停。").catch(() => {});
      await this.sync(held, this.o.transport()).catch(() => {});
    }
  }
  async close(options?: { stop?: boolean }) {
    if (this.closed) return;
    if (options?.stop !== false) await this.suspend();
    this.closed = true;
    clearInterval(this.timer);
    await this.working;
    await this.reconciling;
    await this.contextQueue;
    try {
      await this.adapter?.close({ stopRuns: false });
    } finally {
      this.releaseConsumer();
    }
  }
  get hasHold() {
    return !!this.o.store.held();
  }
  private get online() {
    const t = this.o.transport();
    return t?.status.connectionStatus === "online" ? t : undefined;
  }
  private boundHold() {
    const held = this.o.store.held(), lease = held && this.o.device.lease(held.runId);
    return held && !held.leaseEpoch && lease?.workspaceId === held.workspaceId
      ? this.o.store.bindClaim(held, lease.leaseEpoch) : held;
  }
  private captureNativeGuard(runId: string): NativeOperationGuard {
    const held = this.boundHold(), entry = this.o.store.latest(runId);
    if (!held || held.runId !== runId)
      throw new RunnerError("LEASE_MISMATCH", "原生操作没有对应的本机占用。");
    return this.nativeGuard(held, entry?.envelope.commandId);
  }
  private nativeGuard(held: HeldRun, commandId?: string): NativeOperationGuard {
    // This immutable closure belongs to this operation, not whatever held or
    // latest command a delayed RPC happens to find when its reply arrives.
    const claim = { ...held }, transport = this.online, epoch = transport?.status.connectionEpoch;
    const assertCurrent = () => this.assertHeldCurrent(claim, commandId);
    return {
      assertCurrent,
      assertDispatch: () => {
        if (!commandId) throw new RunnerError("COMMAND_SEALED", "缺少原派单记录。");
        assertCurrent();
        if (!transport || this.online !== transport || transport.status.connectionEpoch !== epoch)
          throw new RunnerError("CONNECTION_LOST", "原派发连接已改变。");
        if (this.disabled || !this.liveLease(claim, this.o.store.command(commandId)?.envelope))
          throw new RunnerError("DISPATCH_EXPIRED", "原执行租约已失效。");
        this.o.store.assertDispatchAllowed(claim, commandId);
      },
      canStop: () => {
        assertCurrent();
        const recovery = this.o.store.reconciliation(claim);
        return !recovery || recovery.ticket?.action === "stop";
      },
    };
  }
  private assertHeldCurrent(held: HeldRun, commandId?: string) {
    this.o.store.assertClaimCurrent(held, commandId);
    const lease = this.o.device.lease(held.runId);
    if (lease && (lease.workspaceId !== held.workspaceId || lease.leaseEpoch !== held.leaseEpoch))
      throw new RunnerError("LEASE_MISMATCH", "原执行租约已改变。");
  }
  private async codex(workspaceId: string) {
    const workspace = await this.o.registry.resolve(workspaceId);
    if (!this.adapter?.available) {
      if (!this.connecting) {
        const previous = this.adapter;
        this.attached.clear();
        const adapter = new CodexAdapter({
          command: process.env.QINGDAN_CODEX_BIN || "codex",
          requestTimeoutMs: 8000,
          ...this.o.codex,
          approvalsReviewer: parseApprovalsReviewer(
            this.o.codex?.approvalsReviewer ??
              process.env.QINGDAN_CODEX_APPROVALS_REVIEWER,
          ),
          runnerId: this.o.runnerId,
          store: this.o.runs,
          workspaces: [],
          captureGuard: runId => this.captureNativeGuard(runId),
        });
        this.connecting = (async () => {
          await previous?.close({ stopRuns: false, waitDesktop: false });
          await adapter.connect();
          this.adapter = adapter;
          return adapter;
        })().finally(() => {
          this.connecting = undefined;
        });
      }
      await this.connecting;
    }
    await this.adapter!.attachWorkspace(workspaceId, workspace.root);
    return this.adapter!;
  }
  context(workspaceId: string) {
    const op = this.contextQueue.then(async () => {
      const t = this.online;
      if (!t || this.disabled)
        throw new RunnerError("RUNNER_OFFLINE", "Runner is offline.");
      await this.o.registry.resolve(workspaceId, true);
      const adapter = await this.codex(workspaceId);
      const [{ root, threads }] = await adapter.listProjects({
        workspaceId,
        limit: 30,
      });
      const baseline = await readGitBaseline(root);
      await this.o.registry.resolve(workspaceId);
      const capturedAt = (this.capturedAt = Math.max(
        this.now(),
        this.capturedAt + 1,
      ));
      const context = projectContextSchema.parse({
        workspaceId,
        capturedAt: new Date(capturedAt).toISOString(),
        gitBaseline: baseline,
        threads: threads.slice(0, 30).flatMap((thread) => {
          const updatedAt = new Date(thread.updatedAt * 1000);
          return id.safeParse(thread.threadId).success &&
            Number.isFinite(updatedAt.valueOf())
            ? [
                {
                  threadId: thread.threadId,
                  title: thread.title.slice(0, 200),
                  updatedAt: updatedAt.toISOString(),
                },
              ]
            : [];
        }),
      });
      if (this.online !== t || this.disabled)
        throw new RunnerError("RUNNER_OFFLINE", "Runner is offline.");
      result.parse(
        await t.executionRequest("context", { contexts: [context] }),
      );
      return context;
    });
    this.contextQueue = op.catch(() => {});
    return op;
  }
  private async poll(t: ExecutionTransport) {
    return pollResult.parse(await t.executionRequest("poll", {}));
  }
  private async step() {
    let held = this.boundHold();
    const t = this.online;
    this.adapter?.expireRequests();
    if (t) await this.flushInteractionAcks(t).catch(() => {});
    if (held?.phase === "releasing" || held?.phase === "local_release") {
      await this.release(held, t);
      return;
    }
    if (held?.phase === "claimed") {
      const active = this.o.runs.getRun(held.runId);
      const entry = this.o.store.latest(held.runId);
      if (this.o.store.reconciliation(held)) {
        await this.reconcileHeldRun();
        return;
      }
      if (t && this.o.store.reconciliationRequested(held)) {
        // Reconnect must first retry ordinary reports, preserving successful
        // completion/acceptance. Only a still-unsettled run needs retirement.
        if (await this.sync(held, t)) return;
        const state = this.o.store.run(held.runId);
        if (active?.status === "reconciliation_required" && active.threadId && active.activeTurnId &&
            !active.pendingRequestId && !active.cancelRequested && this.liveLease(held) && !this.recoverableCheckpoint(active)) {
          const adapter = this.adapter?.available ? this.adapter : await this.codex(held.workspaceId);
          const observed = await adapter.identifyRunTurn(held.runId).catch(() => undefined);
          if (observed && ["completed", "failed", "interrupted"].includes(observed.status)) {
            // A failed normal completion may still be retrying P1 terminal
            // cleanup. Do not seal that authorized retry into inspect_only.
            await this.recover(held).catch(() => {});
            if (await this.sync(held, t)) return;
            const current = this.o.store.run(held.runId);
            if (terminal(this.o.runs.getRun(held.runId)) && current?.report?.stopConfirmed && current.reportSent && !current.reportSettled)
              await this.reconcileHeldRun();
            else this.o.store.clearReconciliationRequest(held);
            return;
          }
        }
        if (!this.recoverableCheckpoint(active) &&
            (!entry || active?.status === "reconciliation_required" || active?.cancelRequested ||
              (terminal(active) && state?.report?.stopConfirmed && state.reportSent && !state.reportSettled))) {
          await this.reconcileHeldRun();
          return;
        }
        this.o.store.clearReconciliationRequest(held);
      }
      if (!active?.activeTurnId && !active?.pendingRequestId &&
          ((!entry && !this.liveLease(held)) ||
           (entry && (Date.parse(entry.envelope.expiresAt) <= this.now() || ["uncertain", "superseded"].includes(entry.phase))))) {
        // An ordinary terminal report may still settle normally. Preserve that
        // outcome, and publish a pending uncertainty report before inspecting.
        if (await this.sync(held, t)) return;
        await this.reconcileHeldRun();
        return;
      }
      const status = this.o.transport()?.status.connectionStatus;
      if(entry?.phase==="applied"&&this.recoverableCheckpoint(active)&&!this.disabled&&status!=="revoked"&&(!this.liveLease(held)||active!.cancelRequested)) {
        if(active!.cancelRequested&&legacyCheckpointStop.has(active!.resultError??""))
          this.o.store.markCheckpointRecovery(held.runId,entry.envelope.commandId,active!.activeTurnId!);
        if(!active!.cancelRequested)this.o.runs.patchRun(held.runId,{status:"reconciliation_required",resultError:"暂停点租约已过期，请核对并恢复连接。"});
        if(t)await this.recoverCheckpoint(held,t,entry).catch(()=>{});
        await this.sync(held,t).catch(()=>{});
        return;
      }
      if (active && !terminal(active)) {
        const intent=this.o.store.stopIntent(held.runId);
        let stopReason =
          intent&&intent.commandId===(entry?.envelope.commandId??null)
            ? intent.reason
            : this.disabled || status === "revoked"
            ? "设备执行已停用。"
            : undefined;
        if (!stopReason&&!this.liveLease(held)) stopReason = "运行租约已过期。";
        if (
          !stopReason&&entry?.startedAt &&
          !(
            active.snapshot.kind === "task" &&
            active.snapshot.batch?.managed &&
            active.batchPhase === "ready"
          ) &&
          this.now() >=
            entry.startedAt +
              (entry.snapshot.kind === "summary" ? 5 : 30) * 60_000
        )
          stopReason = "运行超过时间上限。";
        try {
          await this.o.registry.resolve(held.workspaceId);
          await this.o.registry.assertLock(
            held.workspaceId,
            held.runId,
            held.lockToken,
          );
        } catch {
          stopReason ??= "本地项目目录已变化。";
        }
        if (
          t &&
          entry &&
          !stopReason &&
          (this.lastAuthCheck?.commandId !== entry.envelope.commandId ||
            this.lastAuthCheck.epoch !== t.status.connectionEpoch ||
            this.now() - this.lastAuthCheck.at >= 3000)
        ) {
          this.lastAuthCheck = {
            at: this.now(),
            epoch: t.status.connectionEpoch,
            commandId: entry.envelope.commandId,
          };
          try {
            await this.sendAck(
              t,
              entry.ack ?? {
                commandId: entry.envelope.commandId,
                status: "stored",
              },
            );
          } catch (error) {
            if (denied(error)) stopReason = "执行授权已失效。";
          }
        }
        if (stopReason) await this.stop(held, stopReason).catch(() => {});
        else await this.recover(held).catch(() => {});
      }
      if (
        entry?.phase === "dispatching" ||
        (entry?.phase === "uncertain" &&
          this.o.runs.getRun(held.runId)?.batch &&
          this.confirmedDispatch(entry))
      )
        this.finishInterruptedDispatch(entry);
      if (
        await this.sync(held, t).catch(async (error) => {
          if (denied(error))
            await this.stop(held!, "执行授权已失效。").catch(() => {});
          return false;
        })
      )
        return;
    }
    if (!t || this.disabled) return;

    // Poll before a staged mutation, including after restart, so a replacement
    // cancellation can take precedence.
    let response;
    try {
      response = await this.poll(t);
    } catch (error) {
      if (held && denied(error))
        await this.stop(held, "执行授权已失效。").catch(() => {});
      return;
    }
    if (!held) {
      const offer = response.offers[0];
      if (!offer || this.o.device.leases().length) {
        await this.flushEvents(t).catch(() => {});
        return;
      }
      held = this.o.store.reserve(offer.runId, offer.workspaceId) ?? undefined;
      if (!held) return;
    }
    if (held.phase === "reserving") {
      try {
        await this.o.registry.acquire(
          held.workspaceId,
          held.runId,
          held.lockToken,
        );
      } catch (error) {
        if (
          ["WORKSPACE_BUSY", "ACCESS_DENIED", "WORKSPACE_CHANGED"].includes(
            errorCode(error) ?? "",
          )
        )
          this.o.store.clearHold(held);
        throw error;
      }
      held = this.o.store.updateHold(held, "locked") ?? undefined;
      if (!held) return;
    }
    if (held.phase === "locked") {
      if (this.disabled || this.online !== t) return;
      if (!this.o.device.lease(held.runId))
        await t.claimLease(held.workspaceId, held.runId, {
          recoverExpired: true,
        });
      held = this.o.store.updateHold(held, "claimed") ?? undefined;
      if (!held) return;
      held = this.o.store.bindClaim(held, this.o.device.lease(held.runId)!.leaseEpoch);
      response = await this.poll(t);
    }
    const delivery = response.deliveries[0];
    if (delivery)
      await this.accept(held, t, delivery.envelope, delivery.snapshot);
    const entry = this.o.store.latest(held.runId);
    const lease = this.o.device.lease(held.runId);
    if (entry?.phase === "staged") await this.dispatch(held, t, entry);
    else if (
      entry?.phase === "applied" &&
      this.o.runs.getRun(held.runId)?.batchPhase === "ready"
    ) {
      try {
        await this.gate(held, t, entry, true);
        const adapter = await this.codex(held.workspaceId);
        const run = this.o.runs.getRun(held.runId)!;
        if (run.snapshot.kind === "task" && run.snapshot.batch?.managed)
          await this.managedBatch(held, t, entry, adapter);
        else
          await adapter.advanceBatchRun(held.runId, Object.assign(async () => {
            await this.gate(held!, t, entry, true);
          }, { native: this.nativeGuard(held, entry.envelope.commandId) }));
      } catch (error) {
        if (
          denied(error) ||
          [
            "DISPATCH_EXPIRED",
            "WORKSPACE_CHANGED",
            "ACCESS_DENIED",
            "GIT_BASELINE_CHANGED",
          ].includes(errorCode(error) ?? "")
        )
          await this.stop(held, "批次后续待办的执行授权已失效。").catch(
            () => {},
          );
      }
    } else if (
      !delivery &&
      !response.offers.length &&
      (!entry || (lease && entry.envelope.leaseEpoch < lease.leaseEpoch)) &&
      (!this.o.runs.getRun(held.runId) ||
        terminal(this.o.runs.getRun(held.runId)))
    )
      await this.reconcileHeldRun();
    await this.processInteractionResponses(held, t).catch(() => {});
    await this.sync(held, t).catch(() => {});
  }
  private async flushInteractionAcks(t: ExecutionTransport) {
    for (const pending of this.o.store.unackedInteractionResponses()) {
      const status =
        pending.status === "dispatching" ? "expired" : pending.status;
      if (pending.status === "dispatching") {
        this.adapter?.expireRequest(pending.pendingRequestId);
        this.o.store.finishInteractionResponse(pending.responseId, "expired");
      }
      result.parse(
        await t.executionRequest("response-ack", {
          runId: pending.runId,
          responseId: pending.responseId,
          status,
          ...(status === "expired"
            ? { reason: "本机请求已失效或原响应发送状态无法确认，未重复回答。" }
            : {}),
        }),
      );
      this.o.store.acknowledgeInteractionResponse(pending.responseId);
    }
  }
  private async processInteractionResponses(
    held: HeldRun,
    t: ExecutionTransport,
  ) {
    const run = this.o.runs.getRun(held.runId),
      entry = this.o.store.latest(held.runId);
    if (
      !run ||
      run.terminal ||
      run.cancelRequested ||
      !run.activeTurnId ||
      !this.adapter?.available ||
      entry?.phase !== "applied" ||
      entry.envelope.payload.type === "cancel_run"
    )
      return;
    const data = responsesResult.parse(
      await t.executionRequest("responses", { runId: held.runId }),
    );
    for (const response of data.responses) {
      if (response.runId !== held.runId) continue;
      await this.gate(held, t, entry, false, true);
      const record = this.o.store.beginInteractionResponse(response);
      if (!record.created) continue;
      try {
        await this.adapter.respondToCloudRequest(response);
        this.o.store.finishInteractionResponse(response.responseId, "applied");
      } catch {
        const latest = this.o.runs.getRun(held.runId);
        this.o.store.finishInteractionResponse(
          response.responseId,
          latest?.cancelRequested ? "cancelled" : "expired",
        );
      }
    }
    await this.flushInteractionAcks(t);
  }
  private async managedBatch(
    held: HeldRun,
    t: ExecutionTransport,
    entry: JournalEntry,
    adapter: CodexAdapter,
  ) {
    let run = this.o.runs.getRun(held.runId)!;
    const index = run.batch!.currentIndex,
      turnId = run.activeTurnId;
    if (
      !turnId ||
      run.batch!.items[index].completedTurnId !== turnId ||
      !run.resultValid
    )
      return;
    if (run.verification?.turnId !== turnId) {
      const snapshot = currentSnapshot(run);
      if (snapshot.kind !== "task") return;
      const results = await verifyAcceptance(
        run.root,
        snapshot.task.acceptance,
      );
      await this.gate(held, t, entry, true);
      const latest = this.o.runs.getRun(held.runId);
      if (
        latest?.activeTurnId !== turnId ||
        latest.batchPhase !== "ready" ||
        latest.cancelRequested
      )
        return;
      // Evidence and its exact native turn provenance commit atomically. A
      // restart may replay delivery, but can never substitute a model receipt.
      this.o.runs.appendEvent(
        this.o.runnerId,
        run.runId,
        "verification.completed",
        { results },
        `verification:${turnId}`,
        {
          verification: {
            turnId,
            itemIndex: index,
            results,
            capturedAt: new Date(this.now()).toISOString(),
          },
        },
      );
      run = this.o.runs.getRun(held.runId)!;
    }
    await this.sync(held, t);
    const state = this.o.store.run(held.runId),
      report = state?.report;
    if (
      !report ||
      !state.reportSent ||
      report.commandId !== entry.envelope.commandId ||
      report.turnId !== turnId ||
      report.batch?.currentIndex !== index
    )
      return;
    const decision = batchGateResult.parse(
      await t.executionRequest("batch-gate", {
        runId: held.runId,
        commandId: entry.envelope.commandId,
        fromIndex: index,
        completedTurnId: turnId,
        reportRevision: report.revision,
      }),
    );
    if (["wait", "blocked"].includes(decision.decision)) return;
    if (!decision.permitId)
      throw new RunnerError("BATCH_NOT_READY", "服务端未返回有效的继续许可。");
    const guard = Object.assign(async () => {
      await this.gate(held, t, entry, true);
      const current = this.o.runs.getRun(held.runId);
      if (
        current?.batch?.currentIndex !== index ||
        current.activeTurnId !== turnId
      )
        throw new RunnerError("BATCH_NOT_READY", "当前完成项已改变。");
    }, { native: this.nativeGuard(held, entry.envelope.commandId) });
    if (decision.decision === "finish") {
      await adapter.finishManagedBatch(run.runId, guard);
      return;
    }
    if (
      decision.nextIndex !==
      index + (decision.decision === "advance" ? 1 : 0)
    )
      throw new RunnerError("BATCH_NOT_READY", "许可指向的待办顺序不匹配。");
    await adapter.advanceBatchRun(
      run.runId,
      Object.assign(async (stage: string) => {
        await guard();
        if (stage === "turn")
          this.o.store.transition(entry, { startedAt: this.now() });
      }, { native: guard.native }),
      {
        permitId: decision.permitId,
        decision: decision.decision as "advance" | "repair",
        fromIndex: index,
        fromTurnId: turnId,
        nextIndex: decision.nextIndex,
      },
    );
  }
  private liveLease(held: HeldRun, envelope?: CommandEnvelope) {
    const lease = this.o.device.lease(held.runId);
    return (
      lease &&
      lease.workspaceId === held.workspaceId &&
      lease.expiresAt > this.now() &&
      (!envelope || envelope.leaseEpoch === lease.leaseEpoch)
    );
  }
  private async accept(
    held: HeldRun,
    t: ExecutionTransport,
    raw: unknown,
    value: unknown,
  ) {
    const envelope = commandEnvelopeSchema.parse(raw);
    // A server response cannot borrow another reservation or use a stale lease.
    if (
      envelope.runId !== held.runId ||
      envelope.authEpoch !== this.o.authEpoch ||
      !this.liveLease(held, envelope)
    )
      return;
    try {
      const snapshot = executionSnapshotSchema.parse(value);
      const previous = this.o.store.command(envelope.commandId);
      if (previous) {
        this.o.store.accept(envelope, snapshot); // exact duplicate, including immutable snapshot
        return;
      }
      if (
        bytes(snapshot) > 90_000 ||
        snapshot.ownerId !== this.o.ownerId ||
        snapshot.workspaceId !== held.workspaceId ||
        snapshot.runId !== envelope.runId ||
        snapshot.bindingRevision !== envelope.bindingRevision ||
        envelope.payloadHash !== digest(envelope.payload) ||
        snapshot.payloadHash !== digest({ ...snapshot, payloadHash: undefined })
      )
        throw new RunnerError(
          "SNAPSHOT_MISMATCH",
          "Execution snapshot does not match this run and device.",
        );
      const old = this.o.store.latest(held.runId);
      const run = this.o.runs.getRun(held.runId);
      const command = envelope.payload;
      if (
        (old && digest(old.snapshot) !== digest(snapshot)) ||
        (run && run.digest !== digest(snapshot)) ||
        (command.type === "create_run" &&
          (old ||
            run ||
            command.bindingId !== snapshot.bindingId ||
            command.kind !== snapshot.kind ||
            command.snapshotId !== snapshot.snapshotId ||
            command.payloadHash !== snapshot.payloadHash))
      )
        throw new RunnerError(
          "SNAPSHOT_MISMATCH",
          "Execution snapshot changed.",
        );
      if (
        command.type === "continue_run" &&
        (!old ||
          !run ||
          (command.mode === "reply" &&
            envelope.leaseEpoch <= old.envelope.leaseEpoch) ||
          (command.mode === "steer" &&
            envelope.leaseEpoch !== old.envelope.leaseEpoch))
      )
        throw new RunnerError(
          "LEASE_MISMATCH",
          "Continuation lease does not match the previous turn.",
        );
      for (const checkId of snapshot.allowedCheckIds)
        this.o.registry.assertCheck(snapshot.workspaceId, checkId);
      const accepted = await t.acceptExecutionEnvelope(envelope);
      if (!accepted) return;
      if (accepted.status === "rejected")
        throw new RunnerError(
          accepted.reason ?? "ENVELOPE_REJECTED",
          "Execution envelope rejected.",
        );
      this.o.store.accept(envelope, snapshot);
    } catch (error) {
      // Never mutate an earlier journal entry on an altered duplicate.
      if (!this.o.store.command(envelope.commandId))
        await this.sendAck(t, {
          commandId: envelope.commandId,
          status: "rejected",
          reason: errorCode(error) ?? "VALIDATION_ERROR",
        });
    }
  }
  private sendAck(t: ExecutionTransport, ack: NativeAck) {
    return t.executionRequest("ack", ack).then((value) => result.parse(value));
  }
  private async gate(
    held: HeldRun,
    t: ExecutionTransport,
    entry: JournalEntry,
    batchAdvance = false,
    interactionResponse = false,
  ) {
    const { envelope } = entry;
    this.o.store.assertDispatchAllowed(held, envelope.commandId);
    if(this.online!==t)throw new RunnerError("CONNECTION_LOST","执行连接正在恢复，请稍后重试。");
    const current = this.o.runs.getRun(held.runId);
    // The original delivery expires after acceptance, but a running batch is
    // authorized by its immutable snapshot and a freshly checked live lease.
    const appliedBatch =
      (interactionResponse ||
        (batchAdvance && current?.batchPhase === "ready" && !!current.batch)) &&
      entry.phase === "applied" &&
      current?.active &&
      !current.terminal &&
      !current.cancelRequested &&
      envelope.payload.type !== "cancel_run";
    if (
      this.disabled ||
      !this.liveLease(held, envelope) ||
      (!appliedBatch && Date.parse(envelope.expiresAt) <= this.now()) ||
      Date.parse(envelope.issuedAt) > this.now() + 30_000 ||
      this.o.store.held()?.lockToken !== held.lockToken
    )
      throw new RunnerError("DISPATCH_EXPIRED", "执行租约或命令已过期。");
    await this.o.registry.resolve(held.workspaceId, true);
    await this.o.registry.assertLock(
      held.workspaceId,
      held.runId,
      held.lockToken,
    );
    const ack = await this.sendAck(t, {
      commandId: envelope.commandId,
      status: "stored",
    });
    if (ack.superseded)
      throw new RunnerError("COMMAND_SUPERSEDED", "执行命令已被取消或替换。");
    if (
      appliedBatch &&
      current?.snapshot.kind === "task" &&
      current.snapshot.batch?.managed
    ) {
      // Revalidate after the network round trip, immediately before the
      // adapter persists/sends its turn. A granted permit cannot authorize a
      // replacement checkout that appeared while the ACK was in flight.
      await this.o.registry.resolve(held.workspaceId, true);
      await this.o.registry.assertLock(
        held.workspaceId,
        held.runId,
        held.lockToken,
      );
      const actual = await readGitBaseline(current.root),
        expected = current.snapshot.context.gitBaseline;
      if (
        actual.commit !== expected.commit ||
        actual.branch !== expected.branch
      )
        throw new RunnerError(
          "GIT_BASELINE_CHANGED",
          "项目 Git 分支或 HEAD 已改变；后续任务需要重新确认。",
        );
    }
    if(this.online!==t)throw new RunnerError("CONNECTION_LOST","执行连接正在恢复，请稍后重试。");
    this.o.store.assertDispatchAllowed(held, envelope.commandId);
    if (
      this.disabled ||
      !this.liveLease(held, envelope) ||
      (!appliedBatch && Date.parse(envelope.expiresAt) <= this.now()) ||
      this.o.store.held()?.lockToken !== held.lockToken
    )
      throw new RunnerError("DISPATCH_EXPIRED", "执行租约或命令已过期。");
  }
  private recoverableCheckpoint(run?:RunRecord|null) {
    const stop=run&&this.o.store.stopIntent(run.runId);
    if(stop&&stop.commandId===(this.o.store.latest(run!.runId)?.envelope.commandId??null))return false;
    const migrated=run&&this.o.store.checkpointRecovery(run.runId);
    return !!(run&&run.active&&!run.terminal&&run.snapshot.kind==="task"&&run.snapshot.batch?.managed&&run.batchPhase==="ready"&&!run.pendingRequestId&&run.threadId&&run.activeTurnId&&run.batch?.items[run.batch.currentIndex].completedTurnId===run.activeTurnId&&run.resultValid&&(!run.cancelRequested||legacyCheckpointStop.has(run.resultError??"")||(migrated?.turnId===run.activeTurnId&&migrated.commandId===this.o.store.latest(run.runId)?.envelope.commandId)));
  }
  private async recoverCheckpoint(held:HeldRun,t:ExecutionTransport,entry:JournalEntry) {
    const run=this.o.runs.getRun(held.runId)!;
    const connectionEpoch=t.status.connectionEpoch;
    const input={runId:held.runId,commandId:entry.envelope.commandId,threadId:run.threadId!,completedTurnId:run.activeTurnId!,leaseEpoch:entry.envelope.leaseEpoch};
    const decision=leaseRecoveryResult.parse(await t.executionRequest("recover-lease",{...input,phase:"inspect"}));
    if(decision.decision==="cancel") {await this.stop(held,"用户请求停止。");return;}
    if(decision.decision!=="inspect")return;
    const guard=async()=>{
      const assertCurrent=()=>{
        const current=this.o.runs.getRun(held.runId), latest=this.o.store.latest(held.runId);
        if(this.disabled||this.online!==t||t.status.connectionEpoch!==connectionEpoch||!this.recoverableCheckpoint(current)||current!.threadId!==input.threadId||current!.activeTurnId!==input.completedTurnId||latest?.envelope.commandId!==input.commandId||latest.phase!=="applied"||this.o.store.held()?.lockToken!==held.lockToken)
          throw new RunnerError("RECONCILIATION_REQUIRED","原暂停点或执行连接已改变。");
        return current!;
      };
      const current=assertCurrent();
      await this.o.registry.resolve(held.workspaceId,true);
      await this.o.registry.assertLock(held.workspaceId,held.runId,held.lockToken);
      const actual=await readGitBaseline(current!.root),expected=current!.snapshot.context.gitBaseline;
      if(actual.commit!==expected.commit||actual.branch!==expected.branch)
        throw new RunnerError("GIT_BASELINE_CHANGED","项目 Git 身份已改变，不能恢复旧暂停点。");
      assertCurrent();
    };
    await guard();
    const adapter=await this.codex(held.workspaceId);
    await adapter.confirmPausedCheckpoint(held.runId,guard);
    await guard();
    const receipt=leaseRecoveryResult.parse(await t.executionRequest("recover-lease",{...input,phase:"confirm",recoveryId:decision.recoveryId}));
    await guard();
    if(receipt.decision!=="recovered"||receipt.recoveryId!==decision.recoveryId||receipt.lease.runId!==held.runId||receipt.lease.workspaceId!==held.workspaceId||receipt.lease.leaseEpoch!==input.leaseEpoch||receipt.lease.expiresAt<=this.now())return;
    this.o.device.saveLease(receipt.lease);
    this.o.runs.patchRun(held.runId,{cancelRequested:false,status:"verifying",resultError:null});
    this.o.store.clearCheckpointRecovery(held.runId);
    this.attached.add(held.runId);
  }
  private outcome(
    entry: JournalEntry,
    phase: "applied" | "uncertain" | "rejected",
    error?: string,
  ) {
    this.o.store.transition(entry, {
      phase,
      error,
      acked: false,
      ack: {
        commandId: entry.envelope.commandId,
        status: phase,
        ...(error ? { reason: shorten(error, 1000) } : {}),
      },
    });
  }
  private async dispatch(
    held: HeldRun,
    t: ExecutionTransport,
    entry: JournalEntry,
  ) {
    const command = entry.envelope.payload;
    try {
      await this.gate(held, t, entry);
    } catch (error) {
      if (errorCode(error) === "COMMAND_SUPERSEDED")
        await this.reconcileHeldRun();
      else if (
        ["DISPATCH_EXPIRED", "WORKSPACE_CHANGED", "ACCESS_DENIED"].includes(
          errorCode(error) ?? "",
        )
      )
        this.outcome(entry, "rejected", errorCode(error));
      else if (denied(error))
        await this.stop(held, "执行授权已失效。").catch(() => {});
      return;
    }
    const run = this.o.runs.getRun(held.runId);
    if (
      command.type === "continue_run" &&
      (!run?.activeTurnId ||
        !run.threadId ||
        run.activeTurnId !== command.expectedTurnId ||
        run.status === "reconciliation_required" ||
        (command.mode === "reply") !== terminal(run))
    ) {
      this.outcome(entry, "rejected", "TURN_MISMATCH");
      return;
    }
    const started = this.o.store.transition(entry, { phase: "dispatching" });
    if (!started) return;
    entry = started;
    try {
      if (command.type === "cancel_run") {
        await this.stop(held, "用户请求停止。", entry.envelope.commandId);
        const current = this.o.runs.getRun(held.runId);
        this.outcome(
          entry,
          !current || terminal(current)
            ? "applied"
            : current.status === "reconciliation_required"
              ? "uncertain"
              : "applied",
          current?.resultError ?? undefined,
        );
        return;
      }
      const adapter = await this.codex(held.workspaceId);
      const guard = Object.assign(async (stage: string) => {
        await this.gate(held, t, entry);
        if (stage === "turn") {
          entry =
            this.o.store.transition(entry, { startedAt: this.now() }) ?? entry;
        }
      }, { native: this.nativeGuard(held, entry.envelope.commandId) });
      if (command.type === "create_run") {
        const launched = await adapter.startFreshRun(entry.snapshot, guard);
        if (launched.status === "started") {
          this.attached.add(held.runId);
          this.outcome(entry, "applied");
        } else
          this.outcome(
            entry,
            terminal(this.o.runs.getRun(held.runId)) ? "rejected" : "uncertain",
            launched.reason,
          );
      } else {
        const { type: _, ...input } = command;
        const continued = await adapter.continueRun(input, guard);
        if (continued.status === "accepted") {
          this.attached.add(held.runId);
          this.outcome(entry, "applied");
        } else
          this.outcome(
            entry,
            terminal(this.o.runs.getRun(held.runId)) ? "rejected" : "uncertain",
            continued.status,
          );
      }
    } catch (error) {
      if (errorCode(error) === "ITEM_SEALED") {
        await this.stop(
          held,
          "已完成的清单待办已封存，请从未完成项创建新提交。",
          entry.envelope.commandId,
        ).catch(() => {});
        const current = this.o.runs.getRun(held.runId);
        if (current)
          this.o.runs.patchRun(held.runId, {
            resultError:
              "ITEM_SEALED：已完成的清单待办已封存，请从未完成项创建新提交。",
          });
        this.outcome(
          entry,
          terminal(current) ? "rejected" : "uncertain",
          "ITEM_SEALED",
        );
        return;
      }
      const current = this.o.runs.getRun(held.runId);
      this.outcome(
        entry,
        !current || terminal(current) ? "rejected" : "uncertain",
        errorCode(error) ?? "CODEX_UNAVAILABLE",
      );
    }
  }
  private confirmedDispatch(entry: JournalEntry) {
    const run = this.o.runs.getRun(entry.envelope.runId),
      cmd = entry.envelope.payload;
    if (cmd.type === "create_run")
      return run?.launchResult?.status === "started";
    if (cmd.type === "cancel_run") return !run || terminal(run);
    const receipt = this.o.runs.acceptedCommandReceipt(
      cmd.requestId,
      entry.envelope.runId,
    );
    return (
      !!receipt &&
      receipt.threadId === run?.threadId &&
      receipt.turnId === run?.activeTurnId
    );
  }
  private finishInterruptedDispatch(entry: JournalEntry) {
    const run = this.o.runs.getRun(entry.envelope.runId);
    const cmd = entry.envelope.payload;
    if (this.confirmedDispatch(entry)) this.outcome(entry, "applied");
    else if (!run || terminal(run))
      this.outcome(entry, "rejected", "INTERRUPTED_BEFORE_CONFIRMED_DISPATCH");
    else this.outcome(entry, "uncertain", "DISPATCH_RECONCILIATION_REQUIRED");
  }
  private async recover(held: HeldRun) {
    this.assertHeldCurrent(held);
    const run = this.o.runs.getRun(held.runId);
    if (!run || terminal(run)) return;
    if (
      run.launchIntent === "prepared" ||
      run.launchIntent === "thread_created"
    ) {
      this.o.runs.patchRun(run.runId, {
        active: false,
        terminal: true,
        status: "failed",
        resultError: "启动在发送轮次前中断。",
      });
      return;
    }
    if (
      this.attached.has(run.runId) &&
      this.adapter?.available &&
      run.status !== "reconciliation_required"
    )
      return;
    if (!run.threadId) return;
    const adapter = await this.codex(held.workspaceId);
    this.assertHeldCurrent(held);
    const recovered = await adapter.reconcileRun(run.runId);
    this.assertHeldCurrent(held);
    if (recovered.status === "running") this.attached.add(run.runId);
  }
  private async stop(held: HeldRun, reason: string, cancelCommandId?: string) {
    this.assertHeldCurrent(held);
    // Persist explicit stop intent before any await or cross-store cleanup.
    // Old safety-stop display text must never recreate recovery eligibility if
    // this process dies while a later user/lifecycle stop is being handled.
    this.o.store.recordStopIntent(held.runId,reason,this.o.store.latest(held.runId)?.envelope.commandId??null);
    this.o.store.clearCheckpointRecovery(held.runId);
    let run = this.o.runs.getRun(held.runId);
    if (!run || terminal(run)) return;
    if (
      !this.attached.has(run.runId) ||
      !this.adapter?.available ||
      !run.activeTurnId
    )
      await this.recover(held).catch(() => {});
    this.assertHeldCurrent(held);
    run = this.o.runs.getRun(held.runId);
    if (!run || terminal(run)) return;
    if (
      !run.threadId ||
      !run.activeTurnId ||
      run.pendingRequestId ||
      !this.adapter?.available
    ) {
      this.o.runs.patchRun(run.runId, {
        status: "reconciliation_required",
        resultError: reason,
      });
      return;
    }
    const key = `${run.runId}:${run.activeTurnId}:${cancelCommandId ?? "safety-stop"}`;
    const adapter = this.adapter;
    const firstIntent = this.o.store.interruptOnce(key);
    const previous = this.interruptAttempts.get(run.runId);
    if (firstIntent || previous?.key !== key || previous.adapter !== adapter) {
      // The durable marker is intent, not proof the RPC reached Codex. In
      // particular old interruptOnce rows must not suppress recovery forever.
      const recovered = await adapter.reconcileRun(run.runId);
      this.assertHeldCurrent(held);
      const current = this.o.runs.getRun(run.runId);
      if (!current || terminal(current)) return;
      if (
        recovered.status === "reconciliation_required" ||
        this.adapter !== adapter || !adapter.available ||
        current.threadId !== run.threadId || current.activeTurnId !== run.activeTurnId ||
        current.pendingRequestId
      ) return;
      const receipt = await adapter.cancelRun(run.runId);
      this.assertHeldCurrent(held);
      // Suppress repeated accepted interrupts only for this live connection.
      // An ambiguous send or a new connection rechecks the exact target again.
      if (receipt.status !== "reconciliation_required")
        this.interruptAttempts.set(run.runId, { key, adapter });
      await adapter
        .waitForRun(run.runId, this.o.codex?.shutdownTimeoutMs ?? 1500)
        .catch(() => {});
    }
    this.assertHeldCurrent(held);
    if (!terminal(this.o.runs.getRun(run.runId))) {
      this.attached.delete(run.runId);
      await this.recover(held).catch(() => {});
      this.assertHeldCurrent(held);
      if (!terminal(this.o.runs.getRun(run.runId)))
        this.o.runs.patchRun(run.runId, {
          status: "reconciliation_required",
          resultError: reason,
        });
    }
  }
  private report(
    held: HeldRun,
    entry: JournalEntry,
    stopError?: string,
  ): Omit<NativeReport, "revision"> | undefined {
    if (["staged", "dispatching", "superseded"].includes(entry.phase)) return;
    const run = this.o.runs.getRun(held.runId);
    const command = entry.envelope.payload;
    const stopped = !stopError && (terminal(run) || !run);
    let status: NativeReport["status"];
    if (command.type === "cancel_run" && stopped) status = "cancelled";
    else if (entry.phase === "rejected" && stopped) status = "failed";
    else if (
      stopError || run?.status === "reconciliation_required" ||
      (!stopped &&
        (run?.cancelRequested || !run?.activeTurnId) &&
        entry.phase === "uncertain")
    )
      status = "reconciliation_required";
    else if (!run) status = "failed";
    else if (run.status === "cancel_requested") status = "running";
    else status = run.status as NativeReport["status"];
    const error =
      stopError ?? run?.resultError ?? (status === "verifying" ? undefined : entry.error);
    return {
      runId: held.runId,
      commandId: entry.envelope.commandId,
      status,
      threadId: run?.threadId ?? null,
      turnId: run?.activeTurnId ?? null,
      terminal: stopped,
      stopConfirmed: stopped,
      ...(error ? { error: shorten(error, 2000) } : {}),
      ...(run?.batch ? { batch: run.batch } : {}),
      ...(run?.snapshot.kind === "summary" && run.summaryContext
        ? { summaryContext: run.summaryContext }
        : {}),
    };
  }
  private async sync(held: HeldRun, t?: ExecutionTransport) {
    if (!sameExecutionClaim(this.o.store.held(), held)) return false;
    if (this.o.store.reconciliation(held)) return false;
    if (!t || this.o.store.held()?.phase !== "claimed") return false;
    const entry = this.o.store.latest(held.runId);
    if (entry?.ack && !entry.acked) {
      await this.sendAck(t, entry.ack);
      this.o.store.transition(entry, { acked: true });
    }
    if (entry) {
      const run = this.o.runs.getRun(held.runId);
      let stopError: string | undefined;
      if (terminal(run) && run?.threadId && run.activeTurnId) {
        try {
          // A replaced workspace must still allow the already attached native
          // thread to be stopped; only new dispatch needs directory resolution.
          const adapter = this.adapter?.available ? this.adapter : await this.codex(held.workspaceId);
          await adapter.confirmRunStopped(held.runId, undefined, { readOnly: false, native: this.nativeGuard(held, entry.envelope.commandId) });
        } catch (error) {
          stopError = String(error);
        }
      }
      if (!sameExecutionClaim(this.o.store.held(), held)) return false;
      const report = this.report(held, entry, stopError);
      if (report) this.o.store.saveReport(report);
      const pending = this.o.store.run(held.runId);
      if (pending?.report && !pending.reportSent) {
        // Old versions may have saved this report before inspecting terminals.
        // Keep its immutable receipt for retry, but never deliver a false stop.
        if (pending.report.stopConfirmed && !report?.stopConfirmed) return false;
        const receipt = result.parse(
          await t.executionRequest("report", pending.report),
        );
        this.o.store.markReportSent(pending.report, receipt.settled === true);
        // An older pending report never authorizes the latest command's release.
        if (report) this.o.store.saveReport(report);
      }
      const state = this.o.store.run(held.runId);
      const lease = this.o.device.lease(held.runId);
      if (
        report?.stopConfirmed &&
        state?.reportSettled &&
        state.report?.commandId === entry.envelope.commandId &&
        state.report.stopConfirmed &&
        entry.envelope.leaseEpoch === lease?.leaseEpoch
      ) {
        const releasing = this.o.store.updateHold(held, "releasing");
        if (releasing) await this.release(releasing, t);
        await this.flushEvents(t, held.runId).catch(() => {});
        return true;
      }
    }
    if (entry) await this.flushEvents(t, held.runId).catch(() => {});
    return false;
  }
  /** N6/manual reconnect can invoke this while an earlier thread/start is
   * pending. The durable fence is written before any network await. */
  reconcileHeldRun(): Promise<void> {
    if (this.closed || this.deviceResetGuard) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    const held = this.boundHold();
    this.reconciling = this.reconcileHeld().catch(error => {
      if (!held) return;
      const message = shorten(String(error), 2000);
      if (this.o.store.reconciliation(held))
        this.o.store.saveReconciliation(held, { error: message });
      const run = this.o.runs.getRun(held.runId);
      if (run && !terminal(run) && sameExecutionClaim(this.o.store.held(), held))
        this.o.runs.patchRun(held.runId, { status: "reconciliation_required", resultError: message });
    }).finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async assertRecoveryClaim(held: HeldRun, recovery: NativeReconciliation) {
    const assertCurrent = () => {
      const current = this.o.store.held(), lease = this.o.device.lease(held.runId), claim = recovery.claim;
      if (!current || this.closed || current.runId !== claim.runId || current.workspaceId !== claim.workspaceId ||
          current.lockToken !== claim.lockToken || current.leaseEpoch !== claim.leaseEpoch ||
          (lease && (lease.runId !== claim.runId || lease.workspaceId !== claim.workspaceId || lease.leaseEpoch !== claim.leaseEpoch)))
        throw new RunnerError("LEASE_MISMATCH", "原占用或租约已改变，不能确认或释放其他占用。");
    };
    assertCurrent();
    await this.o.registry.assertLock(held.workspaceId, held.runId, held.lockToken);
    assertCurrent();
  }
  private neverDispatched(recovery: NativeReconciliation): NativeStopProof | undefined {
    const ticket = recovery.ticket!;
    const commands = this.o.store.commandsForRun(ticket.runId), run = this.o.runs.getRun(ticket.runId);
    const original = this.o.store.command(ticket.originalCommandId);
    if (commands.some(entry => entry.envelope.payload.type === "continue_run" || entry.phase === "applied") ||
        (commands.length > 0 && !original) || ticket.turnId ||
        (original && (original.envelope.payload.type !== "create_run" || original.envelope.leaseEpoch !== ticket.leaseEpoch ||
          original.snapshot.payloadHash !== ticket.snapshotHash || digest({ ...original.snapshot, payloadHash: undefined }) !== ticket.snapshotHash)) ||
        (run && (run.snapshot.payloadHash !== ticket.snapshotHash || run.digest !== digest(run.snapshot) || run.pendingRequestId ||
          run.activeTurnId || run.launchResult?.status === "started" || !["prepared", "thread_requested", "thread_created"].includes(run.launchIntent))))
      return;
    // Absence alone is not evidence: this always requires the durable original
    // claim, its workspace lock and this process's exclusive consumer lock.
    if (!original && run) return;
    const commandState = original?.phase ?? "not_received";
    if (!["not_received", "staged", "dispatching", "rejected", "uncertain"].includes(commandState)) return;
    return nativeStopProofSchema.parse({ kind: "never_dispatched", consumerHeld: true, claim: recovery.claim,
      journal: { commandId: ticket.originalCommandId, snapshotHash: ticket.snapshotHash, sealed: true },
      commandState, launchStage: run?.launchIntent ?? "absent", turnStartRecorded: false });
  }
  private async recoveryProof(held: HeldRun, recovery: NativeReconciliation): Promise<NativeStopProof> {
    const ticket = recovery.ticket!;
    const never = this.neverDispatched(recovery);
    if (never) return never;
    const run = this.o.runs.getRun(held.runId);
    if (!run?.threadId || run.snapshot.payloadHash !== ticket.snapshotHash)
      throw new RunnerError("RECONCILIATION_REQUIRED", "缺少原生轮次或未派发的完整证据；不能猜测会话。");
    const adapter = this.adapter?.available ? this.adapter : await this.codex(held.workspaceId);
    // Identity lookup reads history only, including turn/start ACK loss. It
    // never guesses a thread from a title, timestamp or another user's chat.
    await adapter.identifyRunTurn(held.runId);
    await this.assertRecoveryClaim(held, recovery);
    if (ticket.action === "stop") await this.stop(held, "用户停止或原执行授权已失效。", ticket.currentCommandId);
    try {
      await adapter.confirmRunStopped(held.runId, () => this.assertRecoveryClaim(held, recovery), { readOnly: ticket.action === "inspect_only" });
    } catch (error) {
      if (ticket.action === "inspect_only" && errorCode(error) === "RECONCILIATION_REQUIRED")
        throw new RunnerError("RECONCILIATION_REQUIRED", "只读核对尚未确认原会话和后台进程全部停止。请先在清单请求停止，再重连核对。");
      throw error;
    }
    const current = this.o.runs.getRun(held.runId)!;
    return nativeStopProofSchema.parse({ kind: "native_stopped", consumerHeld: true, claim: recovery.claim,
      journal: { commandId: ticket.originalCommandId, snapshotHash: ticket.snapshotHash, sealed: true },
      threadId: current.threadId, turnId: current.activeTurnId, turnsStopped: true, backgroundTerminalsStopped: true });
  }
  private async reconcileHeld() {
    let held = this.o.store.held();
    const t = this.online;
    if (!held || !t || held.phase !== "claimed") return;
    const lease = this.o.device.lease(held.runId);
    if (!held.leaseEpoch) {
      // Legacy claims can migrate only from their own persisted lease. The
      // server ticket must never manufacture local execution ownership.
      if (!lease || lease.workspaceId !== held.workspaceId)
        throw new RunnerError("RECONCILIATION_REQUIRED", "缺少原持久租约，不能确认从未派发。");
      held = this.o.store.bindClaim(held, lease.leaseEpoch);
    }
    let recovery = this.o.store.beginReconciliation(held);
    this.o.store.clearReconciliationRequest(held);
    await this.assertRecoveryClaim(held, recovery);
    const epoch = t.status.connectionEpoch;
    const connection = () => {
      if (this.online !== t || t.status.connectionEpoch !== epoch)
        throw new RunnerError("CONNECTION_LOST", "核对连接已更改，保留原请求等待重试。");
    };
    if (!recovery.request) {
      const pending = this.o.store.run(held.runId);
      if (!recovery.ticket && pending?.report?.status === "reconciliation_required" && !pending.reportSent) {
        const receipt = result.parse(await t.executionRequest("report", pending.report));
        connection();
        this.o.store.markReportSent(pending.report, receipt.settled === true);
      }
      const response = reconcileResult.parse(await t.executionRequest("reconcile", { phase: "inspect", runId: held.runId, workspaceId: held.workspaceId, leaseEpoch: recovery.claim.leaseEpoch }));
      connection();
      await this.assertRecoveryClaim(held, recovery);
      // An already-settled server status alone cannot replace our native stop
      // proof. A lost confirm ACK is recovered by the persisted request below.
      if (!("decision" in response) || response.decision !== "inspect")
        throw new RunnerError("RECONCILIATION_REQUIRED", "服务端已有终态，但本机缺少匹配的停止证明回执。");
      const ticket: ExecutionReconcileTicket = response.ticket;
      if (ticket.runId !== held.runId || ticket.workspaceId !== held.workspaceId || ticket.leaseEpoch !== recovery.claim.leaseEpoch)
        throw new RunnerError("LEASE_MISMATCH", "核对票据不属于原占用。");
      recovery = this.o.store.saveReconciliation(held, { ticket, error: undefined });
      const proof = await this.recoveryProof(held, recovery);
      connection();
      await this.assertRecoveryClaim(held, recovery);
      const request = { phase: "confirm" as const, runId: held.runId, recoveryId: ticket.recoveryId, requestId: randomUUID(), proof,
        report: { runId: held.runId, commandId: ticket.currentCommandId, revision: ticket.reportRevision + 1,
          threadId: proof.kind === "native_stopped" ? proof.threadId : this.o.runs.getRun(held.runId)?.threadId ?? ticket.threadId,
          turnId: proof.kind === "native_stopped" ? proof.turnId : null,
          status: "cancelled" as const, terminal: true as const, stopConfirmed: true as const } };
      // Fixed payload is durable before send; only transport supplies a fresh
      // connectionEpoch on replay. Old requests remain archived on conflicts.
      recovery = this.o.store.saveReconciliation(held, { request });
    }
    const request = recovery.request!;
    if (!recovery.settled) {
      let response;
      try {
        response = reconcileResult.parse(await t.executionRequest("reconcile", request));
      } catch (error) {
        if (errorCode(error) === "EXECUTION_HTTP_409")
          this.o.store.saveReconciliation(held, { request: undefined, ticket: undefined });
        throw error;
      }
      connection();
      await this.assertRecoveryClaim(held, recovery);
      if (!("ok" in response) || response.runId !== held.runId || response.workspaceId !== held.workspaceId ||
          response.leaseEpoch !== recovery.claim.leaseEpoch || response.recoveryId !== request.recoveryId ||
          response.reportRevision !== request.report.revision)
        throw new RunnerError("RECONCILIATION_REQUIRED", "停止确认回执不匹配原请求。");
      recovery = this.o.store.saveReconciliation(held, { settled: true, error: undefined });
    }
    // Server settled is necessary, but P1 native verification is still required
    // on EVERY release/restart, including a cached stop proof and receipt.
    if (this.o.runs.getRun(held.runId)) this.o.runs.patchRun(held.runId, {
      status: "cancelled", active: false, terminal: true, cancelRequested: true,
      resultError: null, ...(this.o.runs.getRun(held.runId)?.batch ? { batchPhase: "cancelled" as const } : {}),
    });
    const releasing = this.o.store.updateHold(held, "releasing");
    if (releasing) await this.release(releasing, t);
  }
  private async release(held: HeldRun, t?: ExecutionTransport) {
    this.assertHeldCurrent(held);
    const recovery = this.o.store.reconciliation(held);
    if (recovery) {
      if (!recovery.settled || !recovery.request || !recovery.ticket)
        throw new RunnerError("RECONCILIATION_REQUIRED", "尚未收到匹配的服务端停止回执。");
      await this.assertRecoveryClaim(held, recovery);
      if (recovery.request.proof.kind === "never_dispatched" && !this.neverDispatched(recovery))
        throw new RunnerError("RECONCILIATION_REQUIRED", "未派发证据已变化，保留原占用。");
    }
    const run = this.o.runs.getRun(held.runId);
    if (run?.threadId && run.activeTurnId) {
      const proof = recovery?.request?.proof;
      if (proof && (proof.kind !== "native_stopped" || proof.threadId !== run.threadId || proof.turnId !== run.activeTurnId))
        throw new RunnerError("RECONCILIATION_REQUIRED", "已确认的原生轮次已变化，保留原占用。");
      const adapter = this.adapter?.available ? this.adapter : await this.codex(held.workspaceId);
      await adapter.confirmRunStopped(held.runId, undefined, { readOnly: !!recovery, native: this.nativeGuard(held) });
    }
    this.assertHeldCurrent(held);
    if (recovery) await this.assertRecoveryClaim(held, recovery);
    if (held.phase === "releasing") {
      if (this.o.device.lease(held.runId)) {
        if (!t) return;
        await t.releaseLease(held.workspaceId, held.runId, true);
      }
      this.assertHeldCurrent(held);
      if (recovery) await this.assertRecoveryClaim(held, recovery);
      held = this.o.store.updateHold(held, "local_release") ?? held;
    }
    if (held.phase !== "local_release") return;
    await this.o.registry.release(
      held.workspaceId,
      held.runId,
      true,
      held.lockToken,
    );
    // A legacy manual flag without a recovery record derives ownership from
    // the held claim. Retire it while that original identity is still present.
    this.o.store.clearReconciliationRequest(held);
    this.o.store.clearHold(held);
    this.attached.delete(held.runId);
    this.interruptAttempts.delete(held.runId);
  }
  private async flushEvents(
    t: ExecutionTransport,
    runId = this.o.store.pendingEventRun(),
  ) {
    if (!runId) return;
    const state = this.o.store.eventState(runId);
    let page = state.page;
    this.o.store.eventAttempt(runId, this.now());
    if (!page) {
      const events: RunnerEvent[] = [];
      let cursor = state.cursor,
        size = 200;
      for (const row of this.o.runs.eventsForRunAfter(runId, cursor)) {
        const event = wireEvent(row.event),
          cost = bytes(event) + 1;
        if (events.length >= 50 || size + cost > 1_800_000) break;
        events.push(event);
        cursor = row.cursor;
        size += cost;
      }
      if (!events.length) {
        // Revoked historical pages stay in their own durable outbox; they
        // cannot prevent a different authorized run's events from flowing.
        if (this.o.store.held()?.runId !== runId)
          this.o.store.markEventsDrained(runId);
        return;
      }
      page = { cursor, events };
      this.o.store.saveEventPage(runId, page);
    }
    const ack = eventResult.parse(
      await t.executionRequest("events", { events: page.events }),
    );
    const ids = new Set(ack.eventIds);
    if (page.events.every((event) => ids.has(event.eventId)))
      this.o.store.markEventPageSent(runId, page);
  }
}
