import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chatClientHeader,
  chatClientName,
  modelToolError,
  modelToolResult,
  systemPrompt,
  toolSpecs,
} from "./chat-contract.mjs";
import { chatPrompt, conversationText } from "./chat-input.mjs";
import { readModelReply } from "./model-turn.mjs";
import {
  modelIssue,
  issueError,
  interruptedRun,
} from "../../shared/agent/model-issue.mjs";
import { TaskStore, digest } from "../../runner/harness/task-store.mjs";
import { TaskRun, replayWindow } from "../../runner/harness/coordinator.mjs";
import { harnessPrompt } from "../../runner/harness/contracts.mjs";
import { taskCard } from "../../runner/harness/verification.mjs";
import { completedTaskReport } from "../../runner/harness/retention.mjs";
import { HarnessCapabilities } from "./harness-capabilities.mjs";
import { contextBudget } from "../../runner/harness/context-pack.mjs";
import {
  resultData,
  normalizeEvidence,
} from "../../runner/harness/evidence.mjs";

const entry = fileURLToPath(import.meta.resolve("qingdan-pi-cli/rpc-entry"));
const extension = fileURLToPath(
  new URL("./rpc-extension.mjs", import.meta.url),
);
const operatingSystemEnv =
  /^(path|pathext|systemroot|windir|comspec|tmp|temp|tmpdir|home|userprofile|appdata|localappdata|lang|lc_all|systemdrive|node_extra_ca_certs|ssl_cert_file|https?_proxy|no_proxy)$/i;

