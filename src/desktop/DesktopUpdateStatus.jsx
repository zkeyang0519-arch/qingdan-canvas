import React, { useEffect, useRef, useState } from "react";
import {
  updateIsBusy,
  updateIsReady,
  updateOperation,
  updateLabel,
  updateMessage,
} from "./update-ui.js";

export default function DesktopUpdateStatus({ bridge }) {
  const [update, setUpdate] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dismissedVersion, setDismissedVersion] = useState(null);
  const session = useRef(null);
  useEffect(() => {
    const current = { active: true, received: false, busy: false };
    session.current = current;
    setUpdate(null);
    setError("");
    setBusy(false);
    if (!bridge?.getUpdateState || !bridge.onUpdateState)
      return () => {
        current.active = false;
      };
    const unsubscribe = bridge.onUpdateState((value) => {
      current.received = true;
      if (current.active) {
        setUpdate(value);
        setError("");
      }
    });
    Promise.resolve(bridge.getUpdateState())
      .then((value) => {
        if (current.active && !current.received) setUpdate(value);
      })
      .catch((reason) => {
        if (current.active) setError(reason.message);
      });
    return () => {
      current.active = false;
      unsubscribe?.();
    };
  }, [bridge]);
  const ready = updateIsReady(update),
    locked = updateIsBusy(update),
    waiting = update?.status === "waiting";
  if (!update || (!ready && !locked && !waiting && update.status !== "error"))
    return null;
  const version = update.version || "";
  if (
    ready &&
    !waiting &&
    !locked &&
    update.status !== "error" &&
    dismissedVersion === version &&
    !error &&
    !update.error
  )
    return (
      <div className="desktop-update-status desktop-update-status-compact">
        <button type="button" onClick={() => setDismissedVersion(null)}>
          有更新
        </button>
      </div>
    );
  const operation = updateOperation(update);
  async function run() {
    const current = session.current;
    if (!current?.active || current.busy || !bridge?.[operation]) return;
    current.busy = true;
    setBusy(true);
    setError("");
    try {
      await bridge[operation]();
    } catch (reason) {
      if (current.active) setError(reason.message);
    } finally {
      current.busy = false;
      if (current.active) setBusy(false);
    }
  }
  return (
    <div className="desktop-update-status" role="status">
      <span>{updateMessage(update)}</span>
      {!locked && (
        <button
          type="button"
          disabled={busy || !bridge?.[operation]}
          onClick={run}
        >
          {busy ? "正在处理…" : updateLabel(update)}
        </button>
      )}
      {ready && !waiting && !locked && !error && !update.error && (
        <button type="button" onClick={() => setDismissedVersion(version)}>
          稍后
        </button>
      )}
      {waiting && update.tasks?.length > 0 && (
        <small>
          等待 {update.tasks.filter((task) => !task.checkpointedRemote).length}{" "}
          项任务
        </small>
      )}
      {(error || update.error) && <p role="alert">{error || update.error}</p>}
    </div>
  );
}
