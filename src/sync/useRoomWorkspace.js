import { useCallback, useEffect, useRef, useState } from "react";
import { RoomReplica } from "./room-client.js";
import { equal, undoChanges, ConflictError } from "./replica.js";
import { claimDraftIdentity, openDrafts } from "./drafts.js";
import { sharedObject } from "../../shared/canvas-contract.js";
import {
  attributeLocalBlocks,
  rememberTaskAuthors,
} from "../../shared/task-authors.js";
import { defaultView } from "../canvas/geometry.js";
import { patchObjects, now } from "../canvas/model.js";
import { effectivelyLocked } from "../canvas/layout.js";
import {
  assetIdsToHydrate,
  prepareEdit,
  projectObjects,
  transactionBaseAfterRemote,
  withLocalLayout,
} from "./workspace-changes.js";

export function useRoomWorkspace(room, user) {
  const [state, setState] = useState(null),
    [status, setStatus] = useState("loading");
  const [error, setError] = useState(""),
    [conflict, setConflict] = useState(null);
  const [members, setMembers] = useState([]),
    [profiles, setProfiles] = useState([]),
    [assetVersion, setAssetVersion] = useState(0);
  const [, renderHistory] = useState(0);
  const current = useRef(null),
    engine = useRef(null),
    db = useRef(null),
    socket = useRef(null);
  const assets = useRef(new Map()),
    uploaded = useRef(new Map()),
    life = useRef(null);
  const history = useRef({ past: [], future: [], base: null });
  const projections = useRef(new WeakMap());
  const authors = useRef(new Map());
  const profileDirectory = useRef([]);
  const setCurrent = useCallback((value) => {
    rememberTaskAuthors(value.objects, authors.current);
    current.current = value;
    setState(value);
  }, []);
  const persist = async () => {
    if (!db.current || !engine.current || !current.current) return;
    await db.current.put("drafts", life.current.key, {
      replica: structuredClone(engine.current.save()),
      view: current.current.preferences.views[room.id],
      assets: current.current.assets,
      trash: current.current.trash,
      profiles: profileDirectory.current,
    });
  };
  const persistError = (e) => {
    setError(`本地草稿未能保存：${e.message}`);
    setStatus("error");
  };
  const hydrate = async () => {
    const e = life.current;
    for (const assetId of assetIdsToHydrate(current.current)) {
      if (e.closed) return;
      if (assets.current.has(assetId)) continue;
      try {
        let blob = await db.current.get("assets", `${room.id}/${assetId}`);
        if (!blob) {
          const response = await fetch(
            `/api/rooms/${room.id}/assets/${assetId}`,
            { headers: { "X-QD-Account": user.id } },
          );
          if (!response.ok) throw new Error("图片加载失败，点击重试。");
          blob = await response.blob();
          await db.current.put("assets", `${room.id}/${assetId}`, blob);
        }
        if (e.closed) return;
        assets.current.set(assetId, blob);
        setAssetVersion((v) => v + 1);
      } catch (err) {
        if (!e.closed) setError(err.message);
      }
    }
  };
  const publish = async () => {
    const e = life.current,
      replica = engine.current;
    if (
      !e ||
      e.closed ||
      e.busy ||
      !replica?.ready ||
      replica.conflict ||
      replica.error
    )
      return;
    e.busy = true;
    try {
      for (const object of current.current.objects) {
        if (object.type !== "image" || object.assetMetadata) continue;
        let meta = uploaded.current.get(object.assetId);
        if (!meta) {
          const blob = assets.current.get(object.assetId);
          if (!blob) throw new Error("图片文件尚未加载，请重试。");
          setStatus("uploading");
          const response = await fetch(
            `/api/rooms/${room.id}/assets/${object.assetId}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": blob.type,
                "X-File-Name": encodeURIComponent(object.alt || "图片"),
                "X-QD-Account": user.id,
              },
              body: blob,
            },
          );
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "图片上传失败。");
          meta = data;
          uploaded.current.set(object.assetId, meta);
        }
        if (e.closed) return;
        const next = {
          ...current.current,
          objects: current.current.objects.map((o) =>
            o.assetId === object.assetId
              ? {
                  ...o,
                  assetMetadata: {
                    id: meta.id,
                    mime: meta.mime,
                    byteLength: meta.byteLength,
                  },
                }
              : o,
          ),
        };
        setCurrent(next);
        replica.edit(next.objects.map(sharedObject));
      }
      if (!e.closed) replica.flush();
    } catch (err) {
      if (!e.closed) {
        setError(err.message);
        setStatus("error");
      }
    } finally {
      e.busy = false;
    }
  };
  const schedule = () => {
    const e = life.current;
    if (!e || e.closed) return;
    clearTimeout(e.publishTimer);
    e.publishTimer = setTimeout(() => void publish(), 120);
  };
  useEffect(() => {
    const tabKey = `qingdan.cloud.tab.${room.id}`;
    let tab = sessionStorage.getItem(tabKey);
    if (!tab) {
      tab = crypto.randomUUID();
      sessionStorage.setItem(tabKey, tab);
    }
    const e = {
      closed: false,
      key: `${user.id}/${room.id}/${tab}`,
      delay: 500,
      busy: false,
      publishTimer: null,
      reconnect: null,
      heartbeat: null,
      lastMessage: Date.now(),
      sendQueue: Promise.resolve(),
    };
    life.current = e;
    const syncState = () => {
      if (e.closed) return;
      const r = engine.current,
        previous = current.current;
      if (history.current.base && !equal(previous.objects, r.objects))
        history.current.base = transactionBaseAfterRemote(
          history.current.base,
          previous.objects,
          r.objects,
        );
      const meta = { ...previous.assets };
      for (const o of r.objects)
        if (o.type === "image" && o.assetMetadata)
          meta[o.assetId] = { ...o.assetMetadata, name: o.alt || "图片" };
      setCurrent({
        ...previous,
        objects: withLocalLayout(r.objects, previous.objects),
        assets: meta,
      });
      setConflict(r.conflict);
      if (r.error) setError(r.error);
      setStatus(
        r.conflict
          ? "conflict"
          : r.error
            ? "error"
            : !r.ready
              ? "offline"
              : r.dirty
                ? "saving"
                : "saved",
      );
      void persist().catch(persistError);
      void hydrate();
      schedule();
    };
    const connect = () => {
      if (e.closed) return;
      const url = new URL(`/api/rooms/${room.id}/socket`, location.href);
      url.searchParams.set("account", user.id);
      url.searchParams.set("authors", "1");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        e.delay = 500;
        e.lastMessage = Date.now();
        setError("");
      };
      ws.onmessage = (event) => {
        if (e.closed || socket.current !== ws) return;
        e.lastMessage = Date.now();
        if (event.data === "pong") return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "presence") {
            setMembers(message.members);
            if (Array.isArray(message.profiles)) {
              profileDirectory.current = message.profiles;
              setProfiles(message.profiles);
              void persist().catch(persistError);
            }
          } else engine.current.receive(message);
        } catch (err) {
          setError(err.message);
          setStatus("error");
        }
      };
      ws.onerror = () => {};
      ws.onclose = (event) => {
        if (e.closed || socket.current !== ws) return;
        engine.current.ready = false;
        setMembers([]);
        setStatus("offline");
        if (event.code === 1008) {
          setError("登录已失效，请重新登录。草稿已保留在当前账号。");
          window.dispatchEvent(new Event("qingdan-session-expired"));
          return;
        }
        e.reconnect = setTimeout(connect, e.delay + Math.random() * 250);
        e.delay = Math.min(15000, e.delay * 2);
      };
    };
    (async () => {
      try {
        const originalKey = e.key;
        const identity = await claimDraftIdentity(`${user.id}/${room.id}`, tab);
        if (e.closed) {
          identity.release();
          return;
        }
        e.release = identity.release;
        e.key = `${user.id}/${room.id}/${identity.id}`;
        sessionStorage.setItem(tabKey, identity.id);
        const repository = await openDrafts();
        if (e.closed) {
          repository.close();
          identity.release();
          return;
        }
        db.current = repository;
        const saved =
          (await repository.get("drafts", e.key)) ||
          (e.key !== originalKey
            ? await repository.get("drafts", originalKey)
            : null);
        if (e.closed) return;
        authors.current = new Map();
        profileDirectory.current = saved?.profiles || [];
        setProfiles(profileDirectory.current);
        for (const batch of saved?.trash || []) {
          rememberTaskAuthors(batch.objects, authors.current);
          if (batch.kind === "task")
            rememberTaskAuthors(
              [{ ...batch.task.note, blocks: [batch.task.block] }],
              authors.current,
            );
        }
        const initial = {
          version: 2,
          revision: 0,
          boards: [
            {
              id: room.id,
              name: room.name,
              type: "canvas",
              createdAt: room.createdAt,
            },
          ],
          objects: saved?.replica?.objects || [],
          assets: saved?.assets || {},
          trash: saved?.trash || [],
          preferences: {
            activeBoardId: room.id,
            views: {
              [room.id]: saved?.view || { ...defaultView(), x: 80, y: 40 },
            },
          },
        };
        setCurrent(initial);
        engine.current = new RoomReplica(
          saved?.replica,
          (message) => {
            e.sendQueue = e.sendQueue
              .then(async () => {
                await persist();
                if (!e.closed && socket.current?.readyState === WebSocket.OPEN)
                  socket.current.send(JSON.stringify(message));
              })
              .catch(persistError);
          },
          syncState,
        );
        await hydrate();
        connect();
        e.heartbeat = setInterval(() => {
          const ws = socket.current;
          if (ws?.readyState === WebSocket.OPEN) {
            if (Date.now() - e.lastMessage > 60000) ws.close();
            else ws.send("ping");
          }
        }, 20000);
      } catch (err) {
        if (!e.closed) {
          setError(err.message);
          setStatus("error");
        }
      }
    })();
    const beforeUnload = (event) => {
      if (engine.current?.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const online = () => {
      if (socket.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(e.reconnect);
        connect();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("online", online);
    return () => {
      void persist()
        .catch(() => {})
        .finally(() => {
          db.current?.close();
          e.release?.();
        });
      e.closed = true;
      clearTimeout(e.publishTimer);
      clearTimeout(e.reconnect);
      clearInterval(e.heartbeat);
      socket.current?.close();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("online", online);
    };
  }, [room.id, user.id]);
  const update = useCallback(
    (action, options = {}) => {
      if (!current.current) return;
      if (engine.current?.conflict && !options.navigation) return;
      const before = current.current;
      let next = typeof action === "function" ? action(before) : action;
      if (!next || next === before) return;
      let prepared;
      try {
        if (options.source) {
          const previous =
            projections.current.get(options.source) || options.source.objects;
          const proposed = next.objects;
          next = {
            ...before,
            objects: projectObjects(previous, proposed, before.objects),
          };
          projections.current.set(options.source, proposed);
        }
        next = {
          ...next,
          objects: attributeLocalBlocks(next.objects, user, authors.current),
        };
        prepared = prepareEdit(next);
      } catch (err) {
        setError(
          err instanceof ConflictError
            ? "调整期间同一内容发生了变化。本次调整未应用，请松开鼠标后重试。"
            : `${err.message} 本次修改未应用。`,
        );
        setStatus("error");
        return;
      }
      const changed = !equal(prepareEdit(before), prepared);
      if (changed && options.record !== false && !history.current.base) {
        history.current.past.push({
          before: before.objects,
          after: next.objects,
        });
        history.current.past = history.current.past.slice(-60);
        history.current.future = [];
      }
      setCurrent({
        ...next,
        objects: withLocalLayout(next.objects, before.objects),
      });
      if (changed) {
        engine.current.error = "";
        engine.current.edit(prepared);
      } else void persist().catch(persistError);
    },
    [setCurrent, user.id, user.name],
  );
  const begin = useCallback(() => {
    if (!history.current.base) history.current.base = current.current.objects;
  }, []);
  const end = useCallback(
    (cancel = false) => {
      const h = history.current,
        before = h.base;
      h.base = null;
      if (!before || equal(before, current.current.objects)) return;
      if (cancel) {
        try {
          const objects = undoChanges(
            before,
            current.current.objects,
            current.current.objects,
          );
          update((s) => ({ ...s, objects }), { record: false });
        } catch {
          setError("取消操作遇到共享内容变化，请通过撤销处理。");
        }
      } else {
        h.past.push({ before, after: current.current.objects });
        h.past = h.past.slice(-60);
        h.future = [];
        renderHistory((n) => n + 1);
      }
    },
    [update],
  );
  const travel = (direction) => {
    end();
    const h = history.current,
      from = direction === "undo" ? h.past : h.future,
      to = direction === "undo" ? h.future : h.past;
    const entry = from.at(-1);
    if (!entry) return;
    try {
      const next =
        direction === "undo"
          ? undoChanges(entry.before, entry.after, current.current.objects)
          : undoChanges(entry.after, entry.before, current.current.objects);
      from.pop();
      to.push(entry);
      update((s) => ({ ...s, objects: next }), { record: false });
    } catch {
      setError(
        "其他成员已修改同一内容，无法撤销覆盖。可以继续编辑或导出备份。",
      );
    }
  };
  const toggleBlock = (noteId, blockId) => {
    const note = current.current.objects.find((o) => o.id === noteId);
    if (!note || effectivelyLocked(current.current.objects, noteId)) return;
    const block = note.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const changed = {
      ...block,
      done: !block.done,
      completedAt: block.done ? null : now(),
    };
    update((s) =>
      patchObjects(s, {
        [noteId]: {
          blocks: note.blocks.map((b) => (b.id === blockId ? changed : b)),
        },
      }),
    );
    return () =>
      update((s) => {
        const latest = s.objects.find((o) => o.id === noteId);
        if (!latest) return s;
        return patchObjects(s, {
          [noteId]: {
            blocks: latest.blocks.map((b) =>
              b.id === blockId &&
              b.done === changed.done &&
              b.completedAt === changed.completedAt
                ? { ...b, done: block.done, completedAt: block.completedAt }
                : b,
            ),
          },
        });
      });
  };
  return {
    state,
    current,
    update,
    begin,
    end,
    toggleBlock,
    status,
    error,
    conflict,
    members,
    profiles,
    readOnly: !state || !!conflict,
    assets: assets.current,
    assetVersion,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    undoIfLast: (before) => {
      if (history.current.past.at(-1)?.before !== before.objects) return false;
      travel("undo");
      return true;
    },
    addAssets: (entries) => {
      for (const [id, blob] of entries) {
        assets.current.set(id, blob);
        void db.current
          .put("assets", `${room.id}/${id}`, blob)
          .catch(persistError);
      }
      setAssetVersion((v) => v + 1);
    },
    resolve: (choice) => engine.current.resolve(choice),
    retry: () => {
      setError("");
      engine.current.retry();
      void hydrate();
      schedule();
    },
    dirty: engine.current?.dirty,
  };
}
