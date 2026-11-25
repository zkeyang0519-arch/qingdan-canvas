import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AgentWorkspace from "../../src/agent/AgentWorkspace.jsx";
import "../../src/app.css";
const binding = {
  bindingId: "visual-binding",
  revision: 1,
  runnerId: "visual-runner",
  workspaceId: "visual-workspace",
  enabled: true,
};
let catalog = {
  configured: true,
  defaultId: "existing",
  modelsEndpoint: "/api/agent/chat/models",
  apiFormats: ["responses", "chat_completions"],
  profiles: [
    {
      id: "existing",
      service: "DeepSeek",
      model: "deepseek-v4-pro",
      configured: true,
    },
    {
      id: "secondary",
      service: "团队备用连接",
      model: "已有模型",
      configured: true,
    },
  ],
};
const thread = {
  id: "visual-chat",
  modelProfileId: "existing",
  title: "工作区整理",
};
let memories = [
  {
    id: "m1",
    scope: "personal",
    key: "沟通习惯",
    value: "先说明结论和验证结果，使用中文。",
    revision: 1,
  },
  {
    id: "m2",
    scope: "project",
    bindingId: binding.bindingId,
    key: "界面约定",
    value: "待办直接在原行编辑，保存后保留当前选择。",
    revision: 1,
  },
];
let retention = {
  settings: { mode: "auto", revision: 1 },
  jobs: [
    {
      id: "review-1",
      taskId: "task-1",
      sourceJobId: "job-1",
      status: "retained",
      goal: "整理设置与项目资料",
      updatedAt: Date.now(),
      candidates: [
        {
          kind: "method",
          scope: "project",
          key: "核对工具连接",
          value: "先查询当前服务状态，再依据回执判断连接是否可用。",
          whenApplicable: "历史摘要称服务无法使用时",
          status: "saved",
          evidence: [
            { id: "e1", label: "连接检查通过", kind: "tool", ok: true },
          ],
        },
      ],
    },
  ],
};
const project = {
  bindingId: binding.bindingId,
  bindingRevision: 1,
  status: "ready",
  ready: true,
  summaryRevision: 3,
  sourceRunId: "summary-1",
  sourceKind: "project_current",
  capturedAt: "2026-11-25T04:00:00Z",
  summary: {
    overview: "简化设置与项目资料，保留现有模型、MCP 配置和全部待办功能。",
    background: { purpose: "让轻单更容易找到和使用", stage: "功能验收" },
    modules: [
      {
        name: "设置与工具",
        status: "in_progress",
        current: [{ text: "模型、工具与个人偏好已归位" }],
        remaining: [{ text: "检查窄屏下的长名称" }],
        nextSteps: [{ text: "验证连接操作" }],
      },
    ],
    inProgress: [{ text: "核对桌面与手机布局" }],
    pending: [{ text: "完成未签名安装包验收" }],
    blockers: [],
    uncertainties: [],
    completed: [{ text: "待办原行编辑已完成" }],
    verification: [{ text: "保留全部模型连接与 MCP 工具选择" }],
  },
};
let tasks = [
  {
    noteId: "note",
    taskId: "todo-1",
    text: "验证完整的设置与项目资料",
    done: false,
    locked: false,
    instruction: "验证完整的设置与项目资料",
    acceptance: "原行编辑与保存正常",
    generation: 1,
    specRevision: 1,
    specStatus: "ready",
    editableText: true,
  },
];
let servers = [
  {
    id: "builtin-codex",
    kind: "codex",
    name: "Codex",
    status: "ready",
    tools: [
      { name: "codex_read", label: "读取项目", description: "读取项目文件" },
    ],
    selected: ["codex_read"],
  },
  {
    id: "builtin-waao",
    kind: "waao",
    name: "WAAO",
    status: "ready",
    tools: [
      {
        name: "project_list",
        label: "查询项目",
        description: "列出当前账号项目",
      },
      {
        name: "node_generate",
        label: "提交生成",
        description: "使用已选项目生成",
      },
    ],
    selected: ["project_list"],
  },
  {
    id: "custom-1",
    name: "团队编码助手",
    integrationKind: "agent",
    url: "https://example.com/mcp",
    authMode: "auto",
    status: "ready",
    tools: [{ name: "review", label: "代码审查", description: "审查变更" }],
    selected: [],
  },
];
let sequence = 1,
  rerender = () => {};
