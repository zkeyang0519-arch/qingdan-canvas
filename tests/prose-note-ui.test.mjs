import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "MouseEvent",
  "Event",
  "getComputedStyle",
  "localStorage",
  "DOMParser",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getSelection = dom.window.getSelection.bind(dom.window);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 10);
globalThis.cancelAnimationFrame = clearTimeout;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const { createRoot } = await import("react-dom/client");
const tempRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
await mkdir(tempRoot, { recursive: true });
const output = await mkdtemp(path.join(tempRoot, "prose-ui-"));
await build({
  stdin: {
    contents:
      'export { default as Note } from "./src/canvas/Note.jsx"; export { default as ArrangedWorkspace } from "./src/canvas/ArrangedWorkspace.jsx"; export { TodoToolsProvider } from "./src/canvas/TodoTools.jsx"; export { createWorkspace, createObject, makeBlock, objectText, patchObjects, restoreTrash } from "./src/canvas/model.js"; export { todoPages } from "./src/canvas/todoPages.js"; export { setSurface, clearCompletedPageTasks, deletePageTasks, setPageDeadline, sortPendingPageTasks } from "./src/canvas/arranged-model.js";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "omit-css",
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "test-css",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const {
  Note,
  ArrangedWorkspace,
  TodoToolsProvider,
  createWorkspace,
  createObject,
  makeBlock,
  objectText,
  patchObjects,
  todoPages,
  setSurface,
  clearCompletedPageTasks,
  deletePageTasks,
  restoreTrash,
  setPageDeadline,
  sortPendingPageTasks,
} = await import(pathToFileURL(path.join(output, "ui.mjs")));
after(async () => {
  dom.window.close();
  assert.ok(path.resolve(output).startsWith(path.resolve(tempRoot) + path.sep));
  await rm(output, { recursive: true, force: true });
});

async function mount(
  t,
  {
    lines = ["文章标题", "", "第一段。", "第二段。"],
    checklist = false,
    arranged = false,
    decorate = () => {},
  } = {},
) {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const note = {
    ...createObject(boardId, "note"),
    noteKind: checklist ? "checklist" : "text",
    blocks: lines.map((text) => makeBlock(text)),
  };
  decorate(note);
  state.objects = [note];
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host),
    controls = { references: [] };
  function Fixture() {
    const [currentState, setState] = useState(state);
    const [editing, setEditing] = useState(
      arranged ? null : { noteId: note.id, blockId: note.blocks[0].id },
    );
    const current = useRef(currentState),
      apiRef = useRef(null);
    current.current = currentState;
    const update = (action) => {
      current.current = action(current.current);
      setState(current.current);
    };
    Object.assign(controls, {
      state: () => current.current,
      update,
      api: () => apiRef.current,
    });
    const workspace = {
      state: currentState,
      current,
      update,
      assets: new Map(),
      assetVersion: 0,
      readOnly: false,
      begin() {},
      end() {},
      toggleBlock(noteId, blockId) {
        update((s) => {
          const note = s.objects.find((o) => o.id === noteId);
          return patchObjects(s, {
            [noteId]: {
              blocks: note.blocks.map((b) =>
                b.id === blockId
                  ? {
                      ...b,
                      done: !b.done,
                      completedAt: b.done ? null : new Date().toISOString(),
                    }
                  : b,
              ),
            },
          });
        });
      },
    };
    const props = {
      onEdit: (noteId, blockId) => setEditing({ noteId, blockId }),
      onExit: () => setEditing(null),
      onReference() {},
      onReferencePicker: (...args) => controls.references.push(args),
      onToast() {},
      onCollection() {},
    };
    return arranged
      ? React.createElement(
          TodoToolsProvider,
          {
            workspace,
            scope: "prose-test",
            beforeAction: props.onExit,
            onToast() {},
          },
          React.createElement(ArrangedWorkspace, {
            ...props,
            workspace,
            boardId,
            apiRef,
            editing,
          }),
        )
      : React.createElement(Note, {
          ...props,
          object: currentState.objects.find((o) => o.id === note.id),
          editing: !!editing,
          focusBlock: editing?.blockId,
          objects: new Map(currentState.objects.map((o) => [o.id, o])),
          onEdit: (blockId) => setEditing({ noteId: note.id, blockId }),
          onPatch: (patch) =>
            update((s) => patchObjects(s, { [note.id]: patch })),
        });
  }
  await act(async () => root.render(React.createElement(Fixture)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    host,
    note,
    boardId,
    ...controls,
    text: () =>
      objectText(controls.state().objects.find((o) => o.id === note.id)),
  };
}

async function key(element, key, extra = {}) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  await act(async () => element.dispatchEvent(event));
  return event;
}
async function paste(element, text) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type) => (type === "text/plain" ? text : "") },
  });
  await act(async () => element.dispatchEvent(event));
}
async function copy(element) {
  const values = new Map();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (type, value) => values.set(type, value) },
  });
  await act(async () => element.dispatchEvent(event));
  return values.get("text/plain");
}

