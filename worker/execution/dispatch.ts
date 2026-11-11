import type { Env } from "../types";
import { body, check, json, HttpError } from "../http";
import type {
  BatchItem,
  BatchProgress,
  ExecutionSnapshot,
  RunnerCommand,
  RunnerEvent,
  TaskSpec,
} from "../../shared/agent/contracts";
import { parseExecutionSnapshot } from "../../shared/agent/schemas";
import {
  executionAckSchema,
  executionContextSchema,
  executionEventsSchema,
  executionPollSchema,
  executionReportSchema,
  executionToolSchemas,
  manualIntentSchema,
} from "../../shared/agent/execution";
import type {
  ExecutionProjectContext,
  ExecutionRunView,
  ExecutionToolName,
  ExecutionRunResult,
  NativeSummaryContext,
} from "../../shared/agent/execution";
import { authorizeExecution, type ExecutionPrincipal } from "./execution-auth";
import { canonical, hash, materialize, type StoredCommand } from "./outbox";
import type { DeviceRow, WorkspaceView } from "./types";
import { z } from "zod";
import { ProjectSummaries, projectActionSchemas } from "./project-summary";
import { callAgentChecklist } from "../checklist-client";
import { BatchQueue, initialQueue, isManaged, type QueueState } from "./batch-queue";
import { batchGateSchema, queueControlSchema, leaseRecoverySchema } from "../../shared/agent/queue";
import { executionRespondSchema, nativeResponsesSchema, nativeResponseAckSchema } from "../../shared/agent/permissions";
import { ExecutionRequestInbox } from "./request-inbox";
import {
  ChecklistWritebacks,
  scheduleExecutionAlarm,
} from "./checklist-writeback";

interface StoredRun {
  queueState?: QueueState;
  summaryContext?: NativeSummaryContext;
  principal: ExecutionPrincipal;
  snapshot: ExecutionSnapshot;
  view: ExecutionRunView;
  commands: StoredCommand[];
  reportCommandId: string | null;
  outputBytes: number;
  truncated: boolean;
}
const runKey = (id: string) => "exec:run:" + id;
const seqKey = (runId: string, seq: number) =>
  `exec:event:${runId}:${String(seq).padStart(16, "0")}`;
const byteLength = (value: unknown) =>
  new TextEncoder().encode(canonical(value)).length;
function cancelUnfinishedBatchItems(batch?: BatchProgress) {
  for (const item of batch?.items ?? [])
    if (item.status !== "done") item.status = "cancelled";
}
const manualBatchItem = (
  taskId: string,
  instruction: string,
  acceptance?: string,
): BatchItem => ({
  taskId,
  text: instruction,
  instruction,
  acceptance: [
    {
      id: "manual-review",
      kind: "human",
      description: acceptance || "由用户检查本次试运行结果。",
      required: true,
    },
  ],
});
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  check(value.success, "执行请求格式无效。", 400);
  return value.data;
}

