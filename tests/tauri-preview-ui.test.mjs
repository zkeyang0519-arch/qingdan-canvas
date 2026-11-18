import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

test("packaged verification canvas completes/restores tasks and preserves restored input on quit", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://tauri.localhost/tauri-preview.html",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "MouseEvent",
    "localStorage",
    "location",
    "getComputedStyle",
  ])
    globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 1);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const drafts = { "previous-page": "已恢复但尚未改动的输入" };
  localStorage.setItem(
    "qingdao.tauri.preview.workspace.v1.drafts",
    JSON.stringify(drafts),
  );
  let save,
    downloadCount = 0;
  const layouts = [];
  window.qingdanDesktop = {
    version: 1,
    getUpdateState: async () => ({
      status: "unsupported",
      currentVersion: "0.4.0-preview.3",
    }),
    openPreviewDownloads: async () => {
      downloadCount++;
    },
    setLayout: async (value) => {
      layouts.push(value);
      return {};
    },
    getPlacement: async () => ({
      dock: "top",
      supportsJade: true,
      supportsTwinIsland: true,
      supportsRetainedTwinIsland: true,
      maxHeight: 1040,
      maxWidth: 1920,
    }),
    onPlacement: () => () => {},
    onBeforeQuit: (cb) => {
      save = cb;
      return () => {};
    },
    hide: async () => {},
  };
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/tauri-preview-test-"));
  let preview;
  t.after(async () => {
    if (preview) await act(async () => preview.previewRoot.unmount());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  });
  const output = path.join(directory, "preview.mjs");
  await build({
    entryPoints: ["src/desktop/TauriPreview.jsx"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react-dom/client", "lucide-react"],
  });
  const { act } = await import("react");
  await act(async () => {
    preview = await import(pathToFileURL(output));
  });
  assert.equal(
    document.querySelector(".dynamic-island-dock").style.top,
    "12px",
  );
  await act(async () =>
    document.querySelector('[aria-label="展开轻岛"]').click(),
  );
  await act(async () =>
    document.querySelector('button[aria-label="轻岛设置"]').click(),
  );
  await act(async () =>
    document.querySelector('button[aria-label="四季草地"]').click(),
  );
  assert.ok(document.querySelector(".island-twin-main .island-meadow-surface"));
  assert.ok(document.querySelector('[aria-label="草地滚动速度"]'));
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "下载轻量版")
      .click(),
  );
  assert.equal(downloadCount, 1);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(layouts.at(-1).appearance, "jade-twins");
  assert.equal(layouts.at(-1).retained, true);
  assert.equal(layouts.at(-1).expanded, true);
  await act(async () =>
    document.querySelector('[aria-label="返回待办列表"]').click(),
  );
  await act(async () =>
    document.querySelector(".island-task-row input[type=checkbox]").click(),
  );
  assert.match(document.body.textContent, /已完成 1/);
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "已完成 1")
      .click(),
  );
  await act(async () =>
    document
      .querySelector(".island-task-row input[type=checkbox]:checked")
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "返回待办")
      .click(),
  );
  assert.match(document.body.textContent, /已完成 0/);
  const saved = await save();
  assert.equal(saved.draftsPersisted, true);
  assert.deepEqual(
    JSON.parse(
      localStorage.getItem("qingdao.tauri.preview.workspace.v1.drafts"),
    ),
    drafts,
  );
});