test("旧的多段便签在同一编辑区内全文全选复制，保留空行", async (t) => {
  const f = await mount(t);
  const editors = f.host.querySelectorAll('[contenteditable="true"]');
  assert.equal(editors.length, 1, "整篇文章必须属于同一个文字编辑区");
  await key(editors[0], "a", { ctrlKey: true });
  assert.equal(await copy(editors[0]), "文章标题\n\n第一段。\n第二段。");
  assert.deepEqual(
    f.state().objects[0].blocks,
    f.note.blocks,
    "全选复制不重写旧内容",
  );
});

test("粘贴长文后仍在同一个文章编辑区中继续输入", async (t) => {
  const f = await mount(t, { lines: [""] });
  const article =
    "长文标题\r\n\r\n" + "这是正文。".repeat(1200) + "\r\n最后一段。";
  let editor = f.host.querySelector('[contenteditable="true"]');
  await paste(editor, article);
  assert.equal(f.host.querySelectorAll('[contenteditable="true"]').length, 1);
  assert.equal(f.text(), article.replace(/\r\n/g, "\n"));
  editor = f.host.querySelector('[contenteditable="true"]');
  await paste(editor, "继续写下去。");
  assert.equal(f.text(), article.replace(/\r\n/g, "\n") + "继续写下去。");
});

test("跨旧段落全选替换、继续粘贴和失焦不会丢失或重复正文", async (t) => {
  const f = await mount(t);
  const editor = f.host.querySelector('[contenteditable="true"]');
  await key(editor, "a", { metaKey: true });
  await paste(editor, "新标题\n\n整篇替换后的正文。");
  await paste(editor, "末尾补充。");
  await act(async () =>
    editor.dispatchEvent(new Event("focusout", { bubbles: true })),
  );
  assert.equal(f.text(), "新标题\n\n整篇替换后的正文。末尾补充。");
});

test("修改一段保留另一段的引用、身份和备注", async (t) => {
  const f = await mount(t, {
    lines: ["前段", "后段"],
    decorate(note) {
      note.blocks[1].runs.push({
        type: "ref",
        targetId: "reference",
        label: "参考资料",
      });
      note.blocks[1].remark = {
        text: "保留备注",
        updatedAt: "2026-11-03T00:00:00Z",
      };
      note.blocks[1].createdByUserId = "alice";
      note.blocks[1].createdByName = "小张";
    },
  });
  const editor = f.host.querySelector('[contenteditable="true"]');
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  await paste(editor, "新增：");
  assert.equal(f.text(), "新增：前段\n后段[[参考资料]]");
  assert.deepEqual(f.state().objects[0].blocks[1], f.note.blocks[1]);
});

test("跨段落的局部复制保留换行，替换选区连接前后正文", async (t) => {
  const f = await mount(t, { lines: ["前段保留", "中间段落", "后段保留"] });
  const editor = f.host.querySelector('[contenteditable="true"]');
  const range = document.createRange();
  range.setStart(editor.firstChild.firstChild, 2);
  range.setEnd(editor.lastChild.firstChild, 2);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  assert.equal(await copy(editor), "保留\n中间段落\n后段");
  await paste(editor, "插入");
  assert.equal(f.text(), "前段插入保留");
});

test("本地编辑不会覆盖协作者新增的段落和未修改段落", async (t) => {
  const f = await mount(t, { lines: ["前段", "后段"] });
  await act(async () =>
    f.update((s) => ({
      ...s,
      objects: s.objects.map((o) => ({
        ...o,
        blocks: [
          o.blocks[0],
          { ...o.blocks[1], runs: [{ type: "text", text: "协作者修改后段" }] },
          makeBlock("协作者新增段落"),
        ],
      })),
    })),
  );
  const editor = f.host.querySelector('[contenteditable="true"]');
  const range = document.createRange();
  range.selectNodeContents(editor.firstChild);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  await paste(editor, "本地补充");
  assert.equal(f.text(), "前段本地补充\n协作者修改后段\n协作者新增段落");
});

