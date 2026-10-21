import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Search,
  StickyNote,
  Image,
  Archive,
  Frame,
  ArrowUpRight,
  RotateCcw,
  LockKeyhole,
  ChevronLeft,
  ChevronRight,
  MousePointer2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  objectLabel,
  blockText,
  objectText,
  patchObjects,
  isContainer,
  movableIds,
} from "./model.js";
import Note from "./Note.jsx";
import ImageContent from "./ImageContent.jsx";
import { imageFrame } from "./images.js";
import { effectivelyLocked, ancestors } from "./layout.js";

function CollectedImage({ object, blob }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  const frame = imageFrame(object);
  return (
    <div
      className="collected-image"
      style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
    >
      <ImageContent object={object} url={url} />
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}) {
  const ref = useRef(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    (
      ref.current.querySelector("input,select,textarea") ||
      ref.current.querySelector("button")
    )?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,[tabindex="0"]',
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      previous?.isConnected && previous.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
const ObjectIcon = ({ type }) => {
  const Icon =
    { note: StickyNote, image: Image, collection: Archive, frame: Frame }[
      type
    ] || StickyNote;
  return <Icon size={17} strokeWidth={1.6} />;
};
export function SearchPanel({
  state,
  onClose,
  onChoose,
  sourceId,
  backlinks,
  boardId,
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(
    () =>
      state.objects
        .filter(
          (o) =>
            o.id !== sourceId &&
            (sourceId || backlinks ? o.type === "note" : true) &&
            (!backlinks ||
              o.blocks?.some((b) =>
                b.runs.some(
                  (r) => r.type === "ref" && r.targetId === backlinks,
                ),
              )) &&
            (
              objectText(o) +
              " " +
              state.boards.find((b) => b.id === o.boardId)?.name
            )
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => (b.boardId === boardId) - (a.boardId === boardId)),
    [state, query, sourceId, backlinks, boardId],
  );
  return (
    <Modal
      title={
        sourceId
          ? "插入便签引用"
          : backlinks
            ? "引用这张便签的内容"
            : "搜索画布"
      }
      onClose={onClose}
      wide
    >
      <div className="search-field">
        <Search size={18} />
        <input
          aria-label="搜索内容"
          placeholder="搜索文字、便签或项目…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <kbd>Esc</kbd>
      </div>
      <div className="search-results">
        {results.map((o) => (
          <button key={o.id} onClick={() => onChoose(o)}>
            <span className={`result-icon color-${o.color || "paper"}`}>
              <ObjectIcon type={o.type} />
            </span>
            <span className="result-copy">
              <strong>{objectLabel(o)}</strong>
              <small>
                {state.boards.find((b) => b.id === o.boardId)?.name}
                {o.parentId ? " · 已分组 / 收纳" : ""}
                {o.locked ? " · 已锁定" : ""}
              </small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
        {!results.length && <p className="panel-empty">没有找到相关内容</p>}
      </div>
      <footer className="dialog-footnote">
        {results.length} 个结果 · 选择后定位到画布
      </footer>
    </Modal>
  );
}
export function ProjectForm({ board, boards, onSubmit, onClose }) {
  const [name, setName] = useState(board?.name || ""),
    [type, setType] = useState(board?.type || ""),
    [error, setError] = useState("");
  return (
    <Modal title={board ? "重命名项目" : "新建项目"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!board && !type) return;
          const n = name.trim();
          if (!n || boards.some((b) => b.id !== board?.id && b.name === n)) {
            setError("请填写一个不重复的项目名称。");
            return;
          }
          onSubmit(n, type);
        }}
      >
        {!board && (
          <fieldset className="project-type-picker">
            <legend className="field-label">初始视图</legend>
            <div className="project-type-options">
              {[
                ["canvas", "画布", "自由摆放、拖动与缩放", MousePointer2],
                ["arranged", "Agent", "清单与 Agent 工作区", Sparkles],
              ].map(([value, label, description, Icon]) => (
                <label
                  key={value}
                  className={`project-type-option ${type === value ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="project-type"
                    value={value}
                    checked={type === value}
                    onChange={() => {
                      setType(value);
                      setError("");
                    }}
                  />
                  <Icon size={21} strokeWidth={1.6} />
                  <strong>{label}</strong>
                  <small>{description}</small>
                </label>
              ))}
            </div>
            <p className="project-type-hint">
              之后可在顶部随时切换，内容与画布位置保留。
            </p>
          </fieldset>
        )}
        <label className="field-label" htmlFor="project-name">
          项目名称
        </label>
        <input
          id="project-name"
          className="text-field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="为项目取个名字"
          disabled={!board && !type}
          maxLength={80}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!name.trim() || (!board && !type)}
          >
            {board ? "保存名称" : "创建项目"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function TrashPanel({
  state,
  onRestore,
  onClear,
  onClose,
  readOnly = false,
}) {
  const [confirming, setConfirming] = useState(false);
  const clearButton = useRef(null),
    cancelButton = useRef(null);
  const count = state.trash.reduce(
    (sum, batch) => sum + (batch.kind === "task" ? 1 : batch.objects.length),
    0,
  );
  const cancelClear = () => {
    setConfirming(false);
  };
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (count) clearButton.current?.focus();
    else
      clearButton.current
        ?.closest('[role="dialog"]')
        ?.querySelector('[aria-label="关闭弹窗"]')
        ?.focus();
  }, [confirming]);
  return (
    <Modal
      title="回收站"
      onClose={confirming ? cancelClear : onClose}
      className="trash-modal"
      wide
    >
      <div className="trash-toolbar">
        <p className="dialog-description">
          此浏览器的回收记录 · {count} 个已删除对象
        </p>
        <button
          ref={clearButton}
          className="button secondary compact trash-clear"
          aria-label="清空回收站"
          disabled={readOnly || !onClear || !count || confirming}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={14} />
          清空回收站
        </button>
      </div>
      <div className="search-results">
        {state.trash.map((batch) => (
          <div className="trash-row" key={batch.id}>
            <span className="result-icon">
              <RotateCcw size={17} />
            </span>
            <span className="result-copy">
              <strong>
                {batch.kind === "task"
                  ? `待办 · ${blockText(batch.task.block) || "空白事项"}`
                  : objectLabel(batch.objects[0])}
                {batch.objects.length > 1
                  ? ` 等 ${batch.objects.length} 个对象`
                  : ""}
              </strong>
              <small>{new Date(batch.deletedAt).toLocaleString("zh-CN")}</small>
              {batch.kind === "task" && batch.task.block.remark?.text && (
                <small className="trash-remark">
                  备注：{batch.task.block.remark.text}
                </small>
              )}
            </span>
            <button
              className="button secondary compact"
              disabled={readOnly || confirming}
              onClick={() => onRestore(batch.id)}
            >
              恢复
            </button>
          </div>
        ))}
        {!state.trash.length && <p className="panel-empty">回收站是空的</p>}
      </div>
      {confirming && (
        <div className="trash-confirm" role="group" aria-label="清空确认">
          <p>清空所有项目的 {count} 个已删除对象？</p>
          <p className="dialog-description">
            清空后可通过撤销恢复，刷新页面后无法恢复。
          </p>
          <div className="modal-actions">
            <button
              ref={cancelButton}
              className="button secondary"
              aria-label="取消清空"
              onClick={cancelClear}
            >
              取消
            </button>
            <button
              className="button danger-button"
              aria-label="确认清空回收站"
              disabled={readOnly || !onClear || !count}
              onClick={() => {
                onClear();
                setConfirming(false);
              }}
            >
              确认清空
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
export function CollectionPanel({
  located,
  container,
  state,
  workspace,
  position,
  onClose,
  onTakeOut,
  onDelete,
  onNavigate,
  editing,
  onEdit,
  onExit,
  onReference,
  onReferencePicker,
}) {
  const memberList = useRef(null);
  const [activeId, setActiveId] = useState(container.id);
  const boardObjects = state.objects.filter(
    (o) => o.boardId === container.boardId,
  );
  const objects = new Map(boardObjects.map((o) => [o.id, o]));
  const active = objects.get(activeId);
  const pathToRoot =
    active && isContainer(active)
      ? [active, ...ancestors(objects, activeId)]
      : [];
  const rootIndex = pathToRoot.findIndex((o) => o.id === container.id);
  const path =
    rootIndex >= 0 ? pathToRoot.slice(0, rootIndex + 1).reverse() : [container];
  const current = path.at(-1);
  useEffect(() => {
    setActiveId(container.id);
  }, [container.id]);
  useEffect(() => {
    if (!located) return;
    const parents = ancestors(objects, located);
    if (parents.some((o) => o.id === container.id)) setActiveId(parents[0].id);
  }, [located, container.id]);
  useEffect(() => {
    if (rootIndex < 0) setActiveId(container.id);
  }, [rootIndex, container.id]);
  useEffect(() => {
    if (located) {
      const node = [
        ...memberList.current.querySelectorAll("[data-member-id]"),
      ].find((el) => el.dataset.memberId === located);
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [located, current.id]);
  const members = boardObjects.filter((o) => o.parentId === current.id);
  const movable = movableIds(
    state,
    members.map((o) => o.id),
  );
  const navigate = (key) => {
    onExit();
    onNavigate?.();
    setActiveId(key);
  };
  return (
    <section
      className="collection-panel"
      style={{
        left: Math.max(8, Math.min(position.x, innerWidth - 350)),
        top: Math.max(70, Math.min(position.y, innerHeight - 380)),
      }}
      role="dialog"
      aria-label={container.title}
    >
      <header>
        <div>
          {path.length > 1 ? (
            <button
              className="icon-button"
              aria-label="返回上一级"
              onClick={() => navigate(path.at(-2).id)}
            >
              <ChevronLeft size={17} />
            </button>
          ) : (
            <Archive size={17} />
          )}
          <strong>{current.title}</strong>
          <small>{members.length}</small>
        </div>
        <div className="collection-actions">
          <button
            className="collection-clear"
            aria-label="清空当前收纳内容"
            title="移入回收站，锁定内容会保留"
            disabled={
              !onDelete ||
              workspace.readOnly ||
              !members.some((o) => movable.has(o.id))
            }
            onClick={() => onDelete(current.id)}
          >
            <Trash2 size={14} />
            清空
          </button>
          <button
            className="icon-button"
            aria-label="关闭收纳框"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      {path.length > 1 && (
        <nav className="collection-breadcrumb" aria-label="收纳路径">
          {path.map((item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 && <ChevronRight size={11} />}
              <button
                aria-current={item.id === current.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                {item.title}
              </button>
            </React.Fragment>
          ))}
        </nav>
      )}
      <div ref={memberList} className="collection-members">
        {members.map((note) => (
          <div
            className={`collection-member ${located === note.id ? "located" : ""}`}
            data-member-id={note.id}
            key={note.id}
            draggable={
              movable.has(note.id) &&
              !workspace.readOnly &&
              editing?.noteId !== note.id
            }
            onDragStart={(event) => {
              if (
                !movable.has(note.id) ||
                workspace.readOnly ||
                editing?.noteId === note.id
              ) {
                event.preventDefault();
                return;
              }
              onExit();
              event.dataTransfer.setData(
                "application/x-qingdan-object",
                note.id,
              );
              event.dataTransfer.effectAllowed = "move";
            }}
          >
            <div className="member-heading">
              <span>
                {!movable.has(note.id) ? (
                  <LockKeyhole size={13} />
                ) : (
                  <ObjectIcon type={note.type} />
                )}
              </span>
              <span>{objectLabel(note)}</span>
              <button
                className="icon-button"
                aria-label={`取出${objectLabel(note)}`}
                disabled={!movable.has(note.id) || workspace.readOnly}
                onClick={() => onTakeOut(note.id)}
              >
                <ArrowUpRight size={14} />
              </button>
              <button
                className="icon-button collection-delete"
                aria-label={`删除${objectLabel(note)}`}
                title="移入回收站"
                disabled={
                  !onDelete || !movable.has(note.id) || workspace.readOnly
                }
                onClick={() => onDelete(current.id, [note.id])}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {isContainer(note) ? (
              <button
                className="collected-container"
                aria-label={`打开${objectLabel(note)}`}
                onClick={() => navigate(note.id)}
              >
                <ObjectIcon type={note.type} />
                <span>
                  <strong>{objectLabel(note)}</strong>
                  <small>
                    {boardObjects.filter((o) => o.parentId === note.id).length}{" "}
                    项 · {note.type === "frame" ? "分组" : "收纳箱"} · 点击查看
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ) : note.type === "image" ? (
              <CollectedImage
                object={note}
                blob={workspace.assets.get(note.assetId)}
              />
            ) : (
              <Note
                object={
                  effectivelyLocked(state.objects, note.id)
                    ? { ...note, locked: true }
                    : note
                }
                editing={editing?.noteId === note.id}
                focusBlock={editing?.blockId}
                onEdit={(key) => !workspace.readOnly && onEdit(note.id, key)}
                onPatch={(patch) =>
                  workspace.update(
                    (s) => patchObjects(s, { [note.id]: patch }),
                    {
                      record: editing?.noteId !== note.id,
                    },
                  )
                }
                onExit={onExit}
                objects={objects}
                onReference={onReference}
                onReferencePicker={onReferencePicker}
                onToggle={(key) => workspace.toggleBlock(note.id, key)}
              />
            )}
          </div>
        ))}
        {!members.length && (
          <p className="panel-empty">
            {current.id === container.id
              ? "将元素任意边缘拖到收纳图标上，松手收纳。"
              : "这里还没有内容。"}
          </p>
        )}
      </div>
      <footer>拖出内容，放回画布 · 分组与收纳箱会整体取出</footer>
    </section>
  );
}
export function HelpPanel({ onClose }) {
  const groups = [
    {
      title: "自由画布",
      Icon: Frame,
      tips: [
        ["新建内容", "点左侧工具栏，添加便签、清单、图片或灵感板。"],
        ["画出灵感板", "按住 Ctrl + 左键拖动空白处。"],
        ["调整大小", "拖动元素右下角；拖板标题可整板移动。"],
        ["移动与缩放", "拖空白处平移；Ctrl / ⌘ + 滚轮缩放。"],
        ["多选元素", "按 Shift 点选，或右键拖动框选。"],
      ],
    },
    {
      title: "清单与排列",
      Icon: StickyNote,
      tips: [
        ["完成待办", "点击方框；点文字不会勾选。"],
        ["编辑文字", "双击进入编辑，Esc 结束。"],
        ["补充备注", "点事项旁的备注图标。"],
        ["两栏排列", "同一项目左侧是未完成待办，右侧是已完成待办。"],
        ["设置截止", "点待办右侧日历或圆环，设置、修改或移除时间。"],
        ["时间提醒", "24 小时内整框呼吸；超时变珊瑚色，完成后停止。"],
        ["切换项目", "点排列顶部的项目标签切换清单，点 + 新建灵感板。"],
      ],
    },
    {
      title: "收纳与恢复",
      Icon: Archive,
      tips: [
        ["纸团收纳", "右键「删除此元素」，自动飞入收纳箱。"],
        ["取回内容", "点左上收纳箱，再点取出。"],
        ["撤销重做", "Ctrl / ⌘ + Z 撤销；加 Shift 重做。"],
        ["回收站", "Delete 移入回收站，可在本机恢复。"],
        ["快速复制", "选中元素，按 Ctrl / ⌘ + D。"],
      ],
    },
    {
      title: "协作与保存",
      Icon: Sparkles,
      tips: [
        ["邀请协作", "创建者点「邀请协作」，分享链接。"],
        ["自动保存", "看到「已同步」，表示云端已保存。"],
        ["切换视图", "画布与排列使用同一份内容。"],
        ["快速查找", "Ctrl / ⌘ + K 搜索当前画布。"],
        ["导出备份", "点顶部下载图标，打包画布和图片。"],
      ],
    },
  ];
  return (
    <Modal title="轻单使用 tips" onClose={onClose} className="help-tips">
      <p className="help-tips-intro">画布自由整理，排列专注清单。</p>
      <div className="help-tip-grid">
        {groups.map(({ title, Icon, tips }) => (
          <section className="help-tip-group" key={title}>
            <h3>
              <Icon size={17} aria-hidden="true" />
              {title}
            </h3>
            <ul>
              {tips.map(([label, text]) => (
                <li key={label}>
                  <strong>{label}：</strong>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="help-tips-footer">按 Esc 或点击窗口外，继续记录。</p>
    </Modal>
  );
}
