import { z } from "zod";
import type { Env } from "../types";
import type { ProjectContext } from "../../shared/agent/project";
import type {
  ExecutionSnapshot,
  RunnerEvent,
  RunnerCommand,
} from "../../shared/agent/contracts";
import type {
  ExecutionRunView,
  NativeSummaryContext,
  ExecutionReceipt,
} from "../../shared/agent/execution";
import { projectSummarySchema } from "../../shared/agent/schemas";
import { check } from "../http";
import { authorizeExecution, type ExecutionPrincipal } from "./execution-auth";
import { canonical, hash } from "./outbox";

const id = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\x00-\x20\x7f]+$/),
  revision = z.number().int().positive();
const mutation = { requestId: id, bindingId: id, bindingRevision: revision };
export const projectActionSchemas = {
  state: z.strictObject({
    bindingId: id.optional(),
    bindingRevision: revision.optional(),
    inspectOnly: z.boolean().optional(),
  }),
  initialize: z.strictObject({ ...mutation, chatId: id.optional() }),
  refresh: z
    .strictObject({
      ...mutation,
      expectedActiveRunId: id.nullable().optional(),
      expectedSummaryRevision: z.number().int().nonnegative().optional(),
    })
    .refine(
      (v) =>
        (v.expectedActiveRunId === undefined) ===
        (v.expectedSummaryRevision === undefined),
    ),
  "use-previous": z.strictObject({
    ...mutation,
    expectedSummaryRevision: revision,
    expectedSourceRunId: id,
    expectedActiveRunId: id,
  }),
};
type Run = {
  summaryContext?: NativeSummaryContext;
  principal: ExecutionPrincipal;
  snapshot: ExecutionSnapshot;
  view: ExecutionRunView;
};
type RecordState = {
  state: ProjectContext;
  acceptedPrevious: boolean;
  operationId: string | null;
  cwd: string | null;
  pendingLaunch?: PreparedLaunch;
  reviewedRuns?: string[];
};
type LaunchInput = {
  requestId: string;
  bindingId: string;
  bindingRevision: number;
  kind: "summary";
  instruction: string;
};
type PreparedInput = Omit<
  Extract<RunnerCommand, { type: "create_run" }>,
  "type"
>;
type PreparedLaunch = {
  principal: ExecutionPrincipal;
  projectKey: string;
  operationId: string;
  projectRequestId?: string;
  input: PreparedInput;
  inputHash: string;
  phase: "prepared" | "committed" | "sealed";
  sealedLaunch?: NonNullable<ProjectContext["sealedLaunch"]>;
};
type Launch = {
  prepare(input: LaunchInput): Promise<{ input: PreparedInput }>;
  commit(input: PreparedInput): Promise<ExecutionReceipt>;
};
const launchKey = (runId: string) => "project:launch:" + runId;
const initial = (p: ExecutionPrincipal): ProjectContext => ({
  bindingId: p.bindingId,
  bindingRevision: p.bindingRevision,
  status: "uninitialized",
  ready: false,
  stale: false,
  summaryRevision: 0,
  summary: null,
  capturedAt: null,
  sourceRunId: null,
  threadId: null,
  turnId: null,
  cwd: null,
  gitBaseline: null,
  error: null,
  activeRunId: null,
});

