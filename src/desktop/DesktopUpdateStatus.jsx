import React, { useEffect, useState } from "react";

export default function DesktopUpdateStatus({ bridge }) {
  const [update, setUpdate] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(null);
  useEffect(() => {
    if (!bridge?.getUpdateState || !bridge.onUpdateState) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onUpdateState((value) => {
      receivedEvent = true;
      if (active) setUpdate(value);
    });
    Promise.resolve(bridge.getUpdateState())
      .then((value) => {
        if (active && !receivedEvent) setUpdate(value);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge]);
  if (!update || update.status === "unsupported") return null;
  const run = async (action) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };
  const ready = update.status === "downloaded";
  const installing = update.status === "installing";
  const waiting = [
    "checking",
    "available",
    "downloading",
    "installing",
  ].includes(update.status);
  const version = update.version || "";
  const currentVersion = update.currentVersion || version;
  if (ready && dismissedVersion === version && !error && !update.error)
    return (
      <div className="desktop-update-status desktop-update-status-compact">
        <button type="button" onClick={() => setDismissedVersion(null)}>
          有更新
        </button>
      </div>
    );
  const message = ready
    ? `新版${version ? ` ${version}` : ""}已就绪`
    : installing
      ? "正在保存并重启更新…"
      : update.status === "downloading"
        ? `正在下载更新${Number.isFinite(update.progress) ? ` ${Math.round(update.progress)}%` : ""}`
        : update.status === "checking"
          ? "正在检查更新…"
          : update.status === "available"
            ? "发现新版，正在准备下载…"
            : update.status === "error"
              ? "更新暂未完成，可以重试"
              : `轻岛${currentVersion ? ` ${currentVersion}` : ""}`;
  return (
    <div className="desktop-update-status" role="status">
      <span>{message}</span>
      {ready ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => bridge.installUpdate())}
          >
            {busy ? "正在保存…" : "重启更新"}
          </button>
          {dismissedVersion !== version && (
            <button type="button" onClick={() => setDismissedVersion(version)}>
              稍后
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={busy || waiting}
          onClick={() => run(() => bridge.checkForUpdates())}
        >
          {installing ? "更新中…" : "检查更新"}
        </button>
      )}
      {(error || update.error) && <p role="alert">{error || update.error}</p>}
    </div>
  );
}
