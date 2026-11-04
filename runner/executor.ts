import { z } from "zod";
import type {
  CommandEnvelope,
  ExecutionSnapshot,
  RunnerEvent,
} from "../shared/agent/contracts";
import {
  commandEnvelopeSchema,
  executionSnapshotSchema,
} from "../shared/agent/schemas";
import { projectContextSchema } from "../shared/agent/execution";
import { CodexAdapter, type AdapterOptions } from "./codex-adapter";
import type { DeviceStore } from "./device-store";
import { RunnerError } from "./errors";
import {
  ExecutionStore,
  type HeldRun,
  type JournalEntry,
  type NativeAck,
  type NativeReport,
} from "./execution-store";
import { digest, RunnerStore } from "./store";
import type { RunnerTransport } from "./transport";
import type { RunRecord } from "./types";
import { readGitBaseline, rootKey } from "./workspace";
import { WorkspaceRegistry } from "./workspaces";

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
  private timer?: NodeJS.Timeout;
  private paused = false;
  private closed = false;
  private lastAuthCheck?: { at: number; epoch: number; commandId: string };
  private capturedAt = 0;
  private contextQueue: Promise<unknown> = Promise.resolve();
  private releaseConsumer: () => void;

  constructor(private o: Options) {
    this.now = o.now ?? Date.now;
    this.releaseConsumer = o.store.acquireConsumer();
  }
  private get disabled() {
    return this.paused || this.closed || this.o.enabled?.() === false;
  }
  start() {
    if (this.closed) return;
    this.paused = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 750);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.closed) return Promise.resolve();
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
          runnerId: this.o.runnerId,
          store: this.o.runs,
          workspaces: [],
        });
        this.connecting = (async () => {
          await previous?.close({ stopRuns: false });
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
    let held = this.o.store.held();
    const t = this.online;
    if (held?.phase === "releasing" || held?.phase === "local_release") {
      await this.release(held, t);
      return;
    }
    if (held?.phase === "claimed") {
      const active = this.o.runs.getRun(held.runId);
      const entry = this.o.store.latest(held.runId);
      const status = this.o.transport()?.status.connectionStatus;
      if (active && !terminal(active)) {
        let stopReason =
          this.disabled || status === "revoked"
            ? "设备执行已停用。"
            : undefined;
        if (!this.liveLease(held)) stopReason = "运行租约已过期。";
        if (
          entry?.startedAt &&
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
          stopReason = "本地项目目录已变化。";
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
      if (entry?.phase === "dispatching") this.finishInterruptedDispatch(entry);
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
      response = await this.poll(t);
    }
    const delivery = response.deliveries[0];
    if (delivery)
      await this.accept(held, t, delivery.envelope, delivery.snapshot);
    const entry = this.o.store.latest(held.runId);
    const lease = this.o.device.lease(held.runId);
    if (entry?.phase === "staged") await this.dispatch(held, t, entry);
    else if (
      !delivery &&
      !response.offers.length &&
      (!entry || (lease && entry.envelope.leaseEpoch < lease.leaseEpoch)) &&
      (!this.o.runs.getRun(held.runId) ||
        terminal(this.o.runs.getRun(held.runId)))
    )
      await this.release(this.o.store.updateHold(held, "releasing") ?? held, t);
    await this.sync(held, t).catch(() => {});
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
  ) {
    const { envelope } = entry;
    if (
      this.disabled ||
      this.online !== t ||
      !this.liveLease(held, envelope) ||
      Date.parse(envelope.expiresAt) <= this.now() ||
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
      this.disabled ||
      this.online !== t ||
      !this.liveLease(held, envelope) ||
      Date.parse(envelope.expiresAt) <= this.now() ||
      this.o.store.held()?.lockToken !== held.lockToken
    )
      throw new RunnerError("DISPATCH_EXPIRED", "执行租约或命令已过期。");
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
        this.o.store.transition(entry, { phase: "superseded" });
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
      const guard = async (stage: string) => {
        await this.gate(held, t, entry);
        if (stage === "turn") {
          entry =
            this.o.store.transition(entry, { startedAt: this.now() }) ?? entry;
        }
      };
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
      const current = this.o.runs.getRun(held.runId);
      this.outcome(
        entry,
        !current || terminal(current) ? "rejected" : "uncertain",
        errorCode(error) ?? "CODEX_UNAVAILABLE",
      );
    }
  }
  private finishInterruptedDispatch(entry: JournalEntry) {
    const run = this.o.runs.getRun(entry.envelope.runId);
    const cmd = entry.envelope.payload;
    if (cmd.type === "create_run" && run?.launchResult?.status === "started")
      this.outcome(entry, "applied");
    else if (cmd.type === "cancel_run" && (!run || terminal(run)))
      this.outcome(entry, "applied");
    else if (!run || terminal(run))
      this.outcome(entry, "rejected", "INTERRUPTED_BEFORE_CONFIRMED_DISPATCH");
    else this.outcome(entry, "uncertain", "DISPATCH_RECONCILIATION_REQUIRED");
  }
  private async recover(held: HeldRun) {
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
    const recovered = await adapter.reconcileRun(run.runId);
    if (recovered.status === "running") this.attached.add(run.runId);
  }
  private async stop(held: HeldRun, reason: string, cancelCommandId?: string) {
    let run = this.o.runs.getRun(held.runId);
    if (!run || terminal(run)) return;
    if (
      !this.attached.has(run.runId) ||
      !this.adapter?.available ||
      !run.activeTurnId
    )
      await this.recover(held).catch(() => {});
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
    if (this.o.store.interruptOnce(key)) {
      await this.adapter.cancelRun(run.runId);
      await this.adapter
        .waitForRun(run.runId, this.o.codex?.shutdownTimeoutMs ?? 1500)
        .catch(() => {});
    }
    if (!terminal(this.o.runs.getRun(run.runId))) {
      this.attached.delete(run.runId);
      await this.recover(held).catch(() => {});
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
  ): Omit<NativeReport, "revision"> | undefined {
    if (["staged", "dispatching", "superseded"].includes(entry.phase)) return;
    const run = this.o.runs.getRun(held.runId);
    const command = entry.envelope.payload;
    const stopped = terminal(run) || !run;
    let status: NativeReport["status"];
    if (command.type === "cancel_run" && stopped) status = "cancelled";
    else if (entry.phase === "rejected" && stopped) status = "failed";
    else if (
      run?.status === "reconciliation_required" ||
      (!stopped &&
        (run?.cancelRequested || !run?.activeTurnId) &&
        entry.phase === "uncertain")
    )
      status = "reconciliation_required";
    else if (!run) status = "failed";
    else if (run.status === "cancel_requested") status = "running";
    else status = run.status as NativeReport["status"];
    const error =
      run?.resultError ?? (status === "verifying" ? undefined : entry.error);
    return {
      runId: held.runId,
      commandId: entry.envelope.commandId,
      status,
      threadId: run?.threadId ?? null,
      turnId: run?.activeTurnId ?? null,
      terminal: stopped,
      stopConfirmed: stopped,
      ...(error ? { error: shorten(error, 2000) } : {}),
    };
  }
  private async sync(held: HeldRun, t?: ExecutionTransport) {
    if (!t || this.o.store.held()?.phase !== "claimed") return false;
    const entry = this.o.store.latest(held.runId);
    if (entry?.ack && !entry.acked) {
      await this.sendAck(t, entry.ack);
      this.o.store.transition(entry, { acked: true });
    }
    if (entry) {
      const report = this.report(held, entry);
      if (report) this.o.store.saveReport(report);
      const pending = this.o.store.run(held.runId);
      if (pending?.report && !pending.reportSent) {
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
  private async release(held: HeldRun, t?: ExecutionTransport) {
    if (held.phase === "releasing") {
      if (this.o.device.lease(held.runId)) {
        if (!t) return;
        await t.releaseLease(held.workspaceId, held.runId, true);
      }
      held = this.o.store.updateHold(held, "local_release") ?? held;
    }
    if (held.phase !== "local_release") return;
    await this.o.registry.release(
      held.workspaceId,
      held.runId,
      true,
      held.lockToken,
    );
    this.o.store.clearHold(held);
    this.attached.delete(held.runId);
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
