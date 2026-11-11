import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Plus, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import MemoryPanel, { memoryScopeName } from "./MemoryPanel.jsx";
import { ProjectSummary } from "./ProjectSummaryPanel.jsx";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";

const chatApi = "/api/agent/chat";
const queued = (job) => job?.status === "queued" || job?.status === "running";
const bindingKey = (binding) =>
  binding && JSON.stringify([binding.bindingId, binding.revision]);
const pendingRequests = new Map();
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
  busy,
  needFreshCandidates,
  saveTasks,
  remember,
  openChecklist,
  embedded,
}) {
  return (
    <li className={`agent-chat-message agent-chat-${message.role}`}>
      <strong>{message.role === "user" ? "你" : "助手"}</strong>
      <p className="agent-chat-copy">{message.text}</p>
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
  memoryOpen,
  onMemoryClose,
  summaryOpen,
  onSummaryClose,
  onOpenSummary,
  onTasksSaved,
  onOpenSettings,
}) {
  const bindingId = binding?.bindingId;
  const [state, setState] = useState(null);
  const [older, setOlder] = useState(null);
  const [draft, setDraft] = useWorkspaceDraft(
    JSON.stringify([
      accountScope,
      bindingKey(binding),
      state?.thread?.id || "new",
      "chat",
    ]),
    "",
    embedded,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [needFreshCandidates, setNeedFreshCandidates] = useState(false);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const chatId = useRef(null);
  const snapshot = useRef(null);
  const handledJob = useRef(null);
  const messageList = useRef(null);
  const lastVisible = useRef(null);
  const followingMessages = useRef(true);
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
    if (
      snapshot.current?.memoryEpoch !== next.memoryEpoch ||
      snapshot.current?.thread?.id !== next.thread?.id
    )
      setOlder(null);
    snapshot.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(
    async (version) => {
      const latestBinding = await loadBinding();
      if (!valid(version) || bindingKey(latestBinding) !== bindingKey(binding))
        return;
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
      chatId.current = next.thread?.id ?? null;
      apply(next);
      setReadError("");
      setNeedFreshCandidates(false);
    },
    [loadBinding, binding, bindingId, read, valid, apply],
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
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [refresh, valid]);

  const job = state?.job;
  const pendingJob = queued(job);
  useEffect(() => {
    if (!pendingJob) return;
    let reading = false;
    const timer = setInterval(async () => {
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
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingJob, refresh, valid]);
  useEffect(() => {
    if (!job || queued(job) || handledJob.current === job.id) return;
    handledJob.current = job.id;
    if (job.status === "failed" || job.status === "stale") {
      const previous = state.messages.findLast(
        (message) => message.role === "user",
      )?.text;
      if (previous) setDraft((current) => current || previous);
    }
  }, [job, state]);

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
      if (valid(version)) setBusy(false);
    }
  }
  async function write(action, payload, version) {
    const latest = await loadBinding();
    if (!valid(version) || bindingKey(latest) !== bindingKey(binding)) return;
    const key = JSON.stringify([
      accountScope,
      bindingKey(binding),
      action,
      payload,
    ]);
    let requestId = pendingRequests.get(key);
    if (!requestId) {
      if (pendingRequests.size >= 100)
        throw Error("待核对的操作较多，请先刷新并重试原操作。");
      requestId = crypto.randomUUID();
      pendingRequests.set(key, requestId);
    }
    try {
      const result = await call(`${chatApi}/${action}`, {
        method: "POST",
        body: {
          requestId,
          ...payload,
          ...(payload.bindingId ? { bindingRevision: binding.revision } : {}),
        },
      });
      pendingRequests.delete(key);
      if (valid(version)) return result;
    } catch (err) {
      if (
        action !== "new" &&
        err.status >= 400 &&
        err.status < 500 &&
        ![408, 429].includes(err.status)
      )
        pendingRequests.delete(key);
      throw err;
    }
  }
  function switchThread(thread, messages = [], job = null) {
    const prior = snapshot.current;
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
    const text = draft.trim();
    if (
      !text ||
      !bindingId ||
      pendingJob ||
      !state?.provider?.configured ||
      (state?.project && !state.project.ready)
    )
      return;
    return perform(async (version) => {
      const result = await write(
        "send",
        {
          bindingId,
          ...(chatId.current ? { chatId: chatId.current } : {}),
          text,
        },
        version,
      );
      if (!result) return;
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
      setDraft("");
      if (result.job && !queued(result.job)) await refresh(version);
    });
  }
  function newThread() {
    if (!bindingId) return;
    return perform(async (version) => {
      const result = await write("new", { bindingId }, version);
      if (!result) return;
      switchThread(result.thread ?? result);
      if (!embedded) setDraft("");
      await refresh(version);
    });
  }
  function chooseThread(id) {
    const thread = state.threads.find((item) => item.id === id);
    if (!thread || id === chatId.current) return;
    return perform(async (version) => {
      switchThread(thread);
      if (!embedded) setDraft("");
      await refresh(version);
    });
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
      apply({
        ...current,
        memories: result.memories,
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
  const modelReady = !!state?.provider?.configured;
  const lastMessage = messages.at(-1);
  useLayoutEffect(() => {
    const list = messageList.current;
    if (!embedded || !list) return;
    if (
      !lastVisible.current ||
      followingMessages.current ||
      lastMessage?.role === "user"
    )
      list.scrollTop = list.scrollHeight;
    lastVisible.current = lastMessage?.id;
  }, [embedded, lastMessage?.id, pendingJob]);
  const summary =
    bindingId && state?.project ? (
      <ProjectSummary
        binding={binding}
        userId={accountScope[0]}
        call={call}
        loadBinding={loadBinding}
        requestLocal={requestLocal}
        initialState={state.project}
        autoInitialize={false}
        onStateChange={updateProject}
      />
    ) : (
      <p className="agent-note">关联执行项目后，可以读取项目摘要。</p>
    );
  const memory = state ? (
    <MemoryPanel
      {...{ bindingId, busy, embedded }}
      memories={state.memories}
      save={changeMemory}
      remove={changeMemory}
    />
  ) : (
    <p className="agent-note">正在读取记忆…</p>
  );
  return (
    <>
      {!embedded && bindingId && state?.project && summary}
      {embedded && (!bindingId || (state?.project && !state.project.ready)) && (
        <div className="agent-chat-context-bar">
          <span>
            {bindingId ? "准备项目摘要后开始聊天" : "选择 Codex 会话，自动关联项目"}
          </span>
          <button onClick={bindingId ? onOpenSummary : onOpenSettings}>
            {bindingId ? "查看摘要" : "选择 Codex 会话"}
          </button>
        </div>
      )}
      <section
        className={`agent-device-card${embedded ? " agent-chat-conversation" : ""}`}
        aria-label="项目聊天"
      >
        <div className={embedded ? "agent-chat-toolbar" : "agent-card-heading"}>
          {!embedded && <h4>项目聊天</h4>}
          {bindingId && (
            <>
              {!!state?.threads?.length && (
                <label>
                  {!embedded && "聊天历史"}
                  <select
                    aria-label="聊天历史"
                    title="聊天历史"
                    value={state.thread?.id || ""}
                    disabled={busy}
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
                disabled={busy || !state}
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
        {notice && (
          <p className="agent-success" role="status">
            {notice}
          </p>
        )}
        {!bindingId && !embedded && (
          <p className="agent-note">
            {embedded
              ? "请先关联电脑和执行项目。你仍然可以查看和管理个人记忆。"
              : "请选择已关联的项目，或在第 3 步关联电脑和项目。"}
          </p>
        )}
        {state &&
          (!embedded || !modelReady) &&
          (modelReady ? (
            <p className="agent-note">
              聊天模型：{state.provider.model || "DeepSeek"}
            </p>
          ) : (
            <p className="agent-note">
              聊天模型尚未配置。请完成服务端配置。记忆仍可管理。
            </p>
          ))}
        {bindingId && (older ? older.hasMore : state?.hasMore) && (
          <button disabled={busy} onClick={loadEarlier}>
            加载更早的消息
          </button>
        )}
        {bindingId && messages.length > 0 && (
          <ol
            className="agent-chat-messages"
            aria-label="聊天消息记录"
            ref={messageList}
            onScroll={(event) => {
              const list = event.currentTarget;
              followingMessages.current =
                list.scrollHeight - list.clientHeight - list.scrollTop < 120;
            }}
          >
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
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
            ))}
          </ol>
        )}
        {needFreshCandidates && (
          <p className="agent-note">刷新聊天后可核对哪些建议仍可采纳。</p>
        )}
        {pendingJob && (
          <p className="agent-note" role="status">
            等待模型回复…
          </p>
        )}
        {job?.status === "failed" && (
          <p className="agent-error" role="status">
            {job.error || "模型回复失败。"} 可重新发送。
          </p>
        )}
        {job?.status === "stale" && (
          <p className="agent-note" role="status">
            记忆已更改，请重新发送。
          </p>
        )}
        {embedded && bindingId && state && !messages.length && (
          <div className="agent-chat-welcome">
            <h3>今天想做什么？</h3>
            <div>
              <button
                disabled={!modelReady || busy}
                onClick={() => setDraft("帮我整理今天的待办，并按优先级排序。")}
              >
                整理今天的待办
              </button>
              <button
                disabled={!modelReady || busy}
                onClick={() =>
                  setDraft("帮我梳理这个项目的下一步，先给出建议，不要执行。")
                }
              >
                梳理项目下一步
              </button>
            </div>
          </div>
        )}
        <div className={embedded ? "agent-chat-composer" : undefined}>
          <label>
            发消息
            <textarea
              aria-label="聊天消息"
              value={draft}
              disabled={busy || !bindingId || !modelReady || pendingJob}
              maxLength={12000}
              rows={embedded ? 2 : 3}
              placeholder={
                embedded ? "说说你的想法，或补充项目要求…" : undefined
              }
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={
              busy ||
              !bindingId ||
              !modelReady ||
              pendingJob ||
              !draft.trim() ||
              (state?.project && !state.project.ready)
            }
            onClick={send}
          >
            发送
          </button>
          {embedded && (
            <small title="提交待办才会开始执行">
              {state?.provider?.model || "项目聊天"}
            </small>
          )}
        </div>
      </section>
      {!embedded && state && memory}
      {embedded && memoryOpen && (
        <WorkspaceDrawer title="记忆" onClose={onMemoryClose}>
          {memory}
        </WorkspaceDrawer>
      )}
      {embedded && summaryOpen && (
        <WorkspaceDrawer title="项目摘要" onClose={onSummaryClose}>
          {summary}
        </WorkspaceDrawer>
      )}
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
  const call = useCallback(
    (path, options) =>
      requestCloud(path, {
        ...options,
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const loadBinding = useCallback(async () => {
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
  if (binding === undefined)
    return error ? (
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
          <p>
            讨论项目并整理待办。确认保存的待办会出现在第 5
            步真实清单。聊天与项目记忆跟随轻单清单，变更执行目录后仍会保留。
          </p>
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
