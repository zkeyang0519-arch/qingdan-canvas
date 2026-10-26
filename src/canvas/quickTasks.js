import { id, now } from "./model.js";

const prefix = "qingdan.quick-tasks:";
const maxTextLength = 2000;
const maxItems = 100;

const validItem = (item) =>
  item &&
  typeof item === "object" &&
  typeof item.id === "string" &&
  typeof item.text === "string" &&
  item.text.trim() &&
  typeof item.createdAt === "string" &&
  Number.isFinite(Date.parse(item.createdAt));

export function quickTasksStorageKey(scope = "default") {
  return `${prefix}${scope || "default"}`;
}

export function serializeQuickTasks(items) {
  return JSON.stringify(
    items.filter(validItem).slice(0, maxItems),
  );
}

export function loadQuickTasks(scope, storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.getItem !== "function") return [];
    const raw = storage.getItem(quickTasksStorageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(validItem).slice(0, maxItems).map((item) => ({
          id: item.id,
          text: item.text.trim(),
          createdAt: item.createdAt,
        }))
      : [];
  } catch {
    return [];
  }
}

export function saveQuickTasks(
  scope,
  items,
  storage = globalThis.localStorage,
) {
  try {
    if (!storage || typeof storage.setItem !== "function") return false;
    storage.setItem(quickTasksStorageKey(scope), serializeQuickTasks(items));
    return true;
  } catch {
    return false;
  }
}

export function addQuickTask(items, text, meta = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value || value.length > maxTextLength) return items;
  if (items.some((item) => item.text === value)) return items;
  return [
    ...items,
    {
      id: meta.id || id("quick"),
      text: value,
      createdAt: meta.createdAt || now(),
    },
  ].slice(-maxItems);
}

export function removeQuickTask(items, itemId) {
  const next = items.filter((item) => item.id !== itemId);
  return next.length === items.length ? items : next;
}
