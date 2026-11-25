export const goalNames = {
  draft: "写初稿",
  prompt: "精修提示词",
  image: "做参考图",
  video: "生成 30 秒成片",
};
export const stateNames = {
  draft: "简报草稿",
  queued: "已排队",
  working: "制作中",
  waiting: "等待采用",
  blocked: "需要处理",
  uncertain: "待核对提交",
  done: "已完成",
  stopped: "已停止",
};
export const stageNames = {
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
  deliver: "验证成片",
};
export const emptyTarget = {
  team: "",
  project: "",
  canvas: "",
  model: "",
  billing: "",
};
export function filmUrl(scope, suffix = "", extra = {}) {
  return (
    "/api/agent/films" +
    suffix +
    "?" +
    new URLSearchParams({
      account: scope[0],
      canvas: scope[1],
      section: scope[2],
      ...extra,
    })
  );
}
function requestedGoal(text) {
  const positive = text.replace(
    /(?:先别|暂不|先不|不要|不用|无需|不必|不需要|别|不)(?:再|直接|另外)?(?:生成|做成|制作|做|写|给我|给|出)?(?:30\s*秒)?\s*(?:成片|短片|视频|出片|生图|参考图|图片|分镜|提示词|初稿)/gu,
    "",
  );
  const only = positive.match(
    /(?:只|仅)(?:需(?:要)?|想要?|给我|给|要|做|写|生成|拿到)?(?:一[份张版条个])?\s*(初稿|拍摄提示词|提示词|分镜|参考图|定妆图|图片|成片|短片|视频)/u,
  );
  if (only) {
    if (only[1] === "初稿") return "draft";
    if (/提示词|分镜/.test(only[1])) return "prompt";
    if (/图/.test(only[1])) return "image";
    return "video";
  }
  if (/成片|(?:做成|制作|生成).{0,5}(?:短片|视频)|出片/.test(positive))
    return "video";
  if (
    /生图|定妆图|(?:生成|做|画).{0,5}(?:图片|参考图)|只.{0,3}图/.test(positive)
  )
    return "image";
  if (/提示词|分镜|精修|改词|改稿/.test(positive)) return "prompt";
  return "draft";
}
export function draftFrom(text = "", chatId = null, target = emptyTarget) {
  const goal = requestedGoal(text);
  const writerRequest = text.replace(
    /(?:别用|不用|不需要|不要|无需)(?:使用|调用|用)?\s*(?:GPT|Codex)/gi,
    "",
  );
  const writer = writerRequest.match(
    /(?:初稿|草稿|文稿)\s*(?:用|交给|指定|让|由)\s*(GPT|Codex)|(?:^|\s|用|让|由|请|给)(GPT|Codex)\s*(?:来|负责|帮我)?\s*(?:起草|写(?!提示词)|整理(?:项目|现有)?文稿)/i,
  );
  const direct =
    goal === "video" &&
    /直接.{0,5}(出片|生成视频|做成片)/.test(text) &&
    !/(?:不|别)(?:要|用|需要)?直接/.test(text);
  return {
    title: text.trim().split(/\r?\n/)[0]?.slice(0, 36) || "",
    brief: text,
    goal,
    writer: (writer?.[1] || writer?.[2] || "deepseek").toLowerCase(),
    ratio: "9:16",
    refs: [],
    inspiration: [],
    scriptId: null,
    direct,
    pauseAfter: /先.{0,6}看图/.test(text)
      ? "images"
      : /先.{0,6}看稿/.test(text)
        ? "script"
        : "none",
    character: "",
    dialogue: "",
    context: "",
    style: "",
    sourceTodo: null,
    summaryRevision: null,
    chatId,
    target: { ...target },
  };
}
export function selectImage(spec, id, usage) {
  const refs = spec.refs.filter((r) => r !== id),
    inspiration = spec.inspiration.filter((r) => r !== id);
  if (usage === "ref") refs.push(id);
  if (usage === "inspiration") inspiration.push(id);
  return { ...spec, refs, inspiration };
}
export function swapImage(refs, index, offset) {
  const next = [...refs],
    to = index + offset;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
export async function mutateFilm(call, scope, suffix, body) {
  const slot =
    "qingdan.film-op:" +
    JSON.stringify([scope, suffix, body.action || "create"]);
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body)),
    ),
  );
  const hash = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  let last;
  try {
    last = JSON.parse(sessionStorage.getItem(slot) || "null");
  } catch {}
  const requestId = last?.hash === hash ? last.requestId : crypto.randomUUID();
  try {
    sessionStorage.setItem(slot, JSON.stringify({ hash, requestId }));
  } catch {}
  const result = await call(filmUrl(scope, suffix), {
    method: "POST",
    body: { ...body, requestId },
  });
  try {
    sessionStorage.removeItem(slot);
  } catch {}
  return result;
}
