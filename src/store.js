export const STORAGE_KEY = "qingdan-workspace-v1";
export const COLORS = ["sage", "sand", "lavender", "blue", "rose"];

const emptyState = () => ({
  version: 1,
  projects: [],
  tasks: [],
  hideCompleted: false,
});
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max, required = true) =>
  typeof value === "string" &&
  value.length <= max &&
  (!required || value.trim().length > 0);
const isDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function validateState(value) {
  requireValid(isRecord(value), "备份数据必须是一个工作区对象。");
  requireValid(
    value.version === 1,
    "不支持此备份版本，请导入版本 1 的工作区备份。",
  );
  requireValid(
    Array.isArray(value.projects) && Array.isArray(value.tasks),
    "备份缺少项目或任务列表。",
  );
  requireValid(
    typeof value.hideCompleted === "boolean",
    "备份中的完成项显示设置无效。",
  );

  const ids = new Set();
  const projectIds = new Set();
  const projectNames = new Set();
  const checkId = (id, label) => {
    requireValid(isText(id, 100) && id === id.trim(), `${label}的标识无效。`);
    requireValid(!ids.has(id), "备份中存在重复标识。");
    ids.add(id);
  };

  const projects = value.projects.map((project) => {
    requireValid(isRecord(project), "备份中存在无效项目。");
    checkId(project.id, "项目");
    requireValid(
      isText(project.name, 24),
      "项目名称不能为空，且最多 24 个字符。",
    );
    requireValid(
      isText(project.description, 120, false),
      "项目说明必须是文本，且最多 120 个字符。",
    );
    requireValid(COLORS.includes(project.color), "项目颜色无效。");
    requireValid(
      isDate(project.createdAt),
      "项目创建日期无效，请使用标准 ISO 日期。",
    );
    const name = project.name.trim();
    requireValid(!projectNames.has(name), "备份中存在重复项目名称。");
    projectNames.add(name);
    projectIds.add(project.id);
    return {
      id: project.id,
      name,
      description: project.description.trim(),
      color: project.color,
      createdAt: project.createdAt,
    };
  });

  const tasks = value.tasks.map((task) => {
    requireValid(isRecord(task), "备份中存在无效任务。");
    checkId(task.id, "任务");
    requireValid(
      typeof task.projectId === "string" && projectIds.has(task.projectId),
      "任务关联了不存在的项目。",
    );
    requireValid(
      isText(task.text, 2000),
      "任务内容不能为空，且最多 2000 个字符。",
    );
    requireValid(typeof task.completed === "boolean", "任务完成状态无效。");
    requireValid(
      isDate(task.createdAt),
      "任务创建日期无效，请使用标准 ISO 日期。",
    );
    requireValid(
      task.completed ? isDate(task.completedAt) : task.completedAt === null,
      "任务完成日期与完成状态不一致。",
    );
    return {
      id: task.id,
      projectId: task.projectId,
      text: task.text.trim(),
      completed: task.completed,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    };
  });

  return { version: 1, projects, tasks, hideCompleted: value.hideCompleted };
}

export function createInitialState() {
  const now = new Date().toISOString();
  const projects = [
    { id: "sample-web", name: "网站焕新", description: "", color: "sage" },
    { id: "sample-brand", name: "品牌设计", description: "", color: "sand" },
    {
      id: "sample-product",
      name: "产品研发",
      description: "",
      color: "lavender",
    },
    { id: "sample-team", name: "日常协作", description: "", color: "blue" },
  ].map((project) => ({ ...project, createdAt: now }));
  const entries = [
    ["sample-web", "整理首页改版的灵感参考", false],
    ["sample-web", "和团队确认导航结构", false],
    ["sample-web", "梳理现有页面与内容", true],
    ["sample-brand", "探索新一季的品牌配色", false],
    ["sample-brand", "完善社交媒体封面模板", false],
    ["sample-brand", "收集品牌视觉参考", true],
    ["sample-product", "整理本周用户反馈", false],
    ["sample-product", "完成核心流程评审", true],
    ["sample-team", "准备周五的项目分享", false],
    ["sample-team", "更新团队协作文档", false],
  ];
  const tasks = entries.map(([projectId, text, completed], index) => ({
    id: `sample-task-${index + 1}`,
    projectId,
    text,
    completed,
    createdAt: now,
    completedAt: completed ? now : null,
  }));
  return { version: 1, projects, tasks, hideCompleted: false };
}

