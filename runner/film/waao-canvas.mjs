import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { stableId, StageFailure } from "./journal.mjs";
import {
  waaoFilmCoreTools,
  waaoUploadTools,
} from "../../shared/agent/waao-endpoint.mjs";

export function signedMediaUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.includes(".") ||
    isIP(url.hostname) ||
    url.hostname.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|lan)$/.test(url.hostname)
  )
    throw Error("WAAO 返回的媒体地址无效。");
  return url;
}

function allowedParam(schema, value) {
  if (schema?.enum) return schema.enum.includes(value);
  if (
    typeof value === "number" &&
    Number.isFinite(schema?.minimum) &&
    Number.isFinite(schema.maximum)
  )
    return value >= schema.minimum && value <= schema.maximum;
  return schema?.const === value;
}

async function checkTarget(remote, target, ratio, count) {
  if (
    !target.project ||
    !target.canvas ||
    !target.model ||
    !["personal", "team", "org"].includes(target.billing)
  )
    throw Error(
      "请指定 WAAO 项目、画布、视频服务和积分来源。可在对话里说「列出 WAAO 项目」。",
    );
  const [canvas, services, credits] = await Promise.all([
    remote.call("canvas_load", { canvas_id: target.canvas, limit: 1 }),
    remote.call("service_list", { kind: "video", service_id: target.model }),
    remote.call("credit_source_list", { project_id: target.project }),
  ]);
  if (
    canvas.canvas_id !== target.canvas ||
    canvas.project_id !== target.project ||
    canvas.read_only ||
    !["write", "admin"].includes(canvas.level)
  )
    throw Error("请选择目标项目内可编辑的 WAAO 画布。");
  const model = services.services?.find(
    (s) => s.service_id === target.model && s.kind === "video",
  );
  const caps = model?.capabilities,
    props = model?.params_schema?.properties;
  const durationOK =
    allowedParam(props?.duration, 30) ||
    caps?.durations?.includes?.(30) ||
    (caps?.duration?.min <= 30 && caps?.duration?.max >= 30);
  const ratioOK =
    allowedParam(props?.ratio, ratio) || caps?.ratios?.includes?.(ratio);
  const limit = model?.ref_limits?.max_image ?? caps?.ref_limits?.max_image;
  if (!durationOK || !ratioOK)
    throw Error("所选 WAAO 服务未声明支持 30 秒和指定画幅，请选择其他服务。");
  if (count && !(Number.isInteger(limit) && limit >= count))
    throw Error("所选 WAAO 服务未声明支持这些参考图。");
  const personal = target.billing === "personal";
  const credit = credits.sources?.find(
    (s) =>
      s.usable &&
      (personal
        ? s.kind === "personal"
        : s.kind === "org" &&
          s.org_id === target.team &&
          (s.budget_team_id || "") === (target.budgetTeam || "")),
  );
  if (!credit) throw Error("选择的 WAAO 积分来源在这个项目中不可用。");
  return personal
    ? { kind: "personal" }
    : {
        kind: "org",
        org_id: credit.org_id,
        ...(credit.budget_team_id
          ? { budget_team_id: credit.budget_team_id }
          : {}),
      };
}

async function importImage(ctx, remote, project, image) {
  const { bytes, mime } = await image.read();
  const ext = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[mime];
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (!ext || !bytes.length || (image.sha256 && image.sha256 !== sha))
    throw Error("所选原图的类型或文件摘要与归档不符。");
  const key = "web-mcp:upload:" + stableId(project, image.id, sha);
  let prior = ctx.journal.get(key),
    result;
  const ref = () => ({ project_id: project, upload_id: prior.upload });
  if (prior?.asset) return prior.asset;
  if (prior?.upload) {
    result = await remote.call("asset_upload_get", ref());
    if (result.state === "failed") prior = null;
    if (result.state === "finalizing")
      throw new StageFailure("WAAO 正在核对原图，请稍后继续。", {
        temporary: true,
      });
  }
  if (result?.state !== "ready") {
    let ticket = prior?.ticket;
    if (!prior?.sent) {
      const fileName = image.id + "." + ext;
      if (!ticket || !(Date.parse(ticket.expires_at) > Date.now())) {
        ticket = await remote.call("asset_upload_start", {
          project_id: project,
          asset_type: "image",
          file_name: fileName,
          file_size: bytes.length,
          mime_type: mime,
        });
        if (!ticket.upload_id || !["POST", "PUT"].includes(ticket.method))
          throw Error("WAAO 未签发有效的原图上传地址。");
        prior = ctx.journal.put(key, { upload: ticket.upload_id, ticket });
      }
      const options = {
        method: ticket.method,
        redirect: "error",
        signal: ctx.signal,
      };
      if (ticket.method === "PUT") {
        options.body = bytes;
        options.headers = { "Content-Type": mime };
      } else {
        const form = new FormData();
        for (const [k, v] of Object.entries(ticket.fields || {}))
          form.append(k, String(v));
        form.append("file", new Blob([bytes], { type: mime }), fileName);
        options.body = form;
      }
      const response = await ctx.http(
        signedMediaUrl(ticket.upload_url),
        options,
      );
      if (!response.ok)
        throw Error("WAAO 签名上传失败（HTTP " + response.status + "）。");
      prior = ctx.journal.put(key, { upload: ticket.upload_id, sent: true });
    }
    result = await remote.call("asset_upload_complete", ref());
  }
  if (result.state === "finalizing")
    throw new StageFailure("WAAO 正在核对原图，请稍后继续。", {
      temporary: true,
    });
  if (
    result.state !== "ready" ||
    !result.asset?.asset_id ||
    (result.asset.file_size != null && result.asset.file_size !== bytes.length)
  )
    throw Error("WAAO 未确认所选原图已经入库。");
  ctx.journal.put(key, { asset: result.asset.asset_id });
  return result.asset.asset_id;
}

