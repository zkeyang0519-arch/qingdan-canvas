import UnknownWorkspaceRequests from "./UnknownWorkspaceRequests.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";
import {
  useWorkspaceDraft,
  useWorkspaceRequests,
  workspaceScope,
} from "./workspace-state.js";
import {
  currentNativeRequests,
  NativeRequestPrompt,
  permissionLabel,
} from "./PermissionControls.jsx";

const base = "/api/agent/execution";
const bindingKey = (binding) =>
  binding &&
  JSON.stringify([
    binding.bindingId,
    binding.revision,
    binding.runnerId,
    binding.workspaceId,
  ]);
const phaseText = {
  running: "正在按顺序执行",
  pause_requested: "将在当前项完成后暂停",
  verifying: "正在核对本项验收条件",
  waiting_human: "本项等待你确认验收",
  finalizing: "正在更新清单",
  paused: "已暂停，后续待办尚未开始",
  blocked: "当前项需要处理",
  completed: "本批次已全部完成",
  cancel_requested: "正在等待本机确认停止",
  cancelled: "本批次已停止",
};
const statusText = {
  queued: "已排队，等待电脑接单",
  preparing: "正在准备",
  running: "正在执行",
  waiting_approval: "等待审批",
  waiting_input: "等待补充信息",
  failed: "执行失败",
  reconciliation_required: "需要核对本机进度",
};
const itemText = {
  pending: "待执行",
  running: "执行中",
  done: "已通过验收",
  blocked: "需要处理",
  needs_input: "需要补充信息",
  failed: "执行未通过",
  cancelled: "未继续执行",
};
const writebackText = {
  pending: "待更新清单",
  applied: "已更新清单",
  conflict: "待办已变化，请核对清单",
  failed: "清单更新失败，需核对",
  disabled: "按提交时的选择保留清单状态",
};
const isBatch = (run) =>
  (run?.sourceBacked || run?.executionSettings) && run.kind !== "summary";
export const executionIsActive = (run) =>
  !!run &&
  (!(run.terminal && run.stopConfirmed) ||
    (run.queue?.managed &&
      !["completed", "cancelled"].includes(run.queue.phase)));
const observedPhase = (run) =>
  run.queue?.phase === "cancelled" && !(run.terminal && run.stopConfirmed)
    ? "cancel_requested"
    : run.queue?.phase;
export function batchStatusLabel(run) {
  const phase = observedPhase(run);
  if (phase === "cancel_requested") return phaseText[phase];
  if (run.status === "waiting_approval" && !run.terminal)
    return "等待 Codex 审批";
  if (run.status === "waiting_input" && !run.terminal)
    return "等待 Codex 交互输入";
  return phaseText[phase] || statusText[run.status] || "正在核对批次状态";
}
export function batchItemLabel(run, item, index) {
  const queue = run.queue;
  if (item.status === "done") {
    if (
      queue?.managed &&
      (["completed", "paused"].includes(queue.phase) ||
        index < queue.currentIndex ||
        item.writeback?.status === "applied")
    )
      return "已通过验收";
    if (queue?.phase === "waiting_human") return "待人工验收";
    if (queue?.phase === "finalizing") return "验收通过，待更新清单";
    return "执行已结束，待核对";
  }
  if (observedPhase(run) === "cancelled") return "未继续执行";
  return itemText[item.status] || item.status;
}

