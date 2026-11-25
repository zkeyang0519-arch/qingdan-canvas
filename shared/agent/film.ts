import { z } from "zod";

export const filmId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((v) => !Object.hasOwn(Object.prototype, v));
const prose = z.string().max(64000);
export const filmGoals = ["draft", "prompt", "image", "video"] as const;
export const directorRoles = [
  "总导演",
  "美术与灯光",
  "摄影与运镜",
  "剪辑与声音",
  "提示词统筹",
] as const;
export const filmStageLabels = {
  probe: "Pi 只读验证",
  draft: "起草文稿",
  codex: "委派 Codex",
  child: "等待 Codex 稿件",
  director: "导演精修",
  review: "独立文字质检",
  plan: "整理镜头素材",
  image: "生成参考图",
  submit: "导入素材并提交成片",
  poll: "平台生成中",
  deliver: "验证原片",
} as const;
export const targetSchema = z.object({
  team: z.string().max(150).default(""),
  project: z.string().max(150).default(""),
  canvas: z.string().max(150).default(""),
  model: z.string().max(160).default(""),
  billing: z.string().max(60).default(""),
});
export const filmSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    brief: prose,
    goal: z.enum(filmGoals),
    writer: z.enum(["deepseek", "gpt", "codex"]).default("deepseek"),
    ratio: z
      .enum(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"])
      .default("9:16"),
    scriptId: filmId.nullable().default(null),
    refs: z.array(filmId).max(30).default([]),
    scriptAction: z.enum(["use", "refine"]).default("use"),
    inspiration: z.array(filmId).max(30).default([]),
    direct: z.boolean().default(false),
    replaceRef: filmId.nullable().default(null),
    pauseAfter: z.enum(["none", "script", "images"]).default("none"),
    character: z.string().max(8000).default(""),
    dialogue: z.string().max(8000).default(""),
    context: z.string().max(24000).default(""),
    style: z.string().max(3000).default(""),
    summaryRevision: z.number().int().nonnegative().nullable().default(null),
    chatId: filmId.nullable().default(null),
    sourceTodo: z
      .object({
        noteId: filmId,
        taskId: filmId,
        text: z.string().max(32000),
        generation: z.number().int().optional(),
        specRevision: z.number().int().optional(),
      })
      .nullable()
      .default(null),
    target: targetSchema.default({
      team: "",
      project: "",
      canvas: "",
      model: "",
      billing: "",
    }),
  })
  .refine((s) => new Set(s.refs).size === s.refs.length, "引用图重复");
