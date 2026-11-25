import React, { useState } from "react";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import { Button } from "./ui/button.jsx";
import "./retention.css";

const statusText = {
  queued: "等待整理",
  reviewing: "正在整理",
  awaiting_commit: "等待当前任务结束后保存",
  retained: "已沉淀",
  suggested: "有待查看的建议",
  skipped: "没有新增内容",
  failed: "复盘未完成",
};
function Candidate({ item, job, index, busy, onAction }) {
  const [draft, setDraft] = useState({
    scope: item.scope,
    key: item.key,
    value: item.value,
  });
  const suggested = ["suggested", "conflict"].includes(item.status);
  return (
    <section className="qd-retention-candidate">
      <small>
        {item.kind === "method"
          ? "操作经验"
          : item.scope === "personal"
            ? "个人偏好"
            : "项目约定"}{" "}
        ·{" "}
        {
          {
            saved: "已保存",
            merged: "已合并到现有记录",
            ignored: "已忽略或撤销",
            deleted: "已删除",
            changed: "原记录已修改",
            conflict: "与已有记录存在差异",
            suggested: "建议 · 尚未生效",
          }[item.status]
        }
      </small>
      {suggested ? (
        <>
          <label>
            名称
            <input
              value={draft.key}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              disabled={busy}
            />
          </label>
          <label>
            建议内容
            <textarea
              rows={3}
              value={draft.value}
              maxLength={1000}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              disabled={busy}
            />
          </label>
          <label>
            保存到
            <select
              value={draft.scope}
              onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
              disabled={busy}
            >
              <option value="project">当前项目约定</option>
              <option value="personal">个人偏好 · 所有项目</option>
            </select>
          </label>
        </>
      ) : (
        <>
          <h4>{item.key}</h4>
          <p>{item.value}</p>
        </>
      )}
      <details>
        <summary>适用条件与来源</summary>
        <p>{item.whenApplicable}</p>
        <p>来源任务：{job.goal}</p>
        {item.evidence?.map((e) => (
          <p key={e.id}>
            {e.label} · {e.ok ? "有成功回执" : "未验证"}
          </p>
        ))}
        {item.userQuote && <blockquote>{item.userQuote}</blockquote>}
      </details>
      <div className="agent-actions">
        {suggested && (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                onAction({ action: "ignore", jobId: job.id, index })
              }
            >
              忽略
            </Button>
            <Button
              disabled={
                busy ||
                !draft.key.trim() ||
                !draft.value.trim() ||
                item.status === "conflict"
              }
              onClick={() =>
                onAction({ action: "adopt", jobId: job.id, index, ...draft })
              }
            >
              保存这条建议
            </Button>
          </>
        )}
        {item.status === "conflict" && (
          <p className="agent-note">
            请在约定与经验中查看并编辑原条目，原内容不会被自动覆盖。
          </p>
        )}
        {item.status === "saved" && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onAction({ action: "undo", jobId: job.id, index })}
          >
            撤销保存
          </Button>
        )}
      </div>
    </section>
  );
}

export default function RetentionPanel({
  data,
  preferences = false,
  busy,
  error,
  onAction,
  taskId,
  taskIds = [],
  sourceJobId,
}) {
  const [open, setOpen] = useState(false);
  const jobs = data?.jobs || [];
  const current = jobs.find(
    (job) =>
      (taskId && job.taskId === taskId) ||
      taskIds.includes(job.taskId) ||
      (sourceJobId && job.sourceJobId === sourceJobId),
  );
  const saved =
    current?.candidates.filter((c) => c.status === "saved").length || 0;
  const suggestions =
    current?.candidates.filter((c) =>
      ["suggested", "conflict"].includes(c.status),
    ).length || 0;
  const visible =
    current &&
    (saved ||
      suggestions ||
      ["queued", "reviewing", "awaiting_commit"].includes(current.status));
  if (!preferences && !visible && !open) return null;
  const mode = data?.settings?.mode || "auto";
  return (
    <>
      {preferences ? (
        <section className="qd-retention-settings" aria-label="任务后沉淀设置">
          <div>
            <strong>任务后沉淀</strong>
            <p>任务完成后，整理值得复用的操作和习惯。</p>
          </div>
          <select
            aria-label="任务后沉淀策略"
            value={mode}
            disabled={busy || !data?.settings}
            onChange={(e) =>
              onAction({
                action: "settings",
                mode: e.target.value,
                expectedRevision: data.settings.revision,
              })
            }
          >
            <option value="auto">自动整理</option>
            <option value="suggest">仅生成建议</option>
            <option value="off">关闭</option>
          </select>
          <p>
            {mode === "auto"
              ? "明确的长期要求与已验证方法可保存；推测出的习惯留作建议。"
              : mode === "suggest"
                ? "所有提炼结果先生成建议，保存后才用于后续任务。"
                : "之后结束的任务不再发起复盘，已有记录仍可管理。"}
          </p>
          <button className="qd-retention-link" onClick={() => setOpen(true)}>
            查看最近沉淀 →
          </button>
          {error && (
            <p role="alert" className="agent-error">
              {error}
            </p>
          )}
        </section>
      ) : (
        <div className="qd-retention-receipt" role="status">
          <span>
            {saved
              ? `已沉淀 ${saved} 条内容`
              : suggestions
                ? `${suggestions} 条习惯或方法建议`
                : statusText[current.status]}
          </span>
          <button className="qd-retention-link" onClick={() => setOpen(true)}>
            查看沉淀 →
          </button>
        </div>
      )}
      {open && (
        <WorkspaceDrawer
          title="任务后沉淀"
          description="保留适用条件与来源，可编辑、忽略或撤销。"
          onClose={() => setOpen(false)}
        >
          {error && (
            <p role="alert" className="agent-error">
              {error}
            </p>
          )}
          {!jobs.length && (
            <p className="agent-note">当前项目还没有任务复盘记录。</p>
          )}
          {jobs.map((job) => (
            <details
              className="qd-retention-job"
              key={job.id}
              open={job.id === current?.id || jobs.length === 1}
            >
              <summary>
                <strong>{job.goal}</strong>
                <small>{statusText[job.status]}</small>
              </summary>
              {job.error && (
                <p role="status" className="agent-note">
                  {job.error}
                </p>
              )}
              {job.status === "failed" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => onAction({ action: "retry", jobId: job.id })}
                >
                  重试复盘
                </Button>
              )}
              {job.candidates.map((item, index) => (
                <Candidate
                  key={index + ":" + item.status}
                  {...{ item, job, index, busy, onAction }}
                />
              ))}
            </details>
          ))}
        </WorkspaceDrawer>
      )}
    </>
  );
}