// Invoked only by RunnerHub under its blockConcurrencyWhile gate. Every mutation
// is durable before returning; envelopes never change after first delivery.
export class ExecutionDispatch {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
  ) {}
  private writebacks() {
    return new ChecklistWritebacks(this.storage, this.env);
  }
  private queue() { return new BatchQueue(this.storage, this.env); }
  private requests() { return new ExecutionRequestInbox(this.storage,this.env); }
  private projects(p: ExecutionPrincipal) {
    return new ProjectSummaries(this.storage, this.env, async (input) => {
      const intent = await this.intent(p, input);
      return (await this.tool(p, "codex_create_run", intent.input)) as {
        runId: string;
      };
    });
  }
  async retryWritebacks() {
    await this.writebacks().retryDue();
  }
  private async save(r: StoredRun) {
    r.view.updatedAt = new Date().toISOString();
    await this.storage.put(runKey(r.view.runId), r);
  }
  private async cleanupTerminal(r: StoredRun) {
    if (!r.view.terminal || !r.view.stopConfirmed) return;
    if (isManaged(r) && !["completed", "cancelled"].includes(r.view.queue?.phase ?? "")) return;
    if (isManaged(r) && await this.storage.get("exec:queue-workspace:" + r.view.workspaceId) === r.view.runId)
      await this.storage.delete("exec:queue-workspace:" + r.view.workspaceId);
    await this.storage.delete("exec:pending:" + r.view.runId);
    if ((await this.storage.get<string>("exec:active")) === r.view.runId)
      await this.storage.delete("exec:active");
  }
  private async context(p: ExecutionPrincipal, workspace: WorkspaceView) {
    const stamp = await this.storage.get<{
      authEpoch: number;
      revision: number;
    }>("exec:context-auth:" + workspace.workspaceId);
    if (
      stamp?.authEpoch !== p.authEpoch ||
      stamp.revision !== workspace.revision
    )
      return undefined;
    return this.storage.get<ExecutionProjectContext>(
      "exec:context:" + workspace.workspaceId,
    );
  }
  private async run(p: ExecutionPrincipal, id: string) {
    const r = await this.storage.get<StoredRun>(runKey(id));
    check(
      r && canonical(r.principal) === canonical(p),
      "运行不存在或无权访问。",
      403,
    );
    await authorizeExecution(this.env, p);
    return r;
  }
  private async reserve(p: ExecutionPrincipal, id: string, value: unknown) {
    const digest = await hash(value);
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO agent_execution_requests VALUES(?,?,?,?,?)",
    )
      .bind(p.ownerId, id, digest, p.runnerId, p.bindingId)
      .run();
    const old = await this.env.DB.prepare(
      "SELECT payload_hash,runner_id,binding_id FROM agent_execution_requests WHERE owner_id=? AND request_id=?",
    )
      .bind(p.ownerId, id)
      .first<{ payload_hash: string; runner_id: string; binding_id: string }>();
    check(
      old?.payload_hash === digest &&
        old.runner_id === p.runnerId &&
        old.binding_id === p.bindingId,
      "请求编号已用于不同内容。",
      409,
    );
  }
  async fetch(request: Request) {
    const input = await body(request, 2_000_000),
      action = new URL(request.url).pathname.slice("/execution/".length);
    if (action.startsWith("native/"))
      return json(await this.native(action.slice(7), input));
    const p = input.principal as ExecutionPrincipal;
    await authorizeExecution(this.env, p);
    if (action.startsWith("project-")) {
      check(
        this.env.PROJECT_SUMMARY_ENABLED === "true",
        "项目总结尚未启用。",
        404,
      );
      const operation = action.slice(8) as keyof typeof projectActionSchemas;
      check(
        Object.hasOwn(projectActionSchemas, operation),
        "项目总结接口不存在。",
        404,
      );
      return json(await this.projects(p).act(p, operation, input.input));
    }
    if (action === "intent") return json(await this.intent(p, input.input));
    if (action === "respond") {
      const value=parse(executionRespondSchema,input.input);
      const r=await this.run(p,value.runId);
      await this.reserve(p,"respond:"+value.requestId,value);
      return json(await this.requests().respond(r,value));
    }
    if (action === "queue") {
      const value = parse(queueControlSchema, input.input);
      const r = await this.run(p, value.runId);
      await this.reserve(p, "queue:" + value.requestId, value);
      return json(await this.queue().control(r, value));
    }
    if (action === "tool")
      return json(
        await this.tool(p, input.name as ExecutionToolName, input.input),
      );
    if (action === "runs") {
      const ids = await this.storage.list<string>({
        prefix: `exec:list:${p.bindingId}:`,
        reverse: true,
        limit: 20,
      });
      const runs = [];
      for (const id of ids.values()) {
        const r = await this.storage.get<StoredRun>(runKey(id));
        if (r && canonical(r.principal) === canonical(p))
          runs.push(await this.requests().decorate(r,await this.queue().decorate(r,await this.writebacks().decorate(r))));
      }
      return json({ runs });
    }
    check(false, "接口不存在。", 404);
  }
  private async intent(p: ExecutionPrincipal, value: unknown) {
    const input = parse(manualIntentSchema, value);
    check(input.bindingId === p.bindingId, "绑定不匹配。", 403);
    check(
      input.bindingRevision === p.bindingRevision,
      "绑定已更改，请刷新后重试。",
      409,
    );
    await this.reserve(p, "intent:" + input.requestId, input);
    const key = "exec:intent:" + p.ownerId + ":" + input.requestId;
    const old = await this.storage.get<{ input: unknown }>(key);
    if (old) return old;
    const { binding, workspace } = await authorizeExecution(this.env, p),
      context = await this.context(p, workspace);
    check(context, "请先连接设备并同步项目上下文。", 409);
    const runId = crypto.randomUUID(),
      snapshotId = crypto.randomUUID(),
      now = new Date().toISOString();
    let task: TaskSpec | null = null;
    const linked = input.sourceTasks
      ? await callAgentChecklist(this.env, p, {
          action: "snapshot",
          tasks: input.sourceTasks,
        })
      : undefined;
    const batch = linked
      ? {
          items: linked.items as BatchItem[],
          autoComplete: input.autoComplete ?? false,
        }
      : input.items && {
          items: input.items.map(({ instruction, acceptance }, i) =>
            manualBatchItem(`${runId}-item-${i + 1}`, instruction, acceptance),
          ),
        };
    if (batch && this.env.BATCH_QUEUE_ENABLED === "true")
      Object.assign(batch, { managed: true });
    if (input.kind === "task") {
      const first =
        batch?.items[0] ??
        manualBatchItem(runId, input.instruction!, input.acceptance);
      task = {
        text: first.text,
        instruction: first.instruction,
        acceptance: first.acceptance,
        dependsOn: [],
        priority: 2,
        dueAt: null,
        taskRef: first.source?.taskRef ?? {
          canvasId: binding.canvas_id,
          noteId: "manual-trial",
          taskId: first.taskId,
        },
        planId: "manual-trial:" + runId,
        sourceTextHash: await hash(first.text),
        specRevision: first.source?.specRevision ?? 1,
        specHash: "0".repeat(64),
        specStatus: "ready",
        createdByMessageId: input.requestId,
      };
      task.specHash = await hash({ ...task, specHash: undefined });
    }
    const snapshot = parseExecutionSnapshot({
      snapshotId,
      runId,
      ownerId: p.ownerId,
      bindingId: p.bindingId,
      bindingRevision: p.bindingRevision,
      workspaceId: binding.workspace_id,
      kind: input.kind,
      executionPermissions:{profile:input.kind === "summary" ? "read_only" : input.executionPermissions?.profile ?? "workspace_manual",network:false},
      task,
      ...(batch ? { batch } : {}),
      summaryRevision: 0,
      memoryEpoch: 0,
      sourceRefs: [],
      payloadHash: "0".repeat(64),
      capturedAt: now,
      allowedCheckIds: workspace.checks.map((c) => c.checkId),
      context: {
        projectSummary: null,
        decisions:
          input.kind === "summary" && input.instruction
            ? ["用户本次总结要求：" + input.instruction]
            : [],
        previousTaskNotes: [],
        gitBaseline: context.gitBaseline,
      },
    });
    snapshot.payloadHash = await hash({ ...snapshot, payloadHash: undefined });
    check(byteLength(snapshot) <= 90000, "试运行快照超过大小限制。", 413);
    const result = {
      input: {
        requestId: input.requestId,
        runId,
        bindingId: p.bindingId,
        bindingRevision: p.bindingRevision,
        kind: input.kind,
        snapshotId,
        payloadHash: snapshot.payloadHash,
      },
    };
    await this.storage.put({
      [key]: result,
      ["exec:snapshot:" + snapshotId]: {
        principal: p,
        snapshot,
        input: result.input,
      },
    });
    return result;
  }
  private async append(r: StoredRun, payload: RunnerCommand) {
    const stopping = payload.type === "cancel_run";
    const previousStop = r.commands.at(-1);
    // Repeated stop requests share the already durable cancellation command.
    // Reserve one extra journal slot for stopping a run at its command limit.
    if (stopping && previousStop?.payload.type === "cancel_run") return previousStop.receipt;
    check(r.commands.length < (stopping ? 201 : 200), "运行命令已达上限。", 409);
    if (
      !stopping &&
      !r.view.terminal &&
      !(await this.storage.get("exec:pending:" + r.view.runId))
    )
      check(
        (await this.storage.list({ prefix: "exec:pending:", limit: 100 }))
          .size < 100,
        "待处理试运行已达上限。",
        409,
      );
    const receipt = {
      runId: r.view.runId,
      commandId: crypto.randomUUID(),
      status: "accepted" as const,
      acceptedAt: new Date().toISOString(),
    };
    // A cancellation retires launch/reply redelivery. This is NOT an ACK or
    // proof of stopping; only a native terminal stop report releases the run.
    if (payload.type === "cancel_run")
      for (const c of r.commands) c.settled = true;
    r.commands.push({
      payload,
      receipt,
      envelope: null,
      ack: null,
      sequence: r.commands.length + 1,
      eventFloor: r.view.lastSeq,
      afterLeaseEpoch:
        payload.type === "continue_run" && payload.mode === "reply"
          ? Math.max(0, ...r.commands.map((c) => c.envelope?.leaseEpoch ?? 0))
          : 0,
    });
    r.view.commandId = receipt.commandId;
    r.view.updatedAt = receipt.acceptedAt;
    // Batch progress is replaceable report data. It must not exhaust the
    // command journal budget or prevent a user from cancelling a batch.
    const { batch: _, queue: _queueView, ...commandView } = r.view;
    const { queueState: _queueState, ...commandRecord } = r;
    check(
      stopping || byteLength({ ...commandRecord, view: commandView }) + byteLength(payload) + 1000 <=
        110000,
      "运行记录已达大小上限，请新建试运行。",
      413,
    );
    await this.storage.put({
      [runKey(r.view.runId)]: r,
      ["exec:pending:" + r.view.runId]: r.view.runId,
      ["exec:receipt:" + r.principal.ownerId + ":" + payload.requestId]:
        receipt,
      [`exec:list:${r.principal.bindingId}:${r.view.createdAt}:${r.view.runId}`]:
        r.view.runId,
      ...(isManaged(r) && payload.type === "create_run"
        ? { ["exec:queue-workspace:" + r.view.workspaceId]: r.view.runId }
        : {}),
    });
    return receipt;
  }
  async tool(
    p: ExecutionPrincipal,
    name: ExecutionToolName,
    value: unknown,
  ): Promise<unknown> {
    check(name in executionToolSchemas, "工具不存在。", 400);
    const input = parse(executionToolSchemas[name] as z.ZodType<any>, value);
    const { device, workspace } = await authorizeExecution(this.env, p);
    if (name === "codex_list_projects") {
      check(input.runnerId === p.runnerId, "设备不匹配。", 403);
      const context = await this.context(p, workspace);
      return {
        projects: input.cursor
          ? []
          : [
              {
                ...workspace,
                runnerId: p.runnerId,
                bindingId: p.bindingId,
                online:
                  !!device.last_seen_at &&
                  Date.now() - device.last_seen_at < 45000,
                context: context || null,
              },
            ],
        nextCursor: null,
      };
    }
    if (name === "codex_get_run")
      return this.view(
        await this.run(p, input.runId),
        input.afterSeq ?? 0,
        input.limit ?? 50,
      );
    await this.reserve(p, input.requestId, { name, input });
    const receiptKey = "exec:receipt:" + p.ownerId + ":" + input.requestId;
    const previous = await this.storage.get(receiptKey);
    if (previous) {
      const completed = await this.storage.get<StoredRun>(runKey(input.runId));
      if (completed) {
        if (isManaged(completed) && !completed.view.queue) await this.queue().initialize(completed);
        await this.cleanupTerminal(completed);
      }
      return previous;
    }
    const recovered = await this.storage.get<StoredRun>(runKey(input.runId));
    const recoveredCommand = recovered?.commands.find(
      (c) => c.payload.requestId === input.requestId,
    );
    if (recoveredCommand) {
      check(
        canonical(recovered!.principal) === canonical(p),
        "运行未授权。",
        403,
      );
      await this.storage.put(receiptKey, recoveredCommand.receipt);
      await this.cleanupTerminal(recovered!);
      return recoveredCommand.receipt;
    }
    let r: StoredRun;
    if (name === "codex_create_run") {
      const authorized = await this.storage.get<{
        principal: ExecutionPrincipal;
        snapshot: ExecutionSnapshot;
        input: unknown;
      }>("exec:snapshot:" + input.snapshotId);
      check(
        authorized &&
          canonical(authorized.principal) === canonical(p) &&
          canonical(authorized.input) === canonical(input),
        "运行快照未经授权或已失效。",
        403,
      );
      if (
        authorized.snapshot.kind === "task" &&
        authorized.snapshot.batch?.items.some((item) => item.source)
      ) {
        await callAgentChecklist(this.env, p, {
          action: "snapshot",
          tasks: authorized.snapshot.batch.items.map((item) => ({
            noteId: item.source!.taskRef.noteId,
            taskId: item.source!.taskRef.taskId,
            generation: item.source!.generation,
            specRevision: item.source!.specRevision,
          })),
        });
      }
      check(
        !(await this.storage.get(runKey(input.runId))),
        "运行已存在。",
        409,
      );
      const now = new Date().toISOString();
      const batch =
        authorized.snapshot.kind === "task" && authorized.snapshot.batch;
      const occupied = await this.storage.get<string>("exec:queue-workspace:" + workspace.workspaceId);
      check(!occupied, "此项目仍有未完成的批次，请先继续或停止该批次。", 409);
      r = {
        principal: p,
        snapshot: authorized.snapshot,
        commands: [],
        reportCommandId: null,
        outputBytes: 0,
        truncated: false,
        ...(batch && batch.managed ? { queueState: initialQueue() } : {}),
        view: {
          runId: input.runId,
          bindingId: p.bindingId,
          workspaceId: workspace.workspaceId,
          kind: input.kind,
          status: "queued",
          threadId: null,
          turnId: null,
          terminal: false,
          stopConfirmed: false,
          reportRevision: 0,
          commandId: "",
          createdAt: now,
          updatedAt: now,
          lastSeq: 0,
          ...(batch
            ? {
                batch: {
                  currentIndex: 0,
                  items: batch.items.map(({ taskId, text }) => ({
                    taskId,
                    text,
                    status: "pending",
                    summary: "",
                  })),
                },
              }
            : {}),
        },
      };
    } else {
      r = await this.run(p, input.runId);
      if (name === "codex_continue_run") {
        check(
          !(
            r.snapshot.kind === "task" &&
            r.snapshot.batch?.autoComplete &&
            r.view.batch?.items[r.view.batch.currentIndex]?.status === "done"
          ),
          "该待办已完成并进入清单回写，请修改未完成项后另行提交。",
          409,
        );
        check(
          input.expectedTurnId === r.view.turnId && r.view.threadId,
          "轮次已更改。",
          409,
        );
        check(
          r.view.status !== "cancel_requested" &&
            r.view.status !== "reconciliation_required",
          "运行状态不允许继续。",
          409,
        );
        if (input.mode === "steer")
          check(
            !r.view.terminal &&
              ["running", "waiting_input", "waiting_approval"].includes(
                r.view.status,
              ),
            "没有可调整的活动轮次。",
            409,
          );
        else {
          check(
            r.view.terminal && r.view.stopConfirmed,
            "回复需要先确认上轮停止。",
            409,
          );
          check(
            !r.view.batch ||
              (r.view.status !== "cancelled" &&
                !r.view.batch.items.every((item) => item.status === "done")),
            "此批次已结束，请另行提交新任务。",
            409,
          );
        }
        r.view.status = input.mode === "reply" ? "queued" : r.view.status;
        r.view.terminal = false;
        r.view.stopConfirmed = false;
        if (input.mode === "reply") await this.queue().reply(r);
      } else {
        const undispatched = r.commands.every((c) => !c.envelope);
        if (undispatched) {
          r.view.status = "cancelled";
          r.view.terminal = true;
          r.view.stopConfirmed = true;
          cancelUnfinishedBatchItems(r.view.batch);
        } else if (r.view.terminal && r.view.stopConfirmed && isManaged(r)) {
          r.view.status = "cancelled";
          cancelUnfinishedBatchItems(r.view.batch);
        } else if (!(r.view.terminal && r.view.stopConfirmed)) {
          r.view.status = "cancel_requested";
          r.view.terminal = false;
          r.view.stopConfirmed = false;
        }
        await this.queue().cancel(r);
      }
    }
    const payload = {
      type: name.replace("codex_", ""),
      ...input,
    } as RunnerCommand;
    const receipt = await this.append(r, payload);
    if (name === "codex_create_run" && isManaged(r)) {
      await this.queue().initialize(r);
      await this.storage.put("exec:queue-workspace:" + r.view.workspaceId, r.view.runId);
    }
    if (name === "codex_create_run")
      await this.storage.put(
        `exec:list:${p.bindingId}:${r.view.createdAt}:${r.view.runId}`,
        r.view.runId,
      );
    await this.cleanupTerminal(r);
    if (name === "codex_cancel_run") await this.requests().expire(r);
    await this.storage.put(receiptKey, receipt);
    return receipt;
  }
  private async view(
    r: StoredRun,
    afterSeq: number,
    limit: number,
  ): Promise<ExecutionRunResult> {
    await this.writebacks().flushRun(r.view.runId);
    const entries = await this.storage.list<RunnerEvent>({
      prefix: `exec:event:${r.view.runId}:`,
      startAfter: seqKey(r.view.runId, afterSeq),
      limit: limit + 1,
    });
    const all = [...entries.values()];
    let size = 0;
    const events: RunnerEvent[] = [];
    for (const e of all.slice(0, limit)) {
      const bytes = byteLength(e);
      if (size + bytes > 200000) break;
      events.push(e);
      size += bytes;
    }
    return {
      run: await this.requests().decorate(r,await this.queue().decorate(r,await this.writebacks().decorate(r))),
      events,
      nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
      hasMore: all.length > events.length,
      truncated: r.truncated,
    };
  }
  private async native(action: string, input: Record<string, unknown>) {
    const runnerId = String(input.runnerId),
      authEpoch = Number(input.authEpoch),
      data = input.input;
    const d = await this.env.DB.prepare(
      "SELECT * FROM agent_devices WHERE runner_id=? AND auth_epoch=? AND revoked_at IS NULL",
    )
      .bind(runnerId, authEpoch)
      .first<DeviceRow>();
    check(d, "设备授权失效。", 401);
    const schemas = {
      context: executionContextSchema,
      poll: executionPollSchema,
      ack: executionAckSchema,
      events: executionEventsSchema,
      report: executionReportSchema,
      "batch-gate": batchGateSchema,
      "recover-lease": leaseRecoverySchema,
      responses: nativeResponsesSchema,
      "response-ack": nativeResponseAckSchema,
    };
    check(action in schemas, "接口不存在。", 404);
    const value = parse(
      schemas[action as keyof typeof schemas] as z.ZodType<any>,
      data,
    );
    check(
      value.connectionEpoch === d.connection_epoch &&
        d.connection_epoch > 0 &&
        d.last_seen_at &&
        Date.now() - d.last_seen_at < 45000,
      "设备连接已过期。",
      409,
    );
    if (action === "batch-gate") {
      const r = await this.nativeRun(d, value.runId);
      return this.queue().gate(r, value);
    }
    if (action === "recover-lease") {
      const r=await this.nativeRun(d,value.runId);
      if(value.phase==="inspect"&&r.commands.find(c=>c.receipt.commandId===r.view.commandId)?.payload.type==="cancel_run")return {decision:"cancel"};
      const command=r.commands.find(c=>c.receipt.commandId===value.commandId);
      check(isManaged(r)&&command?.envelope&&command.payload.type!=="cancel_run"&&value.commandId===r.view.commandId&&command.envelope.leaseEpoch===value.leaseEpoch,"恢复请求没有原派单与租约。",409);
      const ticket=await this.queue().recovery(r,value);
      if(!ticket)return {decision:"wait"};
      if(value.phase==="inspect")return {decision:"inspect",recoveryId:ticket.recoveryId};
      check(value.recoveryId===ticket.recoveryId,"恢复票据已更改。",409);
      const lease=await this.env.DB.prepare("SELECT workspace_id,run_id,lease_epoch,expires_at FROM agent_workspace_leases WHERE runner_id=? AND workspace_id=? AND run_id=?")
        .bind(d.runner_id,r.view.workspaceId,r.view.runId).first<{workspace_id:string;run_id:string;lease_epoch:number;expires_at:number}>();
      check(lease&&lease.lease_epoch===value.leaseEpoch,"原租约占用已改变。",409);
      const key=`exec:lease-recovery:${ticket.recoveryId}`;
      let receipt=await this.storage.get<{workspaceId:string;runId:string;leaseEpoch:number;expiresAt:number}>(key);
      if(!receipt) {
        receipt={workspaceId:r.view.workspaceId,runId:r.view.runId,leaseEpoch:value.leaseEpoch,expiresAt:Date.now()+60000};
        // Commit the exact expiry before D1. A crash or lost ACK retries this
        // same bounded renewal, never extends it again or changes lease identity.
        await this.storage.put(key,receipt);
      }
      const renewed=await this.env.DB.prepare("UPDATE agent_workspace_leases SET expires_at=MAX(expires_at,?) WHERE runner_id=? AND workspace_id=? AND run_id=? AND lease_epoch=?")
        .bind(receipt.expiresAt,d.runner_id,receipt.workspaceId,receipt.runId,receipt.leaseEpoch).run();
      check(renewed.meta.changes===1,"原租约占用已改变。",409);
      return {decision:"recovered",recoveryId:ticket.recoveryId,lease:receipt};
    }
    if (action === "responses") return this.requests().poll(await this.nativeRun(d,value.runId));
    if (action === "response-ack") return this.requests().acknowledge(await this.nativeRun(d,value.runId),value);
    if (action === "context") {
      const workspaces = JSON.parse(d.workspaces_json) as WorkspaceView[];
      const allowed = new Set(workspaces.map((w) => w.workspaceId));
      check(
        new Set(
          value.contexts.map((c: ExecutionProjectContext) => c.workspaceId),
        ).size === value.contexts.length,
        "重复项目。",
        400,
      );
      for (const c of value.contexts as ExecutionProjectContext[]) {
        check(allowed.has(c.workspaceId), "项目未授权。", 403);
        check(
          Date.parse(c.capturedAt) <= Date.now() + 60000,
          "上下文时间无效。",
          400,
        );
      }
      for (const c of value.contexts as ExecutionProjectContext[]) {
        const old = await this.storage.get<ExecutionProjectContext>(
          "exec:context:" + c.workspaceId,
        );
        if (!old || Date.parse(c.capturedAt) > Date.parse(old.capturedAt))
          await this.storage.put({
            ["exec:context:" + c.workspaceId]: c,
            ["exec:context-auth:" + c.workspaceId]: {
              authEpoch: d.auth_epoch,
              revision: workspaces.find((w) => w.workspaceId === c.workspaceId)!
                .revision,
            },
          });
        else if (Date.parse(c.capturedAt) === Date.parse(old.capturedAt))
          check(canonical(c) === canonical(old), "上下文版本冲突。", 409);
      }
      return { ok: true };
    }
    if (action === "poll") return this.poll(d);
    if (action === "ack") {
      const commandRun = await this.storage.get<string>(
        "exec:command-run:" + value.commandId,
      );
      check(commandRun, "命令不存在。", 409);
      const r = await this.nativeRun(d, commandRun),
        command = r.commands.find(
          (c) => c.receipt.commandId === value.commandId,
        )!;
      const { connectionEpoch: _, ...ack } = value;
      check(command.envelope, "命令未派发。", 409);
      if (ack.status === "stored" && command.payload.type !== "cancel_run" && value.commandId === r.view.commandId)
        await this.queue().validateDispatch(r);
      const isBatch = r.snapshot.kind === "task" && !!r.snapshot.batch;
      // An applied batch command replays its stored ACK before each automatic
      // turn. A newer command may have arrived since the Runner last polled.
      const supersededBatchAdvance =
        isBatch &&
        command.ack?.status === "applied" &&
        value.commandId !== r.view.commandId;
      const response = {
        ok: true,
        ...(ack.status === "stored" &&
        (command.settled || supersededBatchAdvance)
          ? { superseded: true }
          : {}),
      };
      const ackKey = `exec:ack:${value.commandId}:${value.status}`,
        ackHash = await hash(ack),
        oldAck = await this.storage.get<string>(ackKey);
      if (oldAck) {
        check(oldAck === ackHash, "命令回执冲突。", 409);
        return response;
      }
      if (command.ack) {
        if (canonical(command.ack) === canonical(ack)) return response;
        check(
          (command.ack.status === "stored" &&
            ["applied", "uncertain", "rejected"].includes(ack.status)) ||
            (isBatch &&
              command.ack.status === "uncertain" &&
              ack.status === "applied"),
          "命令回执冲突。",
          409,
        );
      }
      command.ack = ack;
      if (
        (ack.status === "uncertain" || ack.status === "rejected") &&
        !command.settled &&
        value.commandId === r.view.commandId
      ) {
        if (r.view.status !== "cancel_requested")
          r.view.status = "reconciliation_required";
        r.view.terminal = false;
        r.view.stopConfirmed = false;
      }
      r.view.updatedAt = new Date().toISOString();
      await this.storage.put({ [ackKey]: ackHash, [runKey(r.view.runId)]: r });
      return response;
    }
    if (action === "events") {
      const ids = [];
      for (const event of value.events as RunnerEvent[]) {
        check(byteLength(event) <= 110000, "事件超过大小限制。", 413);
        check(event.runnerId === runnerId, "事件设备不匹配。", 403);
        const r = await this.nativeRun(d, event.runId),
          key = "exec:event-id:" + event.eventId,
          h = await hash(event),
          previous = await this.storage.get<{ hash: string }>(key);
        if (previous) {
          check(previous.hash === h, "事件编号冲突。", 409);
          ids.push(event.eventId);
          continue;
        }
        const sameSeq = await this.storage.get<RunnerEvent>(
          seqKey(event.runId, event.seq),
        );
        check(!sameSeq, "事件序号冲突。", 409);
        check(event.seq > r.view.lastSeq, "事件顺序无效。", 409);
        let stored = event;
        if (isManaged(r) && event.turnId && ["turn.completed", "verification.completed"].includes(event.type)) {
          const proof = await this.storage.get<RunnerEvent>(`exec:queue-proof:${event.runId}:${event.turnId}:${event.type}`);
          check(!proof || (proof.threadId === event.threadId && canonical(proof.payload) === canonical(event.payload)), "同一轮的验收来源不可更改。", 409);
          if (event.type === "verification.completed") check(byteLength(event.payload) <= 90000, "验收凭据超过大小限制。", 413);
        }
        if (event.type === "output.delta") {
          const room = Math.max(0, 1_000_000 - r.outputBytes);
          const encoded = new TextEncoder().encode(event.payload.text);
          if (encoded.length > room) {
            r.truncated = true;
            stored = {
              ...event,
              payload: {
                text:
                  new TextDecoder()
                    .decode(encoded.slice(0, room))
                    .replace(/\uFFFD$/u, "") || "[output truncated]",
              },
            };
          }
          r.outputBytes += Math.min(room, encoded.length);
        }
        r.view.lastSeq = event.seq;
        const requestUpdates=await this.requests().stageEvent(r,event);
        // Events are ordered history. Current state comes only from persisted,
        // command-scoped report revisions, never cross-machine timestamps.
        await this.storage.put({
          [key]: { hash: h },
          [seqKey(event.runId, event.seq)]: stored,
          [runKey(event.runId)]: r,
          ...requestUpdates,
          ...(r.snapshot.kind === "summary" && event.type === "turn.completed"
            ? { ["project:result:" + event.runId]: stored }
            : {}),
          ...(isManaged(r) && event.turnId && ["turn.completed", "verification.completed"].includes(event.type)
            ? { [`exec:queue-proof:${event.runId}:${event.turnId}:${event.type}`]: stored }
            : {}),
        });
        if (r.snapshot.kind === "summary")
          await this.projects(r.principal).state(r.principal);
        ids.push(event.eventId);
      }
      return { eventIds: ids };
    }
    const r = await this.nativeRun(d, value.runId),
      reportKey = `exec:report:${value.runId}:${value.revision}`,
      reportHash = await hash({ ...value, connectionEpoch: undefined }),
      old = await this.storage.get<string>(reportKey);
    const progress = value.batch as BatchProgress | undefined;
    if (progress) {
      const batch = r.snapshot.kind === "task" && r.snapshot.batch;
      check(
        batch &&
          progress.items.length === batch.items.length &&
          batch.items.every(
            ({ taskId, text }, index) =>
              progress.items[index].taskId === taskId &&
              progress.items[index].text === text,
          ),
        "批次进度与派单任务不匹配。",
        409,
      );
    }
    if (old) {
      check(old === reportHash, "报告版本冲突。", 409);
      await this.writebacks().flushRun(r.view.runId);
      await this.cleanupTerminal(r);
      return {
        ok: true,
        ignored: true,
        ...(value.terminal && value.stopConfirmed ? { settled: true } : {}),
      };
    }
    if (value.revision <= r.view.reportRevision)
      return { ok: true, ignored: true };
    const command = r.commands.find(
      (c) => c.receipt.commandId === value.commandId,
    );
    check(command?.envelope, "报告命令不存在。", 409);
    const onlyPendingCancels =
      value.terminal &&
      value.stopConfirmed &&
      r.view.status === "cancel_requested" &&
      r.commands
        .slice(r.commands.indexOf(command) + 1)
        .every((c) => c.payload.type === "cancel_run");
    if (value.commandId !== r.view.commandId && !onlyPendingCancels)
      return { ok: true, ignored: true };
    check(
      !(r.view.terminal && r.view.stopConfirmed) ||
        (value.terminal && value.stopConfirmed),
      "已确认停止的命令不能恢复为活动状态。",
      409,
    );
    check(
      !r.view.threadId || !value.threadId || r.view.threadId === value.threadId,
      "会话不匹配。",
      409,
    );
    if (value.summaryContext) {
      check(
        r.snapshot.kind === "summary" &&
          value.summaryContext.workspaceId === r.snapshot.workspaceId,
        "总结来源上下文与执行项目不一致。",
        409,
      );
      check(
        !r.summaryContext ||
          canonical(r.summaryContext) === canonical(value.summaryContext),
        "总结来源上下文不可更换。",
        409,
      );
      r.summaryContext = value.summaryContext;
    }
    r.view.threadId = value.threadId ?? r.view.threadId;
    r.view.turnId = value.turnId ?? r.view.turnId;
    r.view.terminal = value.terminal;
    r.view.stopConfirmed = value.stopConfirmed;
    r.view.error = value.error;
    if (progress) r.view.batch = progress;
    r.view.status =
      r.view.status === "cancel_requested"
        ? value.stopConfirmed
          ? "cancelled"
          : "cancel_requested"
        : value.status;
    if (value.terminal && value.stopConfirmed) {
      if (r.view.status === "cancelled")
        cancelUnfinishedBatchItems(r.view.batch);
      for (const c of r.commands) c.settled = true;
    }
    if (isManaged(r)) await this.queue().observe(r);
    r.view.updatedAt = new Date().toISOString();
    const writebackUpdates = await this.writebacks().stage(r);
    // Queue observation may persist its progress before this receipt is saved.
    // Advance the report identity only in the receipt commit, so a crash in
    // between still accepts the same revision and finishes terminal settlement.
    r.view.reportRevision = value.revision;
    r.reportCommandId = value.commandId;
    await this.storage.put({
      [reportKey]: reportHash,
      [runKey(r.view.runId)]: r,
      ...writebackUpdates,
    });
    await scheduleExecutionAlarm(this.storage);
    await this.writebacks().flushRun(r.view.runId);
    await this.cleanupTerminal(r);
    await this.requests().expire(r);
    if (r.snapshot.kind === "summary")
      await this.projects(r.principal).state(r.principal);
    return {
      ok: true,
      ...(value.terminal && value.stopConfirmed ? { settled: true } : {}),
    };
  }
  private async nativeRun(d: DeviceRow, id: string) {
    const r = await this.storage.get<StoredRun>(runKey(id));
    check(
      r &&
        r.principal.runnerId === d.runner_id &&
        r.principal.ownerId === d.owner_id &&
        r.principal.authEpoch === d.auth_epoch,
      "运行未授权。",
      403,
    );
    await authorizeExecution(this.env, r.principal);
    return r;
  }
  private async poll(d: DeviceRow) {
    await this.retryWritebacks();
    const offers: { runId: string; workspaceId: string }[] = [],
      deliveries: {
        envelope: NonNullable<StoredCommand["envelope"]>;
        snapshot: ExecutionSnapshot;
      }[] = [];
    const pending = await this.storage.list<string>({
      prefix: "exec:pending:",
      limit: 100,
    });
    let active = await this.storage.get<string>("exec:active");
    const candidates = active
      ? new Set([active, ...pending.values()])
      : pending.values();
    for (const runId of candidates) {
      if (active && active !== runId) continue;
      let r: StoredRun;
      try {
        r = await this.nativeRun(d, runId);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 403)) throw error;
        const stale = await this.storage.get<StoredRun>(runKey(runId));
        if (stale && !stale.commands.some((c) => c.envelope))
          await this.storage.delete("exec:pending:" + runId);
        continue;
      }
      if (r.view.terminal && r.view.stopConfirmed) {
        await this.cleanupTerminal(r);
        if (active === runId) active = undefined;
        continue;
      }
      if (r.view.status === "reconciliation_required") continue;
      // A stored ACK only confirms journaling. Keep the command at the head
      // until native records an outcome or cancellation retires it.
      const command = r.commands.find(
        (c) => !c.settled && (!c.ack || c.ack.status === "stored"),
      );
      if (!command) continue;
      const leases = await this.env.DB.prepare(
        "SELECT run_id,workspace_id,lease_epoch,expires_at FROM agent_workspace_leases WHERE runner_id=? LIMIT 101",
      )
        .bind(d.runner_id)
        .all<{
          run_id: string;
          workspace_id: string;
          lease_epoch: number;
          expires_at: number;
        }>();
      if (leases.results.some((l) => l.run_id !== runId)) continue;
      const lease = leases.results.find(
        (l) => l.run_id === runId && l.workspace_id === r.view.workspaceId,
      );
      if (!lease) {
        if (!command.envelope) {
          offers.push({ runId, workspaceId: r.view.workspaceId });
          break;
        }
        r.view.status = "reconciliation_required";
        await this.save(r);
        continue;
      }
      if (lease.expires_at <= Date.now() || lease.lease_epoch < 1) {
        r.view.status = "reconciliation_required";
        await this.save(r);
        continue;
      }
      if (lease.lease_epoch <= (command.afterLeaseEpoch ?? 0)) continue;
      if (
        command.envelope &&
        (command.envelope.leaseEpoch !== lease.lease_epoch ||
          Date.parse(command.envelope.expiresAt) <= Date.now())
      ) {
        r.view.status = "reconciliation_required";
        await this.save(r);
        continue;
      }
      const envelope = await materialize(
        command,
        r.principal.bindingRevision,
        r.principal.authEpoch,
        lease.lease_epoch,
      );
      await this.storage.put({
        [runKey(runId)]: r,
        ["exec:command-run:" + envelope.commandId]: runId,
        "exec:active": runId,
      });
      active = runId;
      deliveries.push({ envelope, snapshot: r.snapshot });
      break;
    }
    return { offers, deliveries };
  }
}
