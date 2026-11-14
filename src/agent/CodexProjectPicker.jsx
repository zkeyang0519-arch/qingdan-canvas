import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Folder, RefreshCw, Search } from "lucide-react";

function directoryKey(value) {
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value))
    return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return value.replace(/\/+$/, "") || "/";
}

function searchKey(value) {
  return value.replaceAll("\\", "/").toLocaleLowerCase();
}

export default function CodexProjectPicker(props) {
  const mode = props.mode || "add";
  const discover = typeof props.requestLocal === "function";
  return (
    <ProjectDirectory
      key={JSON.stringify([props.userId, mode, discover])}
      {...props}
      selecting={mode === "select"}
      discover={discover}
    />
  );
}

function ProjectDirectory({
  userId,
  requestLocal,
  workspaces = [],
  disabled,
  onSelect,
  selecting,
  discover,
}) {
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [opened, setOpened] = useState(selecting);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState(null);
  const [search, setSearch] = useState("");
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const request = useRef(requestLocal);

  useLayoutEffect(() => {
    request.current = requestLocal;
  }, [requestLocal]);

  useLayoutEffect(() => {
    return () => {
      generation.current++;
      loadingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (selecting && discover) void load();
  }, [selecting, discover]);

  async function load(next = null) {
    if (loadingRef.current) return;
    const epoch = ++generation.current;
    loadingRef.current = true;
    setOpened(true);
    setLoading(true);
    setFailure(null);
    try {
      const result = await request.current(
        `/codex/sessions${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
        { accountId: userId },
      );
      if (epoch !== generation.current) return;
      setSessions((prior) => {
        const unique = new Map();
        for (const session of [
          ...(next ? prior : []),
          ...(result.sessions || []),
        ]) {
          if (
            !session.threadId ||
            typeof session.cwd !== "string" ||
            !session.cwd
          )
            continue;
          const key = directoryKey(session.cwd);
          if (!unique.has(key)) unique.set(key, session);
        }
        return [...unique.values()];
      });
      setCursor(
        result.nextCursor && result.nextCursor !== next
          ? result.nextCursor
          : null,
      );
    } catch (error) {
      if (epoch === generation.current)
        setFailure({
          message: error?.message || "获取 Codex 项目失败，请重试。",
          cursor: next,
        });
    } finally {
      if (epoch === generation.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  const directories = new Map();
  const registered = new Set();
  for (const workspace of workspaces) {
    const key = workspace.displayPath
      ? directoryKey(workspace.displayPath)
      : workspace.workspaceId;
    registered.add(key);
    if (selecting) {
      directories.set(key, {
        project: workspace,
        name: workspace.name || workspace.displayPath,
        path: workspace.displayPath,
        added: false,
      });
    }
  }
  for (const session of sessions) {
    const key = directoryKey(session.cwd);
    if (!directories.has(key)) {
      directories.set(key, {
        project: session,
        name: session.projectName || session.cwd,
        path: session.cwd,
        added: !selecting && registered.has(key),
      });
    }
  }

  const term = searchKey(search.trim());
  const filtered = [...directories].filter(([, directory]) =>
    searchKey(`${directory.name || ""}\n${directory.path || ""}`).includes(
      term,
    ),
  );
  const status = loading
    ? "正在读取 Codex 项目目录…"
    : failure
      ? ""
      : !directories.size
        ? discover
          ? "没有找到可用的项目目录。"
          : "这台设备暂无已授权的项目目录。"
        : !filtered.length
          ? cursor
            ? "已加载目录中无匹配项，可继续加载。"
            : "没有匹配的项目目录。"
          : "";

  return (
    <div
      className={selecting ? "agent-binding-directory" : "agent-codex-projects"}
    >
      {selecting ? (
        <div className="agent-binding-directory-tools">
          <label className="agent-binding-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="筛选项目"
              placeholder="搜索项目名称或路径"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {discover && !failure && (
            <button
              type="button"
              aria-label="刷新 Codex 项目"
              title="刷新 Codex 项目"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <div className="agent-actions">
          <button
            type="button"
            disabled={disabled || loading}
            onClick={() => void load(failure?.cursor)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {loading ? "正在获取…" : opened ? "重新获取" : "从 Codex 获取"}
          </button>
        </div>
      )}
      {failure && (
        <div className={selecting ? "agent-binding-feedback" : undefined}>
          <p className="agent-error" role="alert">
            {failure.message}
          </p>
          {selecting && (
            <button type="button" onClick={() => void load(failure.cursor)}>
              重试读取项目
            </button>
          )}
        </div>
      )}
      {opened && (
        <>
          {status && (
            <p
              className={selecting ? "agent-binding-empty" : "agent-note"}
              role="status"
            >
              {status}
            </p>
          )}
          {filtered.length > 0 && (
            <ul
              className={
                selecting
                  ? "agent-binding-directory-list"
                  : "agent-workspace-list agent-codex-project-list"
              }
              aria-label="Codex 项目目录"
            >
              {filtered.map(([key, { project, name, path, added }]) => (
                <li key={key}>
                  <Folder size={17} aria-hidden="true" />
                  <div>
                    <strong>{name}</strong>
                    {path && <p className="agent-path">{path}</p>}
                  </div>
                  <button
                    type="button"
                    aria-label={`${selecting ? "选择执行项目" : "添加 Codex 项目"} ${name}`}
                    disabled={disabled || (!selecting && loading) || added}
                    onClick={() => onSelect(project)}
                  >
                    {selecting ? "选择" : added ? "已添加" : "添加"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cursor && !failure && (
            <button
              type="button"
              disabled={loading || (!selecting && disabled)}
              onClick={() => void load(cursor)}
            >
              加载更多项目
            </button>
          )}
        </>
      )}
    </div>
  );
}
