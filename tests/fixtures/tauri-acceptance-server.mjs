// Full production Worker and React app, with isolated local D1/DO/R2 data.
// Only sample accounts and a deliberate navigation failure are test fixtures.
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import WebSocket from "ws";
import { createObject, makeBlock } from "../../src/canvas/model.js";
import { sharedObject } from "../../shared/canvas-contract.js";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(path.resolve(".tmp/tauri-acceptance-server-"));
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "browser"],
  format: "esm",
  external: ["node:*", "cloudflare:*"],
  outfile: path.join(dir, "worker.mjs"),
  logLevel: "silent",
});
let failRoom = false;
const options = convertV4MiniflareOptions({
  name: "tauri-acceptance",
  port: 18788,
  inspectorPort: 0,
  scriptPath: path.join(dir, "worker.mjs"),
  modules: true,
  compatibilityDate: "2026-10-19",
  compatibilityFlags: ["nodejs_compat"],
  cf: false,
  log: new Log(LogLevel.ERROR),
  d1Databases: ["DB"],
  r2Buckets: ["FILES"],
  durableObjects: { ROOMS: { className: "CanvasRoom", useSQLite: true } },
  bindings: { APP_ENV: "local" },
  outboundService: () =>
    new Response("External network disabled", { status: 503 }),
  serviceBindings: {
    ASSETS: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/__fixture/fail-b") {
        failRoom = true;
        return new Response("ok");
      }
      if (url.pathname === "/__fixture/reset") {
        failRoom = false;
        return new Response("ok");
      }
      if (
        failRoom &&
        url.pathname === "/app" &&
        url.searchParams.get("room") === "room-b"
      )
        return new Response("Deliberate fixture navigation failure", {
          status: 503,
        });
      const rel =
        url.pathname === "/app" || url.pathname === "/"
          ? "index.html"
          : url.pathname.slice(1);
      const root = path.resolve(".tmp/tauri-web"),
        file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep))
        return new Response("Forbidden", { status: 403 });
      try {
        const mime =
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
          }[path.extname(file)] || "application/octet-stream";
        return new Response(await readFile(file), {
          headers: { "Content-Type": mime },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
});
Object.assign(options, {
  isolatedResourcePersistencePath: path.join(dir, "isolated"),
  resourcePersistencePath: path.join(dir, "state"),
  unsafeEnableSharedStorage: true,
  unsafeDevRegistryPath: path.join(dir, "registry"),
});
const mf = new Miniflare(options),
  db = await mf.getD1Database("DB");
for (const file of (await readdir("migrations"))
  .filter((n) => n.endsWith(".sql"))
  .sort()) {
  const sql = (await readFile(path.join("migrations", file), "utf8")).replace(
    /^--.*$/gm,
    "",
  );
  await db.batch(
    sql
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
}
for (const [account, room, token, name] of [
  ["alice", "room-a", "a".repeat(64), "验证账号 A"],
  ["bob", "room-b", "b".repeat(64), "验证账号 B"],
]) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(account, account, name, "fixture", new Date().toISOString()),
    db
      .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
      .bind(
        createHash("sha256").update(token).digest("hex"),
        account,
        Date.now() + 86400000,
      ),
    db
      .prepare(
        "INSERT INTO rooms(id,name,owner_id,invite_hash,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        room,
        name + "的画布",
        account,
        "fixture",
        new Date().toISOString(),
      ),
    db
      .prepare(
        "INSERT INTO members(room_id,user_id,role,joined_at) VALUES(?,?,?,?)",
      )
      .bind(room, account, "owner", new Date().toISOString()),
  ]);
  const socket = new WebSocket(
    `ws://127.0.0.1:18788/api/rooms/${room}/socket?account=${account}&authors=1`,
    {
      headers: {
        Cookie: `qd_session=${token}`,
        Origin: "http://127.0.0.1:18788",
      },
    },
  );
  const note = createObject(room, "note");
  note.noteKind = "checklist";
  note.blocks = [makeBlock(name + "的初始待办")];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Seed timeout")), 10000);
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "snapshot")
        socket.send(
          JSON.stringify({
            type: "commit",
            opId: `seed-${account}`,
            changes: [
              { id: note.id, expectedRevision: 0, data: sharedObject(note) },
            ],
          }),
        );
      if (msg.type === "ack") {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(Error(msg.error || JSON.stringify(msg)));
      }
    });
  });
}
console.log(
  JSON.stringify({
    ready: true,
    origin: "http://127.0.0.1:18788",
    state: dir,
    accounts: ["alice", "bob"],
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
