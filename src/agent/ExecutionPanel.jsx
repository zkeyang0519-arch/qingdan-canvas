import React, { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PLAN_TASKS } from "../../shared/agent/sort-plan.ts";
import { api } from "../api.js";
import { localRunnerRequest } from "./DevicePanel.jsx";

const trialSection = "agent-execution-trial";
// Uncertain submissions survive panel/selection changes within this page.
const pendingCreates = new Map();
const statusText = {
  queued: "已排队，等待电脑接单",
  preparing: "正在准备",
  running: "正在执行",
  waiting_input: "需要补充信息",
  waiting_approval: "需要审批",
  verifying: "本轮结束，待你验收",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已确认停止",
  cancel_requested: "正在请求停止",
  reconciliation_required: "需要核对本机进度",
};
const batchItemStatusText = {
  pending: "待执行",
  running: "执行中",
  done: "执行完毕",
  blocked: "已暂停",
  needs_input: "需要补充说明",
  failed: "执行失败",
  cancelled: "已停止",
};
const batchFinished = (run) =>
  run?.terminal &&
  run.status !== "cancelled" &&
  run.batch?.items.every((item) => item.status === "done");
const batchPaused = (run) =>
  run?.terminal &&
  run.stopConfirmed &&
  run.status !== "cancelled" &&
  ["blocked", "needs_input", "failed"].includes(
    run.batch?.items[run.batch.currentIndex]?.status,
  );
const runStatus = (run) =>
  run.batch && run.status === "cancelled"
    ? "批次已停止"
    : batchFinished(run)
      ? "批次执行完毕，待你验收"
      : batchPaused(run)
        ? "批次已暂停，等待补充说明"
        : statusText[run.status] || run.status;
const clock = (time) =>
  time ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "";

