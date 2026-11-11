import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, RefreshCw } from "lucide-react";
import { MAX_PLAN_TASKS } from "../../shared/agent/sort-plan.ts";
import { api } from "../api.js";
import { localRunnerRequest } from "./DevicePanel.jsx";
import { batchStatusLabel, batchItemLabel } from "./BatchPanel.jsx";
import { useWorkspaceDraft } from "./workspace-state.js";
import {
  PermissionButton,
  usePermissionPreference,
} from "./PermissionControls.jsx";

const executionApi = "/api/agent/execution";
const emptyDraft = { text: "", instruction: "", acceptance: "" };
const specText = {
  ready: "可派单",
  missing: "待填写执行要求",
  stale: "待重新确认执行要求",
};
const runText = {
  queued: "已排队，等待电脑接单",
  preparing: "正在准备",
  running: "正在执行",
  waiting_input: "需要补充信息",
  waiting_approval: "需要审批",
  verifying: "执行结束，待核对结果",
  succeeded: "执行结束，待核对结果",
  failed: "执行失败",
  cancelled: "批次已停止",
  cancel_requested: "正在等待本机确认停止",
  reconciliation_required: "需要核对本机进度",
};
const itemText = {
  pending: "待执行",
  running: "执行中",
  done: "执行成功",
  blocked: "已暂停",
  needs_input: "需要补充信息",
  failed: "执行失败",
  cancelled: "已停止",
};
const writebackText = {
  pending: "待同步",
  applied: "已更新清单",
  conflict: "待办已变化，需核对",
  failed: "清单未更新，需核对",
  disabled: "保留清单状态",
};
const bindingKey = (binding) =>
  binding &&
  JSON.stringify([
    binding.bindingId,
    binding.revision,
    binding.runnerId,
    binding.workspaceId,
  ]);
const taskRef = ({ noteId, taskId }) => ({ noteId, taskId });
const taskVersion = ({ noteId, taskId, generation, specRevision }) =>
  JSON.stringify([noteId, taskId, generation, specRevision]);
const eligible = (task) =>
  !task.done && !task.locked && task.specStatus === "ready";
const draftFromTask = (task) => {
  const checks = task.acceptanceChecks || [];
  const check = checks.length === 1 ? checks[0] : null;
  const file =
    check?.kind === "artifact" &&
    check.required &&
    ["exists", "textContains"].includes(check.predicate?.type);
  return {
    text: task.text,
    instruction: task.instruction || "",
    acceptance: task.acceptance || "",
    ...(checks.length
      ? { acceptanceChecks: checks, checkMode: file ? "file" : "custom" }
      : {}),
    ...(file
      ? {
          checkPath: check.relativePath,
          checkPredicate: check.predicate.type,
          checkText: check.predicate.text || "",
        }
      : {}),
  };
};
const trimDraft = (value) => {
  const result = {
    text: value.text.trim(),
    instruction: value.instruction.trim(),
    acceptance: value.acceptance.trim(),
  };
  if (value.checkMode === "file") {
    const path = (value.checkPath || "").trim();
    const text = value.checkText || "";
    if (!path) throw Error("请填写要检查的项目内文件路径。");
    if (value.checkPredicate === "textContains" && !text.trim())
      throw Error("请填写文件需要包含的文字。");
    result.acceptanceChecks = [
      {
        id: value.acceptanceChecks?.[0]?.id || "checklist-file",
        kind: "artifact",
        required: true,
        description: result.acceptance,
        relativePath: path,
        predicate:
          value.checkPredicate === "textContains"
            ? { type: "textContains", text }
            : { type: "exists" },
      },
    ];
  } else if (value.checkMode === "human") result.acceptanceChecks = [];
  else if (value.acceptanceChecks)
    result.acceptanceChecks = value.acceptanceChecks;
  return result;
};

