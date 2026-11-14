import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { problem, invalid } from "./errors.mjs";
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const security = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
export async function startServer({
  connector,
  token,
  port = 0,
  onQuit,
  instanceId = "local",
}) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid local credential");
  let origin;
  const reply = (res, status, value) => {
    res.writeHead(status, {
      ...security,
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        ["cross-site"].includes(req.headers["sec-fetch-site"])
      ) {
        reply(res, 403, {
          code: "ORIGIN_DENIED",
          message: "此接口只接受本机连接面板。",
        });
        return;
      }
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/health") {
        reply(res, 200, { app: "qingdan-codex-connector", instanceId });
        return;
      }
      if (req.method === "GET" && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        res.writeHead(200, { ...security, "Content-Type": type });
        res.end(await readFile(new URL("./public/" + name, import.meta.url)));
        return;
      }
      const given = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        Buffer.byteLength(given) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(token))
      ) {
        reply(res, 401, {
          code: "LOCAL_AUTH_REQUIRED",
          message: "访问凭证已失效，请重新打开连接器。",
        });
        return;
      }
      if (req.method === "GET") {
        if (url.pathname === "/api/status") {
          reply(res, 200, connector.status());
          return;
        }
        if (url.pathname === "/api/diagnostics") {
          reply(res, 200, connector.diagnostics());
          return;
        }
        if (url.pathname === "/api/sessions") {
          const searchTerm = url.searchParams.get("search") ?? "",
            cursor = url.searchParams.get("cursor") ?? undefined;
          if (searchTerm.length > 200 || (cursor?.length ?? 0) > 4096)
            throw invalid();
          reply(res, 200, await connector.listSessions({ searchTerm, cursor }));
          return;
        }
        if (url.pathname === "/api/session") {
          const id = url.searchParams.get("id");
          if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw invalid();
          reply(res, 200, await connector.readSession(id));
          return;
        }
      }
      if (
        req.method === "POST" &&
        ["/api/connect", "/api/config", "/api/quit"].includes(url.pathname)
      ) {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw invalid("需要 JSON 请求。");
        if (Number(req.headers["content-length"] ?? 0) > 65536) {
          req.resume();
          reply(res, 413, { code: "BODY_TOO_LARGE", message: "请求过大。" });
          return;
        }
        const chunks = [];
        let bytes = 0,
          oversized = false;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) oversized = true;
          else chunks.push(chunk);
        }
        if (oversized) {
          reply(res, 413, { code: "BODY_TOO_LARGE", message: "请求过大。" });
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw invalid("JSON 请求无效。");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw invalid();
        if (url.pathname === "/api/connect") {
          if (Object.keys(body).length) throw invalid();
          reply(res, 200, await connector.inspect());
          return;
        }
        if (url.pathname === "/api/config") {
          if (
            Object.keys(body).some((k) => k !== "manualPath") ||
            typeof body.manualPath !== "string" ||
            body.manualPath.length > 4096
          )
            throw invalid();
          reply(res, 200, await connector.configure(body.manualPath));
          return;
        }
        if (Object.keys(body).length) throw invalid();
        reply(res, 200, { stopping: true });
        if (onQuit) setTimeout(onQuit, 50);
        return;
      }
      reply(res, 404, {
        code: "NOT_FOUND",
        message: "此操作不在连接器支持范围内。",
      });
    } catch (e) {
      if (!res.headersSent)
        reply(res, e.code === "INVALID_INPUT" ? 400 : 503, problem(e));
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = "http://127.0.0.1:" + server.address().port;
  return {
    server,
    url: origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
