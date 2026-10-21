import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
} from "react";
import {
  Archive,
  Check,
  Frame,
  ImagePlus,
  LockKeyhole,
  Pencil,
  Plus,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  blockText,
  collectObjects,
  createObject,
  id,
  makeBlock,
  patchObjects,
} from "./model.js";
import { effectivelyLocked } from "./layout.js";
import { todoPages } from "./todoPages.js";
import {
  panePages,
  activatePane,
  choosePanePage,
  createChecklistPage,
  appendPageObjects,
  editPageBlock,
  insertPageBlocks,
  deletePageTasks,
  takeOutToPage,
  writablePage,
  setPageDeadline,
} from "./arranged-model.js";
import { deadlineInfo } from "../../shared/deadline.js";
import {
  TaskDeadlineButton,
  TaskDeadlineDialog,
  formatDeadline,
  useDeadlineClock,
} from "./TaskDeadline.jsx";
import { HoverText } from "./ChecklistParts.jsx";
import ProjectTabs from "./ProjectTabs.jsx";
import { EditableBlock, RichText } from "./Note.jsx";
import { TodoActions, ChecklistMenu, useTodoTools } from "./TodoTools.jsx";
import { Modal } from "./Panels.jsx";
import ImageContent from "./ImageContent.jsx";
import { parseClipboard } from "./paste.js";
import { prepareImageFile } from "./image-import.js";
import TaskCompletionMotion from "./TaskCompletionMotion.jsx";
import { captureCompletionSource } from "./taskCompletionMotion.js";
import "./arranged.css";

const sideLabel = (side) => (side === "left" ? "左侧" : "右侧");
const isEditor = (target) =>
  target.closest("input,textarea,[contenteditable=true]");

function DraftRow({ onCommit, onClose, apiRef, label }) {
  const input = useRef(null),
    composing = useRef(false),
    saved = useRef(false);
  const [text, setText] = useState("");
  const save = () => {
    if (composing.current) return false;
    if (saved.current) return true;
    const value = input.current.value.trim();
    if (value && !onCommit(value)) return false;
    saved.current = true;
    onClose();
    return true;
  };
  apiRef.current = { save };
  useLayoutEffect(() => {
    input.current.focus();
  }, []);
  useLayoutEffect(() => {
    input.current.style.height = "0px";
    input.current.style.height = `${Math.max(32, input.current.scrollHeight)}px`;
  }, [text]);
  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [],
  );
  return (
    <div className="todo-draft">
      <span className="todo-circle" aria-hidden="true" />
      <textarea
        ref={input}
        value={text}
        aria-label={`${label}新待办内容`}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (
            composing.current ||
            e.nativeEvent.isComposing ||
            e.keyCode === 229
          )
            return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            saved.current = true;
            onClose();
          }
        }}
      />
    </div>
  );
}

