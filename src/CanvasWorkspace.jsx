import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  StickyNote,
  ListChecks,
  ImagePlus,
  Frame,
  Undo2,
  Redo2,
  Maximize,
  Share2,
  Download,
  Search,
  X,
  Trash2,
  Copy,
  LockKeyhole,
  Unlock,
  HelpCircle,
  Type,
  Palette,
  Link2,
  Folder,
  ArrowUpFromLine,
  ArrowDownToLine,
  Columns2,
} from "lucide-react";
import Canvas from "./canvas/Canvas.jsx";
import ArrangedWorkspace from "./canvas/ArrangedWorkspace.jsx";
import { setSurface } from "./canvas/arranged-model.js";
import ContextMenu from "./canvas/ContextMenu.jsx";
import { TodoToolsProvider } from "./canvas/TodoTools.jsx";
import {
  CollectionPanel,
  SearchPanel,
  HelpPanel,
  TrashPanel,
  Modal,
} from "./canvas/Panels.jsx";
import {
  createInspirationBoard,
  patchObjects,
  deleteObjects,
  duplicateObjects,
  takeOutObject,
  deleteCollectedObjects,
  getView,
  restoreTrash,
  objectLabel,
} from "./canvas/model.js";
import { primaryCollection } from "./canvas/collectionDock.js";
import {
  ancestors,
  effectivelyLocked,
  placeBoardObjects,
} from "./canvas/layout.js";
import {
  buildCanvasMenu,
  applyCanvasMenuAction,
  groupTargets,
  noteColors,
} from "./canvas/context-menu.js";
import { fitView, screenToWorld } from "./canvas/geometry.js";
import { exportArchive, downloadBlob } from "./canvas/backup.js";
import { useRoomWorkspace } from "./sync/useRoomWorkspace.js";
import { api, inviteLink } from "./api.js";

const contextIcons = {
  "new-note": StickyNote,
  "new-checklist": ListChecks,
  paste: Copy,
  image: ImagePlus,
  fit: Maximize,
  help: HelpCircle,
  edit: Type,
  convert: ListChecks,
  reference: Link2,
  backlinks: Link2,
  colors: Palette,
  rename: Type,
  duplicate: Copy,
  group: Frame,
  join: Folder,
  detach: ArrowUpFromLine,
  front: ArrowUpFromLine,
  back: ArrowDownToLine,
  lock: LockKeyhole,
  unlock: Unlock,
  delete: Trash2,
  dissolve: Trash2,
};