function DraftFields({
  label,
  value,
  onChange,
  disabled,
  editableText = true,
}) {
  return (
    <>
      {editableText && (
        <label>
          待办内容
          <textarea
            aria-label={label === "新待办" ? label : "编辑待办内容"}
            value={value.text}
            onChange={(event) =>
              onChange({ ...value, text: event.target.value })
            }
            rows={2}
            maxLength={32000}
            disabled={disabled}
          />
        </label>
      )}
      <label>
        执行要求
        <textarea
          aria-label={`${label}执行要求`}
          value={value.instruction}
          onChange={(event) =>
            onChange({ ...value, instruction: event.target.value })
          }
          rows={2}
          maxLength={32000}
          disabled={disabled}
        />
      </label>
      <label>
        验收方式
        <select
          aria-label={`${label}验收方式`}
          value={value.checkMode || "human"}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, checkMode: event.target.value })
          }
        >
          <option value="human">人工确认</option>
          <option value="file">文件检查</option>
          {value.acceptanceChecks?.length > 0 && (
            <option value="custom">保留已有验收条件</option>
          )}
        </select>
      </label>
      {value.checkMode === "file" ? (
        <div className="agent-file-check">
          <label>
            项目内文件路径
            <input
              aria-label={`${label}检查文件`}
              placeholder="例如 reports/result.txt"
              value={value.checkPath || ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, checkPath: event.target.value })
              }
            />
          </label>
          <label>
            检查内容
            <select
              aria-label={`${label}文件检查`}
              value={value.checkPredicate || "exists"}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, checkPredicate: event.target.value })
              }
            >
              <option value="exists">文件存在</option>
              <option value="textContains">文件包含指定文字</option>
            </select>
          </label>
          {value.checkPredicate === "textContains" && (
            <label>
              需要包含的文字
              <textarea
                aria-label={`${label}包含文字`}
                rows={2}
                value={value.checkText || ""}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...value, checkText: event.target.value })
                }
              />
            </label>
          )}
        </div>
      ) : (
        <p className="agent-note">
          {value.checkMode === "custom"
            ? "已有验收条件会保留。选择其他方式会替换这些条件。"
            : "本项执行结束后，由你确认完成标准已满足，再继续下一项。"}
        </p>
      )}
      <label>
        完成标准
        <textarea
          aria-label={`${label}完成标准`}
          value={value.acceptance}
          onChange={(event) =>
            onChange({ ...value, acceptance: event.target.value })
          }
          rows={2}
          maxLength={4000}
          disabled={disabled}
        />
      </label>
    </>
  );
}

