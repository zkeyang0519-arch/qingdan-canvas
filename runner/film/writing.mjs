import { requestPi } from "./pi-session.mjs";
import { artifact, inputText } from "./journal.mjs";
import {
  buildModelData,
  buildSystemPrompt,
  callModel,
  parseModelResponse,
  validateModelUrl,
} from "./director/provider.mjs";
import { completeRevisionMetadata } from "./director/revision-metadata.mjs";
import { runFilmCodex } from "./codex.mjs";
import {
  DEFAULT_INPUT,
  REVISION_NODES,
  prepareDraft,
  validateOutput,
} from "./director/workflow.mjs";
import { needSchema, validFilmPlan } from "../../shared/agent/film.ts";

const draftParameters = {
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: 64000 } },
  required: ["text"],
  additionalProperties: false,
};
const planParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          shots: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
          existing: { type: ["string", "null"] },
        },
        required: [
          "key",
          "name",
          "description",
          "shots",
          "dependsOn",
          "existing",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export async function piWriting(ctx) {
  if (!ctx.env.DEEPSEEK_API_KEY)
    throw Error("当前设备未配置 DeepSeek。请设置 DEEPSEEK_API_KEY。");
  const { job, journal } = ctx,
    planning = job.stage === "plan";
  let result;
  const tool = {
    name: planning ? "save_asset_plan" : "save_draft",
    label: planning ? "保存镜头素材清单" : "保存短片初稿",
    description: planning
      ? "按定稿列出必须使用或需要补齐的静态参考图，复用相同人物和道具。existing 可以引用提供的图版，dependsOn 只写本清单内的素材 key。"
      : "保存完整的 30 秒中文短片初稿，包括角色、分镜时段、动作和固定对白。",
    parameters: planning ? planParameters : draftParameters,
    execute: async (_id, body) => {
      if (result)
        return {
          content: [{ type: "text", text: "本步成果已保存。" }],
          details: {},
        };
      if (planning) {
        const items = needSchema.array().max(30).parse(body.items);
        if (!validFilmPlan(items, job.input.refs))
          throw Error("现有素材编号或依赖无效，请修正。");
        result = { kind: "plan", items };
      } else {
        const text = String(body.text ?? "").trim();
        if (!text || text.length > 64000) throw Error("请提交完整初稿。");
        result = {
          kind: "draft",
          artifact: artifact(
            ctx,
            "draft",
            "DeepSeek 初稿",
            text,
            "DeepSeek / deepseek-v4-pro",
          ),
        };
      }
      journal.put(ctx.key + ":result", result);
      return {
        content: [{ type: "text", text: "成果已保存，可以结束本轮。" }],
        details: { saved: true },
      };
    },
  };
  const refs = ctx.artifacts
    .filter((a) => job.input.refs.includes(a.id))
    .map((a) => ({ id: a.id, title: a.title }));
  const request = planning
    ? JSON.stringify({
        brief: inputText(job.input),
        script: ctx.find(job.adopted).text,
        refs,
      })
    : inputText(job.input);
  try {
    await requestPi(
      ctx,
      [tool],
      request + "\n请实际调用 " + tool.name + " 交付本步。",
    );
  } catch (e) {
    if (!result) throw e;
  }
  if (!result) throw Error("DeepSeek 未交回有效的" + tool.label + "工具回执。");
  return result;
}
export async function gptDraft(ctx) {
  const env = ctx.env,
    key = env.QINGDAN_GPT_API_KEY || env.OPENAI_API_KEY,
    model = env.QINGDAN_GPT_MODEL;
  if (!key || !model) throw Error("请为 GPT 初稿配置 API Key 和模型名称。");
  const url = validateModelUrl(
    env.QINGDAN_GPT_BASE_URL || "https://api.openai.com/v1",
  );
  const res = await ctx.http(url, {
    method: "POST",
    redirect: "error",
    signal: ctx.signal,
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "按用户要求写可交导演台的完整 30 秒中文初稿，分镜连续覆盖 0 到 30 秒，保留固定对白。",
        },
        { role: "user", content: inputText(ctx.job.input) },
      ],
    }),
  });
  if (!res.ok) throw Error("GPT 初稿服务返回 HTTP " + res.status + "。");
  const choice = (await res.json()).choices?.[0],
    text = choice?.message?.content?.trim();
  if (!text || text.length > 64000 || choice.finish_reason === "length")
    throw Error("GPT 初稿为空、过长或被截断。");
  return {
    kind: "draft",
    artifact: artifact(ctx, "draft", "GPT 初稿", text, "GPT / " + model),
  };
}
export async function directWriting(ctx, codex = runFilmCodex) {
  const { job, env } = ctx,
    script = ctx.find(job.adopted);
  const input = {
    ...DEFAULT_INPUT,
    title: job.input.title,
    initialPrompt: script.text,
    ipText: job.input.character,
    brief: inputText(job.input),
    aspectRatio: job.input.ratio,
    executionMode: "live",
  };
  const outputs = { prepare_draft: prepareDraft(input) };
  for (const id of job.directors) {
    const a = ctx.find(id);
    outputs[a.details.nodeId] = a.details.output;
  }
  const nodeId =
    job.stage === "review" ? "review_prompt" : REVISION_NODES[job.director];
  const connection = {
    baseUrl: env.QINGDAN_DIRECTOR_BASE_URL || "https://api.deepseek.com",
    apiKey: env.QINGDAN_DIRECTOR_API_KEY || env.DEEPSEEK_API_KEY,
    model: env.QINGDAN_DIRECTOR_MODEL || "deepseek-v4-pro",
  };
  let raw, origin;
  if (job.workflowVersion === 2) {
    const genre =
      outputs.chief_director?.genre_id ||
      (input.director === "auto" ? undefined : input.director);
    const data = buildModelData(nodeId, input, outputs);
    const result = await codex(ctx, {
      kind: "text",
      instructions: buildSystemPrompt(nodeId, genre),
      prompt: JSON.stringify(data),
    });
    raw = completeRevisionMetadata(
      parseModelResponse(result.text),
      data.current_draft,
      nodeId,
    );
    origin = result.origin;
  } else {
    if (!connection.apiKey) throw Error("旧版导演步骤需要原文本连接。");
    raw = await callModel({
      nodeId,
      input,
      outputs,
      connection,
      signal: ctx.signal,
      fetchImpl: ctx.http,
    });
  }
  const output = validateOutput(nodeId, raw, { input, outputs });
  const parents = [job.directors.at(-1) || script.id],
    details = {
      nodeId,
      model: origin?.model || connection.model,
      ...(origin ? { codex: origin } : {}),
      rules: "director-v3",
      output,
      referenceOrder: job.input.refs,
    };
  if (job.stage === "director")
    return {
      kind: "director",
      artifact: artifact(
        ctx,
        "director",
        ["总导演", "美术与灯光", "摄影与运镜", "剪辑与声音", "提示词统筹"][
          job.director
        ] + "稿",
        output.draft,
        origin ? "Codex · 镜序导演精修" : "镜序导演台",
        { parents, details },
      ),
    };
  const film = outputs.generate_prompt.draft;
  const fixed = job.input.dialogue
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const missing = fixed.filter((line) => !film.includes(line));
  for (const line of missing)
    output.issues.push({
      severity: "blocking",
      location: "固定对白",
      reason: "定稿缺少原句　" + line,
    });
  const passed =
    output.passed && !output.issues.some((i) => i.severity === "blocking");
  return {
    kind: "review",
    passed,
    artifact: artifact(
      ctx,
      passed ? "final" : "review",
      passed ? "已通过质检的导演定稿" : "质检待修",
      passed
        ? film
        : output.issues
            .map((i) => [i.location, i.reason].filter(Boolean).join(" · "))
            .join("\n") || "请核对导演稿。",
      origin ? "Codex · 镜序独立质检" : "镜序独立质检",
      { parents, details },
    ),
  };
}
