"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { productionOrigin } = require("../shared/desktop-origins.cjs");

function bundledAsset(url, directory) {
  const target = new URL(url);
  if (target.origin !== productionOrigin) return null;
  let name;
  try {
    name = decodeURIComponent(target.pathname);
  } catch {
    return null;
  }
  if (name === "/app") name = "/index.html";
  else if (!/^\/(assets|animals)\//.test(name)) return null;
  const root = path.resolve(directory),
    file = path.resolve(root, "." + name);
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    name.includes("\\") ||
    name.includes("\0")
  )
    return null;
  return file;
}
function installBundledWeb(session, directory) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  session.protocol.handle("https", async (request) => {
    const file =
      request.method === "GET" ? bundledAsset(request.url, directory) : null;
    if (!file)
      return session.fetch(request, { bypassCustomProtocolHandlers: true });
    try {
      return new Response(await fs.readFile(file), {
        headers: {
          "Content-Type":
            types[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://todo.zky.lol wss://todo.zky.lol; object-src 'none'; base-uri 'none'; frame-src 'none'",
        },
      });
    } catch {
      return new Response("Bundled asset unavailable", { status: 404 });
    }
  });
}
module.exports = { bundledAsset, installBundledWeb };
