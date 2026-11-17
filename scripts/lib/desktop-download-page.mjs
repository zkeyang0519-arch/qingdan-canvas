import { JSDOM } from "jsdom";

const releaseBase =
  "https://github.com/zkeyang0519-arch/qingdan-canvas/releases";

export function validateDesktopDownloadPage(html, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("正式版版本号无效。");
  }
  const dom = new JSDOM(html);
  try {
    const card = dom.window.document
      .getElementById("original-title")
      ?.closest("article");
    if (!card) throw new Error("下载页缺少正式版卡片。");
    if (
      card.querySelector(".version-number")?.textContent.trim() !==
      `${version} · Windows`
    ) {
      throw new Error(`下载页正式版版本号未更新为 ${version}。`);
    }
    const installer = `${releaseBase}/download/v${version}/Qingdao-Setup-${version}-x64.exe`;
    if (
      card.querySelector('a[data-channel="stable"]')?.getAttribute("href") !==
      installer
    ) {
      throw new Error(`下载页正式安装包链接未更新为 ${version}。`);
    }
    const notes = `${releaseBase}/tag/v${version}`;
    if (card.querySelector(".release-link")?.getAttribute("href") !== notes) {
      throw new Error(`下载页正式版更新说明未更新为 ${version}。`);
    }
    return { version, installer, notes };
  } finally {
    dom.window.close();
  }
}
