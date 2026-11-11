import UnknownWorkspaceRequests from "./UnknownWorkspaceRequests.jsx";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../api.js";
import { localRunnerRequest } from "./DevicePanel.jsx";
import {
  createWorkspaceRequests,
  useWorkspaceRequests,
  workspaceScope,
} from "./workspace-state.js";
import ExecutionPanel from "./ExecutionPanel.jsx";

const pending = (state) =>
  ["queued", "running", "reconciliation_required"].includes(state?.status);
const identity = (binding) =>
  binding &&
  JSON.stringify([
    binding.bindingId,
    binding.revision,
    binding.runnerId,
    binding.workspaceId,
  ]);
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
  blocked = false,
  unknown = false,
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
      {state?.status === "reconciliation_required" && (
        <p role="status">原总结仍待核对，可以继续读取状态或停止原总结。</p>
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
          disabled={
            busy ||
            blocked ||
            !state ||
            (working && !state.canRefresh) ||
            stopping
          }
          onClick={refresh}
        >
          {state?.status === "uninitialized" ? "开始总结" : "重新总结"}
        </button>
        {((working && state?.activeRunId) || unknown || stopping) && (
          <button disabled={busy} onClick={stop}>
            停止总结
          </button>
        )}
        {state?.summary &&
          !state.ready &&
          state.status === "failed" &&
          !working && (
            <button
              disabled={busy || blocked || stopping}
              onClick={usePrevious}
            >
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

export function ProjectSummary(props) {
  const scope = workspaceScope({
    accountId: props.userId,
    canvasId: props.roomId,
    sectionId: props.pageId,
    binding: props.binding,
  });
  return <SummarySession key={scope} {...props} />;
}

function SummarySession({
  binding,
  userId,
  roomId,
  pageId,
  call,
  loadBinding,
  requestLocal = localRunnerRequest,
  initialState,
  autoInitialize = false,
  onStateChange,
  openChat,
}) {
  const [state, setState] = useState(initialState ?? null),
    [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(""),
    [actionError, setActionError] = useState("");
  const [stopping, setStopping] = useState(false),
    [stopNotice, setStopNotice] = useState("");
  const [readConfirmed, setReadConfirmed] = useState(false),
    [showRecovery, setShowRecovery] = useState(false);
  const mounted = useRef(false),
    epoch = useRef(0),
    inFlight = useRef(false),
    autoStarted = useRef(false);
  const readSequence = useRef(0),
    acceptedRead = useRef(0),
    mutation = useRef(0),
    stopRequest = useRef(null);
  const notify = useRef(onStateChange);
  notify.current = onStateChange;
  const fullScope = {
    accountId: userId,
    canvasId: roomId,
    sectionId: pageId,
    binding,
  };
  const scope = workspaceScope(fullScope);
  const requests = useWorkspaceRequests(scope, { owner: "summary" });
  const requestRef = useRef(requests);
  requestRef.current = requests;
  const stopStores = useRef(new Map());
  const stopStoreFor = useCallback(
    (runId) => {
      const key = workspaceScope({ ...fullScope, runId });
      if (!stopStores.current.has(key))
        stopStores.current.set(
          key,
          createWorkspaceRequests(key, { owner: "summary-stop" }),
        );
      return stopStores.current.get(key);
    },
    [scope],
  );
  const stopStore = useMemo(
    () =>
      stopStoreFor(stopRequest.current?.runId ?? state?.activeRunId ?? null),
    [stopStoreFor, state?.activeRunId, stopping],
  );
  const stopSnapshot = useSyncExternalStore(
    stopStore.subscribe,
    stopStore.getSnapshot,
    stopStore.getSnapshot,
  );
  const valid = useCallback(
    (version) => mounted.current && epoch.current === version,
    [],
  );
  const apply = useCallback((next) => {
    setState(next);
    notify.current?.(next);
  }, []);
  const read = useCallback(
    (inspectOnly = true) =>
      call(
        "/api/agent/project/state?bindingId=" +
          encodeURIComponent(binding.bindingId) +
          "&bindingRevision=" +
          binding.revision +
          (inspectOnly ? "&inspectOnly=true" : ""),
      ),
    [call, binding],
  );
  const reload = useCallback(
    async (inspectOnly = true) => {
      const version = epoch.current,
        sequence = ++readSequence.current,
        generation = mutation.current;
      try {
        const next = await read(inspectOnly);
        if (
          !valid(version) ||
          generation !== mutation.current ||
          sequence < acceptedRead.current
        )
          return;
        acceptedRead.current = sequence;
        apply(next);
        setReadError("");
        setReadConfirmed(true);
        const sealedRequest = next.sealedLaunch?.projectRequestId;
        if (
          sealedRequest &&
          requestRef.current.ownedRecords.some(
            (record) => record.requestId === sealedRequest,
          )
        )
          await requestRef.current.resolve(sealedRequest, "sealed");
        const target =
          stopRequest.current ??
          stopStore.getSnapshot().ownedRecords[0]?.request.body.arguments;
        if (target) {
          let confirmed = next.sealedLaunch?.runId === target.runId;
          let notice = confirmed ? "已封存原总结启动，未派发到电脑。" : "";
          if (!confirmed && !(next.pendingLaunch?.runId === target.runId)) {
            const result = await call("/api/agent/execution/tools", {
              method: "POST",
              body: {
                bindingId: binding.bindingId,
                name: "codex_get_run",
                arguments: { runId: target.runId },
              },
            });
            const run = result.result?.run;
            confirmed =
              run?.runId === target.runId && run.terminal && run.stopConfirmed;
            notice =
              run?.status === "cancelled" ? "已确认停止总结。" : "总结已结束。";
          }
          if (confirmed && valid(version) && generation === mutation.current) {
            stopRequest.current = null;
            setStopping(false);
            setStopNotice(notice);
            const saved = stopStoreFor(target.runId)
              .getSnapshot()
              .ownedRecords.find((r) => r.requestId === target.requestId);
            if (saved)
              await stopStoreFor(target.runId).resolve(
                saved.requestId,
                next.sealedLaunch ? "sealed" : "acknowledged",
              );
          }
        }
      } catch (err) {
        if (valid(version) && generation === mutation.current)
          setReadError(err.message);
      }
    },
    [read, valid, apply, call, binding, stopStore, stopStoreFor],
  );
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    setReadConfirmed(false);
    void reloadRef.current(true);
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [scope]);
  async function confirmBinding(version) {
    if (
      !userId ||
      !roomId ||
      !pageId ||
      !binding?.runnerId ||
      !binding?.workspaceId
    )
      throw Error("请先读取完整的项目关联。");
    const latest = await loadBinding();
    if (!valid(version)) return false;
    if (identity(latest) !== identity(binding))
      throw Error("项目关联已变化，请刷新后重试。");
    return true;
  }
  const operate = useCallback(
    async (action, extra = {}, saved = null) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setActionError("");
      setStopNotice("");
      mutation.current++;
      const version = epoch.current;
      let record, store;
      try {
        if (!(await confirmBinding(version))) return;
        if (!saved && requestRef.current.ownedRecords.length)
          throw Error("原总结操作仍待核对，请先核对或重试原操作。");
        store = requestRef.current;
        record = saved
          ? await store.prepare(saved.operationKey, () => saved.request)
          : await store.prepare("summary:" + action, (requestId) => ({
              path: "/api/agent/project/" + action,
              method: "POST",
              body: {
                requestId,
                bindingId: binding.bindingId,
                bindingRevision: binding.revision,
                ...extra,
              },
            }));
        if (!valid(version)) return;
        if (
          record.request.path.endsWith("/initialize") ||
          record.request.path.endsWith("/refresh")
        )
          await prepareSummaryContext(binding, userId, requestLocal);
        if (!valid(version)) return;
        store.assertOwned(record);
        const next = await call(record.request.path, {
          method: record.request.method,
          body: record.request.body,
        });
        if (valid(version)) {
          mutation.current++;
          apply(next);
          setReadError("");
        }
        await store.resolve(record.requestId, "acknowledged");
      } catch (err) {
        if (valid(version)) setActionError(err.message);
        if (
          record &&
          err.status >= 400 &&
          err.status < 500 &&
          ![408, 429].includes(err.status)
        ) {
          // A rejected request cannot become a new operation. Any earlier durable
          // launch remains visible in the server's coordinator and blocks replacement.
          await store.resolve(record.requestId, "rejected").catch(() => {});
          if (valid(version)) await reloadRef.current(true);
        }
      } finally {
        inFlight.current = false;
        if (valid(version)) setBusy(false);
      }
    },
    [
      scope,
      binding,
      userId,
      roomId,
      pageId,
      loadBinding,
      requestLocal,
      call,
      apply,
      valid,
    ],
  );
  const stop = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError("");
    mutation.current++;
    const version = epoch.current;
    try {
      if (!(await confirmBinding(version))) return;
      // Inspect never commits a prepared launch. Stopping must not first start it.
      const next = await read(true);
      if (!valid(version)) return;
      apply(next);
      const runId = stopRequest.current?.runId ?? next.activeRunId;
      if (!runId)
        throw Error("尚未找到可确认的原总结目标，请打开执行记录核对。");
      const store = stopStoreFor(runId);
      const saved = await store.prepare(
        "summary:stop",
        (requestId) => ({
          path: "/api/agent/execution/tools",
          method: "POST",
          body: {
            bindingId: binding.bindingId,
            name: "codex_cancel_run",
            arguments: { requestId, runId },
          },
        }),
        { safeStop: true },
      );
      if (!valid(version)) return;
      stopRequest.current = saved.request.body.arguments;
      store.assertOwned(saved);
      setStopping(true);
      setStopNotice("正在请求停止，等待本机确认。");
      const result = await call(saved.request.path, {
        method: saved.request.method,
        body: saved.request.body,
      });
      if (!valid(version)) return;
      if (result.result?.sealedLaunch?.runId === runId) {
        setStopNotice("已封存原总结启动，未派发到电脑。");
        setStopping(false);
        stopRequest.current = null;
        await store.resolve(saved.requestId, "sealed");
      } else setStopNotice("停止请求已保存，等待本机确认。");
      await reloadRef.current(true);
    } catch (err) {
      if (valid(version)) setActionError(err.message);
    } finally {
      inFlight.current = false;
      if (valid(version)) setBusy(false);
    }
  }, [scope, read, apply, call, valid, binding, stopStoreFor]);
  useEffect(() => {
    if (!readConfirmed || autoStarted.current) return;
    // A restored mount or an unknown request is never a new initialization.
    autoStarted.current = true;
    if (
      autoInitialize &&
      state?.status === "uninitialized" &&
      requests.durable &&
      !requests.ownedRecords.length
    )
      void operate("initialize");
  }, [
    readConfirmed,
    autoInitialize,
    state?.status,
    requests.durable,
    requests.ownedRecords.length,
    operate,
  ]);
  useEffect(() => {
    if (!pending(state) && !stopping) return;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading || inFlight.current) return;
      reading = true;
      try {
        await reloadRef.current(true);
      } finally {
        reading = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.status, stopping]);
  const unknown = requests.ownedRecords.length > 0;
  const blocked = unknown || !requests.durable || !readConfirmed;
  return (
    <>
      {(requests.warning || stopSnapshot.warning) && (
        <p role="alert" className="agent-error">
          {requests.warning || stopSnapshot.warning}
        </p>
      )}
      <UnknownWorkspaceRequests requests={requests} />
      <UnknownWorkspaceRequests requests={stopSnapshot} />
      {requests.ownedRecords.map((record) => (
        <div
          className="agent-note"
          key={record.requestId}
          aria-label="待核对总结操作"
        >
          <p>原总结操作的结果尚未确认，保留原请求等待核对。</p>
          <button disabled={busy} onClick={() => reload(true)}>
            核对原总结操作
          </button>
          <button disabled={busy} onClick={() => operate(null, {}, record)}>
            重试原总结操作
          </button>
        </div>
      ))}
      <ProjectSummaryCard
        {...{
          state,
          busy,
          reload: () => reload(true),
          openChat,
          stop,
          stopping,
          stopNotice,
        }}
        error={actionError || readError}
        blocked={blocked}
        unknown={unknown}
        refresh={() =>
          operate(
            state?.status === "uninitialized" ? "initialize" : "refresh",
            state?.status === "uninitialized"
              ? {}
              : {
                  expectedActiveRunId: state.activeRunId,
                  expectedSummaryRevision: state.summaryRevision,
                },
          )
        }
        usePrevious={() =>
          operate("use-previous", {
            expectedSummaryRevision: state.summaryRevision,
            expectedSourceRunId: state.sourceRunId,
            expectedActiveRunId: state.activeRunId,
          })
        }
      />
      {state?.pendingLaunch && !unknown && (
        <button disabled={busy} onClick={() => reload(false)}>
          恢复原总结启动
        </button>
      )}
      {(state?.recoveryRuns?.length > 0 ||
        state?.status === "reconciliation_required") && (
        <button onClick={() => setShowRecovery((v) => !v)}>
          查看总结执行记录
        </button>
      )}
      {showRecovery && (
        <ExecutionPanel
          key={scope}
          roomId={roomId}
          userId={userId}
          pages={[{ id: pageId, title: "当前项目" }]}
          initialPageId={pageId}
          initialRunId={
            state?.recoveryRuns?.[0]?.runId ?? state?.activeRunId ?? ""
          }
          recoveryOnly
          requestCloud={call}
          requestLocal={requestLocal}
        />
      )}
    </>
  );
}

function SummaryScope({
  roomId,
  userId,
  pageId,
  requestCloud,
  requestLocal,
  openChat,
  autoInitialize,
}) {
  const [binding, setBinding] = useState(undefined),
    [error, setError] = useState("");
  const active = useRef(false),
    requestVersion = useRef(0),
    selectedBinding = useRef(undefined);
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
    if (selectedBinding.current === undefined)
      selectedBinding.current = identity(next);
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
      {...{
        binding,
        userId,
        roomId,
        pageId,
        call,
        loadBinding,
        requestLocal,
        openChat,
      }}
      autoInitialize={
        autoInitialize && selectedBinding.current === identity(binding)
      }
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
  const [explicitSelection, setExplicitSelection] = useState(null);
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
              onChange={(event) => {
                setSelected(event.target.value);
                setExplicitSelection(
                  JSON.stringify([userId, roomId, event.target.value]),
                );
              }}
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
              autoInitialize={
                explicitSelection === JSON.stringify([userId, roomId, page.id])
              }
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
