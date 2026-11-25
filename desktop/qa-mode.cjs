"use strict";
const path = require("node:path");
function configureUpdateQa({ app, profile, channel, env = process.env }) {
  if (env.QINGDAO_UPDATE_QA !== "1") return null;
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
