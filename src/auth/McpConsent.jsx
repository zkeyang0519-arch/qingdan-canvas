import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import McpClientIdentity from "./McpClientIdentity.jsx";

export default function McpConsent(props) {
  return (
    <ConsentPanel
      key={`${props.user.id}/${props.sessionEpoch}/${props.handle}`}
      {...props}
    />
  );
}

function ConsentPanel({ handle, user, isCurrentSession, onFinish }) {
  const [data, setData] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [write, setWrite] = useState(false);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(false),
    submitting = useRef(false);
  const session = useRef(isCurrentSession);
  session.current = isCurrentSession;
  const current = () => alive.current && session.current();
  useEffect(() => {
    alive.current = true;
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    setRooms([]);
    void (async () => {
      try {
        if (!handle)
          throw new Error("授权链接缺少请求标识，请从客户端重新发起连接。");
        const result = await api(
          `/api/mcp/consent/${encodeURIComponent(handle)}`,
          { accountId: user.id, isCurrentSession: current },
        );
        if (!active || !current()) return;
        if (result.account.id !== user.id)
          throw new Error("授权账号已改变，请从客户端重新发起连接。");
        setData(result);
        setWrite(result.requested_scopes.includes("qingdan:write"));
        setOffline(result.requested_scopes.includes("offline_access"));
      } catch (err) {
        if (active && current()) {
          setError(err.message);
          setRestart(err.status === 403 || !handle);
        }
      } finally {
        if (active && current()) setLoading(false);
      }
    })();
    return () => {
      active = false;
      alive.current = false;
    };
  }, [handle, user.id, retry]);

  async function decide(decision) {
    if (
      !data ||
      !current() ||
      submitting.current ||
      restart ||
      (decision === "approve" && !rooms.length)
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/api/mcp/consent/${encodeURIComponent(handle)}`,
        {
          method: "POST",
          accountId: user.id,
          isCurrentSession: current,
          body: {
            decision,
            scopes:
              decision === "deny"
                ? []
                : [
                    "qingdan:read",
                    ...(write ? ["qingdan:write"] : []),
                    ...(offline ? ["offline_access"] : []),
                  ],
            canvas_ids: decision === "deny" ? [] : rooms,
            csrf: data.csrf,
          },
        },
      );
      if (!current()) return;
      if (typeof result.redirect_to !== "string" || !result.redirect_to)
        throw new Error("授权响应缺少返回地址，请从客户端重新发起连接。");
      // This destination comes exclusively from the authenticated server response.
      onFinish(result.redirect_to);
    } catch (err) {
      if (current()) {
        setError(err.message);
        setRestart(err.status === 403);
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className="home auth-page mcp-consent-page">
      <header className="home-nav">
        <a className="brand" href="/">
          <span className="brand-mark" />
          <span>轻单</span>
          <small>Agent 连接</small>
        </a>
      </header>
      <main className="mcp-consent-main">
        <section
          className="dialog auth-card mcp-consent-card"
          aria-labelledby="mcp-consent-title"
          aria-busy={loading || busy}
        >
          <div className="eyebrow">由你决定访问范围</div>
          <h1 id="mcp-consent-title">授权 Agent</h1>
          {loading && <p role="status">正在读取授权请求…</p>}
          {data && (
            <>
              <p>
                当前账号：<strong>{data.account.name}</strong>（
                {data.account.username}）
              </p>
              <McpClientIdentity client={data.client} />
              <dl className="mcp-facts">
                <div>
                  <dt>MCP 地址</dt>
                  <dd>{data.resource}</dd>
                </div>
                <div>
                  <dt>请求有效至</dt>
                  <dd>{new Date(data.expires_at).toLocaleString("zh-CN")}</dd>
                </div>
              </dl>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void decide("approve");
                }}
              >
                <fieldset disabled={busy || restart} className="mcp-options">
                  <legend>访问权限</legend>
                  <p className="mcp-help" aria-label="客户端请求的权限">
                    客户端请求：
                    {data.requested_scopes.includes("qingdan:write")
                      ? "读写"
                      : "只读"}
                    {data.requested_scopes.includes("offline_access")
                      ? "、持续连接"
                      : ""}
                    。你可以调整本次授权。
                  </p>
                  <label className="mcp-choice">
                    <input
                      type="radio"
                      name="mcp-scope"
                      checked={!write}
                      onChange={() => setWrite(false)}
                    />
                    只读：查看和搜索内容
                  </label>
                  <label className="mcp-choice">
                    <input
                      type="radio"
                      name="mcp-scope"
                      checked={write}
                      onChange={() => setWrite(true)}
                    />
                    读写：查看、创建、修改和删除内容
                  </label>
                  <p className="mcp-help">
                    任务与便签文字段落共用写入权限。读写允许修改、删除两者的内容。
                  </p>
                  {data.supported_scopes.includes("offline_access") && (
                    <label className="mcp-choice">
                      <input
                        type="checkbox"
                        checked={offline}
                        onChange={(event) => setOffline(event.target.checked)}
                      />
                      允许持续连接（到期前可刷新访问令牌）
                    </label>
                  )}
                </fieldset>
                <fieldset disabled={busy || restart} className="mcp-options">
                  <legend>选择可访问的画布</legend>
                  <p className="mcp-help">
                    仅授权你本次勾选且仍有编辑权限的画布，未来新建或加入的画布需要重新授权。
                  </p>
                  {data.canvases.length ? (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          setRooms(
                            rooms.length === data.canvases.length
                              ? []
                              : data.canvases.map((item) => item.canvas_id),
                          )
                        }
                      >
                        {rooms.length === data.canvases.length
                          ? "取消全选"
                          : "全选当前画布"}
                      </button>
                      <div className="mcp-room-options">
                        {data.canvases.map((item) => (
                          <label className="mcp-choice" key={item.canvas_id}>
                            <input
                              type="checkbox"
                              checked={rooms.includes(item.canvas_id)}
                              onChange={(event) =>
                                setRooms((ids) =>
                                  event.target.checked
                                    ? [...ids, item.canvas_id]
                                    : ids.filter((id) => id !== item.canvas_id),
                                )
                              }
                            />
                            {item.name}
                            <small>
                              {item.role === "owner" ? "我创建的" : "我参与的"}
                            </small>
                          </label>
                        ))}
                      </div>
                      <p className="mcp-help" role="status">
                        已选择 {rooms.length} 张画布
                      </p>
                    </>
                  ) : (
                    <p className="mcp-warning">
                      没有可授权的画布。请先返回轻单创建或加入画布，再从客户端重新连接。你仍可拒绝本次请求。
                    </p>
                  )}
                </fieldset>
                <p className="mcp-help">
                  重新授权将替换此账号对同一客户端的旧授权；使用相同客户端 ID
                  的其他设备也会受影响。
                </p>
                <div className="mcp-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || restart}
                    onClick={() => void decide("deny")}
                  >
                    拒绝
                  </button>
                  <button
                    className="primary"
                    disabled={busy || restart || !rooms.length}
                  >
                    {busy ? "正在提交…" : "允许访问"}
                  </button>
                </div>
              </form>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {restart && (
            <p className="mcp-warning">
              请求已失效或会话已改变，请从客户端重新发起授权。
            </p>
          )}
          {!loading && !data && !restart && (
            <button
              className="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试读取授权
            </button>
          )}
          <a className="mcp-back" href="/">
            返回轻单
          </a>
        </section>
      </main>
    </div>
  );
}
