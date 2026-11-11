import { z } from "zod";
import type { Env } from "../types";
import type { ProjectContext } from "../../shared/agent/project";
import type {
  ExecutionSnapshot,
  RunnerEvent,
} from "../../shared/agent/contracts";
import type {
  ExecutionRunView,
  NativeSummaryContext,
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
  }),
  initialize: z.strictObject({ ...mutation, chatId: id.optional() }),
  refresh: z.strictObject(mutation),
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
};
type Launch = (input: {
  requestId: string;
  bindingId: string;
  bindingRevision: number;
  kind: "summary";
  instruction: string;
}) => Promise<{ runId: string }>;
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
  async state(p: ExecutionPrincipal): Promise<ProjectContext> {
    const { key } = await this.scope(p),
      record = await this.storage.get<RecordState>(key);
    if (!record) return initial(p);
    const s = record.state;
    if (!s.activeRunId) return s;
    const run = await this.storage.get<Run>("exec:run:" + s.activeRunId);
    if (!run || canonical(run.principal) !== canonical(p))
      return {
        ...s,
        ready: false,
        status: "failed",
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
            ? "failed"
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
    return s;
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
    const current = await this.state(p);
    if (action === "state") return current;
    const { key, workspace } = await this.scope(p),
      request = input as z.infer<typeof projectActionSchemas.refresh>;
    const requestKey = key + ":request:" + request.requestId,
      requestPayload = canonical({ action, input }),
      old = await this.storage.get<string>(requestKey);
    const digest = await hash({ p, action, input });
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
      check(current.status === "failed", "当前总结仍在执行，请等待结果。", 409);
      const active =
        current.activeRunId &&
        (await this.storage.get<Run>("exec:run:" + current.activeRunId));
      check(
        active && active.view.terminal && active.view.stopConfirmed,
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
      await this.storage.put({ [key]: record, [requestKey]: requestPayload });
      return record.state;
    }
    const chatId =
      action === "initialize"
        ? (input as z.infer<typeof projectActionSchemas.initialize>).chatId
        : undefined;
    const initializedKey = key + ":initialized:" + (chatId ?? "initial");
    if (
      action === "initialize" &&
      ((!chatId && current.status !== "uninitialized") ||
        (await this.storage.get(initializedKey)))
    ) {
      await this.storage.put(requestKey, requestPayload);
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
    const launched = await this.launch({
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
      activeRunId: launched.runId,
    };
    await this.storage.put({
      [key]: {
        state,
        acceptedPrevious: false,
        operationId: executionId,
        cwd: workspace.displayPath,
      },
      [requestKey]: requestPayload,
      ...(action === "initialize" ? { [initializedKey]: launched.runId } : {}),
    });
    return state;
  }
}
