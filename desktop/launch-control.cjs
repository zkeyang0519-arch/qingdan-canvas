"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

// This is private native-to-native control, not a browser endpoint. The
// per-profile capability stays on disk and never appears in a page or argv.
async function createLaunchControl({ profile, version, prepareExit, quit }) {
  const nonce = randomBytes(32).toString("hex");
  const file = path.join(profile, "launch-control.json");
  let endpoint,
    busy = false;
  const reply = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
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
      return reply(res, 403, { error: "Forbidden" });
    if (req.method !== "POST" || req.url !== "/prepare-update")
      return reply(res, 404, { error: "Not found" });
    if (busy) return reply(res, 409, { error: "轻岛正在保存，请稍后重试。" });
    busy = true;
    try {
      const commitExit = await prepareExit();
      // Flush the acknowledgment before quitting Electron. The installer also
      // verifies every old process has exited; an acknowledgment alone is not enough.
      let committed = false;
      const finish = () => {
        if (committed) return;
        committed = true;
        setImmediate(() => {
          commitExit();
          quit();
        });
      };
      res.once("finish", finish);
      res.once("close", finish);
      reply(res, 200, { saved: true, version, pid: process.pid });
    } catch (error) {
      busy = false;
      reply(res, 409, {
        error: "轻岛尚未完成本地保存，已保留原窗口。请处理后重试。",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        protocol: 1,
        endpoint,
        nonce,
        pid: process.pid,
        version,
      }),
      { mode: 0o600 },
    );
  } catch (error) {
    server.close();
    throw error;
  }
  const close = () => {
    server.close();
    server.closeAllConnections();
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce)
        fs.unlinkSync(file);
    } catch {
      /* A newer process may already own the record. */
    }
  };
  return { close };
}
module.exports = { createLaunchControl };
