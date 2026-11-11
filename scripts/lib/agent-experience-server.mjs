import { createServer, request as httpRequest } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { validRequestId } from "./agent-experience-service.mjs";

const reject = (status, message) => Object.assign(Error(message), { status });
function originFor(req) {
  return `http://127.0.0.1:${req.socket.localPort}`;
}
function guard(req, local = false, extraOrigins) {
  const origin = originFor(req);
  const originAllowed =
    req.headers.origin === origin || extraOrigins?.has(req.headers.origin);
  if (
    !req.url.startsWith("/") ||
    req.url.startsWith("//") ||
    req.url.includes("\\")
  )
    throw reject(403, "请求路径无效。");
  if (
    req.headers.host !== new URL(origin).host ||
    (req.headers.origin && !originAllowed) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    throw reject(403, "仅允许从本机轻单入口访问。");
  if (local && req.headers["x-qingdan-local"] !== "1")
    throw reject(403, "缺少本机请求标记。");
  if (!["GET", "HEAD"].includes(req.method) && !originAllowed)
    throw reject(403, "本机操作需要同源请求。");
}

function runnerCors(req, res) {
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method !== "OPTIONS") return false;
  const method = req.headers["access-control-request-method"];
  const headers = String(req.headers["access-control-request-headers"] || "")
    .toLowerCase()
    .split(",")
    .map((header) => header.trim())
    .filter(Boolean);
  if (
    !["GET", "POST"].includes(method) ||
    !headers.includes("x-qingdan-local") ||
    headers.some(
      (header) =>
        !["content-type", "x-qingdan-local", "x-qd-account"].includes(header),
    )
  )
    throw reject(403, "不支持的本机跨端口请求。");
  res.writeHead(204, {
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Qingdan-Local, X-QD-Account",
    "Cache-Control": "no-store",
  });
  res.end();
  return true;
}
async function requestId(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw reject(415, "需要 JSON 请求。");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 1024) throw reject(413, "请求过大。");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw reject(400, "请求格式无效。");
  }
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    !validRequestId(body.requestId)
  )
    throw reject(400, "只接受有效的测试请求编号。");
  return body.requestId;
}
function json(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(JSON.stringify(body));
}
export function createExperienceServer({
  service,
  upstream,
  runnerApi,
  handshakeTimeoutMs = 10000,
}) {
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1)
    throw Error("WebSocket handshake timeout must be a positive integer.");
  let closing = false;
  const connections = new Set(),
    remotes = new Set();
  const target = new URL(upstream);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw Error("上游必须是本机轻单开发服务。");
  // Only these local app pages may cross ports. Cookies are still verified
  // against the upstream session by runnerApi on every actual request.
  const runnerOrigins = new Set([target.origin, "http://127.0.0.1:5178"]);
  const server = createServer(async (req, res) => {
    try {
      if (closing) throw reject(503, "本机服务正在关闭。");
      const url = new URL(req.url, originFor(req));
      const localCodex = url.pathname.startsWith("/api/local-codex/");
      const localRunner = url.pathname.startsWith("/api/local-runner/");
      guard(
        req,
        localCodex || (localRunner && req.method !== "OPTIONS"),
        localRunner ? runnerOrigins : undefined,
      );
      if (localRunner) {
        if (runnerCors(req, res)) return;
        if (!runnerApi) throw reject(503, "本机 Runner 尚未启动。");
        return json(res, await runnerApi(req, url));
      }
      if (localCodex) {
        if (req.method === "GET" && url.pathname === "/api/local-codex/status")
          return json(res, await service.status());
        if (
          req.method === "GET" &&
          url.pathname === "/api/local-codex/connection"
        )
          return json(res, await service.connection());
        if (req.method === "GET" && url.pathname === "/api/local-codex/thread")
          return json(
            res,
            await service.thread(
              url.searchParams.get("workspaceId"),
              url.searchParams.get("threadId"),
            ),
          );
        if (req.method === "POST" && url.pathname === "/api/local-codex/tests")
          return json(res, await service.start(await requestId(req)), 202);
        if (
          req.method === "POST" &&
          url.pathname === "/api/local-codex/tests/reconcile"
        )
          return json(res, await service.reconcile(await requestId(req)), 202);
        throw reject(404, "找不到本机功能。");
      }
      const proxy = httpRequest(
        new URL(req.url, target),
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: target.host,
            ...(req.headers.origin ? { origin: target.origin } : {}),
          },
        },
        (response) => {
          res.writeHead(response.statusCode, {
            ...response.headers,
            "X-Frame-Options": "DENY",
          });
          response.pipe(res);
        },
      );
      proxy.on("error", () => {
        if (!res.headersSent)
          json(res, { error: "本机轻单正在启动，请稍后刷新。" }, 502);
        else res.destroy();
      });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => {
        if (!res.writableEnded) proxy.destroy();
      });
      req.pipe(proxy);
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          {
            error: error.message,
            ...(error.code === "OWNER_MISMATCH" ? { code: error.code } : {}),
          },
          error.status || 409,
        );
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    if (closing) socket.destroy();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (closing) return socket.destroy();
      guard(req);
      if (req.headers.origin !== originFor(req) || !req.url.startsWith("/api/"))
        throw reject(403, "仅支持本机协作连接。");
      const url = new URL(req.url, target);
      url.protocol = "ws:";
      const remote = new WebSocket(url, {
        handshakeTimeout: handshakeTimeoutMs,
        headers: {
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
          origin: target.origin,
        },
      });
      remotes.add(remote);
      remote.once("close", () => remotes.delete(remote));
      socket.on("close", () => remote.terminate());
      remote.on("error", () => socket.destroy());
      remote.on("unexpected-response", (_req, res) => {
        res.resume();
        socket.destroy();
      });
      remote.once("open", () => {
        if (closing || socket.destroyed) return remote.terminate();
        sockets.handleUpgrade(req, socket, head, (local) => {
          remote.on("message", (data, isBinary) => {
            if (local.readyState === WebSocket.OPEN)
              local.send(data, { binary: isBinary });
          });
          local.on("message", (data, isBinary) => {
            if (remote.readyState === WebSocket.OPEN)
              remote.send(data, { binary: isBinary });
          });
          local.on("error", () => remote.terminate());
          local.on("close", () => remote.close());
          remote.on("close", () => local.close());
        });
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("close", () => {
    for (const remote of remotes) remote.terminate();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  });
  server.closeConnections = () => {
    closing = true;
    // CONNECTING peers are not yet WebSocketServer clients. Destroy both ends,
    // including raw sockets whose upstream handshake never completed.
    for (const remote of remotes) remote.terminate();
    for (const client of sockets.clients) client.terminate();
    for (const socket of connections) socket.destroy();
    server.closeAllConnections();
  };
  return server;
}
