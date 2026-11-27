import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Bot, Folder, Inbox, ListTodo, Monitor } from "lucide-react";
import WorkspaceNavigation from "./WorkspaceNavigation.jsx";
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
import "./workbench.css";
import "./film.css";
import "./luma.css";
import "./noto-sans-sc.css";
import "./ui/theme.css";
import "./redesign.css";

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
const monitorKey = (t) =>
  JSON.stringify([t.sectionId, t.bindingId, t.bindingRevision, t.runId]);
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
  fullWorkspaceUrl,
  localQuestionInbox = false,
  chatTasksPreview = false,
  chatTaskPreviewContent,
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
  const [pane, setPane] = useState("chat");
  const planHandler = useRef(null);
  const registerPlanHandler = useCallback((handler) => {
    planHandler.current = handler;
  }, []);
  async function planSelectedTodos(tasks) {
    if (!planHandler.current) throw Error("聊天正在准备，请稍后再试。");
    const accepted = await planHandler.current(tasks);
    if (accepted) setPane("chat");
    return accepted;
  }
  const [collection, setCollection] = useState("pending");
  const [previewTasksOpen, setPreviewTasksOpen] = useState(false);
  const [historyHost, setHistoryHost] = useState(null);
  const [executionSettingsHost, setExecutionSettingsHost] = useState(null);
  const [noticeCounts, setNoticeCounts] = useState({});
  const [localQuestionCount, setLocalQuestionCount] = useState(0);
  const [inboxTargets, setInboxTargets] = useState({});
  const [inboxRead, setInboxRead] = useState("idle");
  const receiveNotice = useCallback((key, count, status) => {
    setNoticeCounts((previous) => {
      if (previous[key]?.count === count && previous[key]?.status === status)
        return previous;
      if (!status && !previous[key]) return previous;
      const next = { ...previous };
      if (status) next[key] = { count, status };
      else delete next[key];
      return next;
    });
  }, []);
  const [filmTodo, setFilmTodo] = useState(null);
  const memoryOpen = pane === "memory";
  const summaryOpen = pane === "summary";
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsView, setSettingsView] = useState("binding");
  const [creating, setCreating] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
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
  otherDrawerOpen.current = !["chat", "tasks"].includes(pane) || creating;
  const progressSeen = useRef(new Map());
  const page = pages.find((item) => item.id === selected) || pages[0];
  const selectedRef = useRef(page?.id);
  selectedRef.current = page?.id;
  const taskPane = useRef(null);
  const pageId = page?.id;
  const bindingToken = bindingTokens[pageId] || 0;
  const initialRunSection =
    startAtBatch && validTarget(initialBatchTarget)
      ? initialBatchTarget.sectionId
      : null;
  const sectionIds = JSON.stringify(pages.map((item) => item.id));
  // The persisted selection is a resume point. Discover other pending runs when the inbox opens.
  useEffect(() => {
    if (pane !== "inbox" || fullWorkspaceUrl) return;
    const ids = JSON.parse(sectionIds);
    const abort = new AbortController();
    const options = {
      accountId: userId,
      signal: abort.signal,
      isCurrentSession: () => !abort.signal.aborted,
    };
    let reading = false;
    async function refreshInbox() {
      if (reading || abort.signal.aborted) return;
      reading = true;
      let cursor = 0,
        failed = false;
      const found = {};
      async function readProjects() {
        while (!abort.signal.aborted && cursor < ids.length) {
          const sectionId = ids[cursor++];
          try {
            const { binding } = await requestCloud(
              `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(sectionId)}`,
              options,
            );
            if (!binding?.enabled) {
              found[sectionId] = [];
              continue;
            }
            const data = await requestCloud(
              `/api/agent/execution/runs?bindingId=${encodeURIComponent(binding.bindingId)}`,
              options,
            );
            found[sectionId] = (data.runs || [])
              .filter(
                (run) =>
                  run.bindingId === binding.bindingId &&
                  (["waiting_approval", "waiting_input"].includes(run.status) ||
                    ["waiting_human", "blocked", "paused"].includes(
                      run.queue?.phase,
                    ) ||
                    run.pendingRequests?.some(
                      (r) => r.responseStatus === "pending",
                    )),
              )
              .map((run) => ({
                sectionId,
                bindingId: binding.bindingId,
                bindingRevision: binding.revision,
                runId: run.runId,
              }))
              .filter(validTarget);
          } catch {
            failed = true;
          }
        }
      }
      try {
        await Promise.all(
          Array.from({ length: Math.min(2, ids.length) }, readProjects),
        );
        if (!abort.signal.aborted) {
          setInboxTargets((prior) => ({ ...prior, ...found }));
          setInboxRead(failed ? "partial" : "ready");
        }
      } finally {
        reading = false;
      }
    }
    setInboxRead("loading");
    void refreshInbox();
    const timer = window.setInterval(refreshInbox, 15000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [pane, fullWorkspaceUrl, roomId, userId, sectionIds, requestCloud]);
  const known = [
    ...Object.values(targets),
    ...Object.values(inboxTargets).flat(),
  ].filter((target) => pages.some((item) => item.id === target.sectionId));
  const monitored = [
    ...new Map(known.map((target) => [monitorKey(target), target])).values(),
  ];
  const notices = monitored.map((target) => noticeCounts[monitorKey(target)]);
  const pendingCount = notices.reduce((n, item) => n + (item?.count || 0), 0);
  const noticesReady =
    inboxRead === "ready" && notices.every((item) => item?.status === "ready");
  const noticesLoading =
    inboxRead === "loading" ||
    notices.some((item) => !item || item.status === "loading");
  const counts = displayedCounts(page);
  const common = { roomId, userId, requestCloud, requestLocal };
  const pageList = page ? [page] : [];
  const closeSettings = useCallback(() => setProjectPickerOpen(false), []);
  const selectBindingView = (view) => {
    automaticPicker.current = false;
    setSettingsView(view);
  };
  const openProjectPicker = useCallback(() => {
    if (fullWorkspaceUrl) {
      setProjectPickerOpen(false);
      setPane("devices");
      return;
    }
    automaticPicker.current = false;
    promptedProjects.current.add(selectedRef.current);
    setSettingsView("binding");
    setCreating(false);
    setProjectPickerOpen(true);
  }, [fullWorkspaceUrl]);

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
      if (
        fullWorkspaceUrl ||
        otherDrawerOpen.current ||
        promptedProjects.current.has(pageId)
      )
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
  }, [
    roomId,
    userId,
    pageId,
    bindingToken,
    initialRunSection,
    requestCloud,
    fullWorkspaceUrl,
  ]);
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
    setFilmTodo(null);
    setCollection("pending");
    setPane("chat");
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
      setCollection("history");
      setPane("tasks");
    },
    [selectBatch],
  );
  const openChecklist = useCallback(() => {
    setCollection("pending");
    setPane("tasks");
    taskPane.current?.scrollTo?.({ top: 0 });
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
    setCollection("history");
    setPane("tasks");
    setTargets((prior) => ({ ...prior, [target.sectionId]: target }));
    onBatchTargetChange?.(target);
  };
  async function createProject(event) {
    event.preventDefault();
    if (!projectName.trim() || !onCreateProject || savingProject) return;
    setSavingProject(true);
    try {
      const result = onCreateProject(projectName.trim());
      const id = typeof result === "string" ? result : await result;
      if (typeof id !== "string" || !id) throw Error("项目尚未创建，请重试。");
      setSelected(id);
      setPane("chat");
      setCollection("pending");
      setCreating(false);
      setProjectName("");
      setCreateError("");
    } catch (error) {
      setCreateError(error.message || "项目创建失败。");
    } finally {
      setSavingProject(false);
    }
  }
  const fullPage =
    fullWorkspaceUrl &&
    {
      film: "短片制作",
      tasks: "待办与执行",
      inbox: localQuestionInbox ? null : "待处理请求",
      summary: "项目摘要",
      devices: "设备与绑定",
    }[pane];
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
    <section
      className="agent-workspace studio-workspace"
      data-chat-tasks-preview={chatTasksPreview || undefined}
      aria-label="Agent 工作区"
    >
      <WorkspaceNavigation
        pages={pages}
        page={page}
        pane={pane}
        countsFor={displayedCounts}
        selectProject={selectProject}
        navigate={setPane}
        pendingCount={pendingCount + localQuestionCount}
        openDevices={openProjectPicker}
        connection={connection}
        connectionText={connectionText}
        onCreate={
          onCreateProject &&
          (() => {
            setProjectPickerOpen(false);
            setCreating(true);
          })
        }
      />
      <div className="agent-workspace-main studio-main">
        {(projectStorage.warning || targetStorage.warning) && (
          <p className="agent-error" role="alert">
            {projectStorage.warning || targetStorage.warning}
          </p>
        )}
        {fullPage && (
          <section className="studio-page studio-resource">
            <header className="studio-page-heading">
              <div>
                <small>本机 Pi 对话</small>
                <h2>{fullPage}</h2>
              </div>
            </header>
            <div className="studio-surface">
              <p>
                {pane === "film"
                  ? "本机 Pi 在项目对话中使用 Codex 和 WAAO。制作卡、分镜、素材及出片回执在完整工作区管理。"
                  : "在完整工作区选择画布，进入 Agent 即可使用" +
                    fullPage +
                    "。"}
              </p>
              <div className="studio-handoff">
                <a href={fullWorkspaceUrl} target="_blank" rel="noreferrer">
                  打开完整本地工作区
                </a>
                <button type="button" onClick={() => setPane("chat")}>
                  回到项目对话
                </button>
              </div>
            </div>
          </section>
        )}
        <section
          className="studio-page studio-inbox-page"
          hidden={pane !== "inbox" || !!fullPage || localQuestionInbox}
          aria-label="待处理请求"
        >
          <header className="studio-page-heading">
            <div>
              <small>工作区</small>
              <h2>
                <Inbox size={20} />
                待处理请求
              </h2>
            </div>
          </header>
          {monitored.map((target) => (
            <PendingBatchNotice
              key={monitorKey(target)}
              monitorKey={monitorKey(target)}
              target={target}
              roomId={roomId}
              userId={userId}
              projectName={
                pages.find((item) => item.id === target.sectionId)?.title
              }
              onCount={receiveNotice}
              requestCloud={requestCloud}
              onOpen={openPending}
            />
          ))}
          {inboxRead === "partial" && (
            <p role="status" className="agent-note">
              部分项目暂时无法读取，稍后会自动刷新。
            </p>
          )}
          {!pendingCount && (noticesReady || noticesLoading) && (
            <p className="studio-empty" role="status">
              {noticesLoading ? "正在核对待处理请求…" : "当前没有待处理请求。"}
            </p>
          )}
        </section>
        {page ? (
          <div
            className="agent-workspace-columns"
            data-pane={pane}
            hidden={(pane === "inbox" && !localQuestionInbox) || !!fullPage}
          >
            <div
              className="agent-workspace-chat-pane"
              aria-label="项目对话"
              hidden={pane === "tasks"}
            >
              <ChatPanel
                key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                {...common}
                onPlanHandler={registerPlanHandler}
                pages={pageList}
                embedded
                workspaceView={fullPage ? "external" : pane}
                externalFilmWorkspace={!!fullWorkspaceUrl}
                onNavigate={setPane}
                onQuestionCount={
                  localQuestionInbox ? setLocalQuestionCount : undefined
                }
                workspaceTitle={page.title}
                onExecutionSettingsHost={setExecutionSettingsHost}
                executionSettingsUrl={fullWorkspaceUrl}
                memoryOpen={memoryOpen && !fullPage}
                onMemoryClose={() => setPane("chat")}
                summaryOpen={summaryOpen && !fullPage}
                onSummaryClose={() => setPane("chat")}
                onOpenSummary={() => {
                  setPane("summary");
                }}
                onOpenSettings={openProjectPicker}
                onOpenChecklist={openChecklist}
                onTasksSaved={() => refreshChecklist(page.id)}
                execution={{
                  page,
                  detailHost:
                    pane === "tasks" && collection === "history"
                      ? historyHost
                      : null,
                  onSetTodoDone,
                  filmTodo: filmTodo?.pageId === page.id ? filmTodo : null,
                  onFilmTodoOpened: () => setFilmTodo(null),
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
              hidden={
                pane !== "tasks" && !(chatTasksPreview && pane === "chat")
              }
              data-preview-collapsed={
                (chatTasksPreview && pane === "chat" && !previewTasksOpen) ||
                undefined
              }
            >
              <div className="agent-pane-title">
                <div>
                  <ListTodo size={17} />
                  <h2>
                    {chatTasksPreview && pane === "chat"
                      ? "我的待办"
                      : "待办与执行"}
                  </h2>
                </div>
                <span className="agent-pane-count">
                  {counts.pending} 项待办
                </span>
                {chatTasksPreview && pane === "chat" && (
                  <button
                    className="preview-todos-toggle"
                    type="button"
                    aria-expanded={previewTasksOpen}
                    onClick={() => setPreviewTasksOpen((open) => !open)}
                  >
                    {previewTasksOpen ? "收起" : "展开待办"}
                  </button>
                )}
              </div>
              {chatTasksPreview && pane === "chat" && chatTaskPreviewContent ? (
                chatTaskPreviewContent
              ) : (
                <>
                  <div
                    className="studio-tabs"
                    role="group"
                    aria-label="待办分组"
                  >
                    {[
                      ["pending", "待办"],
                      ["review", "待核对"],
                      ["done", "已完成"],
                      ["history", "执行记录"],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={key === collection}
                        onClick={() => setCollection(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div
                    className="studio-history agent-trial"
                    ref={setHistoryHost}
                    hidden={collection !== "history"}
                  />
                  <div
                    className="agent-workspace-checklist"
                    hidden={collection === "history"}
                  >
                    <ChecklistPanel
                      key={`${scope}/${page.id}/${bindingTokens[page.id] || 0}`}
                      {...common}
                      pages={pageList}
                      embedded
                      collection={collection}
                      centralSettings
                      settingsHost={executionSettingsHost}
                      refreshToken={refreshTokens[page.id] || 0}
                      onOpenBatch={openBatch}
                      onOpenSettings={openProjectPicker}
                      onAddTodo={onAddTodo}
                      onDeleteTodo={onDeleteTodo}
                      onReopenTodo={onReopenTodo}
                      onSetTodoDone={onSetTodoDone}
                      onFilmTodo={(source) => {
                        setFilmTodo({ pageId: page.id, source });
                        setPane("film");
                      }}
                      onPlanTasks={planSelectedTodos}
                      onCountsChange={receiveCounts}
                    />
                  </div>
                </>
              )}
            </aside>
          </div>
        ) : (
          <div
            className="agent-workspace-empty"
            hidden={pane === "inbox" || !!fullPage}
          >
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
            setPane("chat");
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
              <button
                className="primary"
                disabled={!projectName.trim() || savingProject}
              >
                创建项目
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setPane("chat");
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
