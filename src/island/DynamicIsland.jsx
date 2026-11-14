import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  CheckCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  LockKeyhole,
  Pin,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { blockText, createObject, makeBlock } from "../canvas/model.js";
import {
  appendPageObjects,
  choosePanePage,
  panePages,
  writablePage,
} from "../canvas/arranged-model.js";
import { getIslandPreferences, setIslandPreferences } from "./preferences.js";
import {
  IslandDesktopHeader,
  IslandSideTab,
} from "../desktop/IslandDesktopHeader.jsx";
import "./dynamic-island.css";
import { useAnimalRunner } from "./animal-runners.js";

const syncLabels = {
  loading: "连接中",
  saved: "已同步",
  saving: "同步中",
  uploading: "图片上传中",
  offline: "离线 · 保留草稿",
  conflict: "请先处理同步冲突",
  error: "尚未同步",
};

export default function DynamicIsland({
  workspace,
  boardId,
  onDisable,
  beforeAction,
  top,
  hidden = false,
  panelToolbar,
  panelNotice,
  closeLabel = "隐藏轻岛",
  closeText = "隐藏到托盘",
  closeOnWindowBlur = false,
  onDraftsChange,
  dragHandleTitle,
  desktop,
}) {
  const { state, readOnly } = workspace;
  const { pages, page } = panePages(state, boardId);
  const pinned = getIslandPreferences(state, boardId).pinned;
  const [expanded, setExpanded] = useState(pinned);
  const shown = expanded && !desktop?.dragging;
  const side = desktop?.dock === "left" || desktop?.dock === "right";
  const jade = desktop?.supportsJade === true;
  const Surface = dragHandleTitle ? "div" : React.Fragment;
  const [drafts, setDrafts] = useState({});
  const [feedback, setFeedback] = useState("");
  const [focusedTask, setFocusedTask] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [offset, setOffset] = useState(top ?? 76);
  const dock = useRef(null),
    island = useRef(null),
    panel = useRef(null),
    trigger = useRef(null),
    input = useRef(null);
  const enterTimer = useRef(null),
    leaveTimer = useRef(null);
  const pointerInside = useRef(false),
    keyboard = useRef(false),
    composing = useRef(false),
    clickHeld = useRef(false);
  const live = useRef({ pinned, expanded });
  live.current = { pinned, expanded };
  const panelId = useId(),
    inputId = useId();
  const tasks = page?.tasks || [];
  const completed = tasks.filter((task) => task.block.done).length;
  const nextTask = tasks.find((task) => !task.block.done);
  const pendingTasks = tasks.filter((task) => !task.block.done);
  const taskId = (task) => `${task.note.id}/${task.key}`;
  const currentTask =
    pendingTasks.find((task) => taskId(task) === focusedTask) || nextTask;
  const animal = useAnimalRunner(
    jade && !hidden && !desktop.dragging && pendingTasks.length > 0,
    island,
  );
  const draft = drafts[page?.id] || "";
  const writable =
    !readOnly && !!page && !!writablePage(state, boardId, page.id);

  const clearTimers = () => {
    clearTimeout(enterTimer.current);
    clearTimeout(leaveTimer.current);
  };
  const savePin = (value) =>
    workspace.update(
      (current) =>
        setIslandPreferences(current, boardId, {
          enabled: true,
          pinned: value,
        }),
      { record: false, navigation: true },
    );
  const open = () => {
    clearTimers();
    setExpanded(true);
  };
  const close = ({ focus = false, unpin = false } = {}) => {
    clearTimers();
    clickHeld.current = false;
    if (unpin && live.current.pinned) savePin(false);
    if (focus)
      (side
        ? dock.current?.querySelector(".island-side-toggle")
        : trigger.current
      )?.focus();
    setExpanded(false);
  };
  const scheduleClose = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      const active = document.activeElement;
      const editing = active === input.current;
      const keyboardFocus = keyboard.current && panel.current?.contains(active);
      if (
        !live.current.pinned &&
        !clickHeld.current &&
        !pointerInside.current &&
        !editing &&
        !keyboardFocus
      )
        setExpanded(false);
    }, 300);
  };

  useEffect(() => {
    const pointerDown = (event) => {
      keyboard.current = false;
      if (!dock.current?.contains(event.target) && !live.current.pinned) {
        clearTimers();
        clickHeld.current = false;
        setExpanded(false);
      }
    };
    const keyDown = (event) => {
      if (event.key === "Tab") keyboard.current = true;
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      clearTimers();
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, []);

  useEffect(() => {
    onDraftsChange?.(drafts);
  }, [drafts, onDraftsChange]);

  useEffect(() => {
    if (!closeOnWindowBlur) return;
    const blurred = () => {
      clearTimers();
      pointerInside.current = false;
      keyboard.current = false;
      clickHeld.current = false;
      if (!live.current.pinned) setExpanded(false);
    };
    window.addEventListener("blur", blurred);
    return () => window.removeEventListener("blur", blurred);
  }, [closeOnWindowBlur]);

  useEffect(() => {
    if (hidden) {
      clearTimers();
      pointerInside.current = false;
      clickHeld.current = false;
      setExpanded(false);
    } else if (pinned) {
      setExpanded(true);
    }
  }, [hidden, pinned]);

  useEffect(() => {
    if (desktop?.dragging) {
      clearTimers();
      clickHeld.current = false;
      pointerInside.current = false;
      setExpanded(false);
    } else if (pinned && !hidden) setExpanded(true);
  }, [desktop?.dragging, pinned, hidden]);

  useLayoutEffect(() => {
    const measure = () => {
      if (!panel.current || hidden) return;
      island.current?.style.setProperty(
        "--island-height",
        `${panel.current.scrollHeight + 52}px`,
      );
      const nav = dock.current
        ?.closest(".cloud-canvas")
        ?.querySelector(".topbar");
      setOffset(top ?? (nav ? nav.getBoundingClientRect().bottom + 12 : 76));
    };
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(panel.current);
    const nav = dock.current
      ?.closest(".cloud-canvas")
      ?.querySelector(".topbar");
    if (nav) observer?.observe(nav);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [top, hidden, tasks.length, page?.id, feedback, shown, desktop?.dock]);

  const changePage = (event) => {
    if (composing.current) return;
    beforeAction?.();
    const pageId = event.target.value;
    workspace.update(
      (current) => choosePanePage(current, boardId, "left", pageId),
      { record: false, navigation: true },
    );
    setFeedback("");
    setFocusedTask(null);
    setShowCompleted(false);
  };
  const toggleTask = (task, done = !task.block.done) => {
    if (workspace.readOnly) return;
    beforeAction?.();
    const current = workspace.current.current;
    const latest = writablePage(current, boardId, page.id)?.tasks.find(
      (entry) =>
        entry.note.id === task.note.id &&
        entry.key === task.key &&
        !entry.locked,
    );
    if (!latest) {
      setFeedback("这条待办已被锁定、收纳或删除。");
      return;
    }
    if (!!latest.block.done === done) return;
    workspace.toggleBlock(latest.note.id, latest.key);
    setFeedback("");
  };
  const addTask = () => {
    if (composing.current || workspace.readOnly || !page) return;
    const text = draft.trim();
    if (!text) {
      input.current?.focus();
      return;
    }
    beforeAction?.();
    const pageId = page.id;
    if (!writablePage(workspace.current.current, boardId, pageId)) {
      setFeedback("当前项目暂时无法添加，输入已保留。");
      return;
    }
    const note = {
      ...createObject(boardId, "note"),
      noteKind: "checklist",
      blocks: [makeBlock(text)],
    };
    workspace.update((current) =>
      appendPageObjects(current, boardId, pageId, [note]),
    );
    if (
      !workspace.current.current.objects.some((object) => object.id === note.id)
    ) {
      setFeedback("暂时未能添加，输入已保留，请重试。");
      return;
    }
    setDrafts((saved) => ({ ...saved, [pageId]: "" }));
    setShowCompleted(false);
    setFeedback("");
    input.current?.focus();
  };

  const toggle = () => {
    if (shown) close({ focus: true, unpin: true });
    else {
      clickHeld.current = true;
      open();
    }
  };
  const summary = shown
    ? "项目待办"
    : nextTask
      ? blockText(nextTask.block) || "未命名待办"
      : tasks.length
        ? "都完成了，休息一下"
        : "顺手记一件事";
  const moveTask = (step) => {
    const index = pendingTasks.indexOf(currentTask);
    const target =
      pendingTasks[(index + step + pendingTasks.length) % pendingTasks.length];
    if (target) setFocusedTask(taskId(target));
  };
  const projectControls = (
    <div className="island-panel-heading">
      <select
        className="island-project-select"
        aria-label="轻岛项目"
        value={page?.id || ""}
        onChange={changePage}
      >
        {pages.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </select>
      <button
        className="island-pin"
        type="button"
        aria-label={pinned ? "取消钉住轻岛" : "钉住轻岛"}
        aria-pressed={pinned}
        onClick={() => {
          savePin(!pinned);
          clickHeld.current = false;
          if (!pinned) open();
          else scheduleClose();
        }}
      >
        <Pin size={14} />
        <span>{pinned ? "已钉住" : "钉住"}</span>
      </button>
    </div>
  );
  const visibleTasks = jade
    ? showCompleted
      ? tasks.filter((task) => task.block.done)
      : pendingTasks.filter((task) => task !== currentTask)
    : tasks;
  return (
    <div
      ref={dock}
      className="dynamic-island-dock"
      {...desktop?.handlers}
      onPointerDown={(event) => {
        clearTimers();
        desktop?.handlers.onPointerDown(event);
      }}
      hidden={hidden}
      style={{ top: offset, "--island-top": `${offset}px` }}
    >
      <section
        ref={island}
        className="dynamic-island"
        data-open={shown}
        data-appearance={jade ? "jade" : undefined}
        data-dock={desktop?.dragging ? "free" : desktop?.dock}
        data-dragging={desktop?.dragging || undefined}
        style={
          desktop
            ? {
                "--desktop-rail-offset": `${Math.max(0, (desktop.railOffset || 12) - 12)}px`,
              }
            : undefined
        }
        aria-label="轻岛"
        onPointerEnter={(event) => {
          if (event.pointerType === "touch" || desktop?.dragging) return;
          pointerInside.current = true;
          clearTimeout(leaveTimer.current);
          if (!expanded) enterTimer.current = setTimeout(open, 120);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          pointerInside.current = false;
          clickHeld.current = false;
          clearTimeout(enterTimer.current);
          scheduleClose();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            clickHeld.current = false;
          scheduleClose();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          keyboard.current = true;
          if (
            event.key === "Escape" &&
            !event.nativeEvent.isComposing &&
            !composing.current
          ) {
            event.preventDefault();
            close({ focus: true, unpin: true });
          }
        }}
      >
        {side && !desktop?.dragging && (
          <IslandSideTab
            dock={desktop.dock}
            expanded={shown}
            remaining={tasks.length - completed}
            toggle={toggle}
            panelId={panelId}
            animal={jade ? animal : undefined}
          />
        )}
        <Surface
          {...(dragHandleTitle
            ? { className: "island-desktop-surface", inert: side && !shown }
            : {})}
        >
          {dragHandleTitle ? (
            <IslandDesktopHeader
              title={dragHandleTitle}
              summary={summary}
              completed={completed}
              total={tasks.length}
              expanded={shown}
              toggle={toggle}
              panelId={panelId}
              trigger={trigger}
              animal={jade ? animal : undefined}
            />
          ) : (
            <button
              ref={trigger}
              type="button"
              className="island-toggle"
              aria-label={expanded ? "收起轻岛" : "展开轻岛"}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                if (expanded) close({ focus: true, unpin: true });
                else {
                  clickHeld.current = true;
                  open();
                }
              }}
            >
              <span
                className={`island-logo${dragHandleTitle ? " island-logo-placeholder" : ""}`}
                aria-hidden={!!dragHandleTitle}
              >
                {!dragHandleTitle && <CheckCheck size={17} />}
              </span>
              <span
                className="island-summary"
                title={
                  expanded
                    ? page?.title
                    : nextTask
                      ? blockText(nextTask.block)
                      : "全部完成"
                }
              >
                <span>轻岛</span>
                {expanded
                  ? "项目待办"
                  : nextTask
                    ? blockText(nextTask.block) || "未命名待办"
                    : tasks.length
                      ? "都完成了，休息一下"
                      : "顺手记一件事"}
              </span>
              <span className="island-progress" aria-label="待办进度">
                {completed} / {tasks.length}
              </span>
              <ChevronDown
                size={14}
                className="island-chevron"
                aria-hidden="true"
              />
            </button>
          )}
          <div
            ref={panel}
            id={panelId}
            className="island-panel"
            role="region"
            aria-label="轻岛待办"
            aria-hidden={!shown}
            inert={!shown}
          >
            {jade ? (
              <>
                <details className="island-options">
                  <summary aria-label="轻岛设置" title="项目、钉住与画布操作">
                    <Settings2 size={15} />
                  </summary>
                  <div className="island-options-content">
                    {panelToolbar}
                    {projectControls}
                  </div>
                </details>
                <header className="island-current">
                  <div className="island-current-meta">
                    <span>{showCompleted ? "完成记录" : "当前任务"}</span>
                    <span>
                      {showCompleted
                        ? `${completed} 件已完成`
                        : `${pendingTasks.length} 件待办`}
                    </span>
                  </div>
                  <h3>
                    {showCompleted
                      ? "已完成"
                      : currentTask
                        ? blockText(currentTask.block) || "未命名待办"
                        : tasks.length
                          ? "都完成了，休息一下。"
                          : "记下第一件小事。"}
                  </h3>
                  {currentTask?.locked && !showCompleted && (
                    <span className="island-current-lock">
                      <LockKeyhole size={12} />
                      已锁定
                    </span>
                  )}
                </header>
              </>
            ) : (
              <>
                {panelToolbar}
                {projectControls}
              </>
            )}
            {panelNotice}
            <div className="island-task-list">
              {visibleTasks.length ? (
                visibleTasks.map((task) => {
                  const text = blockText(task.block) || "未命名待办";
                  return (
                    <label
                      className="island-task-row"
                      data-done={task.block.done}
                      key={`${task.note.id}/${task.key}`}
                    >
                      <input
                        className="island-check"
                        type="checkbox"
                        checked={!!task.block.done}
                        disabled={!writable || task.locked}
                        aria-label={`${task.block.done ? "恢复" : "完成"}待办：${text}`}
                        onChange={() => toggleTask(task)}
                      />
                      <span className="island-task-text" title={text}>
                        {text}
                      </span>
                      {task.locked && (
                        <LockKeyhole
                          size={12}
                          className="island-task-lock"
                          aria-label="已锁定"
                        />
                      )}
                    </label>
                  );
                })
              ) : !jade || showCompleted ? (
                <div className="island-empty">
                  {jade && showCompleted
                    ? "还没有已完成事项。"
                    : "还没有待办，记下第一件小事。"}
                </div>
              ) : null}
            </div>
            <form
              className="island-compose"
              onSubmit={(event) => {
                event.preventDefault();
                addTask();
              }}
            >
              <Plus size={15} aria-hidden="true" />
              <label htmlFor={inputId} className="island-sr-only">
                新增待办
              </label>
              <textarea
                id={inputId}
                ref={input}
                aria-label="新增待办"
                rows={1}
                value={draft}
                disabled={!writable}
                placeholder={jade ? "记下一件事，回车添加…" : "顺手记一件事…"}
                maxLength={20000}
                onFocus={() => {
                  clearTimeout(leaveTimer.current);
                  open();
                }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((saved) => ({ ...saved, [page.id]: value }));
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    composing.current ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    addTask();
                  }
                }}
              />
              <button
                className="island-add"
                type="submit"
                aria-label="添加待办"
                disabled={!writable || !draft.trim()}
              >
                <CornerDownLeft size={16} />
              </button>
            </form>
            {feedback && (
              <div className="island-feedback" role="status">
                {feedback}
              </div>
            )}
            {jade && (
              <button
                className="island-completed-toggle"
                type="button"
                aria-pressed={showCompleted}
                onClick={() => setShowCompleted((value) => !value)}
              >
                <CheckCheck size={13} />
                {showCompleted ? "返回待办" : `已完成 ${completed}`}
              </button>
            )}
            <div className="island-footer">
              <span className="island-sync" role="status">
                {readOnly
                  ? "只读 · 请先处理同步冲突"
                  : syncLabels[workspace.status] || "待办与画布同步"}
              </span>
              <button
                className="island-close"
                type="button"
                aria-label={closeLabel}
                onClick={onDisable}
              >
                <X size={13} />
                {closeText}
              </button>
            </div>
            {desktop && !jade && (
              <p className="island-sync">
                更新本机代码并重启轻岛，即可使用雾玉双舱和动物奔跑。
              </p>
            )}
            {jade && (
              <footer
                className="island-task-controls"
                aria-label="当前任务操作"
              >
                <button
                  type="button"
                  aria-label="上一项任务"
                  disabled={showCompleted || pendingTasks.length < 2}
                  onClick={() => moveTask(-1)}
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  type="button"
                  className="island-finish"
                  aria-label={
                    currentTask
                      ? `完成当前任务：${blockText(currentTask.block) || "未命名待办"}`
                      : "完成这件"
                  }
                  disabled={
                    showCompleted ||
                    !currentTask ||
                    !writable ||
                    currentTask.locked
                  }
                  onClick={() => toggleTask(currentTask, true)}
                >
                  <Check size={15} />
                  <span>完成这件</span>
                </button>
                <button
                  type="button"
                  aria-label="下一项任务"
                  disabled={showCompleted || pendingTasks.length < 2}
                  onClick={() => moveTask(1)}
                >
                  <ChevronRight size={17} />
                </button>
              </footer>
            )}
          </div>
        </Surface>
      </section>
    </div>
  );
}