export default function ExecutionPanel({
  roomId,
  userId,
  pages = [],
  requestCloud = api,
  requestLocal = localRunnerRequest,
}) {
  const [sectionId, setSectionId] = useState(pages[0]?.id || trialSection);
  const [binding, setBinding] = useState(null);
  const [device, setDevice] = useState(null);
  const [project, setProject] = useState(null);
  const [local, setLocal] = useState(null);
  const [projectOptions, setProjectOptions] = useState({
    accountId: userId,
    items: [],
  });
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [drafts, setDrafts] = useState([
    { id: 0, instruction: "", acceptance: "" },
  ]);
  const [followup, setFollowup] = useState("");
  const [projectName, setProjectName] = useState("轻单测试项目");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false),
    busyRef = useRef(false),
    epoch = useRef(0);
  const nextDraftId = useRef(1);
  const selected = useRef(""),
    details = useRef(null),
    activeBinding = useRef(null);
  const followPending = useRef(null),
    stopPending = useRef(null);
  const namedProjects =
    projectOptions.accountId === userId ? projectOptions.items : [];
  const sectionValid =
    sectionId === trialSection ||
    pages.some((page) => page.id === sectionId) ||
    namedProjects.some((item) => item.sectionId === sectionId);
  const items = drafts.map(({ instruction, acceptance }) => ({
    instruction: instruction.trim(),
    acceptance: acceptance.trim(),
  }));
  const incompleteDraft = items.some(
    (item) => !item.instruction || !item.acceptance,
  );
  const valid = (version) => mounted.current && version === epoch.current;

  const callTool = useCallback(
    async (bindingId, name, args) => {
      const response = await requestCloud("/api/agent/execution/tools", {
        method: "POST",
        accountId: userId,
        body: { bindingId, name, arguments: args },
      });
      return response.result;
    },
    [requestCloud, userId],
  );

  const selectRun = useCallback((id) => {
    selected.current = id;
    details.current = null;
    setSelectedId(id);
    setDetail(null);
    setFollowup("");
    followPending.current = null;
  }, []);

  const readRun = useCallback(
    async (id, version, bindingId) => {
      if (!id || !bindingId) return;
      let prior = details.current?.run?.runId === id ? details.current : null;
      let result;
      for (let page = 0; page < 5; page++) {
        result = await callTool(bindingId, "codex_get_run", {
          runId: id,
          afterSeq: prior?.nextAfterSeq || 0,
        });
        if (!valid(version) || selected.current !== id) return;
        const all = [...(prior?.events || []), ...(result.events || [])];
        const unique = [
          ...new Map(all.map((event) => [event.eventId, event])).values(),
        ];
        prior = {
          ...result,
          events: unique.slice(-300),
          truncated:
            result.truncated || prior?.truncated || unique.length > 300,
        };
        if (!result.hasMore) break;
      }
      details.current = prior;
      setDetail(prior);
      setRuns((current) =>
        current.map((run) => (run.runId === id ? prior.run : run)),
      );
    },
    [callTool],
  );

  const refresh = useCallback(
    async (version) => {
      const [cloud, bindingResult, localResult] = await Promise.allSettled([
        requestCloud("/api/agent/devices", { accountId: userId }),
        requestCloud(
          `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(sectionId)}`,
          { accountId: userId },
        ),
        requestLocal("/status", { accountId: userId }),
      ]);
      if (!valid(version)) return;
      if (cloud.status === "rejected") throw cloud.reason;
      if (bindingResult.status === "rejected") throw bindingResult.reason;
      const nextBinding = bindingResult.value.binding?.enabled
        ? bindingResult.value.binding
        : null;
      const previousBinding = activeBinding.current;
      if (
        previousBinding &&
        (previousBinding.bindingId !== nextBinding?.bindingId ||
          previousBinding.revision !== nextBinding?.revision)
      ) {
        selectRun("");
      }
      activeBinding.current = nextBinding;
      setBinding(nextBinding);
      setLocal(localResult.status === "fulfilled" ? localResult.value : null);
      if (localResult.status === "fulfilled")
        setProjectOptions({
          accountId: userId,
          items: localResult.value.executionProjects || [],
        });
      const currentDevice = cloud.value.devices?.find(
        (item) => item.runnerId === nextBinding?.runnerId,
      );
      setDevice(currentDevice || null);
      setProject(
        currentDevice?.workspaces?.find(
          (item) => item.workspaceId === nextBinding?.workspaceId,
        ) || null,
      );
      if (nextBinding) {
        const [history] = await Promise.all([
          requestCloud(
            `/api/agent/execution/runs?bindingId=${encodeURIComponent(nextBinding.bindingId)}`,
            { accountId: userId },
          ),
          callTool(nextBinding.bindingId, "codex_list_projects", {
            runnerId: nextBinding.runnerId,
          }),
        ]);
        if (!valid(version)) return;
        setRuns(history.runs || []);
        const id = selected.current || history.runs?.[0]?.runId || "";
        if (id !== selected.current) selectRun(id);
        if (id) await readRun(id, version, nextBinding.bindingId);
      } else {
        setRuns([]);
        selectRun("");
      }
      if (valid(version)) setLoaded(true);
    },
    [
      roomId,
      userId,
      sectionId,
      requestCloud,
      requestLocal,
      callTool,
      readRun,
      selectRun,
    ],
  );

  useEffect(() => {
    mounted.current = true;
    const version = ++epoch.current;
    activeBinding.current = null;
    setBinding(null);
    setDevice(null);
    setProject(null);
    setLoaded(false);
    selectRun("");
    setRuns([]);
    setError("");
    void refresh(version).catch((err) => {
      if (valid(version)) {
        setError(err.message);
        setLoaded(true);
      }
    });
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [refresh, selectRun]);

  useEffect(() => {
    if (sectionValid) return;
    epoch.current++;
    activeBinding.current = null;
    setBinding(null);
    setProject(null);
    setLoaded(false);
    selectRun("");
    setSectionId(pages[0]?.id || trialSection);
  }, [sectionValid, pages, selectRun]);

  useEffect(() => {
    let polling = false;
    const timer = setInterval(async () => {
      if (
        busyRef.current ||
        polling ||
        !selected.current ||
        !activeBinding.current
      )
        return;
      polling = true;
      const version = epoch.current;
      try {
        await readRun(
          selected.current,
          version,
          activeBinding.current.bindingId,
        );
      } catch (err) {
        if (valid(version)) setError(err.message);
      } finally {
        polling = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [readRun]);

  const localPost = (route, body = {}) =>
    requestLocal(route, { method: "POST", body, accountId: userId });
  const cloudPost = (route, body) =>
    requestCloud(route, { method: "POST", body, accountId: userId });
  async function perform(operation) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const version = ++epoch.current;
    try {
      await operation(version);
    } catch (err) {
      if (valid(version)) setError(err.message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function prepareTrial(version) {
    const trial = await localPost("/execution/trial", {
      projectName: projectName.trim(),
    });
    const workspaceId = trial.workspace?.workspaceId;
    const targetSection = `agent-execution-project-${workspaceId}`;
    if (
      typeof workspaceId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,76}$/.test(workspaceId) ||
      trial.sectionId !== targetSection
    )
      throw Error("项目创建结果不匹配，请刷新后重试。");
    const route = `/api/agent/bindings?canvasId=${encodeURIComponent(roomId)}&sectionId=${encodeURIComponent(targetSection)}`;
    const previous = (await requestCloud(route, { accountId: userId })).binding;
    if (
      !previous?.enabled ||
      previous.runnerId !== trial.runnerId ||
      previous.workspaceId !== trial.workspace.workspaceId
    ) {
      await cloudPost("/api/agent/bindings", {
        canvasId: roomId,
        sectionId: targetSection,
        runnerId: trial.runnerId,
        workspaceId: trial.workspace.workspaceId,
        expectedRevision: previous?.revision ?? null,
      });
    }
    const nextLocal = await requestLocal("/status", { accountId: userId });
    if (!valid(version)) return;
    if (
      !nextLocal.executionProjects?.some(
        (item) =>
          item.workspaceId === workspaceId && item.sectionId === targetSection,
      )
    )
      throw Error("本机项目列表已变化，请刷新后选择项目。");
    setLocal(nextLocal);
    setProjectOptions({
      accountId: userId,
      items: nextLocal.executionProjects,
    });
    setDrafts((current) =>
      current.length === 1 && !current[0].instruction && !current[0].acceptance
        ? [
            {
              ...current[0],
              instruction:
                "在当前测试项目中创建 hello.txt，内容为：你好，轻单 MCP！只修改这个文件。",
              acceptance: "hello.txt 存在，内容为：你好，轻单 MCP！",
            },
          ]
        : current,
    );
    setMessage(`项目“${trial.workspace.name}”已准备，可以编辑并提交待办。`);
    if (sectionId === targetSection) await refresh(version);
    else setSectionId(targetSection);
  }
  function addDraft() {
    const id = nextDraftId.current++;
    setDrafts((current) =>
      current.length < MAX_PLAN_TASKS
        ? [...current, { id, instruction: "", acceptance: "" }]
        : current,
    );
  }
  function editDraft(id, field, value) {
    setDrafts((current) =>
      current.map((item) =>
        item.id === id ? { ...item, [field]: value } : item,
      ),
    );
  }
  function moveDraft(index, offset) {
    setDrafts((current) => {
      const next = index + offset;
      if (next < 0 || next >= current.length) return current;
      const updated = [...current];
      [updated[index], updated[next]] = [updated[next], updated[index]];
      return updated;
    });
  }
  async function submit(kind, version) {
    if (!binding || !sectionValid || !loaded) return;
    if (kind === "task" && incompleteDraft)
      throw Error("请填写每项待办的执行要求和完成标准。");
    const target = {
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      kind,
      ...(kind === "task" ? { items } : {}),
    };
    const key = JSON.stringify([userId, roomId, target]);
    if (!pendingCreates.has(key)) {
      if (pendingCreates.size >= 100)
        throw Error("待核对的提交较多，请先查看派单记录。");
      pendingCreates.set(key, { requestId: crypto.randomUUID(), input: null });
    }
    const pending = pendingCreates.get(key);
    if (!pending.input) {
      try {
        if (
          local?.runnerId === binding.runnerId &&
          local.connectionStatus === "online"
        ) {
          await localPost("/execution/context", {
            workspaceId: binding.workspaceId,
          });
        }
        const intent = await cloudPost("/api/agent/execution/intents", {
          requestId: pending.requestId,
          ...target,
        });
        if (
          intent.input?.bindingId !== target.bindingId ||
          intent.input?.bindingRevision !== target.bindingRevision ||
          intent.input?.kind !== kind
        ) {
          pendingCreates.delete(key);
          throw Error("项目关联已变化，请刷新后重新提交。");
        }
        pending.input = intent.input;
      } catch (err) {
        // No create call has happened, so this failure cannot have started a run.
        pendingCreates.delete(key);
        throw err;
      }
    }
    const receipt = await callTool(
      binding.bindingId,
      "codex_create_run",
      pending.input,
    );
    pendingCreates.delete(key);
    if (!valid(version)) return;
    selectRun(receipt.runId);
    setMessage(
      kind === "task"
        ? "批次已提交。下方会显示每项待办的执行进度。"
        : "派单已保存。下方会持续显示本机执行进度。",
    );
    await refresh(version);
  }
  async function sendFollowup(version) {
    const run = detail?.run;
    if (!run?.turnId) return;
    const mode = run.terminal ? "reply" : "steer";
    const key = JSON.stringify([run.runId, followup.trim()]);
    if (followPending.current?.key !== key)
      followPending.current = {
        key,
        input: {
          requestId: crypto.randomUUID(),
          runId: run.runId,
          expectedTurnId: run.turnId,
          message: followup.trim(),
          mode,
        },
      };
    try {
      await callTool(
        binding.bindingId,
        "codex_continue_run",
        followPending.current.input,
      );
    } catch (err) {
      if (err.status === 409) {
        followPending.current = null;
        await readRun(run.runId, version, binding.bindingId).catch(() => {});
      }
      throw err;
    }
    if (!valid(version)) return;
    followPending.current = null;
    setFollowup("");
    setMessage("补充说明已保存，将交给原来的 Codex 会话。");
    await readRun(run.runId, version, binding.bindingId);
  }
  async function stop(version) {
    const run = detail?.run;
    if (!run) return;
    const key = JSON.stringify([run.runId, run.turnId]);
    if (stopPending.current?.key !== key)
      stopPending.current = {
        key,
        input: { runId: run.runId, requestId: crypto.randomUUID() },
      };
    await callTool(
      binding.bindingId,
      "codex_cancel_run",
      stopPending.current.input,
    );
    if (!valid(version)) return;
    setMessage("停止请求已保存。");
    await readRun(run.runId, version, binding.bindingId);
  }

  const run = detail?.run;
  const batch = run?.batch;
  const finished = batchFinished(run);
  const paused = batchPaused(run);
  const cancelled = batch && run.status === "cancelled";
  const showCurrent = !finished && !cancelled;
  const completion = detail?.events?.findLast(
    (event) => event.type === "turn.completed",
  );
  const output = (detail?.events || [])
    .filter((event) => event.type === "output.delta")
    .map((event) => event.payload.text)
    .join("")
    .slice(-150000);
  const resultSummary =
    completion?.payload?.outcome?.summary ||
    completion?.payload?.summary?.overview;
  const canFollow =
    run?.turnId &&
    !finished &&
    ![
      "queued",
      "preparing",
      "cancel_requested",
      "cancelled",
      "reconciliation_required",
      "waiting_approval",
    ].includes(run.status) &&
    (!run.terminal || run.stopConfirmed) &&
    (run.status !== "waiting_input" || run.terminal);
  return (
    <div className="agent-trial agent-execution-panel">
      <div className="agent-intro">
        <h3>把任务交给本机 Codex</h3>
        <p>
          每次提交新建一个 Codex
          会话。批次里的待办在同一会话中按顺序执行，可以在这里查看进度、补充说明或请求停止。
        </p>
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
      <section className="agent-device-card" aria-label="执行项目">
        <div className="agent-card-heading">
          <strong>选择执行项目</strong>
          <button
            disabled={busy}
            onClick={() => perform((version) => refresh(version))}
          >
            刷新状态
          </button>
        </div>
        <label>
          清单关联
          <select
            aria-label="清单关联"
            disabled={busy}
            value={sectionId}
            onChange={(event) => {
              epoch.current++;
              setSectionId(event.target.value);
            }}
          >
            {pages
              .filter((page) => page.id !== trialSection)
              .map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title || "未命名清单"}
                </option>
              ))}
            <option value={trialSection}>独立测试项目</option>
            {namedProjects.map((item) => (
              <option key={item.sectionId} value={item.sectionId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {!loaded ? (
          <p className="agent-note">正在读取绑定和派单记录…</p>
        ) : binding ? (
          <>
            <p className="agent-project-name">
              {project?.name || "已授权项目"}{" "}
              <span className="agent-note">
                · {device?.deviceName || "已绑定电脑"} ·{" "}
                {device?.status === "online" ? "在线" : "离线，任务将等待接单"}
              </span>
            </p>
            {project?.displayPath && (
              <details>
                <summary>查看本机目录</summary>
                <p className="agent-path">{project.displayPath}</p>
              </details>
            )}
          </>
        ) : (
          <p className="agent-note">
            这个清单还没有关联项目。可在第 3 步关联，或准备下方的独立测试项目。
          </p>
        )}
        <label>
          新建项目名称
          <input
            aria-label="项目名称"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            maxLength={60}
            placeholder="例如：个人网站"
            disabled={busy}
          />
        </label>
        <div className="agent-actions">
          <button
            disabled={busy || !projectName.trim()}
            onClick={() => perform(prepareTrial)}
          >
            创建项目
          </button>
          <span className="agent-note">
            创建项目会准备同名文件夹。提交批次或项目总结后会新建 Codex
            会话。同名项目保留已有结果。
          </span>
        </div>
      </section>
      <section className="agent-device-card" aria-label="提交批次">
        <div className="agent-card-heading">
          <h4>编排待办</h4>
          <button
            disabled={busy || drafts.length >= MAX_PLAN_TASKS}
            onClick={addDraft}
          >
            添加待办
          </button>
        </div>
        {drafts.map((item, index) => (
          <fieldset key={item.id} className="agent-batch-draft">
            <legend>第 {index + 1} 项待办</legend>
            <label>
              执行要求
              <textarea
                aria-label={
                  index === 0 ? "执行要求" : `第 ${index + 1} 项执行要求`
                }
                value={item.instruction}
                onChange={(event) =>
                  editDraft(item.id, "instruction", event.target.value)
                }
                placeholder="描述希望 Codex 在这个项目里完成的工作"
                rows={3}
                maxLength={32000}
                disabled={busy}
              />
            </label>
            <label>
              完成标准
              <textarea
                aria-label={
                  index === 0 ? "完成标准" : `第 ${index + 1} 项完成标准`
                }
                value={item.acceptance}
                onChange={(event) =>
                  editDraft(item.id, "acceptance", event.target.value)
                }
                placeholder="写明你验收时要看到的结果"
                rows={2}
                maxLength={4000}
                disabled={busy}
              />
            </label>
            {drafts.length > 1 && (
              <div className="agent-actions">
                <button
                  aria-label={`上移第 ${index + 1} 项`}
                  disabled={busy || index === 0}
                  onClick={() => moveDraft(index, -1)}
                >
                  上移
                </button>
                <button
                  aria-label={`下移第 ${index + 1} 项`}
                  disabled={busy || index === drafts.length - 1}
                  onClick={() => moveDraft(index, 1)}
                >
                  下移
                </button>
                <button
                  aria-label={`删除第 ${index + 1} 项`}
                  disabled={busy}
                  onClick={() =>
                    setDrafts((current) =>
                      current.filter((draft) => draft.id !== item.id),
                    )
                  }
                >
                  删除
                </button>
              </div>
            )}
          </fieldset>
        ))}
        <div className="agent-actions">
          <button
            className="primary"
            disabled={
              busy || !binding || incompleteDraft || !sectionValid || !loaded
            }
            onClick={() => perform((version) => submit("task", version))}
          >
            提交批次
          </button>
          <button
            disabled={busy || !binding || !sectionValid || !loaded}
            onClick={() => perform((version) => submit("summary", version))}
          >
            只总结项目
          </button>
        </div>
        <p className="agent-note">
          执行结束后由你检查结果。这里的执行进度仅用于本次派单。
        </p>
      </section>
      <section className="agent-device-card" aria-label="派单记录">
        <h4>派单记录</h4>
        {!runs.length && !run ? (
          <p className="agent-note">还没有派单记录。先提交一个测试任务。</p>
        ) : (
          <>
            <label>
              查看任务
              <select
                aria-label="查看任务"
                value={selectedId}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  selectRun(id);
                  void perform((version) =>
                    readRun(id, version, binding?.bindingId),
                  );
                }}
              >
                {runs.map((item) => (
                  <option value={item.runId} key={item.runId}>
                    {item.kind === "summary"
                      ? "项目总结"
                      : item.batch
                        ? "执行批次"
                        : "执行任务"}{" "}
                    · {clock(item.createdAt)} · {runStatus(item)}
                  </option>
                ))}
              </select>
            </label>
            {run && (
              <div className="agent-execution-run">
                <div className="agent-card-heading">
                  <strong role="status">{runStatus(run)}</strong>
                  <button
                    disabled={
                      busy ||
                      cancelled ||
                      run.stopConfirmed ||
                      run.status === "cancel_requested"
                    }
                    onClick={() => perform(stop)}
                  >
                    请求停止
                  </button>
                </div>
                {run.threadId && (
                  <>
                    <div className="agent-actions">
                      <a
                        className="agent-codex-link"
                        href={`codex://threads/${encodeURIComponent(run.threadId)}`}
                      >
                        在 Codex 中查看
                      </a>
                      <span className="agent-note">
                        补充说明、继续和停止仍在轻单操作。
                      </span>
                    </div>
                    <p className="agent-path">Codex 会话：{run.threadId}</p>
                  </>
                )}
                {batch && (
                  <section
                    className="agent-batch-progress"
                    aria-label="批次进度"
                  >
                    <h5>
                      {showCurrent
                        ? `当前第 ${batch.currentIndex + 1} 项 · 共 ${batch.items.length} 项`
                        : `共 ${batch.items.length} 项`}
                    </h5>
                    <ol>
                      {batch.items.map((item, index) => (
                        <li
                          key={item.taskId}
                          aria-current={
                            showCurrent && index === batch.currentIndex
                              ? "step"
                              : undefined
                          }
                        >
                          <div className="agent-batch-item-heading">
                            <strong>{item.text}</strong>
                            <span>
                              {cancelled && item.status !== "done"
                                ? batchItemStatusText.cancelled
                                : batchItemStatusText[item.status] ||
                                  item.status}
                            </span>
                          </div>
                          {item.summary && <p>{item.summary}</p>}
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
                {run.error && <p className="agent-error">{run.error}</p>}
                {run.status === "cancel_requested" && (
                  <p className="agent-note">
                    正在等待 Codex 确认停止，收到确认前仍会显示执行进度。
                  </p>
                )}
                {run.status === "waiting_approval" && (
                  <p className="agent-note">
                    本次执行需要审批，当前入口尚未提供审批按钮。可以请求停止，调整要求后再提交。
                  </p>
                )}
                {run.status === "waiting_input" && !run.terminal && (
                  <p className="agent-note">
                    Codex
                    正在等待交互输入。当前入口可查看问题和请求停止，直接回答问题将在后续聊天功能接入。
                  </p>
                )}
                {(detail.events || [])
                  .filter((event) =>
                    ["approval.requested", "input.requested"].includes(
                      event.type,
                    ),
                  )
                  .slice(-1)
                  .map((event) => (
                    <p className="agent-note" key={event.eventId}>
                      {event.payload.description ||
                        event.payload.questions
                          ?.map((q) => q.prompt)
                          .join("；")}
                    </p>
                  ))}
                {!batch && resultSummary && (
                  <p className="agent-execution-summary">{resultSummary}</p>
                )}
                <details open>
                  <summary>执行输出</summary>
                  <pre className="agent-execution-output">
                    {output || "等待本机回传输出…"}
                  </pre>
                </details>
                {detail.truncated && (
                  <p className="agent-note">
                    页面展示最近的输出，完整记录仍保存在本机 Codex 会话中。
                  </p>
                )}
                <label>
                  补充说明
                  <textarea
                    aria-label="补充说明"
                    rows={2}
                    maxLength={32000}
                    value={followup}
                    disabled={busy || !canFollow}
                    onChange={(event) => setFollowup(event.target.value)}
                    placeholder="补充要求，交给上面这一个会话"
                  />
                </label>
                <div className="agent-actions">
                  <button
                    disabled={busy || !canFollow || !followup.trim()}
                    onClick={() => perform(sendFollowup)}
                  >
                    发送补充说明
                  </button>
                  <span className="agent-note">
                    {finished || cancelled
                      ? "新的工作可提交新批次。"
                      : paused
                        ? "补充后重做当前项，完成后继续后续待办。"
                        : run.terminal
                          ? "继续原会话的新一轮"
                          : "补充到正在执行的这一轮"}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
