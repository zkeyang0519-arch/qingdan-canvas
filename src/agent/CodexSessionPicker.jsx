import React, { useCallback, useEffect, useRef, useState } from "react";
import { Folder, MessageSquare, RefreshCw, Search } from "lucide-react";

export default function CodexSessionPicker({
  roomId,
  userId,
  page,
  requestLocal,
  requestCloud,
  onCreateProject,
  onBound,
  onOpenSettings,
}) {
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const listVersion = useRef(0);
  const choosing = useRef(false);
  const createdPage = useRef(null);

  const load = useCallback(
    async (next = null, term = "") => {
      const version = ++listVersion.current;
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (next) params.set("cursor", next);
      if (term.trim()) params.set("searchTerm", term.trim());
      try {
        const result = await requestLocal(
          `/codex/sessions${params.size ? `?${params}` : ""}`,
          { accountId: userId },
        );
        if (!mounted.current || version !== listVersion.current) return;
        setSessions((prior) => [
          ...new Map(
            [...(next ? prior : []), ...(result.sessions || [])].map((item) => [
              item.threadId,
              item,
            ]),
          ).values(),
        ]);
        setCursor(
          result.nextCursor && result.nextCursor !== next
            ? result.nextCursor
            : null,
        );
      } catch (failure) {
        if (mounted.current && version === listVersion.current)
          setError(failure.message || "读取会话失败，请重试。");
      } finally {
        if (mounted.current && version === listVersion.current)
          setLoading(false);
      }
    },
    [requestLocal, userId],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      listVersion.current++;
    };
  }, [load]);

  function assertCurrent() {
    if (!mounted.current) throw Error("会话选择已关闭。");
  }
  const local = async (route, body) => {
    assertCurrent();
    const result = await requestLocal(route, {
      accountId: userId,
      ...(body === undefined ? {} : { method: "POST", body }),
    });
    assertCurrent();
    return result;
  };
  const cloud = async (route, body) => {
    assertCurrent();
    const result = await requestCloud(route, {
      accountId: userId,
      isCurrentSession: () => mounted.current,
      ...(body === undefined ? {} : { method: "POST", body }),
    });
    assertCurrent();
    return result;
  };
  const readBinding = (sectionId) =>
    cloud(
      `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(sectionId)}`,
    );

  async function choose(session) {
    if (choosing.current) return;
    choosing.current = true;
    listVersion.current++;
    setLoading(false);
    setBusy(true);
    setError("");
    setMessage("正在连接这台电脑…");
    try {
      let sectionId = page?.id || createdPage.current;
      let existing = sectionId ? (await readBinding(sectionId)).binding : null;
      let state = await local("/status");
      if (!state.paired) {
        const pairing = await cloud("/api/agent/devices/pairings", {});
        state = await local("/pair", {
          pairingCode: pairing.pairingCode,
          deviceName: state.deviceName || "我的电脑",
        });
      }
      if (state.connectionStatus === "revoked")
        throw Error("这台电脑的授权已撤销，请在电脑设置中重新连接。");
      if (!state.enabled) state = await local("/connection", { enabled: true });
      else if (["offline", "error"].includes(state.connectionStatus))
        state = await local("/reconnect", {});
      const deadline = Date.now() + 20000;
      while (state.connectionStatus !== "online") {
        if (Date.now() >= deadline || state.connectionStatus === "revoked")
          throw Error("电脑尚未连接成功，请稍后重试或查看电脑设置。");
        state = await local("/status");
        if (state.connectionStatus !== "online")
          await new Promise((resolve) => setTimeout(resolve, 400));
        assertCurrent();
      }
      setMessage("正在读取会话目录并关联项目…");
      const result = await local("/codex/select", {
        threadId: session.threadId,
      });
      if (!sectionId) {
        sectionId = await onCreateProject?.(result.workspace.name);
        assertCurrent();
        if (typeof sectionId !== "string" || !sectionId)
          throw Error("无法创建轻单项目，请重试。");
        createdPage.current = sectionId;
        existing = (await readBinding(sectionId)).binding;
      }
      if (
        existing?.enabled &&
        existing.runnerId === result.runnerId &&
        existing.workspaceId === result.workspace.workspaceId
      ) {
        const latest = (await readBinding(sectionId)).binding;
        if (
          latest?.bindingId !== existing.bindingId ||
          latest?.revision !== existing.revision ||
          !latest?.enabled
        )
          throw Error("项目关联已变化，请重新选择会话。");
      }
      const binding =
        existing?.enabled &&
        existing.runnerId === result.runnerId &&
        existing.workspaceId === result.workspace.workspaceId
          ? existing
          : (
              await cloud("/api/agent/bindings", {
                canvasId: roomId,
                sectionId,
                runnerId: result.runnerId,
                workspaceId: result.workspace.workspaceId,
                expectedRevision: existing?.revision ?? null,
              })
            ).binding;
      assertCurrent();
      setMessage("项目已关联，每次提交会新建执行会话。");
      onBound?.({ ...result, sectionId, binding });
    } catch (failure) {
      if (mounted.current) {
        setMessage("");
        setError(failure.message || "关联失败，请重试。");
      }
    } finally {
      choosing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="agent-session-picker" aria-busy={busy || loading}>
      <p className="agent-session-intro">
        {page ? (
          <>选一个会话，自动把它的项目关联到「{page.title || "当前项目"}」。</>
        ) : (
          "选一个会话，自动创建并关联对应的轻单项目。"
        )}
        <span>自动连接这台电脑，无需填写目录。每次提交都会新建执行会话。</span>
      </p>
      <form
        className="agent-session-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setQuery(search.trim());
          void load(null, search);
        }}
      >
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="搜索 Codex 会话"
          placeholder="搜索会话标题"
          value={search}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button disabled={busy || loading}>搜索</button>
        <button
          type="button"
          aria-label="刷新 Codex 会话"
          title="刷新会话"
          disabled={busy || loading}
          onClick={() => void load(null, query)}
        >
          <RefreshCw size={16} />
        </button>
      </form>
      {error && (
        <div className="agent-session-error">
          <p className="agent-error" role="alert">
            {error}
          </p>
          <button
            disabled={busy || loading}
            onClick={() => void load(null, query)}
          >
            重新读取会话
          </button>
          {onOpenSettings && (
            <button disabled={busy} onClick={onOpenSettings}>
              电脑设置
            </button>
          )}
        </div>
      )}
      {message && (
        <p className="agent-note" role="status">
          {message}
        </p>
      )}
      <div className="agent-session-list" aria-label="本机 Codex 会话">
        {sessions.map((session) => (
          <button
            key={session.threadId}
            className="agent-session-option"
            aria-label={`选择会话：${session.title || "未命名会话"}`}
            disabled={busy || loading || (!page && !onCreateProject)}
            onClick={() => void choose(session)}
          >
            <MessageSquare size={18} aria-hidden="true" />
            <span>
              <strong>{session.title || "未命名会话"}</strong>
              <small>
                <Folder size={13} aria-hidden="true" />
                {session.cwd}
              </small>
            </span>
            {Number.isFinite(session.updatedAt) && (
              <time dateTime={new Date(session.updatedAt * 1000).toISOString()}>
                {new Date(session.updatedAt * 1000).toLocaleDateString("zh-CN")}
              </time>
            )}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="agent-note" role="status">
          正在读取 Codex 会话…
        </p>
      ) : (
        !error &&
        !sessions.length && (
          <p className="agent-note">
            {query
              ? "没有找到匹配的会话，请换个标题搜索。"
              : "这台电脑还没有可选会话。先在 Codex 中打开一个项目并开始会话，再刷新这里。"}
          </p>
        )
      )}
      {cursor && (
        <button
          className="agent-session-more"
          disabled={busy || loading}
          onClick={() => void load(cursor, query)}
        >
          加载更多会话
        </button>
      )}
    </div>
  );
}
