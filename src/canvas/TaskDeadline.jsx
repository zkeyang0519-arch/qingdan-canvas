import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, X } from "lucide-react";
import { Modal } from "./Panels.jsx";
import {
  nextDeadlineTick,
  parseDeadlineInput,
  validDeadline,
} from "../../shared/deadline.js";
import {
  deadlineSelection,
  deadlineWheelFields,
  updateDeadlineSelection,
  deadlineSelectionValue,
  wheelStepValue,
  wheelDeltaSteps,
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

const WHEEL_ITEM_HEIGHT = 46;
const WHEEL_CYCLES = 7;
// Low-sensitivity wheel profile: about three standard mouse-wheel notches are
// needed before a column advances by one value.
const WHEEL_DELTA_PER_STEP = 360;
const WHEEL_LINE_DELTA = 40;
const WHEEL_REMAINDER_RATIO = 0.8;
const WHEEL_THROTTLE = 2000;
const WHEEL_DEBOUNCE = 180;
const WHEEL_MAX_STEPS_PER_EVENT = 1;

function wheelOptionLabel(field, value) {
  if (field.isOptionEnabled && !field.isOptionEnabled(value)) return "";
  return field.format
    ? field.format(value)
    : String(value).padStart(field.key === "year" ? 4 : 2, "0");
}

function WheelColumn({ field, value, disabled, onChange }) {
  const viewport = useRef(null);
  const loop = Boolean(field.loop);
  const cycleLength = field.options.length;
  const middleCycle = loop ? Math.floor(WHEEL_CYCLES / 2) : 0;
  const valueIndex = Math.max(0, field.options.indexOf(value));
  const initialPosition = middleCycle * cycleLength + valueIndex;
  const [position, setPosition] = useState(initialPosition);
  const positionRef = useRef(initialPosition);
  const wheelRef = useRef({
    endTimer: null,
    lastMove: 0,
    remainder: 0,
    pending: 0,
    timer: null,
  });

  const cycleIndex = (index) =>
    ((index % cycleLength) + cycleLength) % cycleLength;
  const normalizePosition = (index) => {
    if (!loop) return Math.min(cycleLength - 1, Math.max(0, index));
    const cycle = Math.floor(index / cycleLength);
    if (cycle <= 0 || cycle >= WHEEL_CYCLES - 1)
      return middleCycle * cycleLength + cycleIndex(index);
    return index;
  };
  const options = loop
    ? Array.from(
        { length: cycleLength * WHEEL_CYCLES },
        (_, index) => field.options[index % cycleLength],
      )
    : field.options;

  useEffect(() => {
    const currentValue = field.options[cycleIndex(positionRef.current)];
    if (!loop || currentValue !== value) {
      const next = middleCycle * cycleLength + valueIndex;
      positionRef.current = next;
      setPosition(next);
    }
  }, [cycleLength, loop, middleCycle, value, valueIndex]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const top = position * WHEEL_ITEM_HEIGHT;
    if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
  }, [field.options.length, position]);

  const chooseAt = (nextPosition) => {
    if (disabled) return;
    const normalized = normalizePosition(nextPosition);
    const rawValue = field.options[cycleIndex(normalized)];
    const nextValue = field.normalizeValue
      ? field.normalizeValue(rawValue)
      : rawValue;
    let target = normalized;
    if (nextValue !== rawValue) {
      const cycle = loop ? Math.floor(normalized / cycleLength) : 0;
      const valueIndex = field.options.indexOf(nextValue);
      target = normalizePosition(cycle * cycleLength + valueIndex);
    }
    positionRef.current = target;
    setPosition(target);
    if (nextValue !== value) onChange(nextValue);
  };

  const move = (delta) => {
    const step = Math.sign(delta);
    if (!step) return;
    if (loop && !field.stepOptions) chooseAt(positionRef.current + step);
    else {
      const stepOptions = field.stepOptions || field.options;
      const nextValue = wheelStepValue(stepOptions, value, step, loop);
      const valueIndex = field.options.indexOf(nextValue);
      const cycle = loop ? Math.floor(positionRef.current / cycleLength) : 0;
      chooseAt(cycle * cycleLength + valueIndex);
    }
  };

  const moveRef = useRef(move);
  moveRef.current = move;
  const drainWheel = () => {
    const state = wheelRef.current;
    state.timer = null;
    if (!state.pending) return;
    const now = performance.now();
    const wait = Math.max(0, WHEEL_THROTTLE - (now - state.lastMove));
    if (wait) {
      state.timer = window.setTimeout(drainWheel, wait);
      return;
    }
    const step = state.pending > 0 ? 1 : -1;
    state.pending -= step;
    state.lastMove = now;
    moveRef.current(step);
    if (state.pending)
      state.timer = window.setTimeout(drainWheel, WHEEL_THROTTLE);
  };
  const scheduleWheel = () => {
    const state = wheelRef.current;
    if (state.timer != null || !state.pending) return;
    const wait = Math.max(
      0,
      WHEEL_THROTTLE - (performance.now() - state.lastMove),
    );
    state.timer = window.setTimeout(drainWheel, wait);
  };
  useEffect(
    () => () => {
      const state = wheelRef.current;
      if (state.timer != null) window.clearTimeout(state.timer);
      if (state.endTimer != null) window.clearTimeout(state.endTimer);
    },
    [],
  );

  const selectedId = `task-deadline-wheel-${field.key}-${position}`;

  return (
    <div
      className={`task-deadline-wheel-field ${disabled ? "is-disabled" : ""}`}
    >
      <span className="task-deadline-wheel-label">{field.label}</span>
      <div
        ref={viewport}
        className="task-deadline-wheel-viewport"
        role="listbox"
        aria-label={field.name}
        aria-activedescendant={selectedId}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onScroll={(event) => {
          event.stopPropagation();
          if (disabled) return;
          const index = Math.min(
            options.length - 1,
            Math.max(
              0,
              Math.round(event.currentTarget.scrollTop / WHEEL_ITEM_HEIGHT),
            ),
          );
          chooseAt(index);
        }}
        onWheel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          const rawDelta = event.deltaY || event.deltaX;
          if (!rawDelta) return;
          const scale =
            event.deltaMode === 1
              ? WHEEL_LINE_DELTA
              : event.deltaMode === 2
                ? WHEEL_DELTA_PER_STEP
                : 1;
          const state = wheelRef.current;
          const result = wheelDeltaSteps(
            rawDelta * scale,
            state.remainder,
            WHEEL_DELTA_PER_STEP,
          );
          state.remainder = result.remainder;
          if (result.steps) {
            state.pending += Math.max(
              -WHEEL_MAX_STEPS_PER_EVENT,
              Math.min(WHEEL_MAX_STEPS_PER_EVENT, result.steps),
            );
            // A single large wheel event is intentionally capped at one
            // value, so its extra delta must not become a second queued step.
            state.remainder = 0;
          }
          if (state.endTimer != null) window.clearTimeout(state.endTimer);
          state.endTimer = window.setTimeout(() => {
            state.endTimer = null;
            if (
              Math.abs(state.remainder) >=
              WHEEL_DELTA_PER_STEP * WHEEL_REMAINDER_RATIO
            ) {
              state.pending += Math.sign(state.remainder);
            }
            state.remainder = 0;
            scheduleWheel();
          }, WHEEL_DEBOUNCE);
          scheduleWheel();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            chooseAt(loop ? middleCycle * cycleLength : 0);
          } else if (event.key === "End") {
            event.preventDefault();
            chooseAt(
              loop
                ? middleCycle * cycleLength + cycleLength - 1
                : cycleLength - 1,
            );
          }
        }}
      >
        <div className="task-deadline-wheel-options">
          <span className="task-deadline-wheel-spacer" aria-hidden="true" />
          {options.map((option, index) => {
            const distance = index - position;
            const selected = index === position;
            const enabled =
              !field.isOptionEnabled || field.isOptionEnabled(option);
            return (
              <div
                key={`${option}-${index}`}
                id={`task-deadline-wheel-${field.key}-${index}`}
                className={`task-deadline-wheel-option ${selected ? "is-selected" : ""} ${enabled ? "" : "is-unavailable"}`}
                role="option"
                aria-selected={selected}
                aria-disabled={!enabled}
                aria-posinset={cycleIndex(index) + 1}
                aria-setsize={cycleLength}
                data-wheel-option="true"
                style={{
                  transform: `rotateX(${Math.max(-72, Math.min(72, distance * -12))}deg)`,
                  opacity: Math.max(
                    0.12,
                    1 - Math.min(4, Math.abs(distance)) * 0.18,
                  ),
                }}
                onClick={() => chooseAt(index)}
              >
                {wheelOptionLabel(field, option)}
              </div>
            );
          })}
          <span className="task-deadline-wheel-spacer" aria-hidden="true" />
        </div>
        <span className="task-deadline-wheel-center" aria-hidden="true" />
      </div>
    </div>
  );
}

