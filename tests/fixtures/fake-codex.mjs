import readline from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const version = "0.166.0-alpha.5.1";
if (process.argv.includes("--version")) {
  console.log(`codex-cli ${process.env.FAKE_VERSION ?? version}`);
  process.exit(0);
}
const statePath = process.env.FAKE_CODEX_STATE;
let state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { threads: [], calls: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const mode = () => process.env.FAKE_CODEX_MODE ?? "normal";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let initialized = false;
const pending = new Map();

function finish(thread, turn, status = "completed") {
  turn.status = status;
  thread.status = { type: "idle" };
  if (status === "completed") {
    const input = turn.items.find((item) => item.type === "userMessage")
      .content[0].text;
    const { snapshot } = JSON.parse(input);
    const result =
      snapshot.kind === "summary"
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
            runId: snapshot.runId,
            taskId: snapshot.task.taskRef.taskId,
            outcome: "done",
            summary: "任务完成",
            changedFiles: [],
            evidenceRefs: [],
            remainingIssues: [],
            nextTaskNotes: [],
          };
    const text =
      mode() === "invalid-output"
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
    mode() !== "silent-completed" &&
    !(mode() === "silent-cancelled" && status === "interrupted")
  )
    notify("turn/completed", { threadId: thread.id, turn });
  if (mode() === "duplicate")
    notify("turn/completed", { threadId: thread.id, turn });
  if (["exit-completed", "silent-completed"].includes(mode()))
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
      finish(request.thread, request.turn);
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
      source: "appServer",
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    state.threads.push(thread);
    save();
    if (mode() === "exit-thread-start") return process.exit(2);
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
    const items =
      thread.turns.find((turn) => turn.id === params.turnId)?.items ?? [];
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
    thread.turns.push(turn);
    if (["background-cancel", "background-stuck"].includes(mode()))
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
    if (mode() === "exit-turn-start") {
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
      ].includes(mode())
    )
      return;
    if (["approval", "input"].includes(mode())) {
      const id = "server-request";
      pending.set(id, { thread, turn });
      return send({
        id,
        method:
          mode() === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/tool/requestUserInput",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: "item-a",
          reason: "Needs user",
          questions: [{ id: "choice", question: "选择环境" }],
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
