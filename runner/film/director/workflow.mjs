import { inspectDraft } from "./prompt-contract.mjs";
import { extractSourceAnchor } from "./draft-intake.mjs";
export const GENRES = [
  {
    id: "narrative",
    name: "角色剧情",
    en: "NARRATIVE",
    description: "让性格，在故事里被看见",
    color: "#9885d4",
    icon: "film",
  },
  {
    id: "documentary",
    name: "纪实观察",
    en: "DOCUMENTARY",
    description: "走近生活，保留真实的呼吸",
    color: "#559b80",
    icon: "scan",
  },
  {
    id: "variety",
    name: "综艺互动",
    en: "VARIETY",
    description: "任务、关系与意料之外的反应",
    color: "#d09951",
    icon: "sparkles",
  },
  {
    id: "explainer",
    name: "知识演示",
    en: "EXPLAINER",
    description: "把复杂的事情，讲得看得懂",
    color: "#619ac0",
    icon: "lightbulb",
  },
  {
    id: "visual",
    name: "视觉表达",
    en: "VISUAL",
    description: "用光线、质感与节奏留下印象",
    color: "#c38393",
    icon: "aperture",
  },
];
export const TEAM = [
  {
    id: "chief_director",
    name: "总导演",
    responsibility: "故事因果与角色表演",
    file: "roles/chief_director.md",
    color: "#9885d4",
  },
  {
    id: "art_lighting",
    name: "场景美术与灯光导演",
    responsibility: "空间、道具与具体布光",
    file: "roles/art_lighting.md",
    color: "#b18a5b",
  },
  {
    id: "cinematography",
    name: "摄影与运镜导演",
    responsibility: "景别、运动与画面落点",
    file: "roles/cinematography.md",
    color: "#619ac0",
  },
  {
    id: "editing_sound",
    name: "剪辑与声音导演",
    responsibility: "时间轴、切点与声画关系",
    file: "roles/editing_sound.md",
    color: "#559b80",
  },
  {
    id: "generate_prompt",
    name: "提示词统筹与质检",
    responsibility: "整理全文，再单次核对",
    file: "roles/prompt_editor.md",
    color: "#c38393",
  },
];
export const REVISION_NODES = TEAM.map((role) => role.id);
export const MODEL_NODES = [...REVISION_NODES, "review_prompt"];
export const FLOW_NODES = ["prepare_draft", ...MODEL_NODES];
export const NODE_IDS = [
  ...FLOW_NODES,
  "deliver",
  "report_input",
  "report_unresolved",
];
export const NODE_LABELS = {
  prepare_draft: "导入并锁定原稿",
  chief_director: "总导演改稿",
  art_lighting: "场景与灯光改稿",
  cinematography: "摄影与运镜改稿",
  editing_sound: "剪辑与声音改稿",
  generate_prompt: "提示词统筹精修",
  review_prompt: "单次质量检查",
  deliver: "交付提示词",
  report_input: "完善原稿输入",
  report_unresolved: "查看待解决问题",
};
export const ROLE_FILES = Object.fromEntries([
  ...TEAM.map((role) => [role.id, role.file]),
  ["review_prompt", "roles/prompt_editor.md"],
]);
export const PROMPT_FILES = [
  "common.md",
  "revision_contract.md",
  "output_contract.md",
  "generate_video_prompt.md",
  "review_video_prompt.md",
  ...GENRES.map((g) => "directors/" + g.id + ".md"),
  ...TEAM.map((r) => r.file),
];
export const DEFAULT_INPUT = {
  title: "未命名改稿",
  initialPrompt: "",
  ipText: "",
  brief: "",
  duration: 30,
  aspectRatio: "9:16",
  director: "auto",
  executionMode: "demo",
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && !!value.trim();
const sanitizeInput = (value) => {
  const result = Object.fromEntries(
    Object.keys(DEFAULT_INPUT).map((key) => [
      key,
      value?.[key] ?? DEFAULT_INPUT[key],
    ]),
  );
  for (const key of ["title", "initialPrompt", "ipText", "brief"])
    if (typeof result[key] !== "string")
      throw new Error("项目输入必须是文本。");
  if (
    !["demo", "live"].includes(result.executionMode) ||
    !["9:16", "16:9", "1:1", "4:3"].includes(result.aspectRatio) ||
    !["auto", ...GENRES.map((d) => d.id)].includes(result.director) ||
    !Number.isFinite(Number(result.duration)) ||
    Number(result.duration) < 1 ||
    Number(result.duration) > 600
  )
    throw new Error("项目的时长、画幅、模式或拍摄类型无效。");
  result.duration = Number(result.duration);
  return result;
};
const freshNodes = () =>
  Object.fromEntries(
    NODE_IDS.map((id) => [id, { status: "pending", durationMs: 0 }]),
  );
const terminalStatus = {
  deliver: "completed",
  report_input: "needs_input",
  report_unresolved: "needs_revision",
};
const freshState = (input) => ({
  schemaVersion: 3,
  input: sanitizeInput(input),
  cursor: "prepare_draft",
  status: "idle",
  outputs: {},
  nodes: freshNodes(),
  snapshots: {},
  path: [],
  history: [],
  revisions: [],
  promptOverrides: {},
  finalPrompt: "",
  error: "",
  legacyArchive: null,
  updatedAt: Date.now(),
});
const cleanNodes = (value) => {
  if (!record(value)) throw new Error("项目节点记录无效。");
  const result = freshNodes();
  for (const [id, node] of Object.entries(value)) {
    if (
      !NODE_IDS.includes(id) ||
      !record(node) ||
      !["pending", "running", "completed", "error", "paused"].includes(
        node.status,
      )
    )
      throw new Error("项目节点状态无效。");
    result[id] = {
      status: node.status === "running" ? "paused" : node.status,
      durationMs: Number.isFinite(node.durationMs)
        ? Math.max(0, node.durationMs)
        : 0,
    };
  }
  return result;
};

export function extractAnchor(draft) {
  const text = String(draft || "").replace(/\r\n/g, "\n");
  const match =
    /^[ \t]*(?:#{1,6}[ \t]+)?【全局角色锚定】[ \t]*\n([\s\S]*?)(?=^[ \t]*(?:#{1,6}[ \t]+)?【运镜铁律（全局）】)/m.exec(
      text,
    );
  if (!match) return "";
  // The last scene label separates the immutable anchor from the episode's scene.
  const scenes = [...match[1].matchAll(/^[ \t]*场景[：:]/gm)];
  return scenes.length ? match[1].slice(0, scenes.at(-1).index).trim() : "";
}
export function prepareDraft(input) {
  if (!nonempty(input.initialPrompt))
    return {
      input_status: "needs_input",
      input_issues: ["请粘贴或导入初稿、分镜稿或视频提示词。"],
    };
  const locked_anchor =
    extractAnchor(input.initialPrompt) ||
    extractSourceAnchor(input.initialPrompt) ||
    extractSourceAnchor(input.ipText);
  return {
    input_status: "ready",
    locked_anchor,
    duration_seconds: Number(input.duration),
    input_issues: [],
  };
}
export function lockedAnchor(outputs) {
  return (
    outputs.prepare_draft?.locked_anchor ||
    extractAnchor(outputs.chief_director?.draft)
  );
}
export function previousDraft(nodeId, input, outputs) {
  const index = REVISION_NODES.indexOf(nodeId);
  const upstream =
    nodeId === "review_prompt"
      ? REVISION_NODES
      : REVISION_NODES.slice(0, Math.max(index, 0));
  return (
    [...upstream]
      .reverse()
      .map((id) => outputs[id]?.draft)
      .find(nonempty) || input.initialPrompt
  );
}
export function currentDraft({ input, outputs }) {
  return (
    [...REVISION_NODES]
      .reverse()
      .map((id) => outputs[id]?.draft)
      .find(nonempty) ||
    input.initialPrompt ||
    ""
  );
}
export function requireUpstream(nodeId, outputs) {
  const index = FLOW_NODES.indexOf(nodeId);
  if (
    index > 0 &&
    FLOW_NODES.slice(0, index).some((id) => !record(outputs[id]))
  )
    throw new Error("缺少上游结果，请回退并完成前面的节点。");
  if (index > 0 && outputs.prepare_draft?.input_status !== "ready")
    throw new Error("请先解决原稿输入问题。");
  if (
    nodeId === "deliver" &&
    (!outputs.review_prompt?.passed ||
      outputs.review_prompt.issues?.some((i) => i.severity === "blocking"))
  )
    throw new Error("没有通过质检的结果可交付。");
}
function cleanIssues(value) {
  if (
    !Array.isArray(value) ||
    value.some(
      (i) =>
        !record(i) ||
        !["blocking", "advisory"].includes(i.severity) ||
        !nonempty(i.reason),
    )
  )
    throw new Error("问题清单格式无效。");
  return value.map((i) =>
    Object.fromEntries(
      [
        "id",
        "severity",
        "category",
        "location",
        "reason",
        "required_fix",
        "node_id",
      ]
        .filter((k) => typeof i[k] === "string")
        .map((k) => [k, i[k]]),
    ),
  );
}
export function validateOutput(nodeId, result, context) {
  if (!NODE_IDS.includes(nodeId) || !record(result))
    throw new Error("节点返回格式无效，请重试。");
  if (context) requireUpstream(nodeId, context.outputs);
  if (nodeId === "prepare_draft") {
    const expected = context ? prepareDraft(context.input) : result;
    if (
      !["ready", "needs_input"].includes(result.input_status) ||
      result.input_status !== expected.input_status ||
      (result.input_status === "ready" &&
        (typeof result.locked_anchor !== "string" ||
          result.locked_anchor !== expected.locked_anchor))
    )
      throw new Error("原稿角色锚定与输入不一致。");
    if (
      result.input_status === "needs_input" &&
      (!Array.isArray(result.input_issues) || !result.input_issues.length)
    )
      throw new Error("缺少具体输入问题。");
    return clone(expected);
  }
  if (REVISION_NODES.includes(nodeId)) {
    if (
      Object.hasOwn(result, "character_anchor") ||
      Object.hasOwn(result, "ip_profile") ||
      Object.hasOwn(result, "identity_locks")
    )
      throw new Error("导演不可重新定义角色锚定。");
    if (!nonempty(result.draft))
      throw new Error("没有收到完整提示词正文，请重试。");
    if (!GENRES.some((g) => g.id === result.genre_id))
      throw new Error("改稿缺少有效拍法。");
    const expectedGenre =
      context &&
      (nodeId === "chief_director"
        ? context.input.director === "auto"
          ? null
          : context.input.director
        : context.outputs.chief_director.genre_id);
    if (expectedGenre && expectedGenre !== result.genre_id)
      throw new Error("拍法与上游或用户指定不一致。");
    if (context) {
      const anchor = extractAnchor(result.draft),
        locked = lockedAnchor(context.outputs);
      if (!anchor)
        throw new Error(
          "导演输出缺少角色锚定段，请重试当前导演；输入初稿无需手动排版。",
        );
      if (locked && anchor !== locked)
        throw new Error(
          "改稿改变了角色锚定，请保留原文；如需改设定，请先修改输入。",
        );
    }
    if (
      !Array.isArray(result.changes) ||
      result.changes.some(
        (c) => !record(c) || !nonempty(c.location) || !nonempty(c.reason),
      )
    )
      throw new Error("修改说明需包含 location 和 reason。");
    if (
      context &&
      result.draft !== previousDraft(nodeId, context.input, context.outputs) &&
      !result.changes.length
    )
      throw new Error("正文发生变化时必须说明修改位置与原因。");
    return {
      draft: result.draft,
      genre_id: result.genre_id,
      changes: result.changes.map((c) => ({
        location: c.location,
        reason: c.reason,
      })),
      issues: cleanIssues(result.issues),
    };
  }
  if (nodeId === "review_prompt") {
    if (typeof result.passed !== "boolean")
      throw new Error("审核结果格式无效。");
    const issues = cleanIssues(result.issues);
    if (context) {
      const deterministic = inspectDraft(
        context.outputs.generate_prompt.draft,
        Number(context.input.duration),
        { character_anchor: lockedAnchor(context.outputs) },
      );
      for (const issue of deterministic)
        if (!issues.some((i) => i.id === issue.id)) issues.push(issue);
    }
    return {
      passed: result.passed && !issues.some((i) => i.severity === "blocking"),
      issues,
      summary: typeof result.summary === "string" ? result.summary : "",
    };
  }
  return { delivered: nodeId === "deliver", reported: nodeId !== "deliver" };
}
export function validateOutputs(outputs, input) {
  if (
    !record(outputs) ||
    Object.keys(outputs).some((id) => !NODE_IDS.includes(id))
  )
    throw new Error("项目包含未知节点。");
  const checked = {};
  for (const id of NODE_IDS)
    if (Object.hasOwn(outputs, id))
      checked[id] = validateOutput(id, outputs[id], {
        input,
        outputs: checked,
      });
  return checked;
}
export function nextNode(nodeId, result) {
  if (nodeId === "prepare_draft")
    return result.input_status === "ready" ? "chief_director" : "report_input";
  const index = MODEL_NODES.indexOf(nodeId);
  if (index >= 0 && index < MODEL_NODES.length - 1)
    return MODEL_NODES[index + 1];
  if (nodeId === "review_prompt")
    return result.passed &&
      !result.issues.some((i) => i.severity === "blocking")
      ? "deliver"
      : "report_unresolved";
  return null;
}
function validatePath(outputs, path, cursor) {
  let expected = "prepare_draft";
  for (const id of path) {
    if (id !== expected || !Object.hasOwn(outputs, id))
      throw new Error("项目路径与检查点结果不一致。");
    expected = nextNode(id, outputs[id]);
  }
  if (expected !== cursor || Object.keys(outputs).length !== path.length)
    throw new Error("项目路径与当前检查点不一致。");
}
function bounded(work, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      fn(value);
    };
    const cancel = () => finish(reject, new Error("已停止执行"));
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new Error(
            `节点执行超时（${Math.ceil(timeoutMs / 1000)} 秒），可以重试或回退。`,
          ),
        ),
      timeoutMs,
    );
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    Promise.resolve()
      .then(work)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

