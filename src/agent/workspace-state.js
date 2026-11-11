import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const storageWarning =
  "浏览器无法保存恢复信息；关闭页面后可能丢失。请检查浏览器存储设置。";
const coordinationWarning =
  "此浏览器无法协调多个标签页的请求，暂不能提交新执行。请使用支持 Web Locks 的本机或 HTTPS 入口；仍可查看、核对和停止。";
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item;
  });
const failure = (message, code) => Object.assign(new Error(message), { code });
function requestUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues)
    throw Error("浏览器无法生成安全的请求编号，请使用支持安全随机数的浏览器。");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function workspaceScope({
  accountId,
  canvasId,
  sectionId = null,
  binding = null,
  chatId = null,
  runId = null,
}) {
  return JSON.stringify([
    accountId,
    canvasId,
    sectionId,
    binding
      ? [
          binding.bindingId,
          binding.revision,
          binding.runnerId,
          binding.workspaceId,
        ]
      : null,
    chatId,
    runId,
  ]);
}

function readDraft(storageKey, fallback, validate, legacyKeys) {
  try {
    const current = window.localStorage.getItem(storageKey);
    if (current !== null) {
      const saved = JSON.parse(current);
      if (saved?.version !== 1 || !validate(saved.value))
        throw Error("invalid draft");
      return { value: saved.value, durable: true, warning: "" };
    }
    for (const key of legacyKeys) {
      const old = window.sessionStorage.getItem(key);
      if (old === null) continue;
      const value = JSON.parse(old);
      if (!validate(value)) continue;
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ version: 1, value }),
        );
        window.sessionStorage.removeItem(key);
        return { value, durable: true, warning: "" };
      } catch {
        return { value, durable: false, warning: storageWarning };
      }
    }
    return { value: fallback, durable: true, warning: "" };
  } catch {
    return { value: fallback, durable: false, warning: storageWarning };
  }
}

