import { randomUUID } from "node:crypto";
import { controlSchemas, controlSpecs } from "./contracts.mjs";
import { digest } from "./task-store.mjs";
import { modelState, taskCard, verifyResult } from "./verification.mjs";
import { validateRecipe, executeRecipe } from "./recipes.mjs";

const defaults = { maxRequests: 80, maxTokens: 250000, maxRunRequests: 24 };
const terminal = new Set(["completed", "cancelled"]);
const safeMessages = (messages) =>
  messages
    .filter((m) => ["user", "assistant", "toolResult"].includes(m.role))
    .map((m) =>
      m.role === "assistant"
        ? { ...m, content: m.content.filter((p) => p.type !== "thinking") }
        : m,
    );

// Drop whole old user turns, never a tool call independently of its result.
export function replayWindow(messages, limit = 36000) {
  const groups = [];
  for (const message of messages) {
    if (message.role === "user") groups.push([]);
    groups.at(-1)?.push(message);
  }
  const kept = [];
  let size = 0;
  for (const group of groups.reverse()) {
    const bytes = JSON.stringify(group).length;
    if (size + bytes > limit) break;
    kept.unshift(...group);
    size += bytes;
  }
  return kept;
}

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
  }) {
    Object.assign(this, { store, scope, input, jobId, signal, capabilities });
    this.owner = jobId + ":" + randomUUID();
    this.limits = { ...defaults, ...limits };
    this.runRequests = 0;
    this.runTokens = 0;
    this.stalls = 0;
    store.claim(scope, this.owner);
    capabilities.recipes = store.recipes(scope);
    this.task = store.latest(scope, true);
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
      const fresh = !this.task.messageIds.includes(scope.userMessageId);
      this.task.messageIds = [
        ...new Set([...this.task.messageIds, scope.userMessageId]),
      ];
      if (fresh) {
        const pending = this.task.questions.filter((q) => !q.answer);
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
          this.task.budget.maxRequests = Math.max(
            this.task.budget.maxRequests,
            this.task.budget.requests + this.limits.maxRunRequests,
          );
          this.task.budget.maxTokens = Math.max(
            this.task.budget.maxTokens,
            this.task.budget.tokens + this.limits.maxTokens,
          );
        }
      }
      this.task.status = "running";
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
  }
  save(kind) {
    return this.store.save(this.scope, this.owner, this.task, kind);
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
      this.task.budget.tokens = this.runTokens;
      this.save("started");
    }
    return this.task;
  }
  context() {
    return modelState(this.task);
  }
  specs() {
    return [...controlSpecs, ...this.capabilities.activeSpecs()];
  }
  async rpc(event) {
    this.assertActive();
    if (event.kind === "request") {
      const budget = this.task?.budget;
      if (
        this.runRequests >= this.limits.maxRunRequests ||
        (budget &&
          (budget.requests >= budget.maxRequests ||
            budget.tokens >= budget.maxTokens))
      ) {
        if (this.task) {
          this.task.status = "paused_budget";
          this.task.progress = "已保存进度，本次运行预算用尽。";
          this.save("budget");
        }
        throw Error("任务预算用尽，检查点已保存。");
      }
      this.runRequests++;
      if (this.task) {
        this.task.budget.requests++;
        this.save("request");
      }
      return {};
    }
    if (event.kind === "checkpoint") {
      const usage = Number(event.tokens);
      if (Number.isFinite(usage) && usage > 0) {
        this.runTokens += usage;
        if (this.task) this.task.budget.tokens += usage;
      }
      if (this.task) {
        this.task.transcript = [
          ...this.baseTranscript,
          { role: "user", content: this.input.text, timestamp: Date.now() },
          ...safeMessages(event.messages || []).filter(
            (m, i) => !(i === 0 && m.role === "user"),
          ),
        ];
        // Retain a bounded dialogue checkpoint; evidence remains independently readable.
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
    if (task.verification?.accepted) {
      const verdict = verifyResult(task, task.verification.checks);
      if (verdict.accepted) {
        task.status = "completed";
        this.save("completed");
        return { continue: false };
      }
      task.verification = { ...task.verification, ...verdict };
    }
    if (
      [
        "waiting_user",
        "waiting_auth",
        "waiting_external",
        "paused_budget",
        "cancelled",
      ].includes(task.status)
    )
      return { continue: false };
    if (
      this.runRequests >= this.limits.maxRunRequests - 1 ||
      task.budget.requests >= task.budget.maxRequests - 1 ||
      task.budget.tokens >= task.budget.maxTokens
    ) {
      task.status = "paused_budget";
      task.progress = "已保存进度，需要继续时从检查点恢复。";
      this.save("budget");
      return { continue: false };
    }
    const signature = digest([
      task.requirements,
      task.steps,
      task.gaps,
      task.questions,
      task.evidence.map((e) => [e.id, e.ok, e.mediaReady]),
    ]);
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
    if (name === "find_capabilities") return this.capabilities.find(args.query);
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
      const documents = [
        ...this.documents,
        ...(this.task?.evidence || []).map((e) => ({
          id: e.id,
          title: e.label,
          text: JSON.stringify(e.result),
        })),
      ];
      if (name === "search_context") {
        const query = args.query.trim().toLowerCase();
        return {
          documents: documents
            .filter(
              (d) =>
                !query ||
                (d.title + " " + d.text).toLowerCase().includes(query),
            )
            .slice(0, 24)
            .map((d) => ({
              id: d.id,
              title: d.title,
              excerpt: d.text.slice(0, 500),
              length: d.text.length,
            })),
        };
      }
      const doc = documents.find((d) => d.id === args.id);
      if (!doc) throw Error("当前任务中没有这份可见资料。");
      return {
        id: doc.id,
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
        if (
          prior &&
          (prior.check !== req.check || prior.description !== req.description)
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
      if (task.requirements.length > 24)
        throw Error("任务验收项过多，请先完成当前任务。");
      if (args.steps) task.steps = args.steps;
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
      this.task = task;
      this.save("updated");
      return this.context();
    }
    if (name === "ask_user") {
      const prior = task.questions.find((q) => !q.answer);
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
      if (
        evidence.label === "waao" &&
        evidence.result?.id &&
        !evidence.mediaReady
      ) {
        task.external = {
          name: "waao",
          args: { action: "status", receiptId: evidence.result.id },
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
      const verdict = verifyResult(task, args.checks);
      task.verification = {
        ...verdict,
        checks: args.checks,
        summary: args.summary,
      };
      task.progress = verdict.accepted
        ? args.summary
        : verdict.failures.join("；");
      this.save("verification");
      return verdict;
    }
  }
  async execute(name, args, callId, execute) {
    if (Object.hasOwn(controlSchemas, name)) return this.control(name, args);
    const task = this.ensure();
    if (terminal.has(task.status)) throw Error("任务已经结束，请交付结果。");
    await this.capabilities.authorize(name);
    this.assertActive();
    const readOnly = this.capabilities.readOnly(name, args);
    const recipe = this.capabilities.recipe?.(name);
    const trackEffect = !readOnly && !recipe;
    const key = digest([name, args, recipe?.version]);
    const prior = trackEffect && this.store.effect(task.id, key);
    if (prior?.delivery === "received")
      return this.withEvidence(prior.result, prior.evidence);
    if (prior && prior.delivery !== "not_sent")
      throw Error("这次操作的投递结果尚未确认，请先查询原任务，不能重复提交。");
    if (trackEffect)
      this.store.putEffect(this.scope, this.owner, task.id, key, {
        delivery: "sent",
        name,
        args,
      });
    let result;
    try {
      result = recipe
        ? await executeRecipe(recipe, args, (tool, values, stepId) =>
            this.execute(tool, values, callId + ":" + stepId, execute),
          )
        : await execute(name, args, callId);
      // Preserve a received receipt even if cancellation raced with the response.
      const ok = !result?.isError;
      const evidence = {
        id: "ev_" + randomUUID(),
        label: name,
        kind: "tool",
        ok,
        mediaReady: ok && result?.playable === true,
        observedAt: Date.now(),
        result,
      };
      task.evidence.push(evidence);
      task.verification = null;
      if (trackEffect)
        this.store.putEffect(this.scope, this.owner, task.id, key, {
          delivery: "received",
          result,
          evidence: evidence.id,
        });
      this.save("tool_result");
      return this.withEvidence(result, evidence.id);
    } catch (error) {
      if (trackEffect)
        this.store.putEffect(this.scope, this.owner, task.id, key, {
          delivery:
            this.capabilities.delivery?.(name, callId) === "not_sent"
              ? "not_sent"
              : "unknown",
          name,
          args,
        });
      throw error;
    }
  }
  withEvidence(result, evidenceId) {
    if (Array.isArray(result?.content))
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: JSON.stringify({ harnessEvidence: evidenceId }),
          },
        ],
      };
    return { ...result, harnessEvidence: evidenceId };
  }
  finish(text) {
    if (!this.task) return text;
    if (this.task.status === "running") {
      this.task.status = "interrupted";
      this.task.progress = "本轮运行结束，任务尚未通过验收。";
      this.save("interrupted");
    }
    const pending = this.task.questions.find((q) => !q.answer);
    if (pending)
      return [
        pending.question,
        ...pending.options.map((o, i) => `${i + 1}. ${o}`),
        pending.reason,
      ].join("\n");
    if (this.task.status === "completed") {
      this.task.finalText = text;
      this.save("delivered");
      return text;
    }
    // Never publish a model's premature success message as the final task outcome.
    return (
      this.task.progress +
      "\n任务尚未完成，进度与回执已保存。可以在此对话补充信息或继续处理。"
    );
  }
  fail(cancelled) {
    if (
      !this.task ||
      terminal.has(this.task.status) ||
      this.task.status === "paused_budget"
    )
      return;
    this.task.status = cancelled ? "cancelled" : "interrupted";
    this.task.progress = cancelled
      ? "用户已停止任务。"
      : "运行中断，进度与已有回执已保存。";
    this.save(cancelled ? "cancelled" : "interrupted");
  }
  card() {
    return taskCard(this.task);
  }
  close() {
    this.store.release(this.scope, this.owner);
  }
}