function sameCredit(actual, expected) {
  return (
    actual?.kind === expected.kind &&
    (actual.org_id || "") === (expected.org_id || "") &&
    (actual.budget_team_id || "") === (expected.budget_team_id || "")
  );
}

export function matchTask(task, target, node, id) {
  return (
    !!task?.task_id &&
    (!id || task.task_id === id) &&
    task.canvas_id === target.canvas &&
    task.project_id === target.project &&
    task.node_id === node &&
    task.service_id === target.model
  );
}

// A canvas batch has no idempotency key. Recover a lost reply by reading the
// unique labels, then verify the actual IDs, edges and payload before dispatch.
async function recoverNodes(remote, canvas, labels) {
  const found = new Map();
  let offset = 0;
  for (;;) {
    const page = await remote.call("canvas_load", {
      canvas_id: canvas,
      offset,
      limit: 100,
    });
    for (const n of page.nodes || [])
      if (labels.includes(n.title)) {
        if (found.has(n.title))
          throw Error("WAAO 画布上有重名提交节点，请核对原画布。");
        found.set(n.title, n.node_id);
      }
    if (!Number.isInteger(page.next_offset) || page.next_offset <= offset)
      break;
    offset = page.next_offset;
  }
  if (!labels.every((label) => found.has(label)))
    throw new StageFailure("上次画布写入的回执尚未核实，请核对原画布。", {
      temporary: true,
    });
  return labels.map((label) => found.get(label));
}

