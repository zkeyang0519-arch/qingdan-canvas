import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const root = fileURLToPath(new URL("..", import.meta.url));
const resources = path.join(
  root,
  "output/desktop-release/win-unpacked/resources",
);
const archive = path.join(resources, "app.asar");
const files = asar.listPackage(archive).map((p) => p.replaceAll("\\", "/"));
const forbidden = files.filter((p) =>
  /(^|\/)(\.dev\.vars[^/]*|\.git|\.wrangler|desktop-profile|runner-device|worker|runner|\.env)(\/|$)/.test(
    p,
  ),
);
if (forbidden.length)
  throw Error(
    `Unexpected private/server files in installer: ${forbidden.join(", ")}`,
  );
for (const expected of [
  "/desktop/main.cjs",
  "/desktop/preload.cjs",
  "/shared/desktop-origins.cjs",
  "/node_modules/electron-updater/out/main.js",
]) {
  if (!files.includes(expected))
    throw Error(`Missing runtime file: ${expected}`);
}
const pkg = JSON.parse(
  asar.extractFile(archive, "package.json").toString("utf8"),
);
for (const file of await fs.readdir(path.join(root, "desktop"))) {
  if (!file.endsWith(".cjs")) continue;
  const source = await fs.readFile(path.join(root, "desktop", file));
  const packed = asar.extractFile(archive, `desktop/${file}`);
  if (!source.equals(packed))
    throw Error(`Packaged native module differs from source: ${file}`);
}
if (Object.keys(pkg.dependencies || {}).join() !== "electron-updater")
  throw Error("Desktop runtime dependencies exceeded allowlist.");
const html = await fs.readFile(path.join(resources, "web/index.html"), "utf8");
for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g))
  await fs.access(path.join(resources, "web", asset[1]));
for (const animal of [
  "classic-cat",
  "rabbit",
  "welsh-corgi",
  "shiba-inu",
  "fox",
  "chicken",
])
  await fs.access(path.join(resources, "web/animals/runcat", `${animal}.png`));
const feedFile = path.join(root, "output/desktop-release/latest.yml");
try {
  const feed = require("js-yaml").load(await fs.readFile(feedFile, "utf8"));
  if (feed.version !== pkg.version || path.basename(feed.path) !== feed.path)
    throw Error("Unexpected installer feed version or path.");
  const bytes = await fs.readFile(
    path.join(root, "output/desktop-release", feed.path),
  );
  const checksum = createHash("sha512").update(bytes).digest("base64");
  if (
    checksum !== feed.sha512 ||
    checksum !== feed.files?.[0]?.sha512 ||
    bytes.length !== feed.files?.[0]?.size
  )
    throw Error(
      "Installer metadata checksum does not match generated installer.",
    );
  console.log(
    `Installer SHA-256: ${createHash("sha256").update(bytes).digest("hex")}`,
  );
} catch (error) {
  if (error.code !== "ENOENT" || error.path !== feedFile) throw error;
}
console.log(
  `Desktop payload verified: ${pkg.version}; ${files.length} entries; bundled web and all six animals present; private checkout files excluded.`,
);