test("清单仍按行拆成独立待办", async (t) => {
  const f = await mount(t, { checklist: true, lines: [""] });
  await paste(
    f.host.querySelector('[contenteditable="true"]'),
    "第一项\n第二项",
  );
  assert.equal(f.host.querySelectorAll('[contenteditable="true"]').length, 2);
  assert.equal(f.state().objects[0].blocks.length, 2);
  assert.equal(f.state().objects[0].noteKind, "checklist");
});

test("浏览器空段落的占位 br 不会额外保存为一次换行", async (t) => {
  const f = await mount(t, { lines: [""] });
  const editor = f.host.querySelector('[contenteditable="true"]');
  editor.innerHTML = "<div>标题</div><div><br></div><div>正文</div>";
  await act(async () =>
    editor.dispatchEvent(new Event("input", { bubbles: true })),
  );
  assert.equal(f.text(), "标题\n\n正文");
  await key(editor, "a", { ctrlKey: true });
  assert.equal(await copy(editor), "标题\n\n正文");
});

test("全文替换后仍能用双方括号插入引用", async (t) => {
  const f = await mount(t);
  const editor = f.host.querySelector('[contenteditable="true"]');
  await key(editor, "a", { ctrlKey: true });
  await paste(editor, "替换后的正文[");
  await key(editor, "[");
  assert.deepEqual(f.references, [
    [f.note.id, f.state().objects[0].blocks[0].id],
  ]);
});

test("协作者在文章中间插入内容后，本地编辑保留其相邻顺序", async (t) => {
  const f = await mount(t, { lines: ["前段", "后段"] });
  await act(async () =>
    f.update((s) => ({
      ...s,
      objects: s.objects.map((o) => ({
        ...o,
        blocks: [o.blocks[0], makeBlock("协作者插入中间"), o.blocks[1]],
      })),
    })),
  );
  const editor = f.host.querySelector('[contenteditable="true"]');
  const range = document.createRange();
  range.selectNodeContents(editor.firstChild);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  await paste(editor, "本地补充");
  assert.equal(f.text(), "前段本地补充\n协作者插入中间\n后段");
});

test("切换排列把整篇文章列为一个待办，保留全部段落和原始存储", () => {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const article = {
    ...createObject(boardId, "note"),
    blocks: [makeBlock("文章标题"), makeBlock("正文", true)],
  };
  const checklist = {
    ...createObject(boardId, "note"),
    noteKind: "checklist",
    blocks: [makeBlock("真正待办")],
  };
  state.objects = [article, checklist];
  const arranged = setSurface(state, boardId, "arranged");
  const page = todoPages(arranged, boardId)[0];
  assert.deepEqual(
    page.tasks.map((task) => task.key),
    [article.blocks[0].id, checklist.blocks[0].id],
  );
  assert.equal(
    page.tasks[0].block.runs.map((run) => run.text).join(""),
    "文章标题\n正文",
  );
  assert.ok(page.objects.includes(article));
  const cleared = clearCompletedPageTasks(arranged, boardId, page.id);
  assert.deepEqual(
    cleared.objects.find((o) => o.id === article.id),
    article,
  );
  assert.strictEqual(
    setSurface(arranged, boardId, "canvas").objects,
    state.objects,
  );
});

