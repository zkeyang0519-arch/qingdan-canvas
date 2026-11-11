import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { localRunnerRequest } from "./DevicePanel.jsx";
import { batchStatusLabel } from "./BatchPanel.jsx";
import { currentNativeRequests } from "./PermissionControls.jsx";

const timeLabel = (value) => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { hour12: false })
    : "尚未收到";
};
const runTitle = (run) =>
  run.batch?.items?.[0]?.text ||
  (run.kind === "summary" ? "项目摘要" : "项目执行");
function recoveryLabel(run) {
  if (run.status === "reconciliation_required") return "需要核对本机进度";
  const requests = currentNativeRequests(run);
  if (requests.some((request) => request.responseStatus === "queued"))
    return "回答已提交，等待电脑接收";
  if (requests.some((request) => request.kind === "approval"))
    return "等待你审批";
  if (requests.some((request) => request.kind === "input"))
    return "等待你补充信息";
  if (run.status === "cancel_requested") return "正在等待电脑确认停止";
  if (run.queue?.phase) return batchStatusLabel(run);
  return (
    {
      queued: "已提交，等待电脑接单",
      preparing: "正在准备",
      running: "正在执行",
      waiting_approval: "等待你审批",
      waiting_input: "等待你补充信息",
      verifying: "正在核对验收结果",
      completed: "已完成",
      cancelled: "已停止",
      failed: "执行失败",
    }[run.status] || "正在核对执行状态"
  );
}
function needsAttention(run) {
  return (
    run.status === "reconciliation_required" ||
    currentNativeRequests(run).length > 0 ||
    ["paused", "blocked", "waiting_human"].includes(run.queue?.phase) ||
    !(run.terminal && run.stopConfirmed)
  );
}

