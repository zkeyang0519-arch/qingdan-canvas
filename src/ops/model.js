import { validDeadline, validDeadlineRange } from "../../shared/deadline.js";

export const OPS_STORAGE_KEY = "qingdan-ops-v1";
export const OPS_VERSION = 1;

const STATUSES = new Set(["running", "maintenance", "retired"]);
const ENVIRONMENTS = new Set(["production", "staging", "development"]);
const TASK_TARGETS = new Set(["product", "server", "deployment"]);
const MAX = {
  name: 80,
  summary: 240,
  owner: 80,
  tag: 32,
  provider: 80,
  region: 80,
  address: 160,
  system: 80,
  role: 48,
  version: 80,
  task: 240,
};

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max, required = true) => (
  typeof value === "string" && value.length <= max && (!required || value.trim().length > 0)
);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
const normalize = value => typeof value === "string" ? value.trim() : value;
const sameName = (left, right) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

function fail(message) {
  throw new Error(message);
}

function optionalText(value, max, label) {
  if (value === undefined || value === null || value === "") return "";
  if (!isText(value, max, false)) fail(`${label}格式无效，且最多 ${max} 个字符。`);
  return value.trim();
}

function requiredText(value, max, label) {
  if (!isText(value, max)) fail(`${label}不能为空，且最多 ${max} 个字符。`);
  return value.trim();
}

function statusValue(value, label = "状态") {
  const next = value || "running";
  if (!STATUSES.has(next)) fail(`${label}无效。`);
  return next;
}

function environmentValue(value, required = true) {
  if (!value && !required) return "";
  if (!ENVIRONMENTS.has(value)) fail("环境无效。");
  return value;
}

function tagsValue(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) fail("标签格式无效。");
  const tags = value.map(tag => requiredText(tag, MAX.tag, "标签"));
  if (new Set(tags.map(tag => tag.toLocaleLowerCase())).size !== tags.length)
    fail("标签不能重复。");
  return tags;
}

function ensureUniqueName(records, name, label, excludeId) {
  if (records.some(record => record.id !== excludeId && sameName(record.name, name)))
    fail(`${label}名称已存在。`);
}

function mergeDefined(base, input) {
  if (!isRecord(input)) return { ...base, ...(input || {}) };
  const defined = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return { ...base, ...defined };
}

function productFields(input) {
  if (!isRecord(input)) fail("产品记录格式无效。");
  return {
    name: requiredText(input.name, MAX.name, "产品名称"),
    summary: optionalText(input.summary, MAX.summary, "产品说明"),
    owner: optionalText(input.owner, MAX.owner, "负责人"),
    status: statusValue(input.status, "产品状态"),
    tags: tagsValue(input.tags),
  };
}

function serverFields(input) {
  if (!isRecord(input)) fail("服务器记录格式无效。");
  const dueAt = input.dueAt ?? null;
  const dueStartAt = input.dueStartAt ?? null;
  if (dueAt !== null && !validDeadline(dueAt)) fail("截止日期无效。");
  if (!validDeadlineRange(dueStartAt, dueAt)) fail("日期区间无效。");
  return {
    name: requiredText(input.name, MAX.name, "服务器名称"),
    provider: optionalText(input.provider, MAX.provider, "提供商"),
    region: optionalText(input.region, MAX.region, "地域"),
    address: optionalText(input.address, MAX.address, "地址"),
    system: optionalText(input.system, MAX.system, "系统"),
    environment: environmentValue(input.environment, false),
    status: statusValue(input.status, "服务器状态"),
    dueAt,
    dueStartAt,
  };
}

function deploymentFields(state, input) {
  if (!isRecord(input)) fail("部署关系格式无效。");
  if (!state.products.some(product => product.id === input.productId))
    fail("部署关系引用了不存在的产品。");
  if (!state.servers.some(server => server.id === input.serverId))
    fail("部署关系引用了不存在的服务器。");
  const environment = environmentValue(input.environment);
  const role = optionalText(input.role, MAX.role, "角色") || "";
  const version = optionalText(input.version, MAX.version, "版本");
  if (state.deployments.some(item => (
    item.productId === input.productId &&
    item.serverId === input.serverId &&
    item.environment === environment &&
    (item.role || "") === role
  ))) fail("相同的部署关系已存在。");
  return { productId: input.productId, serverId: input.serverId, environment, role, version };
}

function taskFields(state, input) {
  if (!isRecord(input)) fail("待办格式无效。");
  const text = requiredText(input.text, MAX.task, "待办内容");
  const targetType = input.targetType || "product";
  if (!TASK_TARGETS.has(targetType)) fail("待办关联类型无效。");
  if (!targetIdExists(state, targetType, input.targetId)) fail("待办关联了不存在的记录。");
  return { text, targetType, targetId: input.targetId };
}

