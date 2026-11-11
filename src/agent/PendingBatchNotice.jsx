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
}) {
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let active = true,
      checking = false;
    setNotice(null);
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
        const requests =
          result.run?.runId === target.runId &&
          result.run?.bindingId === target.bindingId
            ? currentNativeRequests(result.run).filter(
                (request) => request.responseStatus === "pending",
              )
            : [];
        setNotice(
          requests.length
            ? {
                count: requests.length,
                label: requests[0].kind === "approval" ? "审批" : "回答",
              }
            : null,
        );
      } catch {
        if (active) setNotice(null);
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
  if (!notice) return null;
  return (
    <div
      className={`agent-pending-notice${floating ? " agent-pending-toast" : ""}`}
      role="status"
    >
      <strong>批次正在等待你的{notice.label}</strong>
      <p>有 {notice.count} 个请求需要处理，当前执行会保持等待。</p>
      <button className="primary" onClick={() => onOpen(target)}>
        查看并处理请求
      </button>
    </div>
  );
}
