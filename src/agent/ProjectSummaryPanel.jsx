import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { localRunnerRequest } from "./DevicePanel.jsx";

const pending = (state) => ["queued", "running"].includes(state?.status);
const identity = (binding) =>
  binding && JSON.stringify([binding.bindingId, binding.revision]);
const pendingRequests = new Map();
const sections = [
  ["completed", "已完成"],
  ["inProgress", "进行中"],
  ["pending", "待处理"],
  ["blockers", "阻碍"],
  ["verification", "已核验"],
  ["uncertainties", "待核实"],
];

export async function prepareSummaryContext(
  binding,
  userId,
  requestLocal = localRunnerRequest,
) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname))
    return;
  let local;
  try {
    local = await requestLocal("/status", { accountId: userId });
  } catch {
    return;
  }
  if (
    local.runnerId === binding.runnerId &&
    local.connectionStatus === "online"
  )
    await requestLocal("/execution/context", {
      method: "POST",
      accountId: userId,
      body: { workspaceId: binding.workspaceId },
    });
}

export function ProjectSummaryCard({
  state,
  busy,
  error,
  reload,
  refresh,
  usePrevious,
  openChat,
  stop,
  stopping,
  stopNotice,
}) {
  const working = pending(state);
  const previous = !!state?.summary && (!state.ready || state.stale);
  return (
    <section
      className="agent-device-card agent-project-summary"
      aria-label="项目摘要"
    >
      <div className="agent-card-heading">
        <h4>项目摘要</h4>
        <button disabled={busy} onClick={reload}>
          刷新总结状态
        </button>
      </div>
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      {!state && <p className="agent-note">正在读取项目摘要…</p>}
      {state?.status === "queued" && (
        <p role="status">等待项目空闲后开始总结，返回页面不会重复创建总结。</p>
      )}
      {state?.status === "running" && (
        <p role="status">Codex 正在只读检查项目，完成后会显示摘要。</p>
      )}
      {state?.status === "uninitialized" && (
        <p className="agent-note">
          准备只读总结项目。总结完成后可根据项目实际情况聊天。
        </p>
      )}
      {state?.error && <p className="agent-error">{state.error}</p>}
      {stopNotice && (
        <p className="agent-note" role="status">
          {stopNotice}
        </p>
      )}
      {previous && (
        <p className="agent-note">
          {state.ready
            ? "正在使用上次摘要，请留意生成时间。"
            : "下方是上次摘要，尚未用于当前聊天。"}
        </p>
      )}
      {state?.summary && (
        <>
          <p className="agent-project-overview">{state.summary.overview}</p>
          <p className="agent-note">
            {previous ? "上次摘要" : "项目摘要"} · 第 {state.summaryRevision} 版
            {state.capturedAt && (
              <>
                {" "}
                ·{" "}
                <time dateTime={state.capturedAt}>
                  {new Date(state.capturedAt).toLocaleString("zh-CN")}
                </time>
              </>
            )}
          </p>
          <div className="agent-summary-sections">
            {sections.map(([key, label]) => (
              <section key={key} aria-label={`摘要${label}`}>
                <h5>{label}</h5>
                {state.summary[key]?.length ? (
                  <ul>
                    {state.summary[key].map((item, index) => (
                      <li key={index}>
                        {item.text}
                        {item.evidenceRef && (
                          <small>来源：{item.evidenceRef}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="agent-note">暂无记录</p>
                )}
              </section>
            ))}
          </div>
          <details className="agent-summary-source">
            <summary>查看总结来源</summary>
            <dl>
              {state.cwd && (
                <>
                  <dt>项目目录</dt>
                  <dd>{state.cwd}</dd>
                </>
              )}
              {state.threadId && (
                <>
                  <dt>Codex 会话</dt>
                  <dd>{state.threadId}</dd>
                </>
              )}
              {state.turnId && (
                <>
                  <dt>总结轮次</dt>
                  <dd>{state.turnId}</dd>
                </>
              )}
              {state.sourceRunId && (
                <>
                  <dt>运行编号</dt>
                  <dd>{state.sourceRunId}</dd>
                </>
              )}
              {state.gitBaseline && (
                <>
                  <dt>Git 基线</dt>
                  <dd>
                    {typeof state.gitBaseline === "string"
                      ? state.gitBaseline
                      : JSON.stringify(state.gitBaseline)}
                  </dd>
                </>
              )}
            </dl>
          </details>
        </>
      )}
      <div className="agent-actions">
        <button
          disabled={busy || !state || working || stopping}
          onClick={refresh}
        >
          {state?.status === "uninitialized" ? "开始总结" : "重新总结"}
        </button>
        {working && state?.activeRunId && (
          <button disabled={busy} onClick={stop}>
            停止总结
          </button>
        )}
        {state?.summary && !state.ready && !working && (
          <button disabled={busy} onClick={usePrevious}>
            使用上次摘要
          </button>
        )}
        {openChat && (
          <button disabled={busy || !state?.ready} onClick={openChat}>
            使用摘要聊天
          </button>
        )}
      </div>
    </section>
  );
}

export function ProjectSummary({
  binding,
  userId,
  call,
  loadBinding,
  requestLocal = localRunnerRequest,
  initialState,
  autoInitialize = true,
  onStateChange,
  openChat,
}) {
  const [state, setState] = useState(initialState ?? null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [stopping, setStopping] = useState(false),
    [stopNotice, setStopNotice] = useState("");
  const stopRequest = useRef(null);
  const mounted = useRef(false),
    epoch = useRef(0),
    inFlight = useRef(false),
    autoStarted = useRef(false);
  const notify = useRef(onStateChange);
  notify.current = onStateChange;
  const valid = useCallback(
    (version) => mounted.current && version === epoch.current,
    [],
  );
  const apply = useCallback((next) => {
    setState(next);
    notify.current?.(next);
  }, []);
  const read = useCallback(
    () =>
      call(
        `/api/agent/project/state?bindingId=${encodeURIComponent(binding.bindingId)}&bindingRevision=${binding.revision}`,
      ),
    [call, binding],
  );
  const reload = useCallback(async () => {
    const version = epoch.current;
    try {
      const next = await read();
      if (stopRequest.current) {
        const target = stopRequest.current;
        const result = await call("/api/agent/execution/tools", {
          method: "POST",
          body: {
            bindingId: binding.bindingId,
            name: "codex_get_run",
            arguments: { runId: target.runId },
          },
        });
        const run = result.result?.run;
        if (
          valid(version) &&
          stopRequest.current === target &&
          run?.runId === target.runId &&
          run.terminal &&
          run.stopConfirmed
        ) {
          stopRequest.current = null;
          setStopping(false);
          setStopNotice(
            run.status === "cancelled" ? "已确认停止总结。" : "总结已结束。",
          );
        }
      }
      if (valid(version)) {
        apply(next);
        setError("");
      }
    } catch (err) {
      if (valid(version)) setError(err.message);
    }
  }, [read, valid, apply, call, binding]);
  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    if (!initialState) void reload();
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [reload]);
  useEffect(() => {
    if (initialState) setState(initialState);
  }, [initialState]);
  const operate = useCallback(
    async (action, extra = {}) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError("");
      setStopNotice("");
      const version = epoch.current;
      const payload = {
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        ...extra,
      };
      const key = JSON.stringify([userId, action, payload]);
      if (!pendingRequests.has(key))
        pendingRequests.set(key, crypto.randomUUID());
      try {
        const latest = await loadBinding();
        if (!valid(version)) return;
        if (identity(latest) !== identity(binding))
          throw Error("项目关联已变化，请刷新后重试。");
        if (action !== "use-previous")
          await prepareSummaryContext(binding, userId, requestLocal);
        if (!valid(version)) return;
        const next = await call(`/api/agent/project/${action}`, {
          method: "POST",
          body: { requestId: pendingRequests.get(key), ...payload },
        });
        pendingRequests.delete(key);
        if (valid(version)) apply(next);
      } catch (err) {
        if (valid(version)) setError(err.message);
      } finally {
        inFlight.current = false;
        if (valid(version)) setBusy(false);
      }
    },
    [binding, userId, loadBinding, requestLocal, valid, call, apply],
  );
  const stop = useCallback(async () => {
    if (inFlight.current || !state?.activeRunId || !pending(state)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const version = epoch.current;
    const key = JSON.stringify([
      userId,
      binding.bindingId,
      binding.revision,
      "stop-summary",
      state.activeRunId,
    ]);
    if (!pendingRequests.has(key))
      pendingRequests.set(key, crypto.randomUUID());
    try {
      const latest = await loadBinding();
      if (!valid(version)) return;
      if (identity(latest) !== identity(binding))
        throw Error("项目关联已变化，请刷新后重试。");
      const target = {
        requestId: pendingRequests.get(key),
        runId: state.activeRunId,
      };
      stopRequest.current = target;
      setStopping(true);
      setStopNotice("正在请求停止，等待本机确认。");
      await call("/api/agent/execution/tools", {
        method: "POST",
        body: {
          bindingId: binding.bindingId,
          name: "codex_cancel_run",
          arguments: target,
        },
      });
      if (!valid(version)) return;
      setStopNotice("停止请求已保存，等待本机确认。");
      await reload();
    } catch (err) {
      if (valid(version)) setError(err.message);
    } finally {
      inFlight.current = false;
      if (valid(version)) setBusy(false);
    }
  }, [state, binding, userId, loadBinding, valid, call, reload]);
  useEffect(() => {
    if (
      autoInitialize &&
      state?.status === "uninitialized" &&
      !autoStarted.current
    ) {
      autoStarted.current = true;
      void operate("initialize");
    }
  }, [state?.status, operate, autoInitialize]);
  useEffect(() => {
    if (!pending(state) && !stopping) return;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading || inFlight.current) return;
      reading = true;
      try {
        await reload();
      } finally {
        reading = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.status, stopping, reload]);
  return (
    <ProjectSummaryCard
      {...{ state, busy, error, reload, openChat, stop, stopping, stopNotice }}
      refresh={() =>
        operate(state?.status === "uninitialized" ? "initialize" : "refresh")
      }
      usePrevious={() =>
        operate("use-previous", {
          expectedSummaryRevision: state.summaryRevision,
          expectedSourceRunId: state.sourceRunId,
          expectedActiveRunId: state.activeRunId,
        })
      }
    />
  );
}

function SummaryScope({
  roomId,
  userId,
  pageId,
  requestCloud,
  requestLocal,
  openChat,
}) {
  const [binding, setBinding] = useState(undefined),
    [error, setError] = useState("");
  const active = useRef(false),
    requestVersion = useRef(0);
  const call = useCallback(
    (route, options) =>
      requestCloud(route, {
        ...options,
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const loadBinding = useCallback(async () => {
    const version = ++requestVersion.current;
    const response = await call(
      `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(pageId)}`,
    );
    if (!active.current || requestVersion.current !== version) return;
    const next = response.binding?.enabled ? response.binding : null;
    setBinding((prior) => (identity(prior) === identity(next) ? prior : next));
    setError("");
    return next;
  }, [call, roomId, pageId]);
  useEffect(() => {
    active.current = true;
    void loadBinding().catch((err) => {
      if (active.current) setError(err.message);
    });
    return () => {
      active.current = false;
      requestVersion.current++;
    };
  }, [loadBinding]);
  if (error)
    return (
      <p className="agent-error" role="alert">
        {error}
        <button
          onClick={() =>
            void loadBinding().catch((err) => setError(err.message))
          }
        >
          重新读取项目关联
        </button>
      </p>
    );
  if (binding === undefined)
    return <p className="agent-note">正在读取项目关联…</p>;
  if (!binding)
    return (
      <p className="agent-note">请先在第 3 步为这个清单关联电脑和执行项目。</p>
    );
  return (
    <ProjectSummary
      key={identity(binding)}
      {...{ binding, userId, call, loadBinding, requestLocal, openChat }}
    />
  );
}

export default function ProjectSummaryPanel({
  roomId,
  userId,
  pages = [],
  requestCloud = api,
  requestLocal = localRunnerRequest,
  onOpenChat,
  initialPageId = "",
}) {
  const [selected, setSelected] = useState(initialPageId);
  const page = pages.find((item) => item.id === selected);
  return (
    <div className="agent-trial agent-project-panel">
      <div className="agent-intro">
        <h3>了解项目当前进度</h3>
        <p>
          由 Codex
          只读检查项目，区分已完成、待处理与尚未核实的内容，再将摘要用于轻单聊天。
        </p>
      </div>
      {pages.length > 0 ? (
        <>
          <label>
            项目清单
            <select
              aria-label="总结项目"
              value={page?.id || ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="" disabled>
                请选择要总结的项目
              </option>
              {pages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || "未命名清单"}
                </option>
              ))}
            </select>
          </label>
          {page && (
            <SummaryScope
              key={JSON.stringify([userId, roomId, page.id])}
              {...{ roomId, userId, requestCloud, requestLocal }}
              pageId={page.id}
              openChat={onOpenChat ? () => onOpenChat(page.id) : undefined}
            />
          )}
        </>
      ) : (
        <p className="agent-note">请先创建一个清单并在第 3 步关联项目。</p>
      )}
    </div>
  );
}
