import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { validateDesktopDownloadPage } from "../scripts/lib/desktop-download-page.mjs";

const html = await readFile(
  new URL("../public/download/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../public/download/download.js", import.meta.url),
  "utf8",
);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("正式版发布时下载页版本、安装包和说明必须与包版本一致", () => {
  assert.equal(validateDesktopDownloadPage(html, version).version, version);
});

test("下载页只更新标签、安装包或说明中的一部分时阻止发布", () => {
  for (const selector of [
    ".original .version-number",
    '.original a[data-channel="stable"]',
    ".original .release-link",
  ]) {
    const dom = new JSDOM(html);
    try {
      const target = dom.window.document.querySelector(selector);
      if (target.tagName === "A") {
        target.setAttribute("href", target.getAttribute("href") + ".outdated");
      } else {
        target.textContent = "旧版本 · Windows";
      }
      assert.throws(
        () => validateDesktopDownloadPage(dom.serialize(), version),
        /未更新/,
      );
    } finally {
      dom.window.close();
    }
  }
});

test("验证版卡片不能掩盖正式版下载卡片缺失", () => {
  const dom = new JSDOM(html);
  try {
    dom.window.document.querySelector(".original").remove();
    assert.throws(
      () => validateDesktopDownloadPage(dom.serialize(), version),
      /缺少正式版卡片/,
    );
  } finally {
    dom.window.close();
  }
});

test("直接访问统一下载页无需登录或消息通道，仍可下载并选择正确的返回入口", () => {
  const dom = new JSDOM(html, {
    url: "https://todo.zky.lol/download/",
    runScripts: "outside-only",
  });
  try {
    dom.window.BroadcastChannel = class {
      constructor() {
        throw Error("Unavailable");
      }
    };
    dom.window.eval(script);
    const links = [...dom.window.document.querySelectorAll("a[data-channel]")];
    assert.equal(links.length, 4);
    for (const link of links) {
      const url = new URL(link.href);
      assert.equal(url.origin, "https://github.com");
      assert.match(
        url.pathname,
        /^\/zkeyang0519-arch\/qingdan-canvas\/releases\/download\//,
      );
      assert.match(url.pathname, /\.(exe|dmg)$/);
      link.addEventListener("click", (event) => event.preventDefault(), {
        once: true,
      });
      link.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      assert.equal(
        dom.window.document.getElementById("download-feedback").hidden,
        false,
      );
      assert.equal(
        new URL(
          dom.window.document.getElementById("continue-link").href,
        ).searchParams.get("desktop"),
        link.dataset.channel,
      );
    }
  } finally {
    dom.window.close();
  }
});
