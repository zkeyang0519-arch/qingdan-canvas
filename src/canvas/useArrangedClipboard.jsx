import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ClipboardPaste, Trash2 } from "lucide-react";
import { blockText, objectText } from "./model.js";
import { panePages, writablePage } from "./arranged-model.js";
import ContextMenu from "./ContextMenu.jsx";
import { Modal } from "./Panels.jsx";
import { useTodoTools } from "./TodoTools.jsx";

const isEditor = (target) =>
  target.closest("input,textarea,[contenteditable=true]");
const taskText = (task) =>
  task ? (task.article ? objectText(task.note) : blockText(task.block)) : "";

export default function useArrangedClipboard({
  workspace,
  boardId,
  libraryKey,
  selected,
  blocked,
  beforeAction,
  onToast,
  pasteText,
}) {
  const tools = useTodoTools();
  const [menu, setMenu] = useState(null);
  const [manualCopy, setManualCopy] = useState(null);
  const epoch = useRef(0);
  const live = useRef(null);
  const resolved = panePages(workspace.state, boardId);
  const writable = !!writablePage(workspace.state, boardId, resolved.page?.id);
  live.current = {
    workspace,
    boardId,
    selected,
    blocked,
    beforeAction,
    onToast,
    pasteText,
  };
  const close = useCallback(() => {
    setMenu(null);
    setManualCopy(null);
  }, []);

  // A read authorized in one destination must never land in a later one,
  // including an A -> B -> A navigation while the browser prompt is open.
  useLayoutEffect(() => {
    epoch.current++;
    close();
    return () => {
      epoch.current++;
    };
  }, [
    workspace.current,
    libraryKey,
    boardId,
    resolved.page?.id,
    resolved.view,
    workspace.readOnly,
    writable,
    blocked,
    close,
  ]);

  const currentPage = () =>
    panePages(live.current.workspace.current.current, live.current.boardId)
      .page;
  const valid = (target) =>
    target.epoch === epoch.current && currentPage()?.id === target.pageId;
  const canPaste = (target) =>
    valid(target) &&
    !live.current.blocked &&
    !live.current.workspace.readOnly &&
    !!writablePage(
      live.current.workspace.current.current,
      live.current.boardId,
      target.pageId,
    );
  const currentTask = (target) =>
    valid(target)
      ? currentPage()?.tasks.find((task) => task.key === target.taskId)
      : null;

  const copy = async (target) => {
    const text = taskText(currentTask(target));
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (valid(target)) live.current.onToast("已复制待办文字");
    } catch {
      if (valid(target)) setManualCopy(text);
    }
  };
  const paste = async (target) => {
    if (!canPaste(target)) return;
    try {
      const text = await navigator.clipboard.readText();
      if (canPaste(target)) live.current.pasteText(text, "", target.pageId);
    } catch {
      if (!canPaste(target)) return;
      target.returnFocus?.focus({ preventScroll: true });
      live.current.onToast("请按 Ctrl / ⌘ + V 粘贴到当前清单。");
    }
  };
  const onContextMenu = (event) => {
    if (event.defaultPrevented || isEditor(event.target)) return;
    const pane = event.target.closest("[data-pane]");
    if (!pane || resolved.view !== "list" || blocked) return;
    event.preventDefault();
    event.stopPropagation();
    const pageId = currentPage()?.id;
    if (!pageId) return;
    const target = {
      pageId,
      taskId: event.target.closest("[data-task-id]")?.dataset.taskId,
      anchor: { x: event.clientX, y: event.clientY },
      returnFocus: pane.querySelector(".todo-panel-body"),
    };
    beforeAction(() => setMenu({ ...target, epoch: epoch.current }));
  };
  const onCopy = (event) => {
    if (
      event.defaultPrevented ||
      isEditor(event.target) ||
      !getSelection()?.isCollapsed
    )
      return;
    const page = currentPage();
    const text = page?.tasks
      .filter((task) => selected.keys.includes(task.key))
      .map(taskText)
      .join("\n");
    if (!text || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };

  const task = menu?.taskId ? currentTask(menu) : null;
  const items = menu?.taskId
    ? [
        {
          label: "复制文字",
          icon: <Copy size={15} />,
          disabled: !taskText(task),
          action: () => {
            void copy(menu);
          },
        },
        {
          label: "删除",
          icon: <Trash2 size={15} />,
          danger: true,
          disabled: !task || task.locked || workspace.readOnly || blocked,
          action: () => {
            const current = currentTask(menu);
            if (current)
              tools?.remove(current.note.id, current.key, live.current.blocked);
          },
        },
      ]
    : [
        {
          label: "粘贴为待办",
          icon: <ClipboardPaste size={15} />,
          disabled: !menu || !canPaste(menu),
          action: () => {
            void paste(menu);
          },
        },
      ];
  const overlay = (
    <>
      {menu &&
        createPortal(
          <ContextMenu
            anchor={menu.anchor}
            items={items}
            onClose={close}
            returnFocus={menu.returnFocus}
            label="待办剪贴板操作"
          />,
          document.body,
        )}
      {manualCopy !== null &&
        createPortal(
          <Modal title="复制待办文字" onClose={close}>
            <p>
              浏览器未允许直接复制。请选中下方文字，右键复制或按 Ctrl / ⌘ + C。
            </p>
            <textarea
              className="text-field"
              aria-label="待办文字（手动复制）"
              readOnly
              rows={8}
              value={manualCopy}
              onFocus={(event) => event.currentTarget.select()}
              style={{ width: "100%", resize: "vertical" }}
            />
          </Modal>,
          document.body,
        )}
    </>
  );
  return {
    onContextMenu,
    onCopy,
    overlay,
    close,
    isOpen: !!menu || manualCopy !== null,
  };
}
