"use strict";
const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const origins = require("../shared/desktop-origins.cjs");

const errors = {
  cancelled: "已取消切换，原桌面窗口和输入已保留。",
  "save-failed": "桌面内容尚未保存，请在桌面窗口处理后重试。",
  "session-invalid": "登录状态已变化，请刷新网页后重试。",
  "room-denied": "当前画布权限已变化，请刷新网页后重试。",
  failed: "桌面暂未打开当前画布，请查看桌面提示后重试。",
  timeout: "桌面窗口未响应本次交接，请从系统托盘安全退出轻岛后，再点击按钮。",
};
function validateDesktopContext(value) {
  const id = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        ![
          "accountId",
          "roomId",
          "sessionToken",
          "origin",
          "expiresAt",
        ].includes(key),
    ) ||
    (value.origin !== undefined &&
      !origins.desktopOnlineOrigins().has(value.origin)) ||
    (value.expiresAt !== undefined &&
      (!Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= Date.now())) ||
    !id(value.accountId) ||
    !id(value.roomId) ||
    typeof value.sessionToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sessionToken)
  )
    throw new Error("无效的桌面登录交接。");
  return {
    accountId: value.accountId,
    roomId: value.roomId,
    sessionToken: value.sessionToken,
    ...(value.origin ? { origin: value.origin } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
  };
}

// The descriptor travels only over stdin and Electron's single-instance IPC.
// Credentials stay in memory until a single authenticated native receiver claims them.
async function createDesktopHandoff(
  input,
  { timeoutMs = 120000, claimTimeoutMs = 10000 } = {},
) {
  let context = validateDesktopContext(input);
  const nonce = randomBytes(32).toString("hex");
  let settled = false,
    claimed = false,
    timer,
    endpoint,
    resolveResult,
    closing;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const close = () => {
    if (closing) return closing;
    clearTimeout(timer);
    context = null;
    if (!settled) {
      settled = true;
      resolveResult({ applied: false, code: "failed", error: errors.failed });
    }
    closing = new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    return closing;
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    context = null;
    clearTimeout(timer);
    resolveResult(value);
    // Allow the result response to flush before closing any keep-alive socket.
    setImmediate(() => {
      void close();
    });
  };
  const expire = () =>
    finish({ applied: false, code: "timeout", error: errors.timeout });
  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization;
      const expected = `Bearer ${nonce}`;
      if (
        req.headers.host !== new URL(endpoint).host ||
        req.headers.origin !== undefined ||
        req.headers["sec-fetch-site"] !== undefined ||
        typeof auth !== "string" ||
        Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
      )
        return json(res, 403, { error: "Forbidden" });
      if (
        req.method !== "POST" ||
        !["/claim", "/check", "/result"].includes(req.url)
      )
        return json(res, 404, { error: "Not found" });
      if (settled) return json(res, 410, { error: "Expired" });
      if (req.url === "/claim") {
        if (claimed) return json(res, 409, { error: "Already claimed" });
        claimed = true;
        clearTimeout(timer);
        timer = setTimeout(expire, timeoutMs);
        const payload = context;
        context = null;
        return json(res, 200, payload);
      }
      if (!claimed) return json(res, 409, { error: "Not claimed" });
      if (req.url === "/check") return json(res, 200, { active: true });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) return json(res, 413, { error: "Too large" });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(res, 400, { error: "Invalid result" });
      }
      if (
        !body ||
        typeof body.applied !== "boolean" ||
        Object.keys(body).some(
          (key) => !["applied", "code", "error"].includes(key),
        )
      )
        return json(res, 400, { error: "Invalid result" });
      const code = Object.hasOwn(errors, body.code) ? body.code : "failed";
      const value = body.applied
        ? { applied: true }
        : { applied: false, code, error: errors[code] };
      json(res, 200, { ok: true });
      finish(value);
    } catch {
      if (!res.headersSent) json(res, 400, { error: "Invalid request" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(expire, claimTimeoutMs);
  return { descriptor: { version: 1, endpoint, nonce }, result, close };
}

module.exports = { createDesktopHandoff, validateDesktopContext };
