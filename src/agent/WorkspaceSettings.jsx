import React, { useEffect, useState } from "react";
import { KeyRound, Cable, UserRound } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.jsx";
import "./workspace-information.css";

export default function WorkspaceSettings({
  models,
  onExecutionHost,
  executionUrl,
  retryKey,
  tools,
  preferences,
  onOpenDevices,
}) {
  const [tab, setTab] = useState("models");
  useEffect(() => {
    if (retryKey) setTab("models");
  }, [retryKey]);
  const tabs = [
    ["models", "对话模型", KeyRound],
    ["tools", "工具与 Agent", Cable],
    ["preferences", "个人偏好", UserRound],
  ];
  const executionSettings = executionUrl ? (
    <a href={executionUrl} target="_blank" rel="noreferrer">
      在完整工作区配置执行设置
    </a>
  ) : (
    <div
      className="agent-trial agent-settings-execution"
      ref={onExecutionHost}
    />
  );
  return (
    <section
      className="studio-resource agent-settings-page"
      aria-label="Agent 设置"
    >
      <header className="studio-page-heading">
        <div>
          <small>偏好与连接</small>
          <h2>设置</h2>
          <p className="studio-heading-description">
            管理对话模型、可用工具与长期偏好。
          </p>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="agent-settings-root">
        <TabsList className="agent-settings-tabs" aria-label="设置分类">
          {tabs.map(([key, label, Icon]) => (
            <TabsTrigger key={key} value={key} onClick={() => setTab(key)}>
              <Icon size={15} aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="models" forceMount hidden={tab !== "models"}>
          {models}
        </TabsContent>
        <TabsContent value="tools" forceMount hidden={tab !== "tools"}>
          {tools ? (
            tools(executionSettings)
          ) : (
            <details className="qd-agent-preferences">
              <summary>
                Codex <span>待办编程执行设置</span>
              </summary>
              {executionSettings}
            </details>
          )}
          {onOpenDevices && (
            <button className="qd-settings-device-link" onClick={onOpenDevices}>
              管理设备与本地服务 →
            </button>
          )}
        </TabsContent>
        <TabsContent
          value="preferences"
          forceMount
          hidden={tab !== "preferences"}
        >
          {preferences || <p className="agent-note">正在读取个人偏好…</p>}
        </TabsContent>
      </Tabs>
    </section>
  );
}
