import readline from "node:readline";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const version = "0.167.0-alpha.3.2";
if (process.argv.includes("--version")) {
  console.log(`codex-cli ${process.env.FAKE_VERSION ?? version}`);
  process.exit(0);
}
const statePath = process.env.FAKE_CODEX_STATE;
process.on("uncaughtException", (error) => {
  writeFileSync(`${statePath}.error`, String(error.stack ?? error));
  process.exit(1);
});
let state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { threads: [], calls: [] };
const save = () => {
  writeFileSync(`${statePath}.next`, JSON.stringify(state));
  // Windows readers can briefly deny replacement. Keep the snapshot atomic and
  // surface persistent failures instead of killing the fake on a sharing race.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(`${statePath}.next`, statePath);
      break;
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM" || attempt >= 9)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
const mode = () => process.env.FAKE_CODEX_MODE ?? "normal";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let initialized = false;
const pending = new Map();

function businessResult(thread, turn) {
  const schema =
    thread.responseSchemas?.[turn.id] ?? thread.dynamicTools?.[0]?.inputSchema;
  return schema?.properties?.overview
    ? {
        overview: "测试项目",
        completed: [],
        inProgress: [],
        pending: [],
        blockers: [],
        verification: [],
        uncertainties: [],
      }
    : {
        outcome: "done",
        summary: "任务完成",
        changedFiles: [],
        evidenceRefs: [],
        remainingIssues: [],
        nextTaskNotes: [],
      };
}

function finish(thread, turn, status = "completed") {
  const jsonOnly = [
    "business-output",
    "legacy-output",
    "wrong-result-id",
    "invalid-output",
  ].includes(mode());
  if (
    status === "completed" &&
    mode().startsWith("report") &&
    mode() !== "report-missing" &&
    !turn.reportAttempted
  ) {
    turn.reportAttempted = true;
    const item = {
      type: "dynamicToolCall",
      id: `report-${turn.id}`,
      namespace: null,
      tool: "qingdan_report_result",
      arguments:
        mode() === "report-invalid"
          ? { outcome: "done" }
          : businessResult(thread, turn),
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    };
    turn.items.push(item);
    save();
    notify("item/started", { threadId: thread.id, turnId: turn.id, item });
    pending.set(item.id, { thread, turn, report: item });
    send({
      id: item.id,
      method: "item/tool/call",
      params: {
        threadId: thread.id,
        turnId: mode() === "report-wrong-turn" ? "foreign-turn" : turn.id,
        callId: item.id,
        namespace: null,
        tool: item.tool,
        arguments: item.arguments,
      },
    });
    return;
  }
  turn.status = status;
  thread.status = { type: "idle" };
  if (status === "completed") {
    const result = businessResult(thread, turn);
    if (mode() === "batch-block-second" && thread.turns.length === 2) {
      result.outcome = "blocked";
      result.summary = "当前待办受阻";
      result.remainingIssues = ["需要补充说明"];
    }
    // Transport recovery scenarios supply persisted completed items; report-*
    // scenarios above exercise the actual callback handshake.
    if (
      thread.dynamicTools?.length &&
      !jsonOnly &&
      !mode().startsWith("report")
    ) {
      turn.items.push({
        type: "dynamicToolCall",
        id: `report-${turn.id}`,
        namespace: null,
        tool: "qingdan_report_result",
        arguments: result,
        status: "completed",
        contentItems: [{ type: "inputText", text: "已记录。" }],
        success: true,
        durationMs: 1,
      });
    }
    if (mode() === "legacy-output" && process.env.FAKE_RUNNER_DB) {
      const db = new DatabaseSync(process.env.FAKE_RUNNER_DB, {
        readOnly: true,
      });
      const record = JSON.parse(
        db.prepare("SELECT data FROM runs WHERE thread_id = ?").get(thread.id)
          .data,
      );
      db.close();
      result.runId = record.runId;
      result.taskId = record.snapshot.task.taskRef.taskId;
    }
    if (mode() === "wrong-result-id") {
      result.runId = "foreign-run";
      result.taskId = "foreign-task";
    }
    const text =
      !jsonOnly && thread.dynamicTools?.length
        ? "已完成本次任务，并核对了结果。"
        : mode() === "invalid-output"
          ? "not structured JSON"
          : JSON.stringify(result);
    const item = {
      type: "agentMessage",
      id: `output-${turn.id}`,
      phase: "final_answer",
      text,
    };
    turn.items.push(item);
    notify("item/agentMessage/delta", {
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      delta: text,
    });
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
  }
  save();
  if (
    !["silent-completed", "report-silent"].includes(mode()) &&
    !(mode() === "silent-cancelled" && status === "interrupted")
  )
    notify("turn/completed", {
      threadId: thread.id,
      turn: {
        ...turn,
        items: turn.items
          .filter((item) => item.type === "agentMessage")
          .slice(-1),
      },
    });
  if (mode() === "duplicate")
    notify("turn/completed", { threadId: thread.id, turn });
  if (["exit-completed", "silent-completed", "report-silent"].includes(mode()))
    setTimeout(() => process.exit(0), 20);
}

readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const msg = JSON.parse(raw);
  if (!msg.method) {
    state.calls.push({ method: "server-response", params: msg });
    save();
    const request = pending.get(msg.id);
    if (request) {
      pending.delete(msg.id);
      if (request.report) {
        request.report.success = msg.result?.success === true;
        request.report.status = request.report.success ? "completed" : "failed";
        request.report.contentItems = msg.result?.contentItems ?? [];
        save();
        notify("item/completed", {
          threadId: request.thread.id,
          turnId: request.turn.id,
          item: request.report,
        });
        if (mode() === "report-hold") return;
      }
      finish(
        request.thread,
        request.turn,
        mode() === "report-failed" ? "failed" : "completed",
      );
    }
    return;
  }
  state.calls.push({ method: msg.method, params: msg.params });
  save();
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message) =>
    send({ id: msg.id, error: { code: -32600, message } });
  if (msg.method === "initialize") {
    initialized = true;
    return reply({
      userAgent: `codex/${version}`,
      codexHome: "fake",
      platformFamily: "windows",
      platformOs: "windows",
    });
  }
  if (msg.method === "initialized") return;
  if (!initialized) return fail("Not initialized");
  const params = msg.params ?? {};
  if (msg.method === "account/read")
    return reply({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  if (msg.method === "thread/list") {
    const threads = state.threads.filter(
      (thread) => !params.cwd || params.cwd.includes(thread.cwd),
    );
    const offset = Number(params.cursor ?? 0);
    return reply({
      data: threads.slice(offset, offset + 1),
      nextCursor: offset + 1 < threads.length ? String(offset + 1) : null,
    });
  }
  if (msg.method === "thread/start") {
    const thread = {
      id: `thread-${state.threads.length + 1}`,
      cwd: params.cwd,
      name: null,
      dynamicTools: params.dynamicTools,
      source: "appServer",
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    state.threads.push(thread);
    save();
    if (mode() === "exit-thread-start") return process.exit(2);
    if (mode() === "delayed-thread-start") {
      const timer = setInterval(() => {
        if (!existsSync(`${statePath}.release-thread`)) return;
        clearInterval(timer);
        notify("thread/started", { thread });
        reply({ thread, cwd: params.cwd, sandbox: { type: "workspaceWrite" } });
      }, 5);
      return;
    }
    notify("thread/started", { thread });
    return reply({
      thread,
      cwd: params.cwd,
      sandbox: {
        type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite",
      },
    });
  }
  const thread = state.threads.find((item) => item.id === params.threadId);
  if (!thread) return fail("Unknown thread");
  if (msg.method === "thread/name/set") {
    thread.name = params.name;
    save();
    return reply({});
  }
  if (msg.method === "thread/read" || msg.method === "thread/resume") {
    if (msg.method === "thread/resume" && existsSync(`${statePath}.hold-resume`) && !state.heldResume) {
      state.heldResume = true;
      save();
      const timer = setInterval(() => {
        if (!existsSync(`${statePath}.release-resume`)) return;
        clearInterval(timer);
        reply({ thread });
      }, 5);
      return;
    }
    if (
      msg.method === "thread/read" &&
      ["complete-during-read", "complete-during-read-error"].includes(mode()) &&
      thread.turns.at(-1)?.status === "inProgress"
    ) {
      finish(thread, thread.turns.at(-1));
      if (mode() === "complete-during-read-error")
        return fail("History query failed after completion");
    }
    if (
      msg.method === "thread/resume" &&
      mode() === "resume-once-fails" &&
      state.calls.filter((call) => call.method === "thread/resume").length === 1
    )
      return fail("Temporary resume failure");
    return reply({ thread });
  }
  if (msg.method === "thread/backgroundTerminals/list") {
    const terminals = thread.terminals ?? [],
      offset = Number(params.cursor ?? 0);
    return reply({
      data: terminals.slice(offset, offset + 1),
      nextCursor: offset + 1 < terminals.length ? String(offset + 1) : null,
    });
  }
  if (msg.method === "thread/backgroundTerminals/terminate") {
    const found = (thread.terminals ?? []).some(
      (terminal) => terminal.processId === params.processId,
    );
    if (mode() !== "background-stuck")
      thread.terminals = (thread.terminals ?? []).filter(
        (terminal) => terminal.processId !== params.processId,
      );
    save();
    return reply({ terminated: found && mode() !== "background-stuck" });
  }
  if (msg.method === "thread/turns/list") {
    const offset = Number(params.cursor ?? 0);
    const turns = [...thread.turns].reverse();
    return reply({
      data: turns
        .slice(offset, offset + 1)
        .map((turn) =>
          mode() === "metadata-history" ? { ...turn, items: [] } : turn,
        ),
      nextCursor: offset + 1 < turns.length ? String(offset + 1) : null,
      backwardsCursor: null,
    });
  }
  if (msg.method === "thread/items/list") {
    let items =
      thread.turns.find((turn) => turn.id === params.turnId)?.items ?? [];
    if (params.sortDirection === "desc") items = [...items].reverse();
    const offset = Number(params.cursor ?? 0);
    return reply({
      data: items.slice(offset, offset + 1).map((item) => ({
        turnId: params.turnId,
        item,
        startedAtMs: null,
        completedAtMs: null,
      })),
      nextCursor: offset + 1 < items.length ? String(offset + 1) : null,
      backwardsCursor: null,
    });
  }
  if (msg.method === "turn/start") {
    if (
      Object.values(params.additionalContext ?? {}).some(
        (context) =>
          context.name && !/^[a-z][a-z0-9_]{0,63}$/.test(context.name),
      )
    )
      return fail("additional context name must match [a-z][a-z0-9_]{0,63}");
    if (process.env.FAKE_RUNNER_DB) {
      const db = new DatabaseSync(process.env.FAKE_RUNNER_DB, {
        readOnly: true,
      });
      state.calls.at(-1).persistedThreadId = db
        .prepare("SELECT thread_id FROM runs WHERE thread_id = ?")
        .get(thread.id)?.thread_id;
      db.close();
    }
    const turn = {
      id: `${thread.id}-turn-${thread.turns.length + 1}`,
      status: "inProgress",
      error: null,
      items: [
        {
          type: "userMessage",
          id: "input",
          clientId: params.clientUserMessageId,
          content: params.input,
        },
      ],
    };
    (thread.responseSchemas ||= {})[turn.id] = params.outputSchema;
    thread.turns.push(turn);
    if (
      ["background-cancel", "background-stuck", "batch-background"].includes(
        mode(),
      )
    )
      thread.terminals = ["process-a", "process-b"].map((processId) => ({
        processId,
        itemId: processId,
        command: "test helper",
        cwd: thread.cwd,
        osPid: null,
        cpuPercent: null,
        rssKb: null,
      }));
    thread.status = { type: "active", activeFlags: [] };
    save();
    if (
      mode() === "exit-turn-start" ||
      (mode() === "batch-exit-second" && thread.turns.length === 2) ||
      (mode() === "batch-exit-third" && thread.turns.length === 3)
    ) {
      finish(thread, turn);
      return process.exit(3);
    }
    if (mode() === "foreign-completed")
      notify("turn/completed", {
        threadId: thread.id,
        turn: { ...turn, id: "foreign-turn", status: "completed" },
      });
    notify("turn/started", { threadId: thread.id, turn });
    if (mode() === "early-completed") finish(thread, turn);
    reply({ turn: { ...turn, items: [] } });
    if (mode() === "exit-running") {
      setTimeout(() => process.exit(0), 20);
      return;
    }
    if (
      [
        "early-completed",
        "hang",
        "ignore-cancel",
        "complete-during-read",
        "complete-during-read-error",
        "silent-cancelled",
        "background-cancel",
        "background-stuck",
        "report-steer-race",
      ].includes(mode())
    )
      return;
    if (
      [
        "approval",
        "input",
        "file-approval",
        "session-approval",
        "network-approval",
      ].includes(mode())
    ) {
      const id = "server-request";
      const fileApproval = ["file-approval", "session-approval"].includes(
        mode(),
      );
      if (fileApproval)
        notify("item/started", {
          threadId: thread.id,
          turnId: turn.id,
          item: {
            type: "fileChange",
            id: "item-a",
            status: "inProgress",
            changes: [
              {
                path: `${thread.cwd}/safe.txt`,
                kind: { type: "add" },
                diff: "+private raw patch should not appear",
              },
            ],
          },
        });
      pending.set(id, { thread, turn });
      return send({
        id,
        method:
          mode() === "input"
            ? "item/tool/requestUserInput"
            : fileApproval
              ? "item/fileChange/requestApproval"
              : "item/commandExecution/requestApproval",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: "item-a",
          reason: "Needs user",
          command: "node --token fake-private-token -e 'console.log(1)'",
          cwd: thread.cwd,
          availableDecisions: [
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
          ],
          ...(mode() === "session-approval" ? { grantRoot: thread.cwd } : {}),
          ...(mode() === "network-approval"
            ? {
                additionalPermissions: {
                  network: { enabled: true },
                  fileSystem: null,
                },
              }
            : {}),
          questions: [
            {
              id: "choice",
              question: "选择环境",
              options: [{ label: "测试", description: "使用测试环境" }],
              isOther: true,
              isSecret: false,
            },
          ],
        },
      });
    }
    setTimeout(() => finish(thread, turn), 25);
    return;
  }
  if (msg.method === "turn/steer") {
    const turn = thread.turns.at(-1);
    if (turn.id !== params.expectedTurnId || turn.status !== "inProgress")
      return fail("Turn mismatch");
    if (mode() === "report-steer-race") finish(thread, turn);
    turn.items.push({
      type: "userMessage",
      id: `steer-${params.clientUserMessageId}`,
      clientId: params.clientUserMessageId,
      content: params.input,
    });
    save();
    return reply({ turnId: turn.id });
  }
  if (msg.method === "turn/interrupt") {
    reply({});
    if (mode() !== "ignore-cancel")
      setTimeout(
        () =>
          finish(
            thread,
            thread.turns.find((turn) => turn.id === params.turnId),
            "interrupted",
          ),
        15,
      );
    return;
  }
  fail("Unknown method");
});
