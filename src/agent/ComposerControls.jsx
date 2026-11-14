import React, { useEffect, useState } from "react";
import { Bot, ChevronDown, Zap } from "lucide-react";
import { localRunnerRequest } from "./DevicePanel.jsx";

export default function ComposerControls({ value, onChange, onReady, provider, accountId, requestLocal = localRunnerRequest, disabled }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (value.agent !== "codex") return;
    let alive = true;
    setLoading(true);
    setError("");
    requestLocal("/codex/models", { accountId }).then((result) => {
      if (!alive) return;
      setModels(result.models || []);
    }).catch((err) => {
      if (alive) setError(err.message);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, value.agent, requestLocal, reload]);
  const selected = models.find((model) => model.id === value.model);
  const defaultModel = models.find((model) => model.isDefault);
  const supportsFast = value.agent === "codex" && (value.model ? selected : defaultModel)?.supportsFast;
  useEffect(() => {
    onReady?.(value.agent !== "codex" || (!loading && (!value.model || !!selected) && (!value.fastMode || !!supportsFast)));
  }, [value.agent, value.model, value.fastMode, loading, selected, supportsFast, onReady]);
  useEffect(() => {
    if (!loading && models.length && value.fastMode && !supportsFast)
      onChange({ ...value, fastMode: false });
  }, [loading, models, supportsFast, value, onChange]);
  return (
    <div className="agent-composer-controls" aria-label="模型与工作模式">
      <label className="agent-composer-select" title="工作模式">
        <Bot size={14} aria-hidden="true" />
        <select aria-label="Agent 选择" value={value.agent} disabled={disabled} onChange={(event) => onChange({ ...value, agent: event.target.value, fastMode: false })}>
          <option value="assistant">聊天</option>
          <option value="codex">Agent</option>
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
      <label className="agent-composer-select agent-composer-model" title={error || "选择模型"}>
        <select aria-label="模型选择" disabled={disabled || loading} value={value.agent === "codex" ? value.model : "chat"} onChange={(event) => onChange({ ...value, model: event.target.value, fastMode: false })}>
          {value.agent === "assistant" ? <option value="chat">{provider?.model || "聊天模型"}</option> : <>
            <option value="">{loading ? "读取模型…" : "Codex 默认"}</option>
            {value.model && !selected && <option value={value.model}>{value.model} · 暂不可用</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </>}
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
      <button type="button" className="agent-composer-fast" aria-label="快速模式" aria-pressed={value.fastMode} title={supportsFast ? "快速模式" : "当前模式或模型不支持快速模式"} disabled={disabled || loading || !supportsFast} onClick={() => onChange({ ...value, fastMode: !value.fastMode })}>
        <Zap size={16} aria-hidden="true" />
      </button>
      {error && <button type="button" className="agent-model-retry" title={error} disabled={disabled || loading} onClick={() => setReload((prior) => prior + 1)}>重试模型列表</button>}
    </div>
  );
}