function BatchResult({ run, busy, requestStop, stopRequested, onOpenBatch }) {
  const managed = run.queue?.managed;
  const stopped = managed
    ? run.queue.phase === "cancelled" && run.terminal && run.stopConfirmed
    : run.status === "cancelled";
  const stopping = stopRequested || run.status === "cancel_requested";
  const finished = managed
    ? ["completed", "cancelled"].includes(run.queue.phase)
    : run.terminal;
  const currentIndex = managed
    ? run.queue.currentIndex
    : run.batch?.currentIndex;
  const status =
    !stopped && stopping && (!run.terminal || managed)
      ? runText.cancel_requested
      : managed
        ? batchStatusLabel(run)
        : runText[run.status] || run.status;
  return (
    <div className="agent-execution-run">
      <div className="agent-card-heading">
        <strong role="status">{status}</strong>
        {onOpenBatch && (
          <button disabled={busy} onClick={onOpenBatch}>
            查看批次
          </button>
        )}
        <button
          disabled={
            busy || stopping || stopped || run.stopConfirmed || run.terminal
          }
          onClick={requestStop}
        >
          请求停止
        </button>
      </div>
      {run.threadId && (
        <a
          className="agent-codex-link"
          href={`codex://threads/${encodeURIComponent(run.threadId)}`}
        >
          在 Codex 中查看
        </a>
      )}
      {run.error && <p className="agent-error">{run.error}</p>}
      {!run.terminal && !stopped && (
        <p className="agent-note">
          批次按提交时的要求执行。此后编辑清单会保留在清单里，任务有变化时，完成结果会提示核对并保留原勾选状态。
        </p>
      )}
      {run.batch && (
        <section className="agent-batch-progress" aria-label="真实批次进度">
          <h5>
            {stopped || finished
              ? `共 ${run.batch.items.length} 项`
              : `当前第 ${currentIndex + 1} 项 · 共 ${run.batch.items.length} 项`}
          </h5>
          <ol>
            {run.batch.items.map((item, index) => (
              <li
                key={item.taskId}
                aria-current={
                  !finished && !stopped && index === currentIndex
                    ? "step"
                    : undefined
                }
              >
                <div className="agent-batch-item-heading">
                  <strong>{item.text}</strong>
                  <span>
                    {managed
                      ? batchItemLabel(run, item, index)
                      : itemText[
                          stopped && item.status !== "done"
                            ? "cancelled"
                            : item.status
                        ]}
                  </span>
                </div>
                {item.summary && <p>{item.summary}</p>}
                {item.writeback && (
                  <p>
                    {writebackText[item.writeback.status]}
                    {item.writeback.message && ` · ${item.writeback.message}`}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function BoundChecklist({
  roomId,
  userId,
  page,
  binding,
  project,
  callCloud,
  loadBinding,
  requestLocal,
  onOpenBatch,
  embedded,
  refreshToken,
}) {
  const [view, setView] = useState(null);
  const draftScope = JSON.stringify([
    userId,
    roomId,
    page.id,
    bindingKey(binding),
  ]);
  const [draft, setDraft] = useWorkspaceDraft(
    `${draftScope}:new-task`,
    emptyDraft,
    embedded,
  );
  const [editing, setEditing] = useWorkspaceDraft(
    `${draftScope}:edit-task`,
    null,
    embedded,
  );
  const [selected, setSelected] = useState(new Set());
  const [autoComplete, setAutoComplete] = useState(true);
  const [permissionProfile, setPermissionProfile] = usePermissionPreference(
    userId,
    binding,
  );
  const [run, setRun] = useState(null);
  const [runs, setRuns] = useState([]);
  const [stopRequested, setStopRequested] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const runId = useRef("");
  const pendingKey = `qingdan.agent-checklist-requests:${draftScope}`;
  const pending = useRef(null);
  if (!pending.current) {
    let entries = [];
    if (embedded) {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(pendingKey));
        if (Array.isArray(saved))
          entries = saved.filter(
            (entry) =>
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              typeof entry[1]?.requestId === "string",
          );
      } catch {
        /* Browser storage is optional. */
      }
    }
    pending.current = new Map(entries);
  }
  function savePending() {
    if (!embedded) return;
    try {
      window.sessionStorage.setItem(
        pendingKey,
        JSON.stringify([...pending.current]),
      );
    } catch {
      /* Keep the in-memory identity when storage is unavailable. */
    }
  }
  function forgetPending(key) {
    pending.current.delete(key);
    savePending();
  }
  const valid = useCallback(
    (version) => active.current && epoch.current === version,
    [],
  );
  const post = useCallback(
    (route, body) =>
      callCloud(`${executionApi}/${route}`, { method: "POST", body }),
    [callCloud],
  );
  const checklist = useCallback(
    (action, payload = {}) =>
      post("checklist", { bindingId: binding.bindingId, action, ...payload }),
    [binding.bindingId, post],
  );
  const tool = useCallback(
    async (name, args) =>
      (
        await post("tools", {
          bindingId: binding.bindingId,
          name,
          arguments: args,
        })
      ).result,
    [binding.bindingId, post],
  );
  const applyView = useCallback(
    (next) => {
      if (next.canvasId !== roomId || next.sectionId !== page.id)
        throw Error("清单关联已变化，请刷新后重试。");
      setView(next);
      const versions = new Set(next.tasks.filter(eligible).map(taskVersion));
      setSelected(
        (current) => new Set([...current].filter((key) => versions.has(key))),
      );
    },
    [roomId, page.id],
  );
  const readRun = useCallback(
    async (id, version) => {
      if (!id) return;
      const result = await tool("codex_get_run", { runId: id });
      if (valid(version) && runId.current === id) {
        setRun(result.run);
        setRuns((current) =>
          current.map((entry) => (entry.runId === id ? result.run : entry)),
        );
      }
    },
    [tool, valid],
  );
  const refresh = useCallback(
    async (version, history = false) => {
      const latestBinding = await loadBinding();
      if (!valid(version) || bindingKey(latestBinding) !== bindingKey(binding))
        return;
      const next = await checklist("list");
      if (!valid(version)) return;
      applyView(next);
      if (history) {
        const result = await callCloud(
          `${executionApi}/runs?bindingId=${encodeURIComponent(binding.bindingId)}`,
        );
        if (!valid(version)) return;
        const ids = new Set(next.tasks.map(({ taskId }) => taskId));
        const related = (result.runs || []).filter(
          (entry) =>
            entry.runId === runId.current ||
            entry.sourceBacked === true ||
            (entry.sourceBacked === undefined &&
              entry.batch?.items.some((item) => ids.has(item.taskId))),
        );
        setRuns(related);
        if (!runId.current) runId.current = related[0]?.runId || "";
      }
      await readRun(runId.current, version);
    },
    [loadBinding, valid, binding, checklist, applyView, callCloud, readRun],
  );

  useEffect(() => {
    active.current = true;
    const version = ++epoch.current;
    const handleError = (err, current) => {
      if (valid(current)) setError(err.message);
    };
    let polling = true;
    void refresh(version, true)
      .catch((err) => handleError(err, version))
      .finally(() => {
        polling = false;
      });
    const timer = setInterval(async () => {
      if (busyRef.current || polling) return;
      const current = epoch.current;
      polling = true;
      try {
        await refresh(current);
      } catch (err) {
        handleError(err, current);
      } finally {
        polling = false;
      }
    }, 2500);
    return () => {
      active.current = false;
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh, valid]);

  const refreshedToken = useRef(refreshToken);
  useEffect(() => {
    if (busy || refreshedToken.current === refreshToken) return;
    refreshedToken.current = refreshToken;
    const version = ++epoch.current;
    void refresh(version).catch((err) => {
      if (valid(version)) setError(err.message);
    });
  }, [refreshToken, busy, refresh, valid]);

  async function perform(operation, verifyBinding = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (verifyBinding) {
        const latest = await loadBinding();
        if (!valid(version) || bindingKey(latest) !== bindingKey(binding))
          return;
      }
      await operation(version);
    } catch (err) {
      if (valid(version)) setError(err.message);
    } finally {
      busyRef.current = false;
      if (valid(version)) setBusy(false);
    }
  }
  function requestKey(action, payload) {
    const key = JSON.stringify([action, payload]);
    if (!pending.current.has(key)) {
      if (pending.current.size >= 100)
        throw Error("待核对的操作较多，请先刷新清单。");
      pending.current.set(key, { requestId: crypto.randomUUID(), input: null });
      savePending();
    }
    return [key, pending.current.get(key)];
  }
  async function mutate(action, payload, version) {
    const [key, { requestId }] = requestKey(action, payload);
    const next = await checklist(action, { requestId, ...payload });
    if (!valid(version)) return false;
    forgetPending(key);
    applyView(next);
    return true;
  }
  const tasks = view?.tasks || [];
  const unfinished = tasks.filter((task) => !task.done);
  const canReorder =
    !view?.truncated && !unfinished.some((task) => task.locked);
  const picked = unfinished.filter(
    (task) => eligible(task) && selected.has(taskVersion(task)),
  );
  const editingTask =
    editing &&
    tasks.find(
      (task) =>
        task.noteId === editing.task.noteId &&
        task.taskId === editing.task.taskId,
    );

  function move(index, offset) {
    const next = index + offset;
    if (next < 0 || next >= unfinished.length || !canReorder) return;
    const ordered = [...unfinished];
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    return perform((version) =>
      mutate(
        "reorder",
        { expectedSequence: view.sequence, order: ordered.map(taskRef) },
        version,
      ),
    );
  }
  function toggle(task) {
    if (!eligible(task)) return;
    const key = taskVersion(task);
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(key) && next.size < MAX_PLAN_TASKS) next.add(key);
      return next;
    });
  }
  async function saveNew(version) {
    const item = trimDraft(draft);
    if (!item.text) return;
    if (await mutate("create", { tasks: [item] }, version)) {
      setDraft(emptyDraft);
      setMessage("待办已保存。");
    }
  }
  async function saveExisting(version) {
    if (!editingTask || editingTask.locked || editingTask.done) return;
    const { task, value } = editing;
    const { text, instruction, acceptance, acceptanceChecks } =
      trimDraft(value);
    if (task.editableText && !text) return;
    if (
      await mutate(
        "save",
        {
          ...taskRef(task),
          expectedGeneration: task.generation,
          expectedSpecRevision: task.specRevision,
          ...(task.editableText && text !== task.text ? { text } : {}),
          instruction,
          acceptance,
          ...(acceptanceChecks !== undefined ? { acceptanceChecks } : {}),
        },
        version,
      )
    ) {
      setEditing(null);
      setMessage("待办已保存。");
    }
  }
  async function dispatch(version) {
    if (!picked.length) return;
    const target = {
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      kind: "task",
      sourceTasks: picked.map(
        ({ noteId, taskId, generation, specRevision }) => ({
          noteId,
          taskId,
          generation,
          specRevision,
        }),
      ),
      autoComplete,
      executionPermissions: { profile: permissionProfile },
    };
    const [key, receipt] = requestKey("dispatch", target);
    if (!receipt.input) {
      try {
        const local = await requestLocal("/status", {
          accountId: userId,
        }).catch(() => null);
        if (!valid(version)) return;
        if (
          local?.runnerId === binding.runnerId &&
          local.connectionStatus === "online"
        ) {
          await requestLocal("/execution/context", {
            method: "POST",
            accountId: userId,
            body: { workspaceId: binding.workspaceId },
          });
        }
        if (!valid(version)) return;
        const { input } = await post("intents", {
          requestId: receipt.requestId,
          ...target,
        });
        if (
          input?.bindingId !== binding.bindingId ||
          input.bindingRevision !== binding.revision ||
          input.kind !== "task"
        )
          throw Error("项目关联已变化，请刷新后重新提交。");
        receipt.input = input;
        savePending();
      } catch (err) {
        forgetPending(key);
        throw err;
      }
    }
    if (!valid(version)) return;
    const result = await tool("codex_create_run", receipt.input);
    if (!valid(version)) return;
    forgetPending(key);
    runId.current = result.runId;
    setRun(null);
    setSelected(new Set());
    setMessage("批次已提交。执行结果会在下方更新。");
    await refresh(version, true);
    if (valid(version))
      onOpenBatch?.({
        sectionId: page.id,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        runId: result.runId,
      });
  }
  async function stop(version) {
    const id = run.runId;
    const [key, { requestId }] = requestKey("stop", id);
    await tool("codex_cancel_run", { runId: id, requestId });
    if (!valid(version)) return;
    forgetPending(key);
    setStopRequested(id);
    await refresh(version);
  }
  async function chooseRun(id, version) {
    runId.current = id;
    setRun(null);
    await readRun(id, version);
  }
  const editor = editing && (
    <div className="agent-checklist-editor">
      {!editingTask ? (
        <p className="agent-note">
          此待办已移出清单。你仍可复制未保存的编辑内容。
        </p>
      ) : !editing.task.editableText ? (
        <p className="agent-note">可在画布中编辑此待办的正文。</p>
      ) : null}
      <DraftFields
        label="编辑"
        value={editing.value}
        disabled={busy}
        editableText={editing.task.editableText}
        onChange={(value) => setEditing({ ...editing, value })}
      />
      <div className="agent-actions">
        <button
          disabled={
            busy ||
            !editingTask ||
            editingTask.done ||
            editingTask.locked ||
            (editing.task.editableText && !editing.value.text.trim())
          }
          onClick={() => perform(saveExisting)}
        >
          保存待办
        </button>
        <button disabled={busy} onClick={() => setEditing(null)}>
          取消编辑
        </button>
      </div>
    </div>
  );
  const NewTaskContainer = embedded ? "details" : "section";

  return (
    <>
      <div className="agent-card-heading">
        <p title={`执行项目：${project?.name || "已绑定项目"}`}>
          {!embedded && "执行项目 · "}
          <strong>{project?.name || "已绑定项目"}</strong>
        </p>
        <button
          aria-label="刷新清单"
          title="刷新清单"
          disabled={busy}
          onClick={() => perform((version) => refresh(version, true), false)}
        >
          {embedded ? <RefreshCw size={15} /> : "刷新清单"}
        </button>
      </div>
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="agent-success" role="status">
          {message}
        </p>
      )}
      {!view ? (
        <p className="agent-note">正在读取待办…</p>
      ) : (
        <>
          {view.truncated && (
            <p className="agent-note">
              当前显示部分待办。请在画布中调整完整顺序。
            </p>
          )}
          {tasks.length === 0 && (
            <p className="agent-note">清单里还没有待办。</p>
          )}
          <ol className="agent-checklist-tasks" aria-label="真实待办">
            {tasks.map((task) => {
              const index = unfinished.indexOf(task);
              const checked = selected.has(taskVersion(task));
              return (
                <li key={task.taskId} data-completed={task.done || undefined}>
                  <div className="agent-checklist-row">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`${task.done ? "已完成" : "选中"}待办：${task.text}`}
                        checked={task.done || checked}
                        disabled={
                          busy ||
                          !eligible(task) ||
                          (!checked && picked.length >= MAX_PLAN_TASKS)
                        }
                        onChange={() => toggle(task)}
                      />
                      <span>{task.text}</span>
                    </label>
                    {(!embedded ||
                      task.done ||
                      task.locked ||
                      task.specStatus !== "ready") && (
                      <span className="agent-note">
                        {task.done
                          ? "已完成"
                          : task.locked
                            ? "已锁定"
                            : specText[task.specStatus]}
                      </span>
                    )}
                  </div>
                  {!task.done && (
                    <div className="agent-actions agent-task-actions">
                      <button
                        aria-label={`编辑待办：${task.text}`}
                        title="编辑待办"
                        disabled={busy || !!editing || task.locked}
                        onClick={() =>
                          setEditing({
                            task,
                            value: draftFromTask(task),
                          })
                        }
                      >
                        {embedded ? <Pencil size={14} /> : "编辑待办"}
                      </button>
                      <button
                        aria-label={`上移待办：${task.text}`}
                        title="上移"
                        disabled={
                          busy || !!editing || !canReorder || index <= 0
                        }
                        onClick={() => move(index, -1)}
                      >
                        {embedded ? <ArrowUp size={14} /> : "上移"}
                      </button>
                      <button
                        aria-label={`下移待办：${task.text}`}
                        title="下移"
                        disabled={
                          busy ||
                          !!editing ||
                          !canReorder ||
                          index >= unfinished.length - 1
                        }
                        onClick={() => move(index, 1)}
                      >
                        {embedded ? <ArrowDown size={14} /> : "下移"}
                      </button>
                    </div>
                  )}
                  {editingTask === task && editor}
                </li>
              );
            })}
          </ol>
          {!editingTask && editor}
          {(!embedded || unfinished.length > 0) && (
            <div className="agent-checklist-dispatch">
              <details
                className="agent-dispatch-options"
                open={embedded ? undefined : true}
              >
                <summary>执行设置</summary>
                <PermissionButton
                  value={permissionProfile}
                  onChange={setPermissionProfile}
                  disabled={busy}
                />
                <label className="agent-checklist-option">
                  <input
                    type="checkbox"
                    aria-label="自动勾选完成"
                    checked={autoComplete}
                    disabled={busy}
                    onChange={(event) => setAutoComplete(event.target.checked)}
                  />
                  <span title="验收通过且待办内容未变化时，自动更新完成状态">
                    验收后自动勾选完成
                  </span>
                </label>
              </details>
              <div className="agent-actions">
                <button
                  className="primary"
                  disabled={busy || !!editing || picked.length === 0}
                  onClick={() => perform(dispatch)}
                >
                  提交所选待办
                </button>
                <span className="agent-note">
                  已选 {picked.length} 项
                  {!embedded && "，按清单顺序在同一个会话执行"}
                </span>
              </div>
            </div>
          )}
          <NewTaskContainer
            className="agent-checklist-editor"
            aria-label="新增真实待办"
          >
            {embedded ? <summary>手动添加待办</summary> : <h4>新增待办</h4>}
            <DraftFields
              label="新待办"
              value={draft}
              onChange={setDraft}
              disabled={busy}
            />
            <div className="agent-actions">
              <button
                disabled={busy || !draft.text.trim()}
                onClick={() => perform(saveNew)}
              >
                保存新待办
              </button>
              {!embedded && (
                <button
                  disabled={
                    busy ||
                    !!(draft.text || draft.instruction || draft.acceptance)
                  }
                  onClick={() =>
                    setDraft({
                      text: "检查项目中的 README",
                      instruction:
                        "只读查看项目根目录，说明是否存在 README 文件。",
                      acceptance:
                        "报告 README 文件名，或明确说明项目根目录中没有 README。",
                    })
                  }
                >
                  添加测试待办草稿
                </button>
              )}
            </div>
          </NewTaskContainer>
        </>
      )}
      {!embedded && (runs.length > 0 || run) && (
        <section
          className="agent-checklist-editor"
          aria-label="真实清单派单记录"
        >
          <h4>派单记录</h4>
          {runs.length > 1 && (
            <label>
              查看批次
              <select
                aria-label="查看真实清单批次"
                value={runId.current}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  void perform((version) => chooseRun(id, version));
                }}
              >
                {runs.map((entry) => (
                  <option key={entry.runId} value={entry.runId}>
                    {entry.batch?.items[0]?.text || "执行批次"} ·{" "}
                    {runText[entry.status] || entry.status}
                  </option>
                ))}
              </select>
            </label>
          )}
          {run && (
            <BatchResult
              run={run}
              busy={busy}
              requestStop={() => perform(stop)}
              stopRequested={stopRequested === run.runId}
              onOpenBatch={
                onOpenBatch
                  ? () =>
                      onOpenBatch({
                        sectionId: page.id,
                        bindingId: binding.bindingId,
                        bindingRevision: binding.revision,
                        runId: run.runId,
                      })
                  : undefined
              }
            />
          )}
        </section>
      )}
    </>
  );
}

