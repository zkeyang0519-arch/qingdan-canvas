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
import "../../src/desktop/glass-island.css";
import IslandAppearanceSettings from "../../src/desktop/IslandAppearanceSettings.jsx";
import { useIslandAppearance } from "../../src/desktop/useIslandAppearance.js";
import "./island-settings-preview.css";

const listeners = new Set();
let updateState = { status: "idle", currentVersion: "0.3.6" };
function previewUpdate(patch) {
  updateState = { currentVersion: "0.3.6", ...patch };
  for (const callback of listeners) callback(updateState);
  return updateState;
}
const previewDelay = () => new Promise((resolve) => setTimeout(resolve, 400));
const previewBridge = {
  getUpdateState: async () => updateState,
  onUpdateState: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  checkForUpdates: async () => {
    previewUpdate({ status: "checking" });
    await previewDelay();
    const version = "0.3.7（交互演示）";
    previewUpdate({ status: "available", version });
    for (const progress of [25, 70, 100]) {
      await previewDelay();
      previewUpdate({ status: "downloading", version, progress });
    }
    return previewUpdate({ status: "downloaded", version });
  },
  installUpdate: async () => {
    previewUpdate({ status: "installing", version: updateState.version });
    await previewDelay();
    previewUpdate({
      status: "idle",
      message: "演示完成：未下载安装，也未重启客户端。",
    });
  },
};

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
  state.preferences = {
    views: {
      [state.boards[0].id]: { dynamicIsland: { enabled: true, pinned: true } },
    },
  };
  return state;
}
function Preview() {
  const [state, setState] = useState(example);
  const [dock, setDock] = useState("top");
  const [backdrop, setBackdrop] = useState("mist");
  const appearance = useIslandAppearance(true);
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
          <h1>轻岛外观</h1>
        </div>
        <p>示例待办 · 更新按钮为交互演示</p>
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
      <div className="preview-layout">
        <aside className="preview-editor">
          <div className="preview-editor-title">
            <span>01 / 外观</span>
            <h2>调成你喜欢的样子</h2>
          </div>
          <IslandAppearanceSettings
            value={appearance.value}
            onChange={appearance.update}
            error={appearance.error}
          />
          <div className="preview-backdrops">
            <span>浅色背景</span>
            <div>
              {[
                ["mist", "薄雾"],
                ["paper", "纯白"],
                ["grid", "方格"],
              ].map(([value, title]) => (
                <button
                  key={value}
                  data-background={value}
                  aria-pressed={backdrop === value}
                  onClick={() => setBackdrop(value)}
                >
                  {title}
                </button>
              ))}
            </div>
          </div>
          <p className="preview-editor-hint">
            点击轻岛右上角的设置按钮，试用下方弹窗、检查更新和历史预览。
          </p>
        </aside>
        <section
          className="preview-stage"
          data-side={dock}
          data-backdrop={backdrop}
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
              updateBridge={previewBridge}
              desktop={{
                dock,
                dragging: false,
                supportsJade: true,
                supportsTwinIsland: true,
                supportsRetainedTwinIsland: true,
                handlers: { onPointerDown() {} },
              }}
              panelToolbar={
                <span className="preview-settings-note">
                  独立预览 · 示例数据
                </span>
              }
            />
          </div>
        </section>
      </div>
      <footer className="preview-help">
        悬停小仓展开剩余待办 · 大仓按住拖动 ·{" "}
        {dock === "top" ? "点击圆圈完成待办" : "在列表中勾选完成"}
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")).render(<Preview />);
