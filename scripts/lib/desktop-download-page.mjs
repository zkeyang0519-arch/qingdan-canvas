import { JSDOM } from "jsdom";

const releaseBase =
  "https://github.com/zkeyang0519-arch/qingdan-canvas/releases";

export function validatePreviewDownloadPage(html, version) {
  if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(version))
    throw new Error("轻量版版本号无效。");
  const tag = `qingdao-preview-v${version}`;
  const notes = `${releaseBase}/tag/${tag}`;
  const dom = new JSDOM(html);
  try {
    const card = dom.window.document
      .getElementById("light-title")
      ?.closest("article");
    if (
      card?.querySelector(".version-number")?.textContent.trim() !==
      `${version} · Windows / macOS`
    )
      throw new Error(`下载页轻量版版本号未更新为 ${version}。`);
    const platforms = [
      ["Windows 64 位", "x64-Setup.exe"],
      ["Mac · Apple Silicon", "mac-AppleSilicon.dmg"],
      ["Mac · Intel", "mac-Intel.dmg"],
    ];
    const links = [...card.querySelectorAll('a[data-channel="tauri-preview"]')];
    if (links.length !== platforms.length)
      throw new Error("轻量版应提供三个平台安装包。");
    const installers = platforms.map(([platform, suffix]) => {
      const url = `${releaseBase}/download/${tag}/Qingdao-Preview-${version}-${suffix}`;
      const link = links.find((item) => item.dataset.platform === platform);
      if (link?.getAttribute("href") !== url)
        throw new Error(`轻量版 ${platform} 安装包链接未更新为 ${version}。`);
      return url;
    });
    if (card.querySelector(".release-link")?.getAttribute("href") !== notes)
      throw new Error(`轻量版更新说明未更新为 ${version}。`);
    return { version, installers, notes };
  } finally {
    dom.window.close();
  }
}

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
