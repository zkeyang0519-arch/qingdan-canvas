import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8788",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
let ChatMarkdown;
let root;
let temp;

async function render(text, options = {}) {
  const source = resolve("src/agent/ChatMarkdown.jsx");
  assert.ok(existsSync(source), "ChatMarkdown must render rich chat messages");
  if (!ChatMarkdown) {
    temp = mkdtempSync(resolve("node_modules/.cache/agent-chat-markdown-"));
    await build({
      entryPoints: [source],
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      loader: { ".css": "empty" },
      outfile: resolve(temp, "ui.mjs"),
    });
    ({ default: ChatMarkdown } = await import(
      pathToFileURL(resolve(temp, "ui.mjs"))
    ));
  }
  if (!root) root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(React.createElement(ChatMarkdown, { text, ...options })),
  );
  return document.querySelector(".agent-chat-markdown");
}

test.afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  delete navigator.clipboard;
});
test.after(() => {
  if (temp) {
    assert.ok(temp.startsWith(resolve("node_modules/.cache") + sep));
    rmSync(temp, { recursive: true, force: true });
  }
  dom.window.close();
});

test("chat markdown renders readable paragraphs, emphasis, headings and quotations", async () => {
  const message = await render(
    "## 检查结果\n\n第一段有 **重点**、*解释* 和 `npm test`。\n保留换行。\n\n> 引用 **依据**\n\n最后一段。",
  );
  assert.equal(message.querySelector("h2").textContent, "检查结果");
  assert.equal(message.querySelector("p strong").textContent, "重点");
  assert.equal(message.querySelector("em").textContent, "解释");
  assert.equal(message.querySelector("p code").textContent, "npm test");
  assert.ok(message.querySelector("p").textContent.includes("保留换行。"));
  assert.equal(message.querySelector("blockquote strong").textContent, "依据");
  assert.equal(message.lastElementChild.textContent, "最后一段。");
});

