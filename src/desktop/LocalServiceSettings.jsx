import React, { useEffect, useState } from "react";

export default function LocalServiceSettings({ bridge }) {
  const [state, setState] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!bridge?.getLocalService) return;
    let active = true,
      revised = false;
    const unsubscribe = bridge.onLocalServiceState?.((next) => {
      revised = true;
      if (active) setState(next);
    });
    Promise.resolve(bridge.getLocalService())
      .then((next) => {
        if (active && !revised) setState(next);
      })
      .catch(() => {
        if (active) setError("本地服务状态暂不可用。");
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge]);
  if (!bridge?.getLocalService) return null;
  async function run(method) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge[method]();
      if (result?.status) setState(result);
    } catch (cause) {
      setError(cause.message || "本地服务操作未完成。");
    } finally {
      setBusy(false);
    }
  }
  const online = ["online", "external"].includes(state?.status);
  return (
    <section className="island-local-service" aria-label="本地服务设置">
      <div className="island-settings-row">
        <span>
          本地服务
          {state?.version && state.managed && (
            <small>v{state.version} · 随轻岛更新</small>
          )}
        </span>
        <button
          disabled={
            busy || !state || ["unsupported", "starting"].includes(state.status)
          }
          onClick={() =>
            run(
              online
                ? "openLocalWorkspace"
                : state.status === "error"
                  ? "retryLocalService"
                  : "startLocalService",
            )
          }
        >
          {busy || state?.status === "starting"
            ? "正在准备…"
            : online
              ? "打开工作区"
              : state?.status === "error"
                ? "重试连接"
                : "添加本地服务"}
        </button>
      </div>
      <p
        className="island-update-message"
        role={error || state?.error ? "status" : undefined}
      >
        {error ||
          state?.error ||
          (online
            ? "已连接，可使用本机 Agent 与 MCP 工具。"
            : "启用内置服务后，在本机运行 Agent；配置与执行回执保存在独立数据目录。")}
      </p>
      {state?.status === "online" && (
        <button
          className="island-service-stop"
          disabled={busy}
          onClick={() => run("stopLocalService")}
        >
          停用本地服务
        </button>
      )}
      {state?.status === "external" && (
        <button
          className="island-service-stop"
          disabled={busy}
          onClick={() => run("retryLocalService")}
        >
          重新检测
        </button>
      )}
    </section>
  );
}
