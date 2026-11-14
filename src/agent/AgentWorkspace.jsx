import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Activity,
  Folder,
  ListTodo,
  MessageSquare,
  Monitor,
  Plus,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { api } from "../api.js";
import ChatPanel from "./ChatPanel.jsx";
import ChecklistPanel from "./ChecklistPanel.jsx";
import { canvasChecklistTasks } from "./checklist-tasks.js";
import DevicePanel, { localRunnerRequest } from "./DevicePanel.jsx";
import DiagnosisPanel from "./DiagnosisPanel.jsx";
import PendingBatchNotice from "./PendingBatchNotice.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import ProjectBindingPicker from "./ProjectBindingPicker.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import "./experience.css";
import "./agent.css";
import "./noto-sans-sc.css";
import "./workbench.css";

function validTarget(target) {
  return (
    target &&
    ["sectionId", "bindingId", "runId"].every(
      (key) =>
        typeof target[key] === "string" &&
        target[key].length > 0 &&
        target[key].length <= 256,
    ) &&
    Number.isSafeInteger(target.bindingRevision) &&
    target.bindingRevision > 0
  );
}
const validTargets = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([id, target]) => validTarget(target) && target.sectionId === id,
  );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countTasks = (page) => {
  const tasks = canvasChecklistTasks(page);
  return {
    total: tasks.length,
    pending: tasks.filter((task) => !task.block.done).length,
    review: 0,
  };
};

function BindingDrawer({ children, onClose }) {
  return (
    <WorkspaceDrawer title="绑定 agent" size="wide" onClose={onClose}>
      {children}
    </WorkspaceDrawer>
  );
}

