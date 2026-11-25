import React, { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { filmUrl } from "./film-model.js";

export default function FilmVersionHistory({
  card,
  scope,
  call,
  artifacts,
  media,
  restore,
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const base = "/" + card.id + "/revisions";
  const current = { rev: card.rev, updated: card.updated, spec: card.spec };
  const version = snapshot || current;
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function read(fn) {
    const token = ++request.current;
    setBusy(true);
    setError("");
    try {
      const apply = await fn();
      if (token === request.current) apply();
    } catch (e) {
      if (token === request.current)
        setError(e.message || "无法读取工作版本。");
    } finally {
      if (token === request.current) setBusy(false);
    }
  }
  function list(append = false) {
    void read(async () => {
      const data = await call(
        filmUrl(scope, base, append ? { before: rows.at(-1).rev } : {}),
      );
      if (!Array.isArray(data.revisions)) throw Error("工作版本记录暂不可用。");
      return () => {
        setRows((previous) =>
          append ? [...previous, ...data.revisions] : data.revisions,
        );
        setMore(data.hasMore);
      };
    });
  }
  function choose(rev) {
    if (rev === card.rev) {
      setSnapshot(null);
      return;
    }
    void read(async () => {
      const data = await call(filmUrl(scope, base + "/" + rev));
      return () => setSnapshot(data);
    });
  }
  function close() {
    request.current++;
    setOpen(false);
    setBusy(false);
    setSnapshot(null);
  }
  const script = artifacts.find((a) => a.id === version.spec.scriptId);
  return (
    <div className="studio-version-history">
      <button
        type="button"
        aria-label={`工作版本 V${card.rev}`}
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            list();
          }
        }}
      >
        <History size={15} />{" "}
        <span className="studio-version-label">工作版本</span> V{card.rev}
      </button>
      {open && (
        <section aria-label="工作版本历史" className="studio-surface">
          <label>
            查看工作版本
            <select
              disabled={busy}
              value={version.rev}
              onChange={(e) => choose(Number(e.target.value))}
            >
              <option value={card.rev}>V{card.rev} · 当前工作版</option>
              {rows
                .filter((row) => row.rev !== card.rev)
                .map((row) => (
                  <option key={row.rev} value={row.rev}>
                    V{row.rev} · {new Date(row.updated).toLocaleString()}
                  </option>
                ))}
            </select>
          </label>
          {busy && <small role="status">正在读取版本…</small>}
          {error && (
            <p role="alert">
              {error}{" "}
              <button type="button" onClick={() => list()}>
                重新读取版本
              </button>
            </p>
          )}
          {more && (
            <button type="button" disabled={busy} onClick={() => list(true)}>
              更早的工作版本
            </button>
          )}
          <h4>{version.spec.title}</h4>
          <p>{version.spec.brief}</p>
          {script && (
            <details>
              <summary>本版分镜 · {script.title}</summary>
              <pre>{script.text}</pre>
            </details>
          )}
          <div className="film-thumbs">
            {version.spec.refs.map((ref, i) => {
              const a = artifacts.find((item) => item.id === ref);
              return a?.mediaId ? (
                <figure key={ref}>
                  <img src={media(a)} alt={a.title} />
                  <figcaption>
                    图 {i + 1} · {a.title}
                  </figcaption>
                </figure>
              ) : (
                <span key={ref}>
                  图 {i + 1} · {a?.title || "素材已不可用"}
                </span>
              );
            })}
          </div>
          {version.rev !== card.rev && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                restore(version.spec);
                close();
              }}
            >
              以此版继续编辑
            </button>
          )}
        </section>
      )}
    </div>
  );
}
