import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import themePlugin from "@fullcalendar/react/themes/monarch";
import zhCn from "@fullcalendar/react/locales/zh-cn";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LockKeyhole,
  X,
} from "lucide-react";
import { deadlineInfo, validDeadline } from "../../shared/deadline.js";
import { deadlineEvents, localDayKey } from "./deadline-calendar.js";
import { TaskDeadlinePopover, formatDeadline } from "./TaskDeadline.jsx";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/monarch/theme.css";
import "@fullcalendar/react/themes/monarch/palettes/green.css";
import "./deadlineCalendar.css";

const plugins = [themePlugin, dayGridPlugin];
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "long",
});
const eventTimeFormat = { hour: "2-digit", minute: "2-digit", hour12: false };
const moreText = (n) => `还有 ${n} 项`;
const eventClass = ({ event }) => `ddl-event ddl-${event.extendedProps.status}`;
const dateClass = ({ isToday }) =>
  `ddl-date-button${isToday ? " is-today" : ""}`;
const renderDay = ({ dayNumberText }) => dayNumberText;
const renderEvent = ({ event, timeText }) => (
  <span className="ddl-event-content" title={`${timeText} ${event.title}`}>
    <time>{timeText}</time>
    <span>{event.title}</span>
  </span>
);

export default function DeadlineCalendar({
  page,
  clock,
  disabled,
  deadlineEditor,
  onDeadline,
  onDeadlineClose,
  onDeadlineSave,
  onToggle,
  onLocate,
  onList,
}) {
  const calendar = useRef(null),
    panel = useRef(null),
    opener = useRef(null);
  const [monthTitle, setMonthTitle] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [day, setDay] = useState(null);
  const events = useMemo(
    () => deadlineEvents(page, { showCompleted, now: clock }),
    [page, showCompleted, clock],
  );
  const datedTasks = (page?.tasks || []).filter((t) =>
    validDeadline(t.block.dueAt),
  );
  const undated = (page?.tasks || []).filter(
    (t) => !t.block.done && !validDeadline(t.block.dueAt),
  ).length;
  const todayEvents = events.filter((e) => localDayKey(e.start) === day);
  const tasksById = new Map(
    (page?.tasks || []).map((t) => [JSON.stringify([t.note.id, t.key]), t]),
  );
  const editingId =
    deadlineEditor &&
    JSON.stringify([deadlineEditor.noteId, deadlineEditor.blockId]);
  // Keep the editor's anchor mounted while a collaborator moves or removes its
  // task. Saving still checks the latest object and original dueAt in the parent.
  const rowEvents =
    deadlineEditor?.pageId === page?.id &&
    !todayEvents.some((e) => e.id === editingId)
      ? [
          ...todayEvents,
          {
            id: editingId,
            title: deadlineEditor.title || "空白待办",
            moved: true,
          },
        ]
      : todayEvents;
  const openDay = useCallback((date, target) => {
    opener.current = target || document.activeElement;
    setDay(typeof date === "string" ? date : localDayKey(date));
  }, []);
  const closeDay = () => {
    if (deadlineEditor) onDeadlineClose(deadlineEditor);
    setDay(null);
    if (opener.current?.isConnected)
      opener.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (day) panel.current?.focus({ preventScroll: true });
  }, [day]);
  const moreClick = useCallback(
    (info) => {
      openDay(info.date, info.jsEvent.currentTarget);
      // Returning the current view is the supported way to suppress the built-in
      // popover while retaining the month and opening our task actions panel.
      return "dayGridMonth";
    },
    [openDay],
  );
  const eventClick = useCallback(
    (info) => openDay(info.event.start, info.el),
    [openDay],
  );
  const datesSet = useCallback((info) => setMonthTitle(info.view.title), []);
  const navDayClick = useCallback(
    (date, event) => openDay(date, event.currentTarget),
    [openDay],
  );
  const move = (action) => {
    closeDay();
    calendar.current?.getApi()[action]();
  };
  return (
    <section
      className="deadline-calendar"
      aria-label={`${page?.title || "当前灵感板"}的 DDL 月历`}
    >
      <header className="ddl-toolbar">
        <div className="ddl-month-nav">
          <h2>{monthTitle || "DDL 月历"}</h2>
          <button
            type="button"
            aria-label="上个月"
            onClick={() => move("prev")}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            aria-label="下个月"
            onClick={() => move("next")}
          >
            <ChevronRight size={17} />
          </button>
          <button type="button" onClick={() => move("today")}>
            今天
          </button>
        </div>
        <label className="ddl-completed-filter">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => {
              if (deadlineEditor) onDeadlineClose(deadlineEditor);
              setShowCompleted(e.target.checked);
            }}
          />
          显示已完成
        </label>
      </header>
      <div className="ddl-calendar-body">
        <div className="ddl-month-scroll">
          <FullCalendar
            ref={calendar}
            plugins={plugins}
            locale={zhCn}
            timeZone="local"
            firstDay={1}
            initialView="dayGridMonth"
            headerToolbar={false}
            height="auto"
            fixedWeekCount={false}
            aspectRatio={2.5}
            dayMaxEvents={3}
            eventDisplay="block"
            eventOrder="done,start,id"
            eventOrderStrict
            defaultTimedEventDuration="00:00:01"
            nextDayThreshold="24:00"
            events={events}
            editable={false}
            eventTimeFormat={eventTimeFormat}
            eventClass={eventClass}
            eventContent={renderEvent}
            eventClick={eventClick}
            dayCellClass="ddl-day-cell"
            dayCellTopInnerClass={dateClass}
            dayCellTopContent={renderDay}
            dayHeaderClass="ddl-weekday"
            navLinks
            navLinkDayClick={navDayClick}
            moreLinkText={moreText}
            moreLinkContent={(info) => moreText(info.num)}
            moreLinkClass="ddl-more"
            moreLinkClick={moreClick}
            datesSet={datesSet}
          />
        </div>
        {day && (
          <aside
            className="ddl-day-panel"
            aria-label="当天 DDL"
            tabIndex={-1}
            ref={panel}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !deadlineEditor) {
                e.stopPropagation();
                closeDay();
              }
            }}
          >
            <header>
              <div>
                <span className="ddl-eyebrow">当天截止</span>
                <h3>{dayFormat.format(new Date(`${day}T12:00:00`))}</h3>
                <p aria-live="polite">
                  {todayEvents.length} 项{showCompleted ? "任务" : "待办"}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭当天清单"
                onClick={closeDay}
              >
                <X size={18} />
              </button>
            </header>
            <div className="ddl-day-tasks">
              {rowEvents.map((event) => {
                const liveTask = tasksById.get(event.id);
                const task = liveTask || {
                  note: { id: deadlineEditor.noteId },
                  key: deadlineEditor.blockId,
                  block: { dueAt: deadlineEditor.dueAt, done: false },
                  locked: true,
                };
                const text = event.title,
                  info = deadlineInfo(task.block, clock);
                const editor =
                  deadlineEditor?.noteId === task.note.id &&
                  deadlineEditor?.blockId === task.key
                    ? deadlineEditor
                    : null;
                const frozen = disabled || task.locked;
                return (
                  <article
                    className={`deadline-day-task ddl-${info.status}`}
                    key={event.id}
                  >
                    <button
                      type="button"
                      className="ddl-complete"
                      aria-label={`${task.block.done ? "恢复" : "完成"}：${text}`}
                      aria-pressed={!!task.block.done}
                      disabled={frozen || !!deadlineEditor}
                      onClick={() => onToggle(task)}
                    >
                      {task.block.done && <Check size={13} />}
                    </button>
                    <div className="ddl-task-main">
                      <p className="ddl-task-title">{text}</p>
                      <span className="ddl-task-meta">
                        <time dateTime={task.block.dueAt}>
                          {validDeadline(task.block.dueAt)
                            ? timeFormat.format(new Date(task.block.dueAt))
                            : "未设日期"}
                        </time>
                        <span>
                          {event.moved ? "任务日期或位置已变化" : info.relative}
                        </span>
                        {task.locked && (
                          <LockKeyhole size={12} aria-label="已锁定" />
                        )}
                      </span>
                      <div className="ddl-task-actions">
                        <TaskDeadlinePopover
                          open={!!editor}
                          task={editor}
                          disabled={frozen}
                          onOpenChange={(open) =>
                            open
                              ? onDeadline(page.id, task)
                              : onDeadlineClose(editor)
                          }
                          onClose={() => onDeadlineClose(editor)}
                          onSave={onDeadlineSave}
                        >
                          <button
                            type="button"
                            disabled={frozen}
                            aria-label={`修改截止时间：${text}`}
                            title={formatDeadline(task.block.dueAt)}
                          >
                            <Clock3 size={13} />
                            改期
                          </button>
                        </TaskDeadlinePopover>
                        <button
                          type="button"
                          disabled={!liveTask}
                          onClick={() => onLocate(task)}
                        >
                          <ArrowUpRight size={13} />
                          在清单中查看
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
              {!rowEvents.length && (
                <div className="ddl-day-empty">
                  <Check size={25} />
                  <p>这一天没有{showCompleted ? "任务" : "待办"} DDL</p>
                  <span>可以显示已完成，或选择其他日期。</span>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className="ddl-footer">
        <span>
          <CalendarDays size={14} />
          当前灵感板 · {datedTasks.filter((t) => !t.block.done).length} 项待办有
          DDL
        </span>
        <span>
          {undated} 项待办未设日期{" "}
          <button type="button" onClick={onList}>
            去清单查看
          </button>
        </span>
      </footer>
      {!datedTasks.length && (
        <p className="ddl-empty-hint">
          在清单中给任务设置截止时间，就会出现在这里。
        </p>
      )}
    </section>
  );
}
