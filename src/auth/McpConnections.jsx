import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import McpClientIdentity from "./McpClientIdentity.jsx";

const time = (value) => (value ? new Date(value).toLocaleString("zh-CN") : "—");
const tools = {
  create_tasks: "创建任务",
  update_task: "修改任务",
  delete_task: "删除任务",
  create_note: "创建便签",
  update_note: "修改便签",
};
function pageQuery(cursor) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export default function McpConnections(props) {
  return (
    <ConnectionsPanel
      key={`${props.user.id}/${props.sessionEpoch}`}
      {...props}
    />
  );
}

function ConnectionsPanel({ user, isCurrentSession }) {
  const [grants, setGrants] = useState(null);
  const [grantLoading, setGrantLoading] = useState(false);
  const [grantError, setGrantError] = useState("");
  const [rooms, setRooms] = useState([]);
  const [roomLoading, setRoomLoading] = useState(true);
  const [roomError, setRoomError] = useState("");
  const [canvasId, setCanvasId] = useState("");
  const [operations, setOperations] = useState(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState("");
  const [restoring, setRestoring] = useState(null);
  const [restoreError, setRestoreError] = useState(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const alive = useRef(false),
    grantPending = useRef(false),
    revokePending = useRef(false),
    restorePending = useRef(false);
  const operationGeneration = useRef(0),
    operationPending = useRef(null);
  const session = useRef(isCurrentSession);
  session.current = isCurrentSession;
  const current = () => alive.current && session.current();
  const currentTime = Math.max(now, Date.now());
  async function loadGrants(cursor = null) {
    if (!current() || grantPending.current) return;
    grantPending.current = true;
    setGrantLoading(true);
    setGrantError("");
    try {
      const result = await api(`/api/profile/mcp-grants?${pageQuery(cursor)}`, {
        accountId: user.id,
        isCurrentSession: current,
      });
      if (current())
        setGrants((previous) => ({
          ...result,
          items: cursor ? [...previous.items, ...result.items] : result.items,
        }));
    } catch (err) {
      if (current()) setGrantError(err.message);
    } finally {
      grantPending.current = false;
      if (current()) setGrantLoading(false);
    }
  }
  async function loadRooms() {
    setRoomLoading(true);
    setRoomError("");
    try {
      const result = await api("/api/rooms", {
        accountId: user.id,
        isCurrentSession: current,
      });
      if (current()) setRooms(result.rooms);
    } catch (err) {
      if (current()) setRoomError(err.message);
    } finally {
      if (current()) setRoomLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadGrants();
    void loadRooms();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);

  async function loadOperations(id, cursor, generation) {
    if (!id || !current() || operationPending.current === generation) return;
    operationPending.current = generation;
    setOperationLoading(true);
    setOperationError("");
    const valid = () => current() && operationGeneration.current === generation;
    try {
      const result = await api(
        `/api/rooms/${encodeURIComponent(id)}/mcp-operations?${pageQuery(cursor)}`,
        { accountId: user.id, isCurrentSession: current },
      );
      if (valid())
        setOperations((previous) => ({
          ...result,
          items: cursor ? [...previous.items, ...result.items] : result.items,
        }));
    } catch (err) {
      if (valid()) setOperationError(err.message);
    } finally {
      if (operationPending.current === generation)
        operationPending.current = null;
      if (valid()) setOperationLoading(false);
    }
  }
  useEffect(() => {
    if (canvasId)
      void loadOperations(canvasId, null, operationGeneration.current);
  }, [canvasId]);
  function chooseCanvas(id) {
    operationGeneration.current++;
    setCanvasId(id);
    setOperations(null);
    setOperationLoading(false);
    setOperationError("");
    setRestoreError(null);
    setNotice("");
    setRestoring(null);
    restorePending.current = false;
  }
  async function revoke(id) {
    if (!current() || revokePending.current) return;
    revokePending.current = true;
    setRevoking(id);
    setRevokeError("");
    try {
      await api(`/api/profile/mcp-grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
        accountId: user.id,
        isCurrentSession: current,
      });
      if (!current()) return;
      setGrants((previous) => ({
        ...previous,
        items: previous.items.map((item) =>
          item.id === id
            ? { ...item, state: "revoked", revoked_at: Date.now() }
            : item,
        ),
      }));
      setConfirm(null);
    } catch (err) {
      if (current()) setRevokeError(err.message);
    } finally {
      revokePending.current = false;
      if (current()) setRevoking(null);
    }
  }
  async function restore(item) {
    if (
      !current() ||
      restorePending.current ||
      item.restored ||
      new Date(item.restorable_until).getTime() <= Date.now()
    )
      return;
    restorePending.current = true;
    const generation = operationGeneration.current;
    const valid = () => current() && operationGeneration.current === generation;
    setRestoring(item.operation_id);
    setRestoreError(null);
    setNotice("");
    try {
      const result = await api(
        `/api/rooms/${encodeURIComponent(canvasId)}/mcp-operations/${encodeURIComponent(item.operation_id)}/restore`,
        {
          method: "POST",
          accountId: user.id,
          isCurrentSession: current,
          body: { request_id: crypto.randomUUID() },
        },
      );
      if (!valid()) return;
      setOperations((previous) => ({
        ...previous,
        items: previous.items.map((op) =>
          op.operation_id === item.operation_id
            ? { ...op, restored: true }
            : op,
        ),
      }));
      setNotice(
        `已恢复${Array.isArray(result.task_ids) ? ` ${result.task_ids.length} 段` : ""}删除内容。`,
      );
    } catch (err) {
      if (valid())
        setRestoreError({ id: item.operation_id, message: err.message });
    } finally {
      if (valid()) {
        restorePending.current = false;
        setRestoring(null);
      }
    }
  }
  return (
    <section className="mcp-connections" aria-label="Agent 连接管理">
      <p className="mcp-help">
        同一账号对同一客户端重新授权会替换旧授权。多个设备使用相同客户端 ID
        时，重新授权或撤销会影响其他设备。
      </p>
      {grants && (
        <>
          <p className="mcp-help">
            {grants.enabled
              ? "MCP 连接服务已启用"
              : "MCP 连接服务已停用；仍可管理连接和恢复删除。"}
          </p>
          {grants.resource && (
            <dl className="mcp-facts">
              <div>
                <dt>MCP 地址</dt>
                <dd>{grants.resource}</dd>
              </div>
            </dl>
          )}
          {!grants.items.length && (
            <p className="mcp-help">
              还没有 Agent 连接。
              {grants.resource
                ? "可在客户端添加上方 MCP 地址后发起授权。"
                : "服务配置完成后，即可从客户端发起授权。"}
            </p>
          )}
          <ul className="mcp-list">
            {grants.items.map((item) => {
              const status =
                item.state === "revoked"
                  ? "已撤销"
                  : item.expires_at <= currentTime
                    ? "已到期"
                    : item.state === "pending"
                      ? "待生效"
                      : "有效";
              return (
                <li className="mcp-record" key={item.id}>
                  <McpClientIdentity client={item.client} />
                  <p className="mcp-state">
                    {status} ·{" "}
                    {item.scopes.includes("qingdan:write") ? "读写" : "只读"}
                    {item.scopes.includes("offline_access")
                      ? " · 可持续连接"
                      : ""}
                  </p>
                  <dl className="mcp-facts">
                    <div>
                      <dt>到期时间</dt>
                      <dd>{time(item.expires_at)}</dd>
                    </div>
                    <div>
                      <dt>最近使用</dt>
                      <dd>
                        {item.last_used_at
                          ? time(item.last_used_at)
                          : "尚未使用"}
                      </dd>
                    </div>
                    <div>
                      <dt>授权地址</dt>
                      <dd>{item.resource}</dd>
                    </div>
                    <div>
                      <dt>已选且当前可访问的画布</dt>
                      <dd>
                        {item.canvases.length
                          ? item.canvases
                              .map((canvas) => canvas.name)
                              .join("、")
                          : "当前没有可访问的已选画布"}
                      </dd>
                    </div>
                  </dl>
                  {item.state !== "revoked" &&
                    (confirm === item.id ? (
                      <div className="mcp-revoke-confirm">
                        <p>撤销后，此连接将立即失去访问权限。</p>
                        <div className="mcp-actions">
                          <button
                            className="secondary"
                            disabled={!!revoking}
                            onClick={() => {
                              setConfirm(null);
                              setRevokeError("");
                            }}
                          >
                            取消
                          </button>
                          <button
                            className="secondary"
                            disabled={!!revoking}
                            onClick={() => void revoke(item.id)}
                          >
                            {revoking === item.id ? "正在撤销…" : "确认撤销"}
                          </button>
                        </div>
                        {revokeError && (
                          <p role="alert" className="form-error">
                            {revokeError}
                          </p>
                        )}
                      </div>
                    ) : (
                      <button
                        className="secondary"
                        disabled={!!revoking}
                        onClick={() => {
                          setConfirm(item.id);
                          setRevokeError("");
                        }}
                      >
                        撤销连接
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {grantLoading && <p role="status">正在读取连接…</p>}
      {grantError && (
        <p role="alert" className="form-error">
          {grantError}
        </p>
      )}
      {grantError && (
        <button
          className="secondary"
          disabled={grantLoading}
          onClick={() => void loadGrants(grants?.next_cursor)}
        >
          重试读取连接
        </button>
      )}
      {grants?.next_cursor && !grantError && (
        <button
          className="secondary wide"
          disabled={grantLoading}
          onClick={() => void loadGrants(grants.next_cursor)}
        >
          更多连接
        </button>
      )}
      <div className="mcp-history">
        <h3>我的 Agent 操作记录</h3>
        <p className="mcp-help">
          仅列出你在所选画布的操作。删除后 30
          天内，仍有编辑权限时可恢复；不需要保留有效连接。恢复保留其他人的修改，目标被锁定或存在冲突时会提示。
        </p>
        <label>
          操作记录画布
          <select
            value={canvasId}
            disabled={roomLoading}
            onChange={(event) => chooseCanvas(event.target.value)}
          >
            <option value="">请选择画布</option>
            {rooms.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {roomLoading && <p role="status">正在读取画布…</p>}
        {roomError && (
          <>
            <p className="form-error" role="alert">
              {roomError}
            </p>
            <button className="secondary" onClick={() => void loadRooms()}>
              重试读取画布
            </button>
          </>
        )}
        {!roomLoading && !roomError && !rooms.length && (
          <p className="mcp-help">
            当前没有可查看记录的画布。请先创建或加入画布。
          </p>
        )}
        {operations && !operations.items.length && (
          <p className="mcp-help">这张画布还没有你的 Agent 操作记录。</p>
        )}
        <ul className="mcp-list">
          {operations?.items.map((item) => (
            <li className="mcp-record" key={item.operation_id}>
              <strong>{tools[item.tool] || item.tool}</strong>
              <dl className="mcp-facts">
                <div>
                  <dt>操作时间</dt>
                  <dd>{time(item.created_at)}</dd>
                </div>
                <div>
                  <dt>客户端 ID</dt>
                  <dd>{item.client_id}</dd>
                </div>
                <div>
                  <dt>操作 ID</dt>
                  <dd>{item.operation_id}</dd>
                </div>
                {item.result.note_id && (
                  <div>
                    <dt>便签 ID</dt>
                    <dd>{item.result.note_id}</dd>
                  </div>
                )}
              </dl>
              {item.restorable_until && (
                <>
                  <p className="mcp-help">
                    恢复截止：{time(item.restorable_until)}
                  </p>
                  {item.restored ? (
                    <p className="mcp-state">已恢复</p>
                  ) : new Date(item.restorable_until).getTime() <=
                    currentTime ? (
                    <p className="mcp-help">恢复期限已过</p>
                  ) : (
                    <button
                      className="secondary"
                      disabled={!!restoring}
                      onClick={() => void restore(item)}
                    >
                      {restoring === item.operation_id
                        ? "正在恢复…"
                        : "恢复删除"}
                    </button>
                  )}
                </>
              )}
              {restoreError?.id === item.operation_id && (
                <p className="form-error" role="alert">
                  {restoreError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
        {operationLoading && <p role="status">正在读取操作记录…</p>}
        {operationError && (
          <>
            <p className="form-error" role="alert">
              {operationError}
            </p>
            <button
              className="secondary"
              disabled={operationLoading}
              onClick={() =>
                void loadOperations(
                  canvasId,
                  operations?.next_cursor,
                  operationGeneration.current,
                )
              }
            >
              重试读取记录
            </button>
          </>
        )}
        {operations?.next_cursor && !operationError && (
          <button
            className="secondary wide"
            disabled={operationLoading}
            onClick={() =>
              void loadOperations(
                canvasId,
                operations.next_cursor,
                operationGeneration.current,
              )
            }
          >
            更多操作
          </button>
        )}
        {notice && (
          <p className="profile-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
