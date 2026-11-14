import React, { useEffect, useState } from "react";

export default function SummaryReadProgress({ progress }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const {
    phase,
    totalRecords,
    readRecords,
    cachedRecords,
    pagesRead,
    startedAt,
    updatedAt,
  } = progress;
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const remaining = totalRecords === null ? null : totalRecords - cachedRecords;
  const value = phase === "reading_cache" ? 0 : readRecords + cachedRecords;
  const current = progress.mode === "project";
  return (
    <div className="agent-summary-reading" aria-label="总结生成进度">
      <p role="status" aria-live="polite">
        {current
          ? phase === "summarizing" ? "已提交总结，正在接收完整报告…" : "Codex 正在按需读取项目最新情况…"
          : phase === "collecting"
          ? "正在收集项目历史…"
          : phase === "reading_cache"
            ? "正在读取上次项目进度…"
            : phase === "summarizing"
              ? "历史读取完成，正在整理模块报告…"
              : `已读取 ${readRecords} / ${remaining} 条本次历史`}
      </p>
      {!current && totalRecords !== null && totalRecords > 0 && (
        <progress aria-label="历史读取进度" value={value} max={totalRecords} />
      )}
      <p className="agent-note">
        {current && `已查看 ${progress.filesRead ?? 0} 个文件 · ${progress.historyReads ?? 0} 条最近记录 · `}
        {!current && totalRecords !== null && `共 ${totalRecords} 条历史 · `}
        {cachedRecords > 0 && `复用 ${cachedRecords} 条 · `}
        {!current && pagesRead > 0 && `第 ${pagesRead} 页 · `}
        {progress.model === "gpt-6.1-terra" ? "Terra" : progress.model} ·{" "}
        {progress.effort}
      </p>
      <p className="agent-note">
        已用时 {Math.floor(seconds / 60)} 分{" "}
        {String(seconds % 60).padStart(2, "0")} 秒{" · 最近进度 "}
        <time dateTime={updatedAt}>
          {new Date(updatedAt).toLocaleTimeString("zh-CN")}
        </time>
      </p>
    </div>
  );
}