function ChecklistPane({
  side,
  page,
  active,
  workspace,
  boardId,
  blocked,
  editing,
  onEdit,
  onExit,
  selected,
  onSelect,
  onCreate,
  onCollect,
  onPickImages,
  onReference,
  onReferencePicker,
  onImagePreview,
  onCollection,
  onActivate,
  assetUrls,
  objectMap,
  apiRef,
  onToast,
  clock,
  onDeadline,
  activeMotions,
  onCompletion,
}) {
  const { state, update } = workspace;
  const root = useRef(null),
    draftApi = useRef(null);
  const [draft, setDraft] = useState(false),
    [revision, setRevision] = useState(0),
    [located, setLocated] = useState(null);
  const todoTools = useTodoTools();
  const frozen =
    blocked ||
    !page ||
    (page.group && effectivelyLocked(state.objects, page.group.id));
  const pending = page?.tasks.filter((t) => !t.block.done) || [],
    completed = page?.tasks.filter((t) => t.block.done) || [];
  const label = sideLabel(side);
  const addTodo = (text) => {
    if (workspace.readOnly || !page) return false;
    const note = {
      ...createObject(boardId, "note"),
      noteKind: "checklist",
      blocks: parseClipboard(text),
    };
    if (!note.blocks.length) return true;
    update((s) => appendPageObjects(s, boardId, page.id, [note]));
    if (!workspace.current.current.objects.some((o) => o.id === note.id)) {
      onToast("这块灵感板暂时无法编辑，输入内容仍保留在当前栏。");
      return false;
    }
    return true;
  };
  const edit = (task) => {
    if (frozen || task.locked) return;
    onSelect(side, [task.key]);
    onExit();
    onEdit(task.note.id, task.key);
  };
  apiRef.current = {
    addNote: () => {
      if (!frozen) {
        onExit();
        setDraft(true);
      } else if (!page) onCreate(side);
    },
    flushDraft: () => draftApi.current?.save() ?? true,
    editSelected: () => {
      const task = page?.tasks.find(
        (t) => selected.includes(t.key) && t.block.done === (side === "right"),
      );
      if (task) edit(task);
    },
    locate: (objectId) => setLocated(objectId),
    element: root.current,
  };
  useEffect(() => {
    if (!located) return;
    const node = [
      ...(root.current?.querySelectorAll("[data-object-id]") || []),
    ].find((el) => el.dataset.objectId === located);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => setLocated(null), 2200);
    return () => clearTimeout(timer);
  }, [located]);
  const renderTask = (task) => {
    const text = blockText(task.block),
      deadline = deadlineInfo(task.block, clock),
      isEditing =
        editing?.noteId === task.note.id && editing.blockId === task.key;
    return (
      <div
        key={task.key}
        data-task-id={task.key}
        data-object-id={task.note.id}
        data-deadline={deadline.status}
        className={`todo-row ${task.block.done ? "is-done" : ""} ${selected.includes(task.key) ? "is-selected" : ""} ${located === task.note.id ? "located" : ""}`}
        onContextMenu={(e) => {
          if (!isEditor(e.target))
            todoTools?.showMenu(e, [task.note], task.key, frozen);
        }}
        onPointerDown={(e) => {
          if (!e.target.closest("button,input,textarea,[contenteditable=true]"))
            onSelect(
              side,
              e.shiftKey
                ? selected.includes(task.key)
                  ? selected.filter((k) => k !== task.key)
                  : [...selected, task.key]
                : [task.key],
            );
        }}
      >
        <span className="todo-deadline-glow" aria-hidden="true" />
        <button
          className="todo-circle"
          role="checkbox"
          aria-checked={task.block.done}
          aria-label={`${task.block.done ? "取消完成" : "完成"}：${text || "空白待办"}`}
          disabled={frozen || task.locked}
          onClick={(e) => {
            onExit();
            if (
              !writablePage(
                workspace.current.current,
                boardId,
                page.id,
              )?.tasks.some((t) => t.key === task.key && !t.locked)
            )
              return;
            const source =
              !task.block.done &&
              captureCompletionSource(e.currentTarget.closest(".todo-row"));
            workspace.toggleBlock(task.note.id, task.key);
            if (source)
              onCompletion({
                eventId: id("completion"),
                itemId: task.key,
                source,
                manual: true,
              });
          }}
        >
          {task.block.done && <Check size={12} />}
        </button>
        <div className="todo-main">
          <div className="todo-copy" onDoubleClick={() => edit(task)}>
            {isEditing && !frozen && !task.locked ? (
              <EditableBlock
                key={`${task.key}:${revision}`}
                block={task.block}
                index={task.index}
                checklist
                objects={objectMap}
                onChange={(block) => {
                  if (!workspace.readOnly)
                    update((s) =>
                      editPageBlock(
                        s,
                        boardId,
                        page.id,
                        task.note.id,
                        task.key,
                        block.runs,
                      ),
                    );
                }}
                onNew={(block, rest, extra) => {
                  const added = extra || [
                    {
                      ...makeBlock(),
                      runs: rest?.length ? rest : [{ type: "text", text: "" }],
                    },
                  ];
                  if (workspace.readOnly) return;
                  update((s) =>
                    insertPageBlocks(
                      s,
                      boardId,
                      page.id,
                      task.note.id,
                      task.key,
                      block,
                      added,
                    ),
                  );
                  setRevision((v) => v + 1);
                  onEdit(task.note.id, added.at(-1)?.id || task.key);
                }}
                onRemove={() =>
                  todoTools?.remove(task.note.id, task.key, frozen)
                }
                onExit={onExit}
                onReference={onReference}
                onReferencePicker={() =>
                  onReferencePicker(task.note.id, task.key)
                }
                autoFocus
              />
            ) : (
              <HoverText label={text || "空白待办"}>
                <RichText
                  runs={task.block.runs}
                  objects={objectMap}
                  onReference={onReference}
                />
              </HoverText>
            )}
          </div>
          {deadline.status !== "none" && (
            <div className="todo-deadline-meta">
              <time dateTime={task.block.dueAt}>
                {formatDeadline(task.block.dueAt)}
              </time>
              <span className="todo-deadline-status">{deadline.relative}</span>
            </div>
          )}
        </div>
        <div className="todo-row-tools">
          {task.locked && <LockKeyhole size={12} aria-label="已锁定" />}
          <button
            aria-label={`编辑待办：${text || "空白待办"}`}
            title="编辑待办"
            disabled={frozen || task.locked}
            onClick={() => edit(task)}
          >
            <Pencil size={13} />
          </button>
          <TodoActions
            note={task.note}
            block={task.block}
            frozen={frozen}
            showMenu={false}
          />
          <button
            aria-label={`收纳便签：${text || "空白待办"}`}
            title="收纳此便签的全部事项"
            disabled={frozen || task.locked}
            onClick={() => onCollect(page.id, [task.note.id])}
          >
            <Archive size={14} />
          </button>
        </div>
        <TaskDeadlineButton
          info={deadline}
          dueAt={task.block.dueAt}
          text={text}
          disabled={frozen || task.locked || workspace.readOnly}
          onClick={() => onDeadline(page.id, task)}
        />
      </div>
    );
  };
  return (
    <section
      className={`checklist-pane ${active ? "is-active" : ""}`}
      ref={root}
      data-pane={side}
      aria-label={`${label}清单${page ? `：${page.title}` : ""}`}
      onPointerDownCapture={() => onActivate(side)}
      onFocusCapture={() => onActivate(side)}
    >
      {!page ? (
        <div className="checklist-empty">
          <Frame size={30} strokeWidth={1.25} />
          <h2>{side === "left" ? "开始一个新项目" : "已完成"}</h2>
          <button
            className="button"
            disabled={workspace.readOnly}
            onClick={() => onCreate(side)}
          >
            <Plus size={15} />
            新建灵感板
          </button>
        </div>
      ) : (
        <div className="checklist-list">
          {side === "left" ? (
            <section
              className="todo-panel pending-panel"
              aria-label={`${label}未完成事项`}
            >
              <header>
                <h1>
                  未完成 <small>{pending.length}</small>
                </h1>
                <div className="checklist-panel-actions">
                  {page.group &&
                    effectivelyLocked(state.objects, page.group.id) && (
                      <LockKeyhole size={14} aria-label="灵感板已锁定" />
                    )}
                  <button
                    className="todo-panel-action"
                    aria-label={`添加${label}图片`}
                    title="添加本页图片"
                    disabled={frozen}
                    onClick={() => onPickImages(page.id)}
                  >
                    <ImagePlus size={16} />
                  </button>
                  <ChecklistMenu
                    notes={page.objects.filter((o) => o.type === "note")}
                    frozen={frozen}
                  />
                </div>
              </header>
              <div
                className="todo-panel-body"
                tabIndex={0}
                aria-label={`${label}未完成清单`}
              >
                {page.tasks.map((task) => {
                  if (!task.block.done) return renderTask(task);
                  const motion = activeMotions.find(
                    (m) => m.itemId === task.key,
                  );
                  return motion ? (
                    <div
                      key={task.key}
                      className="completion-source-placeholder"
                      data-completion-source={task.key}
                      aria-hidden="true"
                      style={{ height: motion.source.fromRect.height }}
                    />
                  ) : null;
                })}
                {draft ? (
                  <DraftRow
                    apiRef={draftApi}
                    label={label}
                    onCommit={addTodo}
                    onClose={() => setDraft(false)}
                  />
                ) : (
                  <button
                    className="todo-empty-row"
                    aria-label={`${label}添加待办`}
                    disabled={frozen}
                    onClick={() => {
                      onExit();
                      setDraft(true);
                    }}
                  >
                    <Plus size={18} />
                    <span>添加待办</span>
                  </button>
                )}
                {page.objects.some((o) => o.type === "image") && (
                  <details className="todo-attachments" open>
                    <summary>
                      本页资料 ·{" "}
                      {page.objects.filter((o) => o.type === "image").length}
                    </summary>
                    <div>
                      {page.objects
                        .filter((o) => o.type === "image")
                        .map((o) => (
                          <article
                            key={o.id}
                            data-object-id={o.id}
                            draggable={
                              !frozen && !effectivelyLocked(state.objects, o.id)
                            }
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                "application/x-qingdan-object",
                                JSON.stringify({ id: o.id }),
                              );
                              e.dataTransfer.effectAllowed = "move";
                            }}
                          >
                            <button
                              className="todo-image"
                              aria-label={`预览图片：${o.alt}`}
                              onClick={() =>
                                onImagePreview({
                                  object: o,
                                  url: assetUrls.get(o.assetId),
                                })
                              }
                            >
                              <ImageContent
                                object={o}
                                url={assetUrls.get(o.assetId)}
                              />
                            </button>
                            <div>
                              <span>{o.alt}</span>
                              <button
                                aria-label={`收纳图片：${o.alt}`}
                                disabled={
                                  frozen ||
                                  effectivelyLocked(state.objects, o.id)
                                }
                                onClick={() => onCollect(page.id, [o.id])}
                              >
                                <Archive size={14} />
                              </button>
                            </div>
                          </article>
                        ))}
                    </div>
                  </details>
                )}
                {page.objects.some((o) => o.type === "collection") && (
                  <div className="todo-boxes">
                    {page.objects
                      .filter((o) => o.type === "collection")
                      .map((o) => (
                        <div key={o.id} data-object-id={o.id}>
                          <button onClick={() => onCollection(o.id)}>
                            <Archive size={18} />
                            {o.title || "收纳框"}
                          </button>
                          <button
                            aria-label={`收纳箱子：${o.title}`}
                            disabled={
                              frozen || effectivelyLocked(state.objects, o.id)
                            }
                            onClick={() => onCollect(page.id, [o.id])}
                          >
                            <Archive size={14} />
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section
              className="todo-panel done-panel"
              aria-label={`${label}已完成事项`}
            >
              <header>
                <h1>
                  已完成 <small>{completed.length}</small>
                </h1>
              </header>
              <div
                className="todo-panel-body"
                tabIndex={0}
                aria-label={`${label}已完成清单`}
              >
                {completed.map((task) => (
                  <div key={task.key}>{renderTask(task)}</div>
                ))}
                {!completed.length && (
                  <p className="checklist-empty-done">完成的事项会留在这里</p>
                )}
                {activeMotions.map((m) => (
                  <div
                    key={m.eventId}
                    className="completion-target-buffer"
                    data-completion-buffer={m.eventId}
                    aria-hidden="true"
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

export default function ArrangedWorkspace({
  workspace,
  boardId,
  editing,
  onEdit,
  onExit,
  onCollection,
  onReference,
  onReferencePicker,
  onImagePreview,
  onToast,
  apiRef,
  blocked,
  dockedCollectionId,
}) {
  const { state, update } = workspace;
  const clock = useDeadlineClock(state.objects);
  const resolved = panePages(state, boardId);
  const panelId = useId();
  const [motions, setMotions] = useState([]);
  const activeMotions = motions.filter(
    (motion) =>
      motion.pageId === resolved.page?.id &&
      resolved.page.tasks.some(
        (task) => task.key === motion.itemId && task.block.done,
      ),
  );
  useEffect(() => {
    setMotions((list) =>
      list.filter(
        (motion) =>
          motion.pageId === resolved.page?.id &&
          resolved.page.tasks.some(
            (task) => task.key === motion.itemId && task.block.done,
          ),
      ),
    );
  }, [resolved.page?.id, state.objects]);
  const panes = useRef({ left: { current: null }, right: { current: null } });
  const main = useRef(null),
    composing = useRef(false),
    pendingNavigation = useRef(null),
    importToken = useRef(0),
    input = useRef(null),
    imagePage = useRef(null),
    pendingLocate = useRef(null);
  const [selected, setSelected] = useState({ side: "left", keys: [] });
  const [dialog, setDialog] = useState(null),
    [title, setTitle] = useState(""),
    [importing, setImporting] = useState(0);
  const objectMap = useMemo(
    () => new Map(state.objects.map((o) => [o.id, o])),
    [state.objects],
  );
  const assetUrls = useMemo(
    () =>
      new Map(
        [...workspace.assets].map(([key, blob]) => [
          key,
          URL.createObjectURL(blob),
        ]),
      ),
    [workspace.assets, workspace.assetVersion],
  );
  useEffect(
    () => () => {
      assetUrls.forEach((url) => URL.revokeObjectURL(url));
    },
    [assetUrls],
  );
  useEffect(
    () => () => {
      importToken.current++;
    },
    [],
  );
  const activate = (side) =>
    update((s) => activatePane(s, boardId, side), {
      record: false,
      navigation: true,
    });
  const navigate = (action) => {
    if (composing.current) {
      pendingNavigation.current = action;
      return;
    }
    if (
      !["left", "right"].every(
        (side) => panes.current[side].current?.flushDraft() ?? true,
      )
    )
      return;
    document.activeElement?.blur();
    onExit();
    action();
  };
  const choose = (side, pageId) =>
    navigate(() => {
      update((s) => choosePanePage(s, boardId, side, pageId), {
        record: false,
        navigation: true,
      });
      setSelected({ side, keys: [] });
    });
  const create = (side) =>
    navigate(() => {
      setTitle("");
      setDialog({ side, type: "create" });
    });
  const rename = (side, page) =>
    navigate(() => {
      setTitle(page.title);
      setDialog({ side, type: "rename", pageId: page.id });
    });
  const currentPage = () => {
    const live = panePages(workspace.current.current, boardId);
    return live[live.active];
  };
  const collect = (pageId, ids) => {
    if (blocked || workspace.readOnly) return;
    navigate(() => {
      const before = workspace.current.current;
      update((s) => {
        const page = writablePage(s, boardId, pageId);
        if (!page) return s;
        const allowed = ids.filter(
          (key) =>
            key === page.group?.id || page.objects.some((o) => o.id === key),
        );
        return collectObjects(s, allowed, dockedCollectionId);
      });
      if (workspace.current.current !== before) {
        setSelected({ side: resolved.active, keys: [] });
        onToast("已收纳，可在收纳框中取出。", {
          label: "撤销",
          run: () => {
            onExit();
            if (!workspace.undoIfLast(before))
              onToast("已有后续修改，请从收纳框中取出。 ");
          },
        });
      }
    });
  };
  const pasteText = (text, html = "", pageId = currentPage()?.id) => {
    if (blocked || !pageId) return;
    const blocks = parseClipboard(text, html);
    if (!blocks.length) return;
    const note = {
      ...createObject(boardId, "note"),
      noteKind: "checklist",
      blocks,
    };
    update((s) => appendPageObjects(s, boardId, pageId, [note]));
    if (workspace.current.current.objects.some((o) => o.id === note.id))
      onToast(`已粘贴 ${blocks.length} 条内容`);
  };
  const addImages = async (files, pageId = currentPage()?.id) => {
    if (
      workspace.readOnly ||
      !pageId ||
      !writablePage(workspace.current.current, boardId, pageId)
    )
      return;
    const accepted = [...files].filter(
      (file) =>
        /^image\/(png|jpeg|webp|gif)$/.test(file.type) &&
        file.size <= 10 * 1024 * 1024,
    );
    if (!accepted.length)
      return onToast("请选择 10 MB 以内的 PNG、JPG、WebP 或 GIF 图片。");
    if (accepted.length !== files.length)
      onToast("已跳过格式不支持或超过 10 MB 的图片。");
    const token = importToken.current;
    setImporting((n) => n + 1);
    try {
      const decoded = await Promise.all(
        accepted.map(async (original) => {
          const file = await prepareImageFile(original);
          const url = URL.createObjectURL(file);
          let size;
          try {
            size = await new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () =>
                resolve({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              image.onerror = () =>
                reject(new Error(`无法读取图片：${file.name}`));
              image.src = url;
            });
          } finally {
            URL.revokeObjectURL(url);
          }
          const key = id("asset"),
            scale = Math.min(1, 460 / size.width, 380 / size.height);
          return {
            key,
            file,
            meta: {
              id: key,
              name: file.name || "粘贴图片",
              mime: file.type,
              byteLength: file.size,
            },
            object: {
              ...createObject(boardId, "image"),
              assetId: key,
              alt: file.name || "粘贴图片",
              naturalWidth: size.width,
              naturalHeight: size.height,
              width: Math.max(1, size.width * scale),
              height: Math.max(1, size.height * scale),
            },
          };
        }),
      );
      if (token !== importToken.current || workspace.readOnly) return;
      if (!writablePage(workspace.current.current, boardId, pageId))
        return onToast("原灵感板已被收纳、删除或锁定，请重新选择图片。");
      await workspace.addAssets(decoded.map((d) => [d.key, d.file]));
      if (token !== importToken.current) return;
      update((s) => {
        const next = appendPageObjects(
          s,
          boardId,
          pageId,
          decoded.map((d) => d.object),
        );
        return next === s
          ? s
          : {
              ...next,
              assets: {
                ...s.assets,
                ...Object.fromEntries(decoded.map((d) => [d.key, d.meta])),
              },
            };
      });
      if (
        decoded.every((d) =>
          workspace.current.current.objects.some((o) => o.id === d.object.id),
        )
      )
        onToast(`已添加 ${decoded.length} 张图片`);
      else onToast("原灵感板暂时无法接收图片，请重试。");
    } catch (error) {
      if (token === importToken.current) onToast(error.message);
    } finally {
      if (token === importToken.current) setImporting((n) => n - 1);
    }
  };
  const takeOut = (objectId, pageId = currentPage()?.id) => {
    if (workspace.readOnly || !pageId) return;
    onExit();
    update((s) => takeOutToPage(s, boardId, pageId, objectId));
    const page = todoPages(workspace.current.current, boardId).find(
      (p) => p.id === objectId || p.objects.some((o) => o.id === objectId),
    );
    if (page) {
      const tasks = page.tasks.filter((task) => task.note.id === objectId);
      const side =
        tasks.length && tasks.every((task) => task.block.done)
          ? "right"
          : "left";
      choose(side, page.id);
      pendingLocate.current = { side, objectId };
    }
  };
  useLayoutEffect(() => {
    if (!pendingLocate.current) return;
    const { side, objectId } = pendingLocate.current;
    panes.current[side].current?.locate(objectId);
    pendingLocate.current = null;
  });
  apiRef.current = {
    isBlocked: () => !!dialog || blocked,
    beforeNavigate: navigate,
    addNote: () => {
      activate("left");
      panes.current.left.current?.addNote();
    },
    addImages,
    pasteText,
    takeOutArranged: takeOut,
    cancelImports: () => {
      importToken.current++;
    },
    editSelected: () => panes.current[resolved.active].current?.editSelected(),
    removeSelected: () => {
      const page = currentPage();
      if (blocked || dialog || !page || selected.side !== resolved.active)
        return;
      onExit();
      const keys = page.tasks
        .filter(
          (task) =>
            selected.keys.includes(task.key) &&
            task.block.done === (resolved.active === "right"),
        )
        .map((task) => task.key);
      update((s) => deletePageTasks(s, boardId, page.id, keys));
      setSelected({ side: resolved.active, keys: [] });
    },
    duplicateSelected: () => {
      const page = currentPage();
      if (blocked || dialog || !page || selected.side !== resolved.active)
        return;
      const blocks = page.tasks
        .filter(
          (t) =>
            selected.keys.includes(t.key) &&
            t.block.done === (resolved.active === "right"),
        )
        .map((t) => ({ ...structuredClone(t.block), id: id("b") }));
      if (blocks.length)
        update((s) =>
          appendPageObjects(s, boardId, page.id, [
            { ...createObject(boardId, "note"), noteKind: "checklist", blocks },
          ]),
        );
    },
    clearSelection: () => setSelected({ side: resolved.active, keys: [] }),
    selectAll: () => {
      const page = currentPage();
      if (page)
        setSelected({
          side: resolved.active,
          keys: page.tasks
            .filter((t) => t.block.done === (resolved.active === "right"))
            .map((t) => t.key),
        });
    },
    getPoint: () => {
      const page = currentPage();
      return { x: (page?.group?.x || 0) + 24, y: (page?.group?.y || 0) + 48 };
    },
    scrollTo: (objectId) => {
      const live = panePages(workspace.current.current, boardId),
        page = live.pages.find(
          (p) => p.id === objectId || p.objects.some((o) => o.id === objectId),
        );
      if (!page) return;
      const tasks = page.tasks.filter((task) => task.note.id === objectId);
      const side =
        tasks.length && tasks.every((task) => task.block.done)
          ? "right"
          : "left";
      choose(side, page.id);
      pendingLocate.current = { side, objectId };
    },
  };
  return (
    <main
      className="todo-document arranged-workspace"
      ref={main}
      aria-label="排列视图"
      tabIndex={-1}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        queueMicrotask(() => {
          const action = pendingNavigation.current;
          pendingNavigation.current = null;
          if (action) navigate(action);
        });
      }}
      onPaste={(e) => {
        if (e.defaultPrevented || isEditor(e.target) || blocked || dialog)
          return;
        e.preventDefault();
        const side =
            e.target.closest("[data-pane]")?.dataset.pane || resolved.active,
          pageId = resolved[side]?.id;
        if (e.clipboardData.files.length)
          void addImages([...e.clipboardData.files], pageId);
        else
          pasteText(
            e.clipboardData.getData("text/plain"),
            e.clipboardData.getData("text/html"),
            pageId,
          );
      }}
      onDragOver={(e) => {
        if (!blocked) e.preventDefault();
      }}
      onDrop={(e) => {
        if (blocked || dialog || isEditor(e.target)) return;
        e.preventDefault();
        const side =
            e.target.closest("[data-pane]")?.dataset.pane || resolved.active,
          pageId = resolved[side]?.id;
        if (!pageId) return;
        const raw = e.dataTransfer.getData("application/x-qingdan-object");
        if (raw) {
          let objectId = raw;
          try {
            objectId = JSON.parse(raw).id || raw;
          } catch {}
          takeOut(objectId, pageId);
        } else void addImages([...e.dataTransfer.files], pageId);
      }}
    >
      <ProjectTabs
        pages={resolved.pages}
        page={resolved.page}
        onChoose={(pageId) => choose("left", pageId)}
        onCreate={() => create("left")}
        readOnly={workspace.readOnly || blocked || !!dialog}
        panelId={panelId}
      />
      <div className="arranged-toolbar">
        <div className="arranged-project-heading">
          <Frame size={15} aria-hidden="true" />
          <span title={resolved.page?.title}>
            {resolved.page?.title || "项目清单"}
          </span>
          {resolved.page?.group && (
            <>
              <button
                aria-label="重命名当前灵感板"
                title="重命名灵感板"
                disabled={
                  blocked ||
                  workspace.readOnly ||
                  !writablePage(state, boardId, resolved.page.id)
                }
                onClick={() => rename("left", resolved.page)}
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label="收纳当前灵感板"
                title="收纳整个灵感板"
                disabled={
                  blocked ||
                  workspace.readOnly ||
                  !writablePage(state, boardId, resolved.page.id)
                }
                onClick={() =>
                  collect(resolved.page.id, [resolved.page.group.id])
                }
              >
                <Archive size={14} />
              </button>
            </>
          )}
        </div>
        <div>
          {importing > 0 && <span role="status">正在读取图片…</span>}
          <button
            aria-label="排列撤销"
            title="撤销"
            disabled={!workspace.canUndo || workspace.readOnly}
            onClick={() => navigate(workspace.undo)}
          >
            <Undo2 size={16} />
          </button>
          <button
            aria-label="排列重做"
            title="重做"
            disabled={!workspace.canRedo || workspace.readOnly}
            onClick={() => navigate(workspace.redo)}
          >
            <Redo2 size={16} />
          </button>
          <button
            className="arranged-collection"
            aria-label="打开排列收纳框"
            onClick={() => navigate(() => onCollection(dockedCollectionId))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (blocked) return;
              try {
                const data = JSON.parse(
                  e.dataTransfer.getData("application/x-qingdan-object"),
                );
                const page = todoPages(workspace.current.current, boardId).find(
                  (p) => p.objects.some((o) => o.id === data.id),
                );
                if (page) collect(page.id, [data.id]);
              } catch {}
            }}
          >
            <Archive size={16} />
            收纳框{" "}
            <span>
              {
                state.objects.filter((o) => o.parentId === dockedCollectionId)
                  .length
              }
            </span>
          </button>
        </div>
      </div>
      <div
        className="arranged-columns"
        role="tabpanel"
        id={panelId}
        aria-label={resolved.page?.title || "项目清单"}
      >
        {["left", "right"].map((side) => (
          <ChecklistPane
            key={`${side}:${resolved[side]?.id || "empty"}`}
            side={side}
            page={resolved[side]}
            active={resolved.active === side}
            workspace={workspace}
            boardId={boardId}
            blocked={blocked || !!dialog}
            editing={editing}
            onEdit={onEdit}
            onExit={onExit}
            selected={selected.side === side ? selected.keys : []}
            onSelect={(side, keys) => {
              activate(side);
              setSelected({ side, keys });
            }}
            onCreate={create}
            onCollect={collect}
            onPickImages={(pageId) => {
              imagePage.current = pageId;
              input.current.click();
            }}
            onReference={onReference}
            onReferencePicker={onReferencePicker}
            onImagePreview={onImagePreview}
            onCollection={onCollection}
            onActivate={activate}
            assetUrls={assetUrls}
            objectMap={objectMap}
            apiRef={panes.current[side]}
            onToast={onToast}
            clock={clock}
            activeMotions={activeMotions}
            onCompletion={(motion) =>
              setMotions((list) => [
                ...list,
                { ...motion, pageId: resolved.page.id },
              ])
            }
            onDeadline={(pageId, task) =>
              navigate(() =>
                setDialog({
                  type: "deadline",
                  pageId,
                  noteId: task.note.id,
                  blockId: task.key,
                  dueAt: task.block.dueAt ?? null,
                  title: blockText(task.block),
                }),
              )
            }
          />
        ))}
      </div>
      {activeMotions.map((entry) => (
        <TaskCompletionMotion
          key={entry.eventId}
          entry={entry}
          listElement={main.current}
          onFinished={() =>
            setMotions((list) =>
              list.filter((motion) => motion.eventId !== entry.eventId),
            )
          }
        />
      ))}
      <input
        type="file"
        ref={input}
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          void addImages([...e.target.files], imagePage.current);
          e.target.value = "";
        }}
      />
      {dialog?.type === "deadline" && (
        <TaskDeadlineDialog
          key={dialog.blockId}
          task={dialog}
          disabled={
            blocked ||
            workspace.readOnly ||
            !writablePage(state, boardId, dialog.pageId)?.tasks.some(
              (task) =>
                task.note.id === dialog.noteId &&
                task.key === dialog.blockId &&
                !task.locked,
            )
          }
          onClose={() => setDialog(null)}
          onSave={(dueAt) => {
            if (blocked || workspace.readOnly) return "这条待办当前无法编辑。";
            update((s) =>
              setPageDeadline(
                s,
                boardId,
                dialog.pageId,
                dialog.noteId,
                dialog.blockId,
                dueAt,
                dialog.dueAt,
              ),
            );
            const latest = writablePage(
              workspace.current.current,
              boardId,
              dialog.pageId,
            )?.tasks.find(
              (task) =>
                task.note.id === dialog.noteId &&
                task.key === dialog.blockId &&
                !task.locked,
            );
            if (!latest) return "这条待办已被锁定、收纳或删除，请关闭后重试。";
            if ((latest.block.dueAt ?? null) !== dueAt)
              return "截止时间已被协作者修改，请关闭弹窗后重新设置。";
            setDialog(null);
            return "";
          }}
        />
      )}
      {dialog && dialog.type !== "deadline" && (
        <Modal
          title={dialog.type === "create" ? "新建灵感板" : "重命名灵感板"}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim() || workspace.readOnly) return;
              onExit();
              if (dialog.type === "create") {
                update((s) => createChecklistPage(s, boardId, title));
                const created = workspace.current.current.objects.at(-1);
                if (created?.type === "frame") choose(dialog.side, created.id);
              } else
                update((s) =>
                  writablePage(s, boardId, dialog.pageId)
                    ? patchObjects(s, {
                        [dialog.pageId]: { title: title.trim() },
                      })
                    : s,
                );
              setDialog(null);
            }}
          >
            <input
              className="text-field"
              autoFocus
              aria-label="灵感板名称"
              value={title}
              maxLength={80}
              placeholder="例如：产品想法、生活计划"
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="modal-actions">
              <button
                className="button primary"
                disabled={!title.trim() || workspace.readOnly}
                type="submit"
              >
                {dialog.type === "create" ? "创建灵感板" : "保存名称"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
