import React, { useEffect, useRef, useState } from "react";

export async function localRequest(route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`/api/local-codex${route}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "x-qingdan-local": "1",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result)
      throw Error(
        result?.error || "尚未连接本机服务，请通过本机入口打开轻单。",
      );
    return result;
  } catch (error) {
    if (error.name === "AbortError")
      throw Error("本机连接超时。请刷新状态核对已提交的测试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const runNames = { summary: "项目总结", a: "任务 A", b: "任务 B" };
const statusNames = {
  running: "测试运行中",
  passed: "3 个独立会话验证通过",
  failed: "测试未通过",
  needs_review: "需要核对上次测试",
};

export default function CodexTrial({ request = localRequest }) {
  const [connection, setConnection] = useState(null);
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [history, setHistory] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const pendingId = useRef(null),
    locked = useRef(false),
    historyVersion = useRef(0),
    statusVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      timer;
    const poll = async () => {
      const version = statusVersion.current;
      try {
        const state = await request("/status");
        if (!stopped && version === statusVersion.current) {
          setCurrent(state.current);
          setStatusError("");
        }
      } catch (e) {
        if (!stopped && version === statusVersion.current) {
          setStatusError(e.message);
          setConnection(null);
        }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [request]);
  const action = async (work) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const connect = () =>
    action(async () => {
      setConnection(null);
      const next = await request("/connection");
      if (!mounted.current) return;
      setConnection(next);
      setProjectId(next.projects[0]?.workspaceId || "");
      setHistory(null);
      setHistoryBusy(false);
      historyVersion.current++;
    });
  const start = () =>
    action(async () => {
      statusVersion.current++;
      pendingId.current ||= crypto.randomUUID();
      const next = await request("/tests", {
        method: "POST",
        body: JSON.stringify({ requestId: pendingId.current }),
      }).finally(() => {
        statusVersion.current++;
      });
      if (mounted.current) setCurrent(next);
      pendingId.current = null;
    });
  const reconcile = () =>
    action(async () => {
      statusVersion.current++;
      const next = await request("/tests/reconcile", {
        method: "POST",
        body: JSON.stringify({ requestId: current.id }),
      }).finally(() => {
        statusVersion.current++;
      });
      if (mounted.current) setCurrent(next);
    });
  const project = connection?.projects.find((p) => p.workspaceId === projectId);
  const readHistory = async (thread) => {
    const version = ++historyVersion.current;
    setHistoryBusy(true);
    setHistory(null);
    setError("");
    try {
      const next = await request(
        `/thread?workspaceId=${encodeURIComponent(projectId)}&threadId=${encodeURIComponent(thread.threadId)}`,
      );
      if (mounted.current && version === historyVersion.current)
        setHistory(next);
    } catch (e) {
      if (mounted.current && version === historyVersion.current)
        setError(e.message);
    } finally {
      if (mounted.current && version === historyVersion.current)
        setHistoryBusy(false);
    }
  };
  return (
    <section className="agent-trial" aria-label="本机 Codex 验证">
      <div className="agent-intro">
        <h3>从轻单发起，回到轻单查看结果</h3>
        <p>
          查看本机已注册的项目和会话，再运行一次真实接入测试。测试会在独立目录依次新建总结、任务
          A、任务 B 三个会话。
        </p>
      </div>
      <div className="agent-connection">
        <span
          className={`agent-dot ${connection?.authenticated ? "connected" : ""}`}
        />
        <strong>
          {connection
            ? connection.authenticated
              ? "本机 Codex 已连接 · 已登录"
              : "本机 Codex 已连接 · 尚未登录"
            : "等待检查本机连接"}
        </strong>
        <button className="secondary" disabled={busy} onClick={connect}>
          检查连接
        </button>
      </div>
      {!connection && (
        <div className="agent-note agent-setup">
          在项目目录运行 <code>npm run dev:agent</code>，打开{" "}
          <a href="http://127.0.0.1:8790" target="_blank" rel="noreferrer">
            本机轻单
          </a>{" "}
          后登录。云端设备配对将在第 3 步接入。
        </div>
      )}
      {connection && !connection.authenticated && (
        <p className="agent-note">
          请在启动轻单的同一 Windows 账号下运行 <code>codex login</code>
          ，然后重新检查连接。
        </p>
      )}
      {(error || statusError) && (
        <p role="alert" className="agent-error">
          {statusError || error}
        </p>
      )}
      {connection && (
        <div className="agent-projects">
          <label>
            本机项目
            <select
              aria-label="本机项目"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setHistory(null);
                setHistoryBusy(false);
                historyVersion.current++;
              }}
            >
              {connection.projects.map((p) => (
                <option key={p.workspaceId} value={p.workspaceId}>
                  {p.root}
                </option>
              ))}
            </select>
          </label>
          <p className="agent-note">
            Codex {connection.version} ·
            只显示本机入口注册的项目。检查连接可刷新会话。
          </p>
          <details>
            <summary>查看项目会话（{project?.threads.length || 0}）</summary>
            <div className="agent-thread-list">
              {project?.threads.map((t) => (
                <button key={t.threadId} onClick={() => void readHistory(t)}>
                  {t.title || "未命名会话"}
                  <small>{t.threadId}</small>
                </button>
              ))}
              {!project?.threads.length && (
                <p className="agent-note">此项目暂无会话。</p>
              )}
            </div>
          </details>
          {historyBusy && <p role="status">正在读取会话…</p>}
          {history && (
            <div className="agent-history">
              <h4>{history.title || "会话内容"}</h4>
              {history.messages.map((m, i) => (
                <div key={i}>
                  <strong>{m.role === "user" ? "要求" : "Codex"}</strong>
                  <pre>{m.text}</pre>
                </div>
              ))}
              {!history.messages.length && <p>暂无文本消息。</p>}
            </div>
          )}
        </div>
      )}
      <div className="agent-test-box">
        <h4>三会话接入测试</h4>
        <ol>
          <li>总结：读取测试项目并返回项目进度。</li>
          <li>任务 A：创建测试文件，轻单核对内容。</li>
          <li>任务 B：读取 A 的文件，再生成新文件并核对。</li>
        </ol>
        <p className="agent-note">
          测试使用独立临时项目，通常需要几分钟；会使用当前 Codex
          账号的额度。关闭面板后仍可重新打开查看。
        </p>
        <div className="agent-actions">
          <button
            className="primary"
            disabled={
              busy ||
              !connection?.authenticated ||
              ["running", "needs_review"].includes(current?.status)
            }
            onClick={start}
          >
            运行三会话测试
          </button>
          {current?.status === "needs_review" && (
            <button
              className="secondary"
              disabled={busy || !connection?.authenticated}
              onClick={reconcile}
            >
              核对上次测试
            </button>
          )}
        </div>
      </div>
      {current && (
        <div className="agent-run-result">
          <h4 role="status">{statusNames[current.status]}</h4>
          <p className="agent-path">测试目录：{current.workspace}</p>
          {current.error && <p className="agent-error">{current.error}</p>}
          {current.status === "running" && (
            <p>
              正在处理：
              {runNames[current.progress?.at(-1)?.key] || "连接并准备测试目录"}…
            </p>
          )}
          {current.report?.runs?.map((run) => (
            <article className="agent-result-card" key={run.key}>
              <div className="agent-card-heading">
                <strong>{runNames[run.key]}</strong>
                <span>
                  {run.artifactVerified ? "文件内容已核对" : "总结已读取"}
                </span>
              </div>
              <p>{run.result?.overview || run.result?.summary}</p>
              <details>
                <summary>查看完整结果与会话编号</summary>
                <p className="agent-path">{run.threadId}</p>
                <pre>{JSON.stringify(run.result, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
