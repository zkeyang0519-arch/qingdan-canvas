import React, { useState } from "react";
import HumanRequestCard from "./HumanRequestCard.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import "./task-progress.css";

const labels = {
  running: "正在推进",
  waiting_user: "等待回答",
  waiting_auth: "等待授权",
  waiting_external: "等待外部结果",
  paused_budget: "已保存检查点",
  interrupted: "需要继续处理",
  completed: "已通过验收",
  cancelled: "已停止",
};

function TaskQuestion({ task, question, busy, onReply, onOpenTools }) {
  const [answer, setAnswer] = useWorkspaceDraft(
    `task-answer:${task.id}:${question.id}`,
    "",
  );
  const [sending, setSending] = useState(false);
  async function send() {
    if (!answer.trim() || sending || busy) return;
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
      status="等待回答"
      footer={
        <>
          {question.kind === "authorization" && (
            <button type="button" disabled={busy} onClick={onOpenTools}>
              打开工具设置
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || sending || !answer.trim()}
            onClick={send}
          >
            {sending ? "正在提交…" : "回答并继续"}
          </button>
        </>
      }
    >
      {!!question.options.length && (
        <div className="agent-task-options">
          {question.options.map((option) => (
            <button
              type="button"
              key={option}
              disabled={busy || sending}
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
          value={answer}
          disabled={busy || sending}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </label>
    </HumanRequestCard>
  );
}

export default function TaskProgress({
  task,
  busy,
  onReply,
  onOpenTools,
  onStop,
}) {
  if (!task) return null;
  return (
    <section className="agent-task-progress" aria-label="任务进度">
      <header>
        <strong>{labels[task.status] || "任务进度"}</strong>
        <span>{task.goal}</span>
      </header>
      {task.progress && <p role="status">{task.progress}</p>}
      {!!task.steps.length && (
        <details>
          <summary>查看任务步骤</summary>
          <ol>
            {task.steps.map((step) => (
              <li key={step.id}>
                <span aria-label={step.status === "done" ? "已完成" : "未完成"}>
                  {step.status === "done" ? "✓" : "○"}
                </span>{" "}
                {step.description}
              </li>
            ))}
          </ol>
        </details>
      )}
      {(task.questions || []).map((question) => (
        <TaskQuestion
          key={question.id}
          {...{ task, question, busy, onReply, onOpenTools }}
        />
      ))}
      {task.result && (
        <details>
          <summary>查看交付结果</summary>
          <p className="agent-task-result">{task.result}</p>
        </details>
      )}
      {!["completed", "cancelled"].includes(task.status) && onStop && (
        <button type="button" onClick={onStop}>
          停止任务推进
        </button>
      )}
      {!["completed", "cancelled", "running"].includes(task.status) &&
        !task.questions.length && (
          <p className="agent-note">
            进度已保存，可在下方补充信息或发送“继续”。
          </p>
        )}
    </section>
  );
}
