import React, { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronDown } from "lucide-react";
import { Modal } from "./Panels.jsx";
import {
  nextDeadlineTick,
  parseDeadlineInput,
  validDeadline,
} from "../../shared/deadline.js";
import {
  deadlineSelection,
  deadlineMonthDays,
  updateDeadlineSelection,
  deadlineSelectionValue,
} from "./deadlineInput.js";
import "./taskDeadline.css";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const formatDeadline = (value) =>
  validDeadline(value) ? dateFormat.format(new Date(value)) : "";

export function useDeadlineClock(objects) {
  const deadlines = useMemo(
    () =>
      objects.flatMap((object) =>
        object.type === "note"
          ? object.blocks
              .filter((block) => !block.done && validDeadline(block.dueAt))
              .map((block) => Date.parse(block.dueAt))
          : [],
      ),
    [objects],
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (deadlines.length && !document.hidden)
        timer = setTimeout(refresh, nextDeadlineTick(deadlines, current));
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [deadlines]);
  return now;
}

export function TaskDeadlineButton({ info, dueAt, text, disabled, onClick }) {
  const hasDeadline = info.status !== "none";
  const description = hasDeadline
    ? `${info.relative}，截止 ${formatDeadline(dueAt)}`
    : "设置截止时间";
  return (
    <button
      type="button"
      className={`todo-deadline-button ${hasDeadline ? "has-deadline" : ""}`}
      aria-label={`${hasDeadline ? "修改" : "设置"}截止时间：${text || "空白待办"}；${description}`}
      title={hasDeadline ? `${description}；点击修改或移除` : "设置截止时间"}
      disabled={disabled}
      onClick={onClick}
    >
      {hasDeadline ? (
        <>
          <svg
            className="todo-deadline-ring"
            viewBox="0 0 40 40"
            aria-hidden="true"
          >
            <circle className="todo-deadline-track" cx="20" cy="20" r="17" />
            <circle
              className="todo-deadline-arc"
              cx="20"
              cy="20"
              r="17"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={
                info.status === "late" ? 0 : 100 * (1 - info.ratio)
              }
            />
          </svg>
          <span className="todo-deadline-value">
            {info.status === "done" ? <Check size={15} /> : info.compact}
          </span>
        </>
      ) : (
        <CalendarClock size={17} />
      )}
    </button>
  );
}

export function TaskDeadlineDialog({ task, disabled, onClose, onSave }) {
  const [parts, setParts] = useState(() => deadlineSelection(task.dueAt));
  const [error, setError] = useState("");
  const numbers = (start, count) =>
    Array.from({ length: count }, (_, index) => start + index);
  const currentYear = new Date().getFullYear();
  const years = [...new Set([...numbers(currentYear - 5, 16), parts.year])]
    .filter((year) => year >= 1 && year <= 9999)
    .sort((a, b) => a - b);
  const fields = [
    { key: "year", label: "年", name: "截止年份", options: years },
    { key: "month", label: "月", name: "截止月份", options: numbers(1, 12) },
    {
      key: "day",
      label: "日",
      name: "截止日期",
      options: numbers(1, deadlineMonthDays(parts)),
    },
    { key: "hour", label: "时", name: "截止小时", options: numbers(0, 24) },
    { key: "minute", label: "分", name: "截止分钟", options: numbers(0, 60) },
  ];
  const save = (dueAt) => {
    const message = onSave(dueAt);
    if (message) setError(message);
  };
  return (
    <Modal
      title="待办截止时间"
      onClose={onClose}
      className="task-deadline-dialog"
    >
      <p className="task-deadline-title">{task.title || "空白待办"}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          try {
            save(parseDeadlineInput(deadlineSelectionValue(parts)));
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        <fieldset className="task-deadline-fields">
          <legend>截止日期和时间</legend>
          <div className="task-deadline-selects">
            {fields.map((field) => (
              <label
                key={field.key}
                className={`task-deadline-field ${field.key === "hour" || field.key === "minute" ? "is-time" : ""}`}
              >
                <span>{field.label}</span>
                <span className="task-deadline-select-wrap">
                  <select
                    className="text-field"
                    aria-label={field.name}
                    value={parts[field.key]}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value;
                      setParts((previous) =>
                        updateDeadlineSelection(previous, field.key, value),
                      );
                      setError("");
                    }}
                  >
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {String(option).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="task-deadline-hint">
          按本机时区设置；提前 24 小时开始提醒。
        </p>
        {disabled && (
          <p role="status" className="task-deadline-error">
            这条待办当前无法编辑，可能已被锁定、收纳或删除。
          </p>
        )}
        {error && (
          <p role="alert" className="task-deadline-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {task.dueAt && (
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={() => save(null)}
            >
              移除截止时间
            </button>
          )}
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={disabled}>
            保存截止时间
          </button>
        </div>
      </form>
    </Modal>
  );
}
