"use strict";
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const { createDesktopOnlineApi } = require("./online-api.cjs");
const { createDesktopHandoff } = require("./handoff-broker.cjs");

const failure = (message) =>
  Object.assign(Error(message), { desktopInstall: true });
async function waitForDesktopDownload(
  updates,
  { signal, onStatus, timeoutMs = 15 * 60 * 1000 },
) {
  const deadline = Date.now() + timeoutMs;
  onStatus("正在检查轻岛版本…");
  await updates.check();
  while (true) {
    signal?.throwIfAborted();
    const state = updates.state();
    if (["idle", "downloaded", "error", "unsupported"].includes(state.status))
      return state;
    if (Date.now() >= deadline)
      throw failure("下载更新超时，原轻岛仍可使用，请稍后重试。");
    if (state.status === "installing")
      throw failure("轻岛正在安装更新，请等待重启后重试。");
    onStatus(
      state.status === "downloading"
        ? `正在下载轻岛更新：${state.progress || 0}%`
        : "正在检查并准备轻岛更新…",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function createWebLaunch({
  updates,
  requestHandoff,
  port = 8791,
  fetchImpl,
  onError = () => {},
}) {
  let pending = false;
  const api = createDesktopOnlineApi({
    ...(fetchImpl ? { fetchImpl } : {}),
    instanceId: randomBytes(16).toString("hex"),
    launch: async (context, { signal, onStatus }) => {
      if (pending) throw failure("轻岛正在处理另一个启动请求，请稍后重试。");
      pending = true;
      try {
        const state = await waitForDesktopDownload(updates, {
          signal,
          onStatus,
        });
        signal.throwIfAborted();
        onStatus("正在恢复当前账号和画布…");
        const broker = await createDesktopHandoff(context);
        const abort = () => {
          void broker.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const work = requestHandoff(broker.descriptor);
          const result = await broker.result;
          await work;
          if (!result.applied) throw failure(result.error);
        } finally {
          signal.removeEventListener("abort", abort);
          await broker.close();
        }
        signal.throwIfAborted();
        if (state.status === "downloaded")
          return {
            started: true,
            applied: true,
            restarting: true,
            afterResponse: async () => {
              try {
                await updates.install();
              } catch {
                onError("未能完成更新，原窗口和输入已保留。");
              }
            },
          };
        return {
          started: true,
          applied: true,
          ...(state.status === "error"
            ? { warning: "暂时无法检查新版本，已打开本机现有版本。" }
            : {}),
        };
      } finally {
        pending = false;
      }
    },
  });
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    void api(req, res, url);
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () => {
      api.close();
      server.close();
      server.closeAllConnections();
    },
  };
}
module.exports = { createWebLaunch, waitForDesktopDownload };