export type FilmSpec = z.infer<typeof filmSpecSchema>;
export const needSchema = z.object({
  key: filmId,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  shots: z.array(z.string().max(80)).max(80),
  dependsOn: z.array(filmId).max(30).default([]),
  existing: filmId.nullable().default(null),
});
export type Need = z.infer<typeof needSchema>;
export const artifactSchema = z.object({
  id: filmId,
  kind: z.enum([
    "draft",
    "director",
    "final",
    "image",
    "review",
    "plan",
    "video",
  ]),
  title: z.string().min(1).max(160),
  text: prose.default(""),
  source: z.string().max(250).default("用户"),
  parents: z.array(filmId).max(64).default([]),
  mediaId: filmId.optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type FilmArtifact = z.infer<typeof artifactSchema>;
export type FilmStage = keyof typeof filmStageLabels;
export const nativeFilmTurn = z.object({
  threadId: filmId,
  requestId: filmId,
  turnId: filmId.optional(),
  model: z.string().max(160).optional(),
});
export type FilmTurn = z.infer<typeof nativeFilmTurn>;
export const waaoSubmissionSchema = z.object({
  scriptId: filmId,
  node: filmId,
  prompt: z.string().min(1).max(300_000),
  imports: z
    .array(
      z.object({
        id: filmId,
        assetId: z.string().min(1).max(256),
        node: filmId,
        position: z.number().int().min(1).max(30),
      }),
    )
    .max(30),
});
export type WaaoSubmission = z.infer<typeof waaoSubmissionSchema>;
export type FilmJob = {
  workflowVersion?: 2;
  codexTurn?: FilmTurn & { step: number; attempt: number };
  waaoSubmission?: WaaoSubmission;
  binding?: {
    ownerId: string;
    runnerId: string;
    bindingId: string;
    bindingRevision: number;
    authEpoch: number;
    workspaceId: string;
  };
  id: string;
  filmId: string;
  edit: number;
  input: FilmSpec;
  stage: FilmStage;
  state:
    | "queued"
    | "working"
    | "waiting"
    | "blocked"
    | "uncertain"
    | "done"
    | "stopped";
  step: number;
  attempt: number;
  director: number;
  adopted: string | null;
  refs: string[];
  plan: Need[];
  mapped: Record<string, string>;
  directors: string[];
  message: string;
  consumed: boolean;
  remote?: { task: string; node: string; operation: string };
  childId?: string;
  produced?: string;
  reviewId?: string;
  checkOnly?: boolean;
  stopped?: boolean;
  dispatchStarted?: boolean;
  created: number;
  updated: number;
};
export const resultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("probe"),
    session: filmId,
    message: z.string().min(1).max(500),
  }),
  z.object({ kind: z.literal("draft"), artifact: artifactSchema }),
  z.object({ kind: z.literal("director"), artifact: artifactSchema }),
  z.object({
    kind: z.literal("review"),
    passed: z.boolean(),
    artifact: artifactSchema,
  }),
  z.object({ kind: z.literal("plan"), items: z.array(needSchema).max(30) }),
  z.object({ kind: z.literal("image"), key: filmId, artifact: artifactSchema }),
  z.object({
    kind: z.literal("submit"),
    task: filmId,
    node: filmId,
    operation: filmId,
  }),
  z.object({ kind: z.literal("poll"), ready: z.boolean() }),
  z.object({ kind: z.literal("deliver"), artifact: artifactSchema }),
  z.object({ kind: z.literal("codex"), childId: filmId }),
  z.object({ kind: z.literal("pending") }),
  z.object({
    kind: z.literal("error"),
    message: z.string().min(1).max(1200),
    uncertain: z.boolean().optional(),
    temporary: z.boolean().optional(),
  }),
]);
export type FilmResult = z.infer<typeof resultSchema>;
export function nextImage(j: FilmJob) {
  return j.plan.find(
    (n) => !j.mapped[n.key] && n.dependsOn.every((k) => j.mapped[k]),
  );
}
function preview(j: FilmJob, point: "script" | "images") {
  if (!j.consumed && j.input.pauseAfter === point && j.state !== "done") {
    j.consumed = true;
    j.state = "waiting";
    j.message =
      point === "script"
        ? "定稿已就绪，请查看并继续。"
        : "参考图已就绪，请查看并继续。";
  }
}
function afterScript(j: FilmJob) {
  if (j.input.goal === "prompt" || j.input.goal === "draft") {
    j.state = "done";
    return;
  }
  j.stage = j.input.direct ? "submit" : "plan";
  preview(j, "script");
  if (j.input.direct) preview(j, "images");
}
export function newFilmJob(
  id: string,
  filmId: string,
  edit: number,
  input: FilmSpec,
  script?: FilmArtifact,
): FilmJob {
  const now = Date.now();
  const j: FilmJob = {
    workflowVersion: 2,
    id,
    filmId,
    edit,
    input,
    stage: "draft",
    state: "queued",
    step: 0,
    attempt: 0,
    director: 0,
    adopted: script?.id ?? null,
    refs: [...input.refs],
    plan: [],
    mapped: {},
    directors: [],
    message: "",
    consumed: false,
    created: now,
    updated: now,
  };
  if (input.goal === "image") {
    j.stage = "image";
    j.plan = [
      {
        key: "reference",
        name: input.title,
        description: input.brief,
        shots: [],
        dependsOn: [],
        existing: null,
      },
    ];
  } else if (
    script?.kind === "final" &&
    (input.scriptAction !== "refine" || input.direct)
  ) {
    afterScript(j);
  } else if (script) {
    if (input.goal === "draft") j.state = "done";
    else j.stage = "director";
  } else if (input.writer === "codex") j.stage = "codex";
  return j;
}
export function validFilmPlan(items: Need[], allowed: string[]) {
  const keys = new Set(items.map((i) => i.key));
  if (
    keys.size !== items.length ||
    allowed.length + items.filter((n) => !n.existing).length > 30 ||
    items.some(
      (i) =>
        (i.existing && !allowed.includes(i.existing)) ||
        i.dependsOn.some((d) => !keys.has(d)),
    )
  )
    return false;
  const done = new Set<string>();
  for (let turn = 0; turn < items.length; turn++)
    for (const item of items)
      if (item.dependsOn.every((id) => done.has(id))) done.add(item.key);
  return done.size === items.length;
}
export function applyFilmResult(current: FilmJob, r: FilmResult): FilmJob {
  const j = structuredClone(current);
  j.updated = Date.now();
  j.message = "";
  if (r.kind === "error") {
    j.state = r.uncertain ? "uncertain" : r.temporary ? "queued" : "blocked";
    j.message = r.message;
    return j;
  }
  if (r.kind === "pending") {
    if (j.stage !== "child" && j.stage !== "poll")
      throw Error("当前步骤不能轮询");
    j.state = "queued";
    return j;
  }
  if (r.kind !== j.stage && !(j.stage === "child" && r.kind === "draft"))
    throw Error("回执与制作步骤不一致");
  if ("artifact" in r) {
    const expected =
      r.kind === "deliver"
        ? "video"
        : r.kind === "review"
          ? r.passed
            ? "final"
            : "review"
          : r.kind;
    if (
      r.artifact.kind !== expected ||
      (["image", "video"].includes(expected)
        ? !r.artifact.mediaId
        : !r.artifact.text.trim())
    )
      throw Error("制作回执缺少对应的有效产物。");
  }
  j.step++;
  j.attempt = 0;
  j.state = "queued";
  j.checkOnly = false;
  switch (r.kind) {
    case "probe":
      j.state = "done";
      j.message = r.message;
      break;
    case "codex":
      j.childId = r.childId;
      j.stage = "child";
      break;
    case "draft":
      j.adopted = r.artifact.id;
      if (j.input.goal === "draft") j.state = "done";
      else j.stage = "director";
      break;
    case "director":
      j.directors.push(r.artifact.id);
      j.director++;
      if (j.director === directorRoles.length) j.stage = "review";
      break;
    case "review":
      j.reviewId = r.artifact.id;
      if (!r.passed) {
        j.state = "blocked";
        j.message = r.artifact.text.slice(0, 1200) || "导演稿需要修正";
      } else {
        j.adopted = r.artifact.id;
        afterScript(j);
      }
      break;
    case "plan":
      if (!validFilmPlan(r.items, j.input.refs))
        throw Error("素材依赖无效或参考图超过 30 张");
      j.plan = r.items;
      for (const n of r.items) if (n.existing) j.mapped[n.key] = n.existing;
      j.stage = nextImage(j) ? "image" : "submit";
      if (j.stage === "submit") preview(j, "images");
      break;
    case "image": {
      if (nextImage(j)?.key !== r.key) throw Error("图片回执与素材项不符");
      j.mapped[r.key] = r.artifact.id;
      j.refs =
        j.input.goal === "image" &&
        j.input.replaceRef &&
        j.refs.includes(j.input.replaceRef)
          ? j.refs.map((id) => (id === j.input.replaceRef ? r.artifact.id : id))
          : Array.from(new Set([...j.refs, r.artifact.id]));
      if (j.input.goal === "image") {
        j.state = "done";
        j.produced = r.artifact.id;
      } else if (!nextImage(j)) {
        j.stage = "submit";
        preview(j, "images");
      }
      break;
    }
    case "submit":
      j.remote = { task: r.task, node: r.node, operation: r.operation };
      j.stage = "poll";
      break;
    case "poll":
      if (r.ready) j.stage = "deliver";
      break;
    case "deliver":
      j.produced = r.artifact.id;
      j.state = "done";
      break;
  }
  return j;
}
