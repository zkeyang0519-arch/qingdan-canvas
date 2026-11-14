import React, { useLayoutEffect } from "react";
import { FileCode2, Terminal } from "lucide-react";
import ChatMarkdown from "./ChatMarkdown.jsx";
import AnswerActions from "./AnswerActions.jsx";

export function executionSegments(events = []) {
  const segments = [],
    byItem = new Map();
  for (const [position, event] of events.entries()) {
    if (event.type !== "output.delta") continue;
    const data = event.payload || {},
      channel = data.channel || "assistant";
    const key = data.itemId
      ? `${event.turnId || ""}:${channel}:${data.itemId}`
      : null;
    let segment = key ? byItem.get(key) : segments.at(-1);
    if (
      !segment ||
      (!key &&
        (segment.key ||
          segment.channel !== channel ||
          segment.turnId !== event.turnId))
    ) {
      segment = {
        key,
        id: event.eventId || String(position),
        turnId: event.turnId,
        channel,
        text: "",
        title: "",
        phase: "delta",
      };
      segments.push(segment);
      if (key) byItem.set(key, segment);
    }
    segment.text += data.text || "";
    if (data.title) segment.title = data.title;
    if (data.phase) segment.phase = data.phase;
    if (data.messagePhase) segment.messagePhase = data.messagePhase;
    segment.updatedAt = position;
  }
  return segments;
}

function executionNodes(segments) {
  const nodes = [];
  for (const segment of segments) {
    if (segment.channel === "assistant") {
      nodes.push({
        id: segment.id,
        turnId: segment.turnId,
        text: segment.text,
        programs: [],
      });
    } else {
      let node = nodes.at(-1);
      if (!node || node.turnId !== segment.turnId) {
        node = {
          id: `program:${segment.id}`,
          turnId: segment.turnId,
          text: "",
          programs: [],
        };
        nodes.push(node);
      }
      node.programs.push(segment);
    }
  }
  return nodes;
}

function terminalText(text = "") {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
function latestLine(text) {
  return (
    terminalText(text)
      .split(/\r\n|[\r\n]/)
      .findLast((line) => line.trim())
      ?.trim() || ""
  );
}
function commandText(title = "") {
  // Codex wraps shell commands in an absolute runtime path. The useful part
  // here is the command being run, never that installation path.
  const command = title.match(/(?:^|\s)-(?:Command|c)\s+([\s\S]+)$/i)?.[1];
  if (command)
    return command.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ");
  return title.replace(/\s+/g, " ");
}
function taskDescription(text) {
  const firstLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.replace(/^[#>*\s-]+/, "")
      .trim() || "";
  return firstLine.match(/^.*?[。！？](?:[”’」』])?/)?.[0] || firstLine;
}

export function executionFinalText(run, events = []) {
  const completion = events.findLast(
    (event) =>
      event.type === "turn.completed" &&
      (!run.turnId || event.turnId === run.turnId),
  );
  const hasFinalOutput =
    Object.hasOwn(run, "output") ||
    Object.hasOwn(completion?.payload || {}, "output");
  const finalText = run.output || completion?.payload?.output;
  if (finalText?.trim()) return finalText;
  if (hasFinalOutput)
    return run.outcome?.summary || completion?.payload?.outcome?.summary || "";
  const segments = executionSegments(events).filter(
    (segment) => !run.turnId || segment.turnId === run.turnId,
  );
  const explicit = segments.findLast(
    (segment) =>
      segment.channel === "assistant" &&
      segment.messagePhase === "final_answer",
  );
  if (explicit?.text.trim()) return explicit.text;
  // Older runners did not transmit message phase. Only accept the final
  // unphased message after tools when the turn also has a successful receipt.
  const last = segments.at(-1);
  if (
    completion?.payload?.outcome?.outcome === "done" &&
    last?.channel === "assistant" &&
    !last.messagePhase &&
    last.text.trim()
  )
    return last.text;
  return run.outcome?.summary || completion?.payload?.outcome?.summary || "";
}

function ProgramLine({ programs }) {
  if (!programs.length) return null;
  const latest = programs.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  const text =
    latestLine(latest.text) ||
    commandText(latest.title) ||
    (latest.channel === "file_change" ? "正在修改文件…" : "正在运行命令…");
  const Icon = latest.channel === "file_change" ? FileCode2 : Terminal;
  return (
    <div className="agent-execution-program-line" aria-label="当前运行代码">
      <Icon size={14} aria-hidden="true" />
      <code className="agent-execution-program-text">{text}</code>
    </div>
  );
}

export default function ExecutionOutput({
  run,
  events = [],
  truncated,
  onProgress,
  onQuote,
  historyLoaded = false,
}) {
  const completed = run.terminal && run.stopConfirmed !== false;
  const finalText = completed ? executionFinalText(run, events) : "";
  const nodes = completed
    ? []
    : executionNodes(
        executionSegments(events).filter(
          (segment) =>
            !run.turnId || !segment.turnId || segment.turnId === run.turnId,
        ),
      );
  useLayoutEffect(() => {
    onProgress?.();
  }, [events, run.output, completed, onProgress]);
  if (completed) {
    return (
      <>
        {finalText ? (
          <div className="agent-execution-result">
            <ChatMarkdown text={finalText} timeline />
            <AnswerActions text={finalText} onQuote={onQuote} />
          </div>
        ) : !run.error && !["cancelled", "failed"].includes(run.status) ? (
          <p className="agent-note" role="status">
            {run.resultReadComplete
              ? "本次执行未保存最终答复。"
              : historyLoaded
                ? "暂未收到本次执行的最终答复。"
                : "正在读取执行结果…"}
          </p>
        ) : null}
        {run.error && (
          <p className="agent-error" role="alert">
            {run.error}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      {truncated && (
        <p className="agent-note">
          较早的输出已超出保存范围，以下为仍可读取的内容。
        </p>
      )}
      <div className="agent-execution-steps">
        {nodes.map((node, index) => (
          <section
            className="agent-execution-step"
            key={node.id}
            data-current={index === nodes.length - 1}
          >
            <p className="agent-execution-task-description">
              {taskDescription(node.text) || "正在处理当前子任务…"}
            </p>
            <ProgramLine programs={node.programs} />
          </section>
        ))}
      </div>
      {!nodes.length && <p className="agent-note">正在等待 Codex 输出…</p>}
      {run.error && (
        <p className="agent-error" role="alert">
          {run.error}
        </p>
      )}
    </>
  );
}
