import { TaskAuthorDetails } from "./TaskAuthors.jsx";
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  blockText,
  objectLabel,
  setTaskRemark,
  deleteTask,
  deleteObjects,
  restoreTrash,
} from "./model.js";
import { effectivelyLocked } from "./layout.js";

const TodoTools = createContext(null);
export const useTodoTools = () => useContext(TodoTools);
const stop = (e) => e.stopPropagation();

export function TodoToolsProvider({
  workspace,
  scope,
  beforeAction,
  onToast,
  children,
}) {
  const [panel, setPanel] = useState(null);
  const live = useRef(null),
    popup = useRef(null),
    openTimer = useRef(),
    closeTimer = useRef();
  const transaction = useRef(false),
    suppressFocus = useRef(null);
  const composing = useRef(false),
    pendingClose = useRef(null),
    reposition = useRef(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  live.current = { panel, workspace, beforeAction, onToast };
  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const finish = () => {
    if (transaction.current) {
      transaction.current = false;
      live.current.workspace.end();
    }
  };
  const close = (returnFocus = false) => {
    if (composing.current) {
      pendingClose.current = { returnFocus };
      return;
    }
    clearTimers();
    finish();
    const anchor = live.current.panel?.anchor;
    live.current.panel = null;
    setPanel(null);
    if (returnFocus && anchor?.isConnected) {
      suppressFocus.current = anchor;
      anchor.focus({ preventScroll: true });
      queueMicrotask(() => {
        suppressFocus.current = null;
      });
    }
  };
  const open = (next) => {
    clearTimers();
    const current = live.current.panel;
    if (composing.current) return;
    if (!next.editing && next.type === "remark" && current?.editing) return;
    finish();
    if (next.editing || next.type === "menu") live.current.beforeAction();
    if (next.editing) {
      const s = live.current.workspace.current.current;
      if (
        live.current.workspace.readOnly ||
        effectivelyLocked(s.objects, next.noteId)
      )
        next = { ...next, editing: false };
      else {
        live.current.workspace.begin();
        transaction.current = true;
      }
    }
    live.current.panel = next;
    setPanel(next);
  };
  const leave = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    if (live.current.panel?.type === "remark" && !live.current.panel.editing)
      closeTimer.current = setTimeout(() => close(), 220);
  };
  const remove = (noteId, blockId, frozen = false) => {
    if (frozen || live.current.workspace.readOnly) return;
    close();
    live.current.beforeAction();
    const api = live.current.workspace,
      before = api.current.current;
    api.update((s) =>
      blockId ? deleteTask(s, noteId, blockId) : deleteObjects(s, [noteId]),
    );
    const batch = api.current.current.trash.find(
      (t) => !before.trash.some((old) => old.id === t.id),
    );
    if (!batch) return;
    live.current.onToast(`${blockId ? "待办及备注" : "整张清单"}已移入回收站`, {
      label: "撤销",
      duration: 6500,
      run: () => {
        live.current.beforeAction();
        api.update((s) => restoreTrash(s, batch.id));
        if (api.current.current.trash.some((t) => t.id === batch.id))
          live.current.onToast("内容仍在回收站，请解锁原清单后恢复。");
      },
    });
  };
  useEffect(() => {
    close();
  }, [scope]);
  useEffect(() => {
    const outside = (e) => {
      const p = live.current.panel;
      if (
        p &&
        !popup.current?.contains(e.target) &&
        !p.anchor?.contains(e.target)
      )
        close();
    };
    const key = (e) => {
      if (
        e.key === "Escape" &&
        !e.isComposing &&
        e.keyCode !== 229 &&
        !composing.current &&
        live.current.panel
      ) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      clearTimers();
      finish();
    };
  }, []);
  const note = workspace.state.objects.find((o) => o.id === panel?.noteId);
  const block = note?.blocks?.find((b) => b.id === panel?.blockId);
  const locked =
    workspace.readOnly ||
    (note && effectivelyLocked(workspace.state.objects, note.id));
  useLayoutEffect(() => {
    if (!panel) return;
    if (!panel.anchor?.isConnected || (panel.type === "remark" && !block)) {
      close();
      return;
    }
    const place = () => {
      if (!panel.anchor.isConnected) {
        close();
        return;
      }
      const a = panel.anchor.getBoundingClientRect(),
        r = {
          width: popup.current.offsetWidth,
          height: popup.current.offsetHeight,
        };
      const w = window.innerWidth,
        h = window.innerHeight;
      // A portal must follow transformed canvas anchors as well as scrolling panels.
      if (a.width && (a.bottom < 0 || a.top > h || a.right < 0 || a.left > w)) {
        close();
        return;
      }
      for (
        let p = panel.anchor.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        if (
          !/(auto|scroll|hidden|clip)/.test(
            window.getComputedStyle(p).overflow +
              window.getComputedStyle(p).overflowY,
          )
        )
          continue;
        const clip = p.getBoundingClientRect();
        if (
          clip.height &&
          (a.bottom <= clip.top ||
            a.top >= clip.bottom ||
            a.right <= clip.left ||
            a.left >= clip.right)
        ) {
          close();
          return;
        }
      }
      if (panel.point) {
        setPosition({
          left: Math.max(12, Math.min(panel.point.x, w - r.width - 12)),
          top: Math.max(12, Math.min(panel.point.y, h - r.height - 12)),
        });
        return;
      }
      let left = a.right + 8,
        top = a.top - 8;
      if (left + r.width > w - 12) left = a.left - r.width - 8;
      if (left < 12) {
        left = Math.max(12, Math.min(a.left, w - r.width - 12));
        top = a.bottom + 8;
      }
      top = Math.max(12, Math.min(top, h - r.height - 12));
      setPosition({ left: Math.max(12, left), top });
    };
    reposition.current = place;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    if (panel.editing)
      popup.current.querySelector("textarea")?.focus({ preventScroll: true });
    else if (panel.type === "menu")
      popup.current
        .querySelector("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    return () => {
      reposition.current = null;
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [panel, !!block]);
  useLayoutEffect(() => {
    if (panel) reposition.current?.();
  }, [workspace.state]);
  useEffect(() => {
    if (panel?.editing && locked) close();
  }, [locked]);
  const api = {
    workspace,
    panel,
    remove,
    showRemark: (e, noteId, blockId, editing = false, delay = false) => {
      const anchor = e.currentTarget;
      if (suppressFocus.current === anchor) return;
      clearTimers();
      const show = () =>
        open({ type: "remark", anchor, noteId, blockId, editing });
      if (delay) openTimer.current = setTimeout(show, 300);
      else show();
    },
    showMenu: (e, notes, blockId, frozen = false) => {
      e.preventDefault();
      e.stopPropagation();
      const compact = e.type === "contextmenu" && Boolean(blockId);
      open({
        type: "menu",
        anchor: e.currentTarget,
        notes,
        noteId: notes[0]?.id,
        blockId,
        frozen,
        compact,
        point: compact ? { x: e.clientX, y: e.clientY } : null,
      });
    },
    leave,
    keep: () => clearTimers(),
  };
  return (
    <TodoTools.Provider value={api}>
      {children}
      {panel &&
        createPortal(
          <div
            ref={popup}
            className={
              panel.type === "remark"
                ? "todo-remark-popover"
                : `todo-action-menu${panel.compact ? " todo-action-menu-compact" : ""}`
            }
            style={position}
            role={panel.type === "remark" ? "dialog" : "menu"}
            aria-label={panel.type === "remark" ? "待办备注" : "清单操作"}
            onPointerDown={stop}
            onClick={stop}
            onDoubleClick={stop}
            onContextMenu={(e) => {
              e.preventDefault();
              stop(e);
            }}
            onPointerEnter={api.keep}
            onPointerLeave={leave}
            onFocus={api.keep}
            onBlur={(e) => {
              if (
                !e.currentTarget.contains(e.relatedTarget) &&
                !panel.anchor?.contains(e.relatedTarget)
              )
                leave();
            }}
          >
            {panel.type === "remark" && block ? (
              <>
                <header>
                  <MessageSquareText size={15} />
                  <strong>备注</strong>
                  <span />
                  {!panel.editing && !locked && (
                    <button
                      aria-label="编辑备注"
                      onClick={() => open({ ...panel, editing: true })}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button aria-label="关闭备注" onClick={() => close(true)}>
                    <X size={15} />
                  </button>
                </header>
                <div className="todo-remark-title">
                  {blockText(block) || "空白事项"}
                </div>
                <TaskAuthorDetails block={block} />
                {panel.editing ? (
                  <textarea
                    className="todo-remark-editor"
                    aria-label="备注内容"
                    placeholder="记录做过的操作、遇到的问题或想法…"
                    value={block.remark?.text || ""}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={(e) => {
                      const text = e.currentTarget.value;
                      workspace.update((s) =>
                        setTaskRemark(s, note.id, block.id, text),
                      );
                      composing.current = false;
                      if (pendingClose.current) {
                        const next = pendingClose.current;
                        pendingClose.current = null;
                        close(next.returnFocus);
                      }
                    }}
                    onChange={(e) =>
                      workspace.update((s) =>
                        setTaskRemark(s, note.id, block.id, e.target.value),
                      )
                    }
                  />
                ) : (
                  <button
                    className="todo-remark-body"
                    disabled={locked}
                    onClick={() => open({ ...panel, editing: true })}
                  >
                    {block.remark?.text || "还没有备注，点击记录。"}
                  </button>
                )}
                <footer>
                  {locked
                    ? "只读"
                    : panel.editing
                      ? "自动保存"
                      : block.remark
                        ? new Date(block.remark.updatedAt).toLocaleString(
                            "zh-CN",
                            {
                              month: "numeric",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )
                        : ""}
                </footer>
              </>
            ) : panel.type === "menu" && panel.compact ? (
              <button
                role="menuitem"
                aria-label="删除待办"
                disabled={panel.frozen || locked || !block}
                onClick={() =>
                  remove(panel.noteId, panel.blockId, panel.frozen)
                }
              >
                删除
              </button>
            ) : panel.type === "menu" ? (
              <>
                <div className="todo-menu-heading">
                  {panel.frozen
                    ? "取消确认后可删除"
                    : panel.blockId
                      ? "此条待办"
                      : "整张清单"}
                  <button aria-label="关闭清单操作" onClick={() => close(true)}>
                    <X size={14} />
                  </button>
                </div>
                {panel.blockId ? (
                  <>
                    {block && <TaskAuthorDetails block={block} />}
                    <button
                      role="menuitem"
                      aria-label="删除待办"
                      disabled={panel.frozen || locked || !block}
                      onClick={() =>
                        remove(panel.noteId, panel.blockId, panel.frozen)
                      }
                    >
                      <Trash2 size={15} />
                      删除待办
                    </button>
                  </>
                ) : (
                  panel.notes.map((n) => {
                    const actual = workspace.state.objects.find(
                      (o) => o.id === n.id,
                    );
                    return (
                      <button
                        key={n.id}
                        role="menuitem"
                        aria-label={
                          panel.notes.length === 1
                            ? "删除整张清单"
                            : `删除整张清单：${objectLabel(n)}`
                        }
                        disabled={
                          panel.frozen ||
                          workspace.readOnly ||
                          !actual ||
                          effectivelyLocked(workspace.state.objects, n.id)
                        }
                        onClick={() => remove(n.id, null, panel.frozen)}
                      >
                        <Trash2 size={15} />
                        <span>
                          删除整张清单
                          {panel.notes.length > 1 && (
                            <small>{objectLabel(n)}</small>
                          )}
                          <small>
                            {actual?.blocks.length || 0} 项待办及备注
                          </small>
                        </span>
                      </button>
                    );
                  })
                )}
              </>
            ) : null}
          </div>,
          document.body,
        )}
    </TodoTools.Provider>
  );
}

export function TodoActions({ note, block, frozen = false, showMenu = true }) {
  const api = useTodoTools();
  if (!api) return null;
  const label = blockText(block) || "空白事项",
    has = !!block.remark?.text.trim();
  return (
    <span
      className="todo-task-actions"
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
    >
      <button
        className={`todo-remark-trigger ${has ? "has-remark" : ""}`}
        aria-label={`${has ? "查看" : "添加"}备注：${label}`}
        aria-haspopup="dialog"
        aria-expanded={
          api.panel?.type === "remark" &&
          api.panel.noteId === note.id &&
          api.panel.blockId === block.id
        }
        onPointerEnter={(e) =>
          api.showRemark(e, note.id, block.id, false, true)
        }
        onPointerLeave={api.leave}
        onFocus={(e) => api.showRemark(e, note.id, block.id)}
        onBlur={api.leave}
        onClick={(e) => api.showRemark(e, note.id, block.id, true)}
      >
        <MessageSquareText size={14} />
      </button>
      {showMenu && (
        <button
          className="todo-more-trigger"
          aria-label={`待办操作：${label}`}
          aria-haspopup="menu"
          onClick={(e) => api.showMenu(e, [note], block.id, frozen)}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
    </span>
  );
}

export function ChecklistMenu({ notes, frozen = false, className = "" }) {
  const api = useTodoTools();
  if (!api || !notes.length) return null;
  return (
    <button
      className={`todo-checklist-menu ${className}`}
      aria-label={
        notes.length === 1 ? `清单菜单：${objectLabel(notes[0])}` : "清单菜单"
      }
      aria-haspopup="menu"
      onPointerDown={stop}
      onDoubleClick={stop}
      onClick={(e) => {
        stop(e);
        api.showMenu(e, notes, null, frozen);
      }}
    >
      <MoreHorizontal size={16} />
    </button>
  );
}