test("排列中整篇文章是一个可勾选的待办，可全文复制和编辑", async (t) => {
  const f = await mount(t, { arranged: true });
  assert.equal(
    f.host.querySelectorAll('.todo-row [role="checkbox"]').length,
    1,
  );
  const article = f.host.querySelector(
    `.pending-panel .todo-row[data-object-id="${f.note.id}"]`,
  );
  assert.ok(article, "整篇文章应放在未完成待办中");
  assert.equal(f.host.querySelector(".todo-attachments"), null);
  assert.match(article.textContent, /第一段。/);
  assert.match(article.textContent, /第二段。/);
  const content = article.querySelector(".checklist-hover-text");
  assert.ok(content, "非编辑时使用单行滚动文字展示整篇文章");
  await act(async () =>
    content.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  const editor = article.querySelector('[contenteditable="true"]');
  assert.ok(editor);
  await key(editor, "a", { ctrlKey: true });
  assert.equal(await copy(editor), "文章标题\n\n第一段。\n第二段。");
  await paste(editor, "修改后的整篇文章\n正文。");
  assert.equal(f.text(), "修改后的整篇文章\n正文。");
  await key(editor, "Escape");
  await act(async () => article.querySelector('[role="checkbox"]').click());
  assert.equal(f.host.querySelectorAll(".pending-panel .todo-row").length, 0);
  assert.equal(f.host.querySelectorAll(".done-panel .todo-row").length, 1);
  assert.equal(f.text(), "修改后的整篇文章\n正文。");
  await act(async () =>
    f.host.querySelector('.done-panel [role="checkbox"]').click(),
  );
  assert.equal(f.host.querySelectorAll(".pending-panel .todo-row").length, 1);
  assert.equal(f.host.querySelectorAll(".done-panel .todo-row").length, 0);
});

test("整篇文章设置截止时间和排序时只算一个待办", () => {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const article = {
    ...createObject(boardId, "note"),
    createdAt: "2026-11-02T00:00:00.000Z",
    blocks: [makeBlock("标题"), makeBlock("正文"), makeBlock("结尾")],
  };
  const checklist = {
    ...createObject(boardId, "note"),
    createdAt: "2026-11-01T00:00:00.000Z",
    noteKind: "checklist",
    blocks: [makeBlock("另一个待办")],
  };
  state.objects = [checklist, article];
  const page = todoPages(state, boardId)[0];
  const dated = setPageDeadline(
    state,
    boardId,
    page.id,
    article.id,
    article.blocks[0].id,
    "2026-12-01T00:00:00.000Z",
  );
  const sorted = sortPendingPageTasks(dated, boardId, page.id);
  const tasks = todoPages(sorted, boardId)[0].tasks;
  assert.deepEqual(
    tasks.map((task) => task.note.id),
    [article.id, checklist.id],
  );
  assert.equal(tasks[0].block.dueAt, "2026-12-01T00:00:00.000Z");
  assert.equal(
    objectText(sorted.objects.find((o) => o.id === article.id)),
    "标题\n正文\n结尾",
  );
});

test("删除和清空已完成都移走整篇文章，回收站可完整恢复", () => {
  const state = createWorkspace(),
    boardId = state.boards[0].id;
  const article = {
    ...createObject(boardId, "note"),
    blocks: [makeBlock("标题", true), makeBlock("正文"), makeBlock("结尾")],
  };
  state.objects = [article];
  const page = todoPages(state, boardId)[0];
  for (const removed of [
    deletePageTasks(state, boardId, page.id, [article.blocks[0].id]),
    clearCompletedPageTasks(state, boardId, page.id),
  ]) {
    assert.equal(
      removed.objects.some((o) => o.id === article.id),
      false,
    );
    assert.equal(removed.trash.length, 1);
    const restored = restoreTrash(removed, removed.trash[0].id);
    assert.equal(
      objectText(restored.objects.find((o) => o.id === article.id)),
      "标题\n正文\n结尾",
    );
    assert.equal(todoPages(restored, boardId)[0].tasks.length, 1);
  }
});

test("文章待办的删除按钮移走全文，复制操作保持文章类型", async (t) => {
  const f = await mount(t, { arranged: true });
  await act(async () => f.api().selectAll());
  await act(async () => f.api().duplicateSelected());
  const duplicates = f.state().objects.filter((o) => o.id !== f.note.id);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].noteKind, "text");
  assert.equal(objectText(duplicates[0]), "文章标题\n\n第一段。\n第二段。");
  const row = f.host.querySelector(`.todo-row[data-object-id="${f.note.id}"]`);
  await act(async () => row.querySelector(".todo-delete-trigger").click());
  assert.equal(
    f.state().objects.some((o) => o.id === f.note.id),
    false,
  );
  assert.equal(f.state().objects.length, 1);
  assert.equal(
    objectText(f.state().trash[0].objects[0]),
    "文章标题\n\n第一段。\n第二段。",
  );
});

test("删除文章首段后仍保留同一待办的完成状态和截止时间", async (t) => {
  const f = await mount(t, {
    lines: ["标题", "正文"],
    decorate(note) {
      note.blocks[0].done = true;
      note.blocks[0].completedAt = "2026-11-03T00:00:00Z";
      note.blocks[0].dueAt = "2026-12-01T00:00:00.000Z";
      note.blocks[0].remark = {
        text: "整篇的备注",
        updatedAt: "2026-11-03T00:00:00Z",
      };
    },
  });
  const editor = f.host.querySelector('[contenteditable="true"]');
  editor.firstChild.remove();
  await act(async () =>
    editor.dispatchEvent(new Event("input", { bubbles: true })),
  );
  const head = f.state().objects[0].blocks[0];
  assert.equal(f.text(), "正文");
  assert.equal(head.id, f.note.blocks[0].id);
  assert.equal(head.done, true);
  assert.equal(head.dueAt, "2026-12-01T00:00:00.000Z");
  assert.equal(head.remark.text, "整篇的备注");
});
