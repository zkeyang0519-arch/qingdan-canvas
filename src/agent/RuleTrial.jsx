import React, { useEffect, useState } from "react";
import {
  newDraftTask,
  exampleTasks,
  readDraft,
  checkDraft,
  copyPageTasks,
} from "./experience-model.js";

export default function RuleTrial({ storageKey, pages }) {
  const [tasks, setTasks] = useState(() => readDraft(storageKey));
  const [pageId, setPageId] = useState(pages[0]?.id || "");
  const [result, setResult] = useState(null);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, tasks }));
      setSaveError("");
    } catch {
      setSaveError("浏览器未能保存草稿，请保持页面打开。");
    }
  }, [tasks, storageKey]);
  const change = (next) => {
    setTasks(next);
    setResult(null);
  };
  const edit = (id, patch) =>
    change(tasks.map((t) => (t.taskId === id ? { ...t, ...patch } : t)));
  const move = (index, delta) => {
    const next = [...tasks];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    change(next);
  };
  const loadPage = () => {
    const next = copyPageTasks(pages.find((p) => p.id === pageId));
    if (next.length > 50) {
      setResult({
        error: "当前项目超过 50 条未完成任务，请先减少任务后复制。",
      });
      return;
    }
    change(next);
  };
  return (
    <section aria-label="任务规则验证" className="agent-trial">
      <div className="agent-intro">
        <h3>让任务知道先做什么、怎样算完成</h3>
        <p>
          依赖优先，其次按优先级、截止时间排序。可以先试示例，也可以复制清单中的未完成项，补充执行要求。
        </p>
      </div>
      <div className="agent-actions">
        <button className="secondary" onClick={() => change(exampleTasks())}>
          载入示例
        </button>
        <button
          className="secondary"
          disabled={tasks.length >= 50}
          onClick={() => change([...tasks, newDraftTask()])}
        >
          添加任务
        </button>
        {pages.length > 0 && (
          <>
            <select
              aria-label="复制来源项目"
              value={pageId}
              onChange={(e) => setPageId(e.target.value)}
            >
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={loadPage}>
              从清单复制未完成项
            </button>
          </>
        )}
      </div>
      <p className="agent-note">
        验证草稿 ·
        自动保存到此浏览器，仅当前账号和画布可见。正式清单的要求与顺序写回将在第
        5 步接入。
      </p>
      {saveError && (
        <p role="alert" className="agent-error">
          {saveError}
        </p>
      )}
      {!tasks.length && (
        <div className="agent-empty">
          还没有验证任务。点击“载入示例”开始体验。
        </div>
      )}
      <div className="agent-rule-list">
        {tasks.map((task, index) => (
          <article className="agent-rule-card" key={task.taskId}>
            <div className="agent-card-heading">
              <strong>任务 {index + 1}</strong>
              <div className="agent-actions">
                <button
                  aria-label={`上移任务 ${index + 1}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  上移
                </button>
                <button
                  aria-label={`下移任务 ${index + 1}`}
                  disabled={index === tasks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <button
                  aria-label={`删除任务 ${index + 1}`}
                  onClick={() =>
                    change(
                      tasks
                        .filter((t) => t.taskId !== task.taskId)
                        .map((t) => ({
                          ...t,
                          dependsOn: t.dependsOn.filter(
                            (id) => id !== task.taskId,
                          ),
                        })),
                    )
                  }
                >
                  删除
                </button>
              </div>
            </div>
            <label>
              做什么
              <input
                aria-label={`任务名称 ${index + 1}`}
                maxLength={32000}
                value={task.text}
                onChange={(e) => edit(task.taskId, { text: e.target.value })}
                placeholder="例如：生成本周项目报告"
              />
            </label>
            <div className="agent-field-grid">
              <label>
                执行要求
                <textarea
                  aria-label={`执行要求 ${index + 1}`}
                  maxLength={32000}
                  value={task.instruction}
                  onChange={(e) =>
                    edit(task.taskId, { instruction: e.target.value })
                  }
                  placeholder="告诉 Codex 怎样做"
                />
              </label>
              <label>
                怎样算完成
                <textarea
                  aria-label={`完成条件 ${index + 1}`}
                  maxLength={32000}
                  value={task.acceptanceText}
                  onChange={(e) =>
                    edit(task.taskId, { acceptanceText: e.target.value })
                  }
                  placeholder="每行一条可检查的条件"
                />
              </label>
            </div>
            <div className="agent-field-grid">
              <label>
                优先级
                <select
                  aria-label={`优先级 ${index + 1}`}
                  value={task.priority}
                  onChange={(e) =>
                    edit(task.taskId, { priority: Number(e.target.value) })
                  }
                >
                  <option value={0}>紧急</option>
                  <option value={1}>高</option>
                  <option value={2}>普通</option>
                  <option value={3}>低</option>
                </select>
              </label>
              <label>
                截止时间（此设备时区）
                <input
                  type="datetime-local"
                  aria-label={`截止时间 ${index + 1}`}
                  value={task.dueLocal}
                  onChange={(e) =>
                    edit(task.taskId, { dueLocal: e.target.value })
                  }
                />
              </label>
            </div>
            <fieldset>
              <legend>必须先完成</legend>
              {tasks.length === 1 && (
                <span className="agent-note">暂无其他任务</span>
              )}
              {tasks
                .filter((t) => t.taskId !== task.taskId)
                .map((other) => (
                  <label className="agent-dependency" key={other.taskId}>
                    <input
                      type="checkbox"
                      aria-label={`任务 ${index + 1} 依赖 ${other.text}`}
                      checked={task.dependsOn.includes(other.taskId)}
                      onChange={(e) =>
                        edit(task.taskId, {
                          dependsOn: e.target.checked
                            ? [...task.dependsOn, other.taskId]
                            : task.dependsOn.filter(
                                (id) => id !== other.taskId,
                              ),
                        })
                      }
                    />
                    {other.text || "未命名任务"}
                  </label>
                ))}
            </fieldset>
          </article>
        ))}
      </div>
      <div className="agent-actions agent-validation-actions">
        <button
          className="primary"
          onClick={() => setResult(checkDraft(tasks))}
        >
          校验并排序
        </button>
        <button
          className="secondary"
          onClick={() => setResult(checkDraft(tasks, true))}
        >
          校验当前顺序
        </button>
      </div>
      {result?.error && (
        <p className="agent-error" role="alert">
          {result.error}
        </p>
      )}
      {result?.order && (
        <div className="agent-success" role="status">
          <strong>校验通过 · 执行顺序预览</strong>
          <ol className="agent-order">
            {result.order.map((id) => (
              <li key={id}>{tasks.find((t) => t.taskId === id).text}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