// This coordinator runs under RunnerHub's existing serial gate. Its launch port
// uses the same intent/snapshot/tool journal as the MCP handler without making
// a reentrant HTTP call into the current Durable Object.
export class ProjectSummaries {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private launch: Launch,
  ) {}
  private async scope(p: ExecutionPrincipal) {
    const { workspace } = await authorizeExecution(this.env, p);
    return {
      workspace,
      key:
        "project:state:" +
        (await hash({ p, workspaceRevision: workspace.revision })),
    };
  }
  async assertCommit(p: ExecutionPrincipal, input: PreparedInput) {
    const launch = await this.storage.get<PreparedLaunch>(
      launchKey(input.runId),
    );
    if (!launch) return; // Existing non-coordinated/legacy execution API remains valid.
    await this.validateLaunch(p, launch);
    check(launch.phase !== "sealed", "总结启动已封存，不能再次提交。", 409);
    check(
      canonical(input) === canonical(launch.input),
      "总结启动身份不匹配。",
      409,
    );
  }
  private async validateLaunch(p: ExecutionPrincipal, launch: PreparedLaunch) {
    const { key } = await this.scope(p);
    check(
      canonical(launch.principal) === canonical(p),
      "总结启动未授权。",
      403,
    );
    check(
      launch.projectKey === key,
      "项目目录或授权版本已变化，请核对原运行。",
      409,
    );
    check(
      launch.inputHash === (await hash(launch.input)) &&
        launch.operationId === launch.input.requestId,
      "总结启动记录不完整，请人工核对。",
      409,
    );
    const snapshot = await this.storage.get<{
      principal: ExecutionPrincipal;
      input: PreparedInput;
    }>("exec:snapshot:" + launch.input.snapshotId);
    check(
      snapshot &&
        canonical(snapshot.principal) === canonical(p) &&
        canonical(snapshot.input) === canonical(launch.input),
      "总结启动快照不匹配，请人工核对。",
      409,
    );
  }
  // Invoked by the existing cancel tool only after proving no run exists, under
  // the same Hub gate as every create. A durable seal, not absence, is the proof.
  async seal(p: ExecutionPrincipal, runId: string, requestId: string) {
    const launch = await this.storage.get<PreparedLaunch>(launchKey(runId));
    check(
      launch && launch.input.runId === runId,
      "运行不存在或无权访问。",
      403,
    );
    await this.validateLaunch(p, launch);
    check(
      !(await this.storage.get("exec:run:" + runId)) &&
        !(await this.storage.get(
          "exec:receipt:" + p.ownerId + ":" + launch.input.requestId,
        )) &&
        !(await this.storage.get("exec:pending:" + runId)) &&
        launch.phase !== "committed",
      "总结已有提交记录，请核对实际运行后停止。",
      409,
    );
    const sealedLaunch = launch.sealedLaunch ?? {
      runId,
      operationId: launch.operationId,
      projectRequestId: launch.projectRequestId,
      sealedAt: new Date().toISOString(),
    };
    const receipt = {
      runId,
      commandId: crypto.randomUUID(),
      status: "accepted" as const,
      acceptedAt: new Date().toISOString(),
      sealedLaunch,
    };
    const record = await this.storage.get<RecordState>(launch.projectKey);
    const updates: Record<string, unknown> = {
      [launchKey(runId)]: { ...launch, phase: "sealed", sealedLaunch },
      ["exec:receipt:" + p.ownerId + ":" + requestId]: receipt,
    };
    if (
      launch.phase !== "sealed" &&
      record?.operationId === launch.operationId &&
      record.state.activeRunId === runId
    ) {
      delete record.pendingLaunch;
      record.state = {
        ...record.state,
        status: "failed",
        ready: false,
        stale: !!record.state.summary,
        error: "总结启动已取消，未派发到电脑。",
        sealedLaunch,
      };
      delete record.state.pendingLaunch;
      updates[launch.projectKey] = record;
    }
    await this.storage.put(updates);
    return receipt;
  }
  private async commit(
    p: ExecutionPrincipal,
    key: string,
    record: RecordState,
  ) {
    const pending = record.pendingLaunch!;
    await this.assertCommit(p, pending.input);
    const receipt = await this.launch.commit(pending.input);
    check(receipt.runId === pending.input.runId, "总结启动回执不匹配。", 409);
    delete record.pendingLaunch;
    delete record.state.pendingLaunch;
    await this.storage.put({
      [key]: record,
      [launchKey(receipt.runId)]: { ...pending, phase: "committed" },
    });
  }
  private async recovery(
    p: ExecutionPrincipal,
    state: ProjectContext,
    record?: RecordState,
  ): Promise<ProjectContext> {
    // Old crashes can predate pendingLaunch. Never infer a native thread or a new
    // request ID. Surface unlinked executions, including stopped records, first.
    const known = new Set(record?.reviewedRuns ?? []);
    for (const value of (
      await this.storage.list<RecordState>({ prefix: "project:state:" })
    ).values()) {
      if (value?.state) {
        if (value.state.activeRunId) known.add(value.state.activeRunId);
        if (value.state.sourceRunId) known.add(value.state.sourceRunId);
      }
    }
    const runs: NonNullable<ProjectContext["recoveryRuns"]> = [];
    let cursor: string | undefined;
    const currentRun =
      state.activeRunId &&
      (await this.storage.get<Run>("exec:run:" + state.activeRunId));
    do {
      const page = await this.storage.list<string>({
        prefix: `exec:list:${p.bindingId}:`,
        limit: 100,
        startAfter: cursor,
      });
      for (const [entry, runId] of page) {
        cursor = entry;
        if (known.has(runId) || (await this.storage.get(launchKey(runId))))
          continue;
        const run = await this.storage.get<Run>("exec:run:" + runId);
        if (
          !run ||
          run.snapshot.kind !== "summary" ||
          canonical(run.principal) !== canonical(p)
        )
          continue;
        if (
          currentRun &&
          run.view.terminal &&
          run.view.stopConfirmed &&
          run.view.createdAt <= currentRun.view.createdAt
        )
          continue;
        runs.push({
          runId,
          status: run.view.status,
          terminal: run.view.terminal,
          stopConfirmed: run.view.stopConfirmed,
        });
      }
      if (page.size < 100) break;
    } while (cursor);
    if (!runs.length) return state;
    return {
      ...state,
      status: "reconciliation_required",
      ready: false,
      stale: !!state.summary,
      recoveryRuns: runs,
      canRefresh:
        runs.every((r) => r.terminal && r.stopConfirmed) &&
        !record?.pendingLaunch &&
        (!currentRun ||
          (currentRun.view.terminal && currentRun.view.stopConfirmed)),
      error:
        "发现尚未关联到摘要的总结记录。请打开执行记录核对并停止原运行，再手动重新总结。",
    };
  }
  async state(
    p: ExecutionPrincipal,
    inspectOnly = false,
  ): Promise<ProjectContext> {
    const { key } = await this.scope(p),
      record = await this.storage.get<RecordState>(key);
    if (!record) return this.recovery(p, initial(p));
    if (record.pendingLaunch) {
      if (inspectOnly) return record.state;
      try {
        await this.commit(p, key, record);
      } catch (error) {
        return {
          ...record.state,
          status: "reconciliation_required",
          ready: false,
          error: "总结启动仍待核对，可刷新或停止原启动。",
        };
      }
    }
    const s = record.state;
    if (s.sealedLaunch) return this.recovery(p, s, record);
    if (!s.activeRunId) return this.recovery(p, s, record);
    const run = await this.storage.get<Run>("exec:run:" + s.activeRunId);
    if (!run || canonical(run.principal) !== canonical(p))
      return {
        ...s,
        ready: false,
        status: "reconciliation_required",
        error: "项目总结运行尚未恢复，请刷新核对。",
      };
    const completion = await this.storage.get<RunnerEvent>(
      "project:result:" + s.activeRunId,
    );
    if (run.view.terminal && run.view.stopConfirmed) {
      const valid =
        completion?.type === "turn.completed" &&
        completion.runId === run.view.runId &&
        !!run.summaryContext &&
        completion.payload.status === "completed" &&
        completion.threadId === run.view.threadId &&
        completion.turnId === run.view.turnId &&
        run.view.status === "verifying" &&
        projectSummarySchema.safeParse(completion.payload.summary);
      if (
        valid &&
        valid.success &&
        JSON.stringify(valid.data).length <= 24000
      ) {
        if (s.sourceRunId !== run.view.runId) {
          s.summary = valid.data;
          s.summaryRevision++;
          s.sourceRunId = run.view.runId;
          s.threadId = run.view.threadId;
          s.turnId = run.view.turnId;
          s.capturedAt = completion!.occurredAt;
          s.cwd = record.cwd;
          s.gitBaseline = run.summaryContext!.gitBaseline;
        }
        s.status = "ready";
        s.ready = true;
        s.stale = false;
        s.error = null;
      } else {
        s.status = record.acceptedPrevious ? "ready" : "failed";
        s.ready = record.acceptedPrevious && !!s.summary;
        s.stale = !!s.summary;
        s.error =
          run.view.error || "总结未取得有效结果，请重试或明确使用上次摘要。";
      }
    } else {
      s.status =
        run.view.status === "queued"
          ? "queued"
          : run.view.status === "reconciliation_required"
            ? "reconciliation_required"
            : "running";
      s.ready = false;
      s.stale = !!s.summary;
      s.error =
        run.view.status === "reconciliation_required"
          ? "总结运行状态需要核对，请检查设备连接。"
          : run.view.status === "waiting_approval"
            ? "总结等待本机审批。"
            : run.view.status === "waiting_input"
              ? "总结需要补充信息，请查看执行记录。"
              : null;
    }
    await this.storage.put(key, record);
    return this.recovery(p, s, record);
  }
  async act(
    p: ExecutionPrincipal,
    action: keyof typeof projectActionSchemas,
    raw: unknown,
  ) {
    const parsed = projectActionSchemas[action].safeParse(raw);
    check(parsed.success, "项目总结请求格式无效。", 400);
    const input = parsed.data;
    check(
      !input.bindingId || input.bindingId === p.bindingId,
      "项目不匹配。",
      403,
    );
    check(
      input.bindingRevision === undefined ||
        input.bindingRevision === p.bindingRevision,
      "项目绑定已变化，请刷新。",
      409,
    );
    const current = await this.state(
      p,
      action === "state" &&
        (input as { inspectOnly?: boolean }).inspectOnly === true,
    );
    if (action === "state") return current;
    const { key, workspace } = await this.scope(p),
      request = input as z.infer<typeof projectActionSchemas.refresh>;
    const requestKey = key + ":request:" + request.requestId,
      requestPayload = canonical({ action, input }),
      old = await this.storage.get<string>(requestKey);
    const digest = await hash({ p, action, input });
    const authorizationKey =
      "project:request-scope:" + p.ownerId + ":" + request.requestId;
    const authorizedKey = await this.storage.get<string>(authorizationKey);
    check(
      !authorizedKey || authorizedKey === key,
      "项目目录或授权版本已变化，请核对原运行。",
      409,
    );
    const reservationId = "project-action:" + request.requestId;
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO agent_execution_requests VALUES(?,?,?,?,?)",
    )
      .bind(p.ownerId, reservationId, digest, p.runnerId, p.bindingId)
      .run();
    const reservation = await this.env.DB.prepare(
      "SELECT payload_hash,runner_id,binding_id FROM agent_execution_requests WHERE owner_id=? AND request_id=?",
    )
      .bind(p.ownerId, reservationId)
      .first<{ payload_hash: string; runner_id: string; binding_id: string }>();
    check(
      reservation?.payload_hash === digest &&
        reservation.runner_id === p.runnerId &&
        reservation.binding_id === p.bindingId,
      "请求编号已用于不同项目或授权版本。",
      409,
    );
    check(!old || old === requestPayload, "请求编号已用于不同内容。", 409);
    if (old) return current;
    if (action === "use-previous") {
      const previous = input as z.infer<
        (typeof projectActionSchemas)["use-previous"]
      >;
      check(
        current.summary &&
          current.summaryRevision === previous.expectedSummaryRevision &&
          current.sourceRunId === previous.expectedSourceRunId &&
          current.activeRunId === previous.expectedActiveRunId,
        "上次摘要版本已变化，请刷新核对。",
        409,
      );
      check(
        current.status === "failed" && !current.pendingLaunch,
        "当前总结仍在执行，请等待结果。",
        409,
      );
      const active =
        current.activeRunId &&
        (await this.storage.get<Run>("exec:run:" + current.activeRunId));
      check(
        current.sealedLaunch ||
          (active && active.view.terminal && active.view.stopConfirmed),
        "尚未确认本次总结停止，请先核对运行状态。",
        409,
      );
      const record = (await this.storage.get<RecordState>(key))!;
      record.acceptedPrevious = true;
      record.state = {
        ...current,
        status: "ready",
        ready: true,
        stale: current.status === "failed" || current.stale,
      };
      await this.storage.put({
        [key]: record,
        [requestKey]: requestPayload,
        [authorizationKey]: key,
      });
      return record.state;
    }
    const chatId =
      action === "initialize"
        ? (input as z.infer<typeof projectActionSchemas.initialize>).chatId
        : undefined;
    const initializedKey = key + ":initialized:" + (chatId ?? "initial");
    const active =
      current.activeRunId &&
      (await this.storage.get<Run>("exec:run:" + current.activeRunId));
    const blocked =
      !!current.pendingLaunch ||
      (!!current.activeRunId &&
        !current.sealedLaunch &&
        !(active && active.view.terminal && active.view.stopConfirmed));
    check(
      !current.recoveryRuns?.length ||
        (action === "refresh" && current.canRefresh),
      "请先在执行记录中核对并停止原总结。",
      409,
    );
    if (action === "refresh") {
      if (request.expectedActiveRunId !== undefined)
        check(
          request.expectedActiveRunId === current.activeRunId &&
            request.expectedSummaryRevision === current.summaryRevision,
          "项目摘要已变化，请刷新后重新操作。",
          409,
        );
      check(!blocked, "尚未确认本次总结停止，请先核对运行状态。", 409);
    }
    if (
      action === "initialize" &&
      (blocked ||
        (!chatId && current.status !== "uninitialized") ||
        (await this.storage.get(initializedKey)))
    ) {
      await this.storage.put({
        [requestKey]: requestPayload,
        [authorizationKey]: key,
        ...(chatId && current.activeRunId
          ? { [initializedKey]: current.activeRunId }
          : {}),
      });
      return current;
    }
    // Derivation survives a crash between the underlying command journal commit
    // and this coordinator record. A repeated action creates no second run.
    const executionId =
      "project-" +
      (await hash({
        key,
        logical:
          action === "initialize"
            ? "initialize:" + (chatId ?? "initial")
            : "refresh:" + request.requestId,
      }));
    const prepared = await this.launch.prepare({
      requestId: executionId,
      bindingId: p.bindingId,
      bindingRevision: p.bindingRevision,
      kind: "summary",
      instruction:
        "只读检查项目说明、AGENTS.md、关键目录、Git 分支及变更状态。区分已验证事实、历史描述和推测；列出证据与未确定事项。不要修改文件、安装依赖、推送或执行待办。",
    });
    const state: ProjectContext = {
      ...current,
      status: "queued",
      ready: false,
      stale: !!current.summary,
      error: null,
      activeRunId: prepared.input.runId,
      pendingLaunch: {
        runId: prepared.input.runId,
        operationId: executionId,
        projectRequestId: request.requestId,
      },
    };
    delete state.sealedLaunch;
    delete state.recoveryRuns;
    delete state.canRefresh;
    const launch: PreparedLaunch = {
      principal: p,
      projectKey: key,
      operationId: executionId,
      projectRequestId: request.requestId,
      input: prepared.input,
      inputHash: await hash(prepared.input),
      phase: "prepared",
    };
    const record: RecordState = {
      state,
      acceptedPrevious: false,
      operationId: executionId,
      cwd: workspace.displayPath,
      pendingLaunch: launch,
      reviewedRuns: [
        ...((await this.storage.get<RecordState>(key))?.reviewedRuns ?? []),
        ...(current.recoveryRuns?.map((r) => r.runId) ?? []),
      ],
    };
    await this.storage.put({
      [key]: record,
      [launchKey(prepared.input.runId)]: launch,
      [requestKey]: requestPayload,
      [authorizationKey]: key,
      ...(action === "initialize"
        ? { [initializedKey]: prepared.input.runId }
        : {}),
    });
    await this.commit(p, key, record);
    return state;
  }
}
