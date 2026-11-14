import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Quote } from "lucide-react";

export function appendQuotedReply(draft, text) {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const next = `${draft}${draft ? "\n\n" : ""}${quote}\n\n`;
  return next.length <= 12000 ? next : null;
}

export default function AnswerActions({ text, onQuote, disabled = false }) {
  const [status, setStatus] = useState("");
  const controls = useRef(null);
  useEffect(() => setStatus(""), [text]);
  if (!text?.trim()) return null;
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setStatus("已复制");
    } catch {
      setStatus("复制失败，请选择正文复制。");
    }
  }
  function quote() {
    const selection = window.getSelection?.();
    const message = controls.current?.closest(".agent-chat-assistant");
    const selected = selection?.toString().trim();
    onQuote(
      selected &&
        message?.contains(selection.anchorNode) &&
        message.contains(selection.focusNode)
        ? selected
        : text,
    );
  }
  return (
    <div className="agent-answer-actions" ref={controls}>
      <button type="button" onClick={copy} aria-label="复制回答" title={status === "已复制" ? "已复制" : "复制回答"}>
        {status === "已复制" ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onQuote && (
        <button
          type="button"
          onClick={quote}
          disabled={disabled}
          aria-label="引用回答"
          title="引用回答"
        >
          <Quote size={14} />
        </button>
      )}
      <span role="status" className={status === "已复制" ? "agent-visually-hidden" : undefined}>{status}</span>
    </div>
  );
}
