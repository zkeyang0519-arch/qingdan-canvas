import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Monitor, X } from "lucide-react";
import "./desktop-launch.css";
import { watchDesktopDownloadSelection } from "./download-selection.js";
import {
  requestOnlineLaunch,
  wakeInstalledDesktop,
  probeInstalledDesktop,
  desktopDownloadPage,
  desktopPreviewSelected,
  selectDesktopChannel,
} from "./online-launch.js";

const localEntry = "http://127.0.0.1:8790/app";
const localOrigins = new Set([
  "http://127.0.0.1:8790",
  "http://127.0.0.1:8788",
  "http://127.0.0.1:5178",
  "http://localhost:8794",
  "http://localhost:8793",
]);

async function requestLaunch(origin, accountId, roomId, signal) {
  const targetOrigin = origin.startsWith("http://localhost:879")
    ? "http://localhost:8794"
    : "http://127.0.0.1:8790";
  const crossPort = origin !== targetOrigin;
  let response;
  try {
    response = await fetch(
      `${crossPort ? targetOrigin : ""}/api/local-desktop/launch`,
      {
        method: "POST",
        credentials: crossPort ? "include" : "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Qingdan-Local": "1",
          "X-QD-Account": accountId,
        },
        body: JSON.stringify({ roomId }),
        signal,
      },
    );
  } catch (cause) {
    throw Error(
      "无法连接本机轻单服务。请确认本机服务已启动，再从本机入口重试。",
      { cause },
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error("本机服务返回了无法识别的响应。请打开本机入口检查服务状态。");
  }
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "请先在本机入口登录当前账号，再重试。"
        : response.status === 404
          ? "本机服务尚未提供桌面启动入口。请重启本机轻单服务后重试。"
          : `本机桌面启动请求失败（${response.status}）。`;
    throw Error(
      response.status !== 404 &&
        typeof result?.error === "string" &&
        result.error.trim()
        ? result.error
        : fallback,
    );
  }
  if (result?.started !== true || result?.applied !== true)
    throw Error("本机服务未确认启动轻岛，请从本机入口检查后重试。");
}

export default function DesktopLaunchButton({ user, room }) {
  const preview = desktopPreviewSelected();
  const accountId = user?.id;
  const roomId = room?.id;
  const context = useRef({ accountId, roomId });
  context.current = { accountId, roomId };
  const version = useRef(0);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const request = useRef(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [progress, setProgress] = useState("");
  const [downloadRequestId] = useState(() => crypto.randomUUID());
  const selectInstaller = (channel) => {
    request.current?.abort();
    version.current++;
    busyRef.current = false;
    setBusy(false);
    selectDesktopChannel(channel);
    setNotice({
      kind: "info",
      needsInstall: true,
      waitingInstall: true,
      text:
        channel === "tauri-preview"
          ? "已选择轻量验证版。安装完成并打开轻岛验证版后，这里会自动继续。"
          : "已选择原版。安装完成并打开轻岛后，这里会自动继续。",
    });
  };
  useEffect(
    () => watchDesktopDownloadSelection(downloadRequestId, selectInstaller),
    [downloadRequestId],
  );

  useEffect(() => {
    mounted.current = true;
    version.current++;
    busyRef.current = false;
    setBusy(false);
    setNotice(null);
    return () => {
      mounted.current = false;
      version.current++;
      request.current?.abort();
      request.current = null;
      busyRef.current = false;
    };
  }, [accountId, roomId]);

  const launch = async ({ wake = true } = {}) => {
    if (!accountId || !roomId || busyRef.current) return;
    const origin = window.location.origin;
    const online = window.location.protocol === "https:";
    if ((online || preview) && wake) wakeInstalledDesktop();
    if (!localOrigins.has(origin) && !online && !preview) {
      setNotice({
        kind: "info",
        text: "轻岛需要从这台电脑的本机入口启动。请打开本机入口，并登录同一账号。",
        localLink: true,
      });
      return;
    }
    const started = version.current;
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      mounted.current &&
      version.current === started &&
      context.current.accountId === accountId &&
      context.current.roomId === roomId;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setProgress("正在检查轻岛安装和版本…");
    try {
      let result;
      if (online || preview)
        result = await requestOnlineLaunch(
          accountId,
          roomId,
          controller.signal,
          (message) => {
            if (current()) setProgress(message);
          },
        );
      else await requestLaunch(origin, accountId, roomId, controller.signal);
      if (current())
        setNotice({
          kind: "success",
          text: "已打开当前画布的轻岛。",
          detail: result?.warning,
        });
    } catch (error) {
      if (current())
        setNotice({
          kind: "error",
          text: error.message,
          localLink: !online && !preview,
          needsInstall: error.needsInstall === true,
        });
    } finally {
      if (current()) {
        request.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!notice?.waitingInstall) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        await probeInstalledDesktop(controller.signal);
        if (!controller.signal.aborted) {
          clearInterval(timer);
          void launch({ wake: false });
        }
      } catch {
        /* Keep waiting while the user runs the first installer. */
      } finally {
        checking = false;
      }
    }, 2000);
    const deadline = setTimeout(
      () => {
        clearInterval(timer);
        controller.abort();
      },
      10 * 60 * 1000,
    );
    return () => {
      clearInterval(timer);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [notice?.waitingInstall, accountId, roomId, preview]);

  return (
    <>
      <button
        type="button"
        className="desktop-launch-button"
        aria-label={preview ? "轻岛测试版" : "轻岛"}
        aria-busy={busy}
        disabled={busy || !accountId || !roomId}
        title="在其他软件上方显示并操作待办"
        onClick={launch}
      >
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Monitor size={15} />
        )}
        <span>{busy ? "正在打开…" : preview ? "轻岛测试版" : "轻岛"}</span>
      </button>
      {(busy || notice) &&
        createPortal(
          <div
            className="desktop-launch-notice"
            data-kind={busy ? "info" : notice.kind}
            role="status"
            aria-label="轻岛启动状态"
          >
            <div>
              <p>{busy ? progress : notice.text}</p>
              {!busy && notice.detail && (
                <p className="desktop-launch-detail">{notice.detail}</p>
              )}
              {!busy && notice.localLink && (
                <a href={localEntry} target="_blank" rel="noopener noreferrer">
                  打开本机入口
                </a>
              )}
              {!busy && notice.needsInstall && (
                <div className="desktop-install-actions">
                  <a
                    href={`${desktopDownloadPage}?request=${downloadRequestId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() =>
                      setNotice({
                        kind: "info",
                        needsInstall: true,
                        text: "请在下载页选择轻量版或原版。安装完成并打开轻岛后，回到这里继续。",
                      })
                    }
                  >
                    下载轻岛（轻量版 / 原版）
                  </a>
                  <button type="button" onClick={() => void launch()}>
                    已安装，打开轻岛
                  </button>
                </div>
              )}
            </div>
            {!busy && (
              <button
                type="button"
                aria-label="关闭轻岛启动提示"
                onClick={() => setNotice(null)}
              >
                <X size={15} />
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
