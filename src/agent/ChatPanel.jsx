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
import {
  useWorkspaceDraft,
  useWorkspaceRequests,
  workspaceScope,
} from "./workspace-state.js";

const chatApi = "/api/agent/chat";
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
  if (action === "send") return `send:${payload.chatId || "new"}`;
  if (action === "new") return "new";
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
  const requestScope = workspaceScope({
    accountId: accountScope[0],
    canvasId: accountScope[1],
    sectionId: accountScope[2],
    binding,
  });
  const requests = useWorkspaceRequests(requestScope);
  const personalRequests = useWorkspaceRequests(
    workspaceScope({ accountId: accountScope[0], canvasId: null }),
  );
  const [state, setState] = useState(null);
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
  const draftControl = useRef(null);
  draftControl.current = {
    chatId: state?.thread?.id || null,
    draft,
    durable: draftStorage.durable,
    setDraft,
    newDraft,
    setNewDraft,
  };
  const settling = useRef(new Set());
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
    if (
      snapshot.current?.memoryEpoch !== next.memoryEpoch ||
      snapshot.current?.thread?.id !== next.thread?.id
    )
      setOlder(null);
    snapshot.current = next;
    setState(next);
  }, []);
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
      for (const record of requests.getSnapshot().records) {
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
  const pendingSend = requests.records.some(
    (record) =>
      record.request.path === `${chatApi}/send` &&
      (!(record.request.body.chatId || record.checkpoint?.chatId) ||
        record.request.body.chatId === state?.thread?.id ||
        record.checkpoint?.chatId === state?.thread?.id),
  );
  useEffect(() => {
    for (const record of requests.records) {
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
      void requests.resolve(record.requestId, "acknowledged").catch(() => {});
    }
  }, [
    received,
    state?.thread?.id,
    requests.records,
    requests.resolve,
    clearOriginalDraft,
    draftHandoff,
    draft,
    draftStorage.durable,
    newDraft,
    newDraftStorage.durable,
  ]);
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
    if (!job || queued(job) || handledJob.current === job.id || pendingSend)
      return;
    handledJob.current = job.id;
    if (job.status === "failed" || job.status === "stale") {
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
      if (valid(version)) setBusy(false);
    }
  }
  async function write(action, payload, version) {
    const personal = action === "memory" && !payload.bindingId;
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
    );
    if (!valid(version)) return;
    return dispatch(record, store, version);
  }
  async function dispatch(record, store, version) {
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
      pendingSend ||
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
      if (result.job && !queued(result.job)) await refresh(version);
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
        roomId={accountScope[1]}
        pageId={accountScope[2]}
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
  const memory =
    personalState || state ? (
      <MemoryPanel
        {...{ bindingId, busy, embedded }}
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
  return (
    <>
      {!embedded && bindingId && state?.project && summary}
      {embedded && (!bindingId || (state?.project && !state.project.ready)) && (
        <div className="agent-chat-context-bar">
          <span>
            {bindingId
              ? "准备项目摘要后开始聊天"
              : "选择 Codex 会话，自动关联项目"}
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
        {[
          draftStorage.warning,
          newDraftStorage.warning,
          requests.warning,
          personalRequests.warning,
        ]
          .filter((value, index, all) => value && all.indexOf(value) === index)
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
        {[
          ...requests.records.map((record) => ({ record, personal: false })),
          ...personalRequests.records.map((record) => ({
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
              pendingSend ||
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
      {memoryError && (
        <p className="agent-error" role="alert">
          {memoryError}
          <button disabled={busy} onClick={() => perform(refreshPersonal)}>
            重新读取个人记忆
          </button>
        </p>
      )}
      {!embedded && memory}
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