const pages = () => [
  {
    id: "visual-project",
    title: "轻单 · 工作区升级",
    tasks: tasks.map((t) => ({
      key: t.taskId,
      note: { id: t.noteId, noteKind: "checklist" },
      block: { done: t.done, runs: [{ type: "text", text: t.text }] },
    })),
  },
];
const cloud = async (route, options = {}) => {
  const body = options.body || {};
  if (route.startsWith("/api/agent/bindings?")) return { binding };
  if (route === "/api/agent/devices")
    return {
      devices: [
        {
          runnerId: binding.runnerId,
          status: "online",
          workspaces: [
            { workspaceId: binding.workspaceId, name: "隔离界面验收" },
          ],
        },
      ],
    };
  if (route.startsWith("/api/agent/project/state")) return project;
  if (route.startsWith("/api/agent/chat/state"))
    return {
      provider: catalog,
      threads: [thread],
      thread,
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "设置、项目资料与长期偏好已整理。",
          createdAt: new Date().toISOString(),
        },
      ],
      memories,
      memoryEpoch: sequence,
      retention,
      job: null,
      hasMore: false,
      mcpAvailable: true,
      project,
    };
  if (route.startsWith("/api/agent/chat/personal"))
    return {
      memories: memories.filter((m) => m.scope === "personal"),
      retention,
      memoryEpoch: sequence,
    };
  if (route.startsWith("/api/agent/chat/memory")) {
    if (body.action === "save") {
      const existing = memories.find((m) => m.id === body.id);
      const value = {
        ...body,
        id: body.id || "m" + Date.now(),
        revision: (existing?.revision || 0) + 1,
      };
      memories = memories.filter((m) => m.id !== value.id).concat(value);
    } else memories = memories.filter((m) => m.id !== body.id);
    sequence++;
    return { memories, memoryEpoch: sequence };
  }
  if (route.endsWith("/retention")) {
    if (body.action === "settings")
      retention = {
        ...retention,
        settings: {
          mode: body.mode,
          revision: retention.settings.revision + 1,
        },
      };
    return { retention, memories, memoryEpoch: sequence };
  }
  if (route.startsWith("/local/mcp")) {
    if (body.action === "enable")
      servers = servers.map((s) =>
        s.id === body.id ? { ...s, selected: body.tools } : s,
      );
    if (body.action === "category")
      servers = servers.map((s) =>
        s.id === body.id ? { ...s, integrationKind: body.kind } : s,
      );
    return { servers };
  }
  if (route === "/api/agent/chat/models") {
    if (body.action === "default") catalog = { ...catalog, defaultId: body.id };
    return catalog;
  }
  if (route.endsWith("/chat/model")) {
    thread.modelProfileId = body.modelProfileId;
    return { thread };
  }
  if (route.includes("/execution/runs?")) return { runs: [] };
  if (route.endsWith("/checklist")) {
    if (body.action === "save") {
      tasks = tasks.map((t) =>
        t.taskId === body.taskId
          ? { ...t, ...body, generation: t.generation + 1 }
          : t,
      );
      sequence++;
      rerender();
    }
    return {
      canvasId: "visual-room",
      sectionId: "visual-project",
      sequence,
      tasks: structuredClone(tasks),
      operationId: "op-" + sequence,
    };
  }
  return {};
};
function Preview() {
  const [list, setList] = useState(pages);
  rerender = () => setList(pages());
  return (
    <div
      className="app-shell cloud-canvas agent-mode"
      style={{ height: "100%", width: "100%" }}
    >
      <AgentWorkspace
        roomId="visual-room"
        userId="visual-only-user"
        pages={list}
        requestCloud={cloud}
        requestLocal={async (route) =>
          route.startsWith("/codex/models")
            ? {
                models: [
                  {
                    id: "gpt-6.1-terra",
                    name: "当前 Codex 模型",
                    supportsFast: true,
                    isDefault: true,
                  },
                ],
              }
            : {
                paired: true,
                runnerId: binding.runnerId,
                connectionStatus: "online",
                sessions: [],
              }
        }
      />
    </div>
  );
}
document.documentElement.style.cssText = "height:100%;background:#f5f6f2";
document.body.style.cssText = "margin:0;height:100vh";
document.getElementById("root").style.cssText = "height:100%";
createRoot(document.getElementById("root")).render(<Preview />);