test("chat markdown keeps nested list items inside their parent and preserves ordered starts", async () => {
  const message = await render(
    "3. 发布准备\n   - 检查测试\n   - 确认 **配置**\n4. 交付\n\n- [x] 已完成\n- [ ] 待确认",
  );
  const ordered = message.querySelector("ol");
  assert.equal(ordered.start, 3);
  assert.equal(ordered.children.length, 2);
  assert.equal(ordered.querySelectorAll("li > ul > li").length, 2);
  assert.equal(ordered.querySelector("ul strong").textContent, "配置");
  const tasks = [...message.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(
    tasks.map((task) => task.checked),
    [true, false],
  );
  assert.ok(tasks.every((task) => task.disabled));
});

test("chat markdown renders GFM tables with inline content and escaped pipes", async () => {
  const message = await render(
    "| 项目 | 状态 | 数量 |\n| :--- | :---: | ---: |\n| **网页** | 已完成 | 2 |\n| A \\| B | `x|y` | 10 |",
  );
  const table = message.querySelector("table");
  assert.deepEqual(
    [...table.querySelectorAll("th")].map((cell) => cell.textContent),
    ["项目", "状态", "数量"],
  );
  assert.equal(table.querySelectorAll("tbody tr").length, 2);
  assert.equal(table.querySelector("td strong").textContent, "网页");
  assert.deepEqual(
    [...table.querySelectorAll("tbody tr")[1].children].map(
      (cell) => cell.textContent,
    ),
    ["A | B", "x|y", "10"],
  );
  assert.equal(table.querySelectorAll("th")[2].style.textAlign, "right");
  assert.equal(table.parentElement.tabIndex, 0);
});

test("chat markdown treats raw HTML and executable link destinations as inert text", async () => {
  const message = await render(
    '<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n[unsafe](javascript:alert(3)) [data](data:text/html;base64,PHNjcmlwdD4=) [mixed](JaVaScRiPt:alert(4)) [encoded](jav&#x61;script:alert(5))\n\n`<svg onload=alert(6)>`',
  );
  assert.equal(message.querySelectorAll("img, script, svg, iframe").length, 0);
  assert.equal(message.querySelectorAll("a").length, 0);
  assert.ok(message.textContent.includes('<img src=x onerror="alert(1)">'));
  assert.equal(
    message.querySelector("code").textContent,
    "<svg onload=alert(6)>",
  );
  assert.ok(message.textContent.includes("unsafe"));
});

test("chat markdown creates safe links without losing balanced parentheses or link titles", async () => {
  const message = await render(
    '[文档](https://example.com/guide_(start) "查看文档") 和 [联系](mailto:team@example.com) 与 [页内](#details)。\n\n<https://example.com/reference>',
  );
  const links = [...message.querySelectorAll("a")];
  assert.equal(links.length, 4);
  assert.equal(links[0].href, "https://example.com/guide_(start)");
  assert.equal(links[0].title, "查看文档");
  assert.equal(links[0].target, "_blank");
  assert.ok(links[0].rel.includes("noopener"));
  assert.ok(links[0].rel.includes("noreferrer"));
  assert.equal(links[1].getAttribute("href"), "mailto:team@example.com");
  assert.equal(links[2].getAttribute("href"), "#details");
  assert.equal(links[3].textContent, "https://example.com/reference");
});

test("chat markdown keeps incomplete streaming fences readable and updates them as text arrives", async () => {
  let message = await render("先执行：\n\n```js\nconst value = '<tag>';\ncon");
  assert.equal(
    message.querySelector("pre code").textContent,
    "const value = '<tag>';\ncon",
  );
  assert.ok(message.textContent.includes("js"));
  assert.equal(message.querySelectorAll("tag").length, 0);
  message = await render(
    "先执行：\n\n```js\nconst value = '<tag>';\nconsole.log(value);\n```\n\n**完成**",
  );
  assert.equal(message.querySelectorAll("pre").length, 1);
  assert.equal(
    message.querySelector("pre code").textContent,
    "const value = '<tag>';\nconsole.log(value);",
  );
  assert.equal(message.lastElementChild.textContent, "完成");
  message = await render("尚未结束的 **强调 和 `代码");
  assert.equal(message.textContent, "尚未结束的 **强调 和 `代码");
});

test("chat code copy writes only the displayed code and confirms success", async () => {
  let copied;
  navigator.clipboard = {
    async writeText(text) {
      copied = text;
    },
  };
  const message = await render('```html\n<div title="test">& hello</div>\n```');
  const button = message.querySelector('button[aria-label="复制代码"]');
  assert.ok(button);
  await act(async () => button.click());
  assert.equal(copied, '<div title="test">& hello</div>');
  assert.ok(button.textContent.includes("已复制"));
  assert.equal(message.querySelector("pre div"), null);
});

test("chat code copy reports clipboard failure without claiming success", async () => {
  navigator.clipboard = {
    async writeText() {
      throw new Error("Clipboard permission denied");
    },
  };
  const message = await render("```sh\nnpm test\n```");
  const button = message.querySelector('button[aria-label="复制代码"]');
  await act(async () => button.click());
  assert.ok(button.textContent.includes("复制失败"));
  assert.equal(message.querySelector("pre code").textContent, "npm test");
});

test("chat markdown preserves long tokens and accepts empty messages", async () => {
  const token = "long_token_".repeat(1000);
  let message = await render(
    `路径：${token}\n\n| 文件 |\n| --- |\n| ${token} |`,
  );
  assert.equal(message.querySelector("p").textContent, `路径：${token}`);
  assert.equal(message.querySelector("td").textContent, token);
  message = await render(undefined);
  assert.equal(message.textContent, "");
});

test("chat headings keep literal hash characters that belong to the title", async () => {
  const message = await render("## C#\n\n### 标题 ###");
  assert.equal(message.querySelector("h2").textContent, "C#");
  assert.equal(message.querySelector("h3").textContent, "标题");
});

test("assistant timeline keeps the overall conclusion before ordered content sections", async () => {
  const message = await render(
    "## 基础体验已就绪\n\n先看 **结论**。\n\n### 已完成\n\n正文与重点已分开。\n\n```js\nconst ready = true;\n```\n\n### 下一步\n\n| 项目 | 状态 |\n| --- | --- |\n| 阅读 | 待确认 |",
    { timeline: true },
  );
  const sections = [
    ...message.querySelectorAll(".agent-chat-timeline-section"),
  ];
  assert.equal(message.firstElementChild.tagName, "H2");
  assert.equal(message.firstElementChild.textContent, "基础体验已就绪");
  assert.deepEqual(
    sections.map((section) => section.querySelector("h3").textContent),
    ["已完成", "下一步"],
  );
  assert.equal(
    sections[0].querySelector("pre code").textContent,
    "const ready = true;",
  );
  assert.equal(sections[1].querySelector("td").textContent, "阅读");
  assert.equal(message.querySelectorAll("h2, h3").length, 3);
  assert.equal(message.querySelector("p strong").textContent, "结论");
});

test("assistant timeline groups peer headings while retaining nested headings in their section", async () => {
  const message = await render(
    "先看进展。\n\n## 已完成\n\n说明。\n\n### 细节\n\n[文档](https://example.com)\n\n## 待确认\n\n需要验收。",
    { timeline: true },
  );
  const sections = [
    ...message.querySelectorAll(".agent-chat-timeline-section"),
  ];
  assert.equal(message.firstElementChild.tagName, "P");
  assert.equal(sections.length, 2);
  assert.equal(sections[0].querySelector("h3").textContent, "细节");
  assert.equal(sections[0].querySelector("a").href, "https://example.com/");
  assert.equal(sections[1].textContent, "待确认需要验收。");
  assert.equal(message.querySelectorAll("input, [role=progressbar]").length, 0);
});

test("assistant timeline decorates titled lists without changing nested, ordered or task-list meaning", async () => {
  const text =
    "- **字体**\n  正文保持细体。\n  - 内层说明\n- **宽度**\n  保持八成宽度。\n\n3. 已有序号\n4. 下一项\n\n- [x] 已完成\n- [ ] 待确认\n\n- 普通条目\n- 第二条";
  let message = await render(text);
  assert.equal(message.querySelectorAll(".agent-chat-timeline-list").length, 0);
  message = await render(text, { timeline: true });
  const timeline = message.querySelector(".agent-chat-timeline-list");
  assert.ok(timeline);
  assert.equal(timeline.tagName, "UL");
  assert.equal(timeline.children.length, 2);
  assert.equal(timeline.querySelector("li > ul > li").textContent, "内层说明");
  assert.equal(message.querySelectorAll(".agent-chat-timeline-list").length, 1);
  assert.equal(message.querySelector("ol").start, 3);
  assert.deepEqual(
    [...message.querySelectorAll("input")].map((input) => input.checked),
    [true, false],
  );
});

test("assistant timeline keeps partial streams readable when additional sections arrive", async () => {
  let message = await render("### 第一步\n\n正在 **整理", { timeline: true });
  assert.equal(message.textContent, "第一步正在 **整理");
  assert.equal(
    message.querySelectorAll(".agent-chat-timeline-section").length,
    0,
  );
  message = await render(
    "### 第一步\n\n正在 **整理**。\n\n### 第二步\n\n核对 `<tag>` 与 [链接](javascript:alert(1))。",
    { timeline: true },
  );
  assert.equal(
    message.querySelectorAll(".agent-chat-timeline-section").length,
    2,
  );
  assert.equal(message.querySelector("strong").textContent, "整理");
  assert.equal(message.querySelector("code").textContent, "<tag>");
  assert.equal(message.querySelectorAll("a, tag, script").length, 0);
  assert.ok(message.textContent.endsWith("核对 <tag> 与 链接。"));
});

test("chat code copy does not confirm an older snapshot after streamed code changes", async () => {
  let finishCopy;
  navigator.clipboard = {
    writeText() {
      return new Promise((resolveCopy) => {
        finishCopy = resolveCopy;
      });
    },
  };
  let message = await render("```js\nlet value");
  await act(async () => message.querySelector("button").click());
  message = await render("```js\nlet value = 1;\n```");
  await act(async () => finishCopy());
  assert.equal(message.querySelector("button").textContent, "复制");
});
