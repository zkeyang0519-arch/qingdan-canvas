import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { currentNativeRequests } from "./PermissionControls.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import "./experience.css";

function validTarget(value) {
  return (
    value === null ||
    !!(
      value &&
      ["runId", "bindingId", "sectionId"].every(
        (field) =>
          typeof value[field] === "string" &&
          value[field].length > 0 &&
          value[field].length <= 256,
      ) &&
      Number.isSafeInteger(value.bindingRevision) &&
      value.bindingRevision > 0
    )
  );
}
export function useObservedBatchTarget(userId, roomId) {
  const key = `qingdan.observed-batch:${JSON.stringify([userId, roomId])}`;
  return useWorkspaceDraft(key, null, true, {
    storageKey: key,
    validate: validTarget,
  });
}

export default function PendingBatchNotice({
  roomId,
  userId,
  target,
  onOpen,
  requestCloud = api,
  floating = false,
  projectName,
  monitorKey,
  onCount,
}) {
  const [notice, setNotice] = useState(null);
  const [readState, setReadState] = useState("loading");
  const targetKey = monitorKey || JSON.stringify(target);
  useEffect(() => {
    onCount?.(targetKey, notice?.count || 0, readState);
  }, [targetKey, notice?.count, readState, onCount]);
  useEffect(() => () => onCount?.(targetKey, 0, null), [targetKey, onCount]);
  useEffect(() => {
    let active = true,
      checking = false;
    setNotice(null);
    setReadState("loading");
    if (!target?.runId) return;
    const read = async () => {
      if (checking) return;
      checking = true;
      try {
        const options = { accountId: userId, isCurrentSession: () => active };
        const { binding } = await requestCloud(
          `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(target.sectionId)}`,
          options,
        );
        if (!active) return;
        if (
          !binding?.enabled ||
          binding.bindingId !== target.bindingId ||
          binding.revision !== target.bindingRevision
        ) {
          setNotice(null);
          setReadState("ready");
          return;
        }
        const { result } = await requestCloud("/api/agent/execution/tools", {
          ...options,
          method: "POST",
          body: {
            bindingId: target.bindingId,
            name: "codex_get_run",
            arguments: { runId: target.runId },
          },
        });
        if (!active) return;
        setReadState("ready");
        const run = result.run;
        if (
          !run ||
          run.runId !== target.runId ||
          run.bindingId !== target.bindingId ||
          ["cancel_requested", "cancelled"].includes(run.queue?.phase) ||
          ["cancel_requested", "cancelled"].includes(run.status)
        ) {
          setNotice(null);
          return;
        }
        const requests = currentNativeRequests(run).filter(
          (request) => request.responseStatus === "pending",
        );
        if (requests.length) {
          setNotice({
            count: requests.length,
            label: requests[0].kind === "approval" ? "审批" : "回答",
          });
        } else {
          const waiting = {
            waiting_human: "确认验收",
            blocked: "补充说明",
            paused: "核对恢复",
          };
          const label =
            !["completed", "cancelled"].includes(run.queue?.phase) &&
            waiting[run.queue?.phase];
          setNotice(label ? { count: 1, label } : null);
        }
      } catch {
        if (active) {
          setNotice(null);
          setReadState("error");
        }
      } finally {
        checking = false;
      }
    };
    void read();
    const timer = window.setInterval(read, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    roomId,
    userId,
    target?.bindingId,
    target?.bindingRevision,
    target?.sectionId,
    target?.runId,
    requestCloud,
  ]);
  if (!notice)
    return onCount && readState === "error" ? (
      <p className="agent-note" role="status">
        {projectName} · 暂时无法读取请求，正在重试。
      </p>
    ) : null;
  return (
    <div
      className={`agent-pending-notice${floating ? " agent-pending-toast" : ""}`}
      role="status"
    >
      {projectName && <small>{projectName}</small>}
      <strong>批次正在等待你的{notice.label}</strong>
      <p>有 {notice.count} 个请求需要处理，当前执行会保持等待。</p>
      <button className="primary" onClick={() => onOpen(target)}>
        查看并处理请求
      </button>
    </div>
  );
}
