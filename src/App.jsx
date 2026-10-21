import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Plus,
  Users,
  LayoutDashboard,
  Link2,
  X,
  LoaderCircle,
} from "lucide-react";
import { api, inviteLink } from "./api.js";
import CanvasWorkspace from "./CanvasWorkspace.jsx";

export default function App() {
  const [session, setSession] = useState(null),
    [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(true),
    [dialog, setDialog] = useState(null);
  const [name, setName] = useState(""),
    [roomName, setRoomName] = useState("新的协作画布");
  const [createKey, setCreateKey] = useState(""),
    [joinText, setJoinText] = useState("");
  const [invite, setInvite] = useState("");
  const refresh = async () => {
    const result = await api("/api/rooms");
    setRooms(result.rooms);
  };
  const enter = async (id) => {
    const result = await api(`/api/rooms/${id}`);
    setRoom(result.room);
    history.replaceState(null, "", `/?room=${id}`);
  };
  useEffect(() => {
    (async () => {
      try {
        const result = await api("/api/session", { method: "POST", body: {} });
        setSession(result);
        setName(result.user.name);
        const url = new URL(location.href);
        const id = url.searchParams.get("room"),
          token = new URLSearchParams(url.hash.slice(1)).get("invite");
        if (id && token) {
          await api(`/api/rooms/${encodeURIComponent(id)}/join`, {
            method: "POST",
            body: { invite: token },
          });
          history.replaceState(null, "", `/?room=${encodeURIComponent(id)}`);
        }
        await refresh();
        if (id) await enter(encodeURIComponent(id));
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    })();
  }, []);
  const act = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const create = async (event) => {
    event.preventDefault();
    await act(async () => {
      const result = await api("/api/rooms", {
        method: "POST",
        body: { name: roomName, createKey },
      });
      setInvite(inviteLink(result.room.id, result.invite));
      setRoom(result.room);
      setDialog(null);
      setCreateKey("");
      history.replaceState(null, "", `/?room=${result.room.id}`);
    });
  };
  const join = async (event) => {
    event.preventDefault();
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
      await enter(encodeURIComponent(id));
      setDialog(null);
    });
  };
  if (room && session)
    return (
      <CanvasWorkspace
        key={room.id}
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
          disabled={!session}
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
                  : "协作昵称"
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
                {session?.createKeyRequired && (
                  <label>
                    创建口令
                    <input
                      type="password"
                      autoComplete="off"
                      value={createKey}
                      onChange={(e) => setCreateKey(e.target.value)}
                      required
                    />
                    <small>由站点管理员提供，仅创建新画布需要。</small>
                  </label>
                )}
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
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const result = await api("/api/session", {
                      method: "POST",
                      body: { name },
                    });
                    setSession(result);
                    setDialog(null);
                  });
                }}
              >
                <h2>协作时怎么称呼你？</h2>
                <p>
                  这是当前浏览器的昵称。清除浏览器 Cookie
                  后，需要重新通过邀请加入。
                </p>
                <label>
                  昵称
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={32}
                    required
                  />
                </label>
                <button className="primary wide" disabled={busy}>
                  保存昵称
                </button>
              </form>
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