function ChecklistSection({
  roomId,
  userId,
  page,
  requestCloud,
  requestLocal,
  onOpenBatch,
  embedded,
  refreshToken,
  onOpenSettings,
}) {
  const [binding, setBinding] = useState(undefined);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const active = useRef(false);
  const revision = useRef(0);
  const callCloud = useCallback(
    (route, options) =>
      requestCloud(route, {
        ...options,
        accountId: userId,
        isCurrentSession: () => active.current,
      }),
    [requestCloud, userId],
  );
  const loadBinding = useCallback(async () => {
    const version = ++revision.current;
    const result = await callCloud(
      `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(page.id)}`,
    );
    if (!active.current || version !== revision.current) return null;
    const next = result.binding?.enabled ? result.binding : null;
    setBinding((prior) =>
      bindingKey(prior) === bindingKey(next) ? prior : next,
    );
    return next;
  }, [callCloud, roomId, page.id]);
  useEffect(() => {
    active.current = true;
    void loadBinding().catch((err) => {
      if (active.current) setError(err.message);
    });
    void callCloud("/api/agent/devices")
      .then((result) => {
        if (active.current) setDevices(result.devices || []);
      })
      .catch(() => {});
    return () => {
      active.current = false;
      revision.current++;
    };
  }, [loadBinding, callCloud]);
  if (!binding) {
    return (
      <>
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        {!error && (
          <p className="agent-note">
            {binding === undefined
              ? "正在读取项目关联…"
              : embedded
                ? "选择 Codex 会话后，自动关联项目并开始整理待办。"
                : "此清单尚未关联执行项目。请先在第 3 步绑定电脑和项目。"}
          </p>
        )}
        {embedded && binding === null && onOpenSettings && (
          <button onClick={onOpenSettings}>选择 Codex 会话</button>
        )}
        {binding !== undefined || error ? (
          <button
            onClick={() => {
              setError("");
              void loadBinding().catch((err) => {
                if (active.current) setError(err.message);
              });
            }}
          >
            刷新项目关联
          </button>
        ) : null}
      </>
    );
  }
  const project = devices
    .find((device) => device.runnerId === binding.runnerId)
    ?.workspaces?.find(
      (workspace) => workspace.workspaceId === binding.workspaceId,
    );
  return (
    <BoundChecklist
      key={bindingKey(binding)}
      {...{
        roomId,
        userId,
        page,
        binding,
        project,
        callCloud,
        loadBinding,
        requestLocal,
        onOpenBatch,
        embedded,
        refreshToken,
      }}
    />
  );
}

