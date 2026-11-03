import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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
import type { ProcessOptions } from "./supervisor";
import { RunnerStore } from "./store";
import { RpcError, RunnerError } from "./errors";
import { canonicalRoot, rootKey, assertGitBaseline } from "./workspace";
import { outputSchema, runPrompt } from "./prompt";
import { stopThreadTerminals } from "./process-cleanup";
import type {
  CommandReceipt,
  LaunchResult,
  PendingRequest,
  ReconcileResult,
  RunRecord,
  Workspace,
} from "./types";

export type AdapterOptions = ProcessOptions & {
  store: RunnerStore;
  runnerId: string;
  workspaces: Workspace[];
  requestTimeoutMs?: number;
  model?: string;
  effort?: ReasoningEffort;
};
export class CodexAdapter {
  private client: CodexClient;
  private changes = new EventEmitter();
  private workspaces = new Map<string, string>();
  private buffered = new Map<string, RpcPacket[]>();
  private requests = new Map<string, PendingRequest>();
  private attachedThreads = new Set<string>();
  private cancellationCleanups = new Map<string, Promise<void>>();
  private closed = false;
  private connected = false;
  private store: RunnerStore;
  constructor(private options: AdapterOptions) {
    this.store = options.store;
    this.client = new CodexClient(options);
    this.client.on("notification", (packet: RpcPacket) => this.receive(packet));
    this.client.on("request", (packet: RpcPacket) => this.receive(packet));
    this.client.on("disconnect", () => {
      this.attachedThreads.clear();
      for (const run of this.store.allRuns())
        if (run.active)
          this.uncertain(run.runId, "Codex 连接中断，需先核实运行结果。");
      this.changes.emit("change");
    });
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
  private uncertain(runId: string, reason: string): LaunchResult {
    if (!this.getRun(runId).terminal)
      this.store.patchRun(runId, {
        status: "reconciliation_required",
        resultError: reason,
      });
    this.changes.emit("change");
    return { status: "reconciliation_required", runId, reason };
  }
  private turnParams(
    run: RunRecord,
    requestId: string,
    message?: string,
  ): TurnStartParams {
    return {
      threadId: run.threadId!,
      clientUserMessageId: requestId,
      input: [
        {
          type: "text",
          text: runPrompt(run.snapshot, requestId, message),
          text_elements: [],
        },
      ],
      cwd: run.root,
      approvalPolicy: "on-request",
      sandboxPolicy:
        run.snapshot.kind === "summary"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [run.root],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      outputSchema: outputSchema(run.snapshot.kind),
    };
  }
  async startFreshRun(input: ExecutionSnapshot): Promise<LaunchResult> {
    if (this.closed) throw new RunnerError("CODEX_CLOSED", "Adapter is closed");
    const snapshot = parseExecutionSnapshot(input),
      root = this.root(snapshot.workspaceId);
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
      return (
        run.launchResult ?? {
          status: "reconciliation_required",
          runId: run.runId,
          reason: "此前启动结果不确定，禁止重复派发。",
        }
      );
    }
    await assertGitBaseline(root, snapshot.context.gitBaseline);
    const { run, created } = this.store.prepareRun(snapshot, root);
    if (!created)
      return (
        run.launchResult ?? this.uncertain(run.runId, "已有运行正在准备。")
      );
    this.publish(
      run.runId,
      "run.accepted",
      { status: "preparing" },
      "accepted",
    );
    this.store.patchRun(run.runId, { launchIntent: "thread_requested" });
    try {
      const result = await this.client.request("thread/start", {
        cwd: root,
        sandbox: snapshot.kind === "summary" ? "read-only" : "workspace-write",
        approvalPolicy: "on-request",
        ephemeral: false,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
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
      await this.client.request("thread/name/set", {
        threadId: result.thread.id,
        name: `轻单 · ${snapshot.kind === "summary" ? "项目总结" : snapshot.task.text.slice(0, 40)} · ${run.runId}`,
      });
      const requestId = `initial-${run.runId}`;
      const prepared = this.store.patchRun(run.runId, {
        launchIntent: "turn_sent",
        pendingRequestId: requestId,
      });
      const response = await this.client.request(
        "turn/start",
        this.turnParams(prepared, requestId),
      );
      if (!response.turn?.id)
        throw new RunnerError("CODEX_PROTOCOL_ERROR", "Missing turn ID");
      const launch: LaunchResult = {
        status: "started",
        runId: run.runId,
        threadId: result.thread.id,
        turnId: response.turn.id,
      };
      this.mapTurn(run.runId, response.turn.id, { launchResult: launch });
      return launch;
    } catch (error) {
      const current = this.getRun(run.runId);
      if (
        error instanceof RpcError &&
        current.launchIntent === "thread_requested"
      )
        this.store.patchRun(run.runId, {
          status: "failed",
          active: false,
          terminal: true,
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
    const run = this.store.patchRun(runId, {
      activeTurnId: turnId,
      pendingRequestId: null,
      launchIntent: "started",
      status: "running",
      terminal: false,
      ...extra,
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
      if (packet.id !== undefined) return this.requestUser(run, packet);
      if (packet.method === "turn/started")
        this.publish(run.runId, "turn.started", {}, `started:${turnId}`);
      if (
        packet.method === "item/agentMessage/delta" &&
        typeof params.delta === "string" &&
        params.delta.length
      ) {
        // Deltas are advisory. Only the final persisted message supplies results.
        for (let offset = 0; offset < params.delta.length; offset += 32000)
          this.publish(run.runId, "output.delta", {
            text: params.delta.slice(offset, offset + 32000),
          });
      }
      if (
        packet.method === "item/completed" &&
        params.item?.type === "agentMessage" &&
        params.item.phase !== "commentary"
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
  private complete(runId: string, turn: Turn, cleanupConfirmed = false) {
    const run = this.getRun(runId);
    if (run.activeTurnId !== turn.id || run.terminal) return;
    if (!["completed", "failed", "interrupted"].includes(turn.status)) return;
    if (
      run.cancelRequested &&
      turn.status === "interrupted" &&
      !cleanupConfirmed
    ) {
      if (!this.cancellationCleanups.has(runId)) {
        const cleanup = stopThreadTerminals(this.client, run.threadId!)
          .then(() => this.complete(runId, turn, true))
          .catch((error) => {
            this.uncertain(runId, String(error));
          })
          .finally(() => this.cancellationCleanups.delete(runId));
        this.cancellationCleanups.set(runId, cleanup);
      }
      return;
    }
    const messages = (turn.items ?? []).filter(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage" && item.phase !== "commentary",
    );
    const output = messages.at(-1)?.text ?? run.output;
    let result: RunRecord["result"] = null,
      resultError: string | null = null;
    if (turn.status === "completed")
      try {
        const value = JSON.parse(output);
        if (run.snapshot.kind === "summary")
          result = projectSummarySchema.parse(value);
        else {
          const parsed = parseRunOutcome(value);
          if (
            parsed.runId !== runId ||
            parsed.taskId !== run.snapshot.task.taskRef.taskId
          )
            throw Error("结果与当前任务身份不符");
          result = parsed;
        }
      } catch {
        resultError =
          "Codex 未返回有效的结构化 JSON 结果，需要在同一会话补充或修复。";
      }
    const cancelled = turn.status === "interrupted" && run.cancelRequested;
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
      },
    );
    if (cancelled)
      this.publish(
        runId,
        "run.cancelled",
        { reason: "已确认当前轮次停止。" },
        `cancelled:${turn.id}`,
      );
    for (const [id, request] of this.requests)
      if (request.runId === runId) this.requests.delete(id);
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
    const request: PendingRequest = {
      id: randomUUID(),
      wireId: packet.id!,
      runId: run.runId,
      threadId: run.threadId!,
      turnId: run.activeTurnId!,
      method: packet.method,
      params: packet.params,
    };
    this.requests.set(request.id, request);
    if (input) {
      const questions = packet.params.questions.map((question: any) => ({
        id: question.id,
        prompt: question.question,
      }));
      this.publish(
        run.runId,
        "input.requested",
        { requestId: request.id, questions },
        `request:${request.id}`,
        { status: "waiting_input" },
      );
    } else
      this.publish(
        run.runId,
        "approval.requested",
        {
          requestId: request.id,
          description: packet.params.reason || "Codex 请求执行审批。",
        },
        `request:${request.id}`,
        { status: "waiting_approval" },
      );
  }
  pendingRequests(runId: string) {
    return [...this.requests.values()].filter(
      (request) => request.runId === runId,
    );
  }
  async respondToRequest(requestId: string, response: unknown) {
    const request = this.requests.get(requestId);
    if (!request)
      throw new RunnerError(
        "REQUEST_NOT_FOUND",
        "审批或问题已结束，需要刷新状态。",
      );
    const run = this.getRun(request.runId);
    if (run.terminal || run.activeTurnId !== request.turnId)
      throw new RunnerError("REVISION_CONFLICT", "此问题不属于当前轮次。");
    if (request.method === "item/tool/requestUserInput") {
      const answers = (response as any)?.answers;
      const ids = request.params.questions as { id: string }[];
      if (
        !answers ||
        Object.keys(answers).length !== ids.length ||
        ids.some(
          (q) =>
            !Array.isArray(answers[q.id]?.answers) ||
            answers[q.id].answers.length === 0 ||
            answers[q.id].answers.some(
              (answer: unknown) => typeof answer !== "string",
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
    this.client.respond(request.wireId, response);
    this.requests.delete(requestId);
    this.store.patchRun(run.runId, { status: "running" });
    this.changes.emit("change");
  }
  async continueRun(input: ContinueRunInput): Promise<CommandReceipt> {
    runnerCommandSchema.parse({ type: "continue_run", ...input });
    let run = this.getRun(input.runId);
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
    if ((input.mode === "reply") !== run.terminal)
      throw new RunnerError(
        "RUN_BUSY",
        "运行中使用 steer，轮次结束后使用 reply。",
      );
    try {
      if (input.mode === "steer") {
        const result = await this.client.request("turn/steer", {
          threadId: run.threadId,
          expectedTurnId: input.expectedTurnId,
          clientUserMessageId: input.requestId,
          input: [
            {
              type: "text",
              text: runPrompt(run.snapshot, input.requestId, input.message),
              text_elements: [],
            },
          ],
        });
        if (result.turnId !== input.expectedTurnId)
          throw new RunnerError(
            "CODEX_PROTOCOL_ERROR",
            "Steer returned another turn",
          );
      } else {
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
        });
        await this.client.request("thread/resume", {
          threadId: run.threadId!,
          cwd: run.root,
          approvalPolicy: "on-request",
          sandbox:
            run.snapshot.kind === "summary" ? "read-only" : "workspace-write",
          excludeTurns: true,
        });
        const response = await this.client.request(
          "turn/start",
          this.turnParams(run, input.requestId, input.message),
        );
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
      this.uncertain(
        run.runId,
        error instanceof Error ? error.message : "补充要求的结果未知",
      );
      return {
        commandId: input.requestId,
        runId: run.runId,
        status: "reconciliation_required",
        threadId: run.threadId,
        turnId: run.activeTurnId,
      };
    }
  }
  async cancelRun(runId: string): Promise<CommandReceipt> {
    const run = this.getRun(runId);
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
      await this.client.request("turn/interrupt", {
        threadId: run.threadId,
        turnId: run.activeTurnId,
      });
    } catch (error) {
      this.uncertain(runId, String(error));
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
        this.complete(runId, turn);
        await this.cancellationCleanups.get(runId);
      } else {
        await this.client.request("thread/resume", {
          threadId: run.threadId,
          cwd: run.root,
          excludeTurns: true,
        });
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
      return {
        runId,
        status: this.getRun(runId).terminal
          ? "completed"
          : this.getRun(runId).status === "reconciliation_required"
            ? "reconciliation_required"
            : "running",
      };
    } catch (error) {
      this.attachedThreads.delete(run.threadId);
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
  async listProjects() {
    const all: Thread[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    if (!this.workspaces.size) return [];
    do {
      const page: ThreadListResponse = await this.client.request(
        "thread/list",
        {
          cursor,
          limit: 100,
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
          modelProviders: [],
          cwd: [...this.workspaces.values()],
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
    } while (cursor);
    return [...this.workspaces].map(([workspaceId, root]) => ({
      workspaceId,
      root,
      threads: all
        .filter((thread) => rootKey(thread.cwd) === rootKey(root))
        .map((thread) => ({
          threadId: thread.id,
          title: thread.name ?? thread.preview?.slice(0, 200) ?? "",
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
  async close() {
    if (this.closed) return;
    for (const run of this.store.allRuns())
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
    await Promise.allSettled(this.cancellationCleanups.values());
    this.closed = true;
    this.changes.emit("change");
  }
}
