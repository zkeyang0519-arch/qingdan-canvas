import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { configured, stableId } from "../../runner/film/journal.mjs";
import { compilePrompt } from "../../runner/film/waao.mjs";
import {
  submitCanvas,
  readCanvasTask,
} from "../../runner/film/waao-canvas.mjs";
import { openWaaoMcp, useWaaoTools } from "../../runner/film/waao-mcp.mjs";
import { activityCommand } from "../../shared/agent/task-activity.mjs";

export function webWaao(login, env, http = fetch) {
  const submitting = new Map();
  const connection = {
    getToken: () => login.token(),
    onRejected: (token) => login.rejected?.(token),
    fetchImpl: http,
  };
  async function open(signal, beforeDispatch, pinnedSource = "web") {
    // Historical receipts must never move to a different account/transport.
    if (pinnedSource !== "web")
      throw Error("此历史任务使用已移除的转接连接，请在 WAAO 官网核对原任务。");
    const client = await openWaaoMcp(connection, signal, beforeDispatch);
    return { ...client, source: "web" };
  }
  const connect = async (signal, run, access, pinnedSource = "web") =>
    useWaaoTools(
      await open(
        signal,
        (packet) => {
          access?.beforeDispatch?.(packet);
          if (packet.method === "tools/call")
            access?.onProgress?.({
              message: activityCommand("mcp__waao__" + packet.params.name),
            });
        },
        pinnedSource,
      ),
      signal,
      (remote) => run({ ...remote, connectionSource: pinnedSource }),
      access?.allows,
      access?.onProgress,
    );
  return {
    connect: (signal, beforeDispatch) => open(signal, beforeDispatch),
    statusOfConnection: () => ({
      kind: "web-mcp",
      source: "web",
      configured: !!(login.status?.().configured ?? login.status?.().connected),
      connected: !!login.status?.().connected,
    }),
    connectionSource: () => "web",
    async verifyAuthorization(client, catalog, signal) {
      if (!catalog.some((tool) => tool.name === "account_get"))
        throw Object.assign(
          Error("WAAO 未提供账号核验工具，暂不能确认授权已生效。"),
          { status: 401, code: "WAAO_AUTH_UNVERIFIED" },
        );
      const result = await client.callTool("account_get", {}, { signal });
      let account = result.structuredContent;
      if (!account) {
        try {
          account = JSON.parse(
            (result.content || [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          );
        } catch {}
      }
      if (result.isError || !account?.user_id || !account.client_id)
        throw Object.assign(
          Error("WAAO 尚未确认当前账号身份，请重新完成官网授权。"),
          { status: 401, code: "WAAO_AUTH_UNVERIFIED" },
        );
      const expected = login.clientId?.();
      if (expected && account.client_id !== expected)
        throw Object.assign(
          Error("WAAO 返回的客户端与当前轻单授权不一致，请重新连接。"),
          { status: 401, code: "WAAO_CLIENT_MISMATCH" },
        );
      const scopes = Array.isArray(account.scopes)
        ? account.scopes.filter((s) => typeof s === "string")
        : [];
      return {
        verified: true,
        clientId: account.client_id,
        userId: account.user_id,
        accountLabel: account.display_name || account.handle || "当前账号",
        scopes,
        checkedAt: new Date().toISOString(),
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify([
              account.client_id,
              account.user_id,
              [...scopes].sort(),
            ]),
          )
          .digest("hex"),
      };
    },
    login: (returnTo) => login.begin(returnTo),
    finish: (params) => login.finish(params),
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
            throw Error(
              "原生成请求使用另一授权连接，请在 WAAO 官网核对原任务。",
            );
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
