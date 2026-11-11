import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCheck,
  Folder,
  ListTodo,
  MessageSquare,
  Plus,
  Settings2,
  Sparkles,
  StickyNote,
  X,
} from "lucide-react";
import { api } from "../api.js";
import ChatPanel from "./ChatPanel.jsx";
import ChecklistPanel from "./ChecklistPanel.jsx";
import BatchPanel from "./BatchPanel.jsx";
import DevicePanel, { localRunnerRequest } from "./DevicePanel.jsx";
import DiagnosisPanel from "./DiagnosisPanel.jsx";
import PendingBatchNotice from "./PendingBatchNotice.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import CodexSessionPicker from "./CodexSessionPicker.jsx";
import "./experience.css";
import "./agent.css";

function readSaved(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeSaved(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* This view still works without browser storage. */
  }
}
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
function readTargets(key) {
  const saved = readSaved(key, {});
  return Object.fromEntries(
    Object.entries(
      saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {},
    ).filter(([id, target]) => validTarget(target) && target.sectionId === id),
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countTasks = (page) => ({
  total: page?.tasks?.length || 0,
  pending: page?.tasks?.filter((task) => !task.block?.done).length || 0,
});

function SettingsDrawer({ children, onClose }) {
  const panel = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    if (!document.querySelector(".agent-request-dialog"))
      panel.current?.focus();
    const key = (event) => {
      if (document.querySelector(".agent-request-dialog")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
      if (event.key !== "Tab") return;
      const items = [
        ...panel.current.querySelectorAll(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary",
        ),
      ].filter((item) => {
        const collapsed = item.closest("details:not([open])");
        return !collapsed || collapsed.querySelector("summary") === item;
      });
      const first = items[0],
        last = items.at(-1);
      if (
        !items.includes(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (
        previous?.isConnected &&
        !document.querySelector(".agent-request-dialog")
      )
        previous.focus?.();
    };
  }, [onClose]);
  return (
    <div className="agent-workspace-drawer-backdrop">
      <section
        className="agent-workspace-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="电脑与项目设置"
        ref={panel}
        tabIndex={-1}
      >
        <header>
          <h2>设置</h2>
          <button
            className="agent-icon-button"
            aria-label="关闭电脑设置"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <div className="agent-workspace-drawer-body">{children}</div>
      </section>
    </div>
  );
}

function WorkspaceScope({
  roomId,
  userId,
  pages = [],
  initialBatchTarget,
  startAtBatch = false,
  onBatchTargetChange,
  onOpenDiagnostics,
  onCreateProject,
  requestCloud,
  requestLocal,
}) {
  const scope = JSON.stringify([userId, roomId]);
  const storage = `qingdan.agent-workspace:${scope}`;
  const [selected, setSelected] = useState(
    () =>
      (startAtBatch && validTarget(initialBatchTarget)
        ? initialBatchTarget.sectionId
        : readSaved(storage + ":project", "")) ||
      (validTarget(initialBatchTarget) ? initialBatchTarget.sectionId : ""),
  );
  const [targets, setTargets] = useState(() => ({
    ...readTargets(storage + ":batches"),
    ...(validTarget(initialBatchTarget)
      ? { [initialBatchTarget.sectionId]: initialBatchTarget }
      : {}),
  }));
  const [mobilePane, setMobilePane] = useState(startAtBatch ? "tasks" : "chat");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(
    () => !(startAtBatch && validTarget(initialBatchTarget)),
  );
  const [settingsView, setSettingsView] = useState("setup");
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [createError, setCreateError] = useState("");
  const [connection, setConnection] = useState("checking");
  const [refreshTokens, setRefreshTokens] = useState({});
  const [bindingTokens, setBindingTokens] = useState({});
  const progressSeen = useRef(new Map());
  const page = pages.find((item) => item.id === selected) || pages[0];
  const selectedRef = useRef(page?.id);
  selectedRef.current = page?.id;
  const taskPane = useRef(null);
  const batchAnchor = useRef(null);
  const pageId = page?.id;
  const counts = countTasks(page);
  const common = { roomId, userId, requestCloud, requestLocal };
  const pageList = page ? [page] : [];
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => {
    setSessionsOpen(false);
    setMemoryOpen(false);
    setSummaryOpen(false);
    setSettingsView("setup");
    setSettingsOpen(true);
  }, []);
  const openSessions = useCallback(() => {
    setMemoryOpen(false);
    setSummaryOpen(false);
    setSettingsOpen(false);
    setCreating(false);
    setSessionsOpen(true);
  }, []);

  useEffect(() => {
    if (pageId) writeSaved(storage + ":project", pageId);
  }, [storage, pageId]);
  useEffect(() => {
    writeSaved(storage + ":batches", targets);
  }, [storage, targets]);
  useEffect(() => {
    if (!validTarget(initialBatchTarget)) return;
    setTargets((prior) =>
      same(prior[initialBatchTarget.sectionId], initialBatchTarget)
        ? prior
        : { ...prior, [initialBatchTarget.sectionId]: initialBatchTarget },
    );
  }, [initialBatchTarget]);
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
    setSettingsOpen(false);
    setSessionsOpen(false);
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
      setMobilePane("tasks");
      batchAnchor.current?.scrollIntoView?.({
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
    setMobilePane("tasks");
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
        <div className="agent-workspace-brand">
          <span>
            <Bot size={22} />
          </span>
          <strong>Agent</strong>
        </div>
        <div className="agent-sidebar-heading">
          <span>我的项目</span>
          {onCreateProject && (
            <button
              className="agent-icon-button"
              aria-label="新建项目"
              onClick={() => {
                setSessionsOpen(false);
                setCreating((value) => !value);
              }}
            >
              <Plus size={17} />
            </button>
          )}
        </div>
        <div className="agent-project-list">
          {pages.map((item) => {
            const count = countTasks(item);
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
        <header className="agent-workspace-header">
          <div className="agent-workspace-heading">
            <h1>{page?.title || "开始你的第一个项目"}</h1>
            <p>
              {counts.total
                ? `${counts.pending} 项待办 · ${counts.total - counts.pending} 项已完成`
                : "暂无待办"}
            </p>
          </div>
          <div className="agent-workspace-tools">
            <button onClick={openSessions}>
              <MessageSquare size={16} />
              <span>选择 Codex 会话</span>
            </button>
            <button
              className={`agent-connection-chip ${connection === "online" ? "is-online" : ""}`}
              onClick={openSettings}
            >
              <i />
              {connectionText}
            </button>
            <button
              aria-label="打开项目摘要"
              title="项目摘要"
              onClick={() => {
                setSessionsOpen(false);
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
                setSessionsOpen(false);
                setMemoryOpen(true);
                setSummaryOpen(false);
                setMobilePane("chat");
              }}
            >
              <Sparkles size={16} />
              <span>记忆</span>
            </button>
            <button
              className="agent-icon-button"
              aria-label="电脑与项目设置"
              title="设置"
              onClick={openSettings}
            >
              <Settings2 size={18} />
            </button>
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
                setSessionsOpen(false);
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
            <div className="agent-workspace-chat-pane" aria-label="项目对话">
              <div className="agent-pane-title">
                <div>
                  <MessageSquare size={17} />
                  <h2>项目聊天</h2>
                </div>
              </div>
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
                onOpenSettings={openSessions}
                onOpenChecklist={openChecklist}
                onTasksSaved={() => refreshChecklist(page.id)}
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
                <span>{counts.pending} 项待办</span>
              </div>
              <div className="agent-workspace-checklist">
                <ChecklistPanel
                  key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                  {...common}
                  pages={pageList}
                  embedded
                  refreshToken={refreshTokens[page.id] || 0}
                  onOpenBatch={openBatch}
                  onOpenSettings={openSessions}
                />
              </div>
              <div className="agent-workspace-batch" ref={batchAnchor}>
                <div className="agent-pane-title">
                  <div>
                    <CheckCheck size={17} />
                    <h2>执行进度</h2>
                  </div>
                </div>
                <BatchPanel
                  key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                  {...common}
                  pages={pageList}
                  embedded
                  initialTarget={targets[page.id]}
                  initialPageId={page.id}
                  onSelectBatch={selectBatch}
                  onRunChange={onRunChange}
                  onOpenChecklist={openChecklist}
                  onOpenSettings={openSessions}
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
            <p>
              新建一个项目，和 Agent 一起整理需求，再把确认好的待办交给 Codex。
            </p>
            {onCreateProject && (
              <button
                className="primary"
                onClick={() => {
                  setSessionsOpen(false);
                  setCreating(true);
                }}
              >
                新建项目
              </button>
            )}
          </div>
        )}
      </div>
      {sessionsOpen && (
        <WorkspaceDrawer
          title="选择 Codex 会话"
          onClose={() => setSessionsOpen(false)}
        >
          <CodexSessionPicker
            {...common}
            page={page}
            onCreateProject={onCreateProject}
            onOpenSettings={openSettings}
            onBound={({ sectionId }) => {
              setSelected(sectionId);
              setBindingTokens((prior) => ({
                ...prior,
                [sectionId]: (prior[sectionId] || 0) + 1,
              }));
              setSessionsOpen(false);
              setConnection("online");
            }}
          />
        </WorkspaceDrawer>
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
      {settingsOpen && (
        <SettingsDrawer onClose={closeSettings}>
          <div className="agent-settings-navigation" aria-label="设置页面">
            <button
              aria-pressed={settingsView === "setup"}
              onClick={() => setSettingsView("setup")}
            >
              电脑与项目
            </button>
            <button
              aria-pressed={settingsView === "diagnosis"}
              onClick={() => setSettingsView("diagnosis")}
            >
              诊断与恢复
            </button>
          </div>
          {settingsView === "diagnosis" ? (
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
          {onOpenDiagnostics && (
            <details className="agent-advanced-settings">
              <summary>高级工具</summary>
              <button
                onClick={() => {
                  closeSettings();
                  onOpenDiagnostics();
                }}
              >
                功能诊断
              </button>
            </details>
          )}
        </SettingsDrawer>
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