export async function rpcTurn({
  args,
  env,
  cwd,
  messages,
  remoteSpecs,
  localSpecs,
  execute,
  signal,
  model,
  service,
  onHttpError,
  harness,
  beforeModel,
}) {
  signal.throwIfAborted();
  const child = fork(entry, args, {
    cwd,
    env,
    execArgv: [],
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  child.stderr.resume();
  const toolController = new AbortController();
  const toolSignal = AbortSignal.any([signal, toolController.signal]);
  let abort, startupTimer;
  let toolWork = Promise.resolve();
  try {
    return await new Promise((resolve, reject) => {
      let last,
        buffer = "",
        settled = false,
        started = false;
      function finish(error, text) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(text);
      }
      abort = () => finish(interruptedRun(signal));
      startupTimer = setTimeout(
        () => finish(new Error("本机 Pi 聊天扩展未能就绪。")),
        30000,
      );
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", () => finish(new Error("无法启动本机 Pi 1.5.2。")));
      child.once("exit", () => finish(new Error("本机 Pi 在回复完成前退出。")));
      child.stdin.on("error", () =>
        finish(new Error("本机 Pi 的 RPC 连接已关闭。")),
      );
      child.on("message", (message) => {
        if (message?.type === "model_http_error") {
          try {
            onHttpError?.(message.detail);
          } catch {
            /* Diagnostic storage may be unavailable; keep the original model error. */
          }
          const issue = modelIssue(message.detail, { model, service });
          if (issue && !issue.retryable) finish(issueError(issue));
          return;
        }
        if (!settled && !started && message?.type === "catalog_request") {
          child.send(
            {
              type: "tool_catalog",
              specs: harness ? harness.specs() : remoteSpecs,
              localSpecs,
            },
            (error) => {
              if (error) finish(new Error("无法交付本轮 MCP 工具列表。"));
            },
          );
          return;
        }
        if (!settled && !started && message?.type === "context_ready") {
          started = true;
          clearTimeout(startupTimer);
          child.send(
            {
              type: "chat_context",
              messages,
              ...(harness && {
                task: harness.context(),
                replay: replayWindow(
                  harness.baseTranscript,
                  (harness.inputBudget || 24000) * 3,
                ),
                inputBudget: harness.inputBudget || 24000,
              }),
            },
            (error) => {
              if (error) finish(new Error("无法交付本轮 Pi 对话。"));
              else if (!settled && !child.stdin.destroyed)
                child.stdin.write(
                  JSON.stringify({
                    id: "chat",
                    type: "prompt",
                    message: chatPrompt,
                  }) + "\n",
                );
            },
          );
          return;
        }
        if (!settled && harness && message?.type === "harness_event") {
          toolWork = toolWork
            .then(async () => {
              if (settled) return;
              const reply = {
                type: "harness_reply",
                requestId: message.requestId,
              };
              try {
                if (["context", "request"].includes(message.kind))
                  await beforeModel?.();
                reply.value = await harness.rpc(message);
              } catch (error) {
                reply.error = modelToolError(error.message);
              }
              if (!settled && child.connected)
                child.send(reply, (error) => {
                  if (error) abort();
                });
            })
            .catch(() => finish(new Error("任务控制连接已关闭。")));
          return;
        }
        if (
          settled ||
          message?.type !== "tool" ||
          typeof message.callId !== "string"
        )
          return;
        toolWork = toolWork
          .then(async () => {
            if (settled) return;
            const reply = { type: "tool_result", callId: message.callId };
            try {
              if (
                ![
                  ...localSpecs,
                  ...(harness ? harness.specs() : remoteSpecs),
                ].some((spec) => spec.name === message.name)
              )
                throw Error("未知的本机工具。");
              reply.value = await execute(
                message.name,
                message.args,
                toolSignal,
                message.callId,
              );
            } catch (error) {
              reply.error = modelToolError(error.message);
            }
            if (!settled && child.connected) {
              if (harness)
                child.send({
                  type: "tool_catalog_update",
                  specs: harness.specs(),
                });
              child.send(reply, (error) => {
                if (error) abort();
              });
              if (harness?.shouldYield()) finish(null, "");
            }
          })
          .catch(() => finish(new Error("轻单工具连接已关闭。")));
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        buffer += chunk;
        try {
          let newline;
          while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            harness?.observe(event);
            if (
              event.type === "response" &&
              event.id === "chat" &&
              (!event.success || event.data?.disposition === "handled")
            )
              throw Error("Pi 未接收本轮聊天消息。");
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            )
              last = event.message;
            if (event.type === "agent_settled")
              finish(null, readModelReply(last, model, service));
          }
          if (buffer.length > 2 * 1024 * 1024)
            throw Error("Pi 的响应超出本机限制。");
        } catch (error) {
          finish(
            error instanceof SyntaxError
              ? new Error("Pi 返回了无效的 RPC 消息。")
              : error,
          );
        }
      });
    });
  } finally {
    clearTimeout(startupTimer);
    signal.removeEventListener("abort", abort);
    toolController.abort();
    if (!child.stdin.destroyed) child.stdin.end();
    const forceStop = setTimeout(() => child.kill(), 1500);
    try {
      await Promise.all([exited, toolWork]);
    } finally {
      clearTimeout(forceStop);
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

export async function prepareProfile(directory, id, settings) {
  const profile =
    id === "xingchi"
      ? path.resolve(directory, "pi-rpc")
      : path.resolve(directory, "pi-models", id);
  const cwd = path.join(profile, "work");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const model = settings.model;
  const provider = {
    baseUrl: settings.baseUrl,
    api:
      settings.apiFormat === "chat_completions"
        ? "openai-completions"
        : "openai-responses",
    apiKey: id === "xingchi" ? "$XINGCHI_API_KEY" : "$QINGDAN_MODEL_KEY",
    headers: { [chatClientHeader]: chatClientName },
    models: [
      {
        id: model,
        input: ["text"],
        contextWindow: settings.contextWindow || 65536,
        maxTokens:
          new URL(settings.baseUrl).hostname === "api.deepseek.com"
            ? 8192
            : 2400,
      },
    ],
  };
  await writeFile(
    path.join(profile, "models.json"),
    JSON.stringify({ providers: { [id]: provider } }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    { mode: 0o600 },
  );
  return { profile, cwd };
}

export async function openPiChat({
  directory,
  settings,
  catalog,
  tools,
  mcp,
  isBinding = (id) => id === "pi-local-binding",
  sample = false,
  taskHarness = false,
  requirePlanConfirmation = false,
  harnessLimits,
  authorizeTask = async () => true,
  externalPollMs = 15000,
  accountId = "pi-local",
  resolveConnection,
  beforeExecute,
  preloadSelected = false,
  filterLocalTools = (specs) => specs,
  onTaskCompleted,
}) {
  // The application enables this path explicitly; the legacy adapter remains
  // available for compatibility and maintenance protocol fixtures.
  const taskStore = taskHarness ? new TaskStore(directory) : null;
  const profiles = new Map(
    settings
      ? [["xingchi", await prepareProfile(directory, "xingchi", settings)]]
      : [],
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      operatingSystemEnv.test(name),
    ),
  );
  const active = new Map();
  const cancelled = new Set();
  const watchers = new Map();
  let closing = false;
  let admissionsPaused = false;
  let retentionDelivery;
  function deliverRetention() {
    if (closing || admissionsPaused || !onTaskCompleted || retentionDelivery)
      return;
    retentionDelivery = (async () => {
      for (const report of taskStore?.pendingRetentions() || []) {
        if (closing) break;
        try {
          await onTaskCompleted(report);
          taskStore.acknowledgeRetention(report.taskId);
        } catch {
          break;
        } // Keep the outbox across local service upgrades.
      }
    })().finally(() => {
      retentionDelivery = null;
    });
  }
  const retentionTimer = onTaskCompleted
    ? setInterval(deliverRetention, 15000)
    : null;
  retentionTimer?.unref();
  deliverRetention();
  function scheduleExternal(id) {
    if (closing || watchers.has(id)) return;
    const timer = setTimeout(() => {
      watchers.delete(id);
      void pollExternal(id).catch(() => {});
    }, externalPollMs);
    timer.unref();
    watchers.set(id, timer);
  }
  const answerWatchers = new Map();
  function scheduleAnswers(id) {
    if (closing || answerWatchers.has(id)) return;
    const timer = setTimeout(() => {
      answerWatchers.delete(id);
      void resumeAnswers(id).catch(() => {});
    }, 100);
    timer.unref();
    answerWatchers.set(id, timer);
  }
  async function resumeAnswers(id) {
    const state = taskStore?.get(id);
    if (
      closing ||
      admissionsPaused ||
      !state?.resume ||
      ["completed", "cancelled"].includes(state.status) ||
      !taskStore.pendingAnswers(id).length
    )
      return;
    const envelope = state.resume;
    if (
      [...active.values()].some((item) => item.chatId === envelope.scope.chatId)
    ) {
      scheduleAnswers(id);
      return;
    }
    if (
      !(await isBinding(envelope.scope.bindingId)) ||
      !(await authorizeTask(envelope))
    )
      return;
    const jobId = "answer:" + id;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(570000),
    ]);
    const work = run(
      {
        ...envelope,
        jobId,
        input: { ...envelope.input, taskReply: undefined },
      },
      signal,
    );
    active.set(jobId, {
      scope: envelope.scope,
      chatId: envelope.scope.chatId,
      modelProfileId: envelope.modelProfileId || "xingchi",
      controller,
      work,
    });
    try {
      await work;
    } finally {
      active.delete(jobId);
    }
  }
  async function pollExternal(id) {
    if (admissionsPaused) {
      scheduleExternal(id);
      return;
    }
    const state = taskStore?.get(id);
    if (
      closing ||
      state?.status !== "waiting_external" ||
      !state.external ||
      !state.resume
    )
      return;
    const envelope = state.resume;
    const { scope } = envelope;
    if ([...active.values()].some((item) => item.chatId === scope.chatId)) {
      scheduleExternal(id);
      return;
    }
    const jobId = "external:" + id;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(570000),
    ]);
    const work = (async () => {
      const permitted =
        (await isBinding(scope.bindingId)) && (await authorizeTask(envelope));
      const remote = mcp?.turn(scope);
      const localSpecs =
        remote?.waaoAccess && !remote.waaoAccess.enabled
          ? toolSpecs.filter((t) => t.name !== "waao")
          : toolSpecs;
      const capabilities = new HarnessCapabilities(mcp, scope, localSpecs);
      let taskRun;
      let wake = false;
      try {
        taskRun = new TaskRun({
          store: taskStore,
          scope,
          input: { ...envelope.input, taskReply: undefined },
          jobId,
          signal,
          capabilities,
          requirePlanConfirmation,
          limits: harnessLimits,
        });
        if (taskRun.task?.id !== id) return;
        if (!permitted) {
          taskRun.task.status = "interrupted";
          taskRun.task.progress =
            "任务可见性或授权已变化，请在原对话核对后继续。";
          taskRun.save("authorization_changed");
          return;
        }
        if (
          Date.now() - state.external.since > 30 * 60000 ||
          state.external.checks >= 120
        ) {
          taskRun.task.status = "interrupted";
          taskRun.task.progress =
            "外部任务等待达到本次上限，原回执已保存，可继续查询。";
          taskRun.save("wait_limit");
          return;
        }
        const waitName = state.external.name || "waao";
        if (waitName !== "waao") {
          const loaded = await capabilities.request(waitName);
          if (loaded.status !== "ready")
            throw Error("原生成任务的状态查询工具不可用，请核对授权。");
        }
        const result = await taskRun.execute(
          waitName,
          state.external.args,
          randomUUID(),
          async (name, args) => {
            if (name !== "waao")
              return capabilities.execute(name, args, randomUUID(), signal);
            const response = await tools.fetch(
              new Request("https://tools.internal/execute", {
                method: "POST",
                body: JSON.stringify({ scope, name, args }),
                signal,
              }),
              remote?.waaoAccess,
            );
            const result = await response.json();
            if (!response.ok)
              throw Object.assign(Error(result.error), {
                accessIssue: result.accessIssue,
              });
            return modelToolResult(name, args.action, result);
          },
        );
        taskRun.task.external.checks++;
        if (result?.isError) {
          taskRun.task.external = null;
          const blocker = taskRun
            .card()
            .blockers?.find((b) => b.kind === "authorization");
          taskRun.fail(
            false,
            issueError({
              code: blocker?.code || "EXTERNAL_STATUS_FAILED",
              source: "tool",
              retryable: false,
              message:
                blocker?.message ||
                "外部平台未能返回有效状态，已保存原回执，请核对服务后继续。",
            }),
          );
          taskRun.finish("");
          return;
        }
        const stateData = resultData(result);
        const status = stateData.task?.status || stateData.status;
        wake =
          (/__macro_run_get$/.test(state.external.name || "") &&
            ["completed", "succeeded"].includes(status)) ||
          (state.external.expectedStatus &&
            status === state.external.expectedStatus &&
            stateData.agent_runnable !== false) ||
          !!taskRun.task.evidence.at(-1)?.mediaReady ||
          ["failed", "stopped", "cancelled", "error", "rejected"].includes(
            status,
          );
        taskRun.task.status = wake ? "running" : "waiting_external";
        taskRun.task.progress = wake
          ? "外部任务已返回结果，正在核对验收条件。"
          : "外部任务仍在处理，已核对原回执。";
        if (wake) taskRun.task.external = null;
        taskRun.save("external_checked");
        if (wake && taskRun.finishKnown("", true)) {
          taskRun.finish("");
          wake = false;
          const report = completedTaskReport(taskRun.task, jobId);
          if (report && onTaskCompleted) {
            taskStore.queueRetention(report);
            deliverRetention();
          }
        }
      } catch (error) {
        taskRun?.fail(false, error);
        taskRun?.finish("");
      } finally {
        taskRun?.close();
        await capabilities.close();
        await remote?.close();
      }
      if (wake && !signal.aborted && !closing)
        await run(
          {
            ...envelope,
            jobId,
            input: { ...envelope.input, taskReply: undefined },
          },
          signal,
        );
    })();
    active.set(jobId, {
      scope,
      chatId: scope.chatId,
      modelProfileId: envelope.modelProfileId || "xingchi",
      controller,
      work,
    });
    try {
      await work;
    } finally {
      active.delete(jobId);
      if (!closing && taskStore?.get(id)?.status === "waiting_external")
        scheduleExternal(id);
    }
  }
  async function run(
    { jobId, sessionId, scope, input, modelProfileId = "xingchi" },
    signal,
  ) {
    const connection = resolveConnection
      ? await resolveConnection(modelProfileId, scope)
      : (catalog?.connection(modelProfileId) ?? settings);
    if (!resolveConnection && !catalog && modelProfileId !== "xingchi")
      throw Error("找不到所选模型连接。");
    const key = await connection.apiKey();
    if (!key) throw Error(connection.setupHint);
    const profileKey = resolveConnection
      ? digest([
          modelProfileId,
          connection.model,
          connection.baseUrl,
          connection.apiFormat,
        ])
      : modelProfileId;
    if (!profiles.has(profileKey))
      profiles.set(
        profileKey,
        prepareProfile(
          resolveConnection
            ? path.join(directory, "connections", profileKey)
            : directory,
          modelProfileId,
          connection,
        ).catch((error) => {
          profiles.delete(profileKey);
          throw error;
        }),
      );
    const { profile, cwd } = await profiles.get(profileKey);
    const { model, service } = connection;
    const resumed = taskStore?.latest(scope, true);
    if (resumed)
      scope = {
        ...scope,
        visible: [...new Set([...scope.visible, ...resumed.messageIds])],
      };
    await mcp?.readyForTurn(scope.bindingId);
    const remote = mcp?.turn(scope);
    const references = tools.references(
      scope.retry
        ? { ...scope, visible: [...scope.visible, scope.userMessageId] }
        : scope,
    );
    const previousTask = taskStore?.latest(scope);
    if (previousTask?.status === "completed" && previousTask.finalText)
      references.push({
        label: "上次任务的已交付结果",
        text: previousTask.finalText,
        taskId: previousTask.id,
      });
    let messages;
    let remoteSpecs = remote?.specs || [];
    const localSpecs = filterLocalTools(
      remote?.waaoAccess && !remote.waaoAccess.enabled
        ? toolSpecs.filter((tool) => tool.name !== "waao")
        : toolSpecs,
      scope,
    );
    const capabilities = taskStore
      ? new HarnessCapabilities(mcp, scope, localSpecs)
      : null;
    if (capabilities)
      capabilities.maxSchemaTokens = Math.min(
        12000,
        Math.max(2000, Math.floor((connection.contextWindow || 65536) / 3)),
      );
    if (preloadSelected) capabilities?.preload(remote, input.text);
    let harness;
    try {
      if (taskStore)
        harness = new TaskRun({
          store: taskStore,
          scope,
          input,
          jobId,
          signal,
          references,
          context: tools.context?.(scope) || [],
          limits: harnessLimits,
          capabilities,
          requirePlanConfirmation,
        });
      if (harness)
        harness.inputBudget = contextBudget(
          connection.contextWindow || 65536,
          new URL(connection.baseUrl).hostname === "api.deepseek.com"
            ? 8192
            : 2400,
          harness.specs(),
        );
      if (harness) {
        harness.contextWindow = connection.contextWindow || 65536;
        harness.outputReserve =
          new URL(connection.baseUrl).hostname === "api.deepseek.com"
            ? 8192
            : 2400;
      }
    } catch (error) {
      await remote?.close();
      throw error;
    }
    messages = conversationText(
      harness?.baseTranscript.length ? { ...input, history: [] } : input,
      [...references, ...(remote?.retryReceipts ?? [])],
    );
    if (harness) remoteSpecs = harness.specs();
    const args = [
      "--provider",
      modelProfileId,
      "--model",
      model,
      "--no-session",
      "--session-id",
      sessionId,
      "--offline",
      "--no-approve",
      "--no-context-files",
      "--no-extensions",
      "--no-mcp", // The host embeds Pi's MCP client with this project's credentials.
      "--no-skills",
      "--no-themes",
      "--no-prompt-templates",
      "--extension",
      extension,
      "--tools",
      [
        ...localSpecs.map((spec) => spec.name),
        ...remoteSpecs.map((spec) => spec.name),
        ...(harness ? ["mcp__*", "qd_recipe_*"] : []),
      ].join(","),
      "--system-prompt",
      systemPrompt +
        (harness ? "\n" + harnessPrompt : "") +
        (sample ? "\n本机 Codex 使用联调样例。" : "") +
        (scope.retry
          ? "\n这是原消息的重试。先复用本轮已有的稿件、图片和工具回执，已提交的工作不要再次执行。"
          : ""),
    ];
    const invoke = async (
      name,
      args,
      callId,
      onProgress,
      toolSignal = signal,
    ) => {
      if (harness && !localSpecs.some((spec) => spec.name === name))
        return capabilities.execute(name, args, callId, toolSignal, onProgress);
      if (!harness && remoteSpecs.some((item) => item.name === name))
        return remote.execute(name, args, callId, toolSignal);
      const response = await tools.fetch(
        new Request("https://tools.internal/execute", {
          method: "POST",
          body: JSON.stringify({ scope, name, args }),
          signal: toolSignal,
        }),
        remote?.waaoAccess,
        onProgress,
      );
      const result = await response.json();
      if (!response.ok) {
        if (name === "waao" && result.accessIssue)
          return { ...result, isError: true };
        throw Error(result.error);
      }
      return modelToolResult(name, args.action, result);
    };

    const deliver = async (text) => {
      const answer = harness ? harness.finish(text) : text;
      let retention;
      // A failed auxiliary review/export must not discard an accepted result.
      try {
        retention = completedTaskReport(harness?.task, jobId);
      } catch {}
      if (retention && onTaskCompleted) {
        try {
          taskStore.queueRetention(retention);
          deliverRetention();
        } catch {}
      }
      return {
        text: answer,
        tasks: harness?.proposals?.tasks || [],
        memories: harness?.proposals?.memories || [],
        ...(retention ? { retention } : {}),
      };
    };
    try {
      if (harness?.task?.schemaVersion >= 3) {
        harness.consumeAnswers();
        await capabilities.prepare(harness.task);
        const prepared = await harness.runPrepared(invoke, (name, values) =>
          beforeExecute?.(scope, name, values, signal),
        );
        if (harness.shouldYield()) return deliver("");
        if (prepared && harness.finishKnown("", true)) return deliver("");
      }
      const text = await rpcTurn({
        args,
        cwd,
        model,
        service,
        onHttpError: (detail) => catalog?.saveDiagnostic(jobId, detail),
        messages,
        remoteSpecs,
        localSpecs,
        harness,
        beforeModel: () => beforeExecute?.(scope, "model_request", {}, signal),
        signal,
        env: {
          ...env,
          PI_CODING_AGENT_DIR: profile,
          [modelProfileId === "xingchi"
            ? "XINGCHI_API_KEY"
            : "QINGDAN_MODEL_KEY"]: key,
          QINGDAN_MODEL_ENDPOINT:
            connection.baseUrl +
            (connection.apiFormat === "chat_completions"
              ? "/chat/completions"
              : "/responses"),
          ...(harness && { QINGDAN_PI_HARNESS: "1" }),
        },
        execute: async (name, args, toolSignal, callId) => {
          await beforeExecute?.(scope, name, args, toolSignal);
          const result = harness
            ? await harness.execute(name, args, callId, (...values) =>
                invoke(...values, toolSignal),
              )
            : await invoke(name, args, callId, undefined, toolSignal);
          return harness &&
            !localSpecs.some((spec) => spec.name === name) &&
            !Array.isArray(result?.content)
            ? {
                content: [{ type: "text", text: JSON.stringify(result) }],
                isError: false,
              }
            : result;
        },
      });
      return deliver(text);
    } catch (error) {
      if (
        (harness?.task?.status === "paused_budget" || harness?.halted) &&
        !signal.aborted
      )
        return { text: harness.finish(""), tasks: [], memories: [] };
      harness?.fail(cancelled.has(jobId), error);
      throw error;
    } finally {
      if (
        harness?.task &&
        !["completed", "cancelled"].includes(harness.task.status)
      ) {
        harness.task.resume = {
          jobId,
          sessionId,
          scope,
          input,
          modelProfileId,
        };
        harness.save("waiting_saved");
        if (harness.task.status === "waiting_external" && harness.task.external)
          scheduleExternal(harness.task.id);
        if (taskStore.pendingAnswers(harness.task.id).length)
          scheduleAnswers(harness.task.id);
      }
      harness?.close();
      await capabilities?.close();
      await remote?.close();
    }
  }
  for (const state of taskStore?.waiting() || [])
    if (state.external && state.resume) scheduleExternal(state.id);
  for (const state of taskStore?.answersWaiting() || [])
    scheduleAnswers(state.id);
  return {
    get activeCount() {
      return active.size;
    },
    modelBusy(ids) {
      const selected = new Set(ids);
      return [...active.values()].some((job) =>
        selected.has(job.modelProfileId),
      );
    },
    retentionBusy(memoryEpoch) {
      return active.size > 0 || !!taskStore?.hasResumableContext(memoryEpoch);
    },
    pauseAdmissions() {
      admissionsPaused = true;
      return { paused: true };
    },
    resumeAdmissions() {
      admissionsPaused = false;
      for (const task of taskStore?.waiting() || [])
        if (task.external && task.resume) scheduleExternal(task.id);
      for (const task of taskStore?.answersWaiting() || [])
        scheduleAnswers(task.id);
    },
    updateActivity() {
      return {
        tasks: [...active].map(([id]) => ({
          id,
          label: "Pi 任务",
          status: "running",
        })),
        unknown: [],
      };
    },
    task(scope) {
      if (!taskStore) return null;
      const task = taskStore.latest(scope);
      const card = taskCard(task);
      const answers = task ? taskStore.pendingAnswers(task.id) : [];
      if (card)
        card.answerPending =
          answers.length > 0 &&
          !["completed", "cancelled"].includes(task.status);
      for (const event of answers) {
        const question = card.questions.find((q) => q.id === event.questionId);
        if (question)
          question.pendingAnswer = {
            text: event.text,
            receivedAt: event.receivedAt,
          };
      }
      return card;
    },
    async queueAnswer(scope, input) {
      if (closing || admissionsPaused)
        throw Error("本机服务正在维护，请稍后重试。");
      const task = taskStore?.latest(scope);
      if (!task || task.id !== input?.taskId)
        throw Error("这次提问已失效，请刷新任务状态后回答。");
      const running = [...active.values()].find(
        (item) => item.chatId === scope.chatId,
      );
      if (!running && !task.resume) return { requiresNewTurn: true };
      if (
        !(await isBinding(scope.bindingId)) ||
        !(await authorizeTask(task.resume || { scope: running.scope }))
      )
        throw Error("任务的项目或上下文授权已变化，请在原对话刷新后继续。");
      const result = taskStore.queueAnswer(scope, input);
      scheduleAnswers(input.taskId);
      return { ...result, task: this.task(scope) };
    },
    decorate(message, scope) {
      const task = taskStore?.forMessage(scope, message.replyTo || message.id);
      return task
        ? {
            ...message,
            harnessTaskId: task.id,
            harnessTaskStatus: task.status,
            ...(message.role === "assistant" &&
            message.replyTo === task.activeMessageId &&
            task.status === "completed"
              ? { harnessTaskCard: taskCard(task) }
              : {}),
            ...(message.role === "assistant" &&
            message.replyTo === task.activeMessageId &&
            task.status === "completed" &&
            task.finalText
              ? { text: task.finalText }
              : {}),
          }
        : message;
    },
    async stopTask(scope, id) {
      const state = taskStore?.latest(scope);
      if (!state || state.id !== id) throw Error("当前对话中找不到此任务。");
      if (["completed", "cancelled"].includes(state.status)) return;
      clearTimeout(watchers.get(id));
      watchers.delete(id);
      const jobs = [...active.values()].filter(
        (job) =>
          job.chatId === scope.chatId &&
          job.scope?.bindingId === scope.bindingId,
      );
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled(jobs.map((job) => job.work));
      const owner = "cancel:" + randomUUID();
      taskStore.claim(scope, owner);
      try {
        const current = taskStore.get(id);
        if (current.status !== "completed") {
          current.status = "cancelled";
          current.progress =
            "已停止自动推进；已受理的平台任务仍可通过原回执查看。";
          taskStore.save(scope, owner, current, "cancelled");
        }
      } finally {
        taskStore.release(scope, owner);
      }
    },
    async fetch(request) {
      if (closing)
        return Response.json({ error: "本机 Pi 正在关闭。" }, { status: 503 });
      if (
        request.method !== "POST" ||
        request.url !== "https://pi.internal/turn"
      )
        return new Response(null, { status: 403 });
      const turn = await request.json();
      const { jobId, scope, sessionId } = turn;
      if (
        !jobId ||
        !sessionId ||
        scope?.accountId !== accountId ||
        !(await isBinding(scope.bindingId)) ||
        !scope.chatId ||
        !scope.userMessageId ||
        !Array.isArray(scope.visible)
      )
        return Response.json(
          { error: "无权访问该本机 Pi 会话。" },
          { status: 403 },
        );
      if (cancelled.has(jobId))
        return Response.json(
          { error: "已停止本轮 Pi 对话。" },
          { status: 409 },
        );
      const prior = active.get(jobId);
      if (admissionsPaused && !prior)
        return Response.json(
          { error: "已预约更新，暂不接收新任务。取消预约后可继续。" },
          { status: 423 },
        );
      if (prior && prior.chatId !== scope.chatId)
        return new Response(null, { status: 409 });
      let work = prior?.work;
      if (!work) {
        const controller = new AbortController();
        const signal = AbortSignal.any([
          request.signal,
          controller.signal,
          AbortSignal.timeout(570000),
        ]);
        work = run(turn, signal).finally(() => active.delete(jobId));
        active.set(jobId, {
          scope,
          chatId: scope.chatId,
          modelProfileId: turn.modelProfileId || "xingchi",
          controller,
          work,
        });
      }
      try {
        return Response.json(await work);
      } catch (error) {
        return Response.json(
          { error: modelToolError(error.message) },
          { status: 502 },
        );
      }
    },
    cancel(jobId) {
      // A cancellation can reach the host before the worker's service call.
      // Keep that fence for the lifetime of the worker's ten-minute job lease.
      if (!cancelled.has(jobId)) {
        cancelled.add(jobId);
        setTimeout(() => cancelled.delete(jobId), 600000).unref();
      }
      active.get(jobId)?.controller.abort();
    },
    async close() {
      closing = true;
      clearInterval(retentionTimer);
      for (const timer of watchers.values()) clearTimeout(timer);
      watchers.clear();
      for (const timer of answerWatchers.values()) clearTimeout(timer);
      answerWatchers.clear();
      const jobs = [...active.values()];
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled(jobs.map((job) => job.work));
      await retentionDelivery;
      taskStore?.close();
    },
  };
}