export class WorkflowController {
  constructor({
    input = DEFAULT_INPUT,
    initial,
    execute,
    timeoutMs = 120000,
  } = {}) {
    this.execute = execute;
    this.timeoutMs = timeoutMs;
    this.listeners = new Set();
    this.epoch = 0;
    this.active = null;
    this.state = freshState(input);
    if (initial) this.restore(initial);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit() {
    this.state = { ...this.state, updatedAt: Date.now() };
    for (const fn of this.listeners) fn(this.state);
  }
  log(event, nodeId, detail = "") {
    this.state.history = [
      ...this.state.history,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        event,
        nodeId,
        detail,
      },
    ].slice(-150);
  }
  remember(nodeId, output) {
    this.state.revisions = [
      ...this.state.revisions,
      {
        id: Date.now() + "-" + Math.random().toString(36).slice(2),
        nodeId,
        at: Date.now(),
        draft: output.draft,
      },
    ].slice(-50);
  }
  setExecutor(execute, timeoutMs) {
    this.execute = execute;
    if (timeoutMs) this.timeoutMs = timeoutMs;
  }
  snapshot() {
    return clone({
      input: this.state.input,
      outputs: this.state.outputs,
      nodes: this.state.nodes,
      path: this.state.path,
    });
  }
  async run({ singleStep = false } = {}) {
    if (this.active || !this.state.cursor || !this.execute) return;
    const epoch = ++this.epoch;
    const abort = new AbortController();
    this.active = abort;
    this.state.error = "";
    this.state.status = "running";
    try {
      while (this.state.cursor && epoch === this.epoch) {
        const nodeId = this.state.cursor;
        this.state.snapshots[nodeId] = this.snapshot();
        this.state.nodes[nodeId] = {
          status: "running",
          startedAt: Date.now(),
          durationMs: 0,
        };
        this.log("start", nodeId);
        this.emit();
        const started = Date.now();
        const result = await bounded(
          () =>
            this.execute({
              nodeId,
              input: clone(this.state.input),
              outputs: clone(this.state.outputs),
              promptOverrides: clone(this.state.promptOverrides),
              signal: abort.signal,
            }),
          abort.signal,
          this.timeoutMs,
        );
        if (epoch !== this.epoch) return;
        const output = validateOutput(nodeId, result, {
          input: this.state.input,
          outputs: this.state.outputs,
        });
        this.state.outputs = { ...this.state.outputs, [nodeId]: output };
        this.state.nodes[nodeId] = {
          status: "completed",
          durationMs: Date.now() - started,
        };
        this.state.path = [
          ...this.state.path.filter((id) => id !== nodeId),
          nodeId,
        ];
        this.state.cursor = nextNode(nodeId, output);
        if (REVISION_NODES.includes(nodeId)) this.remember(nodeId, output);
        this.log("complete", nodeId);
        if (!this.state.cursor) {
          this.state.status = terminalStatus[nodeId] || "completed";
          this.state.finalPrompt =
            nodeId === "deliver"
              ? this.state.outputs.generate_prompt?.draft || ""
              : "";
        } else if (singleStep) this.state.status = "paused";
        this.emit();
        if (singleStep) break;
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      abort.abort();
      const nodeId = this.state.cursor;
      this.state.status = "error";
      this.state.error =
        error instanceof Error ? error.message : "节点执行失败，请重试或回退。";
      if (nodeId)
        this.state.nodes[nodeId] = {
          ...this.state.nodes[nodeId],
          status: "error",
        };
      this.log("error", nodeId, this.state.error);
      this.emit();
    } finally {
      if (epoch === this.epoch) {
        this.active = null;
        if (this.state.status === "running") this.state.status = "paused";
        this.emit();
      }
    }
  }
  stop() {
    const wasRunning = !!this.active;
    ++this.epoch;
    const active = this.active;
    this.active = null;
    active?.abort();
    if (wasRunning) {
      this.state.status = "paused";
      this.state.error = "";
      if (this.state.cursor)
        this.state.nodes[this.state.cursor] = {
          ...this.state.nodes[this.state.cursor],
          status: "paused",
        };
      this.log("stop", this.state.cursor, "可继续、编辑或回退");
      this.emit();
    }
  }
  canRollback(nodeId) {
    return nodeId === "prepare_draft" || !!this.state.snapshots[nodeId];
  }
  rollback(nodeId) {
    if (!this.canRollback(nodeId))
      throw new Error("该节点尚未访问，请先运行其上游节点。");
    this.stop();
    const snap = this.state.snapshots[nodeId] || {
      input: this.state.input,
      outputs: {},
      nodes: freshNodes(),
      path: [],
    };
    this.state.input = clone(snap.input);
    this.state.outputs = clone(snap.outputs);
    this.state.nodes = clone(snap.nodes);
    this.state.path = [...snap.path];
    const keep = new Set([...snap.path, nodeId]);
    this.state.snapshots = Object.fromEntries(
      Object.entries(this.state.snapshots).filter(([id]) => keep.has(id)),
    );
    for (const id of NODE_IDS)
      if (!snap.path.includes(id))
        this.state.nodes[id] = { status: "pending", durationMs: 0 };
    this.state.cursor = nodeId;
    this.state.status = "paused";
    this.state.error = "";
    this.state.finalPrompt = "";
    this.log("rollback", nodeId, "已恢复节点前快照，下游结果已清除");
    this.emit();
  }
  updateInput(input) {
    const cleanInput = sanitizeInput(input);
    this.stop();
    this.state.input = cleanInput;
    this.state.outputs = {};
    this.state.revisions = [];
    this.state.nodes = freshNodes();
    this.state.snapshots = {};
    this.state.path = [];
    this.state.cursor = "prepare_draft";
    this.state.status = "idle";
    this.state.finalPrompt = "";
    this.state.error = "";
    this.log("edit", "prepare_draft", "更新输入，等待重新运行");
    this.emit();
  }
  newProject(input = DEFAULT_INPUT) {
    const next = freshState(input);
    this.stop();
    this.state = next;
    this.emit();
  }
  editOutput(nodeId, value) {
    if (
      nodeId === "prepare_draft" ||
      nodeId === "review_prompt" ||
      Object.hasOwn(terminalStatus, nodeId)
    )
      throw new Error("质检结论与交付状态不可手动改写，请修改草稿后重新检查。");
    if (!this.state.outputs[nodeId])
      throw new Error("请先运行该节点再编辑结果。");
    const output = validateOutput(nodeId, value, {
      input: this.state.input,
      outputs: this.state.outputs,
    });
    this.rollback(nodeId);
    this.state.outputs = { ...this.state.outputs, [nodeId]: output };
    this.state.nodes[nodeId] = { status: "completed", durationMs: 0 };
    this.state.path.push(nodeId);
    this.state.cursor = nextNode(nodeId, output);
    this.state.status = this.state.cursor ? "paused" : terminalStatus[nodeId];
    if (REVISION_NODES.includes(nodeId)) this.remember(nodeId, output);
    this.log("edit", nodeId, "已保存修改，下游结果已失效");
    this.emit();
  }
  updatePrompt(file, text) {
    if (!PROMPT_FILES.includes(file) || typeof text !== "string")
      throw new Error("提示词格式或文件名错误");
    this.rollback("prepare_draft");
    this.state.promptOverrides = {
      ...this.state.promptOverrides,
      [file]: text,
    };
    this.log(
      "prompt",
      "prepare_draft",
      "系统提示词已修改，重新运行以应用新版本",
    );
    this.emit();
  }
  exportProject() {
    const {
      schemaVersion,
      input,
      cursor,
      status,
      outputs,
      nodes,
      snapshots,
      path,
      history,
      revisions,
      promptOverrides,
      finalPrompt,
      error,
      legacyArchive,
      updatedAt,
    } = this.state;
    return clone({
      schemaVersion,
      input,
      cursor,
      status,
      outputs,
      nodes,
      snapshots,
      path,
      history,
      revisions,
      promptOverrides,
      finalPrompt,
      error,
      legacyArchive,
      updatedAt,
    });
  }
  restore(value) {
    if (record(value) && [1, 2].includes(value.schemaVersion)) {
      const archive = cleanLegacyArchive(value);
      this.updateInput({
        ...archive.input,
        initialPrompt:
          archive.finalPrompt ||
          archive.outputs.generate_prompt?.draft ||
          archive.input.initialPrompt ||
          "",
      });
      this.state.promptOverrides = {};
      this.state.history = [];
      this.state.legacyArchive = archive;
      this.log(
        "migrate",
        "prepare_draft",
        "旧项目已存档，完整旧稿已作为本轮原稿，等待确认设置后开始改稿",
      );
      this.emit();
      return;
    }
    if (
      !record(value) ||
      value.schemaVersion !== 3 ||
      !record(value.input) ||
      !record(value.outputs) ||
      !record(value.snapshots) ||
      !Array.isArray(value.path) ||
      ![
        "idle",
        "running",
        "paused",
        "error",
        "completed",
        "needs_input",
        "needs_revision",
      ].includes(value.status) ||
      (value.cursor !== null && !NODE_IDS.includes(value.cursor))
    )
      throw new Error("项目文件格式不正确或版本不支持。");
    if (
      Object.keys(value.outputs).some((id) => !NODE_IDS.includes(id)) ||
      value.path.some((id) => !NODE_IDS.includes(id))
    )
      throw new Error("项目包含未知节点。");
    const snapshots = {};
    const input = sanitizeInput(value.input),
      nodes = cleanNodes(value.nodes);
    // Versions <= 0.3.1 stored format-only refusals as terminal projects. Reopen
    // those drafts before validating the old path against the new intake rule.
    if (
      value.outputs.prepare_draft?.input_status === "needs_input" &&
      prepareDraft(input).input_status === "ready" &&
      Object.keys(value.outputs).every((id) =>
        ["prepare_draft", "report_input"].includes(id),
      ) &&
      [["prepare_draft"], ["prepare_draft", "report_input"]].some(
        (path) => JSON.stringify(path) === JSON.stringify(value.path),
      )
    ) {
      this.stop();
      this.state = freshState(input);
      this.state.promptOverrides = record(value.promptOverrides)
        ? Object.fromEntries(
            Object.entries(value.promptOverrides).filter(
              ([key, text]) =>
                PROMPT_FILES.includes(key) && typeof text === "string",
            ),
          )
        : {};
      this.state.legacyArchive = value.legacyArchive
        ? cleanLegacyArchive(value.legacyArchive)
        : null;
      this.log(
        "migrate",
        "prepare_draft",
        "原稿已保留；旧版输入格式限制已解除，可直接开始改稿。",
      );
      this.emit();
      return;
    }
    const outputs = validateOutputs(value.outputs, input);
    validatePath(outputs, value.path, value.cursor);
    const last = value.path.at(-1);
    if (
      (value.cursor === null && terminalStatus[last] !== value.status) ||
      (value.cursor !== null &&
        ["completed", "needs_input", "needs_revision"].includes(value.status))
    )
      throw new Error("项目状态与检查点不一致。");
    const legacyArchive = value.legacyArchive
      ? cleanLegacyArchive(value.legacyArchive)
      : null;
    for (const [id, snap] of Object.entries(value.snapshots)) {
      if (
        !NODE_IDS.includes(id) ||
        !record(snap) ||
        !record(snap.input) ||
        !record(snap.outputs) ||
        !record(snap.nodes) ||
        !Array.isArray(snap.path) ||
        snap.path.some((p) => !NODE_IDS.includes(p)) ||
        Object.keys(snap.outputs).some((p) => !NODE_IDS.includes(p))
      )
        throw new Error("项目快照格式不正确。");
      const snapInput = sanitizeInput(snap.input);
      snapshots[id] = {
        input: snapInput,
        outputs: validateOutputs(snap.outputs, snapInput),
        nodes: cleanNodes(snap.nodes),
        path: [...snap.path],
      };
      validatePath(snapshots[id].outputs, snap.path, id);
    }
    for (const id of value.path)
      if (!snapshots[id]) throw new Error("项目缺少可用的回退快照。");
    for (const [id, snap] of Object.entries(snapshots)) {
      const index = value.path.includes(id)
        ? value.path.indexOf(id)
        : id === value.cursor
          ? value.path.length
          : -1;
      const prefix = value.path.slice(0, index);
      if (
        index < 0 ||
        JSON.stringify(snap.input) !== JSON.stringify(input) ||
        JSON.stringify(snap.path) !== JSON.stringify(prefix) ||
        prefix.some(
          (p) => JSON.stringify(snap.outputs[p]) !== JSON.stringify(outputs[p]),
        )
      )
        throw new Error("回退快照与实际上游版本不一致。");
    }
    for (const id of NODE_IDS)
      nodes[id].status = value.path.includes(id)
        ? "completed"
        : id === value.cursor && ["error", "paused"].includes(nodes[id].status)
          ? nodes[id].status
          : "pending";
    this.stop();
    const history = Array.isArray(value.history)
      ? value.history
          .filter(
            (event) =>
              record(event) &&
              typeof event.id === "string" &&
              Number.isFinite(event.at) &&
              typeof event.event === "string" &&
              NODE_IDS.includes(event.nodeId),
          )
          .slice(-150)
          .map((event) => ({
            id: event.id,
            at: event.at,
            event: event.event,
            nodeId: event.nodeId,
            detail: typeof event.detail === "string" ? event.detail : "",
          }))
      : [];
    this.state = {
      ...this.state,
      input,
      cursor: value.cursor,
      status: value.status === "running" ? "paused" : value.status,
      outputs,
      nodes,
      snapshots,
      path: [...value.path],
      history,
      revisions: cleanRevisions(value.revisions),
      legacyArchive,
      promptOverrides: record(value.promptOverrides)
        ? Object.fromEntries(
            Object.entries(value.promptOverrides).filter(
              ([key, text]) =>
                PROMPT_FILES.includes(key) && typeof text === "string",
            ),
          )
        : {},
      finalPrompt:
        value.status === "completed"
          ? String(value.outputs.generate_prompt?.draft || "")
          : "",
      error: typeof value.error === "string" ? value.error : "",
    };
    this.emit();
  }
}

function stripCredentialFields(value) {
  if (Array.isArray(value)) return value.map(stripCredentialFields);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/api.?key|token|secret|password|authorization|connection/i.test(key),
      )
      .map(([key, item]) => [key, stripCredentialFields(item)]),
  );
}
function cleanRevisions(value) {
  return Array.isArray(value)
    ? value
        .filter(
          (v) =>
            record(v) &&
            REVISION_NODES.includes(v.nodeId) &&
            nonempty(v.draft) &&
            nonempty(v.id) &&
            Number.isFinite(v.at),
        )
        .slice(-50)
        .map((v) => ({ id: v.id, nodeId: v.nodeId, at: v.at, draft: v.draft }))
    : [];
}
function cleanLegacyArchive(value) {
  if (
    !record(value) ||
    ![1, 2].includes(value.schemaVersion) ||
    !record(value.input) ||
    !record(value.outputs)
  )
    throw new Error("旧项目格式不正确，无法保存旧稿。");
  return {
    schemaVersion: value.schemaVersion,
    input: sanitizeInput(value.input),
    outputs: stripCredentialFields(value.outputs),
    finalPrompt: typeof value.finalPrompt === "string" ? value.finalPrompt : "",
    promptOverrides: record(value.promptOverrides)
      ? Object.fromEntries(
          Object.entries(value.promptOverrides).filter(
            ([key, text]) =>
              /^[a-z_/]+\.md$/.test(key) && typeof text === "string",
          ),
        )
      : {},
    archivedAt: Number.isFinite(value.archivedAt)
      ? value.archivedAt
      : Date.now(),
  };
}
