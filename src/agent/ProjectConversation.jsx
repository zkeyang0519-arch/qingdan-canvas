import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Bot, Circle, LoaderCircle, Square } from "lucide-react";
import {
  BoundBatch,
  batchStatusLabel,
  executionIsActive,
} from "./BatchPanel.jsx";
import ChatMarkdown from "./ChatMarkdown.jsx";
import AnswerActions from "./AnswerActions.jsx";
import ExecutionOutput from "./ExecutionOutput.jsx";
import StreamingMarkdown from "./StreamingText.jsx";
import ElapsedTime from "./ElapsedTime.jsx";
export { executionSegments } from "./ExecutionOutput.jsx";

function newestRun(primary, other) {
  if (!other) return primary;
  for (const key of ["reportRevision", "lastSeq"]) {
    if ((primary[key] || 0) !== (other[key] || 0))
      return (primary[key] || 0) > (other[key] || 0) ? primary : other;
  }
  if ((primary.updatedAt || "") !== (other.updatedAt || ""))
    return (primary.updatedAt || "") > (other.updatedAt || "") ? primary : other;
  if (primary.turnId !== other.turnId)
    return (primary.updatedAt || "") >= (other.updatedAt || "")
      ? primary
      : other;
  if (primary.output || other.output) return primary.output ? primary : other;
  return primary.resultReadComplete ? primary : other;
}

function runStatus(run, stopping) {
  if (stopping || (run.status === "cancel_requested" && !run.stopConfirmed))
    return "正在停止，等待电脑确认…";
  if (run.terminal && run.stopConfirmed) {
    if (run.status === "cancelled" || run.queue?.phase === "cancelled")
      return "已停止";
    if (run.status === "failed") return "执行未完成";
    if (run.queue && run.queue.phase !== "completed")
      return batchStatusLabel(run);
    return "本次执行已结束";
  }
  return (
    {
      queued: "已提交，等待电脑接收",
      preparing: "正在准备",
      running: "Codex 正在执行",
      waiting_approval: "等待审批",
      waiting_input: "等待你的回答",
      reconciliation_required: "连接中断，正在核对执行状态",
    }[run.status] || batchStatusLabel(run)
  );
}

function HistoricalOutput({ run, call, binding, onQuote }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (run.output || run.outcome?.summary || run.resultReadComplete) return;
    let alive = true;
    (async () => {
      let afterSeq = 0,
        events = [],
        result;
      do {
        const response = await call("/api/agent/execution/tools", {
          method: "POST",
          body: {
            bindingId: binding.bindingId,
            name: "codex_get_run",
            arguments: { runId: run.runId, afterSeq },
          },
        });
        result = response.result;
        if (!alive) return;
        if (
          result.run?.terminal &&
          result.run.stopConfirmed &&
          (result.run.output || result.run.resultReadComplete)
        ) {
          events = [];
          break;
        }
        events.push(...(result.events || []));
        if (result.hasMore && result.nextAfterSeq <= afterSeq)
          throw Error("输出读取暂未推进，请稍后重试。");
        afterSeq = result.nextAfterSeq;
      } while (result.hasMore);
      if (alive) setDetail({ ...result, events });
    })().catch((err) => {
      if (alive) setError(err.message);
    });
    return () => {
      alive = false;
    };
  }, [
    call,
    binding.bindingId,
    run.runId,
    run.turnId,
    run.lastSeq,
    run.output,
    run.resultReadComplete,
    run.outcome?.summary,
  ]);
  return (
    <>
      {error && !run.output ? (
        <p className="agent-error">{error}</p>
      ) : (
        <ExecutionOutput
          {...detail}
          run={newestRun(run, detail?.run)}
          historyLoaded={!!detail}
          onQuote={onQuote}
        />
      )}
    </>
  );
}

function RunMessages({
  run,
  detail,
  stopping,
  busy,
  control,
  call,
  binding,
  onProgress,
  onInspect,
  onQuote,
}) {
  const submission = run.submission;
  const text =
    submission?.text ||
    `请执行以下待办：\n\n${(run.batch?.items || []).map((item, index) => `${index + 1}. ${item.text}`).join("\n")}`;
  const active = executionIsActive(run);
  const current = detail?.run?.runId === run.runId;
  const pausedRecovery =
    run.queue?.phase === "paused" && run.status === "reconciliation_required";
  return (
    <>
      <li
        className="agent-chat-message agent-chat-user agent-chat-submission"
        data-run={run.runId}
      >
        <strong className="agent-message-author">
          你{" "}
          <span>
            提交了 {submission?.tasks?.length || run.batch?.items?.length || 1}{" "}
            项待办
          </span>
        </strong>
        <ChatMarkdown text={text} />
        {submission?.projectSummary && (
          <details className="agent-chat-attached-context">
            <summary>
              已附带项目信息
              {submission.projectSummaryStale ? " · 使用上次摘要" : ""}
            </summary>
            <ChatMarkdown
              text={[
                submission.projectSummary.overview,
                ...[
                  "completed",
                  "inProgress",
                  "pending",
                  "blockers",
                  "constraints",
                ].flatMap((key) =>
                  (submission.projectSummary[key] || []).map(
                    (item) =>
                      `- ${typeof item === "string" ? item : item.text || item.title || ""}`,
                  ),
                ),
              ]
                .filter(Boolean)
                .join("\n\n")}
            />
          </details>
        )}
      </li>
      <li
        className="agent-chat-message agent-chat-assistant agent-chat-execution"
        data-run={run.runId}
      >
        <strong className="agent-message-author">
          <Bot size={15} aria-hidden="true" />
          Codex
        </strong>
        {current ? (
          <ExecutionOutput
            key={run.runId}
            {...detail}
            run={run}
            stopping={stopping}
            onProgress={onProgress}
            onInspect={onInspect}
            onQuote={onQuote}
          />
        ) : (
          <HistoricalOutput {...{ run, call, binding, onQuote }} />
        )}
        {(active ||
          ["cancelled", "failed", "waiting_input"].includes(run.status)) && (
          <div className="agent-chat-run-status" role="status">
            {active ? (
              <LoaderCircle size={13} className="agent-stream-spinner" />
            ) : run.status === "cancelled" ? (
              <Square size={12} />
            ) : (
              <Circle size={11} />
            )}
            <span>{runStatus(run, current && stopping)}</span>
            <ElapsedTime
              startedAt={run.createdAt}
              endedAt={run.finishedAt || run.updatedAt}
              active={!(run.terminal && run.stopConfirmed)}
            />
          </div>
        )}
        {current && run.queue && (
          <div className="agent-actions">
            {run.queue.phase === "waiting_human" && (
              <button disabled={busy} onClick={() => control("confirm")}>
                确认本项验收通过
              </button>
            )}
            {run.queue.phase === "paused" &&
              run.queue.canResume &&
              !pausedRecovery && (
                <button disabled={busy} onClick={() => control("resume")}>
                  继续执行
                </button>
              )}
            {(run.queue.phase === "blocked" || pausedRecovery) && (
              <button disabled={busy} onClick={() => control("recover")}>
                {pausedRecovery ? "核对并恢复连接" : "核对执行结果"}
              </button>
            )}
          </div>
        )}
      </li>
    </>
  );
}