// Existing three-argument consumers retain their behavior. The third result
// reports durability; enabling storage is independent of a panel's layout.
export function useWorkspaceDraft(key, fallback, enabled = true, options = {}) {
  const storageKey = options.storageKey || `qingdan.agent-draft:${key}`;
  const identity = JSON.stringify([storageKey, enabled]);
  const validate =
    options.validate ||
    ((value) =>
      value !== undefined &&
      (fallback === null || typeof value === typeof fallback));
  const read = () =>
    enabled
      ? readDraft(
          storageKey,
          fallback,
          validate,
          options.legacyKeys || [storageKey],
        )
      : { value: fallback, durable: false, warning: "" };
  const [saved, setSaved] = useState(() => ({ identity, ...read() }));
  const state = saved.identity === identity ? saved : { identity, ...read() };
  if (saved.identity !== identity) setSaved(state);
  const current = useRef(state);
  current.current = state;
  useEffect(() => {
    const changed = (event) => {
      if (event.key === storageKey || event.key === null)
        setSaved({ identity, ...read() });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [identity]);
  const setValue = useCallback(
    (next) => {
      if (current.current.identity !== identity) return;
      const value =
        typeof next === "function" ? next(current.current.value) : next;
      let durable = false,
        warning = "";
      if (enabled) {
        try {
          if (!validate(value)) throw Error("invalid draft");
          window.localStorage.setItem(
            storageKey,
            JSON.stringify({ version: 1, value }),
          );
          durable = true;
        } catch {
          warning = storageWarning;
        }
      }
      current.current = { identity, value, durable, warning };
      setSaved(current.current);
    },
    [identity],
  );
  return [
    state.value,
    setValue,
    { durable: state.durable, warning: state.warning },
  ];
}

function exactRequest(request, requestId) {
  const value = clone(request);
  if (
    !value?.path?.startsWith("/api/") ||
    value.method !== "POST" ||
    !value.body ||
    typeof value.body !== "object" ||
    ![value.body.requestId, value.body.arguments?.requestId].includes(requestId)
  ) {
    throw Error("请求必须包含准确的原始路径、内容和请求编号。");
  }
  return value;
}
function isSafeStop(request) {
  return (
    request.path === "/api/agent/execution/tools" &&
    request.body.name === "codex_cancel_run" &&
    typeof request.body.arguments?.runId === "string" &&
    !!request.body.arguments.runId
  );
}

// This store only keeps facts. It never sends a request, including on restore.
// All durable read/modify/write operations use the origin's real LockManager.
export function createWorkspaceRequests(scope) {
  const key = `qingdan.agent-requests:v1:${scope}`;
  const listeners = new Set();
  const memoryStops = new Map();
  let snapshot = { records: [], warning: "", durable: true };
  function read() {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return [];
      const saved = JSON.parse(raw);
      if (
        saved.version !== 1 ||
        saved.scope !== scope ||
        !Array.isArray(saved.records)
      )
        throw Error();
      const ids = new Set(),
        operations = new Set();
      for (const item of saved.records) {
        if (
          !item ||
          typeof item.requestId !== "string" ||
          !item.requestId ||
          typeof item.operationKey !== "string" ||
          !item.operationKey ||
          ids.has(item.requestId) ||
          operations.has(item.operationKey)
        )
          throw Error();
        exactRequest(item.request, item.requestId);
        ids.add(item.requestId);
        operations.add(item.operationKey);
      }
      return saved.records;
    } catch {
      throw failure(storageWarning, "WORKSPACE_STORAGE");
    }
  }
  function publish(records, warning = "", durable = true) {
    const volatile = [...memoryStops.values()];
    snapshot = {
      records: clone([
        ...records,
        ...volatile.filter(
          (memory) =>
            !records.some(
              (record) =>
                record.requestId === memory.requestId &&
                record.operationKey === memory.operationKey &&
                canonical(record.request) === canonical(memory.request),
            ),
        ),
      ]),
      warning: volatile.length
        ? [
            warning,
            "仍有停止请求仅暂存在当前页面；请重试原停止请求以保存，关闭页面可能丢失恢复身份。",
          ]
            .filter(Boolean)
            .join(" ")
        : warning,
      durable: durable && !volatile.length,
    };
    for (const listener of listeners) listener();
  }
  const durableSnapshot = () =>
    snapshot.records.filter(
      (record) =>
        memoryStops.get(record.operationKey)?.requestId !== record.requestId,
    );
  function refresh() {
    try {
      publish(
        read(),
        memoryStops.size ? storageWarning : "",
        !memoryStops.size,
      );
    } catch (error) {
      publish(durableSnapshot(), error.message, false);
    }
  }
  function write(records, promotedOperation = null) {
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({ version: 1, scope, records }),
      );
    } catch {
      throw failure(storageWarning, "WORKSPACE_STORAGE");
    }
    // Retire a volatile identity only after its exact durable write succeeds.
    if (promotedOperation !== null) memoryStops.delete(promotedOperation);
    publish(records);
    window.dispatchEvent(
      new window.CustomEvent("qingdan-workspace-requests", { detail: key }),
    );
  }
  async function locked(operation) {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) {
      publish(durableSnapshot(), coordinationWarning, false);
      throw failure(coordinationWarning, "WORKSPACE_COORDINATION");
    }
    let entered = false;
    try {
      return await locks.request(key, () => {
        entered = true;
        return operation(read());
      });
    } catch (error) {
      if (!entered) {
        publish(durableSnapshot(), coordinationWarning, false);
        throw failure(coordinationWarning, "WORKSPACE_COORDINATION");
      }
      if (error.code === "WORKSPACE_STORAGE")
        publish(durableSnapshot(), error.message, false);
      throw error;
    }
  }
  function compatible(existing, request) {
    if (canonical(existing.request) !== canonical(request))
      throw Error(
        "原操作仍待核对，不能更换请求内容或版本。请核对或重试原操作。",
      );
  }
  function existing(records, operationKey, requestId) {
    const candidates = [...records, ...memoryStops.values()].filter(
      (record) =>
        record.operationKey === operationKey ||
        (requestId && record.requestId === requestId),
    );
    const old = candidates[0];
    if (
      candidates.some(
        (record) =>
          record.requestId !== old.requestId ||
          record.operationKey !== old.operationKey ||
          canonical(record.request) !== canonical(old.request),
      )
    ) {
      const message =
        "原操作的持久记录与当前页面身份冲突，请先核对；两个未确认身份均已保留。";
      publish(records, message, false);
      throw Error(message);
    }
    return old;
  }
  function persistExisting(records, record) {
    if (memoryStops.has(record.operationKey)) {
      write(
        records.some((item) => item.requestId === record.requestId)
          ? records
          : [...records, record],
        record.operationKey,
      );
    } else publish(records);
    return clone(record);
  }
  function retainStop(operationKey, record, error) {
    if (!isSafeStop(record.request))
      throw Error("仅停止原执行可在存储不可用时继续。");
    const records = durableSnapshot();
    const old = existing(records, operationKey, record.requestId);
    if (old) {
      if (
        old.requestId !== record.requestId ||
        old.operationKey !== operationKey
      )
        throw Error("旧请求身份与待核对记录冲突。");
      compatible(old, record.request);
    } else memoryStops.set(operationKey, record);
    publish(records, error.message, false);
    return clone(old || record);
  }
  refresh();
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      const changed = (event) => {
        if (event.key === key || event.key === null || event.detail === key)
          refresh();
      };
      window.addEventListener("storage", changed);
      window.addEventListener("qingdan-workspace-requests", changed);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", changed);
        window.removeEventListener("qingdan-workspace-requests", changed);
      };
    },
    async prepare(operationKey, buildRequest, { safeStop = false } = {}) {
      if (typeof operationKey !== "string" || !operationKey)
        throw Error("缺少操作标识。");
      try {
        return await locked((records) => {
          const old = existing(records, operationKey);
          const requestId = old?.requestId || requestUuid();
          const request = exactRequest(buildRequest(requestId), requestId);
          if (safeStop && !isSafeStop(request))
            throw Error("仅停止原执行可使用安全停止通道。");
          if (old) {
            compatible(old, request);
            return persistExisting(records, old);
          }
          if (records.length >= 100 && !safeStop)
            throw Error(
              "待核对操作较多，请先核对原操作；未确认请求不会自动删除。",
            );
          const record = {
            operationKey,
            requestId,
            request,
            checkpoint: null,
            createdAt: Date.now(),
          };
          write([...records, record]);
          return clone(record);
        });
      } catch (error) {
        if (
          !safeStop ||
          !["WORKSPACE_STORAGE", "WORKSPACE_COORDINATION"].includes(error.code)
        )
          throw error;
        const old = existing(durableSnapshot(), operationKey);
        const requestId = old?.requestId || requestUuid();
        const request = exactRequest(buildRequest(requestId), requestId);
        const record = {
          operationKey,
          requestId,
          request,
          checkpoint: old?.checkpoint ?? null,
          createdAt: old?.createdAt ?? Date.now(),
        };
        return retainStop(operationKey, record, error);
      }
    },
    async adopt(operationKey, legacy, { safeStop = false } = {}) {
      if (typeof operationKey !== "string" || !operationKey)
        throw Error("缺少操作标识。");
      if (!legacy?.requestId || typeof legacy.requestId !== "string")
        throw Error("旧请求缺少原始身份。");
      const request = exactRequest(legacy.request, legacy.requestId);
      if (safeStop && !isSafeStop(request))
        throw Error("仅停止原执行可使用安全停止通道。");
      const record = {
        operationKey,
        requestId: legacy.requestId,
        request,
        checkpoint: clone(legacy.checkpoint ?? null),
        createdAt: Date.now(),
      };
      try {
        return await locked((records) => {
          const old = existing(records, operationKey, legacy.requestId);
          if (old) {
            if (
              old.requestId !== legacy.requestId ||
              old.operationKey !== operationKey
            )
              throw Error("旧请求身份与待核对记录冲突。");
            compatible(old, request);
            return persistExisting(records, old);
          }
          write([...records, record]);
          return clone(record);
        });
      } catch (error) {
        if (
          !safeStop ||
          !["WORKSPACE_STORAGE", "WORKSPACE_COORDINATION"].includes(error.code)
        )
          throw error;
        return retainStop(operationKey, record, error);
      }
    },
    checkpoint(requestId, value) {
      return locked((records) => {
        const record = records.find((item) => item.requestId === requestId);
        if (!record) throw Error("原请求尚未保存。");
        record.checkpoint = clone(value);
        write(records);
      });
    },
    async resolve(requestId, outcome) {
      if (!["acknowledged", "rejected", "sealed"].includes(outcome))
        throw Error("未确认的请求不能删除。");
      const memory = [...memoryStops.values()].find(
        (item) => item.requestId === requestId,
      );
      if (memory) {
        memoryStops.delete(memory.operationKey);
        refresh();
        return;
      }
      return locked((records) =>
        write(records.filter((item) => item.requestId !== requestId)),
      );
    },
  };
  return store;
}

export function useWorkspaceRequests(scope) {
  const store = useMemo(() => createWorkspaceRequests(scope), [scope]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { ...store, ...snapshot };
}
