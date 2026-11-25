import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { filmSpecSchema, newFilmJob } from "../shared/agent/film.ts";
import { draftFrom } from "../src/agent/film-model.js";

test("从原聊天输入区打开制作抽屉、保存初稿、采用现成定稿，普通聊天草稿独立", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://127.0.0.1:8790",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  await mkdir("node_modules/.cache", { recursive: true });
  const dir = await mkdtemp(path.resolve("node_modules/.cache", "film-ui-"));
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await build({
    entryPoints: {
      ui: "src/agent/ChatPanel.jsx",
      studio: "src/agent/FilmStudio.jsx",
    },
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".css": "empty" },
  });
  const ChatPanel = (await import(pathToFileURL(path.join(dir, "ui.mjs"))))
    .default;
  const FilmStudio = (await import(pathToFileURL(path.join(dir, "studio.mjs"))))
    .default;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(document.querySelector("#root"));
  let card = null,
    artifacts = [],
    jobs = [],
    writes = 0,
    startRequests = 0;
  const requestCloud = async (url, opts = {}) => {
    const u = new URL(url, "https://example.org"),
      p = u.pathname;
    if (p === "/api/agent/bindings") return { binding: null };
    if (!p.startsWith("/api/agent/films"))
      return { memories: [], threads: [], messages: [] };
    if (p.endsWith("/capabilities"))
      return { binding: null, capabilities: null };
    if (p.endsWith("/actions")) {
      writes++;
      assert.equal(opts.body.action, "import_script");
      card = {
        ...card,
        rev: card.rev + 1,
        spec: { ...opts.body.spec, scriptId: "s1" },
      };
      artifacts = [
        {
          id: "s1",
          kind: "final",
          text: opts.body.text,
          title: "用户定稿",
          source: "用户",
          details: {},
        },
      ];
      return { id: card.id };
    }
    if (p === "/api/agent/films" && opts.method === "POST") {
      writes++;
      if (opts.body.start === true) startRequests++;
      card = {
        id: "card",
        rev: 1,
        spec: filmSpecSchema.parse(opts.body.spec),
        binding: null,
      };
      return { id: "card", revision: 1 };
    }
    if (p.endsWith("/card")) return { card, jobs, events: [], artifacts };
    return {
      films: card
        ? [
            {
              id: "card",
              title: card.spec.title,
              goal: card.spec.goal,
              state: "draft",
              updated: Date.now(),
              chatId: null,
            },
          ]
        : [],
    };
  };
  await act(async () =>
    root.render(
      React.createElement(ChatPanel, {
        roomId: "canvas",
        userId: "owner",
        pages: [{ id: "project", title: "项目", tasks: [] }],
        requestCloud,
        embedded: true,
        execution: { page: { id: "project", tasks: [] } },
      }),
    ),
  );
  const find = (text) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === text,
    );
  const click = async (name) => {
    const b = find(name);
    assert.ok(b, name);
    assert.equal(b.disabled, false, name);
    await act(async () => b.click());
  };
  const label = (name) =>
    [...document.querySelectorAll(".film-studio label")]
      .find((l) => l.firstChild?.textContent === name)
      ?.querySelector("input,textarea,select");
  const edit = async (el, value) => {
    assert.ok(el);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        "value",
      ).set.call(el, value);
      el.dispatchEvent(
        new window.Event(el.tagName === "SELECT" ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  };
  assert.ok(document.querySelector('[aria-label="聊天消息"]'));
  assert.ok(find("短片制作"));
  await click("短片制作");
  assert.ok(document.querySelector('[role="dialog"]'));
  await click("新建制作卡");
  await edit(label("片名"), "车站的红伞");
  await edit(
    label("故事或制作要求"),
    "用 GPT 写初稿，只给我一份拍摄提示词，不要出片",
  );
  assert.equal(label("交付目标").value, "prompt");
  assert.equal(label("初稿来源").value, "gpt");
  await edit(label("交付目标"), "draft");
  await edit(label("初稿来源"), "deepseek");
  await edit(label("故事或制作要求"), "用 GPT 生成 30 秒视频");
  assert.equal(label("交付目标").value, "draft");
  assert.equal(label("初稿来源").value, "deepseek");
  assert.equal(writes, 0);
  await edit(label("故事或制作要求"), "女孩归还一把红伞");
  await click("保存制作卡");
  assert.equal(writes, 1);
  assert.equal(card.spec.title, "车站的红伞");
  assert.equal(card.spec.goal, "draft");
  await edit(label("导入或编辑完整文稿"), "0–30 秒，红伞归还失主。");
  const check =
    label("采用为用户定稿") ||
    [...document.querySelectorAll("label")]
      .find((l) => l.textContent.includes("采用为用户定稿"))
      ?.querySelector("input");
  await act(async () => check.click());
  await click("保存并采用稿件");
  assert.equal(writes, 2);
  assert.equal(card.spec.scriptId, "s1");
  await act(async () =>
    document
      .querySelector('[aria-label^="关闭"][class*="agent-icon-button"]')
      .click(),
  );
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector('[aria-label="聊天消息"]').value, "");
  await click("短片制作");
  assert.ok(find("新建制作卡"));
  assert.ok(
    [...document.querySelectorAll(".film-row")].some((el) =>
      el.textContent.includes("车站的红伞"),
    ),
  );
  assert.equal(draftFrom("初稿用 GPT，再做成30秒短片").writer, "gpt");
  assert.equal(draftFrom("我有定稿和图，直接出片").direct, true);
  assert.equal(
    draftFrom("这是短片的创意，先别出片，只要一张定妆图").goal,
    "image",
  );
  assert.equal(draftFrom("精修提示词，不要直接出片").direct, false);
  assert.equal(draftFrom("用 Codex 写，不用 GPT").writer, "codex");
  assert.equal(
    draftFrom("DeepSeek 主控，让 Codex 改词和生图").writer,
    "deepseek",
  );
  assert.equal(draftFrom("用 Codex 改词").goal, "prompt");
  const picture = {
    id: "red",
    kind: "image",
    mediaId: "red",
    title: "红伞",
    source: "Codex 原生生图",
    details: {},
  };
  const videoSpec = {
    ...card.spec,
    goal: "video",
    direct: true,
    refs: [picture.id],
  };
  const video = newFilmJob("job", card.id, card.rev, videoSpec, artifacts[0]);
  const platformPrompt = "0–30 秒，女孩归还 @图片1。\n\n@图片1　红伞";
  jobs = [
    {
      ...video,
      stage: "poll",
      state: "queued",
      remote: { task: "waao-task", node: "video-node", operation: video.id },
      waaoSubmission: {
        scriptId: artifacts[0].id,
        node: "video-node",
        prompt: platformPrompt,
        imports: [
          {
            id: picture.id,
            assetId: "waao-red",
            node: "image-node",
            position: 1,
          },
        ],
      },
    },
  ];
  artifacts.push(picture);
  await act(async () => document.querySelector(".film-row").click());
  const handoff = [...document.querySelectorAll("summary")].find(
    (el) => el.textContent === "WAAO 节点上的提示词与素材顺序",
  );
  assert.ok(handoff);
  await act(async () => handoff.click());
  assert.equal(
    handoff.parentElement.querySelector("pre").textContent,
    platformPrompt,
  );
  assert.match(handoff.parentElement.textContent, /@图片1.*红伞.*waao-red/);
  assert.ok(document.body.textContent.includes("waao-task"));
  assert.equal(document.querySelector("video"), null);
  jobs = [];
  const openReply = (message, text) =>
    act(async () =>
      root.render(
        React.createElement(FilmStudio, {
          key: message,
          initialMessageId: message,
          initialText: text,
          createFirst: true,
          scope: ["owner", "canvas", "project"],
          call: requestCloud,
          binding: { bindingId: "bound", revision: 1 },
          onClose() {},
          onChange() {},
        }),
      ),
    );
  await openReply("reply-a", "只要提示词，女孩归还一把红伞");
  await edit(label("片名"), "第一条回复的简报");
  await openReply("reply-b", "写一份初稿，男孩在车站等车");
  assert.equal(label("片名").value, "写一份初稿，男孩在车站等车");
  await openReply("reply-a", "只要提示词，女孩归还一把红伞");
  assert.equal(label("片名").value, "第一条回复的简报");
  assert.equal(startRequests, 0);
  await click("精修提示词");
  assert.equal(startRequests, 1);
  assert.equal(card.spec.goal, "prompt");
});
