import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { ConnectorError } from "./errors.mjs";
export async function acquireInstance(stateDir, { probe, waitMs = 4000 } = {}) {
  await mkdir(stateDir, { recursive: true });
  const dir = await realpath(stateDir);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? dir.toLowerCase() : dir)
    .digest("hex")
    .slice(0, 32);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\qingdan-codex-connector-${key}`
      : path.join(dir, "instance.sock");
  const runtimeFile = path.join(dir, "runtime.json");
  const lock = net.createServer((socket) => socket.end());
  let owned = false;
  try {
    await new Promise((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(endpoint, resolve);
    });
    owned = true;
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
  if (!owned) {
    const check =
      probe ??
      (async (runtime) => {
        try {
          const r = await fetch(runtime.url + "/health", {
            signal: AbortSignal.timeout(600),
            redirect: "error",
          });
          const body = await r.json();
          return (
            r.ok &&
            body.app === "qingdan-codex-connector" &&
            body.instanceId === runtime.instanceId
          );
        } catch {
          return false;
        }
      });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        const r = JSON.parse(await readFile(runtimeFile, "utf8"));
        if (
          /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(r.url) &&
          /^[a-f0-9]{64}$/.test(r.token) &&
          typeof r.instanceId === "string" &&
          (await check(r))
        )
          return { existing: r };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ConnectorError(
      "INSTANCE_BUSY",
      "已有连接器正在启动或未响应。",
      "稍候重试，或从已有面板退出后再打开",
    );
  }
  const instanceId = randomUUID();
  let released = false;
  return {
    instanceId,
    async publish(url, token) {
      const temp = runtimeFile + "." + instanceId;
      await writeFile(
        temp,
        JSON.stringify({ pid: process.pid, instanceId, url, token }),
        { mode: 0o600 },
      );
      await rename(temp, runtimeFile);
    },
    async release() {
      if (released) return;
      released = true;
      try {
        const r = JSON.parse(await readFile(runtimeFile, "utf8"));
        if (r.instanceId === instanceId) await unlink(runtimeFile);
      } catch {}
      await new Promise((resolve) => lock.close(resolve));
    },
  };
}
