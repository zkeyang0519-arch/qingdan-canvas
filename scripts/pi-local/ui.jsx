import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../../src/agent/AgentWorkspace.jsx";
import "./preview.css";

async function requestCloud(url, { method = "GET", body, signal } = {}) {
  const response = await fetch(url, {
    method,
    signal,
    headers: {
      "X-QD-Account": "pi-local",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || "本机请求失败。"), {
      status: response.status,
    });
  return result;
}
function LocalWorkspace({ initialProjects }) {
  const [projects, setProjects] = useState(initialProjects);
  async function createProject(name) {
    const row = await requestCloud("/local/projects", {
      method: "POST",
      body: { id: crypto.randomUUID(), name },
    });
    setProjects((current) => [...current, row]);
    return row.id;
  }
  return (
    <Workspace
      fullWorkspaceUrl="http://127.0.0.1:8790/app"
      localQuestionInbox
      userId="pi-local"
      roomId="pi-local-room"
      pages={projects}
      requestCloud={requestCloud}
      onCreateProject={createProject}
      requestLocal={localConnection}
    />
  );
}
const localConnection = () =>
  Promise.resolve({ paired: true, connectionStatus: "online" });

async function start() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (ticket) {
    history.replaceState(null, "", "/");
    await requestCloud("/local/session", { method: "POST", body: { ticket } });
  }
  const session = await requestCloud("/local/status");
  createRoot(document.getElementById("root")).render(
    <LocalWorkspace initialProjects={session.projects} />,
  );
}
start().catch((error) => {
  document.getElementById("root").textContent = error.message;
});
