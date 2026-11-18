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
  "/shared/island-size.json",
  "/node_modules/electron-updater/out/main.js",
]) {
  if (!files.includes(expected))
    throw Error(`Missing runtime file: ${expected}`);
}
const pkg = JSON.parse(
  asar.extractFile(archive, "package.json").toString("utf8"),
);
if (
  !asar
    .extractFile(archive, "shared/island-size.json")
    .equals(await fs.readFile(path.join(root, "shared/island-size.json")))
)
  throw Error("Packaged island size limits differ from the renderer build.");
for (const file of await fs.readdir(path.join(root, "desktop"))) {
  if (!file.endsWith(".cjs")) continue;
  const source = await fs.readFile(path.join(root, "desktop", file));
  const packed = asar.extractFile(archive, `desktop/${file}`);
  if (!source.equals(packed))
    throw Error(`Packaged native module differs from source: ${file}`);
}
if (Object.keys(pkg.dependencies || {}).join() !== "electron-updater")
  throw Error("Desktop runtime dependencies exceeded allowlist.");
const sourcePackage = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
if (pkg.version !== sourcePackage.version)
  throw Error("Packaged version differs from the release source.");
let webFiles = 0;
async function verifyWebDirectory(relative = "") {
  const directory = path.join(root, "dist", relative);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await verifyWebDirectory(name);
    else if (entry.isFile()) {
      const source = await fs.readFile(path.join(root, "dist", name));
      const packed = await fs.readFile(path.join(resources, "web", name));
      if (!source.equals(packed))
        throw Error(
          `Packaged web resource differs from the current build: ${name}`,
        );
      webFiles++;
    }
  }
}
await verifyWebDirectory();
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
// Native source equality was checked above. Exercise the same handler without
// networking so a package cannot pass while its new images still require a CDN.
let bundledRequest;
require("../desktop/bundled-web.cjs").installBundledWeb(
  {
    protocol: { handle: (_, handler) => (bundledRequest = handler) },
    fetch() {
      throw Error("Packaged meadow resources attempted a network request.");
    },
  },
  path.join(resources, "web"),
);
for (const season of ["spring", "summer", "autumn", "winter"]) {
  const asset = `island/meadow/${season}-v3.webp`;
  const response = await bundledRequest(
    new Request(`https://todo.zky.lol/${asset}`),
  );
  const expected = await fs.readFile(path.join(root, "public", asset));
  if (
    response.status !== 200 ||
    response.headers.get("content-type") !== "image/webp" ||
    !Buffer.from(await response.arrayBuffer()).equals(expected)
  )
    throw Error(
      `Packaged seasonal background is unavailable or stale: ${season}`,
    );
}
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
  `Desktop payload verified: ${pkg.version}; ${files.length} entries; ${webFiles} web files match the current build; all four seasons load offline; all six animals present; private checkout files excluded.`,
);
