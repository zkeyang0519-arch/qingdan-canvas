import UnknownWorkspaceRequests from "./UnknownWorkspaceRequests.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Compass,
  FileText,
  Folder,
  History,
  ListTodo,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { api } from "../api.js";
import { createPortal } from "react-dom";
import MemoryPanel, { memoryScopeName } from "./MemoryPanel.jsx";
import { ProjectSummary } from "./ProjectSummaryPanel.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import WorkspaceSettings from "./WorkspaceSettings.jsx";
import ProjectResources from "./ProjectResources.jsx";
import RetentionPanel from "./RetentionPanel.jsx";
import { Button } from "./ui/button.jsx";
import FilmStudio, { FilmButton, FilmLinks } from "./FilmStudio.jsx";
import ChatImages from "./ChatImages.jsx";
import ChatModelPicker, { ModelErrorDetails } from "./ChatModelPicker.jsx";
import ChatFilmReceipt from "./ChatFilmReceipt.jsx";
import McpToolsPanel, { McpCalls } from "./McpToolsPanel.jsx";
import ConnectorQuestions from "./ConnectorQuestions.jsx";
import TaskProgress from "./TaskProgress.jsx";
import { waaoMcpId } from "../../shared/agent/waao-endpoint.mjs";
import ChatMarkdown from "./ChatMarkdown.jsx";
import AnswerActions, { appendQuotedReply } from "./AnswerActions.jsx";
import ElapsedTime from "./ElapsedTime.jsx";
import ProjectConversation, {
  ConversationMessages,
} from "./ProjectConversation.jsx";
import {
  useWorkspaceDraft,
  useWorkspaceRequests,
  workspaceScope,
} from "./workspace-state.js";

const chatApi = "/api/agent/chat";
const intentApi = "/api/agent/execution/intents";
const queued = (job) => job?.status === "queued" || job?.status === "running";
const bindingKey = (binding) =>
  binding &&
  JSON.stringify([
    binding.bindingId,
    binding.revision,
    binding.runnerId,
    binding.workspaceId,
  ]);
const operationKey = (action, payload) => {
  if (action === "retention")
    return `retention:${payload.action}:${payload.jobId || "settings"}:${payload.index ?? ""}`;
  if (action === "send") return `send:${payload.chatId || "new"}`;
  if (action === "new") return "new";
  if (action === "cancel") return `cancel:${payload.jobId}`;
  if (action === "save-tasks") return `save-tasks:${payload.messageId}`;
  if (action === "remember")
    return `remember:${payload.messageId}:${payload.index}`;
  return `memory:${payload.id || JSON.stringify([payload.scope, payload.key])}`;
};
const proposalFields = [
  ["text", "待办内容", 32000],
  ["instruction", "执行要求", 32000],
  ["acceptance", "完成标准", 4000],
];
const candidateText = {
  saved: "已记住",
  deleted: "记忆已删除",
  stale: "此建议已过时",
};

