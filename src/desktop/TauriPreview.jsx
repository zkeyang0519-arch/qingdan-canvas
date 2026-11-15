import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DynamicIsland from "../island/DynamicIsland.jsx";
import {
  createWorkspace,
  createObject,
  makeBlock,
  patchObjects,
} from "../canvas/model.js";
import { useDesktopPlacement } from "./useDesktopPlacement.js";
import "./desktop.css";
import "./jade-island.css";
import "../app.css";
const bridge = window.qingdanDesktop;
const key = "qingdao.tauri.preview.workspace.v1";
function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.boards?.length) return saved;
  } catch {}
  const state = createWorkspace();
  state.boards[0].name = "轻岛验证画布";
  state.objects = [
    {
      ...createObject(state.boards[0].id, "note"),
      noteKind: "checklist",
      blocks: [
        "拖动胶囊，试试顶部和左右停靠",
        "展开后添加、完成和恢复待办",
        "试试透明间隙能否点击后面的窗口",
        "从托盘进入真实轻单",
      ].map((text) => makeBlock(text)),
    },
  ];
  return state;
}
function Preview() {
  const [state, setState] = useState(initial);
  const [initialDrafts] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key + ".drafts")) || {};
    } catch {
      return {};
    }
  });
  const current = useRef(state),
    root = useRef(null),
    drafts = useRef(initialDrafts);
  const desktop = useDesktopPlacement(bridge);
  const update = (change) => {
    const next = change(current.current);
    localStorage.setItem(key, JSON.stringify(next));
    current.current = next;
    setState(next);
  };
  useEffect(
    () =>
      bridge.onBeforeQuit(async () => {
        localStorage.setItem(key, JSON.stringify(current.current));
        localStorage.setItem(key + ".drafts", JSON.stringify(drafts.current));
        return {
          unsynced: false,
          hasDraft: Object.values(drafts.current).some(Boolean),
          draftsPersisted: true,
        };
      }),
    [],
  );
  useLayoutEffect(() => {
    document.documentElement.classList.add("qingdan-desktop");
    document.documentElement.dataset.desktopMode = "island";
    const target = root.current.querySelector(".dynamic-island");
    let frame;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = target.getBoundingClientRect();
        bridge
          .setLayout({
            mode: "island",
            appearance: "jade",
            dock: desktop.dragging ? "free" : desktop.dock,
            expanded: target.dataset.open === "true",
            width: Math.ceil(r.width) + 24,
            height: Math.ceil(r.height) + 24,
          })
          .catch(console.error);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [desktop.dock, desktop.dragging]);
  return (
    <main ref={root} className="desktop-island-workspace">
      <DynamicIsland
        workspace={{
          state,
          current,
          update,
          toggleBlock: (noteId, blockId) =>
            update((latest) => {
              const note = latest.objects.find((item) => item.id === noteId);
              if (!note) return latest;
              return patchObjects(latest, {
                [noteId]: {
                  blocks: note.blocks.map((block) =>
                    block.id === blockId
                      ? {
                          ...block,
                          done: !block.done,
                          completedAt: block.done
                            ? null
                            : new Date().toISOString(),
                        }
                      : block,
                  ),
                },
              });
            }),
          readOnly: false,
          status: "saved",
          assets: new Map(),
        }}
        boardId={state.boards[0].id}
        top={12}
        desktop={desktop}
        dragHandleTitle="拖动轻岛"
        closeOnWindowBlur
        onDisable={() => bridge.hide()}
        initialDrafts={initialDrafts}
        onDraftsChange={(value) => {
          drafts.current = value;
          localStorage.setItem(key + ".drafts", JSON.stringify(value));
        }}
        panelNotice={
          <p style={{ fontSize: 11, opacity: 0.65 }}>
            本地验证画布 · 数据仅保存在此验证版
          </p>
        }
      />
    </main>
  );
}
export const previewRoot = createRoot(document.getElementById("root"));
previewRoot.render(bridge ? <Preview /> : <p>请在轻岛 Tauri 验证版中打开。</p>);
