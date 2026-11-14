import path from "node:path";
import { CodexClient } from "./codex-client";
import type { ProcessOptions } from "./supervisor";
import type { Model } from "./protocol/v2/Model";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse";
import type { Thread } from "./protocol/v2/Thread";
import { RunnerError } from "./errors";
import { rootKey } from "./workspace";

type Options = ProcessOptions & { requestTimeoutMs?: number };
export type SessionQuery = { cursor?: string; searchTerm?: string };

function sessionView(thread: Thread) {
  if (!thread?.id || !thread.cwd || thread.ephemeral || thread.parentThreadId)
    throw new RunnerError("VALIDATION_ERROR", "此会话没有可关联的本机项目。");
  return {
    threadId: thread.id,
    title: (thread.name || thread.preview || "未命名会话").slice(0, 200),
    cwd: thread.cwd,
    projectName: path.basename(thread.cwd) || thread.cwd,
    updatedAt: thread.updatedAt,
  };
}

// This client only reads metadata. It never attaches to, resumes, or runs a thread.
async function inspect<T>(
  options: Options,
  read: (client: CodexClient) => Promise<T>,
) {
  const client = new CodexClient(options);
  try {
    await client.connect();
    return await read(client);
  } finally {
    await client.close();
  }
}

export function listCodexSessions(options: Options, query: SessionQuery) {
  return inspect(options, async (client) => {
    const page = await client.request("thread/list", {
      cursor: query.cursor || null,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      modelProviders: [],
      archived: false,
      useStateDbOnly: true,
      ...(query.searchTerm ? { searchTerm: query.searchTerm } : {}),
    });
    return {
      sessions: page.data
        .filter(
          (thread) => thread.cwd && !thread.ephemeral && !thread.parentThreadId,
        )
        .map(sessionView),
      nextCursor: page.nextCursor,
    };
  });
}

export function fastServiceTier(model: Model | undefined) {
  if (!model) return undefined;
  return (
    model.serviceTiers?.find(({ id }) => id === "priority")?.id ??
    model.serviceTiers?.find(({ id }) => id === "fast")?.id ??
    (!model.serviceTiers && model.additionalSpeedTiers?.includes("fast")
      ? "fast"
      : undefined)
  );
}

export async function readCodexModels(client: CodexClient) {
  const models = new Map<string, Model>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page: ModelListResponse = await client.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    });
    for (const model of page.data)
      if (!model.hidden) models.set(model.model, model);
    if (!page.nextCursor) return [...models.values()];
    if (cursors.has(page.nextCursor))
      throw new RunnerError("CODEX_PROTOCOL_ERROR", "模型列表分页未推进。");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new RunnerError("CODEX_PROTOCOL_ERROR", "模型列表超出读取范围。");
}

async function projectSession(
  client: CodexClient,
  root: string,
  registeredPath: string,
) {
  const cwd = [...new Set([root, registeredPath])];
  const roots = new Set(cwd.map((value) => rootKey(path.resolve(value))));
  let cursor: string | null = null;
  let latest: Thread | undefined;
  const cursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const { data, nextCursor }: { data: Thread[]; nextCursor: string | null } =
      await client.request("thread/list", {
        cwd,
        cursor,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
        modelProviders: [],
        currentAccountOnly: true,
        archived: false,
        useStateDbOnly: true,
      });
    for (const thread of data) {
      if (
        !thread.cwd ||
        !roots.has(rootKey(path.resolve(thread.cwd))) ||
        thread.parentThreadId ||
        thread.ephemeral ||
        /^轻单\s*·\s*/u.test(thread.name ?? "")
      )
        continue;
      latest ??= thread;
      if (thread.status?.type === "active") return thread;
    }
    if (!nextCursor || cursors.has(nextCursor)) break;
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return latest;
}

export function listCodexModels(
  options: Options,
  project?: { root: string; registeredPath: string },
) {
  return inspect(options, async (client) => {
    const models = await readCodexModels(client);
    const catalog = models.map((model) => ({
      id: model.model,
      name: model.displayName,
      isDefault: !!model.isDefault,
      supportsFast: !!fastServiceTier(model),
    }));
    if (!project) return { models: catalog };
    const [{ config }, thread] = await Promise.all([
      client.request("config/read", {
        cwd: project.root,
        includeLayers: false,
      }),
      projectSession(client, project.root, project.registeredPath),
    ]);
    const projectModel = models.find((item) => item.model === thread?.model);
    const model =
      projectModel ??
      models.find((item) => item.model === config.model) ??
      models.find((item) => item.isDefault);
    const tier = fastServiceTier(model);
    const effort = projectModel
      ? (thread?.reasoningEffort ?? projectModel.defaultReasoningEffort)
      : config.model === model?.model || !config.model
        ? (config.model_reasoning_effort ?? model?.defaultReasoningEffort)
        : model?.defaultReasoningEffort;
    return {
      models: catalog,
      current: {
        model: model?.model ?? null,
        fastMode:
          !!tier && (config.service_tier ?? model?.defaultServiceTier) === tier,
        reasoningEffort: effort ?? null,
        source: projectModel ? "project" : "config",
        status: projectModel ? (thread?.status?.type ?? null) : null,
      },
    };
  });
}

export function readCodexSession(options: Options, threadId: string) {
  return inspect(options, async (client) => {
    const { thread } = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (thread.id !== threadId)
      throw new RunnerError(
        "CODEX_PROTOCOL_ERROR",
        "会话编号不匹配，请刷新列表。",
      );
    return sessionView(thread);
  });
}
