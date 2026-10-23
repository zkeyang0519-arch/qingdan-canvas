import React, { memo, useLayoutEffect, useRef } from "react";
import { Plus, Link2, LockKeyhole } from "lucide-react";
import { makeBlock, blockText } from "./model.js";
import { parseClipboard } from "./paste.js";
import { referenceLabel } from "./referenceText.js";
import { TodoActions, ChecklistMenu, useTodoTools } from "./TodoTools.jsx";
import { TaskAuthorAvatar } from "./TaskAuthors.jsx";

export function RichText({ runs, objects, onReference }) {
  return runs.map((run, i) =>
    run.type === "text" ? (
      <React.Fragment key={i}>{run.text}</React.Fragment>
    ) : (
      <button
        key={i}
        className={`note-reference ${objects.has(run.targetId) ? "" : "unavailable"}`}
        data-ref={run.targetId}
        data-label={run.label}
        contentEditable={false}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onReference(run.targetId);
        }}
        aria-label={`引用：${referenceLabel(run, objects)}`}
      >
        <Link2 size={12} />
        {referenceLabel(run, objects)}
      </button>
    ),
  );
}
function readRuns(element) {
  const runs = [];
  const text = (value) => {
    if (!value) return;
    const last = runs.at(-1);
    if (last?.type === "text") last.text += value;
    else runs.push({ type: "text", text: value });
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      text(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.dataset.ref) {
      runs.push({
        type: "ref",
        targetId: node.dataset.ref,
        label: node.dataset.label || "便签引用",
      });
      return;
    }
    if (node.tagName === "BR") {
      text("\n");
      return;
    }
    if ((node.tagName === "DIV" || node.tagName === "P") && runs.length)
      text("\n");
    node.childNodes.forEach(visit);
  };
  element.childNodes.forEach(visit);
  return runs.length ? runs : [{ type: "text", text: "" }];
}
export function EditableBlock({
  block,
  index,
  checklist,
  objects,
  onChange,
  onNew,
  onRemove,
  onExit,
  onReference,
  onReferencePicker,
  autoFocus,
}) {
  const ref = useRef(null),
    composition = useRef(false),
    latest = useRef(block),
    initial = useRef(block.runs);
  latest.current = block;
  useLayoutEffect(() => {
    if (autoFocus) {
      ref.current.focus({ preventScroll: true });
      const selection = getSelection(),
        range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [autoFocus]);
  const sync = () =>
    onChange({ ...latest.current, runs: readRuns(ref.current) });
  return (
    <div
      ref={ref}
      className="block-editor"
      role="textbox"
      aria-label={checklist ? `编辑第 ${index + 1} 项` : "编辑便签正文"}
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-placeholder="写点什么…"
      onPointerDown={(e) => e.stopPropagation()}
      onCompositionStart={() => {
        composition.current = true;
      }}
      onCompositionEnd={() => {
        composition.current = false;
        sync();
      }}
      onInput={sync}
      onBlur={sync}
      onKeyDown={(event) => {
        if (
          composition.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          sync();
          onExit();
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const sel = getSelection();
          const range = sel.rangeCount ? sel.getRangeAt(0) : null;
          let rest = [];
          if (range && ref.current.contains(range.startContainer)) {
            range.deleteContents();
            const after = range.cloneRange();
            after.setEndAfter(ref.current.lastChild || ref.current);
            try {
              const fragment = after.extractContents();
              const holder = document.createElement("div");
              holder.append(fragment);
              rest = readRuns(holder);
            } catch {}
          }
          onNew({ ...latest.current, runs: readRuns(ref.current) }, rest);
        }
        if (
          event.key === "Backspace" &&
          !ref.current.textContent &&
          index > 0
        ) {
          event.preventDefault();
          onRemove();
        }
        if (event.key === "[" && ref.current.textContent?.endsWith("[")) {
          event.preventDefault();
          onReferencePicker();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        const html = event.clipboardData.getData("text/html");
        if (text.includes("\n") || (checklist && html.includes("<li"))) {
          const parsed = checklist
            ? parseClipboard(text, html)
            : text
                .replace(/\r\n?/g, "\n")
                .split("\n")
                .map((line) => makeBlock(line));
          const sel = getSelection();
          const range = sel.rangeCount ? sel.getRangeAt(0) : null;
          if (range && ref.current.contains(range.startContainer)) {
            range.deleteContents();
            const tail = range.cloneRange();
            tail.setEnd(ref.current, ref.current.childNodes.length);
            const holder = document.createElement("div");
            holder.append(tail.extractContents());
            const before = readRuns(ref.current),
              after = readRuns(holder);
            if (parsed.length) {
              parsed[0].runs = [...before, ...parsed[0].runs];
              parsed.at(-1).runs.push(...after);
            }
          }
          if (parsed.length) onNew(parsed[0], null, parsed.slice(1));
        } else {
          const sel = getSelection();
          if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            sync();
          }
        }
      }}
    >
      <RichText
        runs={initial.current}
        objects={objects}
        onReference={onReference}
      />
    </div>
  );
}

function Note({
  object,
  editing,
  focusBlock,
  onEdit,
  onPatch,
  onExit,
  objects,
  onReference,
  onReferencePicker,
  onMeasure,
  onToggle,
}) {
  const ref = useRef(null);
  const checkbox = object.noteKind === "checklist";
  const todoTools = useTodoTools();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      onMeasure?.(object.id, el.offsetHeight),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [object.id, onMeasure]);
  const patchBlock = (block) =>
    onPatch({
      blocks: object.blocks.map((b) =>
        b.id === block.id
          ? { ...block, spacer: !blockText(block).trim() && block.spacer }
          : b,
      ),
    });
  const createAfter = (index, current, rest, extra) => {
    const blocks = [...object.blocks];
    blocks[index] = { ...blocks[index], ...current, id: blocks[index].id };
    const inserted = extra || [
      {
        ...makeBlock(),
        runs: rest?.length ? rest : [{ type: "text", text: "" }],
      },
    ];
    blocks.splice(index + 1, 0, ...inserted);
    onPatch({ blocks });
    onEdit(inserted.at(-1)?.id || blocks[index].id);
  };
  return (
    <div
      ref={ref}
      className={`note-paper color-${object.color} ${editing ? "is-editing" : ""}`}
      style={{
        minHeight: object.height,
        ...(object.fixedHeight ? { height: object.height } : {}),
      }}
    >
      {object.locked && <LockKeyhole className="note-lock" size={13} />}
      {checkbox && (
        <ChecklistMenu notes={[object]} className="todo-note-menu" />
      )}
      <div className={`note-blocks ${checkbox ? "is-checklist" : "is-prose"}`}>
        {object.blocks.map((block, index) => (
          <div
            className={`note-block ${checkbox && block.done ? "is-done" : ""}`}
            key={block.id}
            data-task-id={block.id}
            onPointerDown={(event) => {
              // The canvas uses right-button gestures for object selection.
              // Keep a task's context menu from also opening that object menu.
              if (event.button === 2 && checkbox && todoTools)
                event.stopPropagation();
            }}
            onContextMenu={(event) => {
              if (
                !checkbox ||
                !todoTools ||
                event.target.closest("[contenteditable=true]")
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              todoTools.showMenu(event, [object], block.id);
            }}
          >
            {checkbox && (!block.spacer || editing) && (
              <TaskAuthorAvatar block={block} />
            )}
            {checkbox && (!block.spacer || editing) && (
              <input
                aria-label={`完成：${blockText(block) || "空白条目"}`}
                type="checkbox"
                checked={block.done}
                disabled={object.locked}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={() => onToggle(block.id)}
              />
            )}
            {editing ? (
              <EditableBlock
                key={`${block.id}-${focusBlock === block.id ? "focus" : "idle"}`}
                block={block}
                index={index}
                checklist={checkbox}
                objects={objects}
                autoFocus={focusBlock === block.id}
                onChange={patchBlock}
                onNew={(current, rest, extra) =>
                  createAfter(index, current, rest, extra)
                }
                onRemove={() => {
                  if (block.remark?.text && todoTools) {
                    todoTools.remove(object.id, block.id);
                    return;
                  }
                  onPatch({
                    blocks: object.blocks.filter((b) => b.id !== block.id),
                  });
                  onEdit(object.blocks[index - 1].id);
                }}
                onExit={onExit}
                onReference={onReference}
                onReferencePicker={() => onReferencePicker(object.id, block.id)}
              />
            ) : (
              <div
                className={`block-copy ${!blockText(block) ? "empty-copy" : ""}`}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!object.locked) onEdit(block.id);
                }}
              >
                <RichText
                  runs={block.runs}
                  objects={objects}
                  onReference={onReference}
                />
                {!blockText(block) && (
                  <span>{block.spacer ? "\u00a0" : "写点什么…"}</span>
                )}
              </div>
            )}
            {checkbox && !block.spacer && (
              <TodoActions note={object} block={block} />
            )}
          </div>
        ))}
      </div>
      {checkbox && !object.locked && (
        <button
          className="add-line"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const block = makeBlock();
            onPatch({ blocks: [...object.blocks, block] });
            onEdit(block.id);
          }}
        >
          <Plus size={14} />
          添加一项
        </button>
      )}
    </div>
  );
}
export default memo(Note);
