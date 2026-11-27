import { randomUUID } from "node:crypto";
import { substantiveAnswer } from "./proofs.mjs";
import {
  controlSchemas,
  controlSpecs,
  MAX_TASK_PLAN_ITEMS,
} from "./contracts.mjs";
import { digest, scopeKey } from "./task-store.mjs";
import { modelState, taskCard, verifyResult } from "./verification.mjs";
import { validateRecipe, executeRecipe } from "./recipes.mjs";
import {
  replayWindow,
  contextBudget,
  semanticResult,
} from "./context-pack.mjs";
import {
  normalizeEvidence,
  operationOf,
  artifactFrom,
  attachEvidenceOrigin,
  externalWaitFor,
  expectedOperation,
  requirementTools,
  canonicalRequirement,
  knownReference,
} from "./evidence.mjs";
import { rankSearch } from "./tool-search.mjs";
import { deliveryText } from "./turn-report.mjs";
import {
  activityTitle,
  activityCommand,
  activityLine,
} from "../../shared/agent/task-activity.mjs";
import { waaoAccessIssue } from "../../shared/agent/waao-access.mjs";
import { validatePreparedSteps, preparedArguments } from "./prepared-steps.mjs";
import {
  reconcileSteps,
  verifyStep,
  allRequirementChecks,
  deliveryStep,
} from "./proofs.mjs";
import {
  addBlocker,
  blockingFor,
  canResolve,
  observeBlockers,
  readySteps,
  publicBlockers,
  retryablePermissionDenial,
} from "./blockers.mjs";
import {
  needsTaskPlan,
  planApproved,
  reviewPlan,
  acceptPlan,
} from "./plan-review.mjs";
export { replayWindow } from "./context-pack.mjs";

// null survives durable JSON checkpoints and means unlimited. Explicit numeric
// limits remain available to callers that intentionally configure a budget.
const defaults = { maxRequests: null, maxTokens: null, maxRunRequests: null };
const reached = (used, limit, reserve = 0) =>
  Number.isFinite(limit) && used >= Math.max(0, limit - reserve);
const contextTools = new Set([
  "search_context",
  "read_context",
  "find_capabilities",
  "request_capability",
  "submit_result",
]);
const terminal = new Set(["completed", "cancelled"]);
const safeMessages = (messages) =>
  messages
    .filter((m) => ["user", "assistant", "toolResult"].includes(m.role))
    .map((m) =>
      m.role === "assistant"
        ? { ...m, content: m.content.filter((p) => p.type !== "thinking") }
        : m,
    );

