import React, { useEffect, useState, useId } from "react";
import HumanRequestCard from "./HumanRequestCard.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";

function Question({ request, bindingId, call, onChange, onOpenTools, inbox }) {
  const [choice, setChoice] = useState("");
  const [note, setNote] = useWorkspaceDraft(
    `connector-note:${bindingId}:${request.id}`,
    request.note || "",
  );
  const [attempt, setAttempt] = useWorkspaceDraft(
    `connector-answer:${bindingId}:${request.id}`,
    null,
  );
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const instance = useId();
  const endpoint = `/local/connector-questions?bindingId=${encodeURIComponent(bindingId)}`;
  useEffect(() => {
    const requestId = attempt?.requestId || request.answerRequestId;
    if (!requestId || busy) return;
    let active = true;
    const read = async () => {
      try {
        const result = await call(
          endpoint + "&requestId=" + encodeURIComponent(requestId),
        );
        if (!active) return;
        if (result.found && result.status !== "pending") {
          setAttempt(null);
          setError(result.error || "");
          onChange(result.questions || []);
        }
      } catch {
        /* Keep the original answer for an explicit retry. */
      }
    };
    void read();
    const timer = setInterval(read, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [attempt, request.answerRequestId, busy, call, endpoint, onChange]);
  async function answer(decision) {
    if (busy) return;
    if (decision === "open") {
      onOpenTools(request.serviceId);
      return;
    }
    const body = attempt || {
      id: request.id,
      decision,
      note,
      requestId: crypto.randomUUID(),
    };
    setAttempt(body);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await call(endpoint, { method: "POST", body });
      if (result.status !== "pending") setAttempt(null);
      setError(result.error || "");
      if (result.status === "done") setNotice("这次请求已处理。");
      if (result.status === "deferred") setOpened(false);
      onChange(result.questions || []);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (request.deferred && !opened && !inbox)
    return (
      <div className="agent-human-deferred" role="status">
        <span>{request.service} · 有一个待处理问题</span>
        <button type="button" onClick={() => setOpened(true)}>
          继续回答
        </button>
      </div>
    );
  return (
    <HumanRequestCard
      title={request.title}
      context={`${request.service} 连接 · 需要人工处理`}
      description={request.description}
      status={
        busy || attempt || request.processing ? "等待处理回执" : "等待回答"
      }
      onLater={!busy && !attempt ? () => answer("defer") : undefined}
      details={
        <p>
          {request.diagnostic}
          {request.attempts > 0 && ` 已尝试 ${request.attempts} 次自动适配。`}
        </p>
      }
      footer={
        <button
          type="button"
          className="primary"
          disabled={busy || request.processing || (!attempt && !choice)}
          onClick={() => answer(choice)}
        >
          {busy ? "正在处理…" : attempt ? "核对并重试同一回答" : "确认选择"}
        </button>
      }
    >
      <fieldset disabled={busy || !!attempt || request.processing}>
        {[
          [
            "retry",
            "我已处理，重新检测",
            "确认连接恢复后，即可继续使用此工具。",
          ],
          ["open", "打开连接设置", "查看详细诊断，完成登录或授权。"],
          [
            "disable",
            "在本项目停用此工具",
            "停止后续调用；已提交的平台任务不会被取消。",
          ],
        ].map(([value, label, description]) => (
          <label className="agent-human-choice" key={value}>
            <input
              type="radio"
              name={`connector-${instance}`}
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
        <details className="agent-human-note-disclosure">
          <summary>{note ? "补充说明（已填写）" : "补充说明（可选）"}</summary>
          <label className="agent-human-note">
            备注（可选）
            <textarea
              rows={2}
              maxLength={2000}
              value={note}
              placeholder="这次处理需要记下什么…"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </details>
      </fieldset>
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </HumanRequestCard>
  );
}

export default function ConnectorQuestions({ questions = [], ...props }) {
  return (
    <div
      className="agent-connector-questions"
      aria-label="需要你处理的连接请求"
    >
      {questions.map((request) => (
        <Question key={request.id} request={request} {...props} />
      ))}
    </div>
  );
}
