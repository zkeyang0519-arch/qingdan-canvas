import React, { useEffect, useId, useRef, useState } from "react";
import { Plus, Server, Check, ChevronDown } from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Badge } from "./ui/badge.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import "./chat-model-picker.css";

export function ModelErrorDetails({ diagnostic, previousError }) {
  if (!diagnostic && !previousError) return null;
  return (
    <details className="qd-model-details">
      <summary>{previousError ? "上次尝试" : "错误详情"}</summary>
      {previousError && <div>{previousError}</div>}
      {diagnostic && (
        <>
          <div>
            HTTP {diagnostic.status}
            {diagnostic.requestId && " · 请求 ID " + diagnostic.requestId}
          </div>
          {diagnostic.body && <pre>{diagnostic.body}</pre>}
        </>
      )}
    </details>
  );
}

export default function ChatModelPicker({
  catalog,
  selected,
  failedId,
  busy,
  call,
  onCatalog,
  onChoose,
  onClose,
  inline = false,
  selectionError,
}) {
  const choices = catalog.profiles.filter(
    (profile) => profile.configured && profile.id !== failedId,
  );
  const [adding, setAdding] = useState(!!failedId && !choices.length);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [editUrl, setEditUrl] = useState("");
  const [keyEntered, setKeyEntered] = useState(false);
  const [reuseKey, setReuseKey] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [managing, setManaging] = useState(false);
  const [applying, setApplying] = useState(false);
  const fieldId = useId();
  const [pending, setPending] = useState(
    failedId ? (choices[0]?.id ?? "") : selected || catalog.defaultId || "",
  );
  const [defaultChoice, setDefaultChoice] = useState(catalog.defaultId || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const savingRef = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    setPending(
      failedId ? (choices[0]?.id ?? "") : selected || catalog.defaultId || "",
    );
  }, [selected, failedId]);
  useEffect(
    () => setDefaultChoice(catalog.defaultId || ""),
    [catalog.defaultId],
  );
  const current = catalog.profiles.find((profile) => profile.id === selected);
  const proposed = catalog.profiles.find((profile) => profile.id === pending);
  const deepseek = preset === "deepseek";
  const formOpen = adding || !!editing;
  let destinationChanged = false;
  if (editing) {
    try {
      destinationChanged =
        new URL(editUrl).origin !== new URL(editing.baseUrl).origin;
    } catch {}
  }
  const locked = busy || saving || applying;
  async function applySelection() {
    if (savingRef.current || locked) return;
    savingRef.current = true;
    setApplying(true);
    setError("");
    setNotice("");
    try {
      const result = await onChoose(pending);
      if (result !== false && active.current)
        setNotice(failedId ? "已提交切换重试。" : "主模型已应用到当前对话。");
    } catch (failure) {
      if (active.current) setError(failure.message);
    } finally {
      savingRef.current = false;
      if (active.current) setApplying(false);
    }
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function change(body) {
    if (savingRef.current || busy || applying) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await call(catalog.modelsEndpoint || "/local/models", {
        method: "POST",
        body,
      });
      if (!active.current) return;
      onCatalog(next);
      if (next.added) {
        setPending(next.added);
        setAdding(false);
      }
      if (next.updated) {
        if (pending === next.replaced || failedId === next.replaced)
          setPending(next.updated);
        setEditing(null);
      }
      if (next.deleted) {
        if (pending === next.deleted) setPending("");
        setDeleting(null);
      }
      setNotice(
        next.added
          ? "连接已保存，点击「应用」即可用于当前对话。"
          : next.updated
            ? "连接已更新，之后的消息将使用新设置。"
            : next.deleted
              ? "连接已删除，使用此连接的聊天需重新选择模型。"
              : "新对话默认模型已更新。",
      );
    } catch (err) {
      if (active.current) setError(err.message);
    } finally {
      savingRef.current = false;
      if (active.current) setSaving(false);
    }
  }

  const content = (
    <div className="qd-model-settings qd-model-settings--compact">
      <section className="qd-model-main" role="region" aria-label="主模型设置">
        <div className="qd-model-setting-row">
          <label
            className="qd-model-field-label"
            htmlFor={fieldId + "-current"}
          >
            <strong>{failedId ? "更换模型重试" : "当前对话模型"}</strong>
            <small>
              {failedId ? "沿用原消息进行重试" : "切换后保留聊天记录"}
            </small>
          </label>
          <div className="qd-model-field-control">
            <span
              id={fieldId + "-current-description"}
              className="qd-model-sr-only"
              aria-label="当前使用的主模型"
            >
              {current
                ? `${current.service} · ${current.model}`
                : "尚未选择主模型"}
            </span>
            <select
              id={fieldId + "-current"}
              aria-label={failedId ? "重试主模型" : "当前对话主模型"}
              aria-describedby={fieldId + "-current-description"}
              value={pending}
              disabled={locked || !choices.length}
              onChange={(event) => {
                setNotice("");
                setPending(event.target.value);
              }}
            >
              {!catalog.profiles.some((p) => p.id === pending) && !failedId && (
                <option value={pending} disabled>
                  请选择模型连接
                </option>
              )}
              {failedId && !choices.length && (
                <option value="">请先添加备用模型</option>
              )}
              {catalog.profiles.map((profile) => (
                <option
                  key={profile.id}
                  value={profile.id}
                  disabled={!profile.configured || profile.id === failedId}
                >
                  {profile.model} · {profile.service}
                  {!profile.configured && " · 待配置"}
                  {profile.id === failedId && " · 本次失败"}
                </option>
              ))}
            </select>
            <div className="qd-model-row-action">
              {failedId ? (
                <Button
                  type="button"
                  className="primary"
                  disabled={
                    locked || !choices.some((profile) => profile.id === pending)
                  }
                  onClick={applySelection}
                >
                  切换并重试
                </Button>
              ) : pending !== selected ? (
                <Button
                  type="button"
                  className="primary"
                  aria-label="应用到当前对话"
                  disabled={locked || !proposed?.configured}
                  onClick={applySelection}
                >
                  {applying ? "应用中…" : "应用"}
                </Button>
              ) : (
                <span className="qd-model-saved">
                  {current?.configured && (
                    <Check size={13} aria-hidden="true" />
                  )}
                  {current?.configured ? "已应用" : "待配置"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="qd-model-setting-row">
          <label
            className="qd-model-field-label"
            htmlFor={fieldId + "-default"}
          >
            <strong>新对话默认模型</strong>
            <small>仅用于之后新建的对话</small>
          </label>
          <div className="qd-model-field-control">
            <select
              id={fieldId + "-default"}
              aria-label="新对话默认模型"
              value={defaultChoice}
              disabled={
                locked ||
                !catalog.profiles.some((profile) => profile.configured)
              }
              onChange={(event) => {
                setDefaultChoice(event.target.value);
                setNotice("");
              }}
            >
              {!catalog.profiles.some((p) => p.id === defaultChoice) && (
                <option value={defaultChoice} disabled>
                  请选择默认模型
                </option>
              )}
              {catalog.profiles.map((profile) => (
                <option
                  key={profile.id}
                  value={profile.id}
                  disabled={!profile.configured}
                >
                  {profile.model} · {profile.service}
                  {!profile.configured && " · 待配置"}
                </option>
              ))}
            </select>
            <div className="qd-model-row-action">
              {defaultChoice !== catalog.defaultId ? (
                <Button
                  className="primary"
                  type="button"
                  aria-label="保存默认模型"
                  disabled={
                    locked ||
                    !catalog.profiles.some(
                      (profile) =>
                        profile.id === defaultChoice && profile.configured,
                    )
                  }
                  onClick={() =>
                    change({ action: "default", id: defaultChoice })
                  }
                >
                  {saving ? "保存中…" : "保存"}
                </Button>
              ) : (
                <span className="qd-model-saved">
                  {catalog.profiles.some(
                    (profile) =>
                      profile.id === defaultChoice && profile.configured,
                  ) ? (
                    <>
                      <Check size={13} aria-hidden="true" />
                      已保存
                    </>
                  ) : (
                    "待配置"
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
        {!catalog.profiles.some((profile) => profile.configured) && (
          <p className="qd-model-empty">
            还没有可用的模型连接，请先新建一个连接。
          </p>
        )}
      </section>
      <section
        className="qd-model-management"
        role="region"
        aria-label="BYOK 模型连接"
      >
        <div className="qd-model-management-bar">
          <button
            type="button"
            className="qd-model-manage-toggle"
            aria-expanded={managing}
            aria-controls={fieldId + "-connections"}
            onClick={() => setManaging(!managing)}
          >
            <Server size={16} aria-hidden="true" />
            <span>管理连接</span>
            <span className="qd-model-count">{catalog.profiles.length}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <Button
            variant="outline"
            type="button"
            className="qd-model-add"
            disabled={locked || formOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setPreset("custom");
              setEditing(null);
              setAdding(true);
              setError("");
              setNotice("");
            }}
          >
            <Plus size={14} aria-hidden="true" />
            新建模型连接
          </Button>
        </div>
        {managing && (
          <ul className="qd-model-connections" id={fieldId + "-connections"}>
            {catalog.profiles.map((profile) => (
              <li key={profile.id}>
                <span className="qd-connection-icon">
                  <Server size={18} aria-hidden="true" />
                </span>
                <div className="qd-connection-info">
                  <strong>{profile.service}</strong>
                  <small>
                    {profile.model}
                    {profile.id === selected && " · 当前使用"}
                    {profile.id === catalog.defaultId && " · 新对话默认"}
                  </small>
                  {profile.baseUrl && (
                    <small className="qd-connection-address">
                      {profile.baseUrl}
                    </small>
                  )}
                  {profile.editable === false && (
                    <small>由本机环境配置管理</small>
                  )}
                </div>
                <Badge variant="outline">
                  {profile.configured ? "已配置" : "待配置"}
                </Badge>
                {profile.id !== "xingchi" && profile.editable !== false && (
                  <div className="qd-connection-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={locked || formOpen}
                      aria-label={`编辑 ${profile.service} ${profile.model}`}
                      onClick={() => {
                        setEditing(profile);
                        setAdding(false);
                        setEditUrl(profile.baseUrl || "");
                        setKeyEntered(false);
                        setReuseKey(false);
                        setPreset("custom");
                        setError("");
                        setNotice("");
                        setDeleting(null);
                      }}
                    >
                      编辑
                    </Button>
                    {profile.removable !== false && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={locked || formOpen}
                        aria-label={`删除 ${profile.service} ${profile.model}`}
                        onClick={() => {
                          setDeleting(profile.id);
                          setError("");
                          setNotice("");
                        }}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                )}
                {deleting === profile.id && (
                  <div
                    className="qd-connection-confirm"
                    role="group"
                    aria-label={`确认删除 ${profile.service}`}
                  >
                    <p>
                      删除「{profile.service} · {profile.model}
                      」连接？聊天记录会保留，使用它的聊天需重新选择模型
                      {profile.id === catalog.defaultId
                        ? "，新对话默认模型也需要重新设置"
                        : ""}
                      。
                    </p>
                    <div>
                      <Button
                        type="button"
                        className="qd-model-delete"
                        disabled={locked}
                        onClick={() =>
                          change({ action: "delete", id: profile.id })
                        }
                      >
                        {saving ? "正在删除…" : "删除连接"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => setDeleting(null)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {formOpen && (
          <WorkspaceDrawer
            title={
              editing
                ? "编辑模型连接"
                : deepseek
                  ? "添加 DeepSeek 官方连接"
                  : "新建模型连接"
            }
            onClose={() => {
              if (!saving) {
                setAdding(false);
                setEditing(null);
                setError("");
              }
            }}
          >
            <form
              key={editing?.id || preset}
              className="qd-model-form"
              onSubmit={(event) => {
                event.preventDefault();
                const values = Object.fromEntries(
                  new FormData(event.currentTarget),
                );
                delete values.reuseApiKey;
                void change(
                  editing
                    ? {
                        action: "update",
                        id: editing.id,
                        ...values,
                        apiFormat:
                          values.apiFormat || editing.apiFormat || "responses",
                        reuseApiKey: reuseKey,
                      }
                    : { action: "add", ...values },
                );
              }}
            >
              {!editing && (
                <label>
                  连接模板
                  <select
                    aria-label="连接模板"
                    value={preset}
                    disabled={locked}
                    onChange={(event) => {
                      setPreset(event.target.value);
                      setError("");
                    }}
                  >
                    <option value="custom">自定义连接</option>
                    <option value="deepseek">DeepSeek 官方连接</option>
                  </select>
                </label>
              )}
              {deepseek && (
                <p className="qd-model-preset-note">
                  已填入官方地址和常用模型，可按需选择。
                </p>
              )}
              <label>
                服务商
                <Input
                  name="service"
                  disabled={locked}
                  defaultValue={
                    editing?.service || (deepseek ? "DeepSeek 官方" : "")
                  }
                  required
                  maxLength={60}
                  placeholder="例如，团队模型服务"
                />
              </label>
              <label>
                API 接口地址
                <Input
                  name="baseUrl"
                  disabled={locked}
                  {...(editing
                    ? {
                        value: editUrl,
                        onChange: (event) => {
                          setEditUrl(event.target.value);
                          setReuseKey(false);
                        },
                      }
                    : {
                        defaultValue: deepseek
                          ? "https://api.deepseek.com"
                          : "",
                      })}
                  type="url"
                  required
                  placeholder="https://api.example.com/v1"
                />
              </label>
              {catalog.apiFormats?.includes("chat_completions") ? (
                <label>
                  接口类型
                  <select
                    name="apiFormat"
                    disabled={locked}
                    defaultValue={editing?.apiFormat || "responses"}
                  >
                    <option value="responses">OpenAI Responses</option>
                    <option value="chat_completions">
                      OpenAI Chat Completions
                    </option>
                  </select>
                </label>
              ) : (
                <small>使用兼容 Responses API 和工具调用的接口。</small>
              )}
              <label>
                模型 ID
                {deepseek ? (
                  <select
                    name="model"
                    defaultValue="deepseek-flash"
                    disabled={locked}
                  >
                    <option value="deepseek-flash">
                      DeepSeek Flash · 日常对话
                    </option>
                    <option value="deepseek-v4-pro">
                      DeepSeek V4 Pro · 复杂任务
                    </option>
                  </select>
                ) : (
                  <Input
                    name="model"
                    disabled={locked}
                    defaultValue={editing?.model || ""}
                    required
                    maxLength={160}
                    placeholder="填写服务商提供的模型 ID"
                  />
                )}
              </label>
              <label>
                API 密钥
                <Input
                  name="apiKey"
                  disabled={locked}
                  type="password"
                  required={!editing}
                  maxLength={4096}
                  autoComplete="off"
                  placeholder={editing ? "留空保留现有密钥" : undefined}
                  onChange={(event) =>
                    setKeyEntered(!!event.target.value.trim())
                  }
                />
                {editing && (
                  <small>已保存的密钥不会显示。留空保留，填写则替换。</small>
                )}
              </label>
              {editing && destinationChanged && !keyEntered && (
                <label className="qd-model-key-reuse">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={reuseKey}
                    onChange={(event) => setReuseKey(event.target.checked)}
                  />
                  将已保存的密钥用于新地址：{editUrl}
                </label>
              )}
              {error && (
                <p className="agent-error" role="alert">
                  {error}
                </p>
              )}
              <div className="agent-actions">
                <Button
                  className="primary"
                  disabled={
                    locked ||
                    (editing && destinationChanged && !keyEntered && !reuseKey)
                  }
                  type="submit"
                >
                  {saving ? "正在保存…" : editing ? "保存修改" : "保存模型连接"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setAdding(false);
                    setEditing(null);
                    setError("");
                  }}
                >
                  取消
                </Button>
              </div>
            </form>
          </WorkspaceDrawer>
        )}
      </section>
      {((error && !formOpen) || selectionError) && (
        <p className="agent-error" role="alert">
          {error || selectionError}
        </p>
      )}
      {notice && (
        <p className="agent-success" role="status">
          {notice}
        </p>
      )}
    </div>
  );
  return inline ? (
    content
  ) : (
    <WorkspaceDrawer title="设置" onClose={onClose}>
      {content}
    </WorkspaceDrawer>
  );
}
