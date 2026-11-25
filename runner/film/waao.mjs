import { configured, stableId, StageFailure, artifact } from "./journal.mjs";
import { mediaInput, archive, writeBytes, boundedBytes } from "./media.mjs";
import { submitCanvas, readCanvasTask } from "./waao-canvas.mjs";
import { withWaaoMcp } from "./waao-mcp.mjs";

export function compilePrompt(
  script,
  refs,
  plan,
  mapped,
  artifacts,
  originalOrder = [],
) {
  const positions = new Map(refs.map((id, index) => [id, index + 1]));
  const compiled = script
    .replace(/@图片\s*(\d+)/g, (label, digits) => {
      const before = originalOrder[Number(digits) - 1];
      const replacement =
        before &&
        refs.find((id) =>
          artifacts.find((a) => a.id === id)?.parents?.includes(before),
        );
      const n = originalOrder.length
        ? positions.get(before) || positions.get(replacement)
        : Number(digits);
      if (!Number.isInteger(n) || n < 1 || n > refs.length)
        throw Error(
          "定稿中的 " + label + " 缺少对应的已选参考图，请重新指定图号。",
        );
      return "@图片" + n;
    })
    .replace(/\{\{asset:([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => {
      const n = positions.get(mapped[key]);
      if (!n) throw Error("定稿中的素材 " + key + " 尚未映射。");
      return "@图片" + n;
    });
  const indexed = refs.map((id, i) => {
    const uses = plan.filter((n) => mapped[n.key] === id);
    const title = artifacts.find((a) => a.id === id)?.title || "参考图";
    return (
      "@图片" +
      (i + 1) +
      "　" +
      (uses.length
        ? uses
            .map(
              (n) =>
                n.name +
                (n.shots.length ? "（" + n.shots.join("、") + "）" : ""),
            )
            .join(" / ")
        : title)
    );
  });
  return (
    compiled +
    (indexed.length ? "\n\n参考素材与镜头\n" + indexed.join("\n") : "")
  );
}

function runnerConnection(ctx, run) {
  const configuredTarget = configured(ctx.env).target;
  const target = ctx.job.input.target;
  if (
    ["team", "project", "canvas", "model", "billing"].some(
      (k) => target[k] !== configuredTarget[k],
    )
  )
    throw Error("当前视频版本的 WAAO 目标与设备配置不符。");
  return withWaaoMcp(
    { token: ctx.env.QINGDAN_WAAO_MCP_TOKEN, fetchImpl: ctx.http },
    ctx.signal,
    run,
  );
}

export async function submitVideo(ctx) {
  const { job, journal } = ctx,
    script = ctx.find(job.adopted);
  const duration =
    script.source === "用户" &&
    script.text.match(
      /(?:总时长|全片时长|片长)\s*[：:]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/i,
    );
  if (duration && Number(duration[1]) !== 30)
    throw Error("用户定稿的时长与本版的 30 秒目标不符。");
  const prompt = compilePrompt(
    script.text,
    job.refs,
    job.plan,
    job.mapped,
    ctx.artifacts,
    script.details?.referenceOrder,
  );
  const images = job.refs.map((id) => ({
    id,
    label: ctx.find(id).title,
    read: () => mediaInput(ctx, id),
  }));
  return runnerConnection(ctx, (remote) =>
    submitCanvas(
      {
        journal,
        http: ctx.http,
        signal: ctx.signal,
        checkOnly: job.checkOnly || job.stopped || job.dispatchStarted,
        originalNode: job.waaoSubmission?.node,
        beforeGenerate: (submission) =>
          ctx.cloud("begin-submit", { submission }),
      },
      remote,
      {
        id: job.id,
        target: job.input.target,
        ratio: job.input.ratio,
        scriptId: job.adopted,
        prompt,
        images,
        title: job.input.title,
      },
    ),
  );
}

export async function checkVideo(ctx, deliver = false) {
  const { job } = ctx,
    remote = job.remote;
  const output = await runnerConnection(ctx, (mcp) =>
    readCanvasTask(mcp, job.input.target, remote.node, remote.task),
  );
  if (["failed", "stopped", "cancelled"].includes(output.task.status))
    throw Error("WAAO 任务已停止或失败（" + output.task.status + "）。");
  if (!deliver) return { kind: "poll", ready: !!output.url };
  if (!output.url)
    throw new StageFailure("正在等待 WAAO 交付原片。", { temporary: true });
  const key = job.id + ":video-file",
    id = stableId(job.id, "video-file");
  let file = ctx.journal.get(key);
  if (!file) {
    const response = await ctx.http(output.url, {
      redirect: "error",
      signal: ctx.signal,
    });
    file = await writeBytes(
      ctx,
      id,
      await boundedBytes(response, 256 * 1024 * 1024),
    );
    ctx.journal.put(key, file);
  }
  const media = await archive(ctx, id, file, true);
  return {
    kind: "deliver",
    artifact: artifact(
      ctx,
      "video",
      job.input.title + " · 30 秒原片",
      "",
      "WAAO",
      {
        mediaId: id,
        parents: [job.adopted, ...job.refs],
        details: {
          ...media,
          assetId: output.assetId,
          ...remote,
          target: job.input.target,
          submission:
            ctx.journal.get(job.id + ":submission") ?? job.waaoSubmission,
          billingState: output.task.status,
        },
      },
    ),
  };
}
