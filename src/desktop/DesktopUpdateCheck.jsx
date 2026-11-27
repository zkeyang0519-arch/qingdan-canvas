import React, { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  updateIsBusy,
  updateIsReady,
  updateOperation,
  updateLabel,
  updateMessage,
} from "./update-ui.js";

export default function DesktopUpdateCheck({ bridge }) {
  const [state, setState] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const session = useRef(null);
  useEffect(() => {
    const current = { active: true, revision: 0, action: false };
    session.current = current;
    setState(null);
    setBusy(false);
    setError("");
    const unsubscribe = bridge?.onUpdateState?.((value) => {
      if (current.active) {
        current.revision++;
        setState(value);
        setError("");
      }
    });
    Promise.resolve()
      .then(() => bridge?.getUpdateState?.())
      .then((value) => {
        if (current.active && !current.revision) setState(value || null);
      })
      .catch(() => {
        if (current.active) setError("暂时无法读取更新状态，请重试。");
      });
    return () => {
      current.active = false;
      unsubscribe?.();
    };
  }, [bridge]);
  const locked = updateIsBusy(state);
  const waiting = state?.status === "waiting";
  const ready = updateIsReady(state);
  const manual =
    state?.status === "unsupported" && !!bridge?.openPreviewDownloads;
  const downloading = ["available", "downloading"].includes(state?.status);
  const checking =
    state?.status === "checking" ||
    (busy && session.current?.action === "checkForUpdates");
  const action = manual ? "openPreviewDownloads" : updateOperation(state);
  async function run() {
    const current = session.current;
    if (!current?.active || current.action || !bridge?.[action]) return;
    current.action = action;
    setBusy(true);
    setError("");
    const revision = ++current.revision;
    try {
      const result = await bridge[action]();
      if (current.active && current.revision === revision && result?.status)
        setState(result);
    } catch (cause) {
      if (current.active)
        setError(cause?.message || "更新操作未完成，请重试。");
    } finally {
      current.action = false;
      if (current.active) setBusy(false);
    }
  }
  const label = manual
    ? "下载轻量版"
    : checking && !ready && !locked
      ? "检查中…"
      : updateLabel(state);
  const message =
    error ||
    (manual
      ? "轻量版使用独立安装包更新。"
      : !bridge?.checkForUpdates
        ? "此环境暂不支持自动更新。"
        : updateMessage(state) || (checking ? "正在检查更新…" : ""));
  return (
    <section className="island-update-check" aria-label="轻岛版本更新">
      <div className="island-settings-row">
        <span>
          版本更新
          {state?.currentVersion && (
            <small>
              v{state.currentVersion}
              {state.channel === "beta" ? " · 测试版" : ""}
            </small>
          )}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={
            busy || locked || checking || downloading || !bridge?.[action]
          }
        >
          <RefreshCw
            size={13}
            className={checking || locked ? "spin" : undefined}
          />
          {label}
        </button>
      </div>
      {state?.status === "downloading" && (
        <progress
          aria-label="更新下载进度"
          max="100"
          {...(Number.isFinite(state.progress)
            ? { value: state.progress }
            : {})}
        />
      )}
      {message && (
        <p
          className="island-update-message"
          role={error || state?.error ? "alert" : "status"}
        >
          {message}
        </p>
      )}
      {state?.previousError && !locked && (
        <p className="island-update-message" role="status">
          {state.previousError}
        </p>
      )}
      {waiting && state.tasks?.length > 0 && (
        <ul className="island-update-tasks" aria-label="等待中的任务">
          {state.tasks.map((task) => (
            <li key={task.id}>
              {task.label || "运行任务"}
              {task.checkpointedRemote ? " · 回执已保存" : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
