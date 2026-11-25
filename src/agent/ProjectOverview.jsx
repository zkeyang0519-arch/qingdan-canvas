import React, { useState } from "react";
import { Button } from "./ui/button.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import SummaryReadProgress from "./SummaryReadProgress.jsx";
import { moduleStatusLabels } from "../../shared/agent/progress";
import "./workspace-information.css";

function Items({ items }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>
          {typeof item === "string" ? item : item.text}
          {item.evidenceRef && (
            <details>
              <summary>依据</summary>
              <p>{item.evidenceRef}</p>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function ProjectOverview({
  state,
  busy,
  error,
  reload,
  refresh,
  stop,
  stopping,
  stopNotice,
  blocked,
  unknown,
  usePrevious,
  openChat,
  liveOutput,
  renderDetails,
}) {
  const [detail, setDetail] = useState(null);
  const working = [
    "queued",
    "running",
    "finalizing",
    "reconciliation_required",
  ].includes(state?.status);
  const summary = state?.summary;
  const sections = [
    ["inProgress", "当前进展"],
    ["pending", "下一步"],
    ["blockers", "阻碍"],
    ["uncertainties", "待核实"],
  ];
  return (
    <section className="qd-project-overview" aria-label="项目概览">
      <div className="qd-summary-toolbar">
        <small>
          {summary
            ? `第 ${state.summaryRevision} 版${state.capturedAt ? " · " + new Date(state.capturedAt).toLocaleString("zh-CN") : ""}`
            : "从项目记录整理当前进展"}
        </small>
        <div className="qd-summary-actions">
          <Button
            disabled={
              busy ||
              blocked ||
              !state ||
              (working && !state.canRefresh) ||
              stopping
            }
            onClick={refresh}
          >
            {summary ? "更新摘要" : "生成摘要"}
          </Button>
          {(working || unknown || stopping) && (
            <Button
              variant="outline"
              disabled={busy || stopping}
              onClick={stop}
            >
              {stopping ? "正在停止…" : "停止"}
            </Button>
          )}
        </div>
      </div>
      {(error || state?.error) && (
        <p className="agent-error" role="alert">
          {error || state.error}
          <button disabled={busy} onClick={reload}>
            重新读取状态
          </button>
        </p>
      )}
      {!state && <p role="status">正在读取项目资料…</p>}
      {(working || state?.stale || stopNotice) && (
        <div className="qd-summary-notice" role="status">
          {stopNotice ||
            (working
              ? {
                  queued: "等待项目空闲后整理；返回页面不会重复创建任务。",
                  running: "正在读取和整理项目记录，上次摘要仍可阅读。",
                  finalizing: "正在接收整理结果…",
                  reconciliation_required:
                    "原任务状态待核对，请检查进度或停止等待。",
                }[state.status]
              : "这份摘要需要更新，请留意来源与生成时间。")}
        </div>
      )}
      {summary ? (
        <>
          <div className="qd-summary-goal">
            <small>当前目标</small>
            {summary.background?.purpose && (
              <h3>{summary.background.purpose}</h3>
            )}
            <p>{summary.overview}</p>
            {summary.background?.stage && (
              <small>当前阶段：{summary.background.stage}</small>
            )}
          </div>
          {summary.modules?.length > 0 ? (
            <div className="qd-summary-modules">
              {summary.modules.map((module, i) => (
                <details key={i}>
                  <summary>
                    <strong>{module.name}</strong>
                    <span>
                      {moduleStatusLabels[module.status] || module.status}
                    </span>
                  </summary>
                  <div className="qd-summary-columns">
                    {[
                      ["current", "当前进展"],
                      ["remaining", "剩余工作"],
                      ["nextSteps", "下一步"],
                    ].map(([key, label]) =>
                      module[key]?.length ? (
                        <section className="qd-summary-section" key={key}>
                          <h4>{label}</h4>
                          <Items items={module[key]} />
                        </section>
                      ) : null,
                    )}
                  </div>
                </details>
              ))}
            </div>
          ) : null}
          <div className="qd-summary-columns">
            {sections.map(([key, label]) =>
              summary[key]?.length ? (
                <section className="qd-summary-section" key={key}>
                  <h4>{label}</h4>
                  <Items items={summary[key]} />
                </section>
              ) : null,
            )}
          </div>
          {summary.completed?.length > 0 && (
            <details className="qd-summary-log">
              <summary>已完成 · {summary.completed.length}</summary>
              <Items items={summary.completed} />
            </details>
          )}
          {summary.verification?.length > 0 && (
            <details className="qd-summary-log">
              <summary>
                {state.sourceKind === "codex_history"
                  ? "历史验证记录"
                  : "验证记录"}{" "}
                · {summary.verification.length}
              </summary>
              <Items items={summary.verification} />
            </details>
          )}
          {!state.ready && state.status === "failed" && (
            <Button
              variant="outline"
              disabled={busy || blocked || working}
              onClick={usePrevious}
            >
              使用上次摘要
            </Button>
          )}
        </>
      ) : state && !working ? (
        <p className="agent-note">
          还没有项目摘要。可以整理项目记录，也可以继续聊天，按需补充背景。
        </p>
      ) : null}
      <div className="qd-summary-links">
        <button onClick={() => setDetail("handoff")}>交接报告 →</button>
        <button onClick={() => setDetail("sources")}>来源与版本 →</button>
        <button onClick={() => setDetail("progress")}>生成记录 →</button>
        {openChat && <button onClick={openChat}>回到对话 →</button>}
      </div>
      {(working || liveOutput) && (
        <details className="qd-summary-log">
          <summary>查看读取进度与实时输出</summary>
          {state?.summaryProgress && (
            <SummaryReadProgress progress={state.summaryProgress} />
          )}
          {liveOutput}
          <button disabled={busy} onClick={reload}>
            检查进度
          </button>
        </details>
      )}
      {detail && (
        <WorkspaceDrawer
          title={
            detail === "sources"
              ? "来源与版本"
              : detail === "handoff"
                ? "项目交接报告"
                : "生成记录"
          }
          size="wide"
          onClose={() => setDetail(null)}
        >
          {renderDetails(detail)}
        </WorkspaceDrawer>
      )}
    </section>
  );
}
