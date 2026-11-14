import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Monitor, X } from "lucide-react";
import "./desktop-launch.css";
import { requestOnlineLaunch } from "./online-launch.js";

const localEntry = "http://127.0.0.1:8790/app";
const localOrigins = new Set([
  "http://127.0.0.1:8790",
  "http://127.0.0.1:8788",
  "http://127.0.0.1:5178",
]);

async function requestLaunch(origin, accountId, roomId, signal) {
  const crossPort = origin !== "http://127.0.0.1:8790";
  let response;
  try {
    response = await fetch(
      `${crossPort ? "http://127.0.0.1:8790" : ""}/api/local-desktop/launch`,
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

  const launch = async () => {
    if (!accountId || !roomId || busyRef.current) return;
    const origin = window.location.origin;
    const online = window.location.protocol === "https:";
    if (!localOrigins.has(origin) && !online) {
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
    try {
      if (online)
        await requestOnlineLaunch(accountId, roomId, controller.signal);
      else await requestLaunch(origin, accountId, roomId, controller.signal);
      if (current())
        setNotice({
          kind: "success",
          text: "已打开当前画布的轻岛。",
        });
    } catch (error) {
      if (current())
        setNotice({ kind: "error", text: error.message, localLink: !online });
    } finally {
      if (current()) {
        request.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        className="desktop-launch-button"
        aria-label="轻岛"
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
        <span>{busy ? "正在打开…" : "轻岛"}</span>
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
              <p>
                {busy
                  ? "正在打开当前画布…如桌面窗口有未保存内容，请先完成确认。"
                  : notice.text}
              </p>
              {!busy && notice.detail && (
                <p className="desktop-launch-detail">{notice.detail}</p>
              )}
              {!busy && notice.localLink && (
                <a href={localEntry} target="_blank" rel="noopener noreferrer">
                  打开本机入口
                </a>
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