export function parseBackup(text) {
  let value;
  try {
    requireValid(typeof text === "string", "备份内容必须是 JSON 文本。");
    value = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效的 JSON 格式。");
  }
  return validateState(value);
}

export function serializeBackup(state) {
  return JSON.stringify(validateState(state), null, 2);
}

export function loadState(storage) {
  try {
    // Resolve inside try: some browsers throw when localStorage itself is accessed.
    const target = storage === undefined ? globalThis.localStorage : storage;
    requireValid(
      target && typeof target.getItem === "function",
      "浏览器本地存储不可用。",
    );
    const raw = target.getItem(STORAGE_KEY);
    return {
      state: raw === null ? createInitialState() : parseBackup(raw),
      error: null,
    };
  } catch (error) {
    return {
      state: emptyState(),
      error: `无法读取本地数据：${error.message} 原始存储内容已保留。`,
    };
  }
}

export function saveState(state, storage) {
  try {
    const serialized = serializeBackup(state);
    const target = storage === undefined ? globalThis.localStorage : storage;
    requireValid(
      target && typeof target.setItem === "function",
      "浏览器本地存储不可用。",
    );
    target.setItem(STORAGE_KEY, serialized);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: `保存失败：${error.message} 请导出备份，避免关闭页面后丢失更改。`,
    };
  }
}

function makeId(prefix) {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  return `${prefix}-${suffix}`;
}

export function addTask(state, projectId, text) {
  if (
    !isText(text, 2000) ||
    !state.projects.some((project) => project.id === projectId)
  )
    return state;
  const task = {
    id: makeId("task"),
    projectId,
    text: text.trim(),
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  return { ...state, tasks: [...state.tasks, task] };
}

export function toggleTask(state, id) {
  if (!state.tasks.some((task) => task.id === id)) return state;
  const tasks = state.tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          completed: !task.completed,
          completedAt: task.completed ? null : new Date().toISOString(),
        }
      : task,
  );
  return { ...state, tasks };
}

function projectFields(state, input, excludeId) {
  if (!isRecord(input)) return null;
  const { name, description = "", color = "sage" } = input;
  if (
    !isText(name, 24) ||
    !isText(description, 120, false) ||
    !COLORS.includes(color)
  )
    return null;
  const trimmedName = name.trim();
  if (
    state.projects.some(
      (project) => project.id !== excludeId && project.name === trimmedName,
    )
  )
    return null;
  return { name: trimmedName, description: description.trim(), color };
}

export function addProject(state, input) {
  const fields = projectFields(state, input);
  if (!fields) return state;
  const project = {
    id: makeId("project"),
    ...fields,
    createdAt: new Date().toISOString(),
  };
  return { ...state, projects: [...state.projects, project] };
}

export function updateProject(state, id, input) {
  const existing = state.projects.find((project) => project.id === id);
  if (!existing || !isRecord(input)) return state;
  const fields = projectFields(state, { ...existing, ...input }, id);
  if (!fields) return state;
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === id ? { ...project, ...fields } : project,
    ),
  };
}

export function deleteProject(state, id) {
  if (!state.projects.some((project) => project.id === id)) return state;
  return {
    ...state,
    projects: state.projects.filter((project) => project.id !== id),
    tasks: state.tasks.filter((task) => task.projectId !== id),
  };
}

export function restoreProject(state, payload) {
  if (!isRecord(payload)) return state;
  const { project, tasks, projectIndex } = payload;
  if (
    !isRecord(project) ||
    !Array.isArray(tasks) ||
    !Number.isInteger(projectIndex)
  )
    return state;
  if (!tasks.every((task) => isRecord(task) && task.projectId === project.id))
    return state;
  const index = Math.max(0, Math.min(projectIndex, state.projects.length));
  const next = {
    ...state,
    projects: [
      ...state.projects.slice(0, index),
      project,
      ...state.projects.slice(index),
    ],
    tasks: [...state.tasks, ...tasks],
  };
  try {
    validateState(next);
    return next;
  } catch {
    return state;
  }
}

export function setHideCompleted(state, value) {
  if (typeof value !== "boolean" || state.hideCompleted === value) return state;
  return { ...state, hideCompleted: value };
}
