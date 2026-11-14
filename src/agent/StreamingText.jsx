import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ChatMarkdown from "./ChatMarkdown.jsx";

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
function boundaries(text) {
  if (segmenter)
    return Array.from(
      segmenter.segment(text),
      (part) => part.index + part.segment.length,
    );
  let offset = 0;
  return Array.from(text, (part) => (offset += part.length));
}
function motionDisabled() {
  return (
    document.hidden ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

// Only reveal text already received from the server. Long backlogs catch up
// promptly; history, stopped output and reduced-motion views never replay.
export function useStreamingText(
  text = "",
  { animate = false, streamKey, onProgress } = {},
) {
  const [disabled, setDisabled] = useState(motionDisabled);
  const [shown, setShown] = useState(() => ({
    key: streamKey,
    text: animate && !disabled ? "" : text,
  }));
  const visible = useRef(shown);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setDisabled(motionDisabled());
    media?.addEventListener?.("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      media?.removeEventListener?.("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    let timer,
      active = true;
    const show = (value) => {
      const next = { key: streamKey, text: value };
      visible.current = next;
      setShown((prior) =>
        prior.key === next.key && prior.text === next.text ? prior : next,
      );
    };
    if (!animate || disabled) {
      show(text);
      return;
    }
    const ends = boundaries(text);
    const prior = visible.current;
    const prefix =
      prior.key === streamKey && text.startsWith(prior.text) ? prior.text : "";
    let cursor = ends.findIndex((end) => end > prefix.length);
    if (cursor < 0) cursor = ends.length;
    cursor = Math.max(cursor, ends.length - 160);
    show(cursor ? text.slice(0, ends[cursor - 1]) : "");
    const tick = () => {
      if (!active) return;
      const remaining = ends.length - cursor;
      cursor += remaining > 80 ? Math.ceil(remaining / 24) : 1;
      cursor = Math.min(cursor, ends.length);
      show(cursor ? text.slice(0, ends[cursor - 1]) : "");
      if (cursor < ends.length) timer = window.setTimeout(tick, 16);
    };
    if (cursor < ends.length) timer = window.setTimeout(tick, 16);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [text, animate, disabled, streamKey]);
  const value =
    !animate || disabled
      ? text
      : shown.key === streamKey && text.startsWith(shown.text)
        ? shown.text
        : "";
  useLayoutEffect(() => {
    if (animate) onProgress?.();
  }, [value, animate, onProgress]);
  return value;
}

export default function StreamingMarkdown({
  text = "",
  animate,
  streamKey,
  onProgress,
  timeline = false,
}) {
  const value = useStreamingText(text, { animate, streamKey, onProgress });
  return (
    <div
      className="agent-streaming-markdown"
      data-streaming={value !== text || undefined}
    >
      <ChatMarkdown text={value} timeline={timeline} />
    </div>
  );
}
