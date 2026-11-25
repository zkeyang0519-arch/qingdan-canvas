import React, { useEffect, useState } from "react";

const labels = {
  submitted: "已受理",
  queued: "排队中",
  preparing: "准备中",
  submitting: "提交中",
  running: "生成中",
  persisting: "正在保存原片",
  unknown: "等待平台确认",
  succeeded: "生成完成",
  failed: "生成失败",
  stopped: "已停止",
  cancelled: "已取消",
};
const terminal = (value) =>
  value.playable || ["failed", "stopped", "cancelled"].includes(value.status);

export default function ChatFilmReceipt({ receipt, chatId }) {
  const [live, setLive] = useState(null);
  const value = live || receipt;
  const web = Boolean(
    receipt.target && receipt.node && !receipt.id.startsWith("LOCAL-"),
  );
  useEffect(() => {
    setLive(null);
    if (!web || !chatId || terminal(receipt)) return;
    const abort = new AbortController();
    let timer,
      waiting = false,
      finished = false;
    const poll = async () => {
      clearTimeout(timer);
      if (waiting || finished || abort.signal.aborted || document.hidden)
        return;
      waiting = true;
      try {
        const response = await fetch(
          "/local/waao/tasks/" +
            encodeURIComponent(receipt.id) +
            "?chat=" +
            encodeURIComponent(chatId),
          { signal: abort.signal },
        );
        if (response.ok) {
          const updated = await response.json();
          if (abort.signal.aborted) return;
          setLive(updated);
          finished = terminal(updated);
        }
      } catch {
      } finally {
        waiting = false;
        if (!finished && !abort.signal.aborted) timer = setTimeout(poll, 20000);
      }
    };
    void poll();
    document.addEventListener("visibilitychange", poll);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [web, chatId, receipt.id, receipt.status, receipt.playable]);
  return (
    <>
      <details className="agent-message-submission">
        <summary>
          {web
            ? "WAAO " +
              (labels[value.status] || value.status) +
              " · " +
              receipt.id
            : receipt.label}
        </summary>
        <p>
          {receipt.assetLabel} · {receipt.draftLabel} · {receipt.duration} 秒
        </p>
        <p style={{ whiteSpace: "pre-wrap" }}>{receipt.prompt}</p>
        <small>原图 SHA-256　{receipt.sha256}</small>
      </details>
      {value.playable && (
        <video
          className="agent-chat-film-video"
          aria-label="WAAO 成片"
          controls
          preload="none"
          src={"/api/agent/chat/video/" + encodeURIComponent(receipt.id)}
        />
      )}
    </>
  );
}
