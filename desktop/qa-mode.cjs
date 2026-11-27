"use strict";
const path = require("node:path");
const fs = require("node:fs");
function configureUpdateQa({ app, profile, channel, env = process.env }) {
  if (!["1", "local"].includes(env.QINGDAO_UPDATE_QA)) return null;
  if (channel !== "beta") throw Error("更新验收仅允许独立 Beta 应用。");
  if (env.QINGDAO_UPDATE_QA === "local") {
    const localRoot =
      env.QINGDAO_LOCAL_QA_ROOT && path.resolve(env.QINGDAO_LOCAL_QA_ROOT);
    if (
      !localRoot ||
      !/^qingdao-update-local-[a-f0-9-]{36}$/.test(path.basename(localRoot))
    )
      throw Error("本地验收目录无效。");
    const marker = JSON.parse(
      fs.readFileSync(path.join(localRoot, "qa-run.json"), "utf8"),
    );
    if (
      marker.id !== env.QINGDAO_LOCAL_QA_ID ||
      marker.schema !== 1 ||
      fs.realpathSync(profile) !==
        fs.realpathSync(path.join(localRoot, "profile")) ||
      fs.realpathSync(app.getPath("exe")) !==
        fs.realpathSync(path.join(localRoot, "installed", "QingdaoBeta.exe"))
    )
      throw Error("本地验收必须使用本次安装的 Beta 和独立数据目录。");
    const feed = new URL(env.QINGDAO_QA_FEED);
    if (
      feed.href !== marker.feed ||
      feed.protocol !== "http:" ||
      feed.hostname !== "127.0.0.1" ||
      !feed.port ||
      feed.pathname !== "/updates/" ||
      feed.username ||
      feed.password ||
      feed.search ||
      feed.hash
    )
      throw Error("本地验收更新源无效。");
    // Local UI is operated through the normal window; never expose a debugging port.
    return { feed: feed.href };
  }
  const root = env.RUNNER_TEMP && path.resolve(env.RUNNER_TEMP);
  if (
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.CI !== "true" ||
    channel !== "beta" ||
    !root ||
    !path.resolve(profile).startsWith(root + path.sep)
  )
    throw Error(
      "真实安装更新验收只允许在隔离的 GitHub Windows runner 和临时用户目录运行。",
    );
  const feed = new URL(env.QINGDAO_QA_FEED);
  if (
    feed.protocol !== "http:" ||
    feed.hostname !== "127.0.0.1" ||
    !feed.port ||
    feed.username ||
    feed.password ||
    feed.search ||
    feed.hash ||
    feed.pathname !== "/updates/"
  )
    throw Error("验收更新源必须是本机隔离的 /updates/ 服务。");
  const debugPort = Number(env.QINGDAO_QA_DEBUG_PORT);
  if (!Number.isInteger(debugPort) || debugPort < 1025 || debugPort > 65535)
    throw Error("验收调试端口无效。");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(debugPort));
  return { feed: feed.href, debugPort };
}
module.exports = { configureUpdateQa };
