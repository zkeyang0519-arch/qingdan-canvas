import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export async function localRunnerRequest(
  route,
  { body, accountId, ...options } = {},
) {
  const response = await fetch(`/api/local-runner${route}`, {
    ...options,
    credentials: "same-origin",
    signal: AbortSignal.timeout(45000),
    headers: {
      "X-Qingdan-Local": "1",
      "X-QD-Account": accountId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("本机 Runner 尚未启动，请使用本机体验入口。");
  }
  if (!response.ok) throw Error(data.error || "本机 Runner 请求失败。");
  return data;
}

const statusLabel = {
  unpaired: "尚未绑定",
  connecting: "正在连接",
  online: "在线",
  offline: "离线",
  revoked: "已撤销",
  error: "连接异常",
};
const heartbeatLabel = (value) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
    : "等待首次心跳";

export default function DevicePanel({
  roomId,
  userId,
  pages = [],
  requestCloud = api,
  requestLocal = localRunnerRequest,
}) {
  const [local, setLocal] = useState(null);
  const [devices, setDevices] = useState([]);
  const [cloudReady, setCloudReady] = useState(false);
  const [localError, setLocalError] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [root, setRoot] = useState("");
  const [sectionId, setSectionId] = useState(pages[0]?.id || "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [binding, setBinding] = useState(null);
  const [bindingReady, setBindingReady] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++version.current;
    const results = await Promise.allSettled([
      requestLocal("/status", { accountId: userId }),
      requestCloud("/api/agent/devices", { accountId: userId }),
      sectionId
        ? requestCloud(
            `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(sectionId)}`,
            { accountId: userId },
          )
        : Promise.resolve({ binding: null }),
    ]);
    if (!mounted.current || epoch !== version.current) return;
    const [localResult, devicesResult, bindingResult] = results;
    if (localResult.status === "fulfilled") {
      setLocal(localResult.value);
      setLocalError("");
    } else {
      setLocal(null);
      setLocalError(localResult.reason.message);
    }
    if (devicesResult.status === "fulfilled") {
      setDevices(devicesResult.value.devices || []);
      setCloudReady(devicesResult.value.enabled === true);
      setCloudError(
        devicesResult.value.enabled === true ? "" : "此环境尚未启用设备绑定。",
      );
    } else {
      setCloudReady(false);
      setCloudError(devicesResult.reason.message);
    }
    if (bindingResult.status === "fulfilled") {
      setBinding(bindingResult.value.binding || null);
      setBindingReady(true);
    } else {
      setBindingReady(false);
      setCloudError(bindingResult.reason.message);
    }
    setLoaded(true);
  }, [roomId, sectionId, userId, requestCloud, requestLocal]);

  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const poll = () => {
      if (busyRef.current || polling) return;
      polling = true;
      void refresh().finally(() => {
        polling = false;
      });
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      mounted.current = false;
      version.current++;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!pages.some((page) => page.id === sectionId)) {
      setSectionId(pages[0]?.id || "");
      setBinding(null);
      setBindingReady(false);
    }
  }, [pages, sectionId]);

  const workspaces = local?.workspaces || [];
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.workspaceId === workspaceId) ||
    workspaces[0];
  const device = devices.find((item) => item.runnerId === local?.runnerId);
  const paired = local?.paired === true;
  const canControl = !!local && cloudReady && !busy;
  const connection = local?.connectionStatus || "offline";
  const currentBinding =
    binding?.enabled &&
    binding.runnerId === local?.runnerId &&
    workspaces.some(
      (workspace) => workspace.workspaceId === binding.workspaceId,
    );

  const localAction = (route, body = {}) =>
    requestLocal(route, { method: "POST", body, accountId: userId });
  const cloudAction = (route, body = {}) =>
    requestCloud(route, { method: "POST", body, accountId: userId });
  async function perform(operation, success) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    version.current++;
    setActionError("");
    setMessage("");
    try {
      await operation();
      if (mounted.current) setMessage(success);
    } catch (error) {
      if (mounted.current) setActionError(error.message);
    } finally {
      if (mounted.current) await refresh();
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="agent-trial agent-device-panel">
      <div className="agent-intro">
        <h3>把这台电脑连接到轻单</h3>
        <p>
          绑定当前账号，选择允许执行的项目，再把项目关联到清单。关闭网页后，本机服务仍会保持连接。
        </p>
      </div>
      {!loaded && (
        <p className="agent-note" role="status">
          正在读取电脑状态…
        </p>
      )}
      {localError && (
        <div className="agent-setup">
          <strong>需要启动本机 Runner</strong>
          <p className="agent-note">
            在轻单项目目录运行 <code>npm run dev:agent</code>，然后打开{" "}
            <a href="http://127.0.0.1:8790">本机体验入口</a>。
          </p>
          <p className="agent-note">{localError}</p>
        </div>
      )}
      {cloudError && (
        <p className="agent-error" role="alert">
          {cloudError}
        </p>
      )}
      {actionError && (
        <p className="agent-error" role="alert">
          {actionError}
        </p>
      )}
      {message && (
        <p className="agent-success" role="status">
          {message}
        </p>
      )}

      <section className="agent-device-card" aria-label="这台电脑">
        <div className="agent-card-heading">
          <strong>{paired ? local.deviceName : "这台电脑"}</strong>
          <span
            className={`agent-device-badge ${connection === "online" ? "online" : ""}`}
          >
            <i
              className={`agent-dot ${connection === "online" ? "connected" : ""}`}
            />
            {paired ? statusLabel[connection] : "尚未绑定"}
          </span>
        </div>
        {paired ? (
          <>
            <p className="agent-note">
              已绑定当前轻单账号 · 轻单识别状态：
              {device ? statusLabel[device.status] : "等待同步"}
            </p>
            <p className="agent-note">
              最近心跳：{heartbeatLabel(local.lastHeartbeatAt)} · 设备凭据保存在
              Windows 凭据管理器
            </p>
            {local.error && <p className="agent-error">{local.error}</p>}
            <div className="agent-actions">
              <button
                disabled={!canControl || connection === "revoked"}
                onClick={() =>
                  perform(
                    () =>
                      localAction("/connection", { enabled: !local.enabled }),
                    local.enabled
                      ? "已暂时断开连接。"
                      : "已恢复连接，正在更新状态。",
                  )
                }
              >
                {local.enabled ? "暂时断开" : "继续连接"}
              </button>
              <button
                disabled={!canControl || connection === "revoked"}
                onClick={() =>
                  perform(() => localAction("/reconnect"), "已请求重新连接。")
                }
              >
                重新连接
              </button>
              <button
                disabled={!canControl}
                className="agent-danger-text"
                onClick={() => setConfirmRevoke(true)}
              >
                解除绑定
              </button>
            </div>
            {confirmRevoke && (
              <div className="agent-revoke-confirm">
                <p>解除后，这台电脑的项目授权和清单关联将失效。</p>
                <div className="agent-actions">
                  <button
                    disabled={busy}
                    className="agent-danger-text"
                    onClick={() =>
                      perform(async () => {
                        await cloudAction(
                          `/api/agent/devices/${encodeURIComponent(local.runnerId)}/revoke`,
                        );
                        await localAction("/forget");
                        setConfirmRevoke(false);
                      }, "已解除这台电脑的绑定。")
                    }
                  >
                    确认解除绑定
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setConfirmRevoke(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="agent-device-pair">
            <label>
              电脑名称
              <input
                aria-label="电脑名称"
                placeholder={local?.deviceName || "我的电脑"}
                value={deviceName}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
            <button
              disabled={!canControl}
              onClick={() =>
                perform(async () => {
                  const pairing = await cloudAction(
                    "/api/agent/devices/pairings",
                  );
                  await localAction("/pair", {
                    pairingCode: pairing.pairingCode,
                    deviceName:
                      deviceName.trim() || local.deviceName || "我的电脑",
                  });
                }, "已绑定这台电脑，正在同步连接状态。")
              }
            >
              {busy ? "正在绑定…" : "绑定这台电脑"}
            </button>
          </div>
        )}
      </section>

      {paired && (
        <>
          <section className="agent-device-card" aria-label="允许的项目">
            <h4>允许执行的项目</h4>
            <p className="agent-note">
              添加你允许 Runner 使用的目录。之后只能向已授权的项目派发任务。
            </p>
            <div className="agent-device-add">
              <label>
                项目目录
                <input
                  aria-label="允许执行的项目目录"
                  placeholder="例如 D:\\Projects\\my-project"
                  value={root}
                  disabled={busy}
                  onChange={(event) => setRoot(event.target.value)}
                />
              </label>
              <button
                disabled={
                  !canControl || !root.trim() || connection === "revoked"
                }
                onClick={() =>
                  perform(async () => {
                    await localAction("/workspaces", { root: root.trim() });
                    setRoot("");
                  }, "项目目录已保存。")
                }
              >
                添加项目
              </button>
            </div>
            {workspaces.length ? (
              <ul className="agent-workspace-list">
                {workspaces.map((workspace) => (
                  <li key={workspace.workspaceId}>
                    <div>
                      <strong>{workspace.name}</strong>
                      <p className="agent-path">{workspace.displayPath}</p>
                    </div>
                    <button
                      disabled={!canControl || connection === "revoked"}
                      aria-label={`移除项目 ${workspace.name}`}
                      onClick={() =>
                        perform(
                          () =>
                            localAction("/workspaces/remove", {
                              workspaceId: workspace.workspaceId,
                            }),
                          "已移除项目授权，相关清单关联已停用。",
                        )
                      }
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="agent-note">还没有授权项目。</p>
            )}
          </section>
          <section className="agent-device-card" aria-label="清单关联">
            <h4>关联到清单</h4>
            <div className="agent-field-grid">
              <label>
                当前画布中的清单
                <select
                  aria-label="选择清单"
                  value={sectionId}
                  disabled={busy || !pages.length}
                  onChange={(event) => {
                    version.current++;
                    setSectionId(event.target.value);
                    setBinding(null);
                    setBindingReady(false);
                  }}
                >
                  <option value="" disabled>
                    请选择清单
                  </option>
                  {pages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title || "未命名清单"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                执行项目
                <select
                  aria-label="选择执行项目"
                  value={selectedWorkspace?.workspaceId || ""}
                  disabled={busy || !workspaces.length}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  <option value="" disabled>
                    请先添加项目
                  </option>
                  {workspaces.map((workspace) => (
                    <option
                      key={workspace.workspaceId}
                      value={workspace.workspaceId}
                    >
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="agent-actions agent-binding-actions">
              <button
                disabled={
                  !canControl ||
                  !bindingReady ||
                  !sectionId ||
                  !selectedWorkspace ||
                  connection !== "online"
                }
                onClick={() =>
                  perform(async () => {
                    const result = await cloudAction("/api/agent/bindings", {
                      canvasId: roomId,
                      sectionId,
                      runnerId: local.runnerId,
                      workspaceId: selectedWorkspace.workspaceId,
                      expectedRevision: binding?.revision ?? null,
                    });
                    setBinding(result.binding);
                  }, "当前清单已绑定到所选项目。")
                }
              >
                绑定到当前清单
              </button>
              {currentBinding && (
                <span className="agent-bound-label">
                  当前清单已绑定 ·{" "}
                  {
                    workspaces.find(
                      (workspace) =>
                        workspace.workspaceId === binding.workspaceId,
                    )?.name
                  }
                </span>
              )}
            </div>
            {!pages.length && (
              <p className="agent-note">请先在画布中添加一份清单。</p>
            )}
            <p className="agent-note">
              本步骤验证设备连接和项目关联；任务派发将在下一步接入。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
