import React, { useState } from "react";
import { BookmarkPlus, Plus, Trash2 } from "lucide-react";
import { Modal } from "./Panels.jsx";

export default function QuickTaskLibrary({
  items,
  existingTasks = [],
  onClose,
  onUse,
  onCreate,
  onRemove,
}) {
  const [draft, setDraft] = useState("");
  const save = (event) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    if (onCreate(value) !== false) setDraft("");
  };
  const existing = existingTasks.filter(
    (task) => task.block?.runs && task.block.runs.length,
  );
  return (
    <Modal
      title="常用清单库"
      onClose={onClose}
      wide
      className="quick-task-library"
    >
      <p className="quick-task-library-intro">
        把每天都会出现的待办存起来，点击一次就能添加到当前清单。
      </p>
      <form className="quick-task-form" onSubmit={save}>
        <textarea
          aria-label="常用待办内容"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：中午12点吃饭"
          rows={2}
          maxLength={2000}
        />
        <button type="submit" className="quick-task-save" disabled={!draft.trim()}>
          <BookmarkPlus size={15} />
          保存到库
        </button>
      </form>
      {existing.length > 0 && (
        <section className="quick-task-existing" aria-label="当前清单待办">
          <h3>从当前清单收录</h3>
          <div>
            {existing.map((task) => {
              const text = task.block.runs
                .map((run) => (run.type === "text" ? run.text : ""))
                .join("")
                .trim();
              if (!text) return null;
              return (
                <button
                  type="button"
                  key={task.key}
                  className="quick-task-existing-item"
                  onClick={() => onCreate(text)}
                >
                  <BookmarkPlus size={14} />
                  <span>{text}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      <section className="quick-task-list" aria-label="已保存的常用待办">
        <h3>已保存的待办</h3>
        {items.length ? (
          <div>
            {items.map((item) => (
              <article className="quick-task-item" key={item.id}>
                <button
                  type="button"
                  className="quick-task-use"
                  aria-label={`添加常用待办：${item.text}`}
                  title="添加到当前清单"
                  onClick={() => onUse(item)}
                >
                  <Plus size={15} />
                  <span>{item.text}</span>
                </button>
                <button
                  type="button"
                  className="quick-task-remove"
                  aria-label={`删除常用待办：${item.text}`}
                  title="从常用清单库删除"
                  onClick={() => onRemove(item.id)}
                >
                  <Trash2 size={14} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="quick-task-empty">还没有常用待办，先保存一个吧。</p>
        )}
      </section>
    </Modal>
  );
}
