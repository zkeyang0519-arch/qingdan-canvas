import { useState } from "react";

function read(key, fallback) {
  try {
    return JSON.parse(window.sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Drafts stay in this browser tab and are partitioned by account, project,
// binding revision and (for chat) conversation. Restoring never submits them.
export function useWorkspaceDraft(key, fallback, enabled) {
  const storageKey = `qingdan.agent-draft:${key}`;
  const [saved, setSaved] = useState(() => ({
    key,
    value: enabled ? read(storageKey, fallback) : fallback,
  }));
  const value =
    saved.key === key
      ? saved.value
      : enabled
        ? read(storageKey, fallback)
        : fallback;
  if (saved.key !== key) setSaved({ key, value });
  function setValue(next) {
    const result = typeof next === "function" ? next(value) : next;
    if (enabled) {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(result));
      } catch {
        /* Storage is optional. */
      }
    }
    setSaved({ key, value: result });
  }
  return [value, setValue];
}