function DiagnosisScope({
  roomId,
  userId,
  page,
  requestLocal,
  requestCloud,
  onOpenRun,
  onOpenSetup,
}) {
  const [local, setLocal] = useState(null);
  const [diagnostics, setDiagnostics] = useState(null);
  const [history, setHistory] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const sequence = useRef(0);
  const working = useRef(false);
  const valid = useCallback(
    (version) => active.current && sequence.current === version,
    [],
  );
  const cloud = useCallback(
    (route) =>
      requestCloud(route, {
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const readHistory = useCallback(async () => {
    if (!page?.id) return { binding: null, runs: [] };
    const { binding } = await cloud(
      `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(page.id)}`,
    );
    if (!active.current || !binding?.enabled)
      return { binding: null, runs: [] };
    const result = await cloud(
      `/api/agent/execution/runs?bindingId=${encodeURIComponent(binding.bindingId)}`,
    );
    return {
      binding,
      runs: (result.runs || []).filter(
        (run) => run.bindingId === binding.bindingId,
      ),
    };
  }, [cloud, page?.id, roomId]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    setBusy(true);
    const results = await Promise.allSettled([
      requestLocal("/status", { accountId: userId }),
      requestLocal("/diagnostics", { accountId: userId }),
      readHistory(),
    ]);
    if (!valid(version)) return;
    const nextErrors = {};
    for (const [index, name, update] of [
      [0, "local", setLocal],
      [1, "diagnostics", setDiagnostics],
      [2, "history", setHistory],
    ]) {
      const result = results[index];
      update(result.status === "fulfilled" ? result.value : null);
      if (result.status === "rejected")
        nextErrors[name] = result.reason?.message || "检查失败，请稍后重试。";
    }
    setErrors(nextErrors);
    setBusy(false);
  }, [readHistory, requestLocal, userId, valid]);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, [refresh]);

  async function reconnect(resume) {
    if (working.current || busy) return;
    working.current = true;
    const version = ++sequence.current;
    setBusy(true);
    setMessage("");
    setErrors((previous) => ({ ...previous, action: "" }));
    let failure = "";
    try {
      await requestLocal(resume ? "/connection" : "/reconnect", {
        accountId: userId,
        method: "POST",
        body: resume ? { enabled: true } : {},
      });
      if (!valid(version)) return;
      setMessage("连接请求已发出。请根据检查结果查看原执行的进度。");
    } catch (error) {
      failure = error.message || "连接失败，请稍后重试。";
    } finally {
      if (valid(version)) {
        await refresh();
        if (active.current && failure)
          setErrors((previous) => ({ ...previous, action: failure }));
      }
      working.current = false;
    }
  }
  const connection = !local
    ? "unavailable"
    : !local.paired
      ? "unpaired"
      : local.enabled === false
        ? "disabled"
        : local.connectionStatus;
  const connectionText =
    {
      unavailable: "无法确认电脑状态",
      unpaired: "电脑尚未绑定",
      disabled: "电脑已暂时断开",
      online: "电脑在线",
      connecting: "正在连接电脑",
      offline: "电脑未连接",
      revoked: "电脑授权已撤销",
      error: "电脑连接异常",
    }[connection] || "无法确认电脑状态";
  const runs = [...(history?.runs || [])].sort(
    (a, b) => Number(needsAttention(b)) - Number(needsAttention(a)),
  );
  const canReconnect = !busy && local?.paired && connection !== "revoked";
  return (
    <div className="agent-trial agent-diagnosis-panel">
      <div className="agent-card-heading">
        <div>
          <h3>诊断与恢复</h3>
          <p className="agent-note">
            检查这台电脑，回到已有执行处理未完成的事项。
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            setMessage("");
            void refresh();
          }}
        >
          重新检查
        </button>
      </div>
      {busy && (
        <p className="agent-note" role="status">
          正在检查电脑与执行记录…
        </p>
      )}
      {errors.action && (
        <p className="agent-error" role="alert">
          {errors.action}
        </p>
      )}
      {message && (
        <p className="agent-note" role="status">
          {message}
        </p>
      )}
      <section className="agent-device-card" aria-label="电脑连接诊断">
        <div className="agent-card-heading">
          <h4>电脑连接</h4>
          <span
            className={`agent-device-badge ${connection === "online" ? "online" : ""}`}
          >
            <i
              className={`agent-dot ${connection === "online" ? "connected" : ""}`}
            />
            {connectionText}
          </span>
        </div>
        {local?.lastHeartbeatAt && (
          <p className="agent-note">
            最近收到电脑状态：{timeLabel(local.lastHeartbeatAt)}
          </p>
        )}
        {errors.local && (
          <p className="agent-error" role="alert">
            {errors.local}
          </p>
        )}
        {local?.error && (
          <p className="agent-error" role="alert">
            {local.error}
          </p>
        )}
        {(!local || connection === "unpaired" || connection === "revoked") && (
          <p className="agent-note">
            {!local
              ? "请先启动这台电脑上的轻单服务，再打开本机入口检查。"
              : "请在电脑与项目设置中完成绑定。"}
          </p>
        )}
        <div className="agent-actions">
          {connection === "disabled" && (
            <button disabled={!canReconnect} onClick={() => reconnect(true)}>
              继续连接
            </button>
          )}
          {local?.paired && (
            <button disabled={!canReconnect} onClick={() => reconnect(false)}>
              重新连接
            </button>
          )}
          {onOpenSetup && (
            <button disabled={busy} onClick={onOpenSetup}>
              电脑与项目设置
            </button>
          )}
          {!local && <a href="http://127.0.0.1:8790">打开本机入口</a>}
        </div>
        <p className="agent-note">
          重新连接后，请查看原执行的状态。这里不会另建任务或重复提交待办。
        </p>
      </section>
      <section className="agent-device-card" aria-label="安装检查">
        <h4>安装检查</h4>
        {errors.diagnostics && (
          <p className="agent-error" role="alert">
            安装检查未完成：{errors.diagnostics}
          </p>
        )}
        <dl className="agent-diagnostic-versions">
          <div>
            <dt>轻单本机服务</dt>
            <dd>{diagnostics?.service?.version || "尚未检测到"}</dd>
          </div>
          <div>
            <dt>Node.js</dt>
            <dd>{diagnostics?.service?.nodeVersion || "尚未检测到"}</dd>
          </div>
          <div>
            <dt>Codex</dt>
            <dd>{diagnostics?.codex?.version || "尚未检测到"}</dd>
          </div>
          <div>
            <dt>Codex 登录</dt>
            <dd>
              {diagnostics?.codex?.authenticated === true
                ? "已登录"
                : diagnostics?.codex?.authenticated === false
                  ? "尚未登录"
                  : "尚未确认"}
            </dd>
          </div>
        </dl>
        {diagnostics?.codex?.available === false && (
          <p className="agent-error" role="alert">
            Codex 暂不可用
            {diagnostics.codex.error
              ? `：${diagnostics.codex.error}`
              : "，请检查安装和登录。"}
          </p>
        )}
        {diagnostics?.codex?.authenticated === false && (
          <p className="agent-note">
            请先完成本机 Codex 登录，再点击“重新检查”。
          </p>
        )}
        {diagnostics?.checkedAt && (
          <p className="agent-note">
            检查时间：{timeLabel(diagnostics.checkedAt)}
          </p>
        )}
        <details className="agent-diagnostic-help">
          <summary>如何启动本机服务</summary>
          <p>
            首次使用，在轻单项目目录运行{" "}
            <code>node scripts/agent-install.mjs install</code>，再运行{" "}
            <code>node scripts/agent-install.mjs start</code>
            。之后可以使用安装时生成的启动入口，打开{" "}
            <a href="http://127.0.0.1:8790">本机入口</a> 查看原执行。
          </p>
        </details>
      </section>
      <section className="agent-device-card" aria-label="执行恢复记录">
        <h4>当前项目的执行记录</h4>
        <p className="agent-note">
          {page?.title || "请先选择项目"} · 以下为最近收到的记录
          {connection !== "online"
            ? "；电脑未连接时，无法确认最新进度。"
            : "。"}
        </p>
        {errors.history && (
          <p className="agent-error" role="alert">
            执行记录检查失败：{errors.history}
          </p>
        )}
        {history && !history.binding && (
          <p className="agent-note">
            此项目尚未关联执行目录，请先在电脑与项目设置中完成关联。
          </p>
        )}
        {history?.binding && !runs.length && (
          <p className="agent-note">当前项目还没有执行记录。</p>
        )}
        {runs.length > 0 && (
          <ol className="agent-recovery-runs">
            {runs.map((run) => (
              <li key={run.runId}>
                <strong>{runTitle(run)}</strong>
                <span className="agent-recovery-state">
                  {recoveryLabel(run)}
                </span>
                <p className="agent-note">
                  最近更新：{timeLabel(run.updatedAt || run.createdAt)}
                </p>
                {run.status === "reconciliation_required" && (
                  <p className="agent-note">
                    上一次执行是否结束还未确认。请查看这次执行核对结果，避免再次提交同一待办。
                  </p>
                )}
                {run.error && <p className="agent-error">{run.error}</p>}
                <div className="agent-actions">
                  {run.sourceBacked && run.kind !== "summary" && onOpenRun && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        onOpenRun({
                          sectionId: page.id,
                          bindingId: history.binding.bindingId,
                          bindingRevision: history.binding.revision,
                          runId: run.runId,
                        })
                      }
                    >
                      查看这次执行
                    </button>
                  )}
                  {run.threadId && (
                    <a
                      href={`codex://threads/${encodeURIComponent(run.threadId)}`}
                    >
                      在 Codex 中查看
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export default function DiagnosisPanel(props) {
  return (
    <DiagnosisScope
      key={JSON.stringify([props.userId, props.roomId, props.page?.id])}
      requestCloud={api}
      requestLocal={localRunnerRequest}
      {...props}
    />
  );
}
