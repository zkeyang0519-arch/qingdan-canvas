import React, { useId, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Settings2,
  Zap,
} from "lucide-react";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import {
  executionSettingsIssue,
  executionSettingsPayload,
  followsCodex,
  selectedExecutionModel,
} from "./execution-settings.js";
import "./execution-settings.css";

function ModelPicker({ value, catalog, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef(null);
  const list = useRef(null);
  const listId = useId();
  const selected = catalog.models.find((model) => model.id === value);
  const options = [
    { id: "", name: "跟随 Codex", detail: catalog.current?.model },
    ...catalog.models,
  ].filter((model) =>
    `${model.name || model.id} ${model.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  function choose(modelId) {
    onChange(modelId);
    setOpen(false);
    trigger.current?.focus();
  }
  function navigate(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target.tagName === "INPUT" && ["Home", "End"].includes(event.key))
      return;
    const items = [
      ...(list.current?.querySelectorAll('[role="option"]') || []),
    ];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : current <= 0
              ? items.length - 1
              : current - 1;
    items[next].focus();
    items[next].scrollIntoView?.({ block: "nearest" });
  }
  return (
    <div className="agent-model-picker">
      <span>新会话默认模型</span>
      <button
        type="button"
        className="agent-model-picker-trigger"
        role="combobox"
        aria-label="新会话默认模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        ref={trigger}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          }
        }}
      >
        <span>
          {value
            ? selected
              ? selected.name || value
              : `${value} · 暂不可用`
            : catalog.current?.model
              ? `跟随 Codex · ${catalog.models.find((model) => model.id === catalog.current.model)?.name || catalog.current.model}`
              : "Codex 默认"}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="agent-model-picker-panel" onKeyDown={navigate}>
          <div className="agent-model-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus
              aria-label="搜索模型"
              placeholder="搜索模型名称或 ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div id={listId} role="listbox" aria-label="可选模型" ref={list}>
            {options.map((model) => (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={model.id === value}
                value={model.id}
                onClick={() => choose(model.id)}
              >
                <span>
                  <strong>{model.name || model.id}</strong>
                  {(model.id || model.detail) && (
                    <small>{model.id || model.detail}</small>
                  )}
                </span>
                {model.isDefault && <em>当前默认</em>}
                {model.id === value && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
            {!options.length && <p role="status">没有匹配的模型</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsForm({ value, onSave, onClose, catalog }) {
  const [draft, setDraft] = useState(() => ({ ...value }));
  const resolved = executionSettingsPayload(draft, catalog);
  const selected = selectedExecutionModel(draft, catalog);
  const supportsFast = catalog.status === "ready" && selected?.supportsFast;
  const issue = executionSettingsIssue(draft, catalog);
  return (
    <form
      className="agent-execution-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!issue) {
          onSave(draft);
          onClose();
        }
      }}
    >
      <ModelPicker
        value={draft.model}
        catalog={catalog}
        onChange={(model) => {
          const next = { ...draft, model, followCodex: !model };
          setDraft({
            ...next,
            fastMode: !!(
              model &&
              resolved?.fastMode &&
              selectedExecutionModel(next, catalog)?.supportsFast
            ),
          });
        }}
      />
      <div className="agent-model-catalog-status">
        <span role={catalog.status === "error" ? "alert" : "status"}>
          {catalog.status === "loading"
            ? "正在读取完整模型列表…"
            : catalog.status === "error"
              ? catalog.error
              : !followsCodex(draft)
                ? "自定义设置"
                : catalog.current?.source === "project"
                  ? "跟随最近项目会话"
                  : catalog.current
                    ? "跟随 Codex 设置"
                    : ""}
        </span>
        <button
          type="button"
          aria-label="刷新模型列表"
          title="刷新模型列表"
          disabled={catalog.status === "loading"}
          onClick={catalog.refresh}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="agent-default-fast-row">
        <div>
          <strong>
            <Zap size={15} />
            快速模式
          </strong>
          {catalog.status === "ready" && !supportsFast && (
            <p>当前模型不支持快速模式。</p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          className="agent-default-fast-switch"
          aria-label="快速模式"
          aria-checked={resolved?.fastMode ?? false}
          disabled={!supportsFast && !resolved?.fastMode}
          onClick={() =>
            setDraft({
              ...draft,
              model: draft.model || selected?.id || "",
              fastMode: !resolved?.fastMode,
              followCodex: false,
            })
          }
        >
          <span />
        </button>
      </div>
      {issue && catalog.status === "ready" && (
        <p className="agent-note" role="status">
          {issue}
        </p>
      )}
      <footer>
        <div>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!!issue}>
            保存执行设置
          </button>
        </div>
      </footer>
    </form>
  );
}

export default function ExecutionSettings({
  value,
  onSave,
  catalog,
  disabled,
  warning,
}) {
  const [open, setOpen] = useState(false);
  const model = selectedExecutionModel(value, catalog);
  const resolved = executionSettingsPayload(value, catalog);
  return (
    <>
      <button
        type="button"
        className="agent-execution-settings-entry"
        aria-label="执行默认设置"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className="agent-settings-entry-title">
          <span>
            <Settings2 size={14} />
            执行设置
          </span>
          <ChevronRight size={15} />
        </span>
        <span className="agent-settings-entry-summary">
          <span>
            <Bot size={14} />
            Codex
          </span>
          <span>
            {resolved?.model ? model?.name || resolved.model : "Codex 默认"}
          </span>
          <span>
            {resolved?.fastMode && <Zap size={12} />}
            {resolved ? (resolved.fastMode ? "快速" : "标准") : "跟随 Codex"}
          </span>
        </span>
      </button>
      {warning && (
        <p className="agent-note" role="status">
          {warning}
        </p>
      )}
      {open && (
        <WorkspaceDrawer title="执行设置" onClose={() => setOpen(false)}>
          <SettingsForm
            value={value}
            onSave={onSave}
            onClose={() => setOpen(false)}
            catalog={catalog}
          />
        </WorkspaceDrawer>
      )}
    </>
  );
}