export function ConversationMessages({
  messages,
  renderMessage,
  job,
  runs = [],
  detail,
  notices,
  ...runProps
}) {
  const list = useRef(null);
  const following = useRef(true);
  const lastUser = useRef(null);
  const followProgress = useCallback(() => {
    if (list.current && following.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, []);
  const inspectHistory = useCallback(() => {
    following.current = false;
  }, []);
  const records = new Map(runs.map((run) => [run.runId, run]));
  if (detail?.run)
    records.set(
      detail.run.runId,
      newestRun(detail.run, records.get(detail.run.runId)),
    );
  const entries = [
    ...messages.map((message, index) => ({
      id: message.id,
      time: Date.parse(message.createdAt) || index,
      kind: "message",
      value: message,
    })),
    ...[...records.values()].map((run) => ({
      id: run.runId,
      time: Date.parse(run.createdAt) || Date.now(),
      kind: "run",
      value: run,
    })),
  ].sort((a, b) => a.time - b.time);
  const partial =
    job &&
    !messages.some((message) => message.id === job.assistantMessageId) &&
    ["queued", "running", "cancelled", "failed"].includes(job.status);
  const newestUser = messages.findLast(
    (message) => message.role === "user",
  )?.id;
  useLayoutEffect(() => {
    if (list.current && (following.current || newestUser !== lastUser.current))
      list.current.scrollTop = list.current.scrollHeight;
    lastUser.current = newestUser;
  }, [messages, detail, job?.partialText, job?.status, newestUser]);
  return (
    <>
      <ol
        className={`agent-chat-messages${!entries.length && !partial ? " is-empty" : ""}`}
        aria-label="聊天消息记录"
        ref={list}
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 100;
        }}
      >
        {entries.map((entry) =>
          entry.kind === "message" ? (
            renderMessage(entry.value)
          ) : (
            <RunMessages
              key={entry.id}
              run={entry.value}
              detail={detail}
              {...runProps}
              onProgress={followProgress}
              onInspect={inspectHistory}
            />
          ),
        )}
        {partial && (
          <li
            className="agent-chat-message agent-chat-assistant"
            aria-label="助手流式回复"
          >
            <strong className="agent-message-author">
              <Bot size={15} />
              助手
            </strong>
            {job.partialText && (
              <StreamingMarkdown
                timeline
                text={job.partialText}
                animate={["queued", "running"].includes(job.status)}
                streamKey={job.id}
                onProgress={followProgress}
              />
            )}
            <AnswerActions text={job.partialText} onQuote={runProps.onQuote} />
            <div className="agent-chat-run-status" role="status">
              {["queued", "running"].includes(job.status) && (
                <LoaderCircle size={13} className="agent-stream-spinner" />
              )}
              {job.status === "cancelled"
                ? "已停止"
                : job.status === "failed"
                  ? "回复中断"
                  : job.partialText
                    ? "正在回复…"
                    : "正在整理回复…"}
              <ElapsedTime
                startedAt={
                  job.createdAt ||
                  messages.find((message) => message.id === job.userMessageId)
                    ?.createdAt
                }
                endedAt={job.updatedAt}
                active={["queued", "running"].includes(job.status)}
              />
            </div>
          </li>
        )}
      </ol>
      {notices && <div className="agent-chat-execution-notices">{notices}</div>}
    </>
  );
}

export default function ProjectConversation({
  execution,
  accountScope,
  binding,
  call,
  loadBinding,
  onExecutionChange,
  ...chat
}) {
  return (
    <BoundBatch
      roomId={accountScope[1]}
      userId={accountScope[0]}
      page={execution.page}
      binding={binding}
      callCloud={call}
      loadBinding={loadBinding}
      embedded
      initialTarget={execution.initialTarget}
      onSelectBatch={execution.onSelectBatch}
      onRunChange={execution.onRunChange}
      onExecutionChange={onExecutionChange}
      renderConversation={(data) => (
        <ConversationMessages
          {...chat}
          {...data}
          call={call}
          binding={binding}
        />
      )}
    />
  );
}
