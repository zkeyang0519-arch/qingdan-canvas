import React, { useEffect, useRef, useState } from "react";

const textLimit = 60000;

export default function SummaryLiveOutput(props) {
  return (
    <SummaryStream
      key={JSON.stringify([props.bindingId, props.runId])}
      {...props}
    />
  );
}

function SummaryStream({ bindingId, runId, call }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [ended, setEnded] = useState(false);
  const cursor = useRef(0),
    output = useRef(""),
    log = useRef(null);
  const follow = useRef(true),
    completedTurns = useRef(new Set());

  useEffect(() => {
    let live = true,
      timer;
    async function read() {
      try {
        // Drain bounded pages without waiting for the polling interval. The
        // server owns sequencing and authorization; text never drives status.
        for (let page = 0; page < 5; page++) {
          const response = await call("/api/agent/execution/tools", {
            method: "POST",
            body: {
              bindingId,
              name: "codex_get_run",
              arguments: { runId, afterSeq: cursor.current },
            },
          });
          if (!live) return;
          const result = response.result;
          if (
            result?.run?.runId !== runId ||
            (result.run.bindingId && result.run.bindingId !== bindingId)
          )
            throw Error("读取输出的项目或运行不匹配，正在重新连接。");
          const next = result.nextAfterSeq;
          if (
            !Number.isSafeInteger(next) ||
            next < cursor.current ||
            (result.hasMore && next === cursor.current)
          )
            throw Error("读取输出暂未推进，正在重新连接。");
          const events = (result.events ?? []).filter(
            (event) =>
              event.runId === runId &&
              event.seq > cursor.current &&
              event.seq <= next,
          );
          for (const event of events)
            if (
              event.type === "turn.completed" ||
              event.type === "run.cancelled"
            )
              completedTurns.current.add(event.turnId);
          const added = events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.payload.text)
            .join("");
          if (added) {
            const combined = output.current + added;
            if (combined.length > textLimit) setTruncated(true);
            output.current = combined.slice(-textLimit);
            setText(output.current);
          }
          if (result.truncated) setTruncated(true);
          cursor.current = next;
          setError("");
          if (!result.hasMore) {
            // Reports and events arrive on independent outboxes. A terminal
            // report alone cannot prove that the final text has reached us.
            if (
              result.run.terminal &&
              (!result.run.turnId ||
                completedTurns.current.has(result.run.turnId))
            ) {
              setEnded(true);
              return;
            }
            break;
          }
        }
      } catch (err) {
        if (!live) return;
        setError(err.message || "输出连接暂时中断");
      }
      if (live) timer = setTimeout(read, 1000);
    }
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bindingId, runId, call]);

  useEffect(() => {
    if (follow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [text]);

  return (
    <section className="agent-summary-stream" aria-label="Codex 实时读取输出">
      <div className="agent-summary-stream-heading">
        <h5>Codex 读取与输出</h5>
        <span>{ended ? "本次输出已结束" : "实时更新"}</span>
      </div>
      {error && (
        <p className="agent-note" role="status">
          {error}；保留已有输出，正在自动重连。
        </p>
      )}
      <pre
        ref={log}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {text ||
          (ended ? "本次没有可显示的读取输出。" : "等待 Codex 开始读取项目…")}
      </pre>
      {truncated && (
        <p className="agent-note">仅显示最近的输出；完整结论以项目总结为准。</p>
      )}
    </section>
  );
}