function WorkspaceScope({
  roomId,
  userId,
  pages = [],
  initialBatchTarget,
  startAtBatch = false,
  onBatchTargetChange,
  onCreateProject,
  onAddTodo,
  onDeleteTodo,
  onReopenTodo,
  onSetTodoDone,
  requestCloud,
  requestLocal,
}) {
  const scope = JSON.stringify([userId, roomId]);
  const storage = `qingdan.agent-workspace:${scope}`;
  const [selected, setSelected, projectStorage] = useWorkspaceDraft(
    storage + ":project",
    validTarget(initialBatchTarget) ? initialBatchTarget.sectionId : "",
    true,
    {
      storageKey: storage + ":project",
      validate: (value) => typeof value === "string" && value.length <= 256,
    },
  );
  const [targets, setTargets, targetStorage] = useWorkspaceDraft(
    storage + ":batches",
    {},
    true,
    { storageKey: storage + ":batches", validate: validTargets },
  );
  const [mobilePane, setMobilePane] = useState("chat");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsView, setSettingsView] = useState("binding");
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [createError, setCreateError] = useState("");
  const [connection, setConnection] = useState("checking");
  const [refreshTokens, setRefreshTokens] = useState({});
  const [bindingTokens, setBindingTokens] = useState({});
  const [checklistCounts, setChecklistCounts] = useState({});
  const receiveCounts = useCallback((sourcePage, next) => {
    setChecklistCounts((previous) => {
      const old = previous[sourcePage.id];
      if (old?.tasks === sourcePage.tasks && same(old.counts, next))
        return previous;
      return {
        ...previous,
        [sourcePage.id]: { tasks: sourcePage.tasks, counts: next },
      };
    });
  }, []);
  const displayedCounts = (sourcePage) => {
    const saved = checklistCounts[sourcePage?.id];
    return saved && saved.tasks === sourcePage?.tasks
      ? saved.counts
      : countTasks(sourcePage);
  };
  const bindingRead = useRef(0);
  const promptedProjects = useRef(new Set());
  const automaticPicker = useRef(false);
  const otherDrawerOpen = useRef(false);
  otherDrawerOpen.current = memoryOpen || summaryOpen || creating;
  const progressSeen = useRef(new Map());
  const page = pages.find((item) => item.id === selected) || pages[0];
  const selectedRef = useRef(page?.id);
  selectedRef.current = page?.id;
  const taskPane = useRef(null);
  const chatPane = useRef(null);
  const pageId = page?.id;
  const bindingToken = bindingTokens[pageId] || 0;
  const initialRunSection =
    startAtBatch && validTarget(initialBatchTarget)
      ? initialBatchTarget.sectionId
      : null;
  const projectPickerLabel = "绑定 agent";
  const counts = displayedCounts(page);
  const common = { roomId, userId, requestCloud, requestLocal };
  const pageList = page ? [page] : [];
  const closeSettings = useCallback(() => setProjectPickerOpen(false), []);
  const selectBindingView = (view) => {
    automaticPicker.current = false;
    setSettingsView(view);
  };
  const openProjectPicker = useCallback(() => {
    automaticPicker.current = false;
    promptedProjects.current.add(selectedRef.current);
    setMemoryOpen(false);
    setSummaryOpen(false);
    setSettingsView("binding");
    setCreating(false);
    setProjectPickerOpen(true);
  }, []);

  useEffect(() => {
    if (pageId) setSelected(pageId);
  }, [storage, pageId]);
  useEffect(() => {
    if (!validTarget(initialBatchTarget)) return;
    if (startAtBatch) setSelected(initialBatchTarget.sectionId);
    setTargets((prior) =>
      same(prior[initialBatchTarget.sectionId], initialBatchTarget)
        ? prior
        : { ...prior, [initialBatchTarget.sectionId]: initialBatchTarget },
    );
  }, [initialBatchTarget, startAtBatch]);
  useEffect(() => {
    let active = true;
    const version = ++bindingRead.current;
    const isCurrent = () =>
      active &&
      version === bindingRead.current &&
      selectedRef.current === pageId;
    const promptIfNeeded = () => {
      if (otherDrawerOpen.current || promptedProjects.current.has(pageId))
        return;
      promptedProjects.current.add(pageId);
      automaticPicker.current = true;
      setSettingsView("binding");
      setProjectPickerOpen(true);
    };
    if (!pageId) {
      if (!initialRunSection) promptIfNeeded();
    } else {
      void (async () => {
        try {
          const { binding } = await requestCloud(
            `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(pageId)}`,
            { accountId: userId, isCurrentSession: isCurrent },
          );
          if (!isCurrent() || binding === undefined) return;
          if (binding) {
            if (automaticPicker.current) {
              automaticPicker.current = false;
              setProjectPickerOpen(false);
            }
          } else if (pageId !== initialRunSection) promptIfNeeded();
        } catch {
          // An unavailable binding lookup does not mean the project is unbound.
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [roomId, userId, pageId, bindingToken, initialRunSection, requestCloud]);
  useEffect(() => {
    let active = true,
      reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await requestLocal("/status", { accountId: userId });
        if (active)
          setConnection(
            result.paired === false
              ? "unpaired"
              : result.connectionStatus || "offline",
          );
      } catch (error) {
        if (active)
          setConnection(
            error.code === "OWNER_MISMATCH" ? "owner_mismatch" : "offline",
          );
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [requestLocal, userId]);
  const refreshChecklist = useCallback(
    (id) =>
      setRefreshTokens((prior) => ({ ...prior, [id]: (prior[id] || 0) + 1 })),
    [],
  );
  const selectProject = (id) => {
    if (!pages.some((item) => item.id === id)) return;
    setSelected(id);
    setMemoryOpen(false);
    setSummaryOpen(false);
    setProjectPickerOpen(false);
  };
  const selectBatch = useCallback(
    (target) => {
      if (!validTarget(target) || target.sectionId !== selectedRef.current)
        return;
      setTargets((prior) =>
        same(prior[target.sectionId], target)
          ? prior
          : { ...prior, [target.sectionId]: target },
      );
      onBatchTargetChange?.(target);
    },
    [onBatchTargetChange],
  );
  const openBatch = useCallback(
    (target) => {
      if (!validTarget(target) || target.sectionId !== selectedRef.current)
        return;
      selectBatch(target);
      setMobilePane("chat");
      chatPane.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
    },
    [selectBatch],
  );
  const openChecklist = useCallback(() => {
    setMobilePane("tasks");
    taskPane.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, []);
  const onRunChange = useCallback(
    (run) => {
      const id = pageId;
      if (!id || selectedRef.current !== id) return;
      if (!run) return;
      const signature = JSON.stringify([
        run.runId,
        run.terminal,
        run.stopConfirmed,
        run.batch?.items?.map((item) => [item.taskId, item.writeback?.status]),
      ]);
      const previous = progressSeen.current.get(id);
      progressSeen.current.set(id, signature);
      if (
        signature !== previous &&
        (previous !== undefined ||
          run.batch?.items?.some(
            (item) => item.writeback?.status === "applied",
          ))
      )
        refreshChecklist(id);
    },
    [pageId, refreshChecklist],
  );
  const openPending = (target) => {
    if (
      !validTarget(target) ||
      !pages.some((item) => item.id === target.sectionId)
    )
      return;
    selectProject(target.sectionId);
    setMobilePane("chat");
    setTargets((prior) => ({ ...prior, [target.sectionId]: target }));
    onBatchTargetChange?.(target);
  };
  function createProject(event) {
    event.preventDefault();
    if (!projectName.trim() || !onCreateProject) return;
    try {
      const id = onCreateProject(projectName.trim());
      if (typeof id !== "string" || !id) throw Error("项目尚未创建，请重试。");
      setSelected(id);
      setCreating(false);
      setProjectName("");
      setCreateError("");
    } catch (error) {
      setCreateError(error.message || "项目创建失败。");
    }
  }
  const connectionText =
    {
      checking: "正在连接电脑",
      online: "电脑在线",
      connecting: "电脑连接中",
      unpaired: "电脑未绑定",
      revoked: "电脑授权已撤销",
      owner_mismatch: "电脑账号不匹配",
      error: "电脑连接异常",
    }[connection] || "电脑未连接";
  return (
    <section className="agent-workspace" aria-label="Agent 工作区">
      <aside className="agent-workspace-sidebar" aria-label="Agent 项目导航">
        <div className="agent-sidebar-heading">
          <span>
            我的项目 <small>{pages.length}</small>
          </span>
          {onCreateProject && (
            <button
              className="agent-icon-button"
              aria-label="新建项目"
              onClick={() => {
                setProjectPickerOpen(false);
                setCreating((value) => !value);
              }}
            >
              <Plus size={17} />
            </button>
          )}
        </div>
        <div className="agent-project-list">
          {pages.map((item) => {
            const count = displayedCounts(item);
            return (
              <button
                key={item.id}
                className="agent-project-item"
                aria-label={`选择项目：${item.title || "未命名项目"}`}
                aria-current={item.id === pageId ? "page" : undefined}
                onClick={() => selectProject(item.id)}
              >
                <Folder size={16} />
                <span>{item.title || "未命名项目"}</span>
                <small aria-label={`${count.pending} 项未完成`}>
                  {count.pending}
                </small>
              </button>
            );
          })}
        </div>
      </aside>
      <div className="agent-workspace-main">
        {(projectStorage.warning || targetStorage.warning) && (
          <p className="agent-error" role="alert">
            {projectStorage.warning || targetStorage.warning}
          </p>
        )}
        <header className="agent-workspace-header">
          <div className="agent-workspace-heading">
            <span className="agent-heading-icon" aria-hidden="true">
              <Folder size={20} />
            </span>
            <div>
              <h1 title={page?.title}>{page?.title || "开始你的第一个项目"}</h1>
              <p>
                {counts.total
                  ? `${counts.pending} 项待办 · ${counts.total - counts.pending} 项已完成${counts.review ? ` · ${counts.review} 项待核对` : ""}`
                  : "暂无待办"}
              </p>
            </div>
          </div>
          <div className="agent-workspace-tools">
            <div
              className="agent-project-tools"
              role="group"
              aria-label="项目工具"
            >
              <button
                aria-label={projectPickerLabel}
                title={projectPickerLabel}
                onClick={openProjectPicker}
              >
                <Folder size={16} />
                <span>{projectPickerLabel}</span>
              </button>
              <button
                aria-label="打开项目摘要"
                title="项目摘要"
                onClick={() => {
                  setProjectPickerOpen(false);
                  setSummaryOpen(true);
                  setMemoryOpen(false);
                  setMobilePane("chat");
                }}
              >
                <StickyNote size={16} />
                <span>项目摘要</span>
              </button>
              <button
                aria-label="打开记忆"
                title="记忆"
                onClick={() => {
                  setProjectPickerOpen(false);
                  setMemoryOpen(true);
                  setSummaryOpen(false);
                  setMobilePane("chat");
                }}
              >
                <Sparkles size={16} />
                <span>记忆</span>
              </button>
            </div>
            <div
              className="agent-device-tools"
              role="group"
              aria-label="电脑连接与设置"
            >
              <span
                className={`agent-connection-chip ${connection === "online" ? "is-online" : ""}`}
                role="status"
              >
                <i aria-hidden="true" />
                {connectionText}
              </span>
            </div>
          </div>
        </header>
        <div className="agent-mobile-navigation">
          <label>
            当前项目
            <select
              aria-label="Agent 当前项目"
              value={pageId || ""}
              onChange={(event) => selectProject(event.target.value)}
            >
              {pages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || "未命名项目"}
                </option>
              ))}
            </select>
          </label>
          {onCreateProject && (
            <button
              className="agent-icon-button"
              aria-label="新建项目"
              onClick={() => {
                setProjectPickerOpen(false);
                setCreating(true);
                setMobilePane("projects");
              }}
            >
              <Plus size={18} />
            </button>
          )}
          <div
            className="agent-mobile-tabs"
            role="tablist"
            aria-label="Agent 工作区内容"
          >
            <button
              role="tab"
              aria-selected={mobilePane === "chat"}
              onClick={() => setMobilePane("chat")}
            >
              <MessageSquare size={16} />
              项目聊天
            </button>
            <button
              role="tab"
              aria-selected={mobilePane === "tasks"}
              onClick={() => setMobilePane("tasks")}
            >
              <ListTodo size={16} />
              待办与执行
            </button>
          </div>
        </div>
        <div className="agent-background-requests">
          {Object.values(targets)
            .filter(
              (target) =>
                target.sectionId !== pageId &&
                pages.some((item) => item.id === target.sectionId),
            )
            .map((target) => (
              <PendingBatchNotice
                key={target.runId}
                roomId={roomId}
                userId={userId}
                target={target}
                requestCloud={requestCloud}
                onOpen={openPending}
              />
            ))}
        </div>
        {page ? (
          <div className="agent-workspace-columns" data-pane={mobilePane}>
            <div
              className="agent-workspace-chat-pane"
              aria-label="项目对话"
              ref={chatPane}
            >
              <ChatPanel
                key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                {...common}
                pages={pageList}
                embedded
                memoryOpen={memoryOpen}
                onMemoryClose={() => setMemoryOpen(false)}
                summaryOpen={summaryOpen}
                onSummaryClose={() => setSummaryOpen(false)}
                onOpenSummary={() => {
                  setSummaryOpen(true);
                  setMemoryOpen(false);
                }}
                onOpenSettings={openProjectPicker}
                onOpenChecklist={openChecklist}
                onTasksSaved={() => refreshChecklist(page.id)}
                execution={{
                  page,
                  initialTarget: targets[page.id],
                  onSelectBatch: selectBatch,
                  onRunChange,
                }}
              />
            </div>
            <aside
              className="agent-workspace-task-pane"
              aria-label="项目待办与执行"
              ref={taskPane}
            >
              <div className="agent-pane-title">
                <div>
                  <ListTodo size={17} />
                  <h2>待办与执行</h2>
                </div>
                <span className="agent-pane-count">
                  {counts.pending} 项待办
                </span>
              </div>
              <div className="agent-workspace-checklist">
                <ChecklistPanel
                  key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                  {...common}
                  pages={pageList}
                  embedded
                  refreshToken={refreshTokens[page.id] || 0}
                  onOpenBatch={openBatch}
                  onOpenSettings={openProjectPicker}
                  onAddTodo={onAddTodo}
                  onDeleteTodo={onDeleteTodo}
                  onReopenTodo={onReopenTodo}
                  onSetTodoDone={onSetTodoDone}
                  onCountsChange={receiveCounts}
                />
              </div>
            </aside>
          </div>
        ) : (
          <div className="agent-workspace-empty">
            <div>
              <Bot size={34} />
            </div>
            <h2>给你的计划一个开始</h2>
            {onCreateProject && (
              <button
                className="primary"
                onClick={() => {
                  setProjectPickerOpen(false);
                  setCreating(true);
                }}
              >
                新建项目
              </button>
            )}
          </div>
        )}
      </div>
      {projectPickerOpen && (
        <BindingDrawer onClose={closeSettings}>
          <div
            className="agent-settings-navigation"
            role="group"
            aria-label="agent 绑定管理"
          >
            <button
              aria-pressed={settingsView === "binding"}
              onClick={() => selectBindingView("binding")}
            >
              <Folder size={16} aria-hidden="true" />
              <span>项目绑定</span>
            </button>
            <button
              aria-pressed={settingsView === "setup"}
              onClick={() => selectBindingView("setup")}
            >
              <Monitor size={16} aria-hidden="true" />
              <span>设备管理</span>
            </button>
            <button
              aria-pressed={settingsView === "diagnosis"}
              onClick={() => selectBindingView("diagnosis")}
            >
              <Activity size={16} aria-hidden="true" />
              <span>诊断与恢复</span>
            </button>
          </div>
          {settingsView === "binding" ? (
            <ProjectBindingPicker
              {...common}
              page={page}
              onCreateProject={onCreateProject}
              onBound={({ sectionId, isLocalAgent }) => {
                bindingRead.current++;
                promptedProjects.current.add(sectionId);
                automaticPicker.current = false;
                setSelected(sectionId);
                setBindingTokens((prior) => ({
                  ...prior,
                  [sectionId]: (prior[sectionId] || 0) + 1,
                }));
                setProjectPickerOpen(false);
                if (isLocalAgent) setConnection("online");
              }}
            />
          ) : settingsView === "diagnosis" ? (
            <DiagnosisPanel
              {...common}
              page={page}
              onOpenSetup={() => setSettingsView("setup")}
              onOpenRun={(target) => {
                closeSettings();
                openBatch(target);
              }}
            />
          ) : (
            <DevicePanel
              {...common}
              pages={pageList}
              embedded
              initialPageId={pageId}
              onBindingChanged={() => {
                if (pageId)
                  setBindingTokens((prior) => ({
                    ...prior,
                    [pageId]: (prior[pageId] || 0) + 1,
                  }));
              }}
            />
          )}
        </BindingDrawer>
      )}
      {creating && (
        <WorkspaceDrawer
          title="新建项目"
          onClose={() => {
            setCreating(false);
            setMobilePane("chat");
          }}
        >
          <form className="agent-project-create" onSubmit={createProject}>
            <label>
              项目名称
              <input
                autoFocus
                aria-label="新项目名称"
                maxLength={120}
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="给这件事起个名字"
              />
            </label>
            <div>
              <button className="primary" disabled={!projectName.trim()}>
                创建项目
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setMobilePane("chat");
                }}
              >
                取消
              </button>
            </div>
            {createError && <p role="alert">{createError}</p>}
          </form>
        </WorkspaceDrawer>
      )}
    </section>
  );
}

export default function AgentWorkspace(props) {
  return (
    <WorkspaceScope
      key={JSON.stringify([props.userId, props.roomId])}
      requestCloud={api}
      requestLocal={localRunnerRequest}
      {...props}
    />
  );
}
