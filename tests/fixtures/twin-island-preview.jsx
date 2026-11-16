import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DynamicIsland from "../../src/island/DynamicIsland.jsx";
import {
  createWorkspace,
  createObject,
  makeBlock,
  patchObjects,
} from "../../src/canvas/model.js";
import "../../src/desktop/desktop.css";
import "../../src/desktop/jade-island.css";
import "../../src/desktop/twins-island.css";
import "../../src/ui/luma.css";

// Real presentation, with an in-memory workspace adapter only.
// This preview never opens the user's IndexedDB, account or desktop profile.
function example() {
  const state = createWorkspace();
  const deadline = new Date();
  deadline.setHours(14, 30, 0, 0);
  state.objects = [
    {
      ...createObject(state.boards[0].id, "note"),
      noteKind: "checklist",
      blocks: [
        { ...makeBlock("整理本周的灵感与计划"), dueAt: deadline.toISOString() },
        makeBlock("给阳台的小植物浇水"),
        makeBlock("下班后出门走一走"),
      ],
    },
  ];
  return state;
}
function Preview() {
  const [state, setState] = useState(example);
  const [dock, setDock] = useState("top");
  const [generation, setGeneration] = useState(0);
  const current = useRef(state);
  current.current = state;
  const update = (action) => {
    current.current = action(current.current);
    setState(current.current);
  };
  const workspace = {
    state,
    current,
    update,
    status: "saved",
    readOnly: false,
    toggleBlock: (id, key) =>
      update((value) =>
        patchObjects(value, {
          [id]: {
            blocks: value.objects
              .find((note) => note.id === id)
              .blocks.map((block) =>
                block.id === key
                  ? {
                      ...block,
                      done: !block.done,
                      completedAt: block.done ? null : new Date().toISOString(),
                    }
                  : block,
              ),
          },
        }),
      ),
    flushLocal: async () => {},
  };
  return (
    <>
      <header className="preview-heading">
        <div>
          <small>轻单 · 轻岛</small>
          <h1>雾玉双岛</h1>
        </div>
        <p>独立预览 · 示例数据</p>
      </header>
      <nav className="preview-controls" aria-label="预览控制">
        <div>
          {[
            ["top", "横向"],
            ["left", "左侧贴边"],
            ["right", "右侧贴边"],
          ].map(([value, title]) => (
            <button
              key={value}
              aria-pressed={dock === value}
              onClick={() => setDock(value)}
            >
              {title}
            </button>
          ))}
        </div>
        <div>
          <button
            onClick={() => {
              setState(example());
              setGeneration((v) => v + 1);
            }}
          >
            还原示例
          </button>
          <button
            onClick={() =>
              update((value) =>
                patchObjects(
                  value,
                  Object.fromEntries(
                    value.objects.map((note) => [
                      note.id,
                      {
                        blocks: note.blocks.map((block) => ({
                          ...block,
                          done: true,
                        })),
                      },
                    ]),
                  ),
                ),
              )
            }
          >
            查看空待办
          </button>
        </div>
      </nav>
      <section
        className="preview-stage"
        data-side={dock}
        aria-label="轻岛真实组件预览"
      >
        <div className="preview-guide">
          {dock === "top"
            ? "横向双岛"
            : dock === "left"
              ? "左侧贴边"
              : "右侧贴边"}
        </div>
        <div className="desktop-island-workspace">
          <DynamicIsland
            key={generation}
            workspace={workspace}
            boardId={state.boards[0].id}
            dragHandleTitle="拖动轻岛"
            top={0}
            onDisable={() => setGeneration((v) => v + 1)}
            closeText="收起预览"
            closeLabel="收起预览"
            desktop={{
              dock,
              dragging: false,
              supportsJade: true,
              supportsTwinIsland: true,
              handlers: { onPointerDown() {} },
            }}
            panelToolbar={<span>预览中的操作只影响示例待办</span>}
          />
        </div>
      </section>
      <footer className="preview-help">
        悬停展开全部待办 · 点击圆圈完成待办
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")).render(<Preview />);
