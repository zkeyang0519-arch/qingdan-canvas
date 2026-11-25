import React, { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import "./workspace-information.css";

export const memoryScopeName = { personal: "个人偏好", project: "项目约定" };

export default function MemoryPanel({
  bindingId,
  memories,
  busy,
  save,
  remove,
  embedded = false,
  projectFirst = false,
  fixedScope,
  before,
}) {
  const [selectedScope, setScope] = useState(
    projectFirst && bindingId ? "project" : "personal",
  );
  const scope = fixedScope || selectedScope;
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState("");
  const rows = memories.filter(
    (m) =>
      m.scope === scope && (scope === "personal" || m.bindingId === bindingId),
  );
  async function submit() {
    const key = editor.key.trim(),
      value = editor.value.trim();
    if (!key || !value) return;
    setError("");
    try {
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
    } catch (cause) {
      setError(cause.message);
    }
  }
  function form() {
    return (
      <div className="qd-memory-editor">
        <label>
          名称
          <Input
            autoFocus
            aria-label="记忆名称"
            value={editor.key}
            maxLength={100}
            disabled={busy}
            onChange={(e) => setEditor({ ...editor, key: e.target.value })}
          />
        </label>
        <label>
          内容
          <textarea
            aria-label="记忆内容"
            value={editor.value}
            rows={3}
            maxLength={1000}
            disabled={busy}
            onChange={(e) => setEditor({ ...editor, value: e.target.value })}
          />
        </label>
        {error && (
          <p role="alert" className="agent-error">
            {error}
          </p>
        )}
        <div className="agent-actions">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setEditor(null)}
          >
            取消编辑记忆
          </Button>
          <Button
            disabled={busy || !editor.key.trim() || !editor.value.trim()}
            onClick={submit}
          >
            保存记忆
          </Button>
        </div>
      </div>
    );
  }
  return (
    <section className="agent-memory-panel" aria-label="管理记忆">
      {before}
      <div className="qd-memory-header">
        <div>
          <h3>
            {fixedScope
              ? scope === "personal"
                ? "长期使用的偏好"
                : "项目约定与经验"
              : "管理记忆"}
          </h3>
          <p>
            {scope === "personal"
              ? "用于你的各个项目；可随时修改或删除。"
              : "仅用于当前项目；任务进度在概览里查看。"}
          </p>
        </div>
        <Button
          size="sm"
          disabled={busy || !!editor || (scope === "project" && !bindingId)}
          onClick={() => {
            setError("");
            setEditor({ key: "", value: "" });
          }}
        >
          <Plus size={14} aria-hidden="true" />
          {fixedScope ? "添加" : "新增记忆"}
        </Button>
      </div>
      {!fixedScope && (
        <div className="agent-actions agent-memory-tabs" aria-label="记忆范围">
          {(projectFirst
            ? ["project", "personal"]
            : ["personal", "project"]
          ).map((id) => (
            <Button
              variant="ghost"
              size="sm"
              key={id}
              aria-pressed={scope === id}
              disabled={busy || (id === "project" && !bindingId)}
              onClick={() => {
                setScope(id);
                setEditor(null);
              }}
            >
              {memoryScopeName[id]}
            </Button>
          ))}
        </div>
      )}
      {editor && !editor.id && <div className="qd-memory-new">{form()}</div>}
      {!editor && !rows.length && (
        <p className="agent-memory-empty">
          {fixedScope
            ? "还没有保存的内容。可添加长期偏好、项目约定，或从任务复盘中沉淀经验。"
            : "暂无记忆"}
        </p>
      )}
      <ul className="agent-memory-list">
        {rows.map((memory) => (
          <li key={memory.id} className="qd-memory-row">
            {editor?.id === memory.id ? (
              form()
            ) : (
              <>
                <div className="qd-memory-copy">
                  <strong>{memory.key}</strong>
                  <p>{memory.value}</p>
                  <small>
                    {memory.retention?.kind === "method"
                      ? "操作经验 · 来自任务复盘"
                      : memory.retention
                        ? "来自任务复盘"
                        : memory.sourceMessageId
                          ? "来自聊天建议"
                          : "手动添加"}
                  </small>
                  {memory.retention?.whenApplicable && (
                    <details>
                      <summary>适用条件与来源</summary>
                      <p>{memory.retention.whenApplicable}</p>
                      <p>
                        {memory.retention.evidence
                          ?.map((item) => item.label || item.id)
                          .join("；")}
                      </p>
                    </details>
                  )}
                </div>
                <div className="agent-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={"编辑记忆：" + memory.key}
                    disabled={busy || !!editor}
                    onClick={() => {
                      setError("");
                      setEditor({ ...memory });
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={"删除记忆：" + memory.key}
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
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
