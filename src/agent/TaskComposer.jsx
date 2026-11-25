import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Check, X } from "lucide-react";

export default function TaskComposer({
  value,
  onChange,
  onSave,
  onClose,
  inputRef,
  busy,
  mode = "create",
  saveDisabled = false,
}) {
  const localInput = useRef(null);
  const input = inputRef || localInput;
  const form = useRef(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${Math.min(mode === "edit" ? 160 : Infinity, Math.max(32, input.current.scrollHeight))}px`;
  }, [input, value, mode]);

  async function save() {
    if (
      busy ||
      saveDisabled ||
      submitting.current ||
      composing.current ||
      !value.trim()
    )
      return;
    submitting.current = true;
    input.current?.focus({ preventScroll: true });
    try {
      await onSave();
    } finally {
      submitting.current = false;
      if (form.current?.contains(document.activeElement))
        input.current?.focus({ preventScroll: true });
    }
  }

  return (
    <form
      ref={form}
      className={`agent-task-composer${mode === "edit" ? " is-editing" : ""}`}
      aria-label={mode === "edit" ? "原行编辑待办" : "新增待办"}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="agent-task-composer-row">
        <span className="agent-task-composer-circle" aria-hidden="true" />
        <textarea
          ref={input}
          className="agent-task-input"
          aria-label={mode === "edit" ? "编辑待办内容" : "新待办"}
          placeholder={mode === "edit" ? "待办内容" : "添加待办"}
          title={
            mode === "edit"
              ? "Enter 保存 · Shift + Enter 换行 · Esc 取消"
              : "Enter 添加 · Shift + Enter 换行 · Esc 收起"
          }
          rows={1}
          maxLength={32000}
          value={value}
          readOnly={busy}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              composing.current
            )
              return;
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              event.stopPropagation();
              onClose?.();
              return;
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void save();
          }}
        />
        <button
          type="submit"
          aria-label={mode === "edit" ? "保存待办" : "保存新待办"}
          title={
            busy ? "正在保存…" : mode === "edit" ? "保存待办" : "保存新待办"
          }
          disabled={busy || saveDisabled || !value.trim()}
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          aria-label={mode === "edit" ? "取消编辑" : "收起添加待办"}
          title={mode === "edit" ? "取消编辑" : "收起，保留草稿"}
          disabled={busy}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
    </form>
  );
}
