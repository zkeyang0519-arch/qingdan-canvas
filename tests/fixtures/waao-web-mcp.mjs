import assert from "node:assert/strict";
import { waaoMcpUrl } from "../../runner/film/waao-mcp.mjs";

export const webTarget = {
  team: "org-account",
  project: "project",
  canvas: "canvas",
  model: "video-model",
  billing: "org",
};
export const webEnv = {
  QINGDAN_WAAO_MCP_TOKEN: "fixture",
  QINGDAN_WAAO_TEAM: webTarget.team,
  QINGDAN_WAAO_PROJECT: webTarget.project,
  QINGDAN_WAAO_CANVAS: webTarget.canvas,
  QINGDAN_WAAO_MODEL: webTarget.model,
  QINGDAN_WAAO_BILLING: webTarget.billing,
};

// An in-memory implementation of the vendor's public MCP envelopes, plus the
// one-use storage URL the upload tool returns. Only tests import this module.
export function waaoFixture({ onUpload, onGenerate, onRead, video } = {}) {
  const nodes = [],
    edges = [],
    uploads = [],
    calls = [];
  let task,
    submitted = 0;
  const tools = {
    account_get: () => ({
      user_id: "fixture-user",
      client_id: "fixture-client",
      display_name: "测试账号",
      scopes: ["read", "canvas:write", "generate"],
    }),
    project_list: () => ({
      projects: [
        { name: "试映", level: "write", project_id: webTarget.project },
      ],
    }),
    project_get: () => ({
      project: { project_id: webTarget.project },
      canvases: [{ canvas_id: webTarget.canvas, name: "短片" }],
    }),
    canvas_load: () => ({
      canvas_id: webTarget.canvas,
      project_id: webTarget.project,
      level: "write",
      read_only: false,
      nodes,
    }),
    service_list: () => ({
      services: [
        {
          kind: "video",
          service_id: webTarget.model,
          label: "30 秒视频",
          ref_limits: { max_image: 4 },
          params_schema: {
            properties: {
              duration: { minimum: 4, maximum: 30 },
              ratio: { enum: ["9:16", "16:9"] },
            },
          },
        },
      ],
    }),
    credit_source_list: () => ({
      sources: [
        { kind: "org", org_id: webTarget.team, usable: true, name: "组织积分" },
      ],
    }),
    asset_upload_start: (a) => {
      assert.equal(a.project_id, webTarget.project);
      const id = "up" + (uploads.length + 1);
      uploads.push({ id, size: a.file_size });
      return {
        upload_id: id,
        upload_url: "https://upload.example.org/" + id,
        method: uploads.length % 2 ? "POST" : "PUT",
        fields: { policy: "fixture" },
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
    },
    asset_upload_get: (a) => ({
      state: "ready",
      asset: { asset_id: a.upload_id },
    }),
    asset_upload_complete: (a) => {
      const upload = uploads.find((u) => u.id === a.upload_id);
      assert.equal(upload.size, upload.bytes.length);
      return {
        state: "ready",
        asset: { asset_id: upload.id, file_size: upload.size },
      };
    },
    canvas_apply_changes: (a) => {
      assert.equal(a.canvas_id, webTarget.canvas);
      const refs = new Map();
      for (const c of a.changes) {
        if (c.op === "create") {
          const n = {
            node_id: "node-" + (nodes.length + 1),
            kind: c.type,
            title: c.data.label,
            data: { ...c.data, inputs: [] },
          };
          refs.set(c.ref, n);
          nodes.push(n);
        } else {
          assert.equal(c.op, "connect");
          edges.push({
            from: refs.get(c.from).node_id,
            to: refs.get(c.to).node_id,
          });
          refs.get(c.to).data.inputs.push(refs.get(c.from).node_id);
        }
      }
      return {
        created: [...refs].map(([ref, n]) => ({ ref, node_id: n.node_id })),
        skipped: [],
      };
    },
    canvas_elements_get: (a) => {
      onRead?.(nodes, edges);
      return {
        nodes: nodes.filter((n) => a.node_ids.includes(n.node_id)),
        edges,
      };
    },
    node_generate: (a) => {
      submitted++;
      const node = nodes.find((n) => n.node_id === a.node_id);
      assert.ok(node);
      task = {
        task_id: "real-protocol-task",
        node_id: a.node_id,
        project_id: webTarget.project,
        canvas_id: webTarget.canvas,
        service_id: webTarget.model,
        status: video ? "succeeded" : "running",
        asset_ids: video ? ["video-file"] : [],
      };
      if (video) {
        node.data.asset_id = "video-file";
        node.media_url = "https://cdn.example.org/video";
      }
      onGenerate?.(a);
      return { status: "submitted", task_id: task.task_id };
    },
    task_get: (a) => {
      assert.equal(a.task_id, task.task_id);
      return task;
    },
    node_generation_status: () => ({ task }),
  };
  const http = async (url, options = {}) => {
    const dest = new URL(url);
    if (dest.hostname === "upload.example.org") {
      assert.equal(new Headers(options.headers).has("authorization"), false);
      const upload = uploads.find((u) => "/" + u.id === dest.pathname);
      upload.bytes = Buffer.from(
        options.method === "PUT"
          ? options.body
          : await options.body.get("file").arrayBuffer(),
      );
      await onUpload?.(upload.bytes, uploads.indexOf(upload));
      return new Response(null, { status: 204 });
    }
    if (dest.hostname === "cdn.example.org") {
      assert.equal(new Headers(options.headers).has("authorization"), false);
      return new Response(video);
    }
    assert.equal(dest.href, waaoMcpUrl);
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer fixture",
    );
    if (options.method === "GET") return new Response(null, { status: 405 });
    const req = JSON.parse(options.body);
    const res = (result) =>
      Response.json({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "initialize")
      return res({
        protocolVersion: req.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "waao-test", version: "1" },
      });
    if (req.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    if (req.method === "tools/list") {
      const entries = Object.keys(tools),
        first = !req.params?.cursor;
      return res({
        tools: (first ? entries.slice(0, 5) : entries.slice(5)).map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
        ...(first ? { nextCursor: "p2" } : {}),
      });
    }
    assert.equal(req.method, "tools/call");
    calls.push(req.params.name);
    const data = await tools[req.params.name](req.params.arguments);
    return res({
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    });
  };
  return {
    http,
    nodes,
    edges,
    uploads,
    calls,
    get submitted() {
      return submitted;
    },
  };
}