function DeadlinePicker({ task, disabled, onClose, onSave }) {
  const [parts, setParts] = useState(() => deadlineSelection(task.dueAt));
  const [error, setError] = useState("");
  const currentYear = new Date().getFullYear();
  const fields = deadlineWheelFields(parts, currentYear);
  const save = (dueAt) => {
    const message = onSave(dueAt);
    if (message) setError(message);
  };
  return (
    <>
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
          <div className="task-deadline-wheels">
            {fields.map((field) => (
              <WheelColumn
                key={field.key}
                field={field}
                value={parts[field.key]}
                disabled={disabled}
                onChange={(value) => {
                  setParts((previous) =>
                    updateDeadlineSelection(previous, field.key, value),
                  );
                  setError("");
                }}
              />
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
    </>
  );
}

export function TaskDeadlinePopover({ task, disabled, onClose, onSave }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onPointerDown = (event) => {
      if (
        !panel.current?.contains(event.target) &&
        !event.target.closest("[data-deadline-anchor]")
      )
        closeRef.current();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    panel.current?.querySelector(".task-deadline-wheel-viewport")?.focus({
      preventScroll: true,
    });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  return (
    <section
      ref={panel}
      className="task-deadline-popover"
      role="dialog"
      aria-label="设置待办截止时间"
    >
      <header className="task-deadline-popover-header">
        <strong>设置截止时间</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭截止时间选择"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <DeadlinePicker
        task={task}
        disabled={disabled}
        onClose={onClose}
        onSave={onSave}
      />
    </section>
  );
}

export function TaskDeadlineDialog({ task, disabled, onClose, onSave }) {
  return (
    <Modal
      title="待办截止时间"
      onClose={onClose}
      className="task-deadline-dialog"
    >
      <DeadlinePicker
        task={task}
        disabled={disabled}
        onClose={onClose}
        onSave={onSave}
      />
    </Modal>
  );
}
