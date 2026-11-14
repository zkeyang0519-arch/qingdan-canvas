import { useEffect, useState } from "react";
import { executionSettingsSchema } from "../../shared/agent/model-settings.ts";

export const defaultExecutionSettings = {
  agent: "codex",
  model: "",
  fastMode: false,
  followCodex: true,
};
export const followsCodex = (value) =>
  value.followCodex !== false && !value.model && !value.fastMode;

export function executionSettingsPayload(value, catalog) {
  const follows = followsCodex(value);
  const current = catalog?.current;
  const model = value.model || current?.model;
  if (follows && !current?.model) return undefined;
  return {
    ...(model ? { model } : {}),
    fastMode: follows ? !!current?.fastMode : value.fastMode,
    ...(current?.model === model && current?.reasoningEffort
      ? { reasoningEffort: current.reasoningEffort }
      : {}),
  };
}
export const validExecutionDefaults = (value) =>
  !!value &&
  value.agent === "codex" &&
  typeof value.model === "string" &&
  (value.followCodex === undefined || typeof value.followCodex === "boolean") &&
  executionSettingsSchema.safeParse({
    ...(value.model ? { model: value.model } : {}),
    fastMode: value.fastMode,
  }).success;

export function useCodexModelCatalog(
  accountId,
  binding,
  requestLocal,
  enabled,
) {
  const identity = JSON.stringify([
    accountId,
    binding?.bindingId,
    binding?.revision,
    binding?.runnerId,
    binding?.workspaceId,
  ]);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState({
    identity,
    status: "loading",
    models: [],
    error: "",
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState((prior) => ({
      identity,
      status: "loading",
      models: prior.identity === identity ? prior.models : [],
      current: prior.identity === identity ? prior.current : null,
      error: "",
    }));
    requestLocal("/status", { accountId })
      .then((local) => {
        if (!active) return;
        if (!binding?.runnerId || !local?.runnerId)
          throw Error("无法确认当前电脑身份，请检查电脑连接后刷新模型列表。");
        if (local.runnerId !== binding.runnerId)
          throw Error(
            "当前项目关联的是另一台电脑，请在关联的电脑上读取模型列表。",
          );
        const query = binding.workspaceId
          ? "?" +
            new URLSearchParams({
              runnerId: binding.runnerId,
              workspaceId: binding.workspaceId,
            })
          : "";
        return requestLocal(`/codex/models${query}`, { accountId });
      })
      .then((result) => {
        if (!active) return;
        if (!Array.isArray(result.models) || !result.models.length)
          throw Error("无法读取模型列表，请刷新重试。");
        if (active)
          setState({
            identity,
            status: "ready",
            models: result.models,
            current: result.current || null,
            error: "",
          });
      })
      .catch((error) => {
        if (active)
          setState({
            identity,
            status: "error",
            models: [],
            error: error.message,
          });
      });
    return () => {
      active = false;
    };
  }, [identity, accountId, requestLocal, reload, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setReload((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled]);
  return {
    ...(state.identity === identity
      ? state
      : { status: "loading", models: [], error: "" }),
    refresh: () => setReload((value) => value + 1),
  };
}

export const selectedExecutionModel = (value, catalog) =>
  value.model || catalog.current?.model
    ? catalog.models.find(
        (model) => model.id === (value.model || catalog.current.model),
      )
    : catalog.models.find((model) => model.isDefault);

export function executionSettingsIssue(value, catalog) {
  // Native default remains usable even if this browser cannot read the catalog.
  if (followsCodex(value)) return "";
  if (catalog.status === "loading") return "正在读取可用模型，请稍候。";
  if (catalog.status === "error")
    return "无法核对默认模型，请打开执行设置刷新模型列表。";
  const model = selectedExecutionModel(value, catalog);
  if (!model) return "默认模型暂不可用，请打开执行设置重新选择。";
  if (value.fastMode && !model.supportsFast)
    return "当前模型不支持快速模式，请更新执行设置。";
  return "";
}
