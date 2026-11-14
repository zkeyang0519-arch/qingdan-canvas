import React, { useLayoutEffect } from "react";
import { LoaderCircle, Minus, RotateCw } from "lucide-react";
import { getDesktopBridge, requestDesktopLayout } from "./bridge.js";
import "./desktop.css";

export default function DesktopFrame({ mode, children }) {
  const bridge = getDesktopBridge();
  useLayoutEffect(() => {
    if (!bridge) return;
    document.documentElement.classList.add("qingdan-desktop");
    document.documentElement.dataset.desktopMode = mode;
    if (mode === "setup") {
      requestDesktopLayout(bridge, { mode: "setup", width: 920, height: 740 });
    } else if (mode === "opening") {
      requestDesktopLayout(bridge, { mode: "island", width: 354, height: 76 });
    }
    return () => {
      document.documentElement.classList.remove("qingdan-desktop");
      delete document.documentElement.dataset.desktopMode;
    };
  }, [bridge, mode]);

  useLayoutEffect(() => {
    if (!bridge || (mode !== "setup" && mode !== "opening")) return;
    return bridge.onBeforeQuit(async () => ({
      unsynced: false,
      hasDraft: false,
      accountId: null,
      roomId: null,
    }));
  }, [bridge, mode]);

  if (!bridge) return children;
  return (
    <div className="desktop-frame" data-mode={mode}>
      {mode === "setup" && (
        <div className="desktop-titlebar">
          <span>轻岛</span>
          <button
            type="button"
            aria-label="隐藏轻岛"
            title="隐藏到托盘"
            onClick={() => bridge.hide()}
          >
            <Minus size={17} />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

export function DesktopOpeningState({ error = "", onRetry }) {
  const bridge = getDesktopBridge();
  return (
    <div className="desktop-opening-capsule" role={error ? "alert" : "status"}>
      {!error && <LoaderCircle size={17} className="spin" aria-hidden="true" />}
      <span title={error || "正在打开当前画布…"}>
        {error || "正在打开当前画布…"}
      </span>
      {error && (
        <button
          type="button"
          aria-label="重试打开轻岛"
          title="重试"
          onClick={onRetry}
        >
          <RotateCw size={15} />
        </button>
      )}
      <button
        type="button"
        aria-label="隐藏轻岛"
        title="隐藏到托盘"
        onClick={() => bridge?.hide()}
      >
        <Minus size={15} />
      </button>
    </div>
  );
}
