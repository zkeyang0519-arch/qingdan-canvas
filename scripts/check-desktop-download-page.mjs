import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { validateDesktopDownloadPage } from "./lib/desktop-download-page.mjs";
import {
  fetchDesktopAsset,
  releaseBase,
  validateDesktopRelease,
} from "./lib/desktop-installation.mjs";

const args = process.argv.slice(2);
const online = args.includes("--online");
const wait = args.includes("--wait");
const pageUrl = "https://todo.zky.lol/download/";

try {
  if (
    args.some((arg) => !["--online", "--wait"].includes(arg)) ||
    (wait && !online)
  ) {
    throw new Error(
      "用法：npm run desktop:download:check -- [--online [--wait]]",
    );
  }
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!online) {
    validateDesktopDownloadPage(
      await readFile(
        new URL("../public/download/index.html", import.meta.url),
        "utf8",
      ),
      version,
    );
    console.log(`下载页源码与正式版 ${version} 一致。`);
  } else {
    const deadline = Date.now() + (wait ? 5 * 60_000 : 0);
    while (true) {
      try {
        const feed = await fetchDesktopAsset(
          `${releaseBase}/latest/download/latest.yml`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!feed.ok) throw new Error(`正式更新源返回 HTTP ${feed.status}。`);
        const release = validateDesktopRelease(await feed.text());
        if (release.version !== version) {
          throw new Error(
            `最新正式版仍为 ${release.version}，预期 ${version}。`,
          );
        }
        const response = await fetch(pageUrl, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`线上下载页返回 HTTP ${response.status}。`);
        }
        validateDesktopDownloadPage(await response.text(), version);
        console.log(`线上下载页与正式更新源 ${version} 一致：${pageUrl}`);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        console.log(`等待下载页部署：${error.message}`);
        await delay(Math.min(10_000, deadline - Date.now()));
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
