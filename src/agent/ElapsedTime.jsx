import React, { useEffect, useState } from "react";

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}小时 ` : ""}${minutes || hours ? `${minutes}分 ` : ""}${seconds % 60}秒`;
}

export default function ElapsedTime({ startedAt, endedAt, active }) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [start, active]);
  if (!Number.isFinite(start) || (!active && !Number.isFinite(end))) return null;
  return (
    <span className="agent-elapsed-time" aria-live="off">
      {active ? "已用时" : "用时"} {formatElapsed((active ? now : end) - start)}
    </span>
  );
}