export class TaskRun {
  constructor({
    store,
    scope,
    input,
    jobId,
    signal,
    limits,
    references = [],
    context = [],
    capabilities,
    requirePlanConfirmation = false,
  }) {
    Object.assign(this, { store, scope, input, jobId, signal, capabilities });
    this.owner = jobId + ":" + randomUUID();
    this.limits = { ...defaults, ...limits };
    this.runRequests = 0;
    this.runTokens = 0;
    this.stalls = 0;
    this.requestStalls = 0;
    this.contextObservations = new Set();
    this.halted = false;
    this.turnTranscript = [
      { role: "user", content: input.text, timestamp: Date.now() },
    ];
    this.archiveCursor = 0;
    this.seenUsage = new Set();
    this.requirePlanConfirmation = requirePlanConfirmation;
    store.claim(scope, this.owner);
    capabilities.recipes = store.recipes(scope);
    this.task = store.latest(scope, true);
    if (this.task) {
      this.task.requirePlanConfirmation ||= requirePlanConfirmation;
      this.task.activities ||= [];
      this.task.artifacts ||= [];
      this.task.mode ||= "persistent";
      if (!this.task.schemaVersion || this.task.schemaVersion < 2) {
        this.task.evidence = this.task.evidence.map((e) => ({
          ...normalizeEvidence(e.label, e.args || {}, e.result, {
            id: e.id,
            taskId: this.task.id,
          }),
          ...e,
        }));
        this.task.artifacts = this.task.evidence
          .map(artifactFrom)
          .filter(Boolean);
        this.task.schemaVersion = 2;
      }
      if (requirePlanConfirmation) this.task.schemaVersion = 3;
      this.task.blockers ||= [];
      for (const a of this.task.activities)
        if (a.status === "running") a.status = "waiting";
      this.task.activeMessageId = scope.userMessageId;
      if (this.task.schemaVersion >= 3) {
        for (const activity of this.task.activities)
          if (activity.id.startsWith("step:") && activity.evidenceId) {
            const evidence = this.task.evidence.find(
              (e) => e.id === activity.evidenceId,
            );
            if (evidence) evidence.stepId ||= activity.id.slice(5);
          }
        reconcileSteps(this.task);
        this.refreshFeasibility();
      }
    }
    this.contextAnswerRevision = this.task?.answerRevision || 0;
    this.baseTranscript = this.task?.transcript || [];
    if (
      input.taskReply &&
      (input.taskReply.taskId !== this.task?.id ||
        !this.task.questions.some(
          (q) =>
            q.id === input.taskReply.questionId &&
            (!q.answer || q.answerMessageId === scope.userMessageId),
        ))
    ) {
      this.close();
      throw Error("这次提问已失效，请刷新任务状态后回答。");
    }
    if (this.task) {
      try {
        acceptPlan(this.task, input, scope.userMessageId);
      } catch (error) {
        this.close();
        throw error;
      }
      // Runtime policy applies on an explicit new turn, never by replaying a
      // saved operation or silently starting an already-paused task at startup.
      for (const key of ["maxRequests", "maxTokens"]) {
        if (this.limits[key] == null) this.task.budget[key] = null;
        else if (!Number.isFinite(this.task.budget[key]))
          this.task.budget[key] = this.limits[key];
      }
      this.task.budget.maxRunRequests = this.limits.maxRunRequests;
      const fresh = !this.task.messageIds.includes(scope.userMessageId);
      this.userInputNeedsReview =
        fresh &&
        !input.taskReply &&
        !/^(?:继续|继续执行|继续处理|重试|恢复任务)[。.!！]?$/.test(
          input.text.trim(),
        );
      this.task.messageIds = [
        ...new Set([...this.task.messageIds, scope.userMessageId]),
      ];
      if (fresh) {
        this.task.userInputs ||= [];
        this.task.userInputs.push({
          id: scope.userMessageId,
          text: input.text,
        });
        const pending = this.task.questions.filter(
          (q) => !q.answer && q.kind !== "plan_confirmation",
        );
        const question = input.taskReply
          ? pending.find((q) => q.id === input.taskReply.questionId)
          : pending.length === 1
            ? pending[0]
            : null;
        if (question) {
          question.answer = input.text;
          question.answerMessageId = scope.userMessageId;
        }
        this.task.verification = null;
        if (
          this.task.status === "paused_budget" &&
          /^继续(?:执行|处理|原任务|任务)?[。.!！]?$/.test(input.text.trim())
        ) {
          if (Number.isFinite(this.limits.maxRequests))
            this.task.budget.maxRequests = Math.max(
              this.task.budget.maxRequests,
              this.task.budget.requests +
                (this.limits.maxRunRequests ?? this.limits.maxRequests),
            );
          if (Number.isFinite(this.limits.maxTokens))
            this.task.budget.maxTokens = Math.max(
              this.task.budget.maxTokens,
              this.task.budget.tokens + this.limits.maxTokens,
            );
        }
      }
      this.releaseDeniedRetries();
      this.task.status = "running";
      reviewPlan(this.task);
      if (
        this.task.external &&
        !this.userInputNeedsReview &&
        planApproved(this.task)
      )
        this.task.status = "waiting_external";
      this.save("resumed");
    }
    const data = [
      ...input.memories.map((m) => ({ title: m.key, text: m.value })),
      ...(input.summary
        ? [{ title: "项目摘要", text: JSON.stringify(input.summary) }]
        : []),
      ...input.history.map((m, i) => ({
        title: "可见对话 " + (i + 1),
        text: m.text,
      })),
      ...context,
      ...references.map((r) => ({
        title: r.label || "已有回执",
        text: JSON.stringify(r),
      })),
    ];
    this.documents = data
      .filter((d) => typeof d.text === "string")
      .map((d) => ({ ...d, id: "ctx_" + digest(d).slice(0, 20) }));
  }
  assertActive() {
    this.signal.throwIfAborted();
    this.store.assertLease(this.scope, this.owner);
    if (this.halted) throw Error("任务连续多轮没有新进展，检查点已保存。");
  }
  releaseDeniedRetries() {
    const task = this.task;
    for (const blocker of task?.blockers || []) {
      if (
        blocker.resolved ||
        blocker.kind !== "authorization" ||
        !(blocker.deniedAtInputCount < (task.userInputs?.length || 0))
      )
        continue;
      const evidence = task.evidence.find((e) => e.id === blocker.evidenceId);
      if (!evidence || !retryablePermissionDenial(evidence.result)) continue;
      blocker.resolved = true;
      blocker.resolution = "explicit_user_retry";
      for (const step of task.steps.filter((s) =>
        blocker.stepIds?.includes(s.id),
      ))
        delete step.executionAttempt;
    }
  }
  consumeAnswers() {
    if (!this.task || terminal.has(this.task.status)) return false;
    let changed = false;
    for (const event of this.store.pendingAnswers?.(this.task.id) || []) {
      const question = this.task.questions.find(
        (q) => q.id === event.questionId,
      );
      if (question?.answerEventId === event.id) {
        this.store.acknowledgeAnswer(this.scope, this.owner, event.id);
        continue;
      }
      if (
        !question ||
        question.answer ||
        event.scope !== scopeKey(this.scope) ||
        event.memoryEpoch !== this.scope.memoryEpoch ||
        event.projectSourceDigest !== digest(this.scope.projectSource ?? null)
      ) {
        this.store.acknowledgeAnswer(this.scope, this.owner, event.id, "stale");
        continue;
      }
      if (question.kind === "plan_confirmation") {
        this.refreshFeasibility();
        try {
          acceptPlan(
            this.task,
            {
              text: event.text,
              taskReply: { taskId: this.task.id, questionId: question.id },
            },
            "answer:" + event.id,
          );
        } catch {
          this.store.acknowledgeAnswer(
            this.scope,
            this.owner,
            event.id,
            "stale",
          );
          continue;
        }
      } else {
        question.answer = event.text;
        this.pendingAnswerReview = true;
      }
      question.answerEventId = event.id;
      question.answeredAt = event.receivedAt;
      this.task.userInputs ||= [];
      this.task.userInputs.push({ id: "answer:" + event.id, text: event.text });
      this.releaseDeniedRetries();
      this.turnTranscript.push({
        role: "user",
        content: event.text,
        timestamp: event.receivedAt,
      });
      this.task.answerRevision = (this.task.answerRevision || 0) + 1;
      this.task.verification = null;
      if (!this.task.external) this.task.status = "running";
      this.save("answer_applied");
      this.store.acknowledgeAnswer(this.scope, this.owner, event.id);
      changed = true;
    }
    return changed;
  }
  save(kind) {
    if (
      this.task?.schemaVersion >= 3 &&
      this.store.archive &&
      this.turnTranscript.length > this.archiveCursor
    ) {
      this.store.archive(
        this.scope,
        this.owner,
        this.task.id,
        this.scope.userMessageId,
        this.turnTranscript.slice(this.archiveCursor),
      );
      this.archiveCursor = this.turnTranscript.length;
    }
    return this.store.save(this.scope, this.owner, this.task, kind);
  }
  recordExchange(name, args, callId, value, isError = false) {
    if (!this.task || this.task.schemaVersion < 3) return;
    this.turnTranscript.push(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name,
            arguments: structuredClone(args),
          },
        ],
        stopReason: "toolUse",
        api: "openai-responses",
        provider: "qingdan-history",
        model: "saved-operation",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: name,
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError,
        timestamp: Date.now(),
      },
    );
    this.task.transcript = replayWindow(
      [...this.baseTranscript, ...this.turnTranscript],
      160000,
    );
    this.save("tool_exchange");
  }
  observeUsage(message) {
    if (!this.task || this.task.schemaVersion < 3 || !message?.usage) return;
    const key = digest([
      message.provider,
      message.model,
      message.timestamp,
      message.usage,
    ]);
    if (this.seenUsage.has(key)) return;
    this.seenUsage.add(key);
    const tokens = Number(message.usage.totalTokens) || 0;
    this.runTokens += tokens;
    this.task.budget.tokens += tokens;
    this.task.usage ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const field of Object.keys(this.task.usage))
      this.task.usage[field] += Number(message.usage[field]) || 0;
  }
  shouldYield() {
    if (!this.task || this.task.schemaVersion < 3) return false;
    if (this.userInputNeedsReview || this.pendingAnswerReview) return false;
    if (
      [
        "waiting_plan",
        "blocked",
        "waiting_external",
        "waiting_model",
        "completed",
      ].includes(this.task.status)
    )
      return true;
    return (
      ["waiting_user", "waiting_auth"].includes(this.task.status) &&
      !readySteps(this.task).length
    );
  }
  async runPrepared(invoke, beforeStep) {
    const task = this.task;
    if (
      !task ||
      task.schemaVersion < 3 ||
      !planApproved(task) ||
      this.userInputNeedsReview ||
      this.pendingAnswerReview
    )
      return 0;
    this.refreshFeasibility();
    if (task.feasibility && !task.feasibility.ready) {
      task.status = "blocked";
      this.save("plan_blocked");
      return 0;
    }
    let count = 0;
    while (!this.signal.aborted && !task.external) {
      this.consumeAnswers();
      if (this.pendingAnswerReview) break;
      const step = readySteps(task).find(
        (s) => s.execution && !s.executionAttempt,
      );
      if (!step) break;
      task.activeStepId = step.id;
      const loaded = await this.capabilities.request(step.execution.tool);
      if (loaded.status !== "ready") {
        addBlocker(task, {
          kind: "capability",
          code: "CAPABILITY_UNAVAILABLE",
          message: loaded.message || "当前步骤所需工具不可用。",
          stepIds: [step.id],
          tool: step.execution.tool,
        });
        task.status = "blocked";
        this.save("step_unavailable");
        break;
      }
      let args;
      try {
        args = preparedArguments(task, step);
      } catch (error) {
        step.needsDecision = error.message;
        this.save("step_needs_input");
        break;
      }
      step.executionAttempt = {
        signature: digest([step.execution, args]),
        at: Date.now(),
      };
      task.status = "running";
      this.save("prepared_step");
      await beforeStep?.(step.execution.tool, args);
      await this.execute(
        step.execution.tool,
        args,
        "prepared:" + task.id + ":" + step.id + ":" + task.plan.revision,
        invoke,
      );
      count++;
      if (this.shouldYield() || step.status !== "done") break;
    }
    return count;
  }
  finishKnown(answer = "", prepared = false) {
    const task = this.task;
    if (
      !task ||
      task.schemaVersion < 3 ||
      !planApproved(task) ||
      task.external ||
      this.userInputNeedsReview ||
      this.pendingAnswerReview
    )
      return false;
    const actual = substantiveAnswer(answer) ? answer : "";
    if (!actual && !(prepared && task.artifacts?.length)) return false;
    reconcileSteps(task);
    this.refreshFeasibility();
    const checks = allRequirementChecks(task);
    if (!checks.length || checks.some((c) => !c.accepted)) return false;
    const steps = task.steps.map((s) =>
      deliveryStep(s) ? { ...s, status: "done" } : s,
    );
    const verdict = verifyResult({ ...task, steps }, checks);
    if (!verdict.accepted) return false;
    task.steps = steps;
    task.verification = { ...verdict, checks, scope: "business_result" };
    task.status = "completed";
    task.finalText = actual || task.answer || deliveryText(task, "");
    this.save("completed");
    return true;
  }
  ensure() {
    this.assertActive();
    if (!this.task) {
      this.task = this.store.create(
        this.scope,
        this.owner,
        this.input.text.slice(0, 2000),
        this.limits,
      );
      this.task.budget.requests = this.runRequests;
      this.task.originalGoal = this.input.text;
      this.task.requiresToolResult =
        /(?:让|去|调用|使用).{0,30}(?:codex|waao|mcp)|^(?:生成|制作).{0,20}(?:图片|视频)|新建.{0,20}(?:节点|画布)/i.test(
          this.input.text,
        );
      this.task.schemaVersion = this.requirePlanConfirmation ? 3 : 2;
      this.task.blockers = [];
      this.task.requirePlanConfirmation = this.requirePlanConfirmation;
      this.task.executionRequested =
        this.requirePlanConfirmation && needsTaskPlan(this.input.text);
      this.task.mode = /然后|接着|之后|再(?:去|用|把|生成|创建)|分别|同时/.test(
        this.input.text,
      )
        ? "persistent"
        : "auto";
      this.task.activeMessageId = this.scope.userMessageId;
      this.task.activities = [];
      this.task.artifacts = [];
      this.task.userInputs = [
        { id: this.scope.userMessageId, text: this.input.text },
      ];
      this.task.budget.tokens = this.runTokens;
      this.save("started");
    }
    return this.task;
  }
  context() {
    const state = modelState(this.task);
    return this.requirePlanConfirmation
      ? { ...state, requirePlanConfirmation: true }
      : state;
  }
  refreshFeasibility(task = this.task) {
    if (!task || task.schemaVersion < 3 || !this.capabilities.assessPlan)
      return;
    task.feasibility = this.capabilities.assessPlan(task);
    for (const b of task.blockers || [])
      if (b.origin === "plan") b.resolved = true;
    for (const issue of task.feasibility.issues)
      addBlocker(task, { ...issue, kind: "capability", origin: "plan" });
    if (task.plan) task.plan.canConfirm = task.feasibility.ready;
  }
  observe(event) {
    if (this.halted || this.signal.aborted || terminal.has(this.task?.status))
      return;
    if (event.type === "message_start" && event.message?.role === "assistant") {
      const task = this.ensure();
      this.streamId =
        "model:" +
        this.owner +
        ":" +
        (this.streamCount = (this.streamCount || 0) + 1);
      task.activities.push({
        id: this.streamId,
        kind: "model",
        title: task.evidence.length ? "整理本轮结果" : "梳理任务",
        status: "running",
        text: "",
        messageId: this.scope.userMessageId,
      });
      this.save("activity_started");
    }
    const item = this.task?.activities.find((a) => a.id === this.streamId);
    if (!item) return;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      item.text = (item.text + event.assistantMessageEvent.delta).slice(-16000);
      if (Date.now() - (this.lastStreamSave || 0) > 150) {
        this.lastStreamSave = Date.now();
        this.save("activity_delta");
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (this.task.schemaVersion >= 3 && this.store.archive)
        this.store.archive(
          this.scope,
          this.owner,
          this.task.id,
          this.scope.userMessageId,
          safeMessages([message]),
        );
      this.observeUsage(message);
      item.text =
        message.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n") || item.text;
      item.status = ["error", "aborted"].includes(message.stopReason)
        ? "failed"
        : "done";
      if (item.text) this.task.lastAssistantText = item.text;
      if (this.task.schemaVersion >= 3 && item.text)
        this.turnTranscript.push({
          ...message,
          content: [{ type: "text", text: item.text }],
          stopReason: "stop",
        });
      if (message.stopReason === "stop" && item.text)
        this.turnFinalText = item.text;
      this.save("activity_finished");
    }
  }
  specs() {
    return [...controlSpecs, ...this.capabilities.activeSpecs()];
  }
  progressSignature() {
    const task = this.task;
    // New receipt ids/timestamps alone are not progress. Repeated read-only
    // results and cached writes must not keep a non-productive loop running.
    const evidence = new Set(
      (task?.evidence || []).map((item) =>
        digest([
          item.label,
          item.kind,
          item.ok,
          item.mediaReady,
          semanticResult(item.result),
        ]),
      ),
    );
    return digest([
      task?.requirements,
      task?.steps?.map(({ id, status, description }) => ({
        id,
        status,
        description,
      })),
      task?.gaps,
      task?.questions,
      [...evidence].sort(),
      [...this.contextObservations].sort(),
    ]);
  }
  async rpc(event) {
    this.assertActive();
    if (event.kind === "context") {
      this.consumeAnswers();
      this.contextAnswerRevision = this.task?.answerRevision || 0;
      this.pendingAnswerReview = false;
      if (this.contextWindow)
        this.inputBudget = contextBudget(
          this.contextWindow,
          this.outputReserve || 8192,
          this.specs(),
        );
      return {
        task: this.context(),
        inputBudget: this.inputBudget || 24000,
        targetBudget:
          this.requirePlanConfirmation || this.task?.schemaVersion >= 3
            ? this.task?.plan?.status === "approved"
              ? 12000
              : 20000
            : this.inputBudget || 24000,
      };
    }
    if (event.kind === "request") {
      const budget = this.task?.budget;
      if (
        reached(this.runRequests, this.limits.maxRunRequests) ||
        (budget &&
          (reached(budget.requests, budget.maxRequests) ||
            reached(budget.tokens, budget.maxTokens)))
      ) {
        if (this.task) {
          this.task.status = "paused_budget";
          this.task.progress = "已保存进度，本次运行预算用尽。";
          this.save("budget");
        }
        throw Error("任务预算用尽，检查点已保存。");
      }
      const signature = this.progressSignature();
      this.requestStalls =
        signature === this.lastRequestSignature ? this.requestStalls + 1 : 0;
      this.lastRequestSignature = signature;
      if (this.requestStalls >= 3) {
        const task = this.ensure();
        task.status = "interrupted";
        task.progress =
          "连续多轮没有获得新信息或执行进展，已保存检查点。请补充信息或调整方法后继续。";
        this.save("no_progress");
        this.halted = true;
        throw Error("任务连续多轮没有新进展，检查点已保存。");
      }
      this.runRequests++;
      if (this.task) {
        this.task.budget.requests++;
        const trace = {
          request: this.task.budget.requests,
          stepId: this.task.activeStepId,
          estimatedInputTokens: event.estimatedInputTokens,
          tools: event.tools,
          phase:
            this.task.plan?.status === "approved" ? "execution" : "planning",
        };
        this.task.lastModelRequest = trace;
        if (this.task.schemaVersion >= 3 && this.store.archive)
          this.store.archive(
            this.scope,
            this.owner,
            this.task.id,
            this.scope.userMessageId,
            [{ type: "model_request", ...trace }],
          );
        this.save("request");
      }
      return {};
    }
    if (event.kind === "checkpoint") {
      const usage = Number(event.tokens);
      if (event.message && this.task?.schemaVersion >= 3)
        this.observeUsage(event.message);
      else if (Number.isFinite(usage) && usage > 0) {
        this.runTokens += usage;
        if (this.task) this.task.budget.tokens += usage;
      }
      if (this.task) {
        this.task.transcript =
          this.task.schemaVersion >= 3
            ? [...this.baseTranscript, ...this.turnTranscript]
            : [
                ...this.baseTranscript,
                {
                  role: "user",
                  content: this.input.text,
                  timestamp: Date.now(),
                },
                ...safeMessages(event.messages || []).filter(
                  (m, i) => !(i === 0 && m.role === "user"),
                ),
              ];
        // Artifacts and evidence remain independently readable when dialogue is trimmed.
        this.task.transcript = replayWindow(this.task.transcript, 160000);
        this.save("checkpoint");
      }
      return {};
    }
    if (event.kind === "boundary") return this.boundary();
    throw Error("未知的任务控制事件。");
  }
  boundary() {
    this.assertActive();
    const task = this.task;
    if (!task) return { continue: false };
    if (this.finishKnown(this.turnFinalText)) return { continue: false };
    if (task.schemaVersion >= 3) {
      this.refreshFeasibility();
      reconcileSteps(task);
      if (!task.feasibility?.ready && task.feasibility) {
        task.status = "blocked";
        task.progress = task.feasibility.issues
          .map((i) => i.message)
          .join("\n");
        this.save("plan_blocked");
        return { continue: false };
      }
      if (
        publicBlockers(task).some((b) => b.kind !== "model") &&
        !readySteps(task).length
      ) {
        task.status = "blocked";
        task.progress = publicBlockers(task)
          .map((b) => b.message)
          .join("\n");
        this.save("blocked");
        return { continue: false };
      }
    }
    if (
      task.requirePlanConfirmation &&
      (task.executionRequested || task.plan || task.steps.length) &&
      !planApproved(task)
    ) {
      reviewPlan(task);
      if (task.plan?.status === "pending") {
        this.save("plan_waiting");
        return { continue: false };
      }
      // Keep ordinary questions direct, but never treat an execution request as
      // delivered before the model has proposed a reviewable plan.
      task.mode = "persistent";
    }
    if (
      task.mode === "auto" &&
      !task.requirements.length &&
      !task.questions.some((q) => !q.answer) &&
      !task.external
    ) {
      const evidence = task.evidence.filter((e) => e.ok);
      const operations = new Set(
        evidence
          .filter((e) => e.operation !== "resource.read")
          .map((e) => e.operation),
      );
      if (
        (!task.requiresToolResult || evidence.length > 0) &&
        (!task.evidence.length || evidence.length === task.evidence.length) &&
        operations.size <= 1 &&
        ![...operations].some((o) =>
          ["unknown", "generation.submit"].includes(o),
        )
      ) {
        const last = evidence.at(-1);
        task.requirements = [
          {
            id: "result",
            description: task.goal,
            check: last ? "tool_result" : "answer",
            ...(last && { tool: last.label, operation: last.operation }),
          },
        ];
        task.status = "completed";
        if (this.turnFinalText) task.finalText = this.turnFinalText;
        task.verification = {
          accepted: true,
          failures: [],
          checks: [
            {
              requirementId: "result",
              evidenceIds: last ? [last.id] : [],
              explanation: "已交付本次回答或单步操作的实际结果。",
            },
          ],
          scope: "single_action",
        };
        this.save("completed");
        return { continue: false };
      }
      task.mode = "persistent";
    }
    if (task.verification?.accepted) {
      const verdict = verifyResult(task, task.verification.checks);
      if (verdict.accepted) {
        task.status = "completed";
        if (this.turnFinalText) task.finalText = this.turnFinalText;
        this.save("completed");
        return { continue: false };
      }
      task.verification = { ...task.verification, ...verdict };
    }
    const blocked = new Set(
      task.questions
        .filter((q) => !q.answer)
        .flatMap((q) => q.blocksStepIds || []),
    );
    const independent =
      blocked.size &&
      task.steps.filter((s) => s.status !== "done" && !blocked.has(s.id));
    if (
      independent?.length &&
      ["waiting_user", "waiting_auth"].includes(task.status)
    ) {
      return {
        continue: true,
        message:
          "当前问题只阻塞部分步骤。请先推进这些不依赖回答的步骤：" +
          independent.map((s) => s.description).join("；"),
      };
    }
    if (
      [
        "waiting_user",
        "waiting_plan",
        "blocked",
        "waiting_model",
        "waiting_auth",
        "waiting_external",
        "paused_budget",
        "cancelled",
      ].includes(task.status)
    )
      return { continue: false };
    if (
      reached(this.runRequests, this.limits.maxRunRequests, 1) ||
      reached(task.budget.requests, task.budget.maxRequests, 1) ||
      reached(task.budget.tokens, task.budget.maxTokens)
    ) {
      task.status = "paused_budget";
      task.progress = "已保存进度，需要继续时从检查点恢复。";
      this.save("budget");
      return { continue: false };
    }
    const signature = this.progressSignature();
    this.stalls = signature === this.lastSignature ? this.stalls + 1 : 0;
    this.lastSignature = signature;
    if (this.stalls >= 2) {
      task.status = "interrupted";
      task.progress =
        "连续检查未获得新证据，已保存进度。请补充信息或调整方法后继续。";
      this.save("no_progress");
      return { continue: false };
    }
    return {
      continue: true,
      message:
        "任务尚未通过验收。请读取以下状态，选择有用的下一步；缺资料先读取资料，缺工具先发现，必须询问时用 ask_user，完成时用 submit_result 提交逐项证据。\n" +
        JSON.stringify(this.context()),
    };
  }
  async control(name, value) {
    const result = await this.applyControl(name, value);
    if (contextTools.has(name))
      this.contextObservations.add(digest([name, result]));
    return result;
  }
  async applyControl(name, value) {
    this.assertActive();
    const parsed = controlSchemas[name].safeParse(value);
    if (!parsed.success)
      throw Error(
        "任务工具参数不完整：" +
          parsed.error.issues
            .map((i) => i.path.join(".") + " " + i.message)
            .join("；")
            .slice(0, 400),
      );
    const args = parsed.data;
    if (name === "propose_reply") {
      this.proposals = args;
      return { prepared: true, message: "候选将随回复展示，由用户审核保存。" };
    }
    if (name === "find_capabilities")
      return this.capabilities.discover
        ? this.capabilities.discover(args.query)
        : this.capabilities.find(args.query);
    if (name === "request_capability")
      return this.capabilities.request(args.name);
    if (name === "create_capability") {
      this.ensure();
      const recipe = {
        ...validateRecipe(args, this.capabilities.catalog()),
        sourceMessageId: this.scope.userMessageId,
      };
      this.store.putRecipe(this.scope, this.owner, recipe);
      this.capabilities.recipes = this.store.recipes(this.scope);
      const result = await this.capabilities.request(recipe.name);
      return {
        ...result,
        message: "组合结构已校验；实际调用仍逐步检查权限、参数和回执。",
      };
    }
    if (name === "search_context" || name === "read_context") {
      if (
        name === "read_context" &&
        this.task &&
        /^history_\d+$/.test(args.id)
      ) {
        const text = this.store.readArchived?.(this.task.id, args.id);
        if (!text) throw Error("当前任务中没有这份可见历史记录。");
        return {
          id: args.id,
          text: text.slice(args.offset, args.offset + 8000),
          nextOffset:
            args.offset + 8000 < text.length ? args.offset + 8000 : null,
        };
      }
      const documents = [
        ...this.documents,
        ...(this.task
          ? [
              {
                id: "task_plan",
                title: "当前完整任务目标与计划",
                text: JSON.stringify({
                  goal: this.task.originalGoal,
                  requirements: this.task.requirements,
                  steps: this.task.steps,
                }),
              },
            ]
          : []),
        ...(this.task?.userInputs || []).map((m) => ({
          id: "turn_" + m.id,
          title: "用户要求与补充",
          text: m.text,
        })),
        ...(this.task?.artifacts || []).map((a) => ({
          id: a.id,
          title: a.title,
          text: a.text || JSON.stringify(a.resource),
        })),
        ...(this.task?.evidence || []).map((e) => ({
          id: e.id,
          title: e.label,
          text: JSON.stringify(e.result),
        })),
      ];
      if (name === "search_context") {
        const query = args.query.trim().toLowerCase();
        return {
          documents: [
            ...rankSearch(
              documents,
              query,
              (d) => d.title + " " + d.text,
              24,
            ).map((d) => ({
              id: d.id,
              title: d.title,
              excerpt: d.text.slice(0, 500),
              length: d.text.length,
            })),
            ...(this.task
              ? this.store.archived?.(this.task.id, args.query) || []
              : []),
          ].slice(0, 24),
        };
      }
      const doc = documents.find((d) => d.id === args.id);
      if (!doc) throw Error("当前任务中没有这份可见资料。");
      let adopted;
      if (args.adopt) {
        const task = this.ensure();
        const text = doc.text.slice(
          args.offset,
          args.length ? args.offset + args.length : undefined,
        );
        if (!text.trim()) throw Error("选取的原文为空。");
        adopted = {
          id: "artifact_" + digest([task.id, doc.id, args.offset, text]),
          kind: "adopted.text",
          title: doc.title,
          sourceContextId: doc.id,
          text,
          contentHash: digest(text),
          createdAt: Date.now(),
        };
        if (!task.artifacts.some((a) => a.id === adopted.id))
          task.artifacts.push(adopted);
        this.save("artifact_adopted");
      }
      return {
        id: doc.id,
        ...(adopted && {
          artifactId: adopted.id,
          contentHash: adopted.contentHash,
          adoptedLength: adopted.text.length,
        }),
        title: doc.title,
        text: doc.text.slice(args.offset, args.offset + 8000),
        nextOffset:
          args.offset + 8000 < doc.text.length ? args.offset + 8000 : null,
      };
    }
    const task = this.ensure();
    if (terminal.has(task.status)) throw Error("任务已经结束，请交付结果。");
    if (name === "update_task") {
      const task = structuredClone(this.task);
      if (!Object.keys(args).length)
        throw Error("请提供本次需要更新的目标、要求、步骤或进展。");
      if (args.requirements) task.mode = "persistent";
      if (task.schemaVersion >= 3 && args.requirements)
        args.requirements = args.requirements.map(canonicalRequirement);
      if (args.revise) {
        if (
          !args.goal ||
          !args.requirements ||
          (task.goalSourceMessageId || task.messageIds[0]) ===
            this.scope.userMessageId
        )
          throw Error(
            "只有新的用户要求才能修改任务目标，并须提供完整的新验收条件。",
          );
        task.goalHistory = [
          ...(task.goalHistory || []),
          { goal: task.goal, requirements: task.requirements },
        ];
        task.goalSourceMessageId = this.scope.userMessageId;
        task.goal = args.goal;
        task.requirements = [];
        task.steps = [];
        task.gaps = [];
        task.external = null;
      }
      if (args.goal && task.requirements.length && args.goal !== task.goal)
        throw Error("已开始任务的目标不可缩减，请沿用原目标并更新步骤。");
      if (args.goal) task.goal = args.goal;
      for (const req of args.requirements || []) {
        const prior = task.requirements.find((r) => r.id === req.id);
        const priorTools = prior ? requirementTools(prior) : [];
        const nextTools = requirementTools(req);
        if (
          prior &&
          (prior.check !== req.check ||
            prior.description !== req.description ||
            ["operation", "inputArtifactId"].some(
              (key) => prior[key] && prior[key] !== req[key],
            ) ||
            (priorTools.length > 0 &&
              (!nextTools.length ||
                nextTools.some((tool) => !priorTools.includes(tool)))) ||
            Object.entries(prior.resource || {}).some(
              ([key, value]) => req.resource?.[key] !== value,
            ))
        )
          throw Error("已有验收要求不可改写；可以补充新的要求。");
      }
      task.requirements = [
        ...new Map(
          [...task.requirements, ...(args.requirements || [])].map((r) => [
            r.id,
            r,
          ]),
        ).values(),
      ];
      if (
        task.requirements.length >
        (task.requirePlanConfirmation ? MAX_TASK_PLAN_ITEMS : 24)
      )
        throw Error("任务验收项过多，请先完成当前任务。");
      if (args.steps)
        task.steps = args.steps.map((step, index) => {
          const prior = task.steps.find((s) => s.id === step.id);
          const next = {
            ...prior,
            ...step,
            ...(task.schemaVersion >= 3 &&
            step.dependsOn === undefined &&
            !prior?.dependsOn
              ? { dependsOn: index ? [args.steps[index - 1].id] : [] }
              : {}),
          };
          if (
            prior?.execution &&
            step.execution &&
            digest(prior.execution) !== digest(step.execution)
          )
            delete next.executionAttempt;
          return next;
        });
      if (new Set(task.steps.map((s) => s.id)).size !== task.steps.length)
        throw Error("每个子任务必须有独立的步骤标识。");
      if (task.schemaVersion >= 3) validatePreparedSteps(task);
      if (args.activeStepId) {
        if (!task.steps.some((s) => s.id === args.activeStepId))
          throw Error("当前子任务不在计划中。");
        task.activeStepId = args.activeStepId;
      }
      if (args.gaps)
        task.gaps = [
          ...new Map(
            [...task.gaps, ...args.gaps].map((g) => [g.id, g]),
          ).values(),
        ];
      if (args.progress) task.progress = args.progress;
      task.verification = null;
      task.status = task.questions.some((q) => !q.answer)
        ? task.questions.some((q) => !q.answer && q.kind === "authorization")
          ? "waiting_auth"
          : "waiting_user"
        : "running";
      reconcileSteps(task);
      if (task.schemaVersion >= 3) {
        await this.capabilities.prepare?.(task);
        this.refreshFeasibility(task);
      }
      reviewPlan(task);
      this.task = task;
      this.userInputNeedsReview = false;
      this.save("updated");
      return this.context();
    }
    if (name === "ask_user") {
      if (task.mode === "persistent" && !task.requirements.length)
        throw Error(
          "先用 update_task 保存原目标的验收条件，再说明具体缺口；不要因提问丢失任务要求。",
        );
      if (
        args.blocksStepIds?.some((id) => !task.steps.some((s) => s.id === id))
      )
        throw Error("问题引用了不存在的任务步骤。");
      const sources = new Set([
        ...this.documents.map((d) => d.id),
        ...task.evidence.map((e) => e.id),
        ...task.artifacts.map((a) => a.id),
      ]);
      if (args.checkedSources)
        args.checkedSources = args.checkedSources.map((id) =>
          knownReference(id, sources),
        );
      if (args.checkedSources?.some((id) => !sources.has(id)))
        throw Error("问题引用了当前任务不可见的资料，请先检索真实资料编号。");
      const prior = task.questions.find(
        (q) => !q.answer && q.kind !== "plan_confirmation",
      );
      if (prior && prior.question !== args.question)
        throw Error("已有待回答问题，请合并必要信息，等待用户回复。");
      const question = prior || {
        id: randomUUID(),
        ...args,
        createdAt: Date.now(),
      };
      if (!prior) task.questions.push(question);
      task.status =
        args.kind === "authorization" ? "waiting_auth" : "waiting_user";
      task.progress = args.reason;
      this.save("question");
      return { status: task.status, question };
    }
    if (name === "wait_for_result") {
      const evidence = task.evidence.find(
        (e) => e.id === args.evidenceId && e.ok && e.kind === "tool",
      );
      if (!evidence) throw Error("等待必须引用真实工具回执。");
      const waiting = externalWaitFor(evidence);
      if (waiting && !evidence.mediaReady) {
        task.external = {
          ...waiting,
          since: task.external?.since || Date.now(),
          checks: task.external?.checks || 0,
        };
      }
      task.status = "waiting_external";
      task.progress = args.reason;
      this.save("waiting");
      return {
        status: task.status,
        automatic: !!task.external,
        message: task.external
          ? "宿主将查询原任务；结果就绪后自动继续验收。"
          : "已保存检查点，当前工具未提供受支持的自动查询接口。后续继续查询原任务，不要再次提交。",
      };
    }
    if (name === "submit_result") {
      if (task.requirePlanConfirmation && !planApproved(task))
        throw Error(
          "请先生成有名称的子任务计划，等待用户通过卡片确认；确认前不能执行或交付任务完成结果。",
        );
      const knownIds = new Set(task.evidence.map((e) => e.id));
      if (args.answer?.trim()) task.answer = args.answer.trim();
      reconcileSteps(task);
      const checks = args.checks.map((c) => ({
        ...c,
        evidenceIds: c.evidenceIds.map((id) => knownReference(id, knownIds)),
      }));
      const steps = task.steps.map((s) =>
        deliveryStep(s) ? { ...s, status: "done" } : s,
      );
      const verdict = verifyResult({ ...task, steps }, checks);
      if (verdict.accepted) task.steps = steps;
      task.verification = {
        ...verdict,
        checks,
        summary: args.summary,
      };
      task.progress = verdict.accepted
        ? args.summary
        : verdict.failures.join("；");
      this.save("verification");
      if (task.schemaVersion >= 3 && verdict.accepted)
        this.finishKnown(task.answer || args.summary, true);
      return verdict;
    }
  }
  async execute(name, args, callId, execute) {
    this.consumeAnswers();
    if (
      (this.task?.answerRevision || 0) > (this.contextAnswerRevision || 0) &&
      !callId.startsWith("prepared:") &&
      ![
        "read_context",
        "search_context",
        "find_capabilities",
        "request_capability",
      ].includes(name)
    )
      throw Error(
        "用户刚刚回答了任务问题。请先读取最新上下文，再决定下一步；本次操作尚未执行。",
      );
    if (Object.hasOwn(controlSchemas, name)) {
      const value = await this.control(name, args);
      this.recordExchange(name, args, callId, value);
      return value;
    }
    const task = this.ensure();
    if (terminal.has(task.status)) throw Error("任务已经结束，请交付结果。");
    if (task.requirePlanConfirmation && !planApproved(task)) {
      task.executionRequested = true;
      task.mode = "persistent";
      reviewPlan(task);
      this.save("plan_required");
      throw Error(
        "任务还没有经用户确认。先用 update_task 列出目标、验收条件和每个子任务名称，再等待卡片确认；此工具尚未执行。",
      );
    }
    await this.capabilities.authorize(name);
    this.assertActive();
    const readOnly = this.capabilities.readOnly(name, args);
    if (task.schemaVersion >= 3 && this.userInputNeedsReview && !readOnly)
      throw Error(
        "用户刚补充了要求。先用 update_task 核对或调整计划，再继续写入；本次操作尚未执行。",
      );
    const operation = operationOf(name, args, readOnly);
    const recipe = this.capabilities.recipe?.(name);
    const trackEffect = !readOnly && !recipe;
    const key = digest([name, args, recipe?.version]);
    let prior = trackEffect && this.store.effect(task.id, key);
    if (
      prior?.delivery === "received" &&
      retryablePermissionDenial(prior.result) &&
      (task.evidence.find((e) => e.id === prior.evidence)?.userInputCount ??
        Infinity) < (task.userInputs?.length || 0)
    )
      prior = null;
    if (prior?.delivery === "received") {
      const value = this.withEvidence(prior.result, prior.evidence);
      this.recordExchange(name, args, callId, value, !!value.isError);
      return value;
    }
    if (prior && prior.delivery !== "not_sent")
      throw Error("这次操作的投递结果尚未确认，请先查询原任务，不能重复提交。");
    const step =
      task.steps.find(
        (s) => s.id === task.activeStepId && s.status !== "done",
      ) ||
      task.steps.find(
        (s) => s.status !== "done" && expectedOperation(s) === operation,
      ) ||
      task.steps.find((s) => s.status === "running") ||
      (task.plan && task.steps.find((s) => s.status !== "done"));
    if (task.schemaVersion >= 3) {
      this.refreshFeasibility();
      const blocks = blockingFor(task, step?.id);
      const resolving =
        readOnly &&
        (task.blockers || []).some(
          (b) => !b.resolved && canResolve(b, name, args, true),
        );
      const unresolved = resolving
        ? []
        : blocks.filter((b) => !canResolve(b, name, args, readOnly));
      const dependencies = (resolving ? [] : step?.dependsOn || []).filter(
        (id) => task.steps.find((s) => s.id === id)?.status !== "done",
      );
      if (unresolved.length || dependencies.length) {
        task.status = task.questions.some((q) => !q.answer)
          ? "waiting_user"
          : "blocked";
        this.save("step_blocked");
        throw Error(
          unresolved[0]?.message ||
            "此步骤的前置成果尚未通过核验，不能提前执行。",
        );
      }
      if (!readOnly && step?.execution) {
        if (
          name !== step.execution.tool ||
          digest(args) !== digest(preparedArguments(task, step))
        )
          throw Error(
            "这次写操作与已确认的步骤参数不一致，请先调整计划再确认。",
          );
      }
      const validation = this.capabilities.validateArgs?.(name, args);
      if (validation?.error) throw Error(validation.error);
    }
    if (
      !readOnly &&
      !recipe &&
      task.mode === "auto" &&
      task.evidence.some(
        (e) =>
          e.ok &&
          e.operation !== "resource.read" &&
          (e.label !== name ||
            e.operation !== operationOf(name, args, readOnly)),
      )
    ) {
      task.mode = "persistent";
      this.save("contract_required");
    }
    if (recipe?.steps.length > 1) task.mode = "persistent";
    if (!readOnly && task.mode === "persistent" && !task.requirements.length)
      throw Error(
        "这个持续任务还没有验收条件。请先 update_task 记录原目标和交付要求，再执行写入或生成；可继续读取资料。",
      );
    const title = activityTitle(name, args);
    if (step && (task.plan || expectedOperation(step) === operation))
      step.status = "running";
    const activityId = step
      ? "step:" + step.id
      : "tool:" + this.scope.userMessageId + ":" + title;
    let activity = task.activities.find((a) => a.id === activityId);
    if (!activity) {
      activity = {
        id: activityId,
        kind: "tool",
        title: step?.title || step?.description || title,
        messageId: this.scope.userMessageId,
        calls: 0,
      };
      task.activities.push(activity);
    }
    activity.status = "running";
    activity.calls++;
    activity.text = "";
    activity.command = activityCommand(name, args);
    activity.action = null;
    this.save("activity_started");
    if (trackEffect)
      this.store.putEffect(this.scope, this.owner, task.id, key, {
        delivery: "sent",
        name,
        args,
      });
    let result;
    const onProgress = (progress) => {
      if (
        this.signal.aborted ||
        activity.status !== "running" ||
        this.task !== task
      )
        return;
      const line = activityLine(
        typeof progress === "string" ? progress : progress?.message,
      );
      if (!line || line === activity.command) return;
      try {
        this.store.assertLease(this.scope, this.owner);
        activity.command = line;
        if (Date.now() - (activity.lastProgressAt || 0) > 180) {
          activity.lastProgressAt = Date.now();
          this.save("tool_progress");
        }
      } catch {
        /* A stopped or superseded turn cannot publish late progress. */
      }
    };
    try {
      result = recipe
        ? await executeRecipe(recipe, args, (tool, values, stepId) =>
            this.execute(tool, values, callId + ":" + stepId, execute),
          )
        : await execute(name, args, callId, onProgress);
      // Preserve a received receipt even if cancellation raced with the response.
      const evidence = normalizeEvidence(name, args, result, {
        id: "ev_" + randomUUID(),
        taskId: task.id,
        callId,
        readOnly,
      });
      if (step) evidence.stepId = step.id;
      evidence.userInputCount = task.userInputs?.length || 0;
      attachEvidenceOrigin(task, evidence);
      task.evidence.push(evidence);
      if (
        step &&
        expectedOperation(step) === evidence.operation &&
        evidence.ok &&
        !task.plan
      ) {
        step.status =
          evidence.operation === "generation.status" && !evidence.mediaReady
            ? "waiting"
            : "done";
      }
      const artifact = artifactFrom(evidence);
      if (artifact) task.artifacts.push(artifact);
      if (task.schemaVersion >= 3) {
        observeBlockers(task, name, args, result, step?.id);
        reconcileSteps(task);
        this.refreshFeasibility();
        const pendingMacro = (task.blockers || []).find(
          (b) =>
            !b.resolved &&
            b.code === "WAAO_MACRO_CONFIRMATION_REQUIRED" &&
            b.resource?.macro_id,
        );
        const macroRead = "mcp__waao__macro_get";
        const automatic = !evidence.mediaReady && externalWaitFor(evidence);
        const wait =
          pendingMacro &&
          this.capabilities
            .catalog?.()
            .some((c) => c.name === macroRead && c.state === "ready")
            ? {
                name: macroRead,
                args: { macro_id: pendingMacro.resource.macro_id },
                expectedStatus: "enabled",
                stepId: step?.id,
              }
            : automatic &&
                this.capabilities
                  .catalog?.()
                  .some((c) => c.name === automatic.name && c.state === "ready")
              ? { ...automatic, stepId: step?.id }
              : null;
        if (wait) {
          const same =
            task.external &&
            task.external.name === wait.name &&
            digest(task.external.args) === digest(wait.args);
          task.external = {
            ...wait,
            since: same ? task.external.since : Date.now(),
            checks: same ? task.external.checks : 0,
          };
          task.status = "waiting_external";
          task.progress = pendingMacro
            ? "等待 WAAO 确认并启用宏，期间由宿主核对状态。"
            : "平台已受理，宿主将查询原任务并保存结果。";
          if (!pendingMacro)
            addBlocker(task, {
              kind: "external",
              code: "WAITING_EXTERNAL_RESULT",
              message: "等待原平台任务返回结果。",
              stepIds: step ? [step.id] : [],
              resolver: wait,
              resource: evidence.resource,
            });
        } else if (publicBlockers(task).length && !readySteps(task).length)
          task.status = "blocked";
        else if (task.status === "blocked" && readySteps(task).length)
          task.status = "running";
      }
      activity.status = evidence.ok ? "done" : "failed";
      activity.evidenceId = evidence.id;
      const accessIssue =
        /waao/.test(name) && !evidence.ok ? waaoAccessIssue(result) : null;
      activity.text = evidence.ok
        ? `${title}：已收到结果。`
        : accessIssue?.message || "操作未成功，正在核对原因";
      activity.action = accessIssue
        ? { label: accessIssue.actionLabel, url: accessIssue.actionUrl }
        : null;
      task.verification = null;
      if (trackEffect)
        this.store.putEffect(this.scope, this.owner, task.id, key, {
          delivery: "received",
          result,
          evidence: evidence.id,
        });
      this.save("tool_result");
      const value = this.withEvidence(result, evidence.id);
      this.recordExchange(name, args, callId, value, !!value.isError);
      return value;
    } catch (error) {
      activity.status = "failed";
      const accessIssue = /waao/.test(name) ? waaoAccessIssue(error) : null;
      error.issue ||= {
        code: accessIssue?.code || "TOOL_EXECUTION_FAILED",
        source: "tool",
        retryable: false,
        message:
          accessIssue?.message ||
          `${title}未能确认执行结果，已保存原操作，请先核对回执。`,
      };
      activity.text =
        accessIssue?.message || "本步未完成，原操作与回执已保留。";
      activity.action = accessIssue
        ? { label: accessIssue.actionLabel, url: accessIssue.actionUrl }
        : null;
      if (trackEffect)
        this.store.putEffect(this.scope, this.owner, task.id, key, {
          delivery:
            this.capabilities.delivery?.(name, callId) === "not_sent"
              ? "not_sent"
              : "unknown",
          name,
          args,
        });
      this.save("activity_failed");
      throw error;
    }
  }
  withEvidence(result, evidenceId) {
    const artifact = this.task?.artifacts.find(
      (a) => a.evidenceId === evidenceId,
    );
    const receipt = this.task?.evidence.find((e) => e.id === evidenceId);
    const marker = {
      harnessEvidence: evidenceId,
      ...(artifact && { harnessArtifactId: artifact.id }),
      ...(receipt && {
        operation: receipt.operation,
        resource: receipt.resource,
      }),
    };
    if (Array.isArray(result?.content))
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: JSON.stringify(marker),
          },
        ],
      };
    return { ...result, ...marker };
  }
  finish(text) {
    if (!this.task) return text;
    if (this.task.status === "running") {
      this.task.status = "interrupted";
      this.task.progress = "本轮运行结束，任务尚未通过验收。";
      this.save("interrupted");
    }
    const answer = deliveryText(this.task, text);
    this.task.report = {
      text: answer,
      status: this.task.status,
      artifactIds: this.task.artifacts.map((a) => a.id),
    };
    if (this.task.status === "completed") {
      this.task.finalText = answer;
      this.save("delivered");
      return answer;
    }
    this.save("report");
    return answer;
  }
  fail(cancelled, error) {
    if (!this.task && error && !this.signal.aborted) this.ensure();
    if (
      !this.task ||
      terminal.has(this.task.status) ||
      this.task.status === "paused_budget"
    )
      return;
    const issue = !cancelled && error?.issue;
    this.task.failure =
      issue ||
      (!cancelled && error
        ? {
            code: error.code || "EXECUTION_INTERRUPTED",
            source: "runtime",
            message: error.message,
            retryable: true,
          }
        : null);
    this.task.status = cancelled
      ? "cancelled"
      : issue?.source === "model"
        ? "waiting_model"
        : "interrupted";
    this.task.progress = cancelled
      ? "用户已停止任务。"
      : issue?.message || "运行中断，进度与已有回执已保存。";
    for (const activity of this.task.activities || [])
      if (activity.status === "running") activity.status = "waiting";
    this.save(cancelled ? "cancelled" : "interrupted");
  }
  card() {
    return taskCard(this.task);
  }
  close() {
    this.store.release(this.scope, this.owner);
  }
}