export default function ChecklistPanel({
  roomId,
  userId,
  pages = [],
  requestCloud = api,
  requestLocal = localRunnerRequest,
  onOpenBatch,
  embedded = false,
  refreshToken,
  onOpenSettings,
}) {
  const [sectionId, setSectionId] = useState("");
  const page = pages.find((item) => item.id === sectionId) || pages[0];
  return (
    <div
      className={`agent-trial agent-execution-panel agent-checklist-panel${embedded ? " is-embedded" : ""}`}
    >
      {!embedded && (
        <div className="agent-intro">
          <h3>执行真实清单</h3>
          <p>从清单选择待办。每次提交新建一个 Codex 会话，按清单顺序执行。</p>
        </div>
      )}
      <section className="agent-device-card" aria-label="真实清单">
        {page ? (
          <>
            {!embedded && (
              <label>
                选择真实清单
                <select
                  aria-label="选择真实清单"
                  value={page.id}
                  onChange={(event) => setSectionId(event.target.value)}
                >
                  {pages.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title || "未命名清单"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ChecklistSection
              key={JSON.stringify([userId, roomId, page.id])}
              {...{
                roomId,
                userId,
                page,
                requestCloud,
                requestLocal,
                onOpenBatch,
                embedded,
                refreshToken,
                onOpenSettings,
              }}
            />
          </>
        ) : (
          <p className="agent-note">此画布还没有清单。</p>
        )}
      </section>
    </div>
  );
}
