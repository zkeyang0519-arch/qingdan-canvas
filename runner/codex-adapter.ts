import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { boundedFinalOutput } from "../shared/agent/output";
import type {
  ContinueRunInput,
  ExecutionSnapshot,
  RunnerEvent,
  RunnerEventPayloads,
} from "../shared/agent/contracts";
import {
  parseExecutionSnapshot,
  parseRunOutcome,
  projectSummarySchema,
  runnerCommandSchema,
} from "../shared/agent/schemas";
import type { Thread } from "./protocol/v2/Thread";
import type { Turn } from "./protocol/v2/Turn";
import type { ThreadItem } from "./protocol/v2/ThreadItem";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse";
import type { ThreadItemsListResponse } from "./protocol/v2/ThreadItemsListResponse";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse";
import type { ReasoningEffort } from "./protocol/ReasoningEffort";
import { CodexClient, type RpcPacket } from "./codex-client";
import { fastServiceTier, readCodexModels } from "./codex-sessions";
import type { ProcessOptions } from "./supervisor";
import { RunnerStore } from "./store";
import { RpcError, RunnerError } from "./errors";
import {
  canonicalRoot,
  rootKey,
  assertGitBaseline,
  readGitBaseline,
} from "./workspace";
import { validateSummaryReferences } from "./summary-evidence";
import {
  inspectProject,
  projectInspectionToolName,
  mergeInspectionSources,
  validateInspectionReferences,
  projectInspectionRoot,
  projectInspectionTool,
} from "./project-inspection";
import { validateHistoryReferences } from "./project-history";
import { readRecentHistory, recentHistoryTool, recentHistoryToolName } from "./project-recent-history";
import { historyTool, historyToolName, historyManifest, initialHistoryRead, readHistoryPage } from "./project-history-pages";
import { historyReadInput } from "./summary-cache";
import { summaryReadProgress } from "./summary-progress";
import {
  outputSchema,
  resultTool,
  resultToolName,
  runContext,
  runInstructions,
  runPrompt,
  runTitle,
  type SummaryMode,
} from "./prompt";
import { confirmThreadTerminalsStopped, stopThreadTerminals } from "./process-cleanup";
import { currentSnapshot, finishBatchItem, initialBatch } from "./batch";
import {
  requestResponseSchema,
  type NativeRequestResponse,
} from "../shared/agent/permissions";
import {
  approvalMetadata,
  inputMetadata,
  type NativeItemMetadata,
} from "./interaction-metadata";
import type {
  CommandReceipt,
  LaunchResult,
  PendingRequest,
  ReconcileResult,
  RunRecord,
  Workspace,
} from "./types";

export type NativeOperationGuard = {
  assertCurrent: () => void;
  assertDispatch: () => void;
  canStop: () => boolean;
};
export type AdapterOptions = ProcessOptions & {
  store: RunnerStore;
  runnerId: string;
  workspaces: Workspace[];
  requestTimeoutMs?: number;
  model?: string;
  effort?: ReasoningEffort;
  approvalsReviewer?: "user" | "auto_review";
  now?: () => number;
  desktopProjectSync?: (root: string) => Promise<void>;
  // Synchronous durable fence at the actual RPC send, including after awaits.
  captureGuard?: (runId: string) => NativeOperationGuard;
};
export function parseApprovalsReviewer(
  value?: unknown,
): "user" | "auto_review" {
  if (value === undefined) return "user";
  if (value === "user" || value === "auto_review") return value;
  throw new RunnerError(
    "VALIDATION_ERROR",
    "审批复核方式仅支持 user 或 auto_review。",
  );
}
type DispatchGuard = ((
  stage: "thread" | "name" | "resume" | "turn" | "steer",
) => Promise<void>) & { native?: NativeOperationGuard };
const summaryMode = (run: RunRecord): SummaryMode =>
  run.summaryHistory ? run.summaryHistory.version === 2 ? "history" : "legacy_history" : run.summaryInspection ? run.summaryInspection.mode === "current" ? run.summaryInspection.reportFormat === "handoff" ? "current" : "legacy_current" : "inspection" : "evidence";

