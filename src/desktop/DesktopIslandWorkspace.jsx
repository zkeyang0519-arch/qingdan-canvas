import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowLeft, ExternalLink, LoaderCircle } from "lucide-react";
import DynamicIsland from "../island/DynamicIsland.jsx";
import { useRoomWorkspace } from "../sync/useRoomWorkspace.js";
import { downloadBlob, exportArchive } from "../canvas/backup.js";
import { getDesktopBridge, requestDesktopLayout } from "./bridge.js";
import { DesktopOpeningState } from "./DesktopFrame.jsx";
import { useDesktopPlacement } from "./useDesktopPlacement.js";
import "./jade-island.css";

export default function DesktopIslandWorkspace(props) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ConnectedWorkspace
      key={`${props.user.id}/${props.room.id}/${attempt}`}
      {...props}
      onRetryStartup={() => setAttempt((current) => current + 1)}
    />
  );
}

function ConnectedWorkspace({
  room,
  user,
  onLeave,
  onRetryStartup,
  compactOpening = false,
}) {
  const bridge = getDesktopBridge();
  const desktop = useDesktopPlacement(bridge);
  const workspace = useRoomWorkspace(room, user, {
    draftIdentity: "desktop-v1",
  });
  const root = useRef(null);
  const latest = useRef(workspace);
  latest.current = workspace;
  const drafts = useRef({});
  const [actionError, setActionError] = useState("");
  const [acceptedContext, setAcceptedContext] = useState(null);
  const [contextError, setContextError] = useState("");
  const identity = useRef(null);
  identity.current = `${user.id}/${room.id}`;
  const opening =
    compactOpening &&
    (!workspace.state ||
      !workspace.startupReady ||
      acceptedContext?.accountId !== user.id ||
      acceptedContext?.roomId !== room.id);
  const draftsChanged = useCallback((value) => {
    drafts.current = value;
  }, []);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onBeforeQuit(async () => {
      await latest.current.flushLocal();
      return {
        unsynced: !!latest.current.dirty,
        hasDraft: Object.values(drafts.current).some((text) => text.trim()),
        accountId: user.id,
        roomId: room.id,
      };
    });
  }, [bridge, user.id, room.id]);

  useEffect(() => {
    if (!workspace.state || !workspace.startupReady) return;
    if (!bridge?.setContext) {
      if (compactOpening)
        setContextError("桌面组件尚未就绪，请重新启动悬浮窗后重试。");
      return;
    }
    let mounted = true;
    const scope = identity.current;
    const current = () => mounted && identity.current === scope;
    setContextError("");
    (async () => {
      try {
        const context = { accountId: user.id, roomId: room.id };
        if ((await bridge.setContext(context)) !== true)
          throw Error("桌面窗口未确认当前画布，请重试。");
        if (current()) setAcceptedContext(context);
      } catch (error) {
        if (current()) setContextError(`桌面连接未确认：${error.message}`);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [
    bridge,
    !!workspace.state,
    workspace.startupReady,
    user.id,
    room.id,
    compactOpening,
  ]);

  useLayoutEffect(() => {
    if (!bridge) return;
    const island = root.current?.querySelector(".dynamic-island");
    const opening = root.current?.querySelector(".desktop-opening-capsule");
    const target =
      island || opening || root.current?.querySelector(".desktop-loading-card");
    if (!target) return;
    let frame;
    let previous = "";
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = target.getBoundingClientRect();
        const width =
          Math.ceil(bounds.width || (island || opening ? 330 : 420)) + 24;
        const height =
          Math.ceil(bounds.height || (island || opening ? 52 : 176)) + 24;
        const dock = desktop.dragging ? "free" : desktop.dock;
        const expanded = island?.dataset.open === "true";
        const size = `${width}/${height}/${dock}/${expanded}`;
        if (size === previous) return;
        previous = size;
        requestDesktopLayout(bridge, {
          mode: "island",
          width,
          height,
          ...(island ? { dock, expanded } : {}),
          ...(island?.dataset.appearance === "jade"
            ? { appearance: "jade" }
            : {}),
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [bridge, !!workspace.state, opening, desktop.dock, desktop.dragging]);

  const leave = async () => {
    try {
      if (
        Object.values(drafts.current).some((text) => text.trim()) &&
        !window.confirm(
          "还有未提交的输入。返回画布列表会丢弃这些输入，继续吗？",
        )
      )
        return;
      await workspace.flushLocal();
      onLeave();
    } catch (error) {
      setActionError(`本地保存未完成：${error.message}`);
    }
  };
  const backup = async () => {
    try {
      const bytes = await exportArchive(
        workspace.current.current,
        workspace.assets,
      );
      downloadBlob(
        new Blob([bytes], { type: "application/zip" }),
        `${room.name || "轻单"}.qingdan`,
      );
      setActionError("");
    } catch (error) {
      setActionError(error.message);
    }
  };
  const openWorkspace = async () => {
    try {
      await bridge.openWorkspace(room.id);
    } catch (error) {
      setActionError(error.message);
    }
  };
  const recovery = (
    <>
      {workspace.conflict && (
        <div className="desktop-recovery" role="alert">
          <p>{workspace.conflict}</p>
          <button type="button" onClick={backup}>
            先导出草稿
          </button>
          <button type="button" onClick={() => workspace.resolve("local")}>
            保留我的冲突内容
          </button>
          <button type="button" onClick={() => workspace.resolve("remote")}>
            使用共享冲突内容
          </button>
        </div>
      )}
      {workspace.error && !workspace.conflict && (
        <div className="desktop-recovery" role="alert">
          <p>{workspace.error}</p>
          <button
            type="button"
            onClick={workspace.state ? workspace.retry : onRetryStartup}
          >
            重试
          </button>
          {workspace.state && (
            <button type="button" onClick={backup}>
              导出备份
            </button>
          )}
        </div>
      )}
      {actionError && (
        <p className="desktop-action-error" role="alert">
          {actionError}
        </p>
      )}
    </>
  );
  return (
    <main className="desktop-island-workspace" ref={root}>
      {opening ? (
        <DesktopOpeningState
          error={contextError || workspace.error || actionError}
          onRetry={onRetryStartup}
        />
      ) : !workspace.state ? (
        <div className="desktop-loading-card">
          <div className="desktop-loading-title">轻岛 · {room.name}</div>
          {!workspace.error && (
            <p>
              <LoaderCircle className="spin" size={17} /> 正在打开待办…
            </p>
          )}
          {recovery}
          <div className="desktop-loading-actions">
            <button type="button" onClick={leave}>
              返回画布列表
            </button>
            <button type="button" onClick={() => bridge.hide()}>
              隐藏到托盘
            </button>
          </div>
        </div>
      ) : (
        <DynamicIsland
          workspace={workspace}
          boardId={room.id}
          top={12}
          beforeAction={() => workspace.end()}
          closeOnWindowBlur
          onDraftsChange={draftsChanged}
          dragHandleTitle="拖动轻岛"
          desktop={desktop}
          closeLabel="隐藏轻岛"
          closeText="隐藏到托盘"
          onDisable={() => bridge.hide()}
          panelNotice={recovery}
          panelToolbar={
            <>
              <div className="desktop-island-toolbar">
                <button
                  type="button"
                  aria-label="返回画布列表"
                  title="切换画布 / 账号"
                  onClick={leave}
                >
                  <ArrowLeft size={15} />
                </button>
                <button
                  type="button"
                  aria-label="在浏览器打开画布"
                  title="在浏览器打开完整画布"
                  onClick={openWorkspace}
                >
                  <ExternalLink size={15} />
                </button>
              </div>
            </>
          }
        />
      )}
    </main>
  );
}
