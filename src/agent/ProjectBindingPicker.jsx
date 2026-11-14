import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Monitor } from "lucide-react";
import CodexProjectPicker from "./CodexProjectPicker.jsx";
import "./binding-picker.css";

export default function ProjectBindingPicker(props) {
  return (
    <BindingScope
      key={JSON.stringify([props.userId, props.roomId])}
      {...props}
    />
  );
}

function BindingScope({
  roomId,
  userId,
  page,
  requestLocal,
  requestCloud,
  onCreateProject,
  onBound,
  onOpenSettings,
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [localLookup, setLocalLookup] = useState(null);
  const [cloudLookup, setCloudLookup] = useState(null);
  const [agentId, setAgentId] = useState("");
  const [deviceAttempt, setDeviceAttempt] = useState(0);
  const mounted = useRef(false);
  const choosing = useRef(false);
  const createdPage = useRef(null);
  const latest = useRef(null);

  useLayoutEffect(() => {
    latest.current = {
      page,
      requestLocal,
      requestCloud,
      onCreateProject,
      onBound,
    };
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const isCurrent = () => active && mounted.current;
    const discover = async (request, route, options, update, fallback) => {
      try {
        const data = await request(route, { accountId: userId, ...options });
        if (isCurrent()) update({ data, attempt: deviceAttempt });
      } catch (failure) {
        if (isCurrent())
          update({
            error: failure?.message || fallback,
            attempt: deviceAttempt,
          });
      }
    };
    void discover(
      latest.current.requestLocal,
      "/status",
      {},
      setLocalLookup,
      "无法读取本机设备。",
    );
    void discover(
      latest.current.requestCloud,
      "/api/agent/devices",
      { isCurrentSession: isCurrent },
      setCloudLookup,
      "无法读取已连接设备。",
    );
    return () => {
      active = false;
    };
  }, [userId, deviceAttempt]);

  const localState = localLookup?.data;
  const devices = cloudLookup?.data?.devices || [];
  const loadingDevices =
    localLookup?.attempt !== deviceAttempt ||
    cloudLookup?.attempt !== deviceAttempt;
  const deviceErrors = [localLookup, cloudLookup]
    .filter((lookup) => lookup?.attempt === deviceAttempt && lookup.error)
    .map((lookup) => lookup.error);
  const remoteDevices = devices.filter(
    (device) =>
      device.status !== "revoked" &&
      (device.runnerId !== localState?.runnerId || device.runnerId === agentId),
  );
  const localAvailable =
    localState && localState.connectionStatus !== "revoked";
  const canChooseDevice =
    localAvailable ||
    remoteDevices.some((device) => device.status === "online");
  const selectedDevice = devices.find((device) => device.runnerId === agentId);

  async function choose(project) {
    if (choosing.current || !agentId) return;
    const isLocalAgent =
      agentId === "local" || agentId === localState?.runnerId;
    const pageId = page?.id;
    let sectionId = pageId || createdPage.current;
    const isCurrent = () => {
      const currentPageId = latest.current.page?.id;
      return (
        mounted.current &&
        (pageId
          ? currentPageId === pageId
          : !currentPageId || currentPageId === sectionId)
      );
    };
    function assertCurrent() {
      if (!isCurrent()) throw Error("项目选择已关闭或当前项目已变化。");
    }
    async function request(source, route, body) {
      assertCurrent();
      const result = await latest.current[source](route, {
        accountId: userId,
        ...(source === "requestCloud" ? { isCurrentSession: isCurrent } : {}),
        ...(body === undefined ? {} : { method: "POST", body }),
      });
      assertCurrent();
      return result;
    }
    const local = (route, body) => request("requestLocal", route, body);
    const cloud = (route, body) => request("requestCloud", route, body);
    const readBinding = (sectionId) =>
      cloud(
        `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(sectionId)}`,
      );

    choosing.current = true;
    setBusy(true);
    setError("");
    setMessage("正在核对设备与目录…");
    try {
      let existing = sectionId ? (await readBinding(sectionId)).binding : null;
      let result;
      if (!isLocalAgent) {
        const latest = await cloud("/api/agent/devices");
        const device = latest.devices?.find(
          (item) => item.runnerId === agentId,
        );
        const workspace = device?.workspaces?.find(
          (item) => item.workspaceId === project.workspaceId,
        );
        if (device?.status !== "online" || !workspace)
          throw Error("所选 agent 已离线或项目授权已变化，请重新选择。");
        result = { runnerId: device.runnerId, workspace };
      } else {
        let state = await local("/status");
        if (localState?.runnerId && state.runnerId !== localState.runnerId)
          throw Error("这台电脑的 agent 绑定已变化，请关闭后重新选择。");
        if (project.workspaceId) {
          if (!state.paired || !state.runnerId)
            throw Error("所选目录的设备授权已变化，请重新选择。");
          const query = new URLSearchParams({
            runnerId: state.runnerId,
            workspaceId: project.workspaceId,
          });
          result = await local(`/workspaces/verify?${query}`);
          if (
            result?.runnerId !== state.runnerId ||
            result?.workspace?.workspaceId !== project.workspaceId
          )
            throw Error("所选目录的设备授权已变化，请重新选择。");
        }
        if (!state.paired) {
          const pairing = await cloud("/api/agent/devices/pairings", {});
          state = await local("/pair", {
            pairingCode: pairing.pairingCode,
            deviceName: state.deviceName || "我的电脑",
          });
        }
        if (state.connectionStatus === "revoked")
          throw Error("这台电脑的授权已撤销，请在设备管理中重新连接。");
        if (!state.enabled)
          state = await local("/connection", { enabled: true });
        else if (["offline", "error"].includes(state.connectionStatus))
          state = await local("/reconnect", {});
        const deadline = Date.now() + 20000;
        while (state.connectionStatus !== "online") {
          if (Date.now() >= deadline || state.connectionStatus === "revoked")
            throw Error("电脑尚未连接成功，请稍后重试或查看设备管理。");
          state = await local("/status");
          if (state.connectionStatus !== "online")
            await new Promise((resolve) => setTimeout(resolve, 400));
          assertCurrent();
        }
        setMessage("正在关联项目目录…");
        if (!result) {
          result = await local("/codex/select", { threadId: project.threadId });
        }
        if (state.runnerId && result.runnerId !== state.runnerId)
          throw Error("项目所属 agent 已变化，请重新选择。");
      }
      if (!sectionId) {
        assertCurrent();
        sectionId = await latest.current.onCreateProject?.(
          result.workspace.name,
        );
        assertCurrent();
        if (typeof sectionId !== "string" || !sectionId)
          throw Error("无法创建轻单项目，请重试。");
        createdPage.current = sectionId;
        existing = (await readBinding(sectionId)).binding;
      }
      const unchanged =
        existing?.enabled &&
        existing.runnerId === result.runnerId &&
        existing.workspaceId === result.workspace.workspaceId;
      if (unchanged) {
        const latest = (await readBinding(sectionId)).binding;
        if (
          latest?.bindingId !== existing.bindingId ||
          latest?.revision !== existing.revision ||
          !latest?.enabled
        )
          throw Error("项目关联已变化，请重新选择项目。");
      }
      const binding = unchanged
        ? existing
        : (
            await cloud("/api/agent/bindings", {
              canvasId: roomId,
              sectionId,
              runnerId: result.runnerId,
              workspaceId: result.workspace.workspaceId,
              expectedRevision: existing?.revision ?? null,
            })
          ).binding;
      assertCurrent();
      setMessage("项目已关联。");
      latest.current.onBound?.({
        ...result,
        sectionId,
        binding,
        isLocalAgent,
      });
    } catch (failure) {
      if (mounted.current) {
        setMessage("");
        setError(failure?.message || "关联失败，请重试。");
      }
    } finally {
      choosing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="agent-project-binding-picker" aria-busy={busy}>
      <section className="agent-binding-source" aria-label="执行设备">
        <label className="agent-binding-device-field">
          <span>执行设备</span>
          <span className="agent-binding-device-control">
            <Monitor size={17} aria-hidden="true" />
            <select
              aria-label="选择 agent 与设备"
              value={agentId}
              disabled={busy || (loadingDevices && !canChooseDevice)}
              onChange={(event) => {
                setAgentId(event.target.value);
                setError("");
                setMessage("");
              }}
            >
              <option value="">
                {loadingDevices && !canChooseDevice
                  ? "正在读取设备…"
                  : "选择设备"}
              </option>
              {localState && (
                <option value="local" disabled={!localAvailable}>
                  {localState.deviceName
                    ? `${localState.deviceName}（本机）`
                    : "这台电脑"}
                  {!localAvailable ? " · 已撤销" : ""}
                </option>
              )}
              {remoteDevices.map((device) => (
                <option
                  key={device.runnerId}
                  value={device.runnerId}
                  disabled={device.status !== "online"}
                >
                  {device.deviceName || "已绑定设备"}
                  {device.status !== "online" ? " · 离线" : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        {deviceErrors.length > 0 && (
          <div className="agent-binding-feedback">
            <p role="status">{deviceErrors.join(" ")}</p>
            <button
              type="button"
              disabled={busy || loadingDevices}
              onClick={() => setDeviceAttempt((attempt) => attempt + 1)}
            >
              重试读取设备
            </button>
          </div>
        )}
        {!loadingDevices && !canChooseDevice && (
          <div className="agent-binding-feedback">
            <p>暂无可用设备，请在设备管理中连接电脑。</p>
            {onOpenSettings && (
              <button type="button" disabled={busy} onClick={onOpenSettings}>
                设备管理
              </button>
            )}
          </div>
        )}
      </section>

      <section
        className="agent-binding-destinations"
        aria-label="Codex 项目目录"
      >
        <div className="agent-binding-heading">
          <h3>Codex 项目目录</h3>
          {page?.title && <span title={page.title}>关联到 {page.title}</span>}
        </div>
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="agent-binding-message" role="status">
            {message}
          </p>
        )}
        {agentId === "local" && localAvailable ? (
          <CodexProjectPicker
            key={`local/${localState.runnerId || "unpaired"}`}
            userId={userId}
            requestLocal={requestLocal}
            workspaces={localState.workspaces}
            mode="select"
            disabled={busy || (!page && !onCreateProject)}
            onSelect={(project) => void choose(project)}
          />
        ) : selectedDevice ? (
          <CodexProjectPicker
            key={selectedDevice.runnerId}
            userId={userId}
            workspaces={selectedDevice.workspaces}
            mode="select"
            disabled={
              busy ||
              selectedDevice.status !== "online" ||
              (!page && !onCreateProject)
            }
            onSelect={(project) => void choose(project)}
          />
        ) : (
          <p className="agent-binding-empty">选择设备后查看项目目录。</p>
        )}
      </section>
    </div>
  );
}