export class CodexAdapter {
  private client: CodexClient;
  private changes = new EventEmitter();
  private workspaces = new Map<string, string>();
  private buffered = new Map<string, RpcPacket[]>();
  private requests = new Map<string, PendingRequest>();
  private itemMetadata = new Map<string, NativeItemMetadata>();
  private attachedThreads = new Set<string>();
  private completionCleanups = new Map<string, Promise<void>>();
  private completionReads = new Map<string, Promise<void>>();
  private desktopRefreshes = new Map<string, Promise<void>>();
  private closed = false;
  private connected = false;
  get available() {
    return this.connected && !this.closed;
  }
  private store: RunnerStore;
  private approvalsReviewer: "user" | "auto_review";
  private now: () => number;
  constructor(private options: AdapterOptions) {
    this.now = options.now ?? Date.now;
    this.approvalsReviewer = parseApprovalsReviewer(options.approvalsReviewer);
    this.store = options.store;
    this.client = new CodexClient(options);
    this.client.on("notification", (packet: RpcPacket) => this.receive(packet));
    this.client.on("request", (packet: RpcPacket) => this.receive(packet));
    this.client.on("disconnect", () => {
      this.connected = false;
      this.attachedThreads.clear();
      this.resolveRequests(
        undefined,
        "expired",
        "Codex 连接已断开，请停止或重新核对当前运行。",
      );
      this.itemMetadata.clear();
      for (const run of this.store.allRuns())
        if (run.active)
          this.uncertain(run.runId, "Codex 连接中断，需先核实运行结果。");
      this.changes.emit("change");
    });
    // Persisted identities deliberately contain no wire IDs. A new connection
    // can expire old prompts, but can never reconstruct a callback to approve.
    this.resolveRequests(
      undefined,
      "expired",
      "Runner 已重启，旧问题不能继续回答。",
    );
  }
  async attachWorkspace(workspaceId: string, registeredRoot: string) {
    const root = await canonicalRoot(registeredRoot);
    const prior = this.workspaces.get(workspaceId);
    if (
      rootKey(root) !== rootKey(registeredRoot) ||
      (prior && rootKey(prior) !== rootKey(root))
    )
      throw new RunnerError("WORKSPACE_CHANGED", "项目目录已变更。");
    this.workspaces.set(workspaceId, root);
  }
  async connect() {
    if (this.connected) return;
    for (const workspace of this.options.workspaces) {
      if (this.workspaces.has(workspace.workspaceId))
        throw new RunnerError("VALIDATION_ERROR", "Duplicate workspace ID");
      this.workspaces.set(
        workspace.workspaceId,
        await canonicalRoot(workspace.root),
      );
    }
    try {
      const info = await this.client.connect();
      this.connected = true;
      return info;
    } catch (error) {
      await this.client.close();
      throw error;
    }
  }
  account() {
    return this.client.request("account/read", { refreshToken: false });
  }
  getRun(runId: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new RunnerError("RUN_NOT_FOUND", "找不到本地运行。");
    return run;
  }
  private root(workspaceId: string) {
    const root = this.workspaces.get(workspaceId);
    if (!root)
      throw new RunnerError("ACCESS_DENIED", "项目目录尚未在本机注册。");
    return root;
  }
  private publish<K extends keyof RunnerEventPayloads>(
    runId: string,
    type: K,
    payload: RunnerEventPayloads[K],
    key?: string,
    patch?: Partial<RunRecord>,
  ) {
    this.store.appendEvent(
      this.options.runnerId,
      runId,
      type,
      payload,
      key,
      patch,
    );
    this.changes.emit("change");
  }
  private displayOutput(
    runId: string,
    channel: NonNullable<RunnerEventPayloads["output.delta"]["channel"]>,
    itemId: unknown,
    phase: NonNullable<RunnerEventPayloads["output.delta"]["phase"]>,
    text: string,
    title?: string,
    messagePhase?: RunnerEventPayloads["output.delta"]["messagePhase"] | null,
  ) {
    if (typeof itemId !== "string" || !/^[^\x00-\x20\x7f]{1,256}$/.test(itemId)) {
      for (let offset = 0; offset < text.length; offset += 32000)
        this.publish(runId, "output.delta", { text: text.slice(offset, offset + 32000) });
      return;
    }
    const run = this.getRun(runId);
    const state = run.outputItems?.turnId === run.activeTurnId
      ? structuredClone(run.outputItems)
      : { turnId: run.activeTurnId!, items: {} };
    const previous = Object.hasOwn(state.items, itemId) ? state.items[itemId] : { length: 0, completed: false };
    if (previous.completed) return;
    // Completion carries cumulative output. Only publish the suffix that was
    // not streamed already; keeping lengths durable prevents reconnect copies.
    const remaining = phase === "completed" ? text.slice(previous.length) : text;
    let length = previous.length;
    const chunks = remaining.length ? Math.ceil(remaining.length / 32000) : 1;
    for (let index = 0; index < chunks; index++) {
      const chunk = remaining.slice(index * 32000, (index + 1) * 32000);
      length += chunk.length;
      state.items[itemId] = { length, completed: phase === "completed" && index === chunks - 1 };
      this.publish(runId, "output.delta", {
        text: chunk, channel, itemId, phase,
        ...(messagePhase ? { messagePhase } : {}),
        ...(title ? { title: title.slice(0, 2000) } : {}),
      }, phase === "delta" ? undefined : `display:${run.activeTurnId}:${itemId}:${phase}:${index}`, { outputItems: state });
    }
  }
  private uncertain(runId: string, reason: string): LaunchResult {
    if (!this.getRun(runId).terminal)
      this.store.patchRun(runId, {
        status: "reconciliation_required",
        resultError: reason,
      });
    this.changes.emit("change");
    return { status: "reconciliation_required", runId, reason };
  }
  private currentOperation(guard?: NativeOperationGuard) {
    try { guard?.assertCurrent(); return true; } catch { return false; }
  }
  private syncDesktop(runId: string) {
    const notify = this.options.desktopProjectSync;
    if (!notify || this.closed || this.desktopRefreshes.has(runId)) return;
    // Every desktop-only read/write stays inside this contained background job.
    // An unavailable display or busy status journal cannot change task dispatch.
    const refresh = Promise.resolve()
      .then(async () => {
        const run = this.getRun(runId);
        if (
          run.launchResult?.status !== "started" ||
          run.desktopSync?.status === "requested"
        )
          return;
        this.store.patchRun(runId, { desktopSync: { status: "pending" } });
        const currentRoot = await canonicalRoot(run.root);
        if (this.closed) return;
        if (
          rootKey(currentRoot) !== rootKey(this.root(run.snapshot.workspaceId))
        )
          throw new RunnerError(
            "WORKSPACE_CHANGED",
            "项目目录已变更，未通知桌面。",
          );
        await notify(currentRoot);
        if (this.closed) return;
        this.store.patchRun(runId, { desktopSync: { status: "requested" } });
      })
      .catch((error) => {
        if (this.closed) return;
        try {
          this.store.patchRun(runId, {
            desktopSync: {
              status: "failed",
              error: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 1000),
            },
          });
        } catch {
          /* Best-effort display status must not reject task work. */
        }
      })
      .finally(() => {
        this.desktopRefreshes.delete(runId);
      });
    this.desktopRefreshes.set(runId, refresh);
  }
  private turnParams(
    run: RunRecord,
    requestId: string,
    message?: string,
  ): TurnStartParams {
    const permissions = this.permissions(run.snapshot);
    const model = run.summarySettings?.model ?? run.taskModel ?? run.snapshot.executionSettings?.model ?? this.options.model;
    const effort = run.summarySettings?.effort ?? run.snapshot.executionSettings?.reasoningEffort ?? this.options.effort;
    return {
      threadId: run.threadId!,
      clientUserMessageId: requestId,
      input: [
        {
          type: "text",
          text: runPrompt(currentSnapshot(run), message, summaryMode(run)),
          text_elements: [],
        },
      ],
      cwd: run.root,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.reviewer,
      sandboxPolicy:
        permissions.sandbox === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : permissions.sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [run.root],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
      ...(model ? { model } : {}),
      ...(run.taskServiceTier ? { serviceTier: run.taskServiceTier } : {}),
      ...(run.snapshot.kind === "task" && run.snapshot.executionSettings && !run.snapshot.executionSettings.fastMode ? { serviceTierForTurn: "default" } : {}),
      ...(effort ? { effort } : {}),
      additionalContext: {
        ...(run.snapshot.kind === "summary" && (run.summaryHistory || run.summaryInspection || run.summaryEvidence)
          ? {
              qingdan_project_evidence: {
                kind: "untrusted" as const,
                name: "qingdan_project_evidence",
                value: JSON.stringify((run.summaryHistory?.version === 2
                  ? { ...historyManifest(historyReadInput(run.summaryHistory, run.summaryHistoryCache), run.summaryHistoryRead ?? initialHistoryRead(historyReadInput(run.summaryHistory, run.summaryHistoryCache))),
                    totalProjectRecords: run.summaryHistory.records.length,
                    cachedRecords: run.summaryHistoryCache?.reusedSources.length ?? 0,
                    ...(run.summaryHistoryCache ? { cache: { sourceRunId: run.summaryHistoryCache.sourceRunId, capturedAt: run.summaryHistoryCache.capturedAt } } : {}) }
                  : run.summaryHistory) ?? (run.summaryInspection
                  ? { mode: "project_inspection", cwd: run.root, ...run.summaryContext,
                      guidance: run.summaryInspection.mode === "current"
                        ? "按需 browse/read/search/git 检查当前项目，需要时查最近会话；信息足够即可总结，不要求读完分页或历史。"
                        : "先调用 qingdan_inspect_project 的 list 浏览整个项目，再用 read/search/git 按模块核查。nextCursor 非空表示尚未读取完。" }
                  : run.summaryEvidence)),
              },
            }
          : {}),
        qingdan_task: {
          kind: "untrusted",
          name: "qingdan_task",
          value: runContext(currentSnapshot(run), summaryMode(run)),
        },
      },
      ...(run.resultChannel === "tool"
        ? {}
        : { outputSchema: outputSchema(run.snapshot.kind, summaryMode(run)) }),
    };
  }
  private permissions(snapshot: ExecutionSnapshot) {
    const profile = snapshot.executionPermissions?.profile;
    const fullAccess = snapshot.kind === "task" && profile === "full_access";
    return {
      sandbox: (snapshot.kind === "summary" || profile === "read_only"
        ? "read-only"
        : fullAccess ? "danger-full-access" : "workspace-write") as "read-only" | "workspace-write" | "danger-full-access",
      approvalPolicy: (fullAccess ? "never" : "on-request") as "never" | "on-request",
      reviewer: profile
        ? ((profile === "workspace_auto" && snapshot.kind !== "summary"
            ? "auto_review"
            : "user") as "auto_review" | "user")
        : this.approvalsReviewer,
    };
  }
  async startFreshRun(
    input: ExecutionSnapshot,
    guard?: DispatchGuard,
  ): Promise<LaunchResult> {
    if (this.closed) throw new RunnerError("CODEX_CLOSED", "Adapter is closed");
    const snapshot = parseExecutionSnapshot(input),
      root = this.root(snapshot.workspaceId);
    const native = guard?.native ?? this.options.captureGuard?.(snapshot.runId);
    native?.assertCurrent();
    const previous = this.store.getRun(snapshot.runId);
    // A replay checks identity but does not re-check a baseline changed by its
    // own completed work, nor issue any RPC with execution side effects.
    if (previous) {
      const { run } = this.store.prepareRun(snapshot, root);
      if (
        run.launchResult &&
        !run.terminal &&
        run.threadId &&
        (!this.attachedThreads.has(run.threadId) ||
          run.status === "reconciliation_required")
      ) {
        const recovered = await this.reconcileRun(run.runId);
        if (recovered.status === "reconciliation_required")
          return {
            status: "reconciliation_required",
            runId: run.runId,
            reason: recovered.reason ?? "已有会话需要核实。",
          };
      }
      this.syncDesktop(run.runId);
      return (
        run.launchResult ?? {
          status: "reconciliation_required",
          runId: run.runId,
          reason: "此前启动结果不确定，禁止重复派发。",
        }
      );
    }
    if (snapshot.kind === "task")
      await assertGitBaseline(root, snapshot.context.gitBaseline);
    const { run, created } = this.store.prepareRun(snapshot, root);
    if (!created)
      return (
        run.launchResult ?? this.uncertain(run.runId, "已有运行正在准备。")
      );
    this.store.patchRun(run.runId, {
      resultChannel: "tool",
      reportedResult: null,
      ...(snapshot.kind === "summary" ? {
        summarySettings: { model: "gpt-6.1-terra", effort: "medium" as const },
        summaryProgress: { ...summaryReadProgress(run), mode: "project" as const, phase: "reading" as const, filesRead: 0, historyReads: 0 },
      } : {}),
      ...(snapshot.kind === "task" && snapshot.batch
        ? { batch: initialBatch(snapshot), batchPhase: "running" }
        : {}),
    });
    this.publish(
      run.runId,
      "run.accepted",
      { status: "preparing" },
      "accepted",
    );
    try {
      const settings = snapshot.kind === "task" ? snapshot.executionSettings : undefined;
      let model = snapshot.kind === "summary" ? "gpt-6.1-terra" : settings?.model ?? this.options.model;
      let serviceTier = settings ? "default" : undefined;
      if (settings?.fastMode) {
        const models = await readCodexModels(this.client);
        if (!model) {
          const { config } = await this.client.request("config/read", { cwd: root, includeLayers: false });
          model = config.model ?? models.find((entry) => entry.isDefault)?.model;
        }
        serviceTier = fastServiceTier(models.find((entry) => entry.model === model));
        if (!serviceTier)
          throw new RunnerError("VALIDATION_ERROR", "当前模型不支持快速模式。请更新执行设置。");
      }
      await guard?.("thread");
      native?.assertDispatch();
      this.store.patchRun(run.runId, {
        launchIntent: "thread_requested",
        ...(settings?.fastMode ? { taskModel: model, taskServiceTier: serviceTier } : {}),
      });
      const result = await this.client.request("thread/start", {
        cwd: root,
        sandbox: this.permissions(snapshot).sandbox,
        approvalPolicy: this.permissions(snapshot).approvalPolicy,
        approvalsReviewer: this.permissions(snapshot).reviewer,
        ephemeral: false,
        developerInstructions: runInstructions(snapshot.kind),
        dynamicTools: [resultTool(snapshot.kind), ...(snapshot.kind === "summary" ? [projectInspectionTool(), recentHistoryTool()] : [])],
        ...(model ? { model } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      // A reconciliation may finish while thread/start is pending. Its late
      // reply must not revive the run or proceed to name/turn/start.
      native?.assertDispatch();
      if (!result.thread?.id || rootKey(result.thread.cwd) !== rootKey(root))
        throw new RunnerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex 返回了错误的项目目录。",
        );
      this.publish(run.runId, "thread.created", {}, "thread", {
        threadId: result.thread.id,
        launchIntent: "thread_created",
      });
      this.attachedThreads.add(result.thread.id);
      await guard?.("name");
      native?.assertDispatch();
      await this.client.request("thread/name/set", {
        threadId: result.thread.id,
        name: runTitle(snapshot),
      });
      const requestId = `initial-${run.runId}`;
      await guard?.("turn");
      const summaryContext =
        snapshot.kind === "summary"
          ? {
              workspaceId: snapshot.workspaceId,
              gitBaseline: await readGitBaseline(root),
              capturedAt: new Date().toISOString(),
              sourceKind: "project_current" as const,
            }
          : undefined;
      const summaryInspection = summaryContext
        ? { root: await projectInspectionRoot(root), sources: [], mode: "current" as const, reportFormat: "handoff" as const, historySources: [] }
        : undefined;
      if (summaryInspection) await guard?.("turn");
      native?.assertDispatch();
      let prepared = this.store.patchRun(run.runId, {
        launchIntent: "turn_sent",
        pendingRequestId: requestId,
        ...(summaryContext ? { summaryContext } : {}),
        ...(summaryInspection ? { summaryInspection } : {}),
      });
      if (summaryInspection) prepared = this.store.patchRun(run.runId, { summaryProgress: summaryReadProgress(prepared) });
      const response = await this.client.request(
        "turn/start",
        this.turnParams(prepared, requestId),
      );
      native?.assertDispatch();
      if (!response.turn?.id)
        throw new RunnerError("CODEX_PROTOCOL_ERROR", "Missing turn ID");
      const launch: LaunchResult = {
        status: "started",
        runId: run.runId,
        threadId: result.thread.id,
        turnId: response.turn.id,
      };
      this.mapTurn(run.runId, response.turn.id, { launchResult: launch });
      this.syncDesktop(run.runId);
      return launch;
    } catch (error) {
      if (!this.currentOperation(native))
        return { status: "reconciliation_required", runId: run.runId, reason: "原执行占用已结束。" };
      const current = this.getRun(run.runId);
      if (!current.terminal && (
        current.launchIntent === "prepared" ||
        current.launchIntent === "thread_created" ||
        (error instanceof RpcError &&
          current.launchIntent === "thread_requested")
      ))
        this.store.patchRun(run.runId, {
          status: "failed",
          active: false,
          terminal: true,
          resultError: error instanceof Error ? error.message : "启动失败",
        });
      return this.uncertain(
        run.runId,
        error instanceof Error ? error.message : "启动结果未知",
      );
    }
  }
  private mapTurn(
    runId: string,
    turnId: string,
    extra: Partial<RunRecord> = {},
  ) {
    const prior = this.getRun(runId);
    const batch = prior.batch ? structuredClone(prior.batch) : undefined;
    if (batch && prior.batchPhase !== "ready")
      batch.items[batch.currentIndex].status = "running";
    const run = this.store.patchRun(runId, {
      activeTurnId: turnId,
      pendingRequestId: null,
      launchIntent: "started",
      status: "running",
      terminal: false,
      ...extra,
      ...(batch ? { batch } : {}),
    });
    this.publish(runId, "turn.started", {}, `started:${turnId}`);
    const packets = this.buffered.get(run.threadId!) ?? [];
    this.buffered.delete(run.threadId!);
    for (const packet of packets) this.receive(packet);
  }
  private receive(packet: RpcPacket) {
    const params = packet.params;
    if (!params || typeof params.threadId !== "string") {
      if (packet.id !== undefined)
        this.client.rejectRequest(packet.id, "Unsupported Runner request");
      return;
    }
    const run = this.store.byThread(params.threadId);
    if (!run) {
      if (packet.id !== undefined)
        this.client.rejectRequest(packet.id, "Unknown Runner thread");
      return;
    }
    const turnId = params.turnId ?? params.turn?.id;
    if (!run.activeTurnId && run.pendingRequestId) {
      const buffered = this.buffered.get(params.threadId) ?? [];
      if (buffered.length >= 512) {
        this.uncertain(run.runId, "启动期间事件过多，需核实历史。");
        return;
      }
      buffered.push(packet);
      this.buffered.set(params.threadId, buffered);
      return;
    }
    if (turnId !== run.activeTurnId || run.terminal) {
      if (packet.id !== undefined)
        this.client.rejectRequest(
          packet.id,
          "Request does not match the active turn",
        );
      return;
    }
    try {
      if (packet.id !== undefined) {
        if (packet.method === "item/tool/call" && params.tool === historyToolName)
          return this.readHistoryTool(run, packet);
        if (packet.method === "item/tool/call" && params.tool === recentHistoryToolName)
          return this.readRecentHistoryTool(run, packet);
        if (packet.method === "item/tool/call" && params.tool === projectInspectionToolName)
          return this.inspectProjectTool(run, packet);
        if (packet.method === "item/tool/call")
          return this.reportResult(run, packet);
        return this.requestUser(run, packet);
      }
      if (packet.method === "turn/started")
        this.publish(run.runId, "turn.started", {}, `started:${turnId}`);
      if (
        ["item/started", "item/completed"].includes(packet.method) &&
        params.item?.id
      ) {
        const item = params.item;
        if (item.type === "fileChange" && Array.isArray(item.changes))
          this.itemMetadata.set(`${run.runId}:${turnId}:${item.id}`, {
            files: item.changes.flatMap((c: any) =>
              [c.path, c.kind?.move_path].filter((p) => typeof p === "string"),
            ),
          });
        if (item.type === "commandExecution")
          this.itemMetadata.set(`${run.runId}:${turnId}:${item.id}`, {
            command: item.command,
            cwd: item.cwd,
          });
        if (this.itemMetadata.size > 100)
          this.itemMetadata.delete(this.itemMetadata.keys().next().value!);
        const phase = packet.method === "item/started" ? "started" : "completed";
        if (item.type === "commandExecution") {
          const command = typeof item.command === "string" ? item.command : "命令执行";
          const suffix = phase === "completed"
            ? Number.isInteger(item.exitCode) ? ` · 退出码 ${item.exitCode}` : ` · ${item.status === "failed" ? "失败" : "已结束"}`
            : "";
          this.displayOutput(run.runId, "command", item.id, phase,
            phase === "completed" && typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", command + suffix);
        } else if (item.type === "fileChange" && phase === "completed") {
          const files = Array.isArray(item.changes) ? item.changes.flatMap((change: any) => typeof change.path === "string" ? [change.path] : []) : [];
          this.displayOutput(run.runId, "file_change", item.id, "completed", files.join("\n"), item.status === "failed" ? "文件修改失败" : "文件修改");
        } else if (item.type === "agentMessage") {
          this.displayOutput(run.runId, "assistant", item.id, phase,
            phase === "completed" && typeof item.text === "string" ? item.text : "", undefined, item.phase);
        }
      }
      if (
        packet.method === "item/agentMessage/delta" &&
        typeof params.delta === "string" &&
        params.delta.length
      ) {
        // Deltas are display-only. Persisted receipts supply task results.
        this.displayOutput(run.runId, "assistant", params.itemId, "delta", params.delta);
      }
      if (packet.method === "item/commandExecution/outputDelta" && typeof params.delta === "string" && params.delta.length)
        this.displayOutput(run.runId, "command", params.itemId, "delta", params.delta);
      if (
        packet.method === "item/completed" &&
        params.item?.type === "agentMessage" &&
        (params.item.phase === "final_answer" || params.item.phase == null)
      )
        this.store.patchRun(run.runId, { output: params.item.text });
      if (packet.method === "turn/completed")
        this.complete(run.runId, params.turn);
    } catch (error) {
      this.uncertain(
        run.runId,
        `Codex 事件处理失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }
  private readHistoryTool(run: RunRecord, packet: RpcPacket) {
    try {
      if (run.snapshot.kind !== "summary" || run.summaryHistory?.version !== 2 || !run.summaryHistoryRead || packet.params.namespace != null || typeof packet.params.callId !== "string" || !packet.params.callId)
        throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "当前运行没有历史分页工具。");
      const native = this.options.captureGuard?.(run.runId);
      native?.assertDispatch();
      if (!this.available || run.terminal || run.cancelRequested)
        throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "总结已结束或正在停止，不再交付历史。");
      const result = readHistoryPage(historyReadInput(run.summaryHistory, run.summaryHistoryCache), run.summaryHistoryRead, packet.params.arguments);
      const summaryProgress = result.state === run.summaryHistoryRead ? run.summaryProgress : summaryReadProgress({ ...run, summaryHistoryRead: result.state });
      this.store.patchRun(run.runId, { summaryHistoryRead: result.state, ...(run.summarySettings ? { summaryProgress } : {}) });
      try {
        this.client.respond(packet.id!, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result.output) }] });
      } catch (error) {
        this.store.patchRun(run.runId, { summaryHistoryRead: run.summaryHistoryRead, summaryProgress: run.summaryProgress });
        throw error;
      }
    } catch (error) {
      if (this.available) this.client.respond(packet.id!, { success: false, contentItems: [{ type: "inputText", text: error instanceof RunnerError ? error.message : "历史分页参数无效，请使用当前 nextCursor。" }] });
    }
  }
  private async inspectProjectTool(run: RunRecord, packet: RpcPacket) {
    try {
      if (run.snapshot.kind !== "summary" || !run.summaryInspection || packet.params.namespace != null || typeof packet.params.callId !== "string")
        throw new RunnerError("PROJECT_INSPECTION_DENIED", "当前运行没有项目检查工具。");
      const native = this.options.captureGuard?.(run.runId);
      native?.assertDispatch();
      if (!this.available || run.terminal || run.cancelRequested)
        throw new RunnerError("PROJECT_INSPECTION_DENIED", "总结已停止，不再读取项目。");
      if (run.summaryInspection.mode === "current")
        this.publish(run.runId, "output.delta", { text: "\n正在查看项目内容…\n" });
      const result = await inspectProject(run.root, packet.params.arguments, run.summaryInspection.root);
      const current = this.getRun(run.runId);
      if (!this.available || current.terminal || current.cancelRequested || current.activeTurnId !== run.activeTurnId || !current.summaryInspection)
        throw new RunnerError("PROJECT_INSPECTION_DENIED", "原总结已结束或正在停止，不再返回项目内容。");
      native?.assertDispatch();
      // Another inspection may finish while this file is read; merge into the latest journal.
      const inspected = this.store.patchRun(run.runId, {
        summaryInspection: {
          ...current.summaryInspection,
          sources: mergeInspectionSources(current.summaryInspection.sources, result.sources),
        },
      });
      try {
        this.client.respond(packet.id!, {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result.output) }],
        });
        if (current.summaryInspection.mode === "current") {
          this.store.patchRun(run.runId, { summaryProgress: { ...summaryReadProgress(inspected), pagesRead: (current.summaryProgress?.pagesRead ?? 0) + 1 } });
          const paths = [...new Set(result.sources.map(s => s.path))];
          const label = paths.includes("native:git") ? "已查看当前 Git 变更和近期提交"
            : paths.includes("native:inventory") ? `已浏览目录 ${packet.params.arguments.path ?? "."}`
              : `已读取 ${paths.slice(0, 5).join("、") || "项目内容"}`;
          this.publish(run.runId, "output.delta", { text: `${label}${result.output.nextCursor ? "（还有内容，可按需继续）" : ""}。\n` });
        }
      } catch (error) {
        this.store.patchRun(run.runId, { summaryInspection: current.summaryInspection });
        throw error;
      }
    } catch (error) {
      if (this.available) {
        try {
          this.client.respond(packet.id!, {
            success: false,
            contentItems: [{ type: "inputText", text: error instanceof RunnerError ? error.message : "无法读取该项目内容，请检查相对路径和继续游标；无法检查的范围应列入待核实。" }],
          });
        } catch {
          // The disconnect listener retains the run for reconciliation.
        }
      }
    }
  }
  private async readRecentHistoryTool(run: RunRecord, packet: RpcPacket) {
    try {
      if (run.snapshot.kind !== "summary" || run.summaryInspection?.mode !== "current" ||
        packet.params.namespace != null || typeof packet.params.callId !== "string" || !packet.params.callId)
        throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "当前运行没有最近历史读取工具。");
      const native = this.options.captureGuard?.(run.runId);
      const assertCurrent = () => {
        native?.assertDispatch();
        const current = this.getRun(run.runId);
        if (!this.available || current.terminal || current.cancelRequested || current.activeTurnId !== run.activeTurnId)
          throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "总结已停止，不再返回历史内容。");
      };
      assertCurrent();
      this.publish(run.runId, "output.delta", { text: "\n正在查看当前项目最近的相关会话…\n" });
      const result = await readRecentHistory(this.client, run.root, packet.params.arguments, {
        excludeThreadIds: this.store.allRuns().flatMap(r => r.snapshot.kind === "summary" && r.threadId ? [r.threadId] : []),
        assertCurrent,
      });
      assertCurrent();
      const current = this.getRun(run.runId);
      const updated = this.store.patchRun(run.runId, { summaryInspection: {
        ...current.summaryInspection!, historySources: [...new Set([...(current.summaryInspection?.historySources ?? []), ...result.sources])],
      } });
      try {
        this.client.respond(packet.id!, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result.output) }] });
      } catch (error) {
        this.store.patchRun(run.runId, { summaryInspection: current.summaryInspection });
        throw error;
      }
      this.store.patchRun(run.runId, { summaryProgress: { ...summaryReadProgress(updated), pagesRead: (current.summaryProgress?.pagesRead ?? 0) + 1 } });
      this.publish(run.runId, "output.delta", { text: result.output.threads
        ? `找到 ${result.output.threads.length} 个相关会话，Codex 将按需选择。\n`
        : `已读取 ${result.sources.length} 条最近记录，正在结合项目现状整理。\n` });
    } catch (error) {
      if (this.available) try {
        this.client.respond(packet.id!, { success: false, contentItems: [{ type: "inputText", text: error instanceof RunnerError ? error.message : "最近会话暂时不可读取，可先检查项目文件并说明背景缺口。" }] });
      } catch { /* Disconnect is reconciled by the transport. */ }
    }
  }
  private parseResult(
    run: RunRecord,
    value: unknown,
  ): NonNullable<RunRecord["result"]> {
    const snapshot = currentSnapshot(run);
    if (snapshot.kind === "summary") {
      let report = value;
      let historyReceipt: unknown;
      if (run.summaryHistory?.version === 2 && value && typeof value === "object") {
        const { historyReceipt: receipt, ...content } = value as Record<string, unknown>;
        historyReceipt = receipt;
        report = content;
      }
      const summary = projectSummarySchema.parse(report);
      if (run.summaryHistory) {
        if (run.summaryHistory.version === 2) {
          if (!run.summaryHistoryRead || run.summaryHistoryRead.nextCursor !== null)
            throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "历史尚未读完，请继续调用 qingdan_read_project_history，nextCursor=" + run.summaryHistoryRead?.nextCursor);
          if (historyReceipt !== (run.summaryHistory.records.length ? run.summaryHistoryRead.previous?.output.receipt : "empty"))
            throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "缺少正确的末页回执 historyReceipt，请使用 replayCursor=" + run.summaryHistoryRead.previous?.cursor + " 重读末页，并原样提交该页 receipt。");
          if (!summary.background || !summary.modules)
            throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "请补充 background 项目背景和 modules 模块当前进度、剩余工作、下一步。");
          const c = run.summaryHistory.coverage;
          const progress = summaryReadProgress(run);
          summary.coverage = { totalRecords: run.summaryHistory.records.length, deliveredRecords: progress.readRecords + progress.cachedRecords,
            ...(run.summaryHistoryCache ? { cachedRecords: progress.cachedRecords } : {}),
            threadCount: c.threadCount, failedThreadCount: c.failedThreadCount, excludedForkCount: c.excludedForkCount,
            missingFinalCount: c.missingFinalCount, incompleteTurnCount: c.incompleteTurnCount,
            partial: !!(c.failedThreadCount || c.excludedForkCount || c.missingFinalCount || c.omittedCount || c.truncatedCount) };
          if (JSON.stringify(summary).length > 24000)
            throw new RunnerError("PROJECT_HISTORY_UNAVAILABLE", "项目进度报告过长（含数据覆盖超过 24000 字符），请精简重复内容至 23000 字符以内后重新提交。");
        }
        return projectSummarySchema.parse(validateHistoryReferences(summary, run.summaryHistory));
      }
      if (run.summaryInspection) {
        if (run.summaryInspection.reportFormat === "handoff" && !summary.handoff)
          throw new RunnerError("INVALID_SUMMARY_EVIDENCE", "请补充 handoff 交接字段：技术概况、最近改动、当前停点、修改入口、接手顺序与验收、接手约束。没有依据的列表留空并说明待核实范围。");
        if (run.summaryInspection.mode === "current" && (!summary.background || !summary.modules))
          throw new RunnerError("INVALID_SUMMARY_EVIDENCE", "请提供 background 项目背景和 modules 当前进度、剩余工作及下一步。");
        return validateInspectionReferences(summary, run.summaryInspection.sources, run.summaryInspection.historySources);
      }
      return run.summaryEvidence
        ? validateSummaryReferences(summary, run.summaryEvidence)
        : summary;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("结果必须是对象");
    const legacyIds = "runId" in value || "taskId" in value;
    const parsed = parseRunOutcome(
      legacyIds
        ? value
        : {
            ...value,
            runId: run.runId,
            taskId: snapshot.task.taskRef.taskId,
          },
    );
    if (
      parsed.runId !== run.runId ||
      parsed.taskId !== snapshot.task.taskRef.taskId
    )
      throw Error("结果与当前任务身份不符");
    return parsed;
  }
  private reportResult(run: RunRecord, packet: RpcPacket) {
    const params = packet.params;
    if (
      run.resultChannel !== "tool" ||
      params.tool !== resultToolName ||
      params.namespace != null
    ) {
      this.client.rejectRequest(packet.id!, "Unknown result tool");
      return;
    }
    let result: NonNullable<RunRecord["result"]>;
    try {
      const value = params.arguments;
      if (
        typeof params.callId !== "string" ||
        !params.callId ||
        !value ||
        typeof value !== "object" ||
        "runId" in value ||
        "taskId" in value
      )
        throw Error("Invalid report");
      result = this.parseResult(run, value);
    } catch (error) {
      this.store.patchRun(run.runId, { reportedResult: null });
      this.client.respond(packet.id!, {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text:
              error instanceof RunnerError ? error.message : run.snapshot.kind === "task"
                ? "回执格式无效，请按工具字段重交，不要提供 runId/taskId。changedFiles 必须是项目相对路径，不能使用盘符、绝对路径或 ../；outcome 为 done 时 remainingIssues 必须为空数组，未运行额外测试等验证局限写在 nextTaskNotes；summary 必须非空。不要编造未执行的验证。"
                : run.summaryHistory
                  ? "项目总结回执格式无效。各列表使用包含 text 和可选 evidenceRef 的对象，evidenceRef 只能使用本轮 records 原样的 source 或 native:history。不要引用文件路径或提供 runId/taskId。"
                  : "项目总结回执格式无效，请按工具字段重交。各列表使用包含 text 和可选 evidenceRef 的对象，evidenceRef 只能引用本轮实际读取的文件或 native:git/native:inventory；未读文件请先调用项目检查工具。不要提供 runId/taskId。",
          },
        ],
      });
      return;
    }
    // Save before acknowledging. A receipt cannot finish a still-running turn.
    const reported = this.store.patchRun(run.runId, {
      reportedResult: {
        turnId: run.activeTurnId!,
        callId: params.callId,
        result,
      },
    });
    if (run.summaryInspection?.mode === "current")
      this.store.patchRun(run.runId, { summaryProgress: summaryReadProgress(reported) });
    this.client.respond(packet.id!, {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "本轮结果已记录，等待轮次结束后核验。请用自然语言向用户说明结果。",
        },
      ],
    });
  }
  private complete(
    runId: string,
    turn: Turn,
    cleanupConfirmed = false,
    historyConfirmed = false,
  ) {
    const run = this.getRun(runId);
    if (run.activeTurnId !== turn.id || run.terminal) return;
    if (!["completed", "failed", "interrupted"].includes(turn.status)) return;
    const native = this.options.captureGuard?.(runId);
    if (
      run.resultChannel === "tool" &&
      turn.status === "completed" &&
      !historyConfirmed
    ) {
      // Completion notifications contain only a summary. Read chronological
      // items so a receipt before a later steer can never finish that request.
      if (!this.completionReads.has(turn.id)) {
        const read = this.items(run.threadId!, turn.id)
          .then((items) =>
            this.complete(runId, { ...turn, items }, cleanupConfirmed, true),
          )
          .catch((error) => {
            if (this.currentOperation(native))
              this.uncertain(runId, `任务结果回执需要核实：${String(error)}`);
          })
          .finally(() => this.completionReads.delete(turn.id));
        this.completionReads.set(turn.id, read);
      }
      return;
    }
    const items = turn.items ?? [];
    const currentItems = items.slice(items.findLastIndex(item => item.type === "userMessage") + 1);
    const lastActivity = currentItems.findLastIndex(item => item.type !== "agentMessage");
    const messages = currentItems.filter(
      (item, index): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage" && (item.phase === "final_answer" || (item.phase == null && index > lastActivity)),
    );
    const output = messages.findLast(item => item.phase === "final_answer")?.text
      ?? messages.at(-1)?.text
      ?? (run.resultChannel === "tool" ? "" : run.output);
    let result: RunRecord["result"] = null,
      resultError: string | null = null;
    if (turn.status === "completed")
      try {
        const items = turn.items ?? [];
        const lastInput = items.findLastIndex(
          (item) => item.type === "userMessage",
        );
        const report =
          run.resultChannel === "tool"
            ? items
                .slice(lastInput + 1)
                .findLast(
                  (
                    item,
                  ): item is Extract<ThreadItem, { type: "dynamicToolCall" }> =>
                    item.type === "dynamicToolCall" &&
                    item.tool === resultToolName &&
                    item.namespace == null,
                )
            : undefined;
        if (run.resultChannel === "tool") {
          if (
            !report ||
            report.status !== "completed" ||
            report.success !== true
          )
            throw Error("回执未成功");
          result = this.parseResult(run, report.arguments);
        } else {
          // Old chats retain their JSON results and strict identity checks.
          result = this.parseResult(run, JSON.parse(output));
        }
      } catch {
        resultError =
          "Codex 未提交有效的任务结果回执，需要在同一会话补充或修复。";
      }
    const cancelled =
      run.cancelRequested && (turn.status === "interrupted" || !!run.batch);
    const batchPatch = finishBatchItem(
      run,
      run.snapshot.kind === "task" ? (result as any) : null,
      turn.status,
      cancelled,
    );
    // A terminal model turn does not prove that its background commands have
    // stopped. Keep the local workspace active until both facts are verified.
    // Between-item checkpoints retain their lease and may retain background
    // commands; their final release goes through finishManagedBatch instead.
    if (batchPatch.terminal !== false && !cleanupConfirmed) {
      if (!this.completionCleanups.has(runId)) {
        const cleanup = this.confirmRunStopped(runId, undefined, { readOnly: false, native })
          .then(() => this.complete(runId, turn, true, historyConfirmed))
          .catch((error) => {
            if (this.currentOperation(native)) this.uncertain(runId, String(error));
          })
          .finally(() => this.completionCleanups.delete(runId));
        this.completionCleanups.set(runId, cleanup);
      }
      return;
    }
    const status = cancelled
      ? "cancelled"
      : turn.status !== "completed"
        ? "failed"
        : result
          ? "verifying"
          : "waiting_input";
    this.publish(
      runId,
      "turn.completed",
      {
        status: turn.status as "completed" | "failed" | "interrupted",
        outcome: run.snapshot.kind === "task" ? (result as any) : null,
        summary: run.snapshot.kind === "summary" ? (result as any) : null,
        error:
          turn.status === "completed" ? null : (turn.error?.message ?? null),
        ...(run.resultChannel === "tool" ? { output: boundedFinalOutput(output) } : {}),
      },
      `completed:${turn.id}`,
      {
        terminal: true,
        active: false,
        status,
        result,
        resultValid: result !== null,
        resultError,
        output,
        ...batchPatch,
      },
    );
    if (cancelled)
      this.publish(
        runId,
        "run.cancelled",
        { reason: "已确认当前轮次停止。" },
        `cancelled:${turn.id}`,
      );
    this.resolveRequests(
      runId,
      cancelled ? "cancelled" : "expired",
      cancelled ? "当前运行已停止。" : "当前轮次已结束。",
    );
  }
  private requestUser(run: RunRecord, packet: RpcPacket) {
    const input = packet.method === "item/tool/requestUserInput";
    const approval = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(packet.method);
    if (!input && !approval) {
      this.client.rejectRequest(
        packet.id!,
        "This approval/tool request is not supported by the Runner",
      );
      this.uncertain(
        run.runId,
        `需人工处理不支持的 Codex 请求：${packet.method}`,
      );
      return;
    }
    if (
      [...this.requests.values()].some(
        (r) =>
          r.wireId === packet.id &&
          r.threadId === run.threadId &&
          r.turnId === run.activeTurnId,
      )
    )
      return;
    let questions, metadata;
    try {
      if (input) questions = inputMetadata(packet.params.questions);
      else
        metadata = approvalMetadata(
          run,
          packet.method as any,
          packet.params,
          this.itemMetadata.get(
            `${run.runId}:${run.activeTurnId}:${packet.params.itemId}`,
          ),
        );
      if (
        Buffer.byteLength(JSON.stringify(metadata ?? questions)) > 24_000 ||
        this.pendingRequests(run.runId).length >= 5
      )
        throw Error("request too large");
    } catch {
      this.client.rejectRequest(
        packet.id!,
        "问题或审批内容超出轻单可安全展示的范围，请拆分后重试。",
      );
      return;
    }
    const request: PendingRequest = {
      id: randomUUID(),
      wireId: packet.id!,
      runId: run.runId,
      threadId: run.threadId!,
      turnId: run.activeTurnId!,
      method: packet.method,
      params: packet.params,
      expiresAt: this.now() + 15 * 60_000,
      ...(metadata ? { details: metadata.details } : {}),
      nativeScope: this.itemMetadata.get(
        `${run.runId}:${run.activeTurnId}:${packet.params.itemId}`,
      ),
      ...(questions ? { questions } : {}),
    };
    this.requests.set(request.id, request);
    const pendingInteractions = [
      ...(run.pendingInteractions ?? []),
      { id: request.id, threadId: request.threadId, turnId: request.turnId },
    ];
    if (input) {
      this.publish(
        run.runId,
        "input.requested",
        { requestId: request.id, questions: questions! },
        `request:${request.id}`,
        { status: "waiting_input", pendingInteractions },
      );
    } else
      this.publish(
        run.runId,
        "approval.requested",
        {
          requestId: request.id,
          ...metadata!,
        },
        `request:${request.id}`,
        { status: "waiting_approval", pendingInteractions },
      );
  }
  private resolveRequest(
    runId: string,
    requestId: string,
    status: "responded" | "expired" | "cancelled",
    reason?: string,
  ) {
    const run = this.getRun(runId),
      item = run.pendingInteractions?.find((r) => r.id === requestId);
    this.requests.delete(requestId);
    const pendingInteractions =
      run.pendingInteractions?.filter((r) => r.id !== requestId) ?? [];
    if (item?.threadId === run.threadId && item.turnId === run.activeTurnId)
      this.publish(
        runId,
        "request.resolved",
        { requestId, status, ...(reason ? { reason } : {}) },
        `request-resolved:${requestId}`,
        { pendingInteractions },
      );
    else if (item) this.store.patchRun(runId, { pendingInteractions });
  }
  private resolveRequests(
    runId: string | undefined,
    status: "expired" | "cancelled",
    reason: string,
  ) {
    for (const run of runId ? [this.getRun(runId)] : this.store.allRuns())
      for (const request of run.pendingInteractions ?? [])
        this.resolveRequest(run.runId, request.id, status, reason);
  }
  expireRequests() {
    for (const request of this.requests.values())
      if (this.now() >= request.expiresAt)
        this.resolveRequest(
          request.runId,
          request.id,
          "expired",
          "问题已超过 15 分钟，请停止或重新核对当前运行。",
        );
  }
  expireRequest(requestId: string) {
    const request = this.requests.get(requestId);
    if (request)
      this.resolveRequest(
        request.runId,
        requestId,
        "expired",
        "响应发送状态无法确认，不会重复回答旧请求。",
      );
  }
  pendingRequests(runId: string) {
    return [...this.requests.values()].filter(
      (request) => request.runId === runId,
    );
  }
  async respondToRequest(requestId: string, response: unknown) {
    this.expireRequests();
    const request = this.requests.get(requestId);
    if (!request)
      throw new RunnerError(
        "REQUEST_NOT_FOUND",
        "审批或问题已结束，需要刷新状态。",
      );
    const run = this.getRun(request.runId);
    const native = this.options.captureGuard?.(run.runId);
    if (
      !this.available ||
      run.terminal ||
      run.cancelRequested ||
      run.threadId !== request.threadId ||
      run.activeTurnId !== request.turnId
    )
      throw new RunnerError("REVISION_CONFLICT", "此问题不属于当前轮次。");
    const parsed = requestResponseSchema.safeParse(response);
    if (!parsed.success)
      throw new RunnerError(
        "VALIDATION_ERROR",
        "仅支持本次批准、拒绝、取消或完整回答问题。",
      );
    response = parsed.data;
    if (request.method === "item/tool/requestUserInput") {
      const answers = (response as any)?.answers;
      const ids = request.questions!;
      if (
        !answers ||
        Object.keys(answers).length !== ids.length ||
        ids.some(
          (q) =>
            !Array.isArray(answers[q.id]?.answers) ||
            answers[q.id].answers.length === 0 ||
            answers[q.id].answers.some(
              (answer: unknown) =>
                typeof answer !== "string" ||
                (q.options?.length &&
                  !q.isOther &&
                  !q.options.some((o) => o.label === answer)),
            ),
        )
      )
        throw new RunnerError("VALIDATION_ERROR", "请逐项回答当前问题。");
    } else if (
      !response ||
      Object.keys(response).length !== 1 ||
      !["accept", "decline", "cancel"].includes((response as any).decision)
    )
      throw new RunnerError(
        "VALIDATION_ERROR",
        "只允许本次审批的同意、拒绝或取消。",
      );
    else if (
      !request.details?.allowedDecisions?.includes(
        (response as any).decision,
      ) ||
      !approvalMetadata(
        run,
        request.method as any,
        request.params,
        request.nativeScope,
      ).details.allowedDecisions?.includes((response as any).decision)
    )
      throw new RunnerError("ACCESS_DENIED", "当前权限不允许此审批决定。");
    native?.assertDispatch();
    this.client.respond(request.wireId, response);
    this.resolveRequest(run.runId, requestId, "responded");
    this.store.patchRun(run.runId, {
      status: this.pendingRequests(run.runId).some(
        (r) => r.method !== "item/tool/requestUserInput",
      )
        ? "waiting_approval"
        : this.pendingRequests(run.runId).length
          ? "waiting_input"
          : "running",
    });
    this.changes.emit("change");
  }
  async respondToCloudRequest(input: NativeRequestResponse) {
    this.expireRequests();
    const request = this.requests.get(input.pendingRequestId);
    if (!request)
      throw new RunnerError(
        "REQUEST_NOT_FOUND",
        "本机问题已过期或连接已变化。",
      );
    if (
      request.runId !== input.runId ||
      request.threadId !== input.threadId ||
      request.turnId !== input.turnId
    )
      throw new RunnerError(
        "REVISION_CONFLICT",
        "响应不属于当前运行的原生请求。",
      );
    await this.respondToRequest(request.id, input.response);
  }
  async advanceBatchRun(
    runId: string,
    guard?: DispatchGuard,
    permit?: NonNullable<RunRecord["batchPermit"]>,
  ): Promise<CommandReceipt> {
    const native = guard?.native ?? this.options.captureGuard?.(runId);
    native?.assertCurrent();
    let run = this.getRun(runId);
    if (
      !run.batch ||
      run.batchPhase !== "ready" ||
      run.terminal ||
      run.cancelRequested ||
      !run.threadId
    )
      throw new RunnerError("BATCH_NOT_READY", "批次尚未满足推进条件。");
    const managed = run.snapshot.kind === "task" && run.snapshot.batch?.managed;
    const repair = permit?.decision === "repair";
    const nextIndex = run.batch.currentIndex + (repair ? 0 : 1);
    const requestId = permit?.permitId ?? `batch-${runId}-${nextIndex + 1}`;
    if (
      managed &&
      (!permit ||
        permit.fromIndex !== run.batch.currentIndex ||
        permit.fromTurnId !== run.activeTurnId ||
        permit.nextIndex !== nextIndex ||
        run.batch.items[permit.fromIndex].completedTurnId !== permit.fromTurnId)
    )
      throw new RunnerError(
        "BATCH_NOT_READY",
        "后续轮次缺少当前完成项的服务端许可。",
      );
    if (repair) {
      const checks = currentSnapshot(run);
      const verification = run.verification;
      const failures = verification?.results.filter((result) => {
        const criterion =
          checks.kind === "task" &&
          checks.task.acceptance.find((c) => c.id === result.criterionId);
        return (
          result.status !== "passed" &&
          criterion &&
          criterion.required &&
          criterion.kind !== "human"
        );
      });
      if (
        !managed ||
        (run.repairCounts?.[String(nextIndex)] ?? 0) >= 1 ||
        verification?.turnId !== run.activeTurnId ||
        !failures?.length ||
        failures.some(
          (result) =>
            result.status !== "failed" ||
            !["predicate", "command_exit"].includes(result.failureKind ?? ""),
        )
      )
        throw new RunnerError(
          "BATCH_NOT_READY",
          "当前项不满足一次自动修复条件，请人工处理。",
        );
    }
    const repairMessage = repair
      ? "本项的机器验收未通过。请只修复当前待办；这是本项唯一一次自动修复，完成后会重新验收所有条件。\n" +
        JSON.stringify(
          run
            .verification!.results.filter((r) => r.status !== "passed")
            .map(({ criterionId, message }) => ({ criterionId, message })),
        )
      : undefined;
    if (nextIndex >= run.batch.items.length)
      throw new RunnerError("BATCH_NOT_READY", "批次已没有后续待办。");
    let sent = false;
    try {
      await guard?.("resume");
      await this.client.request("thread/resume", {
        threadId: run.threadId,
        cwd: run.root,
        approvalPolicy: this.permissions(run.snapshot).approvalPolicy,
        approvalsReviewer: this.permissions(run.snapshot).reviewer,
        sandbox: this.permissions(run.snapshot).sandbox,
        excludeTurns: true,
        developerInstructions: runInstructions("task"),
      });
      await guard?.("turn");
      const current = this.getRun(runId);
      if (
        current.batchPhase !== "ready" ||
        current.cancelRequested ||
        current.batch?.currentIndex !== run.batch!.currentIndex ||
        current.activeTurnId !== run.activeTurnId
      )
        throw new RunnerError("BATCH_NOT_READY", "批次在派发前已变化。");
      // This single persisted pending-turn transition is the internal dispatch
      // journal. A separate command insert would leave a crash window before it.
      const batch = structuredClone(run.batch!);
      batch.currentIndex = nextIndex;
      batch.items[nextIndex].status = "running";
      batch.items[nextIndex].summary = "";
      delete batch.items[nextIndex].completedTurnId;
      native?.assertDispatch();
      run = this.store.patchRun(runId, {
        batch,
        batchPhase: "running",
        active: true,
        terminal: false,
        activeTurnId: null,
        pendingRequestId: requestId,
        launchIntent: "turn_sent",
        output: "",
        result: null,
        resultValid: false,
        resultError: null,
        reportedResult: null,
        verification: undefined,
        ...(permit ? { batchPermit: permit } : {}),
        ...(repair
          ? { repairCounts: { ...run.repairCounts, [nextIndex]: 1 } }
          : {}),
      });
      sent = true;
      const response = await this.client.request(
        "turn/start",
        this.turnParams(run, requestId, repairMessage),
      );
      native?.assertDispatch();
      if (!response.turn?.id)
        throw new RunnerError("CODEX_PROTOCOL_ERROR", "Missing batch turn ID");
      this.mapTurn(runId, response.turn.id);
      this.attachedThreads.add(run.threadId!);
      const receipt: CommandReceipt = {
        commandId: requestId,
        runId,
        status: "accepted",
        threadId: run.threadId,
        turnId: response.turn.id,
      };
      return receipt;
    } catch (error) {
      if (!sent) throw error;
      if (this.currentOperation(native))
        this.uncertain(runId, error instanceof Error ? error.message : "下一项启动结果未知");
      return {
        commandId: requestId,
        runId,
        status: "reconciliation_required",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
    }
  }
  async finishManagedBatch(runId: string, guard: DispatchGuard) {
    const native = guard.native ?? this.options.captureGuard?.(runId);
    const run = this.getRun(runId);
    if (
      run.snapshot.kind !== "task" ||
      !run.snapshot.batch?.managed ||
      run.batchPhase !== "ready" ||
      run.cancelRequested ||
      !run.threadId ||
      !run.batch ||
      run.batch.currentIndex !== run.batch.items.length - 1
    )
      throw new RunnerError("BATCH_NOT_READY", "批次尚未满足结束条件。");
    await guard("turn");
    // Confirm inherited background terminals have stopped before releasing the
    // native workspace lease; a completed model turn alone is not that proof.
    await this.confirmRunStopped(runId, () => guard("turn"), { readOnly: false, native });
    await guard("turn");
    const current = this.getRun(runId);
    if (
      current.cancelRequested ||
      current.batchPhase !== "ready" ||
      current.activeTurnId !== run.activeTurnId
    )
      throw new RunnerError("BATCH_NOT_READY", "批次在结束前已变化。");
    this.store.patchRun(runId, {
      batchPhase: "complete",
      terminal: true,
      active: false,
      status: "verifying",
    });
    this.changes.emit("change");
  }
  async continueRun(
    input: ContinueRunInput,
    guard?: DispatchGuard,
  ): Promise<CommandReceipt> {
    runnerCommandSchema.parse({ type: "continue_run", ...input });
    const native = guard?.native ?? this.options.captureGuard?.(input.runId);
    native?.assertCurrent();
    let run = this.getRun(input.runId);
    this.assertBatchItemUnsealed(run);
    if (run.batchPhase === "complete" || run.batchPhase === "cancelled")
      throw new RunnerError(
        "BATCH_COMPLETE",
        "这批待办已结束，新需求请提交新批次。",
      );
    const readySupplement =
      run.batchPhase === "ready" && input.mode === "steer";
    const accepted = this.store.acceptCommand(
      input.requestId,
      input.runId,
      input,
    );
    if (!accepted.created)
      return (
        (accepted.receipt as CommandReceipt) ?? {
          commandId: input.requestId,
          runId: input.runId,
          status: "reconciliation_required",
          threadId: run.threadId,
          turnId: run.activeTurnId,
        }
      );
    if (
      !run.threadId ||
      !run.activeTurnId ||
      input.expectedTurnId !== run.activeTurnId ||
      run.status === "reconciliation_required"
    )
      throw new RunnerError(
        "REVISION_CONFLICT",
        "先核实当前会话与轮次，再补充要求。",
      );
    if (!readySupplement && (input.mode === "reply") !== run.terminal)
      throw new RunnerError(
        "RUN_BUSY",
        "运行中使用 steer，轮次结束后使用 reply。",
      );
    try {
      if (input.mode === "steer" && !readySupplement) {
        await guard?.("steer");
        this.assertBatchItemUnsealed(this.getRun(run.runId));
        native?.assertDispatch();
        this.store.patchRun(run.runId, { reportedResult: null });
        const result = await this.client.request("turn/steer", {
          threadId: run.threadId,
          expectedTurnId: input.expectedTurnId,
          clientUserMessageId: input.requestId,
          input: [
            {
              type: "text",
              text: runPrompt(currentSnapshot(run), input.message),
              text_elements: [],
            },
          ],
        });
        native?.assertDispatch();
        if (result.turnId !== input.expectedTurnId)
          throw new RunnerError(
            "CODEX_PROTOCOL_ERROR",
            "Steer returned another turn",
          );
      } else {
        await guard?.("resume");
        await this.client.request("thread/resume", {
          threadId: run.threadId!,
          cwd: run.root,
          approvalPolicy: this.permissions(run.snapshot).approvalPolicy,
          approvalsReviewer: this.permissions(run.snapshot).reviewer,
          sandbox: this.permissions(run.snapshot).sandbox,
          excludeTurns: true,
          ...(run.resultChannel === "tool"
            ? { developerInstructions: runInstructions(run.snapshot.kind, summaryMode(run)) }
            : {}),
        });
        await guard?.("turn");
        const batch = run.batch ? structuredClone(run.batch) : undefined;
        if (batch) {
          const item = batch.items[batch.currentIndex];
          item.status = "running";
          item.summary = "";
          delete item.completedTurnId;
        }
        native?.assertDispatch();
        run = this.store.patchRun(run.runId, {
          active: true,
          terminal: false,
          cancelRequested: false,
          activeTurnId: null,
          pendingRequestId: input.requestId,
          launchIntent: "turn_sent",
          output: "",
          result: null,
          resultValid: false,
          resultError: null,
          reportedResult: null,
          ...(batch ? { batch, batchPhase: "running" } : {}),
        });
        const response = await this.client.request(
          "turn/start",
          this.turnParams(run, input.requestId, input.message),
        );
        native?.assertDispatch();
        this.attachedThreads.add(run.threadId!);
        this.mapTurn(run.runId, response.turn.id);
      }
      run = this.getRun(run.runId);
      const receipt: CommandReceipt = {
        commandId: input.requestId,
        runId: run.runId,
        status: "accepted",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
      this.store.saveReceipt(input.requestId, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof RunnerError && error.code === "ITEM_SEALED")
        throw error;
      if (this.currentOperation(native))
        this.uncertain(run.runId, error instanceof Error ? error.message : "补充要求的结果未知");
      return {
        commandId: input.requestId,
        runId: run.runId,
        status: "reconciliation_required",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
    }
  }
  private assertBatchItemUnsealed(run: RunRecord) {
    if (
      run.batchPhase === "ready" &&
      run.snapshot.kind === "task" &&
      run.snapshot.batch?.autoComplete
    )
      throw new RunnerError(
        "ITEM_SEALED",
        "当前清单项已完成。请在清单中重新提交剩余待办。",
      );
  }
  async cancelRun(runId: string): Promise<CommandReceipt> {
    const native = this.options.captureGuard?.(runId);
    this.assertStopAllowed(native);
    const run = this.getRun(runId);
    this.resolveRequests(
      runId,
      "cancelled",
      "用户已请求停止运行，不能继续审批或回答。",
    );
    if (run.batchPhase === "ready") {
      this.store.patchRun(runId, {
        cancelRequested: true,
        status: "cancel_requested",
      });
      try {
        await this.confirmRunStopped(runId, undefined, { readOnly: false, native });
      } catch (error) {
        if (this.currentOperation(native)) this.uncertain(runId, String(error));
        return {
          commandId: `cancel-${runId}`,
          runId,
          status: "reconciliation_required",
          threadId: run.threadId,
          turnId: run.activeTurnId,
        };
      }
      native?.assertCurrent();
      const batch = structuredClone(run.batch!);
      for (let i = batch.currentIndex + 1; i < batch.items.length; i++)
        batch.items[i].status = "cancelled";
      this.publish(
        runId,
        "run.cancelled",
        { reason: "批次已停止，后续待办未启动。" },
        `batch-cancelled:${run.activeTurnId}`,
        {
          batch,
          batchPhase: "cancelled",
          cancelRequested: true,
          terminal: true,
          active: false,
          status: "cancelled",
        },
      );
      return {
        commandId: `cancel-${runId}`,
        runId,
        status: "accepted",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
    }
    if (!run.threadId || !run.activeTurnId) {
      this.uncertain(runId, "无法确认当前轮次，不能宣称已停止。");
      return {
        commandId: `cancel-${runId}`,
        runId,
        status: "reconciliation_required",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
    }
    const receipt: CommandReceipt = {
      commandId: `cancel-${runId}-${run.activeTurnId}`,
      runId,
      status: run.terminal ? "accepted" : "cancel_requested",
      threadId: run.threadId,
      turnId: run.activeTurnId,
    };
    if (run.terminal) return receipt;
    this.store.patchRun(runId, {
      status: "cancel_requested",
      cancelRequested: true,
    });
    try {
      this.assertStopAllowed(native);
      await this.client.request("turn/interrupt", {
        threadId: run.threadId,
        turnId: run.activeTurnId,
      });
    } catch (error) {
      if (this.currentOperation(native)) this.uncertain(runId, String(error));
      return { ...receipt, status: "reconciliation_required" };
    }
    return receipt;
  }
  private async turns(threadId: string): Promise<Turn[]> {
    const result: Turn[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ThreadTurnsListResponse = await this.client.request(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 50,
          sortDirection: "desc",
          itemsView: "full",
        },
      );
      result.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new RunnerError(
          "CODEX_PROTOCOL_ERROR",
          "Invalid or excessive history pagination",
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  async readThread(threadId: string, workspaceId: string) {
    const response = await this.client.request("thread/read", { threadId });
    if (rootKey(response.thread.cwd) !== rootKey(this.root(workspaceId)))
      throw new RunnerError("ACCESS_DENIED", "会话不属于指定项目。");
    return { thread: response.thread, turns: await this.turns(threadId) };
  }
  async reconcileRun(runId: string): Promise<ReconcileResult> {
    const native = this.options.captureGuard?.(runId);
    const run = this.getRun(runId);
    if (run.terminal) return { runId, status: "completed" };
    if (!run.threadId)
      return {
        runId,
        status: "reconciliation_required",
        reason: "thread/start 未取得会话 ID，不能安全重发。",
      };
    try {
      const history = await this.readThread(
        run.threadId,
        run.snapshot.workspaceId,
      );
      native?.assertCurrent();
      // Notifications are live while history RPCs are in flight. Never replace
      // a newer terminal state or a different pending turn with this snapshot.
      const current = this.getRun(runId);
      if (current.terminal) return { runId, status: "completed" };
      if (
        current.activeTurnId !== run.activeTurnId ||
        current.pendingRequestId !== run.pendingRequestId
      )
        return {
          runId,
          status: "reconciliation_required",
          reason: "核实期间当前轮次已变化。",
        };
      const matches = history.turns.filter((turn) =>
        run.pendingRequestId
          ? turn.items.some(
              (item) =>
                item.type === "userMessage" &&
                item.clientId === run.pendingRequestId,
            )
          : turn.id === run.activeTurnId,
      );
      if (matches.length !== 1) {
        this.uncertain(runId, "历史中没有唯一匹配轮次；禁止自动重发。");
        return { runId, status: "reconciliation_required" };
      }
      const turn = matches[0];
      // Between-item cancellation has its own event key. Reusing the already
      // persisted completed:<turn> event would dedupe away the stop transition.
      if (
        current.batchPhase === "ready" &&
        current.cancelRequested &&
        turn.status !== "inProgress"
      ) {
        await this.cancelRun(runId);
        return {
          runId,
          status: this.getRun(runId).terminal
            ? "completed"
            : "reconciliation_required",
        };
      }
      const pending = run.pendingRequestId;
      this.mapTurn(runId, turn.id, {
        status: current.cancelRequested
          ? "cancel_requested"
          : ["waiting_input", "waiting_approval"].includes(current.status)
            ? current.status
            : "running",
        ...(pending === `initial-${runId}`
          ? {
              launchResult: {
                status: "started" as const,
                runId,
                threadId: run.threadId,
                turnId: turn.id,
              },
            }
          : {}),
      });
      if (turn.status !== "inProgress") {
        if (!turn.items.some((item) => item.type === "agentMessage"))
          turn.items = await this.items(run.threadId, turn.id);
        native?.assertCurrent();
        this.complete(runId, turn);
        await this.completionReads.get(turn.id);
        await this.completionCleanups.get(runId);
      } else {
        await this.client.request("thread/resume", {
          threadId: run.threadId,
          cwd: run.root,
          approvalPolicy: this.permissions(run.snapshot).approvalPolicy,
          approvalsReviewer: this.permissions(run.snapshot).reviewer,
          sandbox: this.permissions(run.snapshot).sandbox,
          excludeTurns: true,
          ...(run.resultChannel === "tool"
            ? { developerInstructions: runInstructions(run.snapshot.kind, summaryMode(run)) }
            : {}),
        });
        native?.assertCurrent();
        this.attachedThreads.add(run.threadId);
      }
      if (pending)
        this.store.saveReceipt(pending, {
          commandId: pending,
          runId,
          status: "accepted",
          threadId: run.threadId,
          turnId: turn.id,
        });
      this.syncDesktop(runId);
      return {
        runId,
        status: this.getRun(runId).terminal
          ? "completed"
          : this.getRun(runId).status === "reconciliation_required"
            ? "reconciliation_required"
            : "running",
      };
    } catch (error) {
      if (!this.currentOperation(native)) return { runId, status: "reconciliation_required", reason: "原执行占用已改变。" };
      this.attachedThreads.delete(run.threadId);
      // A live completion can be resolving its receipt while this independent
      // history query fails. Let that authoritative result settle first.
      if (run.activeTurnId) await this.completionReads.get(run.activeTurnId);
      await this.completionCleanups.get(runId);
      if (!this.currentOperation(native)) return { runId, status: "reconciliation_required", reason: "原执行占用已改变。" };
      const current = this.getRun(runId);
      if (current.terminal) return { runId, status: "completed" };
      if (
        current.activeTurnId !== run.activeTurnId ||
        current.pendingRequestId !== run.pendingRequestId
      )
        return {
          runId,
          status: "reconciliation_required",
          reason: "核实期间当前轮次已变化。",
        };
      this.uncertain(runId, String(error));
      return {
        runId,
        status: "reconciliation_required",
        reason: String(error),
      };
    }
  }
  /** Recover only a uniquely recorded request identity; no completion cleanup
   * or interrupt is allowed on the inspect_only path. */
  async identifyRunTurn(runId: string) {
    const native = this.options.captureGuard?.(runId);
    const run = this.getRun(runId);
    if (!run.threadId) throw new RunnerError("RECONCILIATION_REQUIRED", "原会话 ID 未知，不能猜测匹配。");
    const history = await this.readThread(run.threadId, run.snapshot.workspaceId);
    native?.assertCurrent();
    const current = this.getRun(runId);
    if (current.threadId !== run.threadId || current.activeTurnId !== run.activeTurnId || current.pendingRequestId !== run.pendingRequestId)
      throw new RunnerError("RECONCILIATION_REQUIRED", "核对期间原轮次已改变。");
    const matches = history.turns.filter(turn => run.pendingRequestId
      ? turn.items.some(item => item.type === "userMessage" && item.clientId === run.pendingRequestId)
      : turn.id === run.activeTurnId);
    if (matches.length !== 1)
      throw new RunnerError("RECONCILIATION_REQUIRED", "历史中没有唯一匹配轮次，不能声明已停止。");
    if (run.pendingRequestId) this.mapTurn(runId, matches[0].id);
    return { status: matches[0].status };
  }
  private assertStopAllowed(native?: NativeOperationGuard) {
    native?.assertCurrent();
    if (native?.canStop() === false)
      throw new RunnerError("RECONCILIATION_REQUIRED", "当前票据仅允许只读核对；请先请求停止。");
  }
  async confirmRunStopped(runId: string, guard?: () => Promise<void>, options?: { readOnly: boolean; native?: NativeOperationGuard }) {
    const native = options?.native ?? this.options.captureGuard?.(runId);
    const run = this.getRun(runId);
    const unchanged = () => {
      native?.assertCurrent();
      const current = this.getRun(runId);
      if (
        !this.available || !run.threadId || !run.activeTurnId ||
        current.threadId !== run.threadId || current.activeTurnId !== run.activeTurnId ||
        current.pendingRequestId
      )
        throw new RunnerError("RECONCILIATION_REQUIRED", "原轮次或 Codex 连接已改变，尚未确认停止。");
    };
    const checkHistory = async () => {
      unchanged();
      const history = await this.readThread(run.threadId!, run.snapshot.workspaceId);
      unchanged();
      const matches = history.turns.filter(turn => turn.id === run.activeTurnId);
      if (
        matches.length !== 1 ||
        !["completed", "failed", "interrupted"].includes(matches[0].status) ||
        history.turns.some(turn => turn.status === "inProgress")
      )
        throw new RunnerError("RECONCILIATION_REQUIRED", "原会话仍有活动或不确定轮次，尚未确认停止。");
      await guard?.();
      unchanged();
    };
    await checkHistory();
    // After restart this thread must be loaded before terminal inspection.
    // This attaches the mapped thread only; it never starts a model turn.
    if (!this.attachedThreads.has(run.threadId!)) {
      await this.client.request("thread/resume", {
        threadId: run.threadId!, cwd: run.root, approvalPolicy: this.permissions(run.snapshot).approvalPolicy,
        approvalsReviewer: this.permissions(run.snapshot).reviewer,
        sandbox: this.permissions(run.snapshot).sandbox, excludeTurns: true,
        ...(run.resultChannel === "tool"
          ? { developerInstructions: runInstructions(run.snapshot.kind, summaryMode(run)) }
          : {}),
      });
      await checkHistory();
      this.attachedThreads.add(run.threadId!);
    }
    if (options?.readOnly || native?.canStop() === false)
      await confirmThreadTerminalsStopped(this.client, run.threadId!);
    else
      await stopThreadTerminals(this.client, run.threadId!, () => this.assertStopAllowed(native));
    await checkHistory();
  }
  async confirmPausedCheckpoint(runId: string, guard: () => Promise<void>) {
    const native = this.options.captureGuard?.(runId);
    const run=this.getRun(runId);
    const unchanged=()=>{
      native?.assertCurrent();
      const current=this.getRun(runId);
      if(current.terminal||!current.active||current.batchPhase!=="ready"||current.pendingRequestId||current.threadId!==run.threadId||current.activeTurnId!==run.activeTurnId)
        throw new RunnerError("RECONCILIATION_REQUIRED","原暂停点已改变，不能恢复租约。");
    };
    const checkHistory=async()=>{
      const history=await this.readThread(run.threadId!,run.snapshot.workspaceId);
      unchanged();
      const matches=history.turns.filter(turn=>turn.id===run.activeTurnId);
      if(matches.length!==1||matches[0].status!=="completed"||history.turns.some(turn=>turn.status==="inProgress"))
        throw new RunnerError("RECONCILIATION_REQUIRED","原会话仍有活动或不确定轮次，不能恢复租约。");
    };
    unchanged();
    await checkHistory();
    await guard();
    // Attach the already completed thread to this new app-server before
    // inspecting its background terminals. This never sends turn/start.
    await this.client.request("thread/resume",{
      threadId:run.threadId!,cwd:run.root,approvalPolicy:this.permissions(run.snapshot).approvalPolicy,
      approvalsReviewer:this.permissions(run.snapshot).reviewer,
      sandbox:this.permissions(run.snapshot).sandbox,excludeTurns:true,
      developerInstructions:runInstructions(run.snapshot.kind, summaryMode(run)),
    });
    await checkHistory();
    await stopThreadTerminals(this.client,run.threadId!,()=>this.assertStopAllowed(native));
    await checkHistory();
    await guard();
    unchanged();
  }
  private async items(threadId: string, turnId: string): Promise<ThreadItem[]> {
    const items: ThreadItem[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ThreadItemsListResponse = await this.client.request(
        "thread/items/list",
        { threadId, turnId, cursor, limit: 100, sortDirection: "asc" },
      );
      if (page.data.some((entry) => entry.turnId !== turnId))
        throw new RunnerError(
          "CODEX_PROTOCOL_ERROR",
          "Item history belongs to another turn",
        );
      items.push(...page.data.map((entry) => entry.item));
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new RunnerError(
          "CODEX_PROTOCOL_ERROR",
          "Invalid item pagination",
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async listProjects(options?: { workspaceId: string; limit: number }) {
    const all: Thread[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    const projects = options
      ? [[options.workspaceId, this.root(options.workspaceId)] as const]
      : [...this.workspaces];
    if (!projects.length) return [];
    do {
      const page: ThreadListResponse = await this.client.request(
        "thread/list",
        {
          cursor,
          limit: options?.limit ?? 100,
          ...(options
            ? { sortKey: "updated_at" as const, useStateDbOnly: true }
            : {}),
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
          modelProviders: [],
          cwd: projects.map(([, root]) => root),
        },
      );
      all.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new RunnerError(
          "CODEX_PROTOCOL_ERROR",
          "Invalid project pagination",
        );
      if (cursor) seen.add(cursor);
    } while (cursor && !options);
    return projects.map(([workspaceId, root]) => ({
      workspaceId,
      root,
      threads: all
        .filter((thread) => rootKey(thread.cwd) === rootKey(root))
        .map((thread) => ({
          threadId: thread.id,
          title:
            thread.name ?? (options ? "" : thread.preview?.slice(0, 200)) ?? "",
          cwd: thread.cwd,
          source: thread.source,
          updatedAt: thread.updatedAt,
          status: thread.status,
        })),
    }));
  }
  private async until<T>(get: () => T | null, timeoutMs: number): Promise<T> {
    const ready = get();
    if (ready !== null) return ready;
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        this.changes.off("change", check);
      };
      const check = () => {
        const value = get();
        if (value !== null) {
          stop();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        stop();
        reject(
          new RunnerError(
            "WAIT_TIMEOUT",
            "等待结果超时；可查询或核实已有运行。",
          ),
        );
      }, timeoutMs);
      this.changes.on("change", check);
      check();
    });
  }
  waitForRun(runId: string, timeoutMs = 300000) {
    return this.until(() => {
      const run = this.getRun(runId);
      return run.terminal ? run : null;
    }, timeoutMs);
  }
  waitForRequest(runId: string, timeoutMs = 30000) {
    return this.until(() => this.pendingRequests(runId)[0] ?? null, timeoutMs);
  }
  async *events(afterCursor = 0): AsyncIterable<RunnerEvent> {
    let cursor = afterCursor;
    while (!this.closed) {
      const rows = this.store.eventsAfter(cursor);
      if (rows.length) {
        for (const row of rows) {
          cursor = row.cursor;
          yield row.event;
        }
      } else
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.changes.off("change", wake);
            resolve();
          };
          this.changes.once("change", wake);
        });
    }
  }
  async close(options?: { stopRuns?: boolean; waitDesktop?: boolean }) {
    if (this.closed) return;
    for (const run of options?.stopRuns === false ? [] : this.store.allRuns())
      if (run.active && run.activeTurnId) {
        await this.cancelRun(run.runId).catch(() => {});
        await this.waitForRun(
          run.runId,
          this.options.shutdownTimeoutMs ?? 1500,
        ).catch(() => {});
        if (!this.getRun(run.runId).terminal)
          await this.reconcileRun(run.runId);
      }
    await this.client.close();
    await Promise.allSettled(this.completionCleanups.values());
    if (options?.waitDesktop !== false)
      await Promise.allSettled(this.desktopRefreshes.values());
    this.closed = true;
    this.changes.emit("change");
  }
}