function TaskProposal({ message, busy, save, openChecklist, embedded }) {
  const [tasks, setTasks] = useState(message.tasks);
  const status = message.taskProposal?.status;
  const saved = status === "saved";
  const saving = status === "saving";
  const checkOnly = saving && message.invalidated;
  const stale = status === "stale" || (!saving && message.invalidated);
  const shown = saving ? message.taskProposal.tasks || [] : tasks;
  const submitted = saving
    ? shown
    : tasks.map((task) =>
        Object.fromEntries(
          proposalFields.map(([key]) => [key, task[key].trim()]),
        ),
      );
  return (
    <section
      className={`agent-chat-proposal${embedded && saved ? " is-saved" : ""}`}
      aria-label="待办提案"
    >
      {!(embedded && saved) && <h5>待办提案</h5>}
      {!saved &&
        !stale &&
        shown.map((task, index) => (
          <fieldset key={index} className="agent-batch-draft">
            <legend>待办 {index + 1}</legend>
            {proposalFields.map(([key, label, maxLength]) => (
              <label key={key}>
                {label}
                <textarea
                  aria-label={`提案第 ${index + 1} 项${label}`}
                  value={task[key]}
                  disabled={busy}
                  readOnly={saving}
                  maxLength={maxLength}
                  rows={2}
                  onChange={
                    saving
                      ? undefined
                      : (event) =>
                          setTasks(
                            tasks.map((entry, position) =>
                              position === index
                                ? { ...entry, [key]: event.target.value }
                                : entry,
                            ),
                          )
                  }
                />
              </label>
            ))}
          </fieldset>
        ))}
      {message.taskProposal?.error && (
        <p className="agent-error">{message.taskProposal.error}</p>
      )}
      {saved ? (
        <div className="agent-actions">
          <span className="agent-note">
            {embedded
              ? `已保存 ${message.tasks.length} 项待办`
              : "已保存到真实清单，可在第 5 步排序或提交执行。"}
          </span>
          {openChecklist && (
            <button onClick={openChecklist}>
              {embedded ? "查看待办" : "打开第 5 步"}
            </button>
          )}
        </div>
      ) : (
        <div className="agent-actions">
          <button
            disabled={
              busy ||
              stale ||
              !submitted.length ||
              submitted.some((task) =>
                Object.values(task).some((value) => !value),
              )
            }
            onClick={() => save(message, submitted)}
          >
            {checkOnly
              ? "核对保存结果"
              : saving
                ? "核对并重试保存"
                : "保存到真实清单"}
          </button>
          {stale && (
            <span className="agent-note">
              此提案已过时，请重新发送消息获取建议。
            </span>
          )}
          {saving && (
            <span className="agent-note">
              {checkOnly
                ? "来源已变化，仅核对原保存结果，不会重新写入。"
                : "保存结果待确认。核对时会使用上次提交的内容。"}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function ChatMessage({
  message,
  accountScope,
  busy,
  needFreshCandidates,
  saveTasks,
  remember,
  openChecklist,
  embedded,
  onQuote,
  onFilm,
  onFilmReference,
  onOpenMcp,
  startedAt,
}) {
  const filmRef = message.text?.match(
    /\[轻单制作 ([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9_-]{1,100})\]/,
  );
  return (
    <li className={`agent-chat-message agent-chat-${message.role}`}>
      <strong className="agent-message-author">
        {message.role === "user"
          ? "你"
          : message.provenance?.kind === "project_summary"
            ? "助手 · 项目摘要"
            : message.provenance?.kind === "cancelled_reply"
              ? "助手 · 已停止"
              : "助手"}
        {message.modelLabel && (
          <small className="qd-model-label"> · {message.modelLabel}</small>
        )}
      </strong>
      {message.previousAttempt && (
        <ModelErrorDetails
          previousError={message.previousAttempt.error}
          diagnostic={message.previousAttempt.diagnostic}
        />
      )}
      <ChatMarkdown
        text={message.text}
        timeline={message.role === "assistant"}
      />
      <ChatImages media={message.media} scope={accountScope} />
      <McpCalls calls={message.mcpCalls} onOpen={onOpenMcp} />
      {message.role === "assistant" && message.submission && (
        <ChatFilmReceipt
          key={message.submission.id}
          receipt={message.submission}
          chatId={message.chatId}
        />
      )}
      {message.role === "assistant" && (
        <AnswerActions
          text={message.text}
          onQuote={onQuote}
          onFilm={onFilm}
          disabled={busy}
        />
      )}
      {filmRef && onFilmReference && (
        <button onClick={() => onFilmReference(filmRef[1], filmRef[2])}>
          查看此制作版本
        </button>
      )}
      {message.role === "assistant" && (
        <ElapsedTime
          startedAt={startedAt}
          endedAt={message.createdAt}
          active={false}
        />
      )}
      {message.tasks?.length > 0 && (
        <TaskProposal
          {...{ message, openChecklist, embedded }}
          busy={
            busy ||
            (needFreshCandidates && message.taskProposal?.status !== "saving")
          }
          save={saveTasks}
        />
      )}
      {message.memories?.length > 0 && (
        <section className="agent-chat-proposal" aria-label="记忆建议">
          <h5>记忆建议</h5>
          <ul className="agent-memory-list">
            {message.memories.map((candidate, index) => {
              const status =
                message.memoryStates?.[index] ||
                (message.invalidated ? "stale" : "available");
              return (
                <li key={index}>
                  <strong>{candidate.key}</strong>
                  <p>{candidate.value}</p>
                  <div className="agent-actions">
                    <span className="agent-note">
                      {memoryScopeName[candidate.scope]}
                    </span>
                    <button
                      aria-label={`记住：${candidate.key}`}
                      disabled={
                        busy ||
                        needFreshCandidates ||
                        message.invalidated ||
                        status !== "available"
                      }
                      onClick={() => remember(message, index)}
                    >
                      记住
                    </button>
                    {candidateText[status] && (
                      <span className="agent-note">
                        {candidateText[status]}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </li>
  );
}

function ChatWorkspace({
  accountScope,
  binding,
  call,
  loadBinding,
  openChecklist,
  requestLocal,
  embedded,
  workspaceView,
  externalFilmWorkspace,
  workspaceTitle,
  onExecutionSettingsHost,
  executionSettingsUrl,
  onNavigate,
  memoryOpen,
  onMemoryClose,
  summaryOpen,
  onSummaryClose,
  onOpenSummary,
  onTasksSaved,
  onOpenSettings,
  onQuestionCount,
  execution,
}) {
  const bindingId = binding?.bindingId;
  const requestScope = workspaceScope({
    accountId: accountScope[0],
    canvasId: accountScope[1],
    sectionId: accountScope[2],
    binding,
  });
  const requests = useWorkspaceRequests(requestScope, { owner: "chat" });
  const personalRequests = useWorkspaceRequests(
    workspaceScope({ accountId: accountScope[0], canvasId: null }),
    { owner: "chat" },
  );
  const [state, setState] = useState(null);
  const [settingsCatalog, setSettingsCatalog] = useState(null);
  const [settingsReadError, setSettingsReadError] = useState("");
  const [settingsReload, setSettingsReload] = useState(0);
  const [modelMenu, setModelMenu] = useState(null);
  const [unsentModel, setUnsentModel] = useState(null);
  useEffect(() => {
    if (workspaceView !== "settings") return;
    let active = true;
    setSettingsReadError("");
    call(state?.provider?.modelsEndpoint || chatApi + "/models")
      .then((next) => {
        if (active) {
          setSettingsCatalog(next);
          const current = snapshot.current;
          if (current)
            apply({ ...current, provider: { ...current.provider, ...next } });
        }
      })
      .catch((error) => {
        if (active) setSettingsReadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [workspaceView, state?.provider?.modelsEndpoint, call, settingsReload]);
  useEffect(() => {
    if (workspaceView && workspaceView !== "settings") setModelMenu(null);
  }, [workspaceView]);
  function openModelSettings(retryJob) {
    setModelMenu({
      chatId: state?.thread?.id ?? null,
      ...(retryJob ? { jobId: retryJob.id } : {}),
    });
    onNavigate?.("settings");
  }
  const [mcpOpen, setMcpOpen] = useState(() =>
    typeof window !== "undefined" && window.location?.hash === "#mcp=waao"
      ? waaoMcpId
      : false,
  );
  useEffect(() => {
    if (
      state?.mcpAvailable &&
      mcpOpen === waaoMcpId &&
      window.location.hash === "#mcp=waao"
    )
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
  }, [state?.mcpAvailable, mcpOpen]);
  const [personalState, setPersonalState] = useState(null);
  const [memoryError, setMemoryError] = useState("");
  const [received, setReceived] = useState({});
  const [draftHandoff, setDraftHandoff] = useState(null);
  const [older, setOlder] = useState(null);
  const draftKey = (id) =>
    JSON.stringify([accountScope, bindingKey(binding), id || "new", "chat"]);
  const legacyDraft = (id) => ({
    legacyKeys: [
      `qingdan.agent-draft:${JSON.stringify([accountScope, binding && JSON.stringify([binding.bindingId, binding.revision]), id || "new", "chat"])}`,
    ],
  });
  const [newDraft, setNewDraft, newDraftStorage] = useWorkspaceDraft(
    draftKey(null),
    "",
    true,
    legacyDraft(null),
  );
  const [chatDraft, setChatDraft, chatDraftStorage] = useWorkspaceDraft(
    draftKey(state?.thread?.id),
    "",
    !!state?.thread?.id,
    legacyDraft(state?.thread?.id),
  );
  const draft = state?.thread ? chatDraft : newDraft;
  const setDraft = state?.thread ? setChatDraft : setNewDraft;
  const draftStorage = state?.thread ? chatDraftStorage : newDraftStorage;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [executionState, setExecutionState] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filmOpen, setFilmOpen] = useState(null);
  const [filmRevision, setFilmRevision] = useState(0);
  const filmSequence = useRef(0);
  const openFilm = useCallback(
    (options = {}) => {
      if (!externalFilmWorkspace)
        setFilmOpen({ ...options, instance: ++filmSequence.current });
      onNavigate?.("film");
    },
    [onNavigate, externalFilmWorkspace],
  );
  // Keep the working card and unsaved imports mounted between workspace sections.
  useEffect(() => {
    if (workspaceView === "film") setFilmOpen((current) => current || {});
  }, [workspaceView]);
  useEffect(() => {
    if (execution?.filmTodo) {
      const source = execution.filmTodo.source;
      openFilm({ text: source.text, source, create: true });
      execution.onFilmTodoOpened?.();
    }
  }, [execution?.filmTodo, openFilm]);
  const [needFreshCandidates, setNeedFreshCandidates] = useState(false);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const chatId = useRef(null);
  const snapshot = useRef(null);
  const handledJob = useRef(null);
  const draftControl = useRef(null);
  const composerInput = useRef(null);
  draftControl.current = {
    chatId: state?.thread?.id || null,
    draft,
    durable: draftStorage.durable,
    setDraft,
    newDraft,
    setNewDraft,
  };
  const settling = useRef(new Set());
  function quoteReply(text) {
    const next = appendQuotedReply(draft, text);
    if (next === null) {
      setNotice("引用后会超过消息长度限制，请选择较短的一段文字再引用。");
      return;
    }
    setDraft(next);
    composerInput.current?.focus();
  }
  const memoryRead = useRef(0);
  const valid = useCallback(
    (version) => mounted.current && epoch.current === version,
    [],
  );
  const read = useCallback(
    (id, beforeSequence) => {
      const params = new URLSearchParams();
      if (bindingId) {
        params.set("bindingId", bindingId);
        params.set("bindingRevision", String(binding.revision));
      }
      if (id) params.set("chatId", id);
      if (beforeSequence !== undefined)
        params.set("beforeSequence", String(beforeSequence));
      const query = params.toString();
      return call(`${chatApi}/state${query ? `?${query}` : ""}`);
    },
    [bindingId, binding?.revision, call],
  );
  const apply = useCallback((next) => {
    const previous = snapshot.current;
    if (
      next.harnessUnavailable &&
      previous?.mcpAvailable &&
      previous.thread?.id === next.thread?.id
    )
      next = {
        ...next,
        mcpAvailable: true,
        harnessTask: previous.harnessTask,
        connectorQuestions: previous.connectorQuestions,
      };
    if (
      snapshot.current?.memoryEpoch !== next.memoryEpoch ||
      snapshot.current?.thread?.id !== next.thread?.id
    )
      setOlder(null);
    snapshot.current = next;
    setState(next);
  }, []);
  const updateConnectorQuestions = useCallback(
    (questions) => {
      if (mounted.current && snapshot.current)
        apply({ ...snapshot.current, connectorQuestions: questions });
    },
    [apply],
  );
  useEffect(() => {
    onQuestionCount?.(state?.connectorQuestions?.length || 0);
  }, [state?.connectorQuestions?.length, onQuestionCount]);
  useEffect(() => () => onQuestionCount?.(0), [onQuestionCount]);
  useEffect(() => {
    if (
      !["chat", "inbox"].includes(workspaceView) ||
      !state?.mcpAvailable ||
      !bindingId
    )
      return;
    let active = true;
    const read = async () => {
      try {
        const result = await call(
          `/local/connector-questions?bindingId=${encodeURIComponent(bindingId)}`,
        );
        if (active) updateConnectorQuestions(result.questions || []);
      } catch (error) {
        if (active) setReadError(error.message);
      }
    };
    void read();
    const timer = setInterval(read, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    workspaceView,
    state?.mcpAvailable,
    bindingId,
    call,
    updateConnectorQuestions,
  ]);
  const refreshPersonal = useCallback(
    async (version) => {
      const serial = ++memoryRead.current;
      try {
        const next = await call(`${chatApi}/state`);
        if (!valid(version) || serial !== memoryRead.current) return;
        setPersonalState(next);
        setMemoryError("");
      } catch (err) {
        if (valid(version) && serial === memoryRead.current)
          setMemoryError(err.message);
      }
    },
    [call, valid],
  );
  const clearOriginalDraft = useCallback((record, receipt) => {
    if (record.request.body.retryOf) return;
    const control = draftControl.current;
    if (!record.request.body.chatId) {
      if (control.newDraft.trim() === record.request.body.text)
        control.setNewDraft("");
      else if (control.newDraft && receipt)
        setDraftHandoff({
          requestId: record.requestId,
          chatId: receipt.thread.id,
          text: control.newDraft,
          sourceText: control.newDraft,
        });
    } else if (control.chatId === record.request.body.chatId)
      control.setDraft((current) =>
        current.trim() === record.request.body.text ? "" : current,
      );
  }, []);
  useEffect(() => {
    if (
      !draftHandoff ||
      state?.thread?.id !== draftHandoff.chatId ||
      chatId.current !== draftHandoff.chatId
    )
      return;
    if (!chatDraft) {
      setChatDraft(draftHandoff.text);
    } else if (chatDraft === draftHandoff.text && chatDraftStorage.durable) {
      // Persist the destination first. A crash at either step leaves at least
      // one copy and the original pending identity available for recovery.
      if (newDraft === draftHandoff.sourceText) setNewDraft("");
      else if (newDraftStorage.durable) setDraftHandoff(null);
    }
  }, [
    draftHandoff,
    state?.thread?.id,
    chatDraft,
    chatDraftStorage.durable,
    newDraft,
    newDraftStorage.durable,
    setChatDraft,
    setNewDraft,
  ]);
  const refresh = useCallback(
    async (version) => {
      const latestBinding = await loadBinding();
      if (!valid(version) || bindingKey(latestBinding) !== bindingKey(binding))
        return;
      // The request collection stays at binding scope even when a first send
      // creates a chat. Restoration only reads the original server receipt.
      for (const record of requests.getSnapshot().ownedRecords) {
        if (record.request.path !== `${chatApi}/send`) continue;
        const params = new URLSearchParams({
          bindingId,
          bindingRevision: String(binding.revision),
          requestId: record.requestId,
        });
        const receipt = await call(`${chatApi}/request?${params}`);
        if (!valid(version)) return;
        if (!receipt.found) continue;
        if (
          receipt.job?.userMessageId !== receipt.message?.id ||
          receipt.job?.chatId !== receipt.thread?.id
        )
          throw Error("原请求回执不完整，请再次核对。");
        try {
          await requests.checkpoint(record.requestId, {
            jobId: receipt.job.id,
            chatId: receipt.thread.id,
            status: receipt.job.status,
          });
        } catch {
          /* Keep the original durable record; reads remain available. */
        }
        if (!valid(version)) return;
        settling.current.delete(record.requestId);
        setReceived((prior) => ({ ...prior, [record.requestId]: receipt }));
        clearOriginalDraft(record, receipt);
        if (!chatId.current) chatId.current = receipt.thread.id;
      }
      let next = await read(chatId.current);
      if (!valid(version)) return;
      if (
        bindingId &&
        !chatId.current &&
        !next.thread &&
        next.threads?.length
      ) {
        next = await read(next.threads[0].id);
        if (!valid(version)) return;
      }
      const control = draftControl.current;
      if (
        !control.chatId &&
        control.newDraft &&
        next.thread &&
        next.messages?.some(
          (message) => message.provenance?.kind === "project_summary",
        )
      )
        setDraftHandoff({
          requestId: `summary:${next.thread.id}`,
          chatId: next.thread.id,
          text: control.newDraft,
          sourceText: control.newDraft,
        });
      chatId.current = next.thread?.id ?? null;
      apply(next);
      setReadError("");
      setNeedFreshCandidates(false);
    },
    [
      loadBinding,
      binding,
      bindingId,
      read,
      valid,
      apply,
      call,
      requests.getSnapshot,
      requests.checkpoint,
      clearOriginalDraft,
    ],
  );
  const updateProject = useCallback(
    (project) => {
      const current = snapshot.current;
      if (!current) return;
      const changed =
        current.project?.summaryRevision !== project.summaryRevision ||
        current.project?.sourceRunId !== project.sourceRunId ||
        current.project?.ready !== project.ready;
      apply({ ...current, project });
      if (changed) {
        setNeedFreshCandidates(true);
        const version = epoch.current;
        void refresh(version).catch((err) => {
          if (valid(version)) setReadError(err.message);
        });
      }
    },
    [apply, refresh, valid],
  );

  useEffect(() => {
    mounted.current = true;
    const version = ++epoch.current;
    void refresh(version).catch((err) => {
      if (valid(version)) setReadError(err.message);
    });
    void refreshPersonal(version);
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [refresh, refreshPersonal, valid]);

  const job = state?.job;
  const pendingJob = queued(job);
  const pendingSend = requests.ownedRecords.some(
    (record) =>
      record.request.path === intentApi ||
      (record.request.path === `${chatApi}/send` &&
        (!(record.request.body.chatId || record.checkpoint?.chatId) ||
          record.request.body.chatId === state?.thread?.id ||
          record.checkpoint?.chatId === state?.thread?.id)),
  );
  useEffect(() => {
    for (const record of requests.ownedRecords) {
      const receipt = received[record.requestId];
      if (
        !receipt ||
        receipt.thread.id !== state?.thread?.id ||
        queued(receipt.job) ||
        draftHandoff?.requestId === record.requestId ||
        settling.current.has(record.requestId)
      )
        continue;
      const sourceDraft = record.request.body.chatId ? draft : newDraft;
      const sourceStorage = record.request.body.chatId
        ? draftStorage
        : newDraftStorage;
      if (sourceDraft.trim() === record.request.body.text) {
        clearOriginalDraft(record, receipt);
        continue;
      }
      if (!sourceStorage.durable) continue;
      settling.current.add(record.requestId);
      // A failed model job still acknowledges the accepted send request.
      void requests.resolve(record.requestId, "acknowledged").catch(() => {
        settling.current.delete(record.requestId);
      });
    }
  }, [
    received,
    state?.thread?.id,
    requests.ownedRecords,
    requests.resolve,
    clearOriginalDraft,
    draftHandoff,
    draft,
    draftStorage.durable,
    newDraft,
    newDraftStorage.durable,
  ]);
  useEffect(() => {
    if (
      !pendingJob &&
      !pendingSend &&
      !["running", "waiting_external"].includes(state?.harnessTask?.status) &&
      !["queued", "running", "finalizing", "reconciliation_required"].includes(
        state?.project?.status,
      )
    )
      return;
    let reading = false;
    const timer = setInterval(
      async () => {
        if (reading || busyRef.current) return;
        const version = epoch.current;
        reading = true;
        try {
          await refresh(version);
        } catch (err) {
          if (valid(version)) setReadError(err.message);
        } finally {
          reading = false;
        }
      },
      pendingJob || pendingSend ? 700 : 2000,
    );
    return () => clearInterval(timer);
  }, [
    pendingJob,
    pendingSend,
    state?.project?.status,
    state?.harnessTask?.status,
    refresh,
    valid,
  ]);
  useEffect(() => {
    if (!job || queued(job) || handledJob.current === job.id || pendingSend)
      return;
    handledJob.current = job.id;
    if (job.status === "failed" || job.status === "stale") {
      if (
        job.status === "failed" &&
        state.provider?.profiles &&
        state.provider.modelsEndpoint !== chatApi + "/models"
      )
        return;
      // Finish the accepted request's durable cleanup before offering its text
      // as a new draft. Otherwise the two writes can hide an unfinished cleanup.
      const previous = state.messages.findLast(
        (message) => message.role === "user",
      )?.text;
      if (previous) setDraft((current) => current || previous);
    }
  }, [job, state, pendingSend]);

  async function perform(operation) {
    if (busyRef.current) return false;
    busyRef.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(version);
      return valid(version);
    } catch (err) {
      if (valid(version)) {
        setError(
          err.status === 409 ? `${err.message} 请刷新后重试。` : err.message,
        );
        if (err.status === 409) await refresh(version).catch(() => {});
      }
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function write(action, payload, version) {
    const personal =
      ["memory", "retention"].includes(action) && !payload.bindingId;
    if (!personal) {
      const latest = await loadBinding();
      if (!valid(version) || bindingKey(latest) !== bindingKey(binding)) return;
    }
    const store = personal ? personalRequests : requests;
    const record = await store.prepare(
      operationKey(action, payload),
      (requestId) => ({
        path: `${chatApi}/${action}`,
        method: "POST",
        body: {
          requestId,
          ...payload,
          ...(payload.bindingId ? { bindingRevision: binding.revision } : {}),
        },
      }),
      { safeStop: action === "cancel" },
    );
    if (!valid(version)) return;
    return dispatch(record, store, version);
  }
  async function dispatch(record, store, version) {
    store.assertOwned(record);
    if (record.request.path === intentApi) {
      const intent =
        record.checkpoint?.intent ||
        (await call(intentApi, {
          method: "POST",
          body: record.request.body,
        }));
      if (!valid(version)) return;
      const input = intent?.input;
      if (
        !input ||
        input.requestId !== record.requestId ||
        input.bindingId !== bindingId ||
        input.bindingRevision !== binding.revision ||
        input.kind !== "task" ||
        !input.runId ||
        !input.snapshotId ||
        !/^[a-f0-9]{64}$/.test(input.payloadHash)
      )
        throw Error("执行请求回执不符，原操作仍保留。");
      await store.checkpoint(record.requestId, {
        ...record.checkpoint,
        intent,
      });
      if (!valid(version)) return;
      const result = await call("/api/agent/execution/tools", {
        method: "POST",
        body: { bindingId, name: "codex_create_run", arguments: intent.input },
      });
      if (!valid(version)) return;
      if (
        result?.result?.runId !== input.runId ||
        result.result.status !== "accepted"
      )
        throw Error("派单回执不符，原操作仍保留。");
      const original = record.checkpoint?.composerDraft;
      const control = draftControl.current;
      if (
        original &&
        control.chatId === original.chatId &&
        control.draft.trim() === original.text
      )
        control.setDraft("");
      execution?.onSelectBatch?.({
        sectionId: accountScope[2],
        bindingId,
        bindingRevision: binding.revision,
        runId: intent.input.runId,
      });
      await store.resolve(record.requestId, "acknowledged");
      return result;
    }
    const result = await call(record.request.path, {
      method: record.request.method,
      body: record.request.body,
    });
    if (!valid(version)) return;
    if (record.request.path === `${chatApi}/send`) {
      await store.checkpoint(record.requestId, {
        jobId: result.job.id,
        chatId: result.thread.id,
        status: result.job.status,
      });
      if (!valid(version)) return;
      setReceived((prior) => ({ ...prior, [record.requestId]: result }));
      clearOriginalDraft(record, result);
    } else {
      await store.resolve(record.requestId, "acknowledged");
    }
    if (valid(version)) return result;
  }
  function retry(record, personal) {
    return perform(async (version) => {
      if (!personal) {
        const latest = await loadBinding();
        if (!valid(version) || bindingKey(latest) !== bindingKey(binding))
          return;
      }
      const store = personal ? personalRequests : requests;
      const prepared = await store.prepare(
        record.operationKey,
        () => record.request,
      );
      if (!valid(version)) return;
      const result = await dispatch(prepared, store, version);
      if (!result) return;
      if (record.request.path === `${chatApi}/send`) {
        chatId.current = result.thread.id;
      } else if (record.request.path === `${chatApi}/new`) {
        chatId.current = (result.thread ?? result).id;
      } else if (
        record.request.path === `${chatApi}/memory` ||
        record.request.path === `${chatApi}/remember`
      ) {
        setNeedFreshCandidates(true);
      }
      await refreshPersonal(version);
      await refresh(version);
    });
  }
  function switchThread(thread, messages = [], job = null) {
    const prior = snapshot.current;
    setModelMenu(null);
    setUnsentModel(null);
    chatId.current = thread.id;
    handledJob.current = null;
    setOlder(null);
    apply({
      ...prior,
      thread,
      messages,
      job,
      hasMore: false,
      nextBeforeSequence: undefined,
      threads: [
        thread,
        ...(prior?.threads || []).filter((item) => item.id !== thread.id),
      ],
    });
  }
  function send() {
    return submitChat(selectedProfile?.id);
  }
  function submitChat(modelProfileId, retryJob, submittedText, taskReply) {
    const text = (submittedText ?? draft).trim();
    if (
      (!retryJob && !text) ||
      !bindingId ||
      pendingSend ||
      pendingJob ||
      executionState?.active ||
      !(modelProfileId
        ? profiles?.find((p) => p.id === modelProfileId)?.configured
        : modelReady)
    )
      return;
    return perform(async (version) => {
      const result = await write(
        "send",
        {
          bindingId,
          ...(chatId.current ? { chatId: chatId.current } : {}),
          ...(modelProfileId ? { modelProfileId } : {}),
          ...(retryJob ? { retryOf: retryJob.id } : { text }),
          ...(taskReply ? { taskReply } : {}),
        },
        version,
      );
      if (!result) return;
      setModelMenu(null);
      if (retryJob) onNavigate?.("chat");
      const prior = snapshot.current;
      const messages =
        prior?.thread?.id === result.thread.id ? prior.messages : [];
      const added = messages.some((message) => message.id === result.message.id)
        ? messages
        : [...messages, result.message];
      if (prior?.thread?.id === result.thread.id) {
        apply({
          ...prior,
          thread: result.thread,
          messages: added,
          job: result.job,
          threads: [
            result.thread,
            ...prior.threads.filter((item) => item.id !== result.thread.id),
          ],
        });
      } else switchThread(result.thread, added, result.job);
      if (result.job && !queued(result.job)) await refresh(version);
    });
  }
  function chooseModel(id) {
    if (pickerOpen && modelMenu?.jobId) {
      if (job?.status === "failed" && job.id === modelMenu.jobId)
        return submitChat(id, job);
      return;
    }
    if (!state?.thread) {
      setUnsentModel(id);
      setModelMenu(null);
      return;
    }
    return perform(async (version) => {
      const thread = await call(chatApi + "/select-model", {
        method: "POST",
        body: {
          bindingId,
          bindingRevision: binding.revision,
          chatId: state.thread.id,
          modelProfileId: id,
        },
      });
      if (!valid(version)) return;
      const current = snapshot.current;
      apply({
        ...current,
        thread,
        threads: current.threads.map((t) => (t.id === thread.id ? thread : t)),
      });
      setModelMenu(null);
    });
  }
  function stopReply() {
    if (executionState?.active) return executionState.stop();
    if (!pendingJob || !state?.thread?.id) return;
    return perform(async (version) => {
      const result = await write(
        "cancel",
        { bindingId, chatId: state.thread.id, jobId: job.id },
        version,
      );
      if (!result || !valid(version)) return;
      apply({ ...snapshot.current, job: result.job });
      await refresh(version);
    });
  }
  function newThread() {
    if (!bindingId) return;
    return perform(async (version) => {
      const result = await write("new", { bindingId }, version);
      if (!result) return;
      switchThread(result.thread ?? result);
      await refresh(version);
    });
  }
  function chooseThread(id) {
    const thread = state.threads.find((item) => item.id === id);
    if (!thread || id === chatId.current) return;
    return perform(async (version) => {
      switchThread(thread);
      await refresh(version);
    });
  }
  function chooseHandoff(keepCurrent) {
    const control = draftControl.current;
    const target = draftHandoff?.chatId;
    if (
      !mounted.current ||
      busyRef.current ||
      !target ||
      chatId.current !== target ||
      control.chatId !== target
    )
      return;
    if (keepCurrent) {
      if (!control.durable) return;
      setDraftHandoff((current) =>
        current?.requestId === draftHandoff.requestId &&
        current.chatId === target
          ? { ...current, text: control.draft }
          : current,
      );
    } else control.setDraft(draftHandoff.text);
  }
  function loadEarlier() {
    const cursor = older ? older.nextBeforeSequence : state.nextBeforeSequence;
    if (cursor === undefined || cursor === null || !chatId.current) return;
    return perform(async (version) => {
      const latest = await loadBinding();
      if (!valid(version) || bindingKey(latest) !== bindingKey(binding)) return;
      const id = chatId.current;
      const page = await read(id, cursor);
      if (!valid(version) || id !== chatId.current) return;
      if (page.memoryEpoch !== snapshot.current?.memoryEpoch) {
        await refresh(version);
        return;
      }
      setOlder({
        messages: [...page.messages, ...(older?.messages || [])],
        hasMore: page.hasMore,
        nextBeforeSequence: page.nextBeforeSequence,
      });
    });
  }
  function saveTasks(message, tasks) {
    if (needFreshCandidates && message.taskProposal?.status !== "saving")
      return;
    return perform(async (version) => {
      const result = await write(
        "save-tasks",
        { bindingId, chatId: message.chatId, messageId: message.id, tasks },
        version,
      );
      if (!result) return;
      if (result.status === "stale") {
        await refresh(version);
        if (valid(version)) setError("此提案已过时，请重新发送消息获取建议。");
        return;
      }
      if (result.saved !== true || result.messageId !== message.id)
        throw Error("暂未确认待办已保存，请刷新后核对。");
      const taskProposal = { status: "saved", operationId: result.operationId };
      const current = snapshot.current;
      apply({
        ...current,
        messages: current.messages.map((item) =>
          item.id === message.id ? { ...item, taskProposal } : item,
        ),
      });
      setOlder(
        (prior) =>
          prior && {
            ...prior,
            messages: prior.messages.map((item) =>
              item.id === message.id ? { ...item, taskProposal } : item,
            ),
          },
      );
      setNotice(
        embedded
          ? "已保存到真实清单，可调整顺序后提交执行。"
          : "已保存到真实清单。请在第 5 步排序或提交执行。",
      );
      onTasksSaved?.(result);
    });
  }
  async function refreshAfterMemory(version) {
    // A committed memory change may invalidate earlier proposals. Keep those
    // controls disabled until the server confirms which remain usable.
    setNeedFreshCandidates(true);
    await refreshPersonal(version);
    try {
      await refresh(version);
    } catch (err) {
      if (valid(version)) setReadError(err.message);
    }
  }
  function remember(message, index) {
    if (needFreshCandidates) return;
    return perform(async (version) => {
      const candidate = message.memories[index];
      const prior = state.memories.find(
        (memory) =>
          memory.scope === candidate.scope &&
          memory.key === candidate.key &&
          (memory.scope === "personal" || memory.bindingId === bindingId),
      );
      const result = await write(
        "remember",
        {
          bindingId,
          chatId: message.chatId,
          messageId: message.id,
          index,
          ...(prior
            ? { expectedMemoryId: prior.id, expectedRevision: prior.revision }
            : {}),
        },
        version,
      );
      if (!result) return;
      setNotice("已保存记忆。");
      await refreshAfterMemory(version);
    });
  }
  function changeMemory(payload) {
    return perform(async (version) => {
      const result = await write("memory", payload, version);
      if (!result) return;
      const current = snapshot.current;
      if (!payload.bindingId) {
        memoryRead.current++;
        setPersonalState(result);
        setMemoryError("");
      }
      if (current)
        apply({
          ...current,
          memories: payload.bindingId
            ? result.memories
            : [
                ...current.memories.filter(
                  (memory) => memory.scope === "project",
                ),
                ...result.memories,
              ],
          memoryEpoch: result.memoryEpoch,
        });
      setNotice(payload.action === "delete" ? "记忆已删除。" : "已保存记忆。");
      await refreshAfterMemory(version);
    });
  }

  const messages = [
    ...new Map(
      [...(older?.messages || []), ...(state?.messages || [])].map(
        (message) => [message.id, message],
      ),
    ).values(),
  ];
  const provider = state?.provider?.profiles ? state.provider : settingsCatalog;
  const profiles = provider?.profiles;
  const selectedProfile = profiles?.find(
    (p) =>
      p.id ===
      (state?.thread
        ? (state.thread.modelProfileId ?? "xingchi")
        : (unsentModel ?? provider.defaultId)),
  );
  const modelReady =
    selectedProfile?.configured ?? !!state?.provider?.configured;
  const failedProfile = profiles?.find(
    (p) => p.id === (job?.modelProfileId ?? "xingchi"),
  );
  const pickerOpen =
    !!modelMenu &&
    modelMenu.chatId === (state?.thread?.id ?? null) &&
    (!modelMenu.jobId ||
      (job?.status === "failed" && modelMenu.jobId === job.id));
  const processActive = pendingJob || !!executionState?.active;
  const stopping = !!executionState?.stopping;
  const questionKey = (state?.connectorQuestions || [])
    .map((question) => question.id)
    .join(",");
  const questionCards = questionKey ? (
    <ConnectorQuestions
      questions={state.connectorQuestions}
      bindingId={bindingId}
      call={call}
      onChange={updateConnectorQuestions}
      onOpenTools={setMcpOpen}
      inbox={workspaceView === "inbox"}
    />
  ) : null;
  const modelSettings = profiles ? (
    <ChatModelPicker
      key={
        pickerOpen && modelMenu.jobId
          ? modelMenu.jobId
          : state?.thread?.id || "new"
      }
      inline={!!workspaceView}
      catalog={provider}
      selected={selectedProfile?.id}
      failedId={pickerOpen && modelMenu.jobId ? failedProfile?.id : null}
      busy={busy || pendingSend || processActive}
      call={call}
      selectionError={error}
      onCatalog={(next) => {
        const current = snapshot.current;
        setSettingsCatalog(next);
        if (current)
          apply({ ...current, provider: { ...current.provider, ...next } });
      }}
      onChoose={chooseModel}
      onClose={() => setModelMenu(null)}
    />
  ) : (
    <div className="agent-note" role="status">
      {settingsReadError || "正在读取模型设置…"}
      {settingsReadError && (
        <button
          type="button"
          onClick={() => setSettingsReload((value) => value + 1)}
        >
          重新读取模型设置
        </button>
      )}
    </div>
  );
  const summary =
    bindingId && state?.project ? (
      <ProjectSummary
        binding={binding}
        userId={accountScope[0]}
        roomId={accountScope[1]}
        pageId={accountScope[2]}
        call={call}
        loadBinding={loadBinding}
        requestLocal={requestLocal}
        initialState={state.project}
        autoInitialize={false}
        workspacePage={!!workspaceView}
        openChat={onNavigate ? () => onNavigate("chat") : undefined}
        onStateChange={updateProject}
      />
    ) : (
      <p className="agent-note">关联执行项目后，可以读取项目摘要。</p>
    );
  const memoryFor = (fixedScope, before) =>
    personalState || state ? (
      <MemoryPanel
        {...{ bindingId, busy, embedded }}
        fixedScope={fixedScope}
        before={before}
        projectFirst={!!workspaceView}
        memories={[
          ...(state?.memories || []).filter(
            (memory) => memory.scope === "project",
          ),
          ...(
            (personalState &&
            (!state || personalState.memoryEpoch >= state.memoryEpoch)
              ? personalState.memories
              : state?.memories) || []
          ).filter((memory) => memory.scope === "personal"),
        ]}
        save={changeMemory}
        remove={changeMemory}
      />
    ) : (
      <p className="agent-note">正在读取记忆…</p>
    );
  const memory = memoryFor();
  const personalRetention = personalState?.retention?.settings;
  const projectRetention = state?.retention?.settings;
  const retentionData = {
    jobs: state?.retention?.jobs || [],
    settings:
      personalRetention &&
      (!projectRetention ||
        personalRetention.revision > projectRetention.revision)
        ? personalRetention
        : projectRetention || personalRetention,
  };
  const retentionAction = (payload) =>
    perform(async (version) => {
      const result = await write(
        "retention",
        { ...payload, ...(payload.action === "settings" ? {} : { bindingId }) },
        version,
      );
      if (!result) return;
      setNeedFreshCandidates(true);
      await refreshPersonal(version);
      if (bindingId) await refresh(version);
    });
  const retentionPending = !!state?.retention?.jobs?.some((job) =>
    ["queued", "reviewing", "awaiting_commit"].includes(job.status),
  );
  useEffect(() => {
    if (
      !bindingId ||
      (!state?.thread?.id && !executionState?.runId) ||
      !state?.retention
    )
      return;
    let alive = true,
      reading = false,
      count = 0;
    const timer = setInterval(async () => {
      if (reading || busyRef.current) return;
      if (++count > 20 && !retentionPending) {
        clearInterval(timer);
        return;
      }
      reading = true;
      const version = epoch.current;
      try {
        const next = await read(chatId.current);
        if (alive && valid(version)) apply(next);
      } catch {
        /* Existing refresh controls own errors; a background review must not interrupt the chat. */
      } finally {
        reading = false;
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [
    bindingId,
    state?.thread?.id,
    state?.job?.id,
    retentionPending,
    executionState?.runId,
    executionState?.active,
    read,
    valid,
    apply,
  ]);
  const ChatSurface = workspaceView ? "div" : React.Fragment;
  return (
    <>
      <ChatSurface
        {...(workspaceView
          ? {
              className: "studio-chat-surface",
              hidden: workspaceView !== "chat",
            }
          : {})}
      >
        {workspaceView && (
          <header className="studio-page-heading">
            <div>
              <small>项目对话</small>
              <h2>{state?.thread?.title || workspaceTitle || "新的对话"}</h2>
            </div>
          </header>
        )}
        {!embedded && bindingId && state?.project && summary}
        {embedded && !bindingId && (
          <div className="agent-chat-context-bar">
            <span>
              {bindingId ? "准备项目摘要后开始聊天" : "先选择要开发的项目"}
            </span>
            <button onClick={bindingId ? onOpenSummary : onOpenSettings}>
              {bindingId ? "查看摘要" : "选择项目"}
            </button>
            {!bindingId && !workspaceView && (
              <FilmButton onClick={() => openFilm()} />
            )}
          </div>
        )}
        <section
          className={`agent-device-card${embedded ? " agent-chat-conversation" : ""}`}
          aria-label="项目聊天"
        >
          <TaskProgress
            task={state?.harnessTask}
            busy={busy || pendingSend || processActive}
            onReply={(text, taskReply) =>
              submitChat(selectedProfile?.id, null, text, taskReply)
            }
            onOpenTools={() => setMcpOpen(true)}
            onStop={() =>
              perform(async (version) => {
                await call("/local/task/stop", {
                  method: "POST",
                  body: {
                    bindingId,
                    chatId: state.thread.id,
                    taskId: state.harnessTask.id,
                  },
                });
                await refresh(version);
              })
            }
          />
          <div
            className={embedded ? "agent-chat-toolbar" : "agent-card-heading"}
          >
            {!workspaceView && profiles && (
              <button
                type="button"
                aria-label="设置"
                title="设置"
                onClick={() => openModelSettings()}
              >
                <Settings2 size={16} />
              </button>
            )}
            {bindingId && (
              <>
                {embedded && !!state?.threads?.length && (
                  <button
                    aria-label="查看聊天历史"
                    title="聊天历史"
                    aria-expanded={historyOpen}
                    onClick={() => setHistoryOpen((value) => !value)}
                  >
                    <History size={16} />
                  </button>
                )}
                {!!state?.threads?.length && (!embedded || historyOpen) && (
                  <label>
                    {!embedded && "聊天历史"}
                    <select
                      aria-label="聊天历史"
                      title="聊天历史"
                      value={state.thread?.id || ""}
                      disabled={busy || processActive}
                      onChange={(event) => chooseThread(event.target.value)}
                    >
                      {state.threads.map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  aria-label="新聊天"
                  title="新聊天"
                  disabled={busy || !state || processActive}
                  onClick={newThread}
                >
                  {embedded ? <Plus size={16} /> : "新聊天"}
                </button>
              </>
            )}
            <button
              aria-label="刷新聊天与记忆"
              title="刷新聊天与记忆"
              disabled={busy}
              onClick={() => perform(refresh)}
            >
              {embedded ? <RefreshCw size={15} /> : "刷新聊天与记忆"}
            </button>
          </div>
          {error && (
            <p className="agent-error" role="alert">
              {error}
            </p>
          )}
          {readError && (
            <p className="agent-error" role="alert">
              {readError}
            </p>
          )}
          {state?.harnessUnavailable && (
            <p className="agent-error" role="alert">
              {state.harnessUnavailable}
            </p>
          )}
          {[
            draftStorage.warning,
            newDraftStorage.warning,
            requests.warning,
            personalRequests.warning,
          ]
            .filter(
              (value, index, all) => value && all.indexOf(value) === index,
            )
            .map((warning) => (
              <p className="agent-error" role="alert" key={warning}>
                {warning}
              </p>
            ))}
          {draftHandoff && (
            <div className="agent-note" role="status">
              <p>原草稿仍保留，确认保存后才会结束恢复。</p>
              {state?.thread?.id !== draftHandoff.chatId ? (
                <button
                  disabled={busy}
                  onClick={() => chooseThread(draftHandoff.chatId)}
                >
                  返回待恢复聊天
                </button>
              ) : chatDraft && chatDraft !== draftHandoff.text ? (
                <>
                  <p>当前聊天已有另一份草稿，尚未覆盖。</p>
                  <details>
                    <summary>查看此前草稿</summary>
                    <p className="agent-chat-copy">{draftHandoff.sourceText}</p>
                  </details>
                  <button
                    disabled={busy || !chatDraftStorage.durable}
                    onClick={() => chooseHandoff(true)}
                  >
                    保留当前草稿
                  </button>
                  <button disabled={busy} onClick={() => chooseHandoff(false)}>
                    使用此前草稿
                  </button>
                </>
              ) : null}
            </div>
          )}
          {(!draftStorage.durable || !newDraftStorage.durable) && (
            <button
              disabled={busy}
              onClick={() => {
                if (state?.thread) setChatDraft(chatDraft);
                setNewDraft(newDraft);
              }}
            >
              重试保存草稿
            </button>
          )}
          <UnknownWorkspaceRequests requests={requests} />
          <UnknownWorkspaceRequests requests={personalRequests} />
          {[
            ...requests.ownedRecords.map((record) => ({
              record,
              personal: false,
            })),
            ...personalRequests.ownedRecords.map((record) => ({
              record,
              personal: true,
            })),
          ].map(({ record, personal }) => (
            <div className="agent-actions" key={record.requestId}>
              <span className="agent-note">
                {record.request.path === `${chatApi}/send`
                  ? "原消息已保留，可核对处理结果。"
                  : "原操作待核对，重试会使用原内容。"}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  perform(async (version) => {
                    await refreshPersonal(version);
                    await refresh(version);
                  })
                }
              >
                核对原操作
              </button>
              <button
                disabled={busy || !!received[record.requestId]}
                onClick={() => retry(record, personal)}
              >
                重试原操作
              </button>
            </div>
          ))}
          {notice && (
            <p className="agent-success" role="status">
              {notice}
            </p>
          )}
          {!bindingId && !embedded && (
            <p className="agent-note">请先绑定执行项目。</p>
          )}
          {state &&
            (!embedded || !modelReady) &&
            (modelReady ? (
              <p className="agent-note">
                聊天模型：{state.provider.model || "已配置"}
              </p>
            ) : (
              <p className="agent-note">
                {profiles ? (
                  <>
                    请在设置中添加 BYOK 模型连接。
                    <button type="button" onClick={() => openModelSettings()}>
                      打开设置
                    </button>
                  </>
                ) : (
                  state.provider?.setupHint ||
                  "聊天模型尚未配置。请完成服务端配置。记忆仍可管理。"
                )}
              </p>
            ))}
          {bindingId && (older ? older.hasMore : state?.hasMore) && (
            <button disabled={busy} onClick={loadEarlier}>
              加载更早的消息
            </button>
          )}
          {bindingId &&
            (execution && embedded ? (
              <ProjectConversation
                questionsContent={
                  workspaceView === "inbox" ? null : questionCards
                }
                questionKey={questionKey}
                {...{
                  execution,
                  accountScope,
                  binding,
                  call,
                  loadBinding,
                  messages,
                  job,
                }}
                onExecutionChange={setExecutionState}
                onQuote={quoteReply}
                renderMessage={(message) => (
                  <ChatMessage
                    accountScope={accountScope}
                    key={message.id}
                    onQuote={quoteReply}
                    onOpenMcp={(id) => setMcpOpen(id || true)}
                    onFilm={(text) =>
                      openFilm({ text, messageId: message.id, create: true })
                    }
                    onFilmReference={(id, job) => openFilm({ id, job })}
                    startedAt={
                      messages.find((entry) => entry.id === message.replyTo)
                        ?.createdAt
                    }
                    {...{
                      message,
                      busy,
                      needFreshCandidates,
                      saveTasks,
                      remember,
                      openChecklist,
                      embedded,
                    }}
                  />
                )}
              />
            ) : (
              <ConversationMessages
                questionsContent={
                  workspaceView === "inbox" ? null : questionCards
                }
                questionKey={questionKey}
                {...{ messages, job }}
                renderMessage={(message) => (
                  <ChatMessage
                    accountScope={accountScope}
                    key={message.id}
                    onQuote={quoteReply}
                    onOpenMcp={(id) => setMcpOpen(id || true)}
                    onFilm={
                      embedded
                        ? (text) =>
                            openFilm({
                              text,
                              messageId: message.id,
                              create: true,
                            })
                        : undefined
                    }
                    onFilmReference={
                      embedded ? (id, job) => openFilm({ id, job }) : undefined
                    }
                    startedAt={
                      messages.find((entry) => entry.id === message.replyTo)
                        ?.createdAt
                    }
                    {...{
                      message,
                      busy,
                      needFreshCandidates,
                      saveTasks,
                      remember,
                      openChecklist,
                      embedded,
                    }}
                  />
                )}
              />
            ))}
          {needFreshCandidates && (
            <p className="agent-note">刷新聊天后可核对哪些建议仍可采纳。</p>
          )}
          {job?.status === "failed" && profiles && (
            <div className="agent-error qd-model-failure">
              <span role="status">{job.error || "模型回复失败。"}</span>
              {failedProfile && (
                <small>
                  {failedProfile.model} · {failedProfile.service}
                </small>
              )}
              <button
                type="button"
                disabled={busy || pendingSend || processActive}
                onClick={() => openModelSettings(job)}
              >
                {profiles.some(
                  (p) => p.configured && p.id !== failedProfile?.id,
                )
                  ? "换模型重试"
                  : "添加备用模型"}
              </button>
              <ModelErrorDetails diagnostic={job.diagnostic} />
            </div>
          )}
          {job?.status === "failed" && !profiles && (
            <p className="agent-error" role="status">
              {job.error || "模型回复失败。"} 可重新发送。
            </p>
          )}
          {job?.status === "stale" && (
            <p className="agent-note" role="status">
              记忆已更改，请重新发送。
            </p>
          )}
          {embedded &&
            bindingId &&
            state &&
            !messages.length &&
            !executionState?.runId &&
            !pendingJob && (
              <div className="agent-chat-welcome">
                <span className="agent-chat-welcome-icon" aria-hidden="true">
                  <Sparkles size={24} />
                </span>
                <h3>把想法，变成下一步。</h3>
                <p className="studio-welcome-description">
                  讨论需求、整理待办，让项目从这里开始。
                </p>
                <div>
                  <Button
                    variant="outline"
                    className="studio-suggestion qd:h-auto qd:justify-start qd:rounded-2xl qd:py-4"
                    disabled={!modelReady || busy}
                    onClick={() =>
                      setDraft("帮我整理今天的待办，并按优先级排序。")
                    }
                  >
                    <ListTodo size={17} aria-hidden="true" />
                    <span>整理今天的待办</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    className="studio-suggestion qd:h-auto qd:justify-start qd:rounded-2xl qd:py-4"
                    disabled={!modelReady || busy}
                    onClick={() =>
                      setDraft(
                        "帮我梳理这个项目的下一步，先给出建议，不要执行。",
                      )
                    }
                  >
                    <Compass size={17} aria-hidden="true" />
                    <span>梳理项目下一步</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )}
          {embedded && (
            <FilmLinks
              scope={accountScope}
              call={call}
              revision={filmRevision}
              chatId={state?.thread?.id || null}
              onOpen={(id) => openFilm({ id })}
            />
          )}
          <RetentionPanel
            data={retentionData}
            taskId={state?.harnessTask?.id}
            taskIds={
              executionState?.runId ? ["execution:" + executionState.runId] : []
            }
            sourceJobId={state?.job?.id}
            busy={busy}
            error={error}
            onAction={retentionAction}
          />
          <div className={embedded ? "agent-chat-composer" : undefined}>
            {embedded && bindingId && (
              <div
                className="agent-composer-context"
                aria-label="本次聊天上下文"
              >
                {!workspaceView && (
                  <>
                    <button type="button" onClick={onOpenSettings}>
                      <Folder size={13} />
                      当前项目
                    </button>
                    <button type="button" onClick={onOpenSummary}>
                      <FileText size={13} />
                      {state?.project?.summaryRevision
                        ? `项目摘要 · 第 ${state.project.summaryRevision} 版`
                        : "项目摘要"}
                    </button>
                    <FilmButton onClick={() => openFilm()} />
                  </>
                )}
                {state?.mcpAvailable && (
                  <button type="button" onClick={() => setMcpOpen(true)}>
                    <Wrench size={13} />
                    工具
                  </button>
                )}
                {state?.mcpAvailable && mcpOpen && (
                  <McpToolsPanel
                    key={bindingId}
                    bindingId={bindingId}
                    call={call}
                    unavailable={state.harnessUnavailable}
                    initialServer={typeof mcpOpen === "string" ? mcpOpen : null}
                    onClose={() => setMcpOpen(false)}
                  />
                )}
              </div>
            )}
            <label>
              发消息
              <textarea
                aria-label="聊天消息"
                ref={composerInput}
                value={draft}
                disabled={!bindingId || !state}
                maxLength={12000}
                rows={embedded ? 2 : 3}
                placeholder={
                  embedded
                    ? processActive
                      ? "执行中，可先写下下一条消息…"
                      : "说说你的想法，或补充项目要求…"
                    : undefined
                }
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    !processActive &&
                    !busy
                  ) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            </label>
            {embedded && (
              <span className="agent-composer-assistant">
                <Sparkles size={13} aria-hidden="true" />
                Agent
              </span>
            )}
            <button
              className="primary"
              disabled={
                processActive
                  ? busy || executionState?.busy || stopping
                  : busy ||
                    !bindingId ||
                    !modelReady ||
                    pendingJob ||
                    pendingSend ||
                    !draft.trim()
              }
              onClick={processActive ? stopReply : send}
              aria-label={
                processActive
                  ? stopping
                    ? "正在停止"
                    : "停止"
                  : embedded
                    ? "开始"
                    : "发送"
              }
              data-state={processActive ? "stop" : "start"}
            >
              <span>
                {processActive
                  ? stopping
                    ? "正在停止"
                    : "停止"
                  : embedded
                    ? "开始"
                    : "发送"}
              </span>
              {embedded &&
                (processActive ? (
                  <Square size={13} fill="currentColor" aria-hidden="true" />
                ) : (
                  <ArrowUp size={15} aria-hidden="true" />
                ))}
            </button>
            {embedded && executionState?.active && (
              <small>Codex 执行中 · 可随时停止</small>
            )}
          </div>
        </section>
        {memoryError && (
          <p className="agent-error" role="alert">
            {memoryError}
            <button disabled={busy} onClick={() => perform(refreshPersonal)}>
              重新读取个人记忆
            </button>
          </p>
        )}
        {!embedded && memory}
      </ChatSurface>
      {workspaceView === "settings" && (
        <WorkspaceSettings
          models={modelSettings}
          onExecutionHost={onExecutionSettingsHost}
          executionUrl={executionSettingsUrl}
          retryKey={pickerOpen ? modelMenu.jobId : null}
          onOpenDevices={onOpenSettings}
          preferences={
            <>
              {memoryError && (
                <p role="alert" className="agent-error">
                  {memoryError}
                </p>
              )}
              {memoryFor(
                "personal",
                <RetentionPanel
                  preferences
                  data={retentionData}
                  busy={busy}
                  error={error}
                  onAction={retentionAction}
                />,
              )}
            </>
          }
          tools={
            state?.mcpAvailable && bindingId
              ? (executionSettings) => (
                  <McpToolsPanel
                    bindingId={bindingId}
                    call={call}
                    unavailable={state?.harnessUnavailable}
                    embedded
                    executionSettings={executionSettings}
                  />
                )
              : undefined
          }
        />
      )}
      {workspaceView === "inbox" && state?.mcpAvailable && (
        <section
          className="studio-resource agent-human-inbox"
          aria-label="当前项目待处理请求"
        >
          <header className="studio-page-heading">
            <div>
              <small>当前项目</small>
              <h2>待处理请求</h2>
            </div>
          </header>
          {questionCards || (
            <p className="agent-note">当前没有需要你处理的问题。</p>
          )}
        </section>
      )}
      {!workspaceView && pickerOpen && modelSettings}
      {execution?.detailHost &&
        !bindingId &&
        createPortal(
          <button onClick={onOpenSettings}>绑定执行项目后查看记录</button>,
          execution.detailHost,
        )}
      {embedded && (filmOpen || workspaceView === "film") && (
        <div
          className="studio-film-surface"
          hidden={!!workspaceView && workspaceView !== "film"}
        >
          <FilmStudio
            key={filmOpen?.instance || 0}
            inline={!!workspaceView}
            visible={!workspaceView || workspaceView === "film"}
            scope={accountScope}
            call={call}
            initialId={filmOpen?.id}
            initialVersion={filmOpen?.job}
            initialTodo={filmOpen?.source}
            initialMessageId={filmOpen?.messageId}
            createFirst={filmOpen?.create}
            initialText={filmOpen?.text ?? (workspaceView ? "" : draft)}
            chatId={state?.thread?.id || null}
            binding={binding}
            project={state?.project}
            memories={state?.memories || []}
            saveStyle={changeMemory}
            execution={execution}
            onQuote={(text) => {
              onNavigate?.("chat");
              quoteReply(text);
              if (!workspaceView) setFilmOpen(null);
            }}
            onClose={() => {
              setFilmOpen(null);
              onNavigate?.("chat");
            }}
            onChange={() => setFilmRevision((v) => v + 1)}
          />
        </div>
      )}
      {embedded &&
        workspaceView &&
        (summaryOpen ||
          memoryOpen ||
          workspaceView === "summary" ||
          workspaceView === "memory") && (
          <ProjectResources
            initialTab={workspaceView === "memory" ? "agreements" : "overview"}
            summary={summary}
            memories={memoryFor("project")}
            error={memoryError}
          />
        )}
      {embedded &&
        !workspaceView &&
        memoryOpen &&
        (workspaceView ? (
          <section className="studio-resource">
            <header className="studio-page-heading">
              <div>
                <small>项目资料</small>
                <h2>记忆</h2>
              </div>
            </header>
            {memoryError && <p role="alert">{memoryError}</p>}
            {memory}
          </section>
        ) : (
          <WorkspaceDrawer title="记忆" onClose={onMemoryClose}>
            {memory}
          </WorkspaceDrawer>
        ))}
      {embedded &&
        !workspaceView &&
        summaryOpen &&
        (workspaceView ? (
          <section className="studio-resource">
            <header className="studio-page-heading">
              <div>
                <small>项目资料</small>
                <h2>项目摘要</h2>
              </div>
            </header>
            {summary}
          </section>
        ) : (
          <WorkspaceDrawer
            title="项目摘要"
            size="wide"
            onClose={onSummaryClose}
          >
            {summary}
          </WorkspaceDrawer>
        ))}
    </>
  );
}

function ChatScope({
  roomId,
  userId,
  pageId,
  requestCloud,
  requestLocal,
  openChecklist,
  ...workspaceProps
}) {
  const [binding, setBinding] = useState(undefined);
  const [error, setError] = useState("");
  const active = useRef(false);
  const revision = useRef(0);
  const bindingRead = useRef(null);
  const call = useCallback(
    (path, options) =>
      requestCloud(path, {
        ...options,
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const loadBinding = useCallback(() => {
    if (bindingRead.current) return bindingRead.current;
    const pending = (async () => {
      const version = ++revision.current;
      let result;
      if (pageId) {
        try {
          result = await call(
            `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(pageId)}`,
          );
        } catch (err) {
          // Personal memory remains available to signed-in users without access
          // to this project's execution binding.
          if (![403, 404].includes(err.status)) throw err;
        }
      }
      if (!active.current || version !== revision.current) return;
      const next = result?.binding?.enabled ? result.binding : null;
      setBinding((prior) =>
        bindingKey(prior) === bindingKey(next) ? prior : next,
      );
      setError("");
      return next;
    })().finally(() => {
      if (bindingRead.current === pending) bindingRead.current = null;
    });
    bindingRead.current = pending;
    return pending;
  }, [call, roomId, pageId]);
  useEffect(() => {
    active.current = true;
    void loadBinding().catch((err) => {
      if (active.current) setError(err.message);
    });
    return () => {
      active.current = false;
      revision.current++;
    };
  }, [loadBinding]);
  if (binding === undefined) {
    const status = error ? (
      <p className="agent-error" role="alert">
        {error}{" "}
        <button
          onClick={() =>
            void loadBinding().catch((err) => {
              if (active.current) setError(err.message);
            })
          }
        >
          重新读取项目关联
        </button>
      </p>
    ) : (
      <p className="agent-note">正在读取项目关联…</p>
    );
    return workspaceProps.execution?.detailHost
      ? createPortal(status, workspaceProps.execution.detailHost)
      : status;
  }
  return (
    <ChatWorkspace
      key={bindingKey(binding) || "unbound"}
      accountScope={[userId, roomId, pageId]}
      {...{ binding, call, loadBinding, openChecklist, requestLocal }}
      {...workspaceProps}
    />
  );
}

export default function ChatPanel({
  roomId,
  userId,
  pages = [],
  requestCloud = api,
  requestLocal,
  onOpenChecklist,
  embedded = false,
  ...workspaceProps
}) {
  const [selected, setSelected] = useState("");
  const page = pages.find((item) => item.id === selected) ?? pages[0];
  const pageId = page?.id;
  return (
    <div
      className={`agent-trial agent-execution-panel agent-chat-panel${embedded ? " is-embedded" : ""}`}
    >
      {!embedded && (
        <div className="agent-intro">
          <h3>聊天与记忆</h3>
        </div>
      )}
      {!embedded && page && (
        <label>
          项目清单
          <select
            aria-label="聊天项目"
            value={pageId}
            onChange={(event) => setSelected(event.target.value)}
          >
            {pages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || "未命名清单"}
              </option>
            ))}
          </select>
        </label>
      )}
      <ChatScope
        key={JSON.stringify([userId, roomId, pageId])}
        {...{ roomId, userId, pageId, requestCloud, requestLocal }}
        {...workspaceProps}
        embedded={embedded}
        openChecklist={
          pageId && onOpenChecklist ? () => onOpenChecklist(pageId) : undefined
        }
      />
    </div>
  );
}
