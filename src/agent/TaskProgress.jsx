import React, { useState } from "react";
import HumanRequestCard from "./HumanRequestCard.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import StreamingMarkdown from "./StreamingText.jsx";
import { activityStatus } from "../../shared/agent/task-activity.mjs";
import "./task-progress.css";

const labels = {
  running: "正在推进",
  waiting_plan: "待确认计划",
  blocked: "有待处理的条件",
  waiting_model: "等待模型服务恢复",
  waiting_user: "等待回答",
  waiting_auth: "等待授权",
  waiting_external: "等待外部结果",
  paused_budget: "已保存检查点",
  interrupted: "需要继续处理",
  completed: "已完成",
  cancelled: "已停止",
};

function TaskQuestion({
  task,
  question,
  busy,
  allowQueueReply,
  replyBlockedReason,
  onReply,
  onOpenTools,
}) {
  const [answer, setAnswer] = useWorkspaceDraft(
    `task-answer:${task.id}:${question.id}`,
    "",
  );
  const [sending, setSending] = useState(false);
  const blocked = busy && !allowQueueReply;
  const received = !!question.pendingAnswer;
  async function send() {
    if (!answer.trim() || sending || blocked || received) return;
    setSending(true);
    try {
      const accepted = await onReply(answer.trim(), {
        taskId: task.id,
        questionId: question.id,
      });
      if (accepted) setAnswer("");
    } finally {
      setSending(false);
    }
  }
  return (
    <HumanRequestCard
      title={question.question}
      context={task.goal}
      description={question.reason}
      status={received ? "已收到回答" : "等待回答"}
      footer={
        <>
          {question.kind === "authorization" && (
            <button type="button" disabled={sending} onClick={onOpenTools}>
              打开工具设置
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={blocked || sending || received || !answer.trim()}
            onClick={send}
          >
            {sending
              ? "正在提交…"
              : received
                ? "已收到，正在接续"
                : "回答并继续"}
          </button>
          {blocked && !sending && (
            <p className="agent-task-reply-wait" role="status">
              {replyBlockedReason ||
                "可以先选择或填写回答，当前操作结束后即可发送。"}
            </p>
          )}
        </>
      }
    >
      {!!question.options.length && (
        <div className="agent-task-options">
          {question.options.map((option) => (
            <button
              type="button"
              key={option}
              disabled={sending || received}
              aria-pressed={answer === option}
              onClick={() => setAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <label className="agent-human-note">
        你的回答
        <textarea
          rows={2}
          maxLength={2000}
          value={question.pendingAnswer?.text || answer}
          disabled={sending || received}
          placeholder="选择上方选项，或直接输入回答…"
          onChange={(event) => setAnswer(event.target.value)}
        />
      </label>
    </HumanRequestCard>
  );
}

function PlanActions({ task, busy, allowQueueReply, onReply }) {
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [change, setChange] = useWorkspaceDraft(`task-plan:${task.id}`, "");
  const received = task.questions?.some(
    (q) => q.id === task.plan.questionId && q.pendingAnswer,
  );
  const blocked = busy && (!allowQueueReply || editing);
  async function send(approve) {
    if (blocked || sending || received || (!approve && !change.trim())) return;
    setSending(true);
    try {
      const accepted = await onReply(
        approve
          ? "确认这份任务计划，开始执行。"
          : "请调整这次任务计划：" + change.trim(),
        approve
          ? { taskId: task.id, questionId: task.plan.questionId }
          : undefined,
      );
      if (!approve && accepted) {
        setEditing(false);
        setChange("");
      }
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="agent-task-plan-actions">
      <p>确认后按这些步骤连续执行。</p>
      {editing && (
        <label className="agent-task-plan-edit">
          需要怎样调整
          <textarea
            rows={2}
            value={change}
            maxLength={2000}
            disabled={sending}
            onChange={(event) => setChange(event.target.value)}
            placeholder="例如：先检查现有素材，再生成缺少的图片"
          />
        </label>
      )}
      <div className="agent-task-plan-buttons">
        <button
          type="button"
          className="primary"
          disabled={
            blocked ||
            received ||
            sending ||
            (!editing && task.plan.canConfirm === false) ||
            (editing && !change.trim())
          }
          onClick={() => send(!editing)}
        >
          {sending
            ? "正在提交…"
            : received
              ? "已确认，正在接续"
              : editing
                ? "更新计划"
                : "确认并开始执行"}
        </button>
        <button
          type="button"
          disabled={sending || received}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "返回计划" : "调整计划"}
        </button>
      </div>
    </div>
  );
}

export default function TaskProgress({
  task,
  busy,
  allowQueueReply = false,
  replyBlockedReason,
  onReply,
  onOpenTools,
}) {
  if (!task) return null;
  const activities = task.activities || [];
  if (
    task.status === "completed" &&
    !task.plan &&
    !task.steps?.length &&
    !activities.some((a) => a.kind === "tool")
  )
    return null;
  const planned = (task.steps || []).map((step) => {
    const activity = activities.find((item) => item.id === "step:" + step.id);
    return {
      ...activity,
      id: "step:" + step.id,
      title: step.title || step.description,
      text:
        activity?.text ||
        (task.plan?.status === "pending" ? step.description : ""),
      status:
        step.status === "done"
          ? "done"
          : task.plan
            ? activity?.status === "failed"
              ? "failed"
              : step.status === "running" || activity?.status === "running"
                ? "running"
                : step.status
            : activity?.status || step.status,
    };
  });
  const items = [
    ...planned,
    ...activities.filter(
      (item) =>
        !planned.some((step) => step.id === item.id) &&
        (!task.plan || !planned.length) &&
        (item.kind !== "model" || item.text || item.status === "running"),
    ),
  ].map((item) =>
    item.status === "running" &&
    [
      "blocked",
      "waiting_model",
      "paused_budget",
      "interrupted",
      "cancelled",
    ].includes(task.status)
      ? { ...item, status: "waiting" }
      : item,
  );
  return (
    <section
      className={`agent-task-progress${task.status === "completed" ? " is-completed" : ""}`}
      aria-label="任务进度"
    >
      <header>
        <strong>{labels[task.status] || "任务进度"}</strong>
        <span>{task.goal}</span>
        {!!items.length && (
          <small className="agent-task-count">
            {items.filter((item) => item.status === "done").length}/
            {items.length}
          </small>
        )}
      </header>
      {!!task.blockers?.length && (
        <div className="agent-task-blockers" role="status">
          {task.blockers.map((b) => (
            <p key={b.id}>
              {b.message}
              {b.action?.url && (
                <>
                  {" "}
                  <a
                    href={b.action.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {b.action.label}
                  </a>
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {task.failure &&
        ["waiting_model", "interrupted"].includes(task.status) && (
          <p className="agent-task-blockers" role="status">
            {task.failure.message}
          </p>
        )}
      {!items.length && task.progress && <p role="status">{task.progress}</p>}
      {!!items.length && (
        <ol className="agent-task-activities" aria-label="本次任务进展">
          {items.map((item) => (
            <li
              key={item.id}
              className={`agent-task-activity is-${item.status}`}
            >
              <div className="agent-task-activity-heading">
                <span className="agent-task-activity-dot" aria-hidden="true">
                  {item.status === "done"
                    ? "✓"
                    : item.status === "failed"
                      ? "!"
                      : ""}
                </span>
                <strong>{item.title}</strong>
                <span className="agent-task-activity-status">
                  {activityStatus[item.status] || "待处理"}
                </span>
              </div>
              {(item.text || item.command) && (
                <div className="agent-task-activity-body">
                  {item.status === "running" && item.command ? (
                    <p className="agent-task-live-line" role="status">
                      {item.command}
                    </p>
                  ) : (
                    <StreamingMarkdown
                      text={item.text || item.command}
                      animate={
                        item.status === "running" && task.status === "running"
                      }
                      streamKey={item.id}
                    />
                  )}
                </div>
              )}
              {item.action?.url && (
                <a
                  className="agent-task-activity-action"
                  href={item.action.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.action.label}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
      {task.plan?.status === "pending" && onReply && (
        <PlanActions {...{ task, busy, allowQueueReply, onReply }} />
      )}
      {(task.questions || [])
        .filter((question) => question.kind !== "plan_confirmation")
        .map((question) => (
          <TaskQuestion
            key={question.id}
            {...{
              task,
              question,
              busy,
              allowQueueReply,
              replyBlockedReason,
              onReply,
              onOpenTools,
            }}
          />
        ))}
      {!!task.answerEvents?.length && (
        <details className="agent-task-answers">
          <summary>已收到的补充</summary>
          {task.answerEvents.map((event) => (
            <p key={event.id}>
              <strong>{event.question}</strong>
              <br />
              {event.answer}
            </p>
          ))}
        </details>
      )}
      {task.budget && (
        <details className="agent-task-usage">
          <summary>运行用量</summary>
          <p>
            累计模型请求 {task.budget.requests || 0} 次 · 工具回执{" "}
            {task.budget.tools || 0} 条
            {Number.isFinite(task.budget.tokens)
              ? ` · 模型用量 ${task.budget.tokens.toLocaleString()} token`
              : ""}
          </p>
          <p>
            包含重复上下文和缓存用量；累计预算
            {task.budget.maxRequests == null && task.budget.maxTokens == null
              ? "不限"
              : "按当前设置"}
            。
          </p>
        </details>
      )}
      {!["completed", "cancelled", "running", "waiting_plan"].includes(
        task.status,
      ) &&
        !task.questions?.length && (
          <p className="agent-note">
            {task.status === "waiting_external"
              ? task.automaticWait
                ? "平台结果返回后会继续处理。"
                : "原回执已保存，可以继续查询状态。"
              : "进度已保存，可在下方补充信息或发送“继续”。"}
          </p>
        )}
    </section>
  );
}
