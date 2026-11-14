"use strict";
const { randomBytes, createHash } = require("node:crypto");
const origins = require("../shared/desktop-origins.cjs");
const { validateDesktopContext } = require("./handoff-broker.cjs");
const reject = (status, message) => Object.assign(Error(message), { status });
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
async function readBody(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw reject(415, "需要 JSON 请求。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw reject(413, "请求过大。");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw reject(400, "请求格式无效。");
  }
}
const keys = (value, expected) =>
  Object.keys(value).sort().join() === [...expected].sort().join();

function createDesktopOnlineApi({
  launch,
  fetchImpl = fetch,
  allowedOrigins = origins.desktopOnlineOrigins(),
  now = Date.now,
  instanceId,
} = {}) {
  const pending = new Map();
  function discard(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.verifier = null;
  }
  const handler = async (req, res, url) => {
    const json = (status, value) => {
      if (!res.destroyed) {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(value));
      }
    };
    try {
      const origin = req.headers.origin;
      if (
        req.headers.host !== `127.0.0.1:${req.socket.localPort}` ||
        !allowedOrigins.has(origin) ||
        !req.url.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.includes("\\")
      )
        throw reject(403, "未授权的轻岛启动来源。");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (
        url.search ||
        ![
          "/api/local-desktop/online/prepare",
          "/api/local-desktop/online/launch",
          "/api/local-desktop/online/status",
          "/api/local-desktop/online/probe",
        ].includes(url.pathname)
      )
        throw reject(404, "找不到线上轻岛入口。");
      if (req.method === "OPTIONS") {
        const headers = String(
          req.headers["access-control-request-headers"] || "",
        )
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          req.headers["access-control-request-method"] !== "POST" ||
          !headers.includes("x-qingdan-local") ||
          headers.some((h) => !["content-type", "x-qingdan-local"].includes(h))
        )
          throw reject(403, "不支持的轻岛请求。");
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, X-Qingdan-Local",
          "Access-Control-Allow-Private-Network": "true",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      if (req.method !== "POST" || req.headers["x-qingdan-local"] !== "1")
        throw reject(403, "请通过轻岛按钮启动。");
      const input = await readBody(req);
      if (url.pathname.endsWith("/probe")) {
        if (!keys(input, [])) throw reject(400, "检查请求无效。");
        json(200, { protocol: 1, ...(instanceId ? { instanceId } : {}) });
        return;
      }
      if (url.pathname.endsWith("/status")) {
        if (
          !keys(input, ["requestId"]) ||
          typeof input.requestId !== "string" ||
          !/^[a-f0-9]{32}$/.test(input.requestId)
        )
          throw reject(400, "启动请求编号无效。");
        const entry = pending.get(input.requestId);
        if (!entry || entry.origin !== origin)
          throw reject(410, "启动请求已结束。");
        json(200, { message: entry.message || "正在检查轻岛安装和版本…" });
        return;
      }
      if (url.pathname.endsWith("/prepare")) {
        if (
          !keys(input, ["accountId", "roomId"]) ||
          !id(input.accountId) ||
          !id(input.roomId)
        )
          throw reject(400, "当前账号或画布无效。");
        if (pending.size >= 32) throw reject(429, "启动请求较多，请稍后重试。");
        const requestId = randomBytes(16).toString("hex"),
          verifier = randomBytes(32).toString("hex"),
          expiresAt = now() + 90000;
        const timer = setTimeout(() => discard(requestId), 90000);
        timer.unref();
        pending.set(requestId, {
          ...input,
          origin,
          verifier,
          expiresAt,
          timer,
          controller: new AbortController(),
          busy: false,
          message: "正在检查轻岛安装和版本…",
        });
        json(200, {
          requestId,
          challenge: createHash("sha256").update(verifier).digest("hex"),
          expiresAt,
          ...(instanceId ? { instanceId } : {}),
        });
        return;
      }
      if (
        !keys(input, ["requestId", "ticket"]) ||
        typeof input.requestId !== "string" ||
        typeof input.ticket !== "string" ||
        !/^[a-f0-9]{32}$/.test(input.requestId) ||
        !/^[a-f0-9]{64}$/.test(input.ticket)
      )
        throw reject(400, "桌面交接信息无效。");
      const entry = pending.get(input.requestId);
      if (
        !entry ||
        entry.origin !== origin ||
        entry.busy ||
        entry.expiresAt <= now()
      )
        throw reject(410, "启动请求已过期，请重新点击轻岛。");
      entry.busy = true;
      // Once redemption starts, allow the existing native confirmation timeout.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => discard(input.requestId), 20 * 60 * 1000);
      entry.timer.unref();
      const disconnected = () => {
        if (!res.writableEnded) discard(input.requestId);
      };
      res.once("close", disconnected);
      try {
        const response = await fetchImpl(
          origin + "/api/desktop/handoff/redeem",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Qingdan-Desktop": "1",
            },
            body: JSON.stringify({
              ticket: input.ticket,
              verifier: entry.verifier,
            }),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.any([
              entry.controller.signal,
              AbortSignal.timeout(8000),
            ]),
          },
        );
        if (!response.ok)
          throw reject(410, "线上交接已失效，请刷新网页后重试。");
        const session = await response.json();
        if (
          session.accountId !== entry.accountId ||
          session.roomId !== entry.roomId
        )
          throw reject(403, "账号或画布已变化，请重新点击轻岛。");
        const context = validateDesktopContext({ ...session, origin });
        entry.controller.signal.throwIfAborted();
        const result = await launch(context, {
          signal: entry.controller.signal,
          onStatus: (message) => {
            entry.message = String(message).slice(0, 200);
          },
        });
        entry.controller.signal.throwIfAborted();
        if (result?.started !== true || result?.applied !== true)
          throw reject(503, "轻岛尚未确认接入当前画布。");
        if (result.afterResponse)
          res.once("finish", () => {
            void result.afterResponse();
          });
        json(200, {
          started: true,
          applied: true,
          ...(result.warning ? { warning: result.warning } : {}),
          ...(result.restarting ? { restarting: true } : {}),
        });
      } finally {
        res.off("close", disconnected);
        discard(input.requestId);
      }
    } catch (error) {
      json(error.status || 503, {
        // The native broker maps handoff failures to fixed, public messages.
        // Keep cancellation/upgrade guidance; never expose arbitrary failures.
        error:
          error.status ||
          error.handoff === true ||
          error.desktopInstall === true
            ? error.message
            : "无法完成线上轻岛启动，请确认本机服务和网络正常后重试。",
      });
    }
  };
  handler.close = () => {
    for (const requestId of pending.keys()) discard(requestId);
  };
  return handler;
}

module.exports = { createDesktopOnlineApi };
