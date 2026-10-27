import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { loadQuickTasks, saveQuickTasks } from "./quickTasks.js";

const endpoint = "/api/profile/quick-tasks";
const importKey = (accountId) => `qingdan.quick-tasks-imported:${accountId}`;
function imported(accountId) {
  try {
    return localStorage.getItem(importKey(accountId)) === "1";
  } catch {
    return false;
  }
}

export function useQuickTasks(accountId, enabled) {
  const initial = () => ({
    accountId,
    items: accountId ? loadQuickTasks(accountId) : [],
    ready: false,
    busy: false,
    error: "",
  });
  const [state, setState] = useState(initial);
  const generation = useRef(0),
    locked = useRef(false),
    account = useRef(accountId);
  account.current = accountId;
  const refresh = useCallback(async () => {
    if (!accountId || locked.current) return;
    const turn = ++generation.current;
    const current = () =>
      turn === generation.current && account.current === accountId;
    locked.current = true;
    setState({
      accountId,
      items: loadQuickTasks(accountId),
      ready: false,
      busy: true,
      error: "",
    });
    let result;
    try {
      result = await api(endpoint, { accountId });
      if (!current()) return;
      if (!imported(accountId)) {
        for (const item of loadQuickTasks(accountId)) {
          if (!current()) return;
          if (!result.items.some((saved) => saved.text === item.text))
            result = await api(endpoint, {
              method: "POST",
              accountId,
              body: item,
            });
        }
        if (!current()) return;
        try {
          localStorage.setItem(importKey(accountId), "1");
        } catch {}
      }
      saveQuickTasks(accountId, result.items);
      setState({
        accountId,
        items: result.items,
        ready: true,
        busy: false,
        error: "",
      });
    } catch (error) {
      if (current())
        setState((before) => ({
          ...before,
          ...(result ? { items: result.items, ready: true } : {}),
          busy: false,
          error: `${result ? "本地模板尚未全部迁入账号" : "常用清单读取失败"}：${error.message}`,
        }));
    } finally {
      if (current()) locked.current = false;
    }
  }, [accountId]);

  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      generation.current++;
      locked.current = false;
    };
  }, [accountId, enabled, refresh]);

  const mutate = async (path, options) => {
    if (
      !accountId ||
      !state.ready ||
      state.accountId !== accountId ||
      locked.current
    )
      return false;
    const turn = ++generation.current;
    const current = () =>
      turn === generation.current && account.current === accountId;
    locked.current = true;
    setState((before) => ({ ...before, busy: true, error: "" }));
    try {
      const result = await api(path, { ...options, accountId });
      if (!current()) return false;
      // Until import finishes, this cache is the remaining local copy. Keep it
      // so capacity errors or interruptions cannot silently discard templates.
      const importComplete = imported(accountId);
      if (importComplete) saveQuickTasks(accountId, result.items);
      setState({
        accountId,
        items: result.items,
        ready: true,
        busy: false,
        error: importComplete ? "" : "有本地模板等待迁入，请重试。",
      });
      return true;
    } catch (error) {
      if (current())
        setState((before) => ({
          ...before,
          busy: false,
          error: `常用清单保存失败：${error.message}`,
        }));
      return false;
    } finally {
      if (current()) locked.current = false;
    }
  };
  const visible = state.accountId === accountId ? state : initial();
  return {
    ...visible,
    refresh,
    add: (text) =>
      mutate(endpoint, {
        method: "POST",
        body: { id: crypto.randomUUID(), text },
      }),
    remove: (id) =>
      mutate(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}