export async function submitCanvas(
  ctx,
  remote,
  { id, target, ratio, scriptId, prompt, images, title },
) {
  const key = id + ":web-mcp",
    prior = ctx.journal.get(key) || {};
  const acknowledged = (task) => ({
    kind: "submit",
    task,
    node: prior.node,
    operation: id,
  });
  if (prior.task) return acknowledged(prior.task);
  if (prior.dispatched || ctx.checkOnly) {
    const node = prior.node || ctx.originalNode;
    if (node) {
      const status = await remote.call("node_generation_status", {
        canvas_id: target.canvas,
        node_id: node,
      });
      if (
        matchTask(status.task, target, node) &&
        (prior.dispatched || ctx.originalNode === node)
      ) {
        prior.node = node;
        prior.task = status.task.task_id;
        ctx.journal.put(key, prior);
        return acknowledged(prior.task);
      }
    }
    throw new StageFailure("WAAO 的原任务号仍待核对，请稍后查询原节点。", {
      uncertain: true,
    });
  }
  let approvalToken;
  if (prior.approval) {
    const decision = await remote.call("approval_get", {
      approval_id: prior.approval,
    });
    if (decision.status !== "approved" || !decision.approval_token)
      throw Error(
        "WAAO 积分请求 " +
          prior.approval +
          " 的状态为 " +
          decision.status +
          "，可在画布的「智能体」面板查看。",
      );
    approvalToken = decision.approval_token;
  }
  const required = [
    ...waaoFilmCoreTools,
    ...(images.length ? waaoUploadTools : []),
  ];
  for (const name of required)
    if (!remote.catalog.has(name))
      throw Error("此 WAAO 授权缺少工具 " + name + "。");
  const credit = await checkTarget(remote, target, ratio, images.length);
  const params = {
    model: target.model,
    duration: 30,
    ratio,
    credit_source: credit,
  };
  const assets = [];
  for (const image of images)
    assets.push(await importImage(ctx, remote, target.project, image));
  const refs = images.map((_, i) => "img" + (i + 1)).concat("video");
  const labels = images
    .map((image) => image.label)
    .concat(title || "短片")
    .map((label, i) => label.slice(0, 60) + " · " + id + "/" + refs[i]);
  let ids = prior.nodes;
  if (!ids && prior.preparing)
    ids = await recoverNodes(remote, target.canvas, labels);
  if (!ids) {
    prior.preparing = true;
    ctx.journal.put(key, prior);
    const changes = images.map((_, i) => ({
      op: "create",
      ref: refs[i],
      type: "image",
      data: { label: labels[i], asset_id: assets[i] },
    }));
    changes.push({
      op: "create",
      ref: "video",
      type: "video",
      data: { label: labels.at(-1), prompt, params },
    });
    changes.push(
      ...images.map((_, i) => ({ op: "connect", from: refs[i], to: "video" })),
    );
    const batch = await remote.call("canvas_apply_changes", {
      canvas_id: target.canvas,
      changes,
    });
    if (batch.skipped?.length)
      throw Error("WAAO 已跳过部分画布改动，请核对原节点。");
    ids = refs.map(
      (ref) => batch.created?.find((entry) => entry.ref === ref)?.node_id,
    );
    if (ids.some((node) => !node))
      throw Error("WAAO 未回传全部新建节点的编号。");
  }
  prior.nodes = ids;
  prior.node = ids.at(-1);
  ctx.journal.put(key, prior);
  const graph = await remote.call("canvas_elements_get", {
    canvas_id: target.canvas,
    node_ids: ids,
  });
  const byId = new Map((graph.nodes || []).map((n) => [n.node_id, n]));
  const video = byId.get(prior.node),
    inputs = ids.slice(0, -1),
    data = video?.data,
    actual = data?.params;
  const incoming = (graph.edges || []).filter((edge) => edge.to === prior.node);
  if (
    video?.kind !== "video" ||
    data?.prompt !== prompt ||
    JSON.stringify(data.inputs || []) !== JSON.stringify(inputs) ||
    actual?.model !== target.model ||
    actual.duration !== 30 ||
    actual.ratio !== ratio ||
    !sameCredit(actual.credit_source, credit) ||
    incoming.length !== inputs.length ||
    inputs.some(
      (node, i) =>
        byId.get(node)?.data?.asset_id !== assets[i] ||
        !incoming.some((e) => e.from === node),
    )
  )
    throw Error("WAAO 画布回读的提示词、参考图或生成参数与本次选择不一致。");
  const imports = images.map((img, i) => ({
    id: img.id,
    assetId: assets[i],
    node: inputs[i],
    position: i + 1,
  }));
  const submission = { scriptId, imports, prompt, node: prior.node };
  ctx.journal.put(id + ":submission", submission);
  await ctx.beforeGenerate?.(submission);
  prior.dispatched = true;
  ctx.journal.put(key, prior);
  let answer;
  try {
    answer = await remote.call("node_generate", {
      canvas_id: target.canvas,
      node_id: prior.node,
      idempotency_key: approvalToken
        ? stableId(id, "approval", prior.approval)
        : id,
      ...(approvalToken ? { approval_token: approvalToken } : {}),
    });
  } catch {
    throw new StageFailure("WAAO 生成回执尚未返回，请按原节点核对。", {
      uncertain: true,
    });
  }
  if (answer.status === "approval_required" && answer.approval_id) {
    prior.dispatched = false;
    prior.approval = answer.approval_id;
    ctx.journal.put(key, prior);
    throw Error(
      "WAAO 需要在画布的「智能体」面板批准积分请求 " +
        answer.approval_id +
        "。",
    );
  }
  if (answer.status !== "submitted" || !answer.task_id)
    throw new StageFailure("WAAO 尚未回传原任务号。", { uncertain: true });
  prior.task = answer.task_id;
  ctx.journal.put(key, prior);
  return acknowledged(prior.task);
}

export async function readCanvasTask(remote, target, node, taskId) {
  const task = await remote.call("task_get", { task_id: taskId });
  if (!matchTask(task, target, node, taskId))
    throw Error("平台任务与当前项目、画布或原视频节点不符。");
  if (task.status !== "succeeded") return { task };
  const graph = await remote.call("canvas_elements_get", {
    canvas_id: target.canvas,
    node_ids: [node],
  });
  const output = graph.nodes?.find(
    (n) => n.kind === "video" && n.node_id === node,
  );
  if (!output?.media_url || !task.asset_ids?.includes(output.data?.asset_id))
    return { task };
  return {
    task,
    assetId: output.data.asset_id,
    url: signedMediaUrl(output.media_url).href,
  };
}
