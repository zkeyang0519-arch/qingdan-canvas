import React, {
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CalendarClock, Check, Clock3, X } from "lucide-react";
import { WheelPicker, WheelPickerWrapper } from "@ncdai/react-wheel-picker";
import { Calendar } from "../components/ui/calendar.jsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.jsx";
import {
  nextDeadlineTick,
  parseDeadlineInput,
  validDeadline,
} from "../../shared/deadline.js";
import {
  deadlineSelection,
  deadlineWheelFields,
  deadlineCalendarDate,
  deadlinePopoverSide,
  selectDeadlineDate,
  updateDeadlineSelection,
  deadlineSelectionValue,
} from "./deadlineInput.js";
import "@ncdai/react-wheel-picker/style.css";
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

export const TaskDeadlineButton = React.forwardRef(function TaskDeadlineButton(
  { info, dueAt, text, disabled, ...props },
  ref,
) {
  const hasDeadline = info.status !== "none";
  const description = hasDeadline
    ? `${info.relative}，截止 ${formatDeadline(dueAt)}`
    : "设置截止时间";
  return (
    <button
      ref={ref}
      type="button"
      className={`todo-deadline-button ${hasDeadline ? "has-deadline" : ""}`}
      aria-label={`${hasDeadline ? "修改" : "设置"}截止时间：${text || "空白待办"}；${description}`}
      title={hasDeadline ? `${description}；点击修改或移除` : "设置截止时间"}
      disabled={disabled}
      {...props}
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
});

const timeFields = deadlineWheelFields();

function TimeWheel({ field, value, disabled, onChange, onMovingChange }) {
  const root = useRef(null);
  const motion = useRef({ frame: null, held: false });
  const movingChange = useRef(onMovingChange);
  movingChange.current = onMovingChange;
  const watchMotion = () => {
    if (disabled) return;
    movingChange.current(true);
    if (motion.current.frame !== null) return;
    let previous = null,
      stillFrames = 0;
    const tick = () => {
      const transform =
        root.current?.querySelector("[data-rwp-options]")?.style.transform;
      stillFrames =
        !motion.current.held && transform === previous ? stillFrames + 1 : 0;
      previous = transform;
      if (stillFrames >= 3) {
        motion.current.frame = null;
        movingChange.current(false);
      } else motion.current.frame = requestAnimationFrame(tick);
    };
    motion.current.frame = requestAnimationFrame(tick);
  };
  useLayoutEffect(() => {
    const release = (event) => {
      // The primitive has no touchcancel handler; cancel through its mouseup
      // path while its gesture listeners are still attached.
      if (event.type === "touchcancel" && motion.current.held)
        document.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        );
      motion.current.held = false;
    };
    document.addEventListener("mouseup", release);
    document.addEventListener("touchend", release);
    document.addEventListener("touchcancel", release);
    return () => {
      // wheel-picker 1.2.3 aborts its document mousemove listener on mouseup,
      // but not on unmount. Finish the gesture before its passive cleanup.
      if (motion.current.held)
        document.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        );
      cancelAnimationFrame(motion.current.frame);
      document.removeEventListener("mouseup", release);
      document.removeEventListener("touchend", release);
      document.removeEventListener("touchcancel", release);
    };
  }, []);
  useLayoutEffect(() => {
    if (disabled && motion.current.held)
      document.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      );
  }, [disabled]);
  const options = useMemo(
    () =>
      field.options.map((value) => ({
        value,
        label: field.format(value),
        disabled: Boolean(disabled),
      })),
    [field, disabled],
  );
  // The wheel primitive exposes keyboard handling but no ARIA props yet.
  // Add a named spinbutton to its actual focus target, not a second tab stop.
  useLayoutEffect(() => {
    const wheel = root.current.querySelector("[data-rwp]");
    wheel.setAttribute("role", "spinbutton");
    wheel.setAttribute("aria-label", field.name);
    wheel.setAttribute("aria-valuemin", "0");
    wheel.setAttribute("aria-valuemax", String(field.options.at(-1)));
    wheel.setAttribute("aria-valuenow", String(value));
    wheel.setAttribute(
      "aria-valuetext",
      `${field.format(value)} ${field.label}`,
    );
    wheel.setAttribute("aria-disabled", String(Boolean(disabled)));
  }, [field, value, disabled]);
  return (
    <div
      ref={root}
      className="task-deadline-time-field"
      inert={disabled || undefined}
      onMouseDownCapture={(event) => {
        if (event.button !== 0 || disabled) return;
        motion.current.held = true;
        watchMotion();
      }}
      onTouchStartCapture={() => {
        if (disabled) return;
        motion.current.held = true;
        watchMotion();
      }}
      onWheelCapture={(event) => {
        if (event.deltaY) watchMotion();
      }}
      onKeyDownCapture={(event) => {
        if (disabled) return;
        if (
          ["ArrowUp", "ArrowDown"].includes(event.key) ||
          (/^\d$/.test(event.key) &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey)
        )
          watchMotion();
        if (!["Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(event.key === "Home" ? 0 : field.options.at(-1));
      }}
    >
      <span className="task-deadline-wheel-label" aria-hidden="true">
        {field.label === "时" ? "小时" : "分钟"}
      </span>
      <WheelPicker
        options={options}
        value={value}
        onValueChange={(next) => {
          if (!disabled) onChange(next);
        }}
        infinite
        visibleCount={12}
        optionItemHeight={30}
        scrollSensitivity={8}
        classNames={{
          optionItem: "task-deadline-time-option",
          highlightWrapper: "task-deadline-time-highlight",
          highlightItem: "task-deadline-time-selected",
        }}
      />
    </div>
  );
}

function DeadlinePicker({ task, disabled, onClose, onSave }) {
  const [parts, setParts] = useState(() => deadlineSelection(task.dueAt));
  const [month, setMonth] = useState(() => deadlineCalendarDate(parts));
  const [error, setError] = useState("");
  const [moving, setMoving] = useState({ hour: false, minute: false });
  const settling = moving.hour || moving.minute;
  const date = deadlineCalendarDate(parts);
  const currentYear = new Date().getFullYear();
  const save = (dueAt) => {
    if (disabled) return;
    const message = onSave(dueAt);
    if (message) setError(message);
  };
  return (
    <>
      <p className="task-deadline-title" title={task.title}>
        {task.title || "空白待办"}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (settling) return;
          try {
            save(parseDeadlineInput(deadlineSelectionValue(parts)));
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        <fieldset className="task-deadline-fields" disabled={disabled}>
          <legend className="task-deadline-sr-only">截止日期和时间</legend>
          <Calendar
            mode="single"
            required
            selected={date}
            month={month}
            onMonthChange={setMonth}
            startMonth={deadlineCalendarDate({
              year: Math.max(1, Math.min(currentYear - 5, parts.year)),
              month: 1,
              day: 1,
            })}
            endMonth={deadlineCalendarDate({
              year: Math.min(9999, Math.max(currentYear + 10, parts.year)),
              month: 12,
              day: 1,
            })}
            disabled={disabled}
            disableNavigation={disabled}
            onSelect={(selected) => {
              if (disabled || !selected) return;
              setParts((before) => selectDeadlineDate(before, selected));
              setMonth(selected);
              setError("");
            }}
          />
          <div className="task-deadline-time-heading">
            <span>
              <Clock3 size={14} />
              时间
            </span>
            <span className="task-deadline-time-preview">
              {String(parts.hour).padStart(2, "0")} :{" "}
              {String(parts.minute).padStart(2, "0")}
            </span>
          </div>
          <WheelPickerWrapper className="task-deadline-time-wheels">
            {timeFields.map((field) => (
              <TimeWheel
                key={field.key}
                field={field}
                value={parts[field.key]}
                disabled={disabled}
                onMovingChange={(value) =>
                  setMoving((before) =>
                    before[field.key] === value
                      ? before
                      : { ...before, [field.key]: value },
                  )
                }
                onChange={(value) => {
                  setParts((before) =>
                    updateDeadlineSelection(before, field.key, value),
                  );
                  setError("");
                }}
              />
            ))}
            <span className="task-deadline-time-colon" aria-hidden="true">
              :
            </span>
          </WheelPickerWrapper>
        </fieldset>
        <div className="task-deadline-summary" aria-live="polite">
          <CalendarClock size={14} aria-hidden="true" />
          <span>
            {parts.year} 年 {parts.month} 月 {parts.day} 日 ·{" "}
            {String(parts.hour).padStart(2, "0")}:
            {String(parts.minute).padStart(2, "0")}
          </span>
        </div>
        <p className="task-deadline-hint">本地时间 · 提前 24 小时提醒</p>
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
        <div className="task-deadline-actions">
          {task.dueAt && (
            <button
              className="task-deadline-remove"
              type="button"
              disabled={disabled}
              onClick={() => save(null)}
            >
              移除时间
            </button>
          )}
          <span />
          <button
            className="task-deadline-cancel"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="task-deadline-confirm"
            type="submit"
            disabled={disabled || settling}
            aria-busy={settling}
          >
            确定
          </button>
        </div>
      </form>
    </>
  );
}

export function TaskDeadlinePopover({
  task,
  open,
  onOpenChange,
  disabled,
  onClose,
  onSave,
  children,
}) {
  const panel = useRef(null);
  const [panelElement, setPanelElement] = useState(null);
  const panelRef = useCallback((element) => {
    panel.current = element;
    setPanelElement(element);
  }, []);
  const trigger = useRef(null);
  const [side, setSide] = useState("bottom");
  const titleId = useId();
  useLayoutEffect(() => {
    if (!open || !panelElement) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      setSide(
        deadlinePopoverSide(
          trigger.current.getBoundingClientRect(),
          {
            width: panel.current.offsetWidth,
            height: panel.current.scrollHeight + 2,
          },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    const onScroll = (event) => {
      if (!panel.current?.contains(event.target)) place();
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, panelElement]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild ref={trigger} data-deadline-trigger>
        {children}
      </PopoverTrigger>
      {open && (
        <PopoverContent
          ref={panelRef}
          className="task-deadline-popover"
          side={side}
          align={side === "bottom" ? "end" : "start"}
          aria-labelledby={titleId}
          hideWhenDetached
          onInteractOutside={(event) => {
            const nextTrigger = event.target.closest?.(
              "[data-deadline-trigger]",
            );
            // The other trigger replaces the shared editor. A delayed outside
            // dismissal from this row must not clear the newly opened editor.
            if (
              nextTrigger &&
              nextTrigger !== trigger.current &&
              !nextTrigger.disabled
            )
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A different row may already have opened its panel before this
            // one's delayed focus cleanup. Never steal focus from that panel.
            if (
              document.activeElement === document.body &&
              !document.querySelector(".task-deadline-popover")
            )
              trigger.current?.focus({ preventScroll: true });
          }}
          onOpenAutoFocus={(event) => {
            const day = panel.current?.querySelector(
              '.rdp-day_button[tabindex="0"]',
            );
            if (day) {
              event.preventDefault();
              day.focus({ preventScroll: true });
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <header className="task-deadline-popover-header">
            <span>
              <CalendarClock size={16} />
              <strong id={titleId}>截止时间</strong>
            </span>
            <button
              type="button"
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
        </PopoverContent>
      )}
    </Popover>
  );
}