function targetIdExists(state, type, targetId) {
  if (typeof targetId !== "string") return false;
  if (type === "product") return state.products.some(item => item.id === targetId);
  if (type === "server") return state.servers.some(item => item.id === targetId);
  return state.deployments.some(item => item.id === targetId);
}

function dateValue(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label}日期无效。`);
  return value;
}

function validateProduct(product) {
  if (!isRecord(product)) fail("存在无效产品记录。");
  if (!isText(product.id, 140)) fail("产品标识无效。");
  const fields = productFields(product);
  dateValue(product.updatedAt, "产品更新时间");
  return { id: product.id, ...fields, updatedAt: product.updatedAt };
}

function validateServer(server) {
  if (!isRecord(server)) fail("存在无效服务器记录。");
  if (!isText(server.id, 140)) fail("服务器标识无效。");
  const fields = serverFields(server);
  dateValue(server.updatedAt, "服务器更新时间");
  return { id: server.id, ...fields, updatedAt: server.updatedAt };
}

function validateDeployment(state, deployment) {
  if (!isRecord(deployment) || !isText(deployment.id, 140)) fail("存在无效部署关系。");
  if (!state.products.some(product => product.id === deployment.productId)) fail("部署关系引用了不存在的产品。");
  if (!state.servers.some(server => server.id === deployment.serverId)) fail("部署关系引用了不存在的服务器。");
  const environment = environmentValue(deployment.environment);
  const role = optionalText(deployment.role, MAX.role, "角色");
  const version = optionalText(deployment.version, MAX.version, "版本");
  dateValue(deployment.createdAt, "部署创建");
  return {
    id: deployment.id,
    productId: deployment.productId,
    serverId: deployment.serverId,
    environment,
    role,
    version,
    createdAt: deployment.createdAt,
  };
}

function validateTask(state, task) {
  if (!isRecord(task) || !isText(task.id, 140)) fail("存在无效运维待办。");
  const fields = taskFields(state, task);
  if (typeof task.completed !== "boolean") fail("待办完成状态无效。");
  dateValue(task.createdAt, "待办创建");
  return { id: task.id, ...fields, completed: task.completed, createdAt: task.createdAt };
}

export function validateOpsState(value) {
  if (!isRecord(value) || value.version !== OPS_VERSION) fail("不支持的运维资产数据版本。");
  if (!Array.isArray(value.products) || !Array.isArray(value.servers) || !Array.isArray(value.deployments) || !Array.isArray(value.tasks))
    fail("运维资产数据缺少产品、服务器、部署关系或待办列表。");
  const products = value.products.map(validateProduct);
  const servers = value.servers.map(validateServer);
  ensureUniqueNames(products, "产品");
  ensureUniqueNames(servers, "服务器");
  const base = { version: OPS_VERSION, products, servers, deployments: [], tasks: [] };
  const deployments = value.deployments.map(item => validateDeployment(base, item));
  const next = { ...base, deployments };
  const tasks = value.tasks.map(item => validateTask(next, item));
  return { ...next, tasks };
}

function ensureUniqueNames(records, label) {
  const names = new Set();
  for (const record of records) {
    const key = record.name.toLocaleLowerCase();
    if (names.has(key)) fail(`${label}名称已重复。`);
    names.add(key);
  }
}

export function createInitialOpsState() {
  return { version: OPS_VERSION, products: [], servers: [], deployments: [], tasks: [] };
}

export function parseOpsState(text) {
  if (typeof text !== "string") fail("运维资产内容必须是 JSON 文本。");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("运维资产内容不是有效的 JSON 格式。");
  }
  return validateOpsState(value);
}

export function loadOpsState(storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.getItem !== "function") fail("本地存储不可用。");
    const raw = storage.getItem(OPS_STORAGE_KEY);
    return raw === null
      ? { state: createInitialOpsState(), error: null }
      : { state: parseOpsState(raw), error: null };
  } catch (error) {
    return { state: createInitialOpsState(), error: `无法读取运维资产：${error.message} 原始内容已保留。` };
  }
}

export function serializeOpsState(state) {
  return JSON.stringify(validateOpsState(state), null, 2);
}

export function saveOpsState(state, storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.setItem !== "function") fail("本地存储不可用。");
    storage.setItem(OPS_STORAGE_KEY, serializeOpsState(state));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `运维资产保存失败：${error.message}` };
  }
}

export function addProduct(state, input) {
  const fields = productFields(input);
  ensureUniqueName(state.products, fields.name, "产品");
  const timestamp = now();
  return { ...state, products: [...state.products, { id: id("ops-product"), ...fields, updatedAt: timestamp }] };
}

export function addServer(state, input) {
  const fields = serverFields(input);
  ensureUniqueName(state.servers, fields.name, "服务器");
  const timestamp = now();
  return { ...state, servers: [...state.servers, { id: id("ops-server"), ...fields, updatedAt: timestamp }] };
}

export function updateProduct(state, productId, input) {
  const existing = state.products.find(item => item.id === productId);
  if (!existing) fail("产品不存在。");
  const fields = productFields(mergeDefined(existing, input));
  ensureUniqueName(state.products, fields.name, "产品", productId);
  return { ...state, products: state.products.map(item => item.id === productId ? { ...item, ...fields, updatedAt: now() } : item) };
}

export function updateServer(state, serverId, input) {
  const existing = state.servers.find(item => item.id === serverId);
  if (!existing) fail("服务器不存在。");
  const fields = serverFields(mergeDefined(existing, input));
  ensureUniqueName(state.servers, fields.name, "服务器", serverId);
  return { ...state, servers: state.servers.map(item => item.id === serverId ? { ...item, ...fields, updatedAt: now() } : item) };
}

function removeTarget(state, targetType, targetId) {
  const deploymentIds = new Set(
    state.deployments
      .filter(item => targetType === "product" ? item.productId === targetId : item.serverId === targetId)
      .map(item => item.id),
  );
  const deployments = state.deployments.filter(item => !deploymentIds.has(item.id));
  const tasks = state.tasks.filter(task => (
    !(task.targetType === targetType && task.targetId === targetId) &&
    !(task.targetType === "deployment" && deploymentIds.has(task.targetId))
  ));
  return { ...state, deployments, tasks };
}

export function deleteProduct(state, productId) {
  if (!state.products.some(item => item.id === productId)) return state;
  const next = removeTarget(state, "product", productId);
  return { ...next, products: next.products.filter(item => item.id !== productId) };
}

export function deleteServer(state, serverId) {
  if (!state.servers.some(item => item.id === serverId)) return state;
  const next = removeTarget(state, "server", serverId);
  return { ...next, servers: next.servers.filter(item => item.id !== serverId) };
}

export function addDeployment(state, input) {
  const fields = deploymentFields(state, input);
  return {
    ...state,
    deployments: [...state.deployments, { id: id("ops-deploy"), ...fields, createdAt: now() }],
  };
}

export function addOpsTask(state, input) {
  const fields = taskFields(state, input);
  return { ...state, tasks: [...state.tasks, { id: id("ops-task"), ...fields, completed: false, createdAt: now() }] };
}

export function toggleOpsTask(state, taskId) {
  if (!state.tasks.some(task => task.id === taskId)) fail("待办不存在。");
  return { ...state, tasks: state.tasks.map(task => task.id === taskId ? { ...task, completed: !task.completed } : task) };
}

function searchText(values, keyword) {
  if (!keyword) return true;
  const needle = keyword.trim().toLocaleLowerCase();
  return values.some(value => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
}

function productHasEnvironment(state, productId, environment) {
  return state.deployments.some(item => item.productId === productId && item.environment === environment);
}

function serverHasEnvironment(state, serverId, environment) {
  return state.deployments.some(item => item.serverId === serverId && item.environment === environment);
}

export function filterProducts(state, query = {}) {
  return state.products.filter(product => (
    searchText([product.name, product.summary, product.owner, ...product.tags], query.keyword) &&
    (!query.status || product.status === query.status) &&
    (!query.tag || product.tags.includes(query.tag)) &&
    (!query.environment || productHasEnvironment(state, product.id, query.environment))
  ));
}

export function filterServers(state, query = {}) {
  return state.servers.filter(server => (
    searchText([server.name, server.provider, server.region, server.address, server.system], query.keyword) &&
    (!query.status || server.status === query.status) &&
    (!query.environment || server.environment === query.environment || serverHasEnvironment(state, server.id, query.environment))
  ));
}

export function groupDeploymentsByRole(state, productId) {
  const groups = new Map();
  for (const deployment of state.deployments.filter(item => item.productId === productId)) {
    const role = deployment.role || "未分类";
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push({ deployment, server: state.servers.find(server => server.id === deployment.serverId) });
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "未分类") return 1;
      if (right === "未分类") return -1;
      return left.localeCompare(right, "zh-CN");
    })
    .map(([role, items]) => ({ role, items }));
}

export function productServers(state, productId) {
  const ids = new Set(state.deployments
    .filter(item => item.productId === productId)
    .map(item => item.serverId));
  return state.servers.filter(server => ids.has(server.id));
}
