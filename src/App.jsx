import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Plus,
  Users,
  LayoutDashboard,
  Link2,
  X,
  LoaderCircle,
} from "lucide-react";
import {
  api,
  inviteLink,
  setActiveAccount,
  announceAccountChange,
} from "./api.js";
import CanvasWorkspace from "./CanvasWorkspace.jsx";
import AuthScreen from "./auth/AuthScreen.jsx";
import ProfileSettings from "./auth/ProfileSettings.jsx";
import "./auth/auth.css";

export default function App() {
  const [session, setSession] = useState(null),
    [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(true),
    [dialog, setDialog] = useState(null);
  const [roomName, setRoomName] = useState("新的协作画布");
  const [joinText, setJoinText] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const identity = useRef(null);
  const epoch = useRef(0);
  const [invite, setInvite] = useState("");
  const refresh = async () => {
    const started = epoch.current;
    const result = await api("/api/rooms");
    if (started === epoch.current) setRooms(result.rooms);
  };
  const enter = async (id) => {
    const started = epoch.current;
    const result = await api(`/api/rooms/${id}`);
    if (started !== epoch.current) return;
    setRoom(result.room);
    history.replaceState(null, "", `/?room=${id}`);
  };
  const authenticated = async (result) => {
    const started = ++epoch.current;
    identity.current = result.user.id;
    setActiveAccount(result.user.id);
    setSession(result);
    setError("");
    setBusy(true);
    try {
      const url = new URL(location.href);
      const id = url.searchParams.get("room"),
        token = new URLSearchParams(url.hash.slice(1)).get("invite");
      await refresh();
      if (started !== epoch.current) return;
      if (id && token) {
        await api(`/api/rooms/${encodeURIComponent(id)}/join`, {
          method: "POST",
          body: { invite: token },
        });
        if (started !== epoch.current) return;
        history.replaceState(null, "", `/?room=${encodeURIComponent(id)}`);
      }
      if (id && token) await refresh();
      if (started !== epoch.current) return;
      if (id) await enter(encodeURIComponent(id));
    } catch (err) {
      if (started === epoch.current) setError(err.message);
    } finally {
      if (started === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api("/api/session");
        if (cancelled) return;
        setSession(result);
        if (result.user) await authenticated(result);
      } catch (err) {
        if (!cancelled) setConnectionError(err.message);
      } finally {
        if (!cancelled) {
          setInitializing(false);
          setBusy(false);
        }
      }
    })();
    const expired = () => {
      epoch.current++;
      identity.current = null;
      setActiveAccount(null);
      setRoom(null);
      setRooms([]);
      setSession(null);
      setDialog(null);
      setInvite("");
    };
    const switched = (event) => {
      if (event.key === "qingdan.account-change") {
        expired();
        location.reload();
      }
    };
    const focus = async () => {
      const started = epoch.current;
      try {
        const result = await api("/api/session");
        if (
          !cancelled &&
          started === epoch.current &&
          (result.user?.id || null) !== identity.current
        ) {
          expired();
          location.reload();
        }
      } catch {
        /* An offline tab keeps its own account draft until reconnection. */
      }
    };
    window.addEventListener("storage", switched);
    window.addEventListener("qingdan-session-expired", expired);
    window.addEventListener("focus", focus);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", switched);
      window.removeEventListener("qingdan-session-expired", expired);
      window.removeEventListener("focus", focus);
    };
  }, []);
  const logout = async () => {
    const started = epoch.current;
    await api("/api/auth/logout", { method: "POST", body: {} });
    if (started !== epoch.current) return;
    epoch.current++;
    identity.current = null;
    setActiveAccount(null);
    setRoom(null);
    setRooms([]);
    setSession(null);
    setDialog(null);
    setInvite("");
    setError("");
    history.replaceState(null, "", "/");
    announceAccountChange();
  };
  const act = async (action) => {
    const started = epoch.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      if (started === epoch.current) setError(err.message);
    } finally {
      if (started === epoch.current) setBusy(false);
    }
  };
  const create = async (event) => {
    event.preventDefault();
    const started = epoch.current;
    await act(async () => {
      const result = await api("/api/rooms", {
        method: "POST",
        body: { name: roomName },
      });
      if (started !== epoch.current) return;
      setInvite(inviteLink(result.room.id, result.invite));
      setRoom(result.room);
      setDialog(null);
      history.replaceState(null, "", `/?room=${result.room.id}`);
    });
  };
  const join = async (event) => {
    event.preventDefault();
    const started = epoch.current;
    await act(async () => {
      let url;
      try {
        url = new URL(joinText);
      } catch {
        throw new Error("请粘贴完整的画布邀请链接。");
      }
      if (url.origin !== location.origin)
        throw new Error("此邀请属于另一个站点，请直接在浏览器中打开该链接。");
      const id = url.searchParams.get("room"),
        token = new URLSearchParams(url.hash.slice(1)).get("invite");
      if (!id || !token) throw new Error("链接缺少画布或邀请信息。");
      await api(`/api/rooms/${encodeURIComponent(id)}/join`, {
        method: "POST",
        body: { invite: token },
      });
      if (started !== epoch.current) return;
      await enter(encodeURIComponent(id));
      if (started !== epoch.current) return;
      setDialog(null);
    });
  };
  const renderedEpoch = epoch.current;
  if (initializing)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" />
        <p>正在连接轻单…</p>
      </div>
    );
  if (!session?.user)
    return (
      <AuthScreen
        legacyRoomCount={session?.legacyRoomCount}
        onAuthenticated={authenticated}
        connectionError={connectionError}
        onRetry={() => location.reload()}
      />
    );
  if (room && session.user)
    return (
      <CanvasWorkspace
        key={`${session.user.id}/${room.id}`}
        room={room}
        user={session.user}
        initialInvite={invite}
        onLeave={() => {
          setRoom(null);
          setInvite("");
          history.replaceState(null, "", "/");
          void act(refresh);
        }}
      />
    );
  return (
    <div className="home">
      <header className="home-nav">
        <a className="brand" href="/">
          <span className="brand-mark" />
          <span>轻单</span>
          <small>协作画布</small>
        </a>
        <button
          className="profile-button"
          onClick={() => setDialog("profile")}
          disabled={!session || busy}
        >
          <span className="avatar">
            {(session?.user.name || "访").slice(0, 1)}
          </span>
          {session?.user.name || "连接中"}
        </button>
      </header>
      <main className="home-main">
        <div className="home-heading">
          <div>
            <div className="eyebrow">一起，把想法变成行动</div>
            <h1>
              你的协作空间<span className="heading-dot">.</span>
            </h1>
            <p>一张画布，放下想法、清单和图片。邀请同伴，让事情一起向前。</p>
          </div>
          <div className="home-actions">
            <button
              className="secondary"
              onClick={() => {
                setDialog("join");
                setError("");
              }}
              disabled={!session || busy}
            >
              <Link2 size={16} />
              加入画布
            </button>
            <button
              className="primary"
              onClick={() => {
                setDialog("create");
                setError("");
              }}
              disabled={!session || busy}
            >
              <Plus size={17} />
              新建画布
            </button>
          </div>
        </div>
        {error && (
          <div className="message error" role="alert">
            {error}
            <button onClick={() => location.reload()}>重新连接</button>
          </div>
        )}
        <div className="section-caption">
          <LayoutDashboard size={15} />
          <span>我的画布</span>
          <span className="count">{rooms.length}</span>
        </div>
        {busy && !session ? (
          <div className="empty-state">
            <LoaderCircle className="spin" />
            <p>正在连接协作空间…</p>
          </div>
        ) : (
          <div className="room-grid">
            {rooms.map((item, index) => (
              <button
                className="room-card"
                key={item.id}
                disabled={busy}
                onClick={() => void act(() => enter(item.id))}
              >
                <div className={`room-preview preview-${index % 3}`}>
                  <div className="preview-paper">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="preview-note">
                    一起完成
                    <br />
                    <span>小小的计划，大大的可能。</span>
                  </div>
                  <span className="preview-check">✓</span>
                </div>
                <div className="room-card-body">
                  <h2>{item.name}</h2>
                  <div>
                    <span>
                      <Users size={13} />
                      {item.role === "owner" ? "我创建的" : "我参与的"}
                    </span>
                    <ArrowRight size={17} />
                  </div>
                </div>
              </button>
            ))}
            <button
              className="room-card new-room-card"
              disabled={!session || busy}
              onClick={() => setDialog("create")}
            >
              <span className="new-room-icon">
                <Plus size={26} />
              </span>
              <h2>给想法一个地方</h2>
              <p>创建第一张画布，开始一起记录</p>
            </button>
          </div>
        )}
        <div className="home-footnote">
          <span className="status-dot" />
          编辑实时同步，图片与清单自动保存。进入画布后可邀请同伴。
        </div>
      </main>
      {dialog && (
        <div
          className="dialog-backdrop"
          onClick={(event) =>
            event.target === event.currentTarget && setDialog(null)
          }
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === "create"
                ? "新建画布"
                : dialog === "join"
                  ? "加入画布"
                  : "账号设置"
            }
          >
            <button
              className="dialog-close icon-button"
              aria-label="关闭"
              onClick={() => setDialog(null)}
            >
              <X size={20} />
            </button>
            {dialog === "create" && (
              <form onSubmit={create}>
                <div className="eyebrow">新的开始</div>
                <h2>新建协作画布</h2>
                <p>从一个名字开始，内容慢慢填满。</p>
                <label>
                  画布名称
                  <input
                    autoFocus
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    maxLength={80}
                    required
                  />
                </label>
                <button className="primary wide" disabled={busy}>
                  {busy ? "创建中…" : "创建画布"}
                  <ArrowRight size={16} />
                </button>
              </form>
            )}
            {dialog === "join" && (
              <form onSubmit={join}>
                <h2>加入同伴的画布</h2>
                <p>粘贴收到的邀请链接，即可开始协作。</p>
                <label>
                  邀请链接
                  <textarea
                    autoFocus
                    value={joinText}
                    onChange={(e) => setJoinText(e.target.value)}
                    required
                    placeholder="https://…/?room=…#invite=…"
                  />
                </label>
                <button className="primary wide" disabled={busy}>
                  加入画布
                  <ArrowRight size={16} />
                </button>
              </form>
            )}
            {dialog === "profile" && (
              <ProfileSettings
                key={session.user.id}
                user={session.user}
                onUpdate={(result) => {
                  if (
                    epoch.current === renderedEpoch &&
                    identity.current === result.user.id
                  )
                    setSession(result);
                }}
                onLogout={logout}
              />
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
