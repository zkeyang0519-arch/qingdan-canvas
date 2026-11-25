import { readFile } from "node:fs/promises";
import { configured, stableId } from "../../runner/film/journal.mjs";
import { compilePrompt } from "../../runner/film/waao.mjs";
import {
  submitCanvas,
  readCanvasTask,
} from "../../runner/film/waao-canvas.mjs";
import { openWaaoMcp, useWaaoTools } from "../../runner/film/waao-mcp.mjs";

export function webWaao(login, env, http = fetch, fromCodex) {
  const submitting = new Map();
  let source = fromCodex ? null : "web";
  let preference = "auto";
  let healthy = false,
    requestedWeb = false;
  const connection = {
    getToken: () => login.token(),
    onRejected: (token) => login.rejected?.(token),
    fetchImpl: http,
  };
  // Choose credentials during a read-only probe. Pin the chosen provider for
  // execution; an ambiguous write must never be retried through another account.
  async function probe(signal) {
    if (fromCodex && !requestedWeb && preference !== "web") {
      try {
        const client = await fromCodex.connect(signal);
        source = "codex";
        healthy = true;
        return client;
      } catch (error) {
        signal.throwIfAborted();
        healthy = false;
        if (
          preference === "codex" ||
          source === "codex" ||
          (!login.status?.().connected &&
            ![
              "ENOENT",
              "WAAO_CODEX_MISSING",
              "CODEX_VERSION_MISMATCH",
            ].includes(error.code))
        ) {
          throw error;
        }
      }
    }
    const client = await openWaaoMcp(connection, signal);
    try {
      const catalog = await client.listTools({ signal });
      source = "web";
      healthy = true;
      requestedWeb = false;
      return { ...client, source, listTools: async () => catalog };
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  async function open(signal, beforeDispatch, pinnedSource = source) {
    if (pinnedSource !== "codex") {
      const client = await openWaaoMcp(connection, signal, beforeDispatch);
      return { ...client, source: "web" };
    }
    if (!fromCodex)
      throw Object.assign(Error("原任务的 Codex 授权连接不可用。"), {
        code: "WAAO_CODEX_MISSING",
      });
    try {
      return await fromCodex.connect(signal, beforeDispatch);
    } catch (error) {
      if (!signal.aborted) healthy = false;
      throw error;
    }
  }
  const connect = async (signal, run, access, pinnedSource = source) =>
    useWaaoTools(
      await open(signal, access?.beforeDispatch, pinnedSource),
      signal,
      (remote) => run({ ...remote, connectionSource: pinnedSource }),
      access?.allows,
    );
  return {
    setConnectionPreference(value) {
      if (!["auto", "web", "codex"].includes(value))
        throw Error("WAAO 连接来源无效。");
      preference = value;
      if (value !== "auto") {
        source = value;
        healthy = false;
        requestedWeb = value === "web";
      }
    },
    connectionPreference: () => preference,
    maintenanceStatus: () =>
      source === "web" ? null : fromCodex?.maintenanceStatus?.(),
    retryMaintenance: () => fromCodex?.retryMaintenance?.(),
    connect: (signal, beforeDispatch, scope) =>
      !beforeDispatch && !scope ? probe(signal) : open(signal, beforeDispatch),
    statusOfConnection: () => ({
      kind: "web-mcp",
      source,
      connected: source === "codex" ? healthy : !!login.status?.().connected,
    }),
    connectionSource: () => source,
    async login() {
      if (preference !== "web" && source === "codex" && healthy)
        return { connected: true };
      const out = await login.begin();
      if (!out.url) requestedWeb = true;
      return out;
    },
    async finish(params) {
      await login.finish(params);
      requestedWeb = true;
    },
    capabilities: (signal) =>
      connect(signal, (remote) => ({ tools: [...remote.catalog.keys()] })),
    targets: (args, signal, access) =>
      connect(
        signal,
        async (remote) => {
          if (!args.project && !args.projectPath) {
            const list = await remote.call(
              "project_list",
              args.query ? { query: args.query } : {},
            );
            return {
              projects: (list.projects || [])
                .filter(
                  (p) => !p.archived && ["write", "admin"].includes(p.level),
                )
                .map((p) => ({ id: p.project_id, name: p.name, path: p.path })),
              truncated: list.truncated,
            };
          }
          const info = args.projectPath
            ? await remote.call("project_resolve", { path: args.projectPath })
            : await remote.call("project_get", { project_id: args.project });
          const project = info.project.project_id;
          const [credits, services] = await Promise.all([
            remote.call("credit_source_list", { project_id: project }),
            remote.call("service_list", { kind: "video" }),
          ]);
          return {
            project,
            canvases: (info.canvases || []).map((c) => ({
              id: c.canvas_id,
              name: c.name,
            })),
            credits: (credits.sources || [])
              .filter((c) => c.usable)
              .map((c) => ({
                name: c.name,
                billing: c.kind,
                team: c.org_id,
                budgetTeam: c.budget_team_id,
              })),
            models: (services.services || [])
              .filter((s) => s.kind === "video")
              .map((s) => ({ id: s.service_id, name: s.label })),
          };
        },
        access,
      ),
    submit: ({
      journal,
      chatId,
      draft,
      image,
      groupOrder,
      signal,
      target: specified,
      ratio = "9:16",
      edition,
      access,
    }) =>
      connect(
        signal,
        async (remote) => {
          const target = { ...configured(env).target, ...specified };
          const prompt = compilePrompt(
            draft.text,
            [image.id],
            [],
            {},
            [{ id: image.id, title: image.label }],
            draft.referenceOrder || groupOrder,
          );
          const id = stableId(
            "web-mcp",
            chatId,
            draft.id,
            image.id,
            target.project,
            target.canvas,
            target.model,
            target.billing,
            target.team || "",
            target.budgetTeam || "",
            ratio,
            ...(edition ? [edition] : []),
          );
          const sourceKey = "waao-source:" + id;
          const originalSource = journal.get(sourceKey);
          if (
            originalSource &&
            originalSource.source !== remote.connectionSource
          )
            throw Error("原生成请求使用另一授权连接，请切回原连接核对结果。");
          if (!originalSource)
            journal.put(sourceKey, { source: remote.connectionSource });
          if (!submitting.has(id)) {
            const work = submitCanvas({ journal, http, signal }, remote, {
              id,
              target,
              ratio,
              scriptId: draft.id,
              prompt,
              title: draft.label,
              images: [
                {
                  id: image.id,
                  label: image.label,
                  sha256: image.sha256,
                  read: async () => ({
                    bytes: await readFile(image.file),
                    mime: image.mime,
                  }),
                },
              ],
            });
            submitting.set(
              id,
              work.finally(() => submitting.delete(id)),
            );
          }
          const result = await submitting.get(id);
          const receipt = {
            connectionSource: remote.connectionSource,
            id: result.task,
            node: result.node,
            target,
            label: "WAAO 已受理 · " + result.task,
            status: "submitted",
            duration: 30,
            draftId: draft.id,
            draftLabel: draft.label,
            assetId: image.id,
            assetLabel: image.label,
            sha256: image.sha256,
            prompt,
          };
          return receipt;
        },
        access,
      ),
    status: (receipt, signal, access) =>
      connect(
        signal,
        async (remote) => {
          const result = await readCanvasTask(
            remote,
            receipt.target,
            receipt.node,
            receipt.id,
          );
          return {
            ...receipt,
            status: result.task.status,
            playable: !!result.url,
          };
        },
        access,
        receipt.connectionSource,
      ),
    video: (receipt, signal) =>
      connect(
        signal,
        async (remote) =>
          (
            await readCanvasTask(
              remote,
              receipt.target,
              receipt.node,
              receipt.id,
            )
          ).url,
        undefined,
        receipt.connectionSource,
      ),
  };
}
