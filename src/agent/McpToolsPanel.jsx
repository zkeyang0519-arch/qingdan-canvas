import React, { useEffect, useRef, useState } from "react";
import {
  Cable,
  ChevronDown,
  ExternalLink,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  waaoMcpId,
  waaoIssuer,
  waaoProjectsUrl,
} from "../../shared/agent/waao-endpoint.mjs";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import McpToolPicker from "./McpToolPicker.jsx";
import "./mcp-tools.css";

const statusLabel = {
  checking: "正在检测",
  ready: "已连接",
  authorization: "需要授权",
  offline: "连接失败",
  removing: "正在移除",
};

function ConnectionDetails({ server, children }) {
  const needsAttention =
    server.status !== "ready" || server.maintenance?.status === "blocked";
  const [open, setOpen] = useState(needsAttention);
  useEffect(() => {
    if (needsAttention) setOpen(true);
  }, [needsAttention]);
  return (
    <details
      className="qd-mcp-connection"
      data-attention={needsAttention || undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronDown size={15} aria-hidden="true" />
        <strong>连接设置</strong>
        <small>{statusLabel[server.status]}</small>
      </summary>
      <div className="qd-mcp-connection-content">{children}</div>
    </details>
  );
}

function TokenInput({ label, onSubmit, disabled }) {
  const [token, setToken] = useState("");
  return (
    <form
      className="qd-mcp-inline"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSubmit(token)) setToken("");
      }}
    >
      <label>
        {label}
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
      </label>
      <button disabled={disabled || !token.trim()}>更新并连接</button>
    </form>
  );
}

function AddService({ disabled, onAdd, onCancel }) {
  const [mode, setMode] = useState("auto");
  return (
    <form
      className="qd-mcp-add"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onAdd({
          name: form.get("name"),
          url: form.get("url"),
          authMode: mode,
          integrationKind: form.get("integrationKind"),
          ...(mode === "token" ? { token: form.get("token") } : {}),
        });
      }}
    >
      <label>
        接入类型
        <select name="integrationKind" aria-label="服务类型">
          <option value="tool">MCP 工具</option>
          <option value="agent">Agent · 通过 MCP 接入</option>
        </select>
      </label>
      <label>
        服务名称
        <input
          name="name"
          autoFocus
          required
          maxLength={80}
          placeholder="例如，团队知识库"
        />
      </label>
      <label>
        MCP 地址
        <input
          type="url"
          name="url"
          required
          placeholder="https://example.com/mcp"
        />
      </label>
      <label>
        认证方式
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="auto">自动识别 · 公开服务或网页登录</option>
          <option value="token">Bearer Token</option>
        </select>
      </label>
      {mode === "token" && (
        <label>
          Bearer Token
          <input name="token" type="password" autoComplete="off" required />
        </label>
      )}
      <div className="qd-mcp-buttons">
        <button className="primary" disabled={disabled}>
          连接并读取工具
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          取消
        </button>
      </div>
    </form>
  );
}