function BatchRun({
  run,
  events,
  busy,
  stopping,
  confirmingStop,
  setConfirmingStop,
  control,
  stop,
  followup,
  setFollowup,
  sendFollowup,
}) {
  const queue = run.queue?.managed ? run.queue : null;
  const completed = queue?.phase === "completed";
  const cancelled =
    queue?.phase === "cancelled" && run.terminal && run.stopConfirmed;
  const stopPending =
    !completed &&
    !cancelled &&
    (stopping ||
      ["cancel_requested", "cancelled"].includes(queue?.phase) ||
      run.status === "cancel_requested");
  const phase = stopPending ? "cancel_requested" : queue?.phase;
  const waitingApproval = run.status === "waiting_approval" && !run.terminal;
  const waitingInput = run.status === "waiting_input" && !run.terminal;
  const pausedRecovery =
    queue?.phase === "paused" && run.status === "reconciliation_required";
  const canFollow =
    queue?.phase === "blocked" &&
    run.terminal &&
    run.stopConfirmed &&
    run.turnId &&
    !stopPending &&
    !waitingApproval;
  const canStop =
    !completed && !cancelled && !stopPending && (queue || !run.terminal);
  const current = queue?.currentIndex ?? run.batch?.currentIndex ?? 0;
  const output = events
    .filter((event) => event.type === "output.delta")
    .map((event) => event.payload?.text || "")
    .join("")
    .slice(-150000);
  return (
    <div className="agent-execution-run agent-managed-batch">
      <div className="agent-card-heading">
        <strong role="status">
          {waitingApproval
            ? "等待 Codex 审批"
            : waitingInput
              ? "等待 Codex 交互输入"
              : phaseText[phase] ||
                statusText[run.status] ||
                "正在核对批次状态"}
        </strong>
        {run.threadId && (
          <a
            className="agent-codex-link"
            href={`codex://threads/${encodeURIComponent(run.threadId)}`}
          >
            在 Codex 中查看
          </a>
        )}
      </div>
      {!queue && (
        <p className="agent-note">
          此批次没有逐项控制记录，可以查看已有执行结果。
        </p>
      )}
      {queue?.reason && <p className="agent-batch-reason">{queue.reason}</p>}
      {run.error && <p className="agent-error">{run.error}</p>}
      {waitingApproval && (
        <p className="agent-note">
          {currentNativeRequests(run).length
            ? "请在审批弹窗中处理当前请求；未回答前会保持等待。"
            : "正在核对当前审批请求；尚未取得可回答的请求时，可以刷新或停止本批次。"}
        </p>
      )}
      {waitingInput && (
        <p className="agent-note">
          {currentNativeRequests(run).length
            ? "请在提问弹窗中补充信息，回答会传回当前执行。"
            : "正在核对当前交互问题；普通补充说明不会代替工具提问。"}
        </p>
      )}
      <div className="agent-actions">
        {queue &&
          ["running", "verifying"].includes(queue.phase) &&
          !queue.pauseRequested &&
          !stopPending && (
            <button disabled={busy} onClick={() => control("pause")}>
              当前项完成后暂停
            </button>
          )}
        {queue?.phase === "paused" &&
          queue.canResume &&
          !pausedRecovery &&
          !stopPending && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => control("resume")}
            >
              继续批次
            </button>
          )}
        {pausedRecovery && !stopPending && (
          <button disabled={busy} onClick={() => control("recover")}>
            核对并恢复连接
          </button>
        )}
        {queue?.phase === "waiting_human" && !stopPending && (
          <button
            className="primary"
            disabled={busy || !(queue.turnId || run.turnId)}
            onClick={() => control("confirm")}
          >
            确认本项验收通过
          </button>
        )}
        {queue?.phase === "blocked" && !stopPending && (
          <button disabled={busy} onClick={() => control("recover")}>
            重新核对结果
          </button>
        )}
        {canStop && (
          <button disabled={busy} onClick={() => setConfirmingStop(true)}>
            立即停止
          </button>
        )}
      </div>
      {queue?.phase === "waiting_human" && (
        <p className="agent-note">
          请先核对本项完成标准与执行结果。确认通过后才会更新清单并继续后续待办。
        </p>
      )}
      {queue?.phase === "finalizing" && (
        <p className="agent-note">
          本项已执行，仍在等待清单更新结果；尚不能视为批次完成。
        </p>
      )}
      {confirmingStop && canStop && (
        <div
          className="agent-batch-stop-confirm"
          role="group"
          aria-label="确认停止批次"
        >
          <p>
            停止当前执行，并取消后续待办。已完成的项目结果会保留，尚未确认完成的待办不会被勾选。
          </p>
          <div className="agent-actions">
            <button disabled={busy} onClick={stop}>
              确认停止本批次
            </button>
            <button disabled={busy} onClick={() => setConfirmingStop(false)}>
              暂不停止
            </button>
          </div>
        </div>
      )}
      {run.batch && (
        <BatchItems
          run={run}
          completed={completed}
          cancelled={cancelled}
          current={current}
        />
      )}
      <details className="agent-batch-info">
        <summary>执行信息</summary>
        <p className="agent-note">
          本批次权限：{permissionLabel(run.executionPermissions?.profile)}
        </p>
        <p className="agent-note">
          本批次的待办在同一 Codex 会话中按顺序执行。
        </p>
      </details>
      {queue?.verification?.results?.length > 0 && (
        <details className="agent-batch-evidence">
          <summary>本项验收记录</summary>
          <ul>
            {queue.verification.results.map((result) => (
              <li key={result.criterionId}>
                <strong>
                  {{ passed: "通过", failed: "未通过", needs_input: "待确认" }[
                    result.status
                  ] || result.status}
                </strong>{" "}
                · {result.criterionId}
                {result.evidenceRefs?.length > 0 && (
                  <p>{result.evidenceRefs.join("；")}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canFollow && (
        <div className="agent-batch-followup">
          <label>
            补充本项要求
            <textarea
              aria-label="补充执行说明"
              rows={3}
              maxLength={32000}
              value={followup}
              disabled={busy}
              onChange={(event) => setFollowup(event.target.value)}
            />
          </label>
          <button disabled={busy || !followup.trim()} onClick={sendFollowup}>
            补充说明并继续当前项
          </button>
          <p className="agent-note">
            补充内容会发送到本批次的同一个会话，处理当前项后重新验收。
          </p>
        </div>
      )}
      <details>
        <summary>执行输出</summary>
        <pre className="agent-execution-output">
          {output || "等待本机回传输出…"}
        </pre>
      </details>
    </div>
  );
}

function BatchItems({ run, completed, cancelled, current }) {
  const ResultContainer = completed || cancelled ? "details" : "div";
  return (
    <ResultContainer className="agent-batch-results">
      {(completed || cancelled) && (
        <summary>查看 {run.batch.items.length} 项执行结果</summary>
      )}
      <section className="agent-batch-progress" aria-label="批次逐项进度">
        {!completed && !cancelled && (
          <h4>
            当前第 {Math.min(current + 1, run.batch.items.length)} 项 · 共{" "}
            {run.batch.items.length} 项
          </h4>
        )}
        <ol>
          {run.batch.items.map((item, index) => (
            <li
              key={item.taskId}
              aria-current={
                !completed && !cancelled && current === index
                  ? "step"
                  : undefined
              }
            >
              <div className="agent-batch-item-heading">
                <strong>{item.text}</strong>
                <span>{batchItemLabel(run, item, index)}</span>
              </div>
              {item.summary && <p>{item.summary}</p>}
              {item.writeback && (
                <p>
                  {writebackText[item.writeback.status]}
                  {item.writeback.message && ` · ${item.writeback.message}`}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </ResultContainer>
  );
}

export function BoundBatch({
  userId,
  roomId,
  binding,
  page,
  initialTarget,
  callCloud,
  loadBinding,
  onOpenChecklist,
  onSelectBatch,
  onRunChange,
  embedded,
  renderConversation,
  onExecutionChange,
}) {
  const targetMatches =
    !initialTarget ||
    (initialTarget.bindingId === binding.bindingId &&
      initialTarget.bindingRevision === binding.revision);
  const initialId = targetMatches ? initialTarget?.runId || "" : "";
  const [selectedId, setSelectedId] = useState(initialId);
  const [runs, setRuns] = useState([]);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    targetMatches ? "" : "项目关联已变化，请选择当前项目的批次。",
  );
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const scope = workspaceScope({
    accountId: userId,
    canvasId: roomId,
    sectionId: page.id,
    binding,
    runId: selectedId || null,
  });
  const [followup, setFollowup, draftStorage] = useWorkspaceDraft(
    `${scope}:followup`,
    "",
    !!selectedId,
  );
  const requests = useWorkspaceRequests(scope, { owner: "batch" });
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [responded, setResponded] = useState(new Map());
  const alive = useRef(false);
  const epoch = useRef(0);
  const working = useRef(false);
  const currentId = useRef(initialId);
  const receivedTarget = useRef(initialId);
  const priorDetail = useRef(null);
  const readSequence = useRef(0);
  const acceptedRead = useRef(0);
  const acceptedHistory = useRef(0);
  const settledRead = useRef(0);
  const valid = useCallback(
    (version) => alive.current && epoch.current === version,
    [],
  );
  const post = useCallback(
    (route, body) => callCloud(`${base}/${route}`, { method: "POST", body }),
    [callCloud],
  );
  const tool = useCallback(
    async (name, args) =>
      (
        await post("tools", {
          bindingId: binding.bindingId,
          name,
          arguments: args,
        })
      ).result,
    [binding.bindingId, post],
  );
  const readRun = useCallback(
    async (id, version, order = ++readSequence.current) => {
      let prior =
        priorDetail.current?.run?.runId === id ? priorDetail.current : null;
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const result = await tool("codex_get_run", {
          runId: id,
          afterSeq: prior?.nextAfterSeq || 0,
        });
        if (
          !valid(version) ||
          currentId.current !== id ||
          order < acceptedRead.current
        )
          return;
        if (
          !isBatch(result.run) ||
          result.run.runId !== id ||
          (result.run.bindingId && result.run.bindingId !== binding.bindingId)
        )
          throw Error("该记录不是当前清单的执行批次。");
        const observed = priorDetail.current?.run;
        if (
          observed?.runId === id &&
          ((Number.isFinite(observed.queue?.revision) &&
            result.run.queue?.revision < observed.queue.revision) ||
            (observed.updatedAt &&
              result.run.updatedAt &&
              result.run.updatedAt < observed.updatedAt))
        )
          return;
        const finalOnly =
          renderConversation &&
          result.run.terminal &&
          result.run.stopConfirmed &&
          (result.run.output?.trim() || result.run.resultReadComplete);
        const allEvents = finalOnly
          ? []
          : [
              ...new Map(
                [...(prior?.events || []), ...(result.events || [])].map(
                  (event) => [event.eventId, event],
                ),
              ).values(),
            ];
        const events = renderConversation ? allEvents : allEvents.slice(-300);
        prior = {
          ...result,
          events,
          truncated: prior?.truncated || result.truncated,
          // Events may arrive before the next turn's state report. Only skip
          // through this completed turn, never through a later turn's deltas.
          ...(finalOnly
            ? {
                nextAfterSeq: result.run.resultSeq ?? prior?.nextAfterSeq ?? 0,
                hasMore: false,
              }
            : {}),
        };
        priorDetail.current = prior;
        acceptedRead.current = order;
        setDetail(prior);
        setRuns((previous) =>
          previous.map((entry) => (entry.runId === id ? result.run : entry)),
        );
        if (!prior.hasMore) break;
      }
    },
    [binding.bindingId, tool, valid, !!renderConversation],
  );
  const refresh = useCallback(
    async (version) => {
      const order = ++readSequence.current;
      try {
        const latest = await loadBinding();
        if (!valid(version) || bindingKey(latest) !== bindingKey(binding))
          return;
        const history = await callCloud(
          `${base}/runs?bindingId=${encodeURIComponent(binding.bindingId)}`,
        );
        if (!valid(version)) return;
        const batches = (history.runs || []).filter(isBatch);
        if (order >= acceptedHistory.current && order >= acceptedRead.current) {
          acceptedHistory.current = order;
          setRuns(batches);
        }
        let id = currentId.current;
        const activeRun = renderConversation && batches.find(executionIsActive);
        const selectedRun = batches.find((entry) => entry.runId === id);
        if (
          activeRun &&
          activeRun.runId !== id &&
          (!selectedRun || !executionIsActive(selectedRun))
        ) {
          id = activeRun.runId;
          currentId.current = id;
          setSelectedId(id);
          priorDetail.current = null;
          setDetail(null);
          setStopping(false);
          setConfirmingStop(false);
        }
        if (!id && targetMatches && batches.length) {
          id = batches[0].runId;
          currentId.current = id;
          setSelectedId(id);
        }
        if (id) await readRun(id, version, order);
        if (valid(version) && order >= settledRead.current) {
          settledRead.current = order;
          setReadError("");
        }
      } catch (err) {
        if (valid(version) && order >= settledRead.current) {
          settledRead.current = order;
          setReadError(err.message);
        }
      }
    },
    [
      binding,
      callCloud,
      loadBinding,
      readRun,
      targetMatches,
      valid,
      !!renderConversation,
    ],
  );
  useEffect(() => {
    alive.current = true;
    let reading = false;
    const poll = async () => {
      if (working.current || (renderConversation && reading)) return;
      reading = true;
      try {
        await refresh(epoch.current);
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, renderConversation ? 700 : 2500);
    return () => {
      alive.current = false;
      epoch.current++;
      window.clearInterval(timer);
    };
  }, [refresh, valid, !!renderConversation]);
  useEffect(() => {
    if (busy || receivedTarget.current === initialId) return;
    receivedTarget.current = initialId;
    if (!targetMatches || !initialId || initialId === currentId.current) return;
    const version = ++epoch.current;
    currentId.current = initialId;
    setSelectedId(initialId);
    setDetail(null);
    priorDetail.current = null;
    setError("");
    setConfirmingStop(false);
    setStopping(false);
    void refresh(version);
  }, [initialId, targetMatches, refresh, valid, busy]);
  const observedCallback = useRef(onRunChange);
  observedCallback.current = onRunChange;
  const observedSignature = useRef(null);
  useEffect(() => {
    const run = detail?.run;
    const signature = JSON.stringify(
      run
        ? [
            run.runId,
            run.status,
            run.terminal,
            run.stopConfirmed,
            run.queue,
            run.pendingRequests?.map((item) => [item.requestId, item.status]),
            run.batch?.items?.map((item) => [
              item.taskId,
              item.status,
              item.writeback?.status,
            ]),
          ]
        : null,
    );
    if (signature === observedSignature.current) return;
    observedSignature.current = signature;
    observedCallback.current?.(run || null);
  }, [detail]);
  async function perform(operation) {
    if (working.current) return;
    working.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const latest = await loadBinding();
      if (!valid(version)) return;
      if (bindingKey(latest) !== bindingKey(binding))
        throw Error("项目关联已变化，请重新选择批次。");
      await operation(version);
    } catch (err) {
      if (valid(version)) setError(err.message);
    } finally {
      working.current = false;
      if (valid(version)) setBusy(false);
    }
  }
  async function sendRecord(record, version) {
    requests.assertOwned(record);
    try {
      const { path, method, body } = record.request;
      const response = await callCloud(path, { method, body });
      // A received ACK can settle its original scope even after navigation.
      // Failure to persist that fact retains the exact retry identity.
      await requests.resolve(record.requestId, "acknowledged").catch(() => {});
      return path === `${base}/tools` ? response.result : response;
    } catch (err) {
      if (err.status === 409) await refresh(version);
      throw err;
    }
  }
  async function sendStable(route, input, version) {
    const key = JSON.stringify([
      route,
      input.action || "",
      input.expectedRevision ?? null,
      input.pendingRequestId || "",
    ]);
    const record = await requests.prepare(
      key,
      (requestId) => ({
        path: `${base}/${["queue", "respond"].includes(route) ? route : "tools"}`,
        method: "POST",
        body: ["queue", "respond"].includes(route)
          ? { ...input, requestId }
          : {
              bindingId: binding.bindingId,
              name: route,
              arguments: { ...input, requestId },
            },
      }),
      { safeStop: route === "codex_cancel_run" },
    );
    if (!valid(version)) return;
    return sendRecord(record, version);
  }
  const retryOriginal = (record) =>
    perform(async (version) => {
      const body = record.request.body;
      const prepared = await requests.prepare(
        record.operationKey,
        () => record.request,
        { safeStop: body.name === "codex_cancel_run" },
      );
      if (!valid(version)) return;
      await sendRecord(prepared, version);
      if (!valid(version)) return;
      if (body.name === "codex_cancel_run") {
        setStopping(true);
        setConfirmingStop(false);
      }
      if (
        body.name === "codex_continue_run" &&
        followup.trim() === body.arguments.message
      )
        setFollowup("");
      setMessage("原操作已收到回执，正在核对当前执行。");
      await refresh(version);
    });
  const run =
    detail?.run ||
    (renderConversation
      ? runs.find((entry) => entry.runId === selectedId)
      : null);
  const queue = run?.queue;
  useEffect(() => {
    if (run)
      onSelectBatch?.({
        sectionId: page.id,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        runId: run.runId,
      });
  }, [run?.runId, binding.bindingId, binding.revision, page.id, onSelectBatch]);
  const nativeRequest = stopping ? null : currentNativeRequests(run)[0];
  const respond = (response) =>
    perform(async (version) => {
      if (!nativeRequest) return;
      const result = await sendStable(
        "respond",
        {
          bindingId: binding.bindingId,
          bindingRevision: binding.revision,
          runId: run.runId,
          expectedTurnId: nativeRequest.turnId,
          pendingRequestId: nativeRequest.requestId,
          response,
        },
        version,
      );
      if (!valid(version)) return;
      setResponded((previous) =>
        new Map(previous).set(nativeRequest.requestId, result.status),
      );
      setMessage(
        ["expired", "cancelled"].includes(result.status)
          ? "此请求已结束，正在刷新当前执行。"
          : "回答已提交。后续进度以下方批次状态为准。",
      );
      await refresh(version);
    });
  const control = (action) =>
    perform(async (version) => {
      if (!run || !queue?.managed) return;
      const result = await sendStable(
        "queue",
        {
          bindingId: binding.bindingId,
          bindingRevision: binding.revision,
          runId: run.runId,
          action,
          expectedRevision: queue.revision,
          ...(action === "confirm"
            ? { expectedTurnId: queue.turnId || run.turnId }
            : {}),
        },
        version,
      );
      if (!valid(version)) return;
      if (result.queue) {
        const next = {
          ...priorDetail.current,
          run: { ...run, queue: result.queue },
        };
        priorDetail.current = next;
        setDetail(next);
        setRuns((previous) =>
          previous.map((entry) =>
            entry.runId === run.runId ? next.run : entry,
          ),
        );
      }
      await refresh(version);
    });
  const stop = () =>
    perform(async (version) => {
      await sendStable("codex_cancel_run", { runId: run.runId }, version);
      if (!valid(version)) return;
      setConfirmingStop(false);
      setStopping(true);
      await refresh(version);
    });
  const sendFollowup = () =>
    perform(async (version) => {
      await sendStable(
        "codex_continue_run",
        {
          runId: run.runId,
          expectedTurnId: run.turnId,
          message: followup.trim(),
          mode: "reply",
        },
        version,
      );
      if (!valid(version)) return;
      setFollowup("");
      setMessage("补充说明已发送到原会话，等待本机接收。");
      await refresh(version);
    });
  const executionActions = useRef(null);
  executionActions.current = { stop };
  const executionCallback = useRef(onExecutionChange);
  executionCallback.current = onExecutionChange;
  const activeExecution = executionIsActive(run);
  const stopPending =
    activeExecution &&
    (stopping ||
      run.status === "cancel_requested" ||
      ["cancel_requested", "cancelled"].includes(queue?.phase));
  useEffect(() => {
    executionCallback.current?.({
      runId: run?.runId,
      active: activeExecution,
      stopping: stopPending,
      busy,
      stop: () => executionActions.current?.stop(),
    });
  }, [run?.runId, activeExecution, stopPending, busy]);
  useEffect(() => () => executionCallback.current?.(null), []);
  if (renderConversation)
    return renderConversation({
      runs,
      detail,
      busy,
      stopping: stopPending,
      control,
      notices: (
        <>
          {(requests.warning || error || readError) && (
            <p className="agent-error" role="alert">
              {requests.warning || error || readError}
            </p>
          )}
          <UnknownWorkspaceRequests requests={requests} />
          {requests.ownedRecords.map((record) => (
            <div key={record.requestId} className="agent-actions">
              <span className="agent-note">操作结果待确认</span>
              <button disabled={busy} onClick={() => perform(refresh)}>
                核对原操作
              </button>
              <button disabled={busy} onClick={() => retryOriginal(record)}>
                重试原操作
              </button>
            </div>
          ))}
          {nativeRequest && (
            <NativeRequestPrompt
              key={`${run.runId}:${nativeRequest.requestId}`}
              request={nativeRequest}
              busy={busy}
              delivered={responded.has(nativeRequest.requestId)}
              receiptStatus={responded.get(nativeRequest.requestId)}
              error={error}
              onRespond={respond}
            />
          )}
        </>
      ),
    });
  return (
    <>
      <div className="agent-batch-toolbar">
        {!embedded && onOpenChecklist && (
          <button disabled={busy} onClick={() => onOpenChecklist(page.id)}>
            打开真实清单
          </button>
        )}
        {runs.length > 0 && (
          <label>
            {!embedded && "查看批次"}
            <select
              aria-label="查看执行批次"
              value={selectedId}
              disabled={busy}
              onChange={(event) => {
                const id = event.target.value;
                currentId.current = id;
                setSelectedId(id);
                setDetail(null);
                priorDetail.current = null;
                setConfirmingStop(false);
                setStopping(false);
                void perform((version) => readRun(id, version));
              }}
            >
              {!selectedId && <option value="">请选择批次</option>}
              {selectedId &&
                !runs.some((entry) => entry.runId === selectedId) && (
                  <option value={selectedId}>刚提交的批次</option>
                )}
              {runs.map((entry) => (
                <option key={entry.runId} value={entry.runId}>
                  {entry.batch?.items[0]?.text || "执行批次"}
                  {entry.createdAt &&
                    ` · ${new Date(entry.createdAt).toLocaleString()}`}{" "}
                  ·{" "}
                  {phaseText[observedPhase(entry)] ||
                    statusText[entry.status] ||
                    "查看记录"}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          aria-label="刷新批次"
          title="刷新批次"
          disabled={busy}
          onClick={() => perform(refresh)}
        >
          {embedded ? <RefreshCw size={15} /> : "刷新批次"}
        </button>
      </div>
      {(draftStorage.warning || requests.warning) && (
        <p className="agent-error" role="alert">
          {requests.warning || draftStorage.warning}
        </p>
      )}
      <UnknownWorkspaceRequests requests={requests} />
      {requests.ownedRecords.length > 0 && (
        <section
          className="agent-pending-operations"
          aria-label="待核对的批次操作"
        >
          <p className="agent-note">
            有 {requests.ownedRecords.length}{" "}
            项操作尚未确认。重新打开页面不会自动重发，请先核对原执行。
          </p>
          {requests.ownedRecords.map((record) => (
            <div className="agent-actions" key={record.requestId}>
              <span>
                {record.request.body.name === "codex_continue_run"
                  ? "补充说明"
                  : record.request.body.name === "codex_cancel_run"
                    ? "停止执行"
                    : "批次操作"}
              </span>
              <button disabled={busy} onClick={() => perform(refresh)}>
                核对原操作
              </button>
              <button disabled={busy} onClick={() => retryOriginal(record)}>
                重试原操作
              </button>
            </div>
          ))}
        </section>
      )}
      {readError && (
        <p className="agent-error" role="alert">
          {readError}
        </p>
      )}
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="agent-note" role="status">
          {message}
        </p>
      )}
      {!run && (
        <p className="agent-note">
          {selectedId
            ? "正在读取批次…"
            : embedded
              ? "提交待办后，这里会显示逐项执行进度。"
              : "还没有选择执行批次。可以在第 5 步选择待办并提交。"}
        </p>
      )}
      {run && (
        <BatchRun
          {...{
            run,
            events: detail.events,
            busy,
            stopping,
            confirmingStop,
            setConfirmingStop,
            control,
            stop,
            followup,
            setFollowup,
            sendFollowup,
          }}
        />
      )}
      {nativeRequest && (
        <NativeRequestPrompt
          key={`${run.runId}:${nativeRequest.requestId}`}
          request={nativeRequest}
          busy={busy}
          delivered={responded.has(nativeRequest.requestId)}
          receiptStatus={responded.get(nativeRequest.requestId)}
          error={error}
          onRespond={respond}
        />
      )}
    </>
  );
}

function BatchSection({
  roomId,
  userId,
  page,
  initialTarget,
  requestCloud,
  onOpenChecklist,
  onSelectBatch,
  onRunChange,
  embedded,
  onOpenSettings,
}) {
  const [binding, setBinding] = useState(undefined);
  const [error, setError] = useState("");
  const active = useRef(false);
  const sequence = useRef(0);
  const acceptedBinding = useRef(0);
  const callCloud = useCallback(
    (route, options) =>
      requestCloud(route, {
        ...options,
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const loadBinding = useCallback(async () => {
    const version = ++sequence.current;
    const result = await callCloud(
      `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(page.id)}`,
    );
    if (!active.current || version < acceptedBinding.current) return null;
    acceptedBinding.current = version;
    const next = result.binding?.enabled ? result.binding : null;
    setBinding((prior) =>
      bindingKey(prior) === bindingKey(next) ? prior : next,
    );
    return next;
  }, [callCloud, roomId, page.id]);
  useEffect(() => {
    active.current = true;
    void loadBinding().catch((err) => {
      if (active.current) setError(err.message);
    });
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, [loadBinding]);
  if (!binding)
    return (
      <>
        {error ? (
          <p className="agent-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="agent-note">
            {binding === undefined
              ? "正在读取项目关联…"
              : embedded
                ? "关联执行项目后，可以查看批次进度。"
                : "此清单尚未关联执行项目。请先在第 3 步绑定电脑和项目。"}
          </p>
        )}
        {embedded && binding === null && onOpenSettings && (
          <button onClick={onOpenSettings}>选择项目</button>
        )}
        {(error || binding === null) && (
          <button
            onClick={() => {
              setError("");
              void loadBinding().catch((err) => {
                if (active.current) setError(err.message);
              });
            }}
          >
            刷新项目关联
          </button>
        )}
      </>
    );
  return (
    <BoundBatch
      key={bindingKey(binding)}
      {...{
        userId,
        roomId,
        binding,
        page,
        initialTarget,
        callCloud,
        loadBinding,
        onOpenChecklist,
        onSelectBatch,
        onRunChange,
        embedded,
      }}
    />
  );
}

export default function BatchPanel({
  roomId,
  userId,
  pages = [],
  initialTarget,
  initialPageId = "",
  requestCloud = api,
  onOpenChecklist,
  onSelectBatch,
  onRunChange,
  embedded = false,
  onOpenSettings,
}) {
  const [sectionId, setSectionId] = useState(
    initialTarget?.sectionId || initialPageId,
  );
  const page = pages.find((item) => item.id === sectionId) || pages[0];
  return (
    <div
      className={`agent-trial agent-execution-panel agent-batch-panel${embedded ? " is-embedded" : ""}`}
    >
      {!embedded && (
        <div className="agent-intro">
          <h3>批次执行</h3>
        </div>
      )}
      <section className="agent-device-card" aria-label="批次执行项目">
        {page ? (
          <>
            {!embedded && (
              <label>
                项目清单
                <select
                  aria-label="批次项目清单"
                  value={page.id}
                  onChange={(event) => setSectionId(event.target.value)}
                >
                  {pages.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title || "未命名清单"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <BatchSection
              key={JSON.stringify([userId, roomId, page.id])}
              {...{
                roomId,
                userId,
                page,
                requestCloud,
                onOpenChecklist,
                onSelectBatch,
                onRunChange,
                embedded,
                onOpenSettings,
              }}
              initialTarget={
                initialTarget?.sectionId === page.id ? initialTarget : undefined
              }
            />
          </>
        ) : (
          <p className="agent-note">此画布还没有清单。</p>
        )}
      </section>
    </div>
  );
}
