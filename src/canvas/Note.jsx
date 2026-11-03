import React, { memo, useLayoutEffect, useRef } from "react";
import { Plus, Link2, LockKeyhole } from "lucide-react";
import { makeBlock, blockText } from "./model.js";
import { parseClipboard } from "./paste.js";
import { referenceLabel } from "./referenceText.js";
import { formatCreatedAt } from "./dateFormat.js";
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

// Old notes store one block per line. Keep those identities, but expose a single
// editing host so selection, replacement and clipboard operations span the article.
function proseSegments(element) {
  const segments = [];
  let inline = [];
  const flush = () => {
    if (!inline.length) return;
    const holder = document.createElement("div");
    inline.forEach((node) => holder.append(node.cloneNode(true)));
    segments.push({ node: inline[0], nodes: inline, runs: readRuns(holder) });
    inline = [];
  };
  element.childNodes.forEach((node) => {
    if (node.nodeType === 1 && ["DIV", "P"].includes(node.tagName)) {
      flush();
      segments.push({
        node,
        runs:
          node.childNodes.length === 1 && node.firstChild.nodeName === "BR"
            ? [{ type: "text", text: "" }]
            : readRuns(node),
      });
    } else inline.push(node);
  });
  flush();
  return segments;
}

export function ProseBody({
  blocks,
  editing = false,
  focusBlock,
  objects,
  onChange,
  onEdit,
  onExit,
  onReference,
  onReferencePicker,
}) {
  const ref = useRef(null),
    initial = useRef(blocks),
    baseline = useRef(blocks),
    latest = useRef(blocks),
    nodeIds = useRef(new WeakMap()),
    composing = useRef(false);
  latest.current = blocks;
  useLayoutEffect(() => {
    if (!editing) return;
    const element = ref.current;
    element.focus({ preventScroll: true });
    const target =
      [...element.children].find(
        (node) => node.dataset.proseBlock === focusBlock,
      ) || element;
    const range = document.createRange(),
      selection = getSelection();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [editing, focusBlock]);
  const sync = () => {
    const previous = new Map(baseline.current.map((b) => [b.id, b]));
    const live = new Map(latest.current.map((b) => [b.id, b]));
    const used = new Set();
    const segments = proseSegments(ref.current);
    if (!segments.length)
      segments.push({ node: ref.current, runs: [{ type: "text", text: "" }] });
    const next = segments.map(({ node, nodes = [node], runs }) => {
      const key = node.dataset?.proseBlock || nodeIds.current.get(node);
      const old = !used.has(key) && (previous.get(key) || live.get(key));
      const block =
        old ||
        (segments.length === 1 ? baseline.current[0] : null) ||
        makeBlock();
      used.add(block.id);
      nodes.forEach((child) => nodeIds.current.set(child, block.id));
      if (node !== ref.current && node.nodeType === 1)
        node.dataset.proseBlock = block.id;
      return { ...block, runs };
    });
    // Keep the article task's identity and metadata when its first paragraph is
    // removed, or when a new paragraph is inserted ahead of the old first one.
    const anchor = baseline.current[0];
    if (anchor && next[0].id !== anchor.id) {
      const first = next[0],
        anchorIndex = next.findIndex((b) => b.id === anchor.id);
      next[0] = { ...anchor, runs: first.runs };
      if (anchorIndex > 0)
        next[anchorIndex] = { ...first, runs: next[anchorIndex].runs };
      segments.forEach(({ node, nodes = [node] }, i) => {
        nodes.forEach((child) => nodeIds.current.set(child, next[i].id));
        if (node !== ref.current && node.nodeType === 1)
          node.dataset.proseBlock = next[i].id;
      });
    }
    // Only changed text belongs to this edit. Preserve incoming metadata and
    // untouched paragraphs (including paragraphs added by a collaborator).
    const changed = JSON.stringify(next) !== JSON.stringify(baseline.current);
    if (changed) {
      const merged = next.flatMap((block) => {
        const before = previous.get(block.id),
          current = live.get(block.id);
        if (
          before &&
          JSON.stringify(before.runs) === JSON.stringify(block.runs)
        )
          return current ? [current] : [];
        return [{ ...(current || block), runs: block.runs }];
      });
      for (const [index, block] of latest.current.entries()) {
        if (previous.has(block.id) || used.has(block.id)) continue;
        const following = latest.current
          .slice(index + 1)
          .find((b) => merged.some((item) => item.id === b.id));
        const preceding = latest.current
          .slice(0, index)
          .findLast((b) => merged.some((item) => item.id === b.id));
        const position = following
          ? merged.findIndex((b) => b.id === following.id)
          : preceding
            ? merged.findIndex((b) => b.id === preceding.id) + 1
            : merged.length;
        merged.splice(position, 0, block);
      }
      baseline.current = next;
      onChange(merged);
    }
    return next;
  };
  const insertText = (text) => {
    const value = text.replace(/\r\n?/g, "\n");
    // Keep browser caret placement and undo for a paste into the article.
    if (document.execCommand?.("insertText", false, value)) {
      sync();
      return;
    }
    const selection = getSelection();
    let range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (
      !range ||
      !ref.current.contains(range.startContainer) ||
      !ref.current.contains(range.endContainer)
    ) {
      range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
    }
    const paragraphAt = (node) => {
      while (node && node.parentNode !== ref.current) node = node.parentNode;
      return node?.nodeType === 1 ? node : null;
    };
    const first = paragraphAt(range.startContainer),
      last = paragraphAt(range.endContainer);
    range.deleteContents();
    if (
      first &&
      last &&
      first !== last &&
      ref.current.contains(first) &&
      ref.current.contains(last)
    ) {
      range.setStart(first, first.childNodes.length);
      range.collapse(true);
      first.append(...last.childNodes);
      last.remove();
    } else if (
      range.startContainer === ref.current &&
      ref.current.children.length
    ) {
      const following = ref.current.childNodes[range.startOffset];
      const paragraph =
        following?.nodeType === 1 ? following : ref.current.lastElementChild;
      range.selectNodeContents(paragraph);
      range.collapse(!!following);
    }
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    sync();
  };
  return (
    <div
      ref={ref}
      className={`prose-body ${editing ? "block-editor" : "prose-copy"}`}
      role="textbox"
      aria-label={editing ? "编辑便签正文" : "便签全文"}
      aria-multiline="true"
      aria-readonly={!editing}
      tabIndex={0}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder="写点什么…"
      onPointerDown={(event) => {
        if (editing) event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!editing) onEdit?.(blocks[0]?.id);
      }}
      onInput={() => {
        if (editing && !composing.current) sync();
      }}
      onBlur={() => {
        if (editing) sync();
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        if (editing) sync();
      }}
      onKeyDown={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          event.stopPropagation();
          const range = document.createRange(),
            selection = getSelection();
          range.selectNodeContents(ref.current);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        if (!editing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          sync();
          onExit();
        } else if (event.key === "[") {
          const selection = getSelection();
          let paragraph = selection?.anchorNode;
          if (paragraph === ref.current)
            paragraph =
              paragraph.childNodes[Math.max(0, selection.anchorOffset - 1)];
          while (paragraph && paragraph.parentNode !== ref.current)
            paragraph = paragraph.parentNode;
          const current = sync();
          const key =
            paragraph?.dataset?.proseBlock || nodeIds.current.get(paragraph);
          if (
            current.some(
              (block) => block.id === key && blockText(block).endsWith("["),
            )
          ) {
            event.preventDefault();
            onReferencePicker?.(key);
          }
        }
      }}
      onPaste={(event) => {
        if (!editing) return;
        event.preventDefault();
        event.stopPropagation();
        insertText(event.clipboardData.getData("text/plain"));
      }}
      onCopy={(event) => {
        const selection = getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (
          !ref.current.contains(range.startContainer) ||
          !ref.current.contains(range.endContainer)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData.setData(
          "text/plain",
          proseSegments(range.cloneContents()).map(blockText).join("\n"),
        );
      }}
    >
      {(editing ? initial.current : blocks).map((block) => (
        <div key={block.id} data-prose-block={block.id}>
          <RichText
            runs={block.runs}
            objects={objects}
            onReference={onReference}
          />
        </div>
      ))}
    </div>
  );
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
      {formatCreatedAt(object.createdAt) && (
        <time
          className="note-created-at"
          dateTime={object.createdAt}
          title={`创建于 ${formatCreatedAt(object.createdAt)}`}
          aria-label={`${checkbox ? "清单" : "便签"}创建时间：${formatCreatedAt(object.createdAt)}`}
        >
          {formatCreatedAt(object.createdAt)}
        </time>
      )}
      {checkbox && (
        <ChecklistMenu notes={[object]} className="todo-note-menu" />
      )}
      {!checkbox ? (
        <ProseBody
          key={editing ? "edit" : "read"}
          blocks={object.blocks}
          editing={editing}
          focusBlock={focusBlock}
          objects={objects}
          onChange={(blocks) => onPatch({ blocks })}
          onEdit={(key) => {
            if (!object.locked) onEdit(key);
          }}
          onExit={onExit}
          onReference={onReference}
          onReferencePicker={(key) => onReferencePicker(object.id, key)}
        />
      ) : (
        <div className="note-blocks is-checklist">
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
                  onReferencePicker={() =>
                    onReferencePicker(object.id, block.id)
                  }
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
      )}
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
