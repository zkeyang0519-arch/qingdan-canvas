import React, { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

// Both actions use the native updater. Installation still waits for the shared
// save-before-quit path; the renderer never supplies a feed or installer path.
export default function DesktopUpdateCheck({ bridge }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const session = useRef(null);
  useEffect(() => {
    const current = { active: true, revision: 0, action: "" };
    session.current = current;
    setState(null);
    setError("");
    setBusy("");
    const unsubscribe = bridge?.onUpdateState?.((value) => {
      if (!current.active) return;
      current.revision++;
      setState(value);
      setError("");
    });
    Promise.resolve()
      .then(() => bridge?.getUpdateState?.())
      .then((value) => {
        if (current.active && current.revision === 0) setState(value || null);
      })
      .catch(() => {
        if (current.active && current.revision === 0)
          setError("暂时无法读取更新状态，请重试。");
      });
    return () => {
      current.active = false;
      unsubscribe?.();
    };
  }, [bridge]);

  const run = async (action) => {
    const current = session.current;
    const method = action === "install" ? "installUpdate" : "checkForUpdates";
    if (!current?.active || current.action || !bridge?.[method]) return;
    current.action = action;
    const revision = ++current.revision;
    setBusy(action);
    setError("");
    try {
      const value = await bridge[method]();
      if (
        action === "check" &&
        current.active &&
        current.revision === revision &&
        value
      )
        setState(value);
    } catch (cause) {
      if (current.active && current.revision === revision)
        setError(
          cause?.message ||
            (action === "install"
              ? "安装更新失败，请稍后重试。"
              : "检查更新失败，请稍后重试。"),
        );
    } finally {
      current.action = "";
      if (current.active) setBusy("");
    }
  };
  const checking = busy === "check" || state?.status === "checking";
  const installing = busy === "install" || state?.status === "installing";
  const ready = state?.status === "downloaded";
  const unavailable =
    !bridge?.checkForUpdates || state?.status === "unsupported";
  const locked = ["available", "downloading"].includes(state?.status);
  const message =
    error ||
    state?.error ||
    (unavailable
      ? "此环境暂不支持自动更新"
      : installing
        ? "正在保存并重启更新…"
        : checking
          ? "正在检查更新…"
          : state?.status === "downloading"
            ? `正在下载 ${Math.max(0, Math.min(100, Math.round(state.progress || 0)))}%`
            : state?.status === "available"
              ? `发现新版 ${state.version || ""}`
              : state?.status === "downloaded"
                ? `新版 ${state.version || ""} 已就绪`
                : state?.message ||
                  (state?.status === "error"
                    ? "检查更新失败，请稍后重试。"
                    : ""));
  return (
    <section className="island-update-check" aria-label="轻岛版本更新">
      <div className="island-settings-row">
        <span>
          版本更新
          {state?.currentVersion && <small>v{state.currentVersion}</small>}
        </span>
        <button
          type="button"
          onClick={() => run(ready ? "install" : "check")}
          disabled={
            !!busy ||
            checking ||
            installing ||
            (ready ? !bridge?.installUpdate : unavailable || locked)
          }
        >
          <RefreshCw
            size={13}
            className={checking || installing ? "spin" : undefined}
          />
          {installing
            ? "正在保存…"
            : ready
              ? "重启更新"
              : checking
                ? "检查中…"
                : "检查更新"}
        </button>
      </div>
      {message && (
        <p
          className="island-update-message"
          role={
            error || state?.error || state?.status === "error"
              ? "alert"
              : "status"
          }
        >
          {message}
        </p>
      )}
    </section>
  );
}