export default function McpToolsPanel({
  bindingId,
  call,
  initialServer,
  onClose,
  embedded = false,
  executionSettings,
  unavailable,
}) {
  const [servers, setServers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [requestBusy, setBusy] = useState(false);
  const busy = requestBusy || !!unavailable;
  const [expanded, setExpanded] = useState(initialServer);
  const [serviceQuery, setServiceQuery] = useState("");
  const [serviceKind, setServiceKind] = useState("all");
  const alive = useRef(false),
    working = useRef(false);
  const endpoint = "/local/mcp?bindingId=" + encodeURIComponent(bindingId);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    call(endpoint, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setServers(result.servers);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [call, endpoint]);

  const checking = (servers || [])
    .filter((server) => server.kind && server.status === "checking")
    .map((server) => server.id)
    .join(",");
  useEffect(() => {
    if (!checking) return;
    const controller = new AbortController();
    for (const id of checking.split(","))
      call(endpoint + "&waitForService=" + encodeURIComponent(id), {
        signal: controller.signal,
      })
        .then((result) => {
          const ready = result.servers.find((server) => server.id === id);
          if (!controller.signal.aborted && ready)
            setServers((current) =>
              current.map((server) =>
                server.id === id && server.status === "checking"
                  ? { ...ready, selected: server.selected }
                  : server,
              ),
            );
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(err.message);
        });
    return () => controller.abort();
  }, [call, endpoint, checking]);

  const maintaining = servers?.some((server) =>
    ["repairing", "validating"].includes(server.maintenance?.status),
  );
  useEffect(() => {
    if (!checking && !maintaining && !busy) return;
    const controller = new AbortController();
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await call(endpoint, { signal: controller.signal });
        if (!controller.signal.aborted) setServers(result.servers);
      } catch {
        /* The initiating request owns any actionable error. */
      } finally {
        reading = false;
      }
    }, 1200);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [call, endpoint, checking, maintaining, busy]);

  async function run(body) {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await call(endpoint, {
        method: "POST",
        body: {
          ...body,
          ...(body.action === "login" && {
            returnTo: window.location.pathname + window.location.search,
          }),
        },
      });
      if (!alive.current) return false;
      if (result.servers) setServers(result.servers);
      if (result.id) {
        setAdding(false);
        setExpanded(result.id);
      }
      if (result.error) setError(result.error);
      if (result.url) {
        const dest = new URL(result.url);
        if (
          body.id === waaoMcpId
            ? dest.origin !== waaoIssuer
            : !(
                dest.protocol === "https:" ||
                (dest.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(dest.hostname))
              )
        )
          throw Error("授权网址无效。");
        window.location.assign(dest.href);
      }
      return !result.error;
    } catch (err) {
      if (alive.current) setError(err.message);
      return false;
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const Surface = embedded ? "section" : WorkspaceDrawer;
  // An older local service may still return a delegated WAAO catalog while
  // the application is being upgraded. Never present it as a direct service.
  const directServers = servers?.filter(
    (server) =>
      !(server.kind === "waao" && server.connectionSource === "codex"),
  );
  const visibleServers = directServers?.filter(
    (server) =>
      (serviceKind === "all" ||
        (serviceKind === "agent") ===
          (server.kind === "codex" || server.integrationKind === "agent")) &&
      [
        server.name,
        ...server.tools.map((tool) => `${tool.label} ${tool.description}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(serviceQuery.trim().toLowerCase()),
  );
  return (
    <Surface
      {...(embedded
        ? { "aria-label": "工具与 Agent" }
        : {
            title: "工具与 Agent",
            description: "为当前项目连接服务，Agent 会按任务加载所需工具。",
            onClose,
          })}
    >
      <div className={`qd-mcp-panel${embedded ? " is-embedded" : ""}`}>
        <div className="qd-mcp-heading">
          <h3>可用服务</h3>
          {!adding && (
            <button
              type="button"
              disabled={busy || !servers}
              onClick={() => setAdding(true)}
            >
              <Plus size={14} />
              添加服务
            </button>
          )}
        </div>
        <div className="qd-integration-toolbar">
          <input
            type="search"
            aria-label="搜索工具与 Agent"
            placeholder="搜索服务或能力…"
            value={serviceQuery}
            onChange={(e) => setServiceQuery(e.target.value)}
          />
        </div>
        <div className="qd-integration-filters" aria-label="服务分类">
          {[
            ["all", "全部"],
            ["agent", "Agent"],
            ["tool", "MCP 工具"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={serviceKind === id}
              onClick={() => setServiceKind(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {adding && (
          <AddService
            disabled={busy}
            onCancel={() => setAdding(false)}
            onAdd={(row) => run({ action: "add", ...row })}
          />
        )}
        {error && (
          <p role="alert" className="agent-error">
            {error}
          </p>
        )}
        {unavailable && (
          <p className="agent-note" role="status">
            本地服务暂不可用，已保留当前设置输入。服务恢复后可继续。
          </p>
        )}
        {busy && <p role="status">正在处理连接…</p>}
        {!servers && !error && <p role="status">正在读取服务…</p>}
        {servers && !visibleServers.length && (
          <p role="status">没有匹配的服务。</p>
        )}
        {directServers?.map((server) => {
          const open = expanded === server.id;
          const isWaao = server.kind === "waao";
          function selectPreset(names) {
            const matched = server.tools
              .filter((tool) => names.includes(tool.name))
              .map((tool) => tool.name);
            return run({
              action: "enable",
              id: server.id,
              tools: matched,
            });
          }
          return (
            <section
              className="qd-mcp-service"
              key={server.id}
              hidden={!visibleServers.includes(server)}
            >
              <button
                type="button"
                className="qd-mcp-row"
                aria-expanded={open}
                onClick={() => {
                  setExpanded(open ? null : server.id);
                }}
              >
                <Cable size={18} />
                <span>
                  <strong>{server.name}</strong>
                  <small>
                    {server.kind === "codex"
                      ? "内置 · 本机 Codex · 只读工作区"
                      : isWaao
                        ? "轻单独立连接 · WAAO 官网 MCP"
                        : new URL(server.url).host}
                  </small>
                </span>
                <small>
                  {statusLabel[server.status]}
                  {isWaao &&
                    ` · ${server.enabled ? "当前项目已开启" : "当前项目未开启"}`}
                  {!isWaao &&
                    server.status === "ready" &&
                    server.selected.length === 0 &&
                    " · 本项目未启用"}
                  {!isWaao &&
                    (server.status === "ready" || server.tools.length > 0) &&
                    ` · 已选 ${server.selected.length}/${server.tools.length}`}
                </small>
              </button>
              <div className="qd-mcp-body" hidden={!open}>
                {isWaao && server.authorization?.verified && (
                  <p className="agent-note" role="status">
                    WAAO 服务端已确认授权 · {server.authorization.accountLabel}
                  </p>
                )}
                {isWaao && (
                  <div className="qd-waao-service-control">
                    <div className="qd-waao-service-toggle">
                      <div>
                        <strong>在当前项目使用 WAAO</strong>
                        <p>
                          {server.status === "ready"
                            ? "开启后，Agent 会根据任务发现并加载所需工具。"
                            : "先完成官网授权并核验账号，再开启当前项目服务。"}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        className="qd-waao-switch"
                        aria-label="在当前项目使用 WAAO"
                        aria-checked={!!server.enabled}
                        data-state={server.enabled ? "checked" : "unchecked"}
                        disabled={
                          busy || (server.status !== "ready" && !server.enabled)
                        }
                        onClick={() =>
                          run({
                            action: "service",
                            id: server.id,
                            enabled: !server.enabled,
                          })
                        }
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>
                    <p className="agent-note">
                      项目、组织、预算和操作权限由 WAAO 管理，无需逐项勾选工具。
                    </p>
                  </div>
                )}
                {isWaao && server.accessIssue && (
                  <div className="qd-waao-access-issue" role="status">
                    <strong>上次调用被 WAAO 拒绝</strong>
                    <p>{server.accessIssue.message}</p>
                    {server.accessIssue.requiredScopes?.length > 0 && (
                      <p>
                        WAAO 要求的权限：
                        {server.accessIssue.requiredScopes.join("、")}
                      </p>
                    )}
                    <a
                      href={server.accessIssue.actionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {server.accessIssue.actionLabel}
                    </a>
                  </div>
                )}
                {!isWaao &&
                  server.status === "ready" &&
                  !server.selected.length && (
                    <p className="agent-note">
                      已连接，还没有在当前项目启用工具。请勾选需要的工具后再回到聊天使用。
                    </p>
                  )}
                {isWaao && server.tools.length > 0 && (
                  <details className="qd-waao-catalog">
                    <summary>
                      查看可用工具目录 · {server.tools.length} 项
                    </summary>
                    <McpToolPicker server={server} readOnly />
                  </details>
                )}
                {!isWaao && server.tools.length > 0 && (
                  <McpToolPicker
                    server={server}
                    disabled={busy || server.status !== "ready"}
                    onPreset={selectPreset}
                    onSelect={(tools) =>
                      run({ action: "select", id: server.id, tools })
                    }
                  />
                )}
                {server.status === "ready" && !server.tools.length && (
                  <p>服务已连接，目前没有提供工具。</p>
                )}
                <ConnectionDetails server={server}>
                  {!server.kind && (
                    <label>
                      服务分类
                      <select
                        aria-label={"服务分类：" + server.name}
                        disabled={busy}
                        value={server.integrationKind || "tool"}
                        onChange={(e) =>
                          run({
                            action: "category",
                            id: server.id,
                            kind: e.target.value,
                          })
                        }
                      >
                        <option value="tool">MCP 工具</option>
                        <option value="agent">Agent · 通过 MCP 接入</option>
                      </select>
                    </label>
                  )}
                  {server.kind === "codex" && executionSettings && (
                    <details className="qd-agent-preferences">
                      <summary>
                        待办执行偏好 <span>用于之后提交的编程任务</span>
                      </summary>
                      {executionSettings}
                    </details>
                  )}
                  {server.maintenance && (
                    <div className="qd-mcp-maintenance" role="status">
                      <p>{server.maintenance.message}</p>
                      <small>
                        {server.maintenance.version} · 适配版本{" "}
                        {server.maintenance.revision}
                      </small>
                      {server.maintenance.status === "blocked" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run({ action: "retry-maintenance", id: server.id })
                          }
                        >
                          重新尝试自动适配
                        </button>
                      )}
                    </div>
                  )}
                  {server.verification && server.status === "ready" && (
                    <p className="agent-note">
                      连接已验证 · 工具目录已读取
                      {server.verification.read && " · 查询已验证"}
                      {server.verification.execution
                        ? " · 实际调用有成功回执"
                        : " · 对话或生成尚未验证"}
                    </p>
                  )}
                  {server.diagnostic && (
                    <p className="agent-error" role="status">
                      {server.diagnostic}
                    </p>
                  )}
                  <div className="qd-mcp-buttons">
                    {isWaao && (
                      <a
                        href={waaoProjectsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        打开 WAAO 项目 <ExternalLink size={13} />
                      </a>
                    )}
                    {server.kind === "codex" && (
                      <p className="agent-note">
                        对话工具使用只读工作区；待办执行沿用本批次选择的文件权限。
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run({ action: "test", id: server.id })}
                    >
                      <RefreshCw size={13} />
                      测试连接
                    </button>
                    {(server.status === "authorization" ||
                      (isWaao && server.status === "offline")) &&
                      server.authMode === "auto" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run({ action: "login", id: server.id })
                          }
                        >
                          {isWaao ? "连接 WAAO" : "网页登录"}{" "}
                          <ExternalLink size={13} />
                        </button>
                      )}
                    {!isWaao && server.selected.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run({ action: "select", id: server.id, tools: [] })
                        }
                      >
                        在此项目停用
                      </button>
                    )}
                  </div>
                  {server.authMode === "token" && (
                    <TokenInput
                      label="更换 Token"
                      disabled={busy}
                      onSubmit={(token) =>
                        run({ action: "token", id: server.id, token })
                      }
                    />
                  )}
                  {!server.kind && (
                    <button
                      type="button"
                      className="qd-mcp-remove"
                      disabled={busy}
                      onClick={() => run({ action: "remove", id: server.id })}
                    >
                      从所有项目移除连接
                    </button>
                  )}
                </ConnectionDetails>
              </div>
            </section>
          );
        })}
        {executionSettings &&
          servers &&
          !servers.some((server) => server.kind === "codex") && (
            <details className="qd-agent-preferences">
              <summary>Codex 待办执行偏好</summary>
              {executionSettings}
            </details>
          )}
      </div>
    </Surface>
  );
}

export function McpCalls({ calls, onOpen }) {
  if (!calls?.length) return null;
  return (
    <div className="qd-mcp-receipts">
      {calls.map((call, i) => (
        <details key={i}>
          <summary>
            {call.service} · {call.tool}{" "}
            <small>
              {call.status === "done"
                ? "已完成"
                : call.status === "error"
                  ? "失败"
                  : "未收到回执"}
            </small>
          </summary>
          <p>{call.accessIssue?.message || call.summary}</p>
          {call.links?.length > 0 && (
            <ul aria-label="结果中的链接">
              {call.links.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {call.accessIssue && (
            <a
              href={call.accessIssue.actionUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {call.accessIssue.actionLabel}
            </a>
          )}
          {call.status === "error" && !call.accessIssue && (
            <button type="button" onClick={() => onOpen(call.serverId)}>
              重新连接
            </button>
          )}
        </details>
      ))}
    </div>
  );
}
