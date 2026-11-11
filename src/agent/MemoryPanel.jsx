import React, { useState } from "react";

export const memoryScopeName = {
  personal: "个人记忆",
  project: "当前项目记忆",
};

export default function MemoryPanel({
  bindingId,
  memories,
  busy,
  save,
  remove,
  embedded = false,
}) {
  const [scope, setScope] = useState("personal");
  const [editor, setEditor] = useState(null);
  const rows = memories.filter(
    (memory) =>
      memory.scope === scope &&
      (scope === "personal" || memory.bindingId === bindingId),
  );
  async function submit() {
    const key = editor.key.trim(),
      value = editor.value.trim();
    if (!key || !value) return;
    if (
      await save({
        action: "save",
        scope,
        ...(scope === "project" ? { bindingId } : {}),
        ...(editor.id
          ? { id: editor.id, expectedRevision: editor.revision }
          : {}),
        key,
        value,
      })
    )
      setEditor(null);
  }
  return (
    <section
      className="agent-device-card agent-memory-panel"
      aria-label="管理记忆"
    >
      {!embedded && <h4>管理记忆</h4>}
      <div className="agent-actions" aria-label="记忆范围">
        {Object.entries(memoryScopeName).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={scope === id}
            disabled={busy || (id === "project" && !bindingId)}
            onClick={() => {
              setScope(id);
              setEditor(null);
            }}
          >
            {label}
          </button>
        ))}
        <button
          disabled={busy || !!editor}
          onClick={() => setEditor({ key: "", value: "" })}
        >
          新增记忆
        </button>
      </div>
      <p className="agent-note">
        {scope === "personal"
          ? "个人记忆可用于你的各个项目。"
          : "这里的记忆仅用于当前轻单清单。"}
      </p>
      {rows.length === 0 && <p className="agent-note">这个范围还没有记忆。</p>}
      <ul className="agent-memory-list">
        {rows.map((memory) => (
          <li key={memory.id}>
            <strong>{memory.key}</strong>
            <p>{memory.value}</p>
            <div className="agent-actions">
              <span className="agent-note">
                {memory.sourceMessageId ? "来自聊天建议" : "手动添加"}
              </span>
              <button
                aria-label={`编辑记忆：${memory.key}`}
                disabled={busy || !!editor}
                onClick={() => setEditor({ ...memory })}
              >
                编辑
              </button>
              <button
                aria-label={`删除记忆：${memory.key}`}
                disabled={busy || !!editor}
                onClick={() =>
                  remove({
                    action: "delete",
                    id: memory.id,
                    expectedRevision: memory.revision,
                    ...(scope === "project" ? { bindingId } : {}),
                  })
                }
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editor && (
        <div className="agent-checklist-editor">
          <label>
            名称
            <input
              aria-label="记忆名称"
              value={editor.key}
              maxLength={100}
              disabled={busy}
              onChange={(event) =>
                setEditor({ ...editor, key: event.target.value })
              }
            />
          </label>
          <label>
            内容
            <textarea
              aria-label="记忆内容"
              value={editor.value}
              rows={2}
              maxLength={1000}
              disabled={busy}
              onChange={(event) =>
                setEditor({ ...editor, value: event.target.value })
              }
            />
          </label>
          <div className="agent-actions">
            <button
              disabled={busy || !editor.key.trim() || !editor.value.trim()}
              onClick={submit}
            >
              保存记忆
            </button>
            <button disabled={busy} onClick={() => setEditor(null)}>
              取消编辑记忆
            </button>
          </div>
        </div>
      )}
      <p className="agent-note">
        删除记忆会保留聊天原文。后续模型会停止自动使用已删除的来源。
        {embedded
          ? "已保存的待办可以在清单中单独修改。"
          : "已保存的待办可在第 5 步单独修改。"}
      </p>
    </section>
  );
}