export default function CanvasWorkspace({
  room,
  user,
  initialInvite,
  onLeave,
}) {
  const workspace = useRoomWorkspace(room, user);
  const { state, update, readOnly } = workspace;
  const [selection, setSelection] = useState([]),
    [editing, setEditing] = useState(null);
  const [context, setContext] = useState(null),
    [panel, setPanel] = useState(null),
    [collection, setCollection] = useState(null);
  const [toast, setToast] = useState(null),
    [share, setShare] = useState(
      () =>
        initialInvite ||
        sessionStorage.getItem(`qingdan.invite.${user.id}/${room.id}`) ||
        "",
    );
  const [sharing, setSharing] = useState(false),
    [imagePreview, setImagePreview] = useState(null);
  const [reference, setReference] = useState(null);
  const [menuDialog, setMenuDialog] = useState(null),
    [nameDraft, setNameDraft] = useState("");
  const canvas = useRef(null),
    imageInput = useRef(null),
    imagePoint = useRef(null),
    toastTimer = useRef(null);
  const composing = useRef(false),
    pendingMode = useRef(null);
  const showToast = useCallback((text, action) => {
    clearTimeout(toastTimer.current);
    setToast({ text, action });
    toastTimer.current = setTimeout(() => setToast(null), action ? 8000 : 4000);
  }, []);
  const exitEdit = useCallback(() => {
    setEditing(null);
    workspace.end();
  }, [workspace.end]);
  const view = state ? getView(state, room.id) : {};
  const arranged = view.surface === "arranged";
  const switchSurface = (surface) => {
    if (composing.current) {
      pendingMode.current = surface;
      return;
    }
    const apply = () => {
      document.activeElement?.blur();
      exitEdit();
      canvas.current?.cancelImports?.();
      setSelection([]);
      setContext(null);
      setCollection(null);
      setMenuDialog(null);
      update((s) => setSurface(s, room.id, surface), {
        record: false,
        navigation: true,
      });
    };
    if (arranged) canvas.current?.beforeNavigate(apply);
    else apply();
  };
  const onView = (next) =>
    update(
      (s) => ({
        ...s,
        preferences: {
          ...s.preferences,
          views: { ...s.preferences.views, [room.id]: next },
        },
      }),
      { record: false, navigation: true },
    );
  const add = (kind, point, frameId) => {
    if (readOnly) return;
    exitEdit();
    if (kind === "image") {
      imagePoint.current = point;
      imageInput.current.click();
      return;
    }
    if (kind === "text" || kind === "checklist")
      canvas.current?.addNote(kind, point, frameId);
    else if (kind === "frame") {
      const size = canvas.current?.getSize() || {
        width: innerWidth,
        height: innerHeight - 64,
      };
      const center = screenToWorld(
        { x: size.width / 2, y: size.height / 2 },
        view,
      );
      const object = createInspirationBoard(room.id);
      object.x = point?.x ?? center.x - object.width / 2;
      object.y = point?.y ?? center.y - object.height / 2;
      update((s) =>
        placeBoardObjects({ ...s, objects: [...s.objects, object] }, [
          object.id,
        ]),
      );
      const placed = workspace.current.current.objects.find(
        (o) => o.id === object.id,
      );
      if (!placed) return;
      const scale = Math.max(
        0.1,
        Math.min(
          view.scale,
          (size.width - 128) / placed.width,
          (size.height - 100) / placed.height,
        ),
      );
      onView({
        ...view,
        scale,
        x: size.width / 2 - (placed.x + placed.width / 2) * scale,
        y: size.height / 2 - (placed.y + placed.height / 2) * scale,
      });
      setSelection([object.id]);
    }
  };
  const fit = () =>
    onView(
      fitView(
        state.objects.filter((o) => !o.parentId),
        innerWidth,
        innerHeight - 64,
        view,
      ),
    );
  const remove = () => {
    if (arranged) {
      canvas.current?.removeSelected();
      return;
    }
    exitEdit();
    update((s) =>
      deleteObjects(
        s,
        selection.filter((id) => id !== `${room.id}-root`),
      ),
    );
    setSelection([]);
  };
  const locate = (id) => {
    const object = workspace.current.current.objects.find((o) => o.id === id);
    if (!object) return;
    setPanel(null);
    const parents = ancestors(workspace.current.current.objects, id);
    const enclosingCollection = parents.find((o) => o.type === "collection");
    if (enclosingCollection) {
      setCollection(enclosingCollection.id);
      return;
    }
    if (arranged) {
      canvas.current?.scrollTo(id);
      return;
    }
    const collapsed = parents.filter((o) => o.type === "frame" && o.collapsed);
    if (collapsed.length)
      update((s) =>
        patchObjects(
          s,
          Object.fromEntries(
            collapsed.map((o) => [o.id, { collapsed: false }]),
          ),
        ),
      );
    const size = canvas.current?.getSize() || {
      width: innerWidth,
      height: innerHeight - 64,
    };
    onView({
      ...view,
      x: size.width / 2 - (object.x + object.width / 2) * view.scale,
      y: size.height / 2 - (object.y + object.height / 2) * view.scale,
    });
    setSelection([id]);
  };
  const backup = async () => {
    try {
      const bytes = await exportArchive(
        workspace.current.current,
        workspace.assets,
      );
      downloadBlob(
        new Blob([bytes], { type: "application/zip" }),
        `${room.name}.qingdan`,
      );
      showToast("已导出包含图片的画布备份");
    } catch (err) {
      showToast(err.message);
    }
  };
  const pickReference = (noteId, blockId) => {
    exitEdit();
    setReference({ noteId, blockId });
    setPanel("reference");
  };
  const insertReference = (target) => {
    const note = workspace.current.current.objects.find(
      (o) => o.id === reference.noteId,
    );
    if (!note || effectivelyLocked(workspace.current.current.objects, note.id))
      return;
    const blocks = note.blocks.map((block) => {
      if (block.id !== reference.blockId) return block;
      const runs = block.runs.map((run) => ({ ...run }));
      if (runs.at(-1)?.type === "text")
        runs.at(-1).text = runs.at(-1).text.replace(/\[$/, "");
      runs.push({
        type: "ref",
        targetId: target.id,
        label: objectLabel(target),
      });
      return { ...block, runs };
    });
    update((s) => patchObjects(s, { [note.id]: { blocks } }));
    setPanel(null);
    setReference(null);
  };
  const applyMenuAction = (action) => {
    exitEdit();
    const before = workspace.current.current;
    const previousIds = new Set(before.objects.map((o) => o.id));
    update((s) =>
      applyCanvasMenuAction(s, action, { boardId: room.id, readOnly }),
    );
    const objects = workspace.current.current.objects;
    if (["duplicate", "group"].includes(action.id)) {
      const created = objects
        .filter((o) => !previousIds.has(o.id))
        .map((o) => o.id);
      if (created.length) setSelection(created);
    } else if (action.id === "delete") {
      canvas.current?.animateCollection(before, workspace.current.current);
      setSelection([]);
    } else if (action.id === "dissolve") {
      setSelection((previous) =>
        previous.filter((id) => objects.some((o) => o.id === id)),
      );
    }
  };
  const pasteAt = async (point) => {
    try {
      canvas.current?.pasteText(
        await navigator.clipboard.readText(),
        "",
        point,
      );
    } catch {
      showToast("请按 Ctrl / ⌘ + V 粘贴到画布。");
    }
  };
  const runContextAction = (action) => {
    if (action.disabled) return;
    exitEdit();
    const object = workspace.current.current.objects.find(
      (o) => o.id === action.target.objectId,
    );
    const point = action.target.point;
    switch (action.id) {
      case "new-note":
        return add(
          "text",
          point,
          object?.type === "frame" ? object.id : undefined,
        );
      case "new-checklist":
        return add(
          "checklist",
          point,
          object?.type === "frame" ? object.id : undefined,
        );
      case "image":
        return add("image", point);
      case "paste":
        return void pasteAt(point);
      case "fit":
        return fit();
      case "help":
        return setPanel("help");
      case "edit":
        if (
          !object ||
          effectivelyLocked(workspace.current.current.objects, object.id)
        )
          return;
        setSelection([object.id]);
        workspace.begin();
        return setEditing({ noteId: object.id, blockId: object.blocks[0]?.id });
      case "reference":
        return pickReference(object.id, object.blocks[0]?.id);
      case "backlinks":
        setReference({ targetId: object.id });
        return setPanel("backlinks");
      case "rename":
        setNameDraft(object?.title || "");
        setMenuDialog(action);
        return;
      case "colors":
      case "join":
        return setMenuDialog(action);
      default:
        return applyMenuAction(action);
    }
  };
  useEffect(() => {
    const key = (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPanel("search");
        return;
      }
      if (
        panel ||
        menuDialog ||
        context ||
        readOnly ||
        canvas.current?.isBlocked?.()
      )
        return;
      if (
        arranged &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        canvas.current?.selectAll();
        return;
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        event.target.closest("button,[role=option]")
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        exitEdit();
        event.shiftKey ? workspace.redo() : workspace.undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        exitEdit();
        if (arranged) canvas.current?.duplicateSelected();
        else update((s) => duplicateObjects(s, selection));
      } else if (
        event.key.toLowerCase() === "n" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        add("text");
      } else if (event.key === "Enter" && arranged) {
        event.preventDefault();
        canvas.current?.editSelected();
      } else if (event.key === "Enter" && selection.length === 1) {
        const note = state.objects.find((o) => o.id === selection[0]);
        if (
          note?.type === "note" &&
          !effectivelyLocked(state.objects, note.id)
        ) {
          workspace.begin();
          setEditing({ noteId: note.id, blockId: note.blocks[0]?.id });
        }
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        remove();
      } else if (event.key === "Escape") {
        exitEdit();
        setSelection([]);
        canvas.current?.clearSelection?.();
        setCollection(null);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  const shareNow = async (rotate = false) => {
    setPanel("share");
    if (share && !rotate) return;
    setSharing(true);
    try {
      const result = await api(`/api/rooms/${room.id}/invite`, {
        method: "POST",
        body: {},
      });
      setShare(inviteLink(room.id, result.invite));
    } catch (err) {
      showToast(err.message);
    } finally {
      setSharing(false);
    }
  };
  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(share);
      showToast("邀请链接已复制");
    } catch {
      showToast("请选中邀请链接并复制");
    }
  };
  useEffect(() => {
    if (share)
      sessionStorage.setItem(`qingdan.invite.${user.id}/${room.id}`, share);
  }, [user.id, room.id, share]);
  if (!state)
    return (
      <div className="loading-screen">
        <span className="brand-mark" />
        <p>{workspace.error || "正在打开画布…"}</p>
        <button onClick={onLeave}>返回画布列表</button>
      </div>
    );
  const container = state.objects.find((o) => o.id === collection);
  const label = {
    loading: "连接中",
    saved: "已同步",
    saving: "同步中",
    uploading: "图片上传中",
    offline: "离线 · 保留草稿",
    conflict: "需要处理冲突",
    error: "尚未同步",
  }[workspace.status];
  const members = [
    ...new Map(workspace.members.map((m) => [m.userId, m])).values(),
  ];
  return (
    <TodoToolsProvider
      workspace={workspace}
      scope={`${room.id}:${arranged ? "arranged" : "canvas"}`}
      beforeAction={exitEdit}
      onToast={showToast}
    >
      <div
        className="app-shell cloud-canvas"
        onCompositionStartCapture={() => {
          composing.current = true;
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
          queueMicrotask(() => {
            const surface = pendingMode.current;
            pendingMode.current = null;
            if (surface) switchSurface(surface);
          });
        }}
      >
        <nav className="topbar" aria-label="画布导航">
          <div className="nav-start">
            <button
              className="icon-button"
              title="所有画布"
              aria-label="返回画布列表"
              onClick={onLeave}
            >
              <ArrowLeft size={19} />
            </button>
            <a
              className="brand"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onLeave();
              }}
            >
              <span className="brand-mark" />
              <span>轻单</span>
            </a>
            <span className="nav-divider" />
            <span className="board-title">{room.name}</span>
            <span
              className={`sync-indicator ${workspace.status}`}
              role="status"
            >
              <span className="status-dot" />
              {label}
            </span>
          </div>
          <div
            className="view-mode-switch"
            role="group"
            aria-label="工作区视图"
          >
            <button
              aria-pressed={!arranged}
              onClick={() => switchSurface("canvas")}
            >
              <Frame size={14} />
              画布
            </button>
            <button
              aria-pressed={arranged}
              onClick={() => switchSurface("arranged")}
            >
              <Columns2 size={14} />
              排列
            </button>
          </div>
          <div className="nav-end">
            <div
              className="presence"
              aria-label={`${members.length} 位成员在线`}
            >
              {members.slice(0, 4).map((member, i) => (
                <span
                  className={`avatar avatar-${i}`}
                  key={member.userId}
                  title={
                    member.name + (member.userId === user.id ? "（我）" : "")
                  }
                >
                  {member.name.slice(0, 1)}
                </span>
              ))}
              <span>{members.length} 人在线</span>
            </div>
            <button
              className="icon-button hide-small"
              aria-label="搜索画布"
              title="搜索 · Ctrl K"
              onClick={() => setPanel("search")}
            >
              <Search size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="导出备份"
              title="导出含图片的备份"
              onClick={backup}
            >
              <Download size={18} />
            </button>
            <button
              className="icon-button hide-small"
              aria-label="回收站"
              title="此浏览器的回收站"
              onClick={() => setPanel("trash")}
            >
              <Trash2 size={17} />
            </button>
            <button
              className="help-button"
              aria-label="帮助"
              aria-haspopup="dialog"
              title="轻单使用 tips"
              onClick={() => {
                exitEdit();
                setPanel("help");
              }}
            >
              <HelpCircle size={17} />
              <span>帮助</span>
            </button>
            <button
              className="primary share-button"
              disabled={room.role !== "owner"}
              title={
                room.role === "owner" ? "邀请成员协作" : "请创建者分享邀请链接"
              }
              onClick={() => void shareNow()}
            >
              <Share2 size={16} />
              邀请协作
            </button>
          </div>
        </nav>
        {arranged ? (
          <ArrangedWorkspace
            workspace={workspace}
            boardId={room.id}
            editing={editing}
            onEdit={(noteId, blockId) => {
              workspace.begin();
              setEditing({ noteId, blockId });
            }}
            onExit={exitEdit}
            onCollection={setCollection}
            onReference={locate}
            onReferencePicker={pickReference}
            onImagePreview={setImagePreview}
            onToast={showToast}
            apiRef={canvas}
            blocked={readOnly || !!panel || !!menuDialog}
            dockedCollectionId={primaryCollection(state, room.id)?.id}
          />
        ) : (
          <Canvas
            workspace={workspace}
            boardId={room.id}
            view={view}
            onView={onView}
            selection={selection}
            setSelection={setSelection}
            editing={editing}
            onEdit={(noteId, blockId) => {
              workspace.begin();
              setEditing({ noteId, blockId });
            }}
            onExit={exitEdit}
            onContext={(event) => {
              if (!event.objectId) setSelection([]);
              setContext(event);
            }}
            onCollection={setCollection}
            onReference={locate}
            onReferencePicker={pickReference}
            onImagePreview={setImagePreview}
            onToast={showToast}
            onPasteFeedback={(_id, _text, count) =>
              showToast(`已粘贴 ${count} 条内容`)
            }
            onPickImages={() => imageInput.current.click()}
            apiRef={canvas}
            blocked={readOnly || !!panel || !!menuDialog}
            dockedCollectionId={primaryCollection(state, room.id)?.id}
          />
        )}
        {!arranged && (
          <div className="canvas-toolbox" aria-label="画布工具">
            <button
              disabled={readOnly}
              onClick={() => add("text")}
              title="新建便签"
              aria-label="新建便签"
            >
              <StickyNote size={21} />
              <span>便签</span>
            </button>
            <button
              disabled={readOnly}
              onClick={() => add("checklist")}
              title="新建清单"
              aria-label="新建清单"
            >
              <ListChecks size={21} />
              <span>清单</span>
            </button>
            <button
              disabled={readOnly}
              onClick={() => add("image")}
              title="添加图片"
              aria-label="添加图片"
            >
              <ImagePlus size={21} />
              <span>图片</span>
            </button>
            <button
              disabled={readOnly}
              onClick={() => add("frame")}
              title="新建灵感板"
              aria-label="新建灵感板"
            >
              <Frame size={21} />
              <span>灵感板</span>
            </button>
            <i />
            <button
              disabled={!workspace.canUndo || readOnly}
              onClick={() => {
                exitEdit();
                workspace.undo();
              }}
              aria-label="撤销"
            >
              <Undo2 size={19} />
            </button>
            <button
              disabled={!workspace.canRedo || readOnly}
              onClick={() => workspace.redo()}
              aria-label="重做"
            >
              <Redo2 size={19} />
            </button>
          </div>
        )}
        {!arranged && (
          <div className="canvas-view-tools">
            <button
              onClick={fit}
              title="适应全部内容"
              aria-label="适应全部内容"
            >
              <Maximize size={16} />
            </button>
            <span>{Math.round(view.scale * 100)}%</span>
          </div>
        )}
        {workspace.error && !workspace.conflict && (
          <div className="canvas-banner" role="alert">
            {workspace.error}
            <button onClick={workspace.retry}>重试</button>
            <button onClick={backup}>导出备份</button>
          </div>
        )}
        {workspace.conflict && (
          <div className="canvas-banner conflict" role="alert">
            <span>{workspace.conflict}</span>
            <button onClick={backup}>先导出草稿</button>
            <button onClick={() => workspace.resolve("local")}>
              保留我的冲突内容
            </button>
            <button onClick={() => workspace.resolve("remote")}>
              使用共享冲突内容
            </button>
          </div>
        )}
        {context && (
          <ContextMenu
            anchor={context.screen}
            onClose={() => setContext(null)}
            items={buildCanvasMenu({
              state,
              context,
              selection,
              boardId: room.id,
              readOnly,
            }).map((item) => {
              if (item.separator) return item;
              const Icon = contextIcons[item.id];
              return {
                ...item,
                icon: <Icon size={15} />,
                action: () => runContextAction(item),
              };
            })}
          />
        )}
        {menuDialog?.id === "rename" && (
          <Modal title="重命名" onClose={() => setMenuDialog(null)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                applyMenuAction({ ...menuDialog, value: nameDraft });
                setMenuDialog(null);
              }}
            >
              <input
                className="text-field"
                aria-label="名称"
                value={nameDraft}
                maxLength={80}
                onChange={(event) => setNameDraft(event.target.value)}
              />
              <div className="modal-actions">
                <button
                  className="button primary"
                  type="submit"
                  disabled={
                    readOnly ||
                    effectivelyLocked(state.objects, menuDialog.target.objectId)
                  }
                >
                  保存名称
                </button>
              </div>
            </form>
          </Modal>
        )}
        {menuDialog?.id === "colors" && (
          <Modal title="便签颜色" onClose={() => setMenuDialog(null)}>
            <div className="color-options">
              {noteColors.map(([color, label]) => (
                <button
                  className={`color-option color-${color}`}
                  key={color}
                  disabled={readOnly}
                  onClick={() => {
                    applyMenuAction({ ...menuDialog, value: color });
                    setMenuDialog(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Modal>
        )}
        {menuDialog?.id === "join" && (
          <Modal title="加入分组" onClose={() => setMenuDialog(null)}>
            <div className="choice-list">
              {groupTargets(state, menuDialog.target.ids, room.id).map(
                (frame) => (
                  <button
                    key={frame.id}
                    disabled={readOnly}
                    onClick={() => {
                      applyMenuAction({ ...menuDialog, value: frame.id });
                      setMenuDialog(null);
                    }}
                  >
                    <Frame size={16} />
                    {frame.title}
                  </button>
                ),
              )}
              {!groupTargets(state, menuDialog.target.ids, room.id).length && (
                <p className="empty-results">没有可加入的分组。</p>
              )}
            </div>
          </Modal>
        )}
        {container && (
          <CollectionPanel
            container={container}
            state={state}
            workspace={workspace}
            position={{ x: 100, y: 100 }}
            onClose={() => setCollection(null)}
            editing={editing}
            onEdit={(noteId, blockId) => {
              workspace.begin();
              setEditing({ noteId, blockId });
            }}
            onExit={exitEdit}
            onReference={locate}
            onReferencePicker={pickReference}
            onTakeOut={(id) => {
              if (arranged) canvas.current?.takeOutArranged(id);
              else
                update((s) =>
                  takeOutObject(s, id, canvas.current.getPoint(), room.id),
                );
            }}
            onDelete={(id, ids) =>
              update((s) => deleteCollectedObjects(s, id, ids))
            }
          />
        )}
        {panel === "search" && (
          <SearchPanel
            state={state}
            boardId={room.id}
            onClose={() => setPanel(null)}
            onChoose={(object) => locate(object.id)}
          />
        )}
        {panel === "reference" && (
          <SearchPanel
            state={state}
            boardId={room.id}
            sourceId={reference.noteId}
            onClose={() => setPanel(null)}
            onChoose={insertReference}
          />
        )}
        {panel === "backlinks" && (
          <SearchPanel
            state={state}
            boardId={room.id}
            backlinks={reference.targetId}
            onClose={() => setPanel(null)}
            onChoose={(object) => locate(object.id)}
          />
        )}
        {panel === "trash" && (
          <TrashPanel
            state={state}
            readOnly={readOnly}
            onClose={() => setPanel(null)}
            onRestore={(id) => update((s) => restoreTrash(s, id))}
          />
        )}
        {panel === "help" && <HelpPanel onClose={() => setPanel(null)} />}
        {panel === "share" && (
          <div className="dialog-backdrop">
            <section
              className="dialog"
              role="dialog"
              aria-modal="true"
              aria-label="邀请协作"
            >
              <button
                className="dialog-close icon-button"
                aria-label="关闭"
                onClick={() => setPanel(null)}
              >
                <X size={20} />
              </button>
              <div className="eyebrow">好想法，值得一起完成</div>
              <h2>邀请同伴加入画布</h2>
              <p>获得链接的人可以查看和编辑此画布。</p>
              <label>
                邀请链接
                <textarea
                  readOnly
                  value={share || "正在生成邀请链接…"}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <button
                className="primary wide"
                onClick={copyShare}
                disabled={!share || sharing}
              >
                <Copy size={16} />
                复制邀请链接
              </button>
              <div className="share-note">
                重置会让旧链接失效，已加入的成员仍可访问。
              </div>
              <button
                className="text-button"
                disabled={sharing}
                onClick={() => void shareNow(true)}
              >
                重置邀请链接
              </button>
            </section>
          </div>
        )}
        {imagePreview && (
          <div className="image-lightbox" onClick={() => setImagePreview(null)}>
            <button aria-label="关闭预览">
              <X />
            </button>
            <img
              src={
                typeof imagePreview === "string"
                  ? imagePreview
                  : imagePreview.url
              }
              alt="图片预览"
            />
          </div>
        )}
        {toast && (
          <div className="toast cloud-toast" role="status">
            {toast.text}
            {toast.action && (
              <button onClick={toast.action.run}>{toast.action.label}</button>
            )}
          </div>
        )}
        <input
          ref={imageInput}
          hidden
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => {
            void canvas.current?.addImages(
              [...e.target.files],
              imagePoint.current,
            );
            imagePoint.current = null;
            e.target.value = "";
          }}
        />
      </div>
    </TodoToolsProvider>
  );
}
